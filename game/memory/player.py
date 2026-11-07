#!/usr/bin/env python
"""进程外读游戏内存: 本地玩家的角色位置 + 主背包 (只读, 不注入)。

  python -I game/memory/player.py --pid <factorio.exe 的进程号> [--exe ...] [--pdb-dump ...] [--names]

指针链 (游戏 2.1.24, 布局由 pdb-dump 从 factorio.pdb 现场取, 按 exe 大小 + 修改时间缓存, 不存偏移表):
  global (静态 GlobalContext) → .game (Game*) → .localPlayer (Player*) → .controllerManager (内嵌 ControllerManager) → .controller (Controller*)
  → 若是 CharacterController: .character (Targeter<Character>: TargeterBase.target = Character*) → Entity.position (MapPosition, 定点数 /256)
  → Character.inventory (InventoryWithFilters, 基类 Inventory: data = ItemStack[dataSize]) → ItemStack {count u32, itemID u16, qualityID u8}
一致性: 游戏线程同时在改 → 读前读后各读一次 game 的 tick 不可行 (tick 不在这条链上), 这里用"整块背包连读两次, 不一样就再读" (最多 5 次)。
输出 JSON: {"position": {x, y}, "inventory": {"size": n, "slots": [{"slot": 1 起, "item": id, "quality": id, "count": n, "name": 可选}]}, "reads": 次数, "ms": 耗时}
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I 不把脚本目录放进搜索路径 (仓库 CLAUDE.md 工具坑)
from reader import Reader, cached_layout, default_exe, default_pdb_dump, member_offset, read_list, rva  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--exe", default=None)
    ap.add_argument("--pdb-dump", default=default_pdb_dump())
    ap.add_argument("--names", action="store_true", help="顺便把物品 ID 翻成名字 (再读一遍原型表)")
    args = ap.parse_args()
    args.exe = args.exe or default_exe()
    t0 = time.perf_counter()
    r = Reader(args.pid)
    base = r.module_base("factorio.exe")
    pd, exe = args.pdb_dump, args.exe
    off = lambda key, struct, member, prefix: cached_layout(pd, exe, f"off:{struct}.{member}", lambda: member_offset(pd, exe, struct, member, prefix))  # noqa: E731
    o_global = cached_layout(pd, exe, "rva:global", lambda: rva(pd, exe, "global"))
    o_game = off("GlobalContext.game", "GlobalContext", "game", "Game*")
    o_local = off("Game.localPlayer", "Game", "localPlayer", "Player*")
    o_cm = off("Player.controllerManager", "Player", "controllerManager", "ControllerManager")
    o_ctrl = off("ControllerManager.controller", "ControllerManager", "controller", "Controller*")
    o_char = off("CharacterController.character", "CharacterController", "character", "Targeter<Character")
    o_target = off("TargeterBase.target", "TargeterBase", "target", "Targetable*")
    o_pos = off("Entity.position", "Entity", "position", "MapPosition")
    o_inv = off("Character.inventory", "Character", "inventory", "InventoryWithFilters")
    o_data = off("Inventory.data", "Inventory", "data", "std::unique_ptr<ItemStack")
    o_size = off("Inventory.dataSize", "Inventory", "dataSize", "uint16")
    o_count = off("ItemStack.count", "ItemStack", "count", "uint32")
    o_item = off("ItemStack.itemID", "ItemStack", "itemID", "ID<ItemPrototype")
    o_quality = off("ItemStack.qualityID", "ItemStack", "qualityID", "ID<QualityPrototype")
    stack_size = 24  # struct ItemStack (24 字节; pdb-dump size ItemStack)

    o_cm_player = off("ControllerManager.player", "ControllerManager", "player", "Player*")
    o_ctrl_player = off("Controller.player", "Controller", "player", "Player*")

    def plausible(p: int) -> bool:
        return 0x10000 < p < 0x7FFFFFFFFFFF

    def resolve(game: int):
        """game → localPlayer → controller; 用两处回指 (ControllerManager.player、Controller.player 都要等于 Player) 判定这条链是真的"""
        if not plausible(game):
            return None
        try:
            player = r.u64(game + o_local)
            if not plausible(player) or r.u64(player + o_cm + o_cm_player) != player:
                return None
            controller = r.u64(player + o_cm + o_ctrl)
            if not plausible(controller) or r.u64(controller + o_ctrl_player) != player:
                return None
            return player, controller
        except OSError:
            return None

    # global 是静态对象还是指向它的指针, pdb-dump 不给符号类型: 两种读法都试, 取自洽的那个
    g = base + o_global
    found = None
    for how, game in (("对象", r.u64(g + o_game)), ("指针", r.u64(r.u64(g) + o_game) if plausible(r.u64(g)) else 0)):
        found = resolve(game)
        if found:
            break
    if not found:
        raise RuntimeError("global → game → localPlayer → controller 两种读法都不自洽 (不在游戏里? 或布局变了)")
    player, controller = found
    # 开地图 (远程视图) 时 controller 是 RemoteController, 身体在 physicalController 上 (2026-11-06 真服)
    physical = r.u64(player + o_cm + off("ControllerManager.physicalController", "ControllerManager", "physicalController", "std::unique_ptr"))
    if plausible(physical) and r.u64(physical + o_ctrl_player) == player:
        controller = physical
    character = r.u64(controller + o_char + o_target)
    if not (0x10000 < character < 0x7FFFFFFFFFFF):
        raise RuntimeError(f"控制器不是角色控制器或角色指针不合理 {character:#x} (远程视图 / 观察者?)")

    def snapshot():
        raw = r.read(character + o_pos, 8)
        x = int.from_bytes(raw[0:4], "little", signed=True) / 256.0
        y = int.from_bytes(raw[4:8], "little", signed=True) / 256.0
        inv = character + o_inv
        data = r.u64(inv + o_data)
        size = r.u16(inv + o_size)
        if not data or size > 1000:
            raise RuntimeError(f"背包不合理 data={data:#x} size={size}")
        blob = r.read(data, size * stack_size)
        slots = []
        for i in range(size):
            s = blob[i * stack_size:(i + 1) * stack_size]
            count = int.from_bytes(s[o_count:o_count + 4], "little")
            item = int.from_bytes(s[o_item:o_item + 2], "little")
            quality = s[o_quality]
            if count:
                slots.append({"slot": i + 1, "item": item, "quality": quality, "count": count})
        return {"x": x, "y": y}, {"size": size, "slots": slots}

    reads = 1
    pos, inv = snapshot()
    for _ in range(4):  # 连读两次一样才算稳 (游戏线程同时在改)
        pos2, inv2 = snapshot()
        reads += 1
        if pos2 == pos and inv2 == inv:
            break
        pos, inv = pos2, inv2
    if args.names:
        items = read_list(r, base, pd, exe, "Item", 2)
        by_id = {v: k for k, v in items["by_name"].items()}
        for s in inv["slots"]:
            s["name"] = by_id.get(s["item"])
    json.dump({"position": pos, "inventory": inv, "reads": reads, "ms": round((time.perf_counter() - t0) * 1000, 1)}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
