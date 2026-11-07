#!/usr/bin/env python
"""进程外读游戏内存: 一个地表上的全部实体 (名字、位置、编号, --details 时加细节和机器状态; 只读, 不注入)。

  python -I game/memory/entities.py --pid <factorio.exe 的进程号> --exe <它的 exe> [--surface nauvis] [--owned 文件] [--details]

指针链 (游戏 2.1.24, 布局由 pdb-dump 从 factorio.pdb 现场取, 按 exe 大小 + 修改时间缓存, 不存偏移表):
  global (静态 GlobalContext) → .game (Game*) → .map (Map*) → .surfaces (vector<Surface*>)
  → Surface 的基类 InfiniteRectangle<Chunk*> (InfiniteVector<InfiniteVector<Chunk*>>: data、dataSize、zeroIndex)
  → Chunk.advancedTiles (16×16 格, 每格 AdvancedTile.entities = EntityConnector* 链表头)
  → EntityConnector {advancedTile, nextOnTile, previousOnTile, nextTile, entity}
  → Entity {prototype (PrototypeBase.name), position (MapPosition, 定点数 /256)}, EntityWithOwner {forceID, qualityID, unitNumber}
大实体跨几格, 按实体指针去重。

一致性: 游戏线程同时在改, 没有锁。每个节点都校验 (连接器回指这一格、实体指回这个地表、原型指针读得出名字), 不合格的跳过并计数 (dropped), 不瞎猜。
输出 JSON: {"surface", "chunks", "count", "dropped", "ms", "entities": [{"name", "x", "y", "unit"?}]}; unit 只有 --types 文件里标了有主的类型才读。
"""
import argparse
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I 不把脚本目录放进搜索路径 (仓库 CLAUDE.md 工具坑)
from status import mem_status  # noqa: E402
from reader import Reader, cached_layout, default_exe, member_offset, read_list, rva  # noqa: E402
from reader import default_pdb_dump as proto_default_pdb_dump  # noqa: E402


def plausible(p: int) -> bool:
    return 0x10000 < p < 0x7FFFFFFFFFFF


def find_game(r: Reader, g: int, o_game: int, o_map: int, o_map_game: int) -> int:
    """global 是静态对象还是指向它的指针, pdb-dump 不给符号类型: 两种读法都试, 取 game.map.game 指回自己的那条 (和 player.py 同一个问题; 只看指针像不像会选错)"""
    candidates = [r.u64(g + o_game)]
    head = r.u64(g)
    if plausible(head):
        candidates.append(r.u64(head + o_game))
    tried = []
    for game in candidates:
        tried.append(hex(game))
        if not plausible(game):
            continue
        try:
            m = r.u64(game + o_map)
            tried.append(f"map@+{o_map}={m:#x}")
            if plausible(m) and r.u64(m + o_map_game) == game:
                return game
        except OSError as e:
            tried.append(f"读不了: {e}")
    raise RuntimeError(f"global game map not consistent (not in game, or layout changed): global@{g:#x} game+{o_game} tried {tried}")


def find_surface(r: Reader, base: int, pd: str, exe: str, off, name: str) -> tuple[int, int]:
    """global → game → map → 按名字找地表; 返回 (Map*, Surface*)"""
    o_global = cached_layout(pd, exe, "rva:global", lambda: rva(pd, exe, "global"))
    o_map = off("Game", "map", "Map*")
    game = find_game(r, base + o_global, off("GlobalContext", "game", "Game*"), o_map, off("Map", "game", "Game*"))
    the_map = r.u64(game + o_map)
    o_surfaces = off("Map", "surfaces", "std::vector<Surface")
    o_s_name = off("Surface", "name", "std::basic_string")
    begin, end = r.u64(the_map + o_surfaces), r.u64(the_map + o_surfaces + 8)
    n = (end - begin) // 8
    if not (0 < n < 4096):
        raise RuntimeError(f"地表个数不合理 {n}")
    names = []
    for i in range(n):
        s = r.u64(begin + i * 8)
        if not plausible(s):
            continue
        got = r.msvc_string(s + o_s_name)
        names.append(got)
        if got == name:
            return the_map, s
    raise RuntimeError(f"没有地表 {name}; 有 {names}")


def grid_chunks(r: Reader, rect: int) -> list[int]:
    """InfiniteVector<InfiniteVector<Chunk*>> → 全部非空 Chunk*"""
    data = r.u64(rect)
    rows = int.from_bytes(r.read(rect + 8, 4), "little", signed=True)
    if data == 0 or rows <= 0:
        return []
    if rows > 200_000:
        raise RuntimeError(f"区块表行数不合理 {rows}")
    raw = r.read(data, rows * 16)
    out: list[int] = []
    for i in range(rows):
        row = int.from_bytes(raw[i * 16 : i * 16 + 8], "little")
        n = int.from_bytes(raw[i * 16 + 8 : i * 16 + 12], "little", signed=True)
        if row == 0 or n <= 0:
            continue
        cells = r.read(row, n * 8)
        for j in range(n):
            p = int.from_bytes(cells[j * 8 : j * 8 + 8], "little")
            if p:
                out.append(p)
    return out


def vftables(pdb_dump: str, exe: str, cls: str) -> list[int]:
    """这个类的全部虚表 RVA (多继承有好几张); 对象 +0 的指针是其中一张 → 认出实体到底是哪个类, 不靠名字猜"""
    import re
    import subprocess
    sym = f"{cls}::`vftable'"
    out = subprocess.run([pdb_dump, exe, "sym", sym], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    rvas = []
    for line in out.stdout.splitlines():
        m = re.match(r"\+0x([0-9a-fA-F]+)\t(.+?)\t", line)
        if m and m.group(2) == sym:
            rvas.append(int(m.group(1), 16))
    return rvas


# 认得的实体类 (有实测核对的才放进来; 别的类只给名字、位置、编号)
DETAIL_CLASSES = ["AssemblingMachine", "Furnace", "MiningDrill", "Lab", "Inserter", "TransportBelt", "UndergroundBelt", "Splitter", "ContainerEntity", "LogisticContainer", "Boiler", "Generator", "AmmoTurret", "Character", "ResourceEntity", "ElectricPole", "Pipe", "PipeToGround", "Radar", "OffshorePump", "ItemEntity"]


QUALITY_LEVEL = {"normal": 0, "uncommon": 1, "rare": 2, "epic": 3, "legendary": 5}  # 机器速度 × (1 + 0.3 × 等级) (calc.quality-machine-speed ✅)
WILD_TTL = 60.0  # 没有东西归谁的区块多久重读一遍 (秒); 身体旁边的每次都重读 (EntityScan.refresh_near)


class Details:
    """按类读细节 (只读): 方向、血量、配方、进出料、燃料、能量、带上物品。偏移全部从 pdb 取, 这里不写数字"""

    def __init__(self, r: Reader, base: int, pd: str, exe: str, off):
        self.r = r
        self.off = off
        self.proto_off = off("Entity", "prototype", "EntityPrototype*")
        self.max_health_off = off("EntityWithHealthPrototype", "maxHealth", "float")
        self.max_health_cache: dict[int, float] = {}
        self.recipe_items: dict = {}
        # 原型自带的默认状态 (EntityPrototype.default_status, 例: 开局坠机残骸的容器是 broken); 原型名 → 状态名
        self.default_status: dict[str, str] = {}
        self.name_off = off("PrototypeBase", "name", "std::basic_string")
        self.vt = {}
        for cls in DETAIL_CLASSES:
            for rv in cached_layout(pd, exe, f"vt:{cls}", lambda c=cls: vftables(pd, exe, c)):
                self.vt[base + rv] = cls
        flip = lambda d: {v: k for k, v in d.items()}
        self.items = flip(read_list(r, base, pd, exe, "Item", 2)["by_name"])
        self.qualities = flip(read_list(r, base, pd, exe, "Quality", 1)["by_name"])
        self.recipes = flip(read_list(r, base, pd, exe, "Recipe", 2)["by_name"])
        self.o = {
            "health": off("EntityWithHealth", "health", "float"), "force": off("EntityWithOwner", "forceID", "ForceID"), "quality": off("EntityWithOwner", "qualityID", "ID<QualityPrototype"),
            "inv_data": off("Inventory", "data", "std::unique_ptr<ItemStack"), "inv_size": off("Inventory", "dataSize", "uint16"),
            "st_count": off("ItemStack", "count", "uint32"), "st_item": off("ItemStack", "itemID", "ID<ItemPrototype"), "st_q": off("ItemStack", "qualityID", "ID<QualityPrototype"),
            "src_type": off("EnergySource", "type", "EnergySourceType"), "b_heat": off("Burner", "heat", "EnergyStorage"), "b_fuel": off("Burner", "fuelInventory", "InventoryWithFilters"), "b_burnt": off("Burner", "burntResultInventory", "Inventory"), "b_item": off("Burner", "currentlyBurningItemID", "ID<ItemPrototype"),
            "e_buf": off("ElectricEnergySource", "buffer", "EnergyStorage"), "e_net": off("ElectricEnergySource", "network", "ElectricSubNetwork*"),
            "cm_src": off("CraftingMachine", "sourceInventory", "Inventory"), "cm_res": off("CraftingMachine", "resultInventory", "Inventory"), "cm_energy": off("CraftingMachine", "energySource", "EnergySourceHolderTemplate"), "cm_dir": off("CraftingMachine", "direction", "Direction"), "cm_flags": off("CraftingMachine", "flags", "CraftingMachineFlags"), "cm_sleep": off("CraftingMachine", "sleepReason", "ProductionResult"), "cm_recipe": off("CraftingMachine", "recipeID", "IDWithQuality"), "cm_done": off("CraftingMachine", "productsFinished", "uint32"),
            "md_dir": off("MiningDrill", "direction", "Direction"), "md_buf": off("MiningDrill", "storageBuffer", "Inventory"), "md_energy": off("MiningDrill", "energySource", "EnergySourceHolderTemplate"), "md_empty": off("MiningDrill", "storageBufferIsEmpty", "bool"), "md_fluid": off("MiningDrill", "waitingForFluid", "bool"), "md_target": off("MiningDrill", "miningTarget", "Targeter<ResourceEntity"), "tg_target": off("TargeterBase", "target", "Targetable*"),
            "lab_in": off("Lab", "inputInventory", "Inventory"), "lab_energy": off("Lab", "energySource", "EnergySourceHolderTemplate"), "lab_last": off("Lab", "lastUpdateResult", "Lab::LastUpdateResult"),
            "ins_dir": off("Inserter", "direction", "Direction"), "ins_held": off("Inserter", "heldStack", "ItemStack"), "ins_energy": off("Inserter", "energySource", "EnergySourceHolderTemplate"), "ins_flags": off("Inserter", "flags", "InserterFlags"),
            "belt_dir": off("TransportBeltConnectable", "direction", "Direction"), "belt_l": off("TransportBeltConnectable", "leftLine", "TransportLineConnector"), "belt_r": off("TransportBeltConnectable", "rightLine", "TransportLineConnector"),
            "tc_line": off("TransportLineConnector", "line", "TransportLine*"), "tc_range": off("TransportLineConnector", "range", "TransportLine::PositionRange"),
            "tl_first": off("TransportLine", "distanceToFirst", "FixedPointNumberTemplate"), "tl_items": off("TransportLine", "items", "CompactDeque"), "tl_len": off("TransportLine", "length", "FixedPointNumberTemplate"),
            "cd_data": off("CompactDeque<ItemOnTransportLine>", "_data", "ItemOnTransportLine*"), "cd_cap": off("CompactDeque<ItemOnTransportLine>", "_capacity", "uint32"), "cd_head": off("CompactDeque<ItemOnTransportLine>", "_head", "uint32"), "cd_size": off("CompactDeque<ItemOnTransportLine>", "_size", "uint32"),
            "it_gap": off("ItemOnTransportLine", "distanceToNext", "FixedPointNumberTemplate"), "it_stack": off("ItemOnTransportLine", "stack", "ItemStack"),
            "c_inv": off("ContainerEntity", "inventory", "Inventory*"), "c_dir": off("ContainerEntity", "direction", "Direction"),
            "bo_dir": off("Boiler", "direction", "Direction"), "bo_energy": off("Boiler", "energySource", "EnergySourceHolderTemplate"),
            "ge_dir": off("Generator", "direction", "Direction"), "ge_energy": off("Generator", "electricEnergySource", "EnergySourceHolderTemplate"),
            "at_inv": off("AmmoTurret", "inventory", "Inventory"), "at_energy": off("AmmoTurret", "energySource", "EnergySourceHolderTemplate"),
            "ch_inv": off("Character", "inventory", "InventoryWithFilters"), "ch_guns": off("Character", "gunSlots", "InventoryWithFilters"), "ch_ammo": off("Character", "ammoSlots", "InventoryWithFilters"), "ch_armor": off("Character", "armorSlots", "Inventory"),
            "res_amount": off("ResourceEntity", "resourceAmount", "uint32"),
            "rad_energy": off("Radar", "energySource", "EnergySourceHolderTemplate"),
            # 推算状态要的原始字段 (status.ts / status.py; 规则来自游戏的 getStatus 函数)
            "usage": off("Entity", "usageBitMask", "EntityUsageBitMask"), "u_flags": off("UpdatableEntity", "flags", "uint8"),
            "cm_speed": off("CraftingMachinePrototype", "craftingSpeed", "double"), "cm_stored": off("CraftingMachine", "energyStoredInProduct", "double"), "cm_bonus": off("CraftingMachine", "bonusProduction", "double"), "r_energy": off("RecipePrototype", "energyRequired", "double"),
            "b_rem": off("Burner", "remainingPartOfBurningFuel", "double"), "inv_nonfull": off("Inventory", "firstNonFullIndex", "uint16"),
            "md_stuck": off("MiningDrill", "stuckItems", "StuckItems"), "md_res": off("MiningDrill", "resourcesToMine", "std::vector<Targeter"), "md_drop": off("MiningDrill", "dropTarget", "DropTarget"),
            "ins_drop": off("Inserter", "dropTarget", "DropTarget"), "ins_pick": off("Inserter", "pickupTarget", "NotifiableTargeter"), "ins_head": off("Inserter", "headOrientation", "RealOrientation"), "ins_dist": off("Inserter", "handDistance", "double"), "ins_dh": off("Inserter", "dropoffHandTarget", "InserterHandTarget"), "ins_ph": off("Inserter", "pickupHandTarget", "InserterHandTarget"),
            "ht_dist": off("InserterHandTarget", "distance", "double"), "ht_or": off("InserterHandTarget", "orientation", "RealOrientation"),
            "ins_pv": off("Inserter", "pickupVector", "Vector"), "ins_dv": off("Inserter", "dropoffVector", "Vector"),
            # 邻居和归属 (模组的 belt_neighbours / drop_target / electric_network_id 这些): 指针就是对方实体的地址, 行里的 addr 能对上
            "belt_conn": off("TransportBeltConnectable", "connections", "FourDirectionPointers"), "tb_shape": off("TransportBelt", "shape", "TransportBelt::Shape"),
            "ug_type": off("UndergroundBelt", "type", "UndergroundBeltType"), "ug_conn": off("UndergroundBelt", "connection", "UndergroundBelt*"), "sp_conn2": off("Splitter", "secondaryConnections", "FourDirectionPointers"),
            "pole_conn": off("ElectricPole", "copperConnector", "CopperWireConnector"), "cw_net": off("CopperWireConnector", "network", "ElectricSubNetwork*"), "net_index": off("ElectricSubNetwork", "index", "uint32"),
            "cm_mods": off("CraftingMachine", "moduleInventory", "InventoryWithStackLimit"), "md_mods": off("MiningDrill", "moduleInventory", "InventoryWithStackLimit"), "lab_mods": off("Lab", "moduleInventory", "InventoryWithStackLimit"),
            "cm_eff": off("CraftingMachine", "effectReceiver", "EffectReceiver"), "md_eff": off("MiningDrill", "effectReceiver", "EffectReceiver"), "lab_eff": off("Lab", "effectReceiver", "EffectReceiver"), "er_effect": off("EffectReceiver", "effect", "Effect"),
            "cm_mirror": off("CraftingMachine", "mirroring", "NamedBool"), "md_mirror": off("MiningDrill", "mirroring", "NamedBool"),
            "ins_filter": off("Inserter", "filter", "std::array<IDWithQualityFilter"), "ins_spoil": off("Inserter", "spoilPriority", "SpoilPriority"), "ins_over": off("Inserter", "stackSizeOverride", "uint8"),
            "ie_stack": off("ItemEntity", "itemStack", "ItemStack"),
            "wc_conns": off("WireConnector", "connections", "SmallVector<WireConnection"), "sv_begin": off("SmallVector<WireConnection,5,0>", "begin_", "WireConnection*"), "sv_end": off("SmallVector<WireConnection,5,0>", "end_", "WireConnection*"), "wc_target": off("WireConnection", "target", "WireConnector*"), "wc_origin": off("WireConnection", "origin", "WireOrigin"), "cw_owner": off("CopperWireConnector", "owner", "Entity*"),
        }
        self.upd = {c: cached_layout(pd, exe, f"off:{c}.base.UpdatableEntity", lambda c=c: base_offset(pd, exe, c, "UpdatableEntity")) for c in ("CraftingMachine", "MiningDrill", "Inserter")}
        self.recipe_vec = base + cached_layout(pd, exe, "rva:PrototypeList<RecipePrototype>::indexToPrototype", lambda: rva(pd, exe, "PrototypeList<RecipePrototype>::indexToPrototype"))
        self.stack_size = 24
        self.item_size = 32

    def use_recipes(self, recipes: dict) -> None:
        """导出数据里每个配方的物品产物 (配方名 → [(物品, 每次几个)]); 算"堵料"要 (output_over)"""
        out: dict = {}
        for name, rec in (recipes or {}).items():
            rows = []
            for p in rec.get("results") or []:
                if isinstance(p, dict) and p.get("type", "item") == "item":
                    a = p.get("amount", p.get("amount_max", 1))
                    rows.append((p.get("name"), a))
            out[name] = rows
        self.recipe_items = out

    def use_prototypes(self, raw: dict) -> None:
        """导出数据里带 default_status 的实体原型 (2.1.24 只有开局坠机残骸的容器, broken): 推算状态时容器用它代替 normal"""
        out: dict[str, str] = {}
        for rows in (raw or {}).values():
            if isinstance(rows, dict):
                for name, p in rows.items():
                    if isinstance(p, dict) and isinstance(p.get("default_status"), str):
                        out[name] = p["default_status"]
        self.default_status = out

    def output_over(self, ent: int, d: dict) -> bool:
        """组装机没在做时产物够不够多到算堵料 (游戏的 idle full output; 模组 outputstop.lua, 2.0.77 实测: 每次产量 × (1 + ⌈1.166 × 机器速度 / 配方秒数⌉))。
        不能只看 CraftingMachineFlags::FULL: 那个标记机械臂碰过才置上, 刚读完地图时大多没有 (2026-11-06 联机服务器的存档副本: 真值 296 台堵料, 只看标记时读成缺料)"""
        rows = self.recipe_items.get(d.get("recipe") or "")
        energy = d.get("recipeEnergy") or 0
        if not rows or energy <= 0:
            return False
        r = self.r
        speed = r.f64(r.u64(ent + self.proto_off) + self.o["cm_speed"]) * (1 + 0.3 * QUALITY_LEVEL.get(d.get("quality"), 0))
        speed *= max(0.2, 1 + (d.get("effect") or {}).get("speed", 0) * 0.0001)
        crafts = 1 + math.ceil(1.166 * speed / energy - 1e-9)
        held = {x["name"]: x["count"] for x in d.get("output") or []}
        return any(held.get(name, 0) >= amount * crafts - 1e-6 for name, amount in rows)

    def recipe_energy(self, rid: int) -> float:
        r = self.r
        p = r.u64(r.u64(self.recipe_vec) + rid * 8)
        return r.f64(p + self.o["r_energy"]) if plausible(p) else 0.0

    def target_full(self, ent: int):
        """机械臂要放进去的那个实体"满不满" (getStatus 调的 isFullForInserters): 机器看 FULL 标记, 箱子看第一个没满的格子; 别的类 None"""
        if not plausible(ent):
            return None
        o, r = self.o, self.r
        cls = self.vt.get(r.u64(ent))
        if cls in ("AssemblingMachine", "Furnace"):
            return bool(r.u8(ent + o["cm_flags"]) & 2)
        if cls in ("ContainerEntity", "LogisticContainer"):
            inv = r.u64(ent + o["c_inv"])
            return r.u16(inv + o["inv_nonfull"]) >= r.u16(inv + o["inv_size"]) if plausible(inv) else None
        # 烧燃料的目标 (Burner::isFullForInserters): 燃料够 5 个就不再往里放 (后半句还要比燃料总能量 ≥ 热量缓冲的几倍, 煤这种普通燃料 5 个都够)
        holder = {"Boiler": o["bo_energy"], "MiningDrill": o["md_energy"]}.get(cls)
        if holder is not None:
            p = self.energy(ent + holder)
            return sum(s["count"] for s in p.get("fuel", [])) >= 5 if p.get("src") == "burner" else False
        return None if cls == "Lab" else False

    def effect(self, receiver: int) -> dict | None:
        """EffectReceiver.effect (插件 + 塔的合计): 五个 int32 的原始值 (EffectValue::MULTIPLIER 是常量, pdb 里没符号; 倍率由 npm run io:modhost 对真值核)。全 0 回 None"""
        raw = self.r.read(receiver + self.o["er_effect"], 20)
        v = [int.from_bytes(raw[i * 4 : i * 4 + 4], "little", signed=True) for i in range(5)]
        if not any(v):
            return None
        return dict(zip(("consumption", "speed", "productivity", "pollution", "quality"), v))

    def stacks(self, inv: int) -> list[dict]:
        """一个 Inventory → 合并后的 [{name, quality, count}] (按第一次出现的格子排, 和 get_contents 一样)"""
        o, r = self.o, self.r
        data = r.u64(inv + o["inv_data"])
        size = r.u16(inv + o["inv_size"])
        if not data or size == 0:
            return []
        if size > 4096:
            raise ValueError(f"背包大小不合理 {size}")
        raw = r.read(data, size * self.stack_size)
        out: list[dict] = []
        for i in range(size):
            b = i * self.stack_size
            count = int.from_bytes(raw[b + o["st_count"] : b + o["st_count"] + 4], "little")
            if count == 0:
                continue
            item = int.from_bytes(raw[b + o["st_item"] : b + o["st_item"] + 2], "little")
            q = raw[b + o["st_q"]]
            name, quality = self.items.get(item, f"?{item}"), self.qualities.get(q, f"?{q}")
            hit = next((s for s in out if s["name"] == name and s["quality"] == quality), None)
            if hit:
                hit["count"] += count
            else:
                out.append({"name": name, "quality": quality, "count": count})
        return out

    def slots(self, inv: int) -> list:
        """一格一格的 (空格是 0): 角色主背包要知道还有几个空格、第几格放什么"""
        o, r = self.o, self.r
        data = r.u64(inv + o["inv_data"])
        size = r.u16(inv + o["inv_size"])
        if not data or size == 0 or size > 4096:
            return []
        raw = r.read(data, size * self.stack_size)
        out: list = []
        for i in range(size):
            b = i * self.stack_size
            count = int.from_bytes(raw[b + o["st_count"] : b + o["st_count"] + 4], "little")
            if count == 0:
                out.append(0)
                continue
            item = int.from_bytes(raw[b + o["st_item"] : b + o["st_item"] + 2], "little")
            q = raw[b + o["st_q"]]
            out.append({"name": self.items.get(item, f"?{item}"), "quality": self.qualities.get(q, f"?{q}"), "count": count})
        return out

    def energy(self, holder: int) -> dict:
        o, r = self.o, self.r
        src = r.u64(holder)
        if not plausible(src):
            return {}
        kind = r.u8(src + o["src_type"])
        if kind == 0:  # Burner
            return {"src": "burner", "energy": r.f64(src + o["b_heat"]), "remaining": r.f64(src + o["b_rem"]), "fuel": self.stacks(src + o["b_fuel"]), "burnt": self.stacks(src + o["b_burnt"]), "burning": self.items.get(r.u16(src + o["b_item"]))}
        if kind == 1:  # Electric
            net = r.u64(src + o["e_net"])
            out = {"src": "electric", "energy": r.f64(src + o["e_buf"]), "capacity": r.f64(src + o["e_buf"] + 8), "network": 1 if net else 0}
            if plausible(net):
                out["netId"] = r.u32(net + o["net_index"]) + 1  # LuaEntity.electric_network_id = 子网 index + 1 (对过真值)
            return out
        return {"src": ["burner", "electric", "heat", "void", "fluid"][kind] if kind < 5 else str(kind)}

    def line(self, connector: int) -> list[dict]:
        """带子一条道 (TransportLineConnector) 上的物品: 只算落在这一格范围里的。物品从线的尾头开始排, distanceToFirst 是第一个物品离尾头多远, distanceToNext 是到下一个的距离; 距离都是定点数"""
        o, r = self.o, self.r
        line = r.u64(connector + o["tc_line"])
        if not plausible(line):
            return []
        start = int.from_bytes(r.read(connector + o["tc_range"], 4), "little", signed=True)
        end = int.from_bytes(r.read(connector + o["tc_range"] + 4, 4), "little", signed=True)
        d = int.from_bytes(r.read(line + o["tl_first"], 4), "little", signed=True)
        deq = line + o["tl_items"]
        data, cap, head, size = r.u64(deq + o["cd_data"]), r.u32(deq + o["cd_cap"]), r.u32(deq + o["cd_head"]), r.u32(deq + o["cd_size"])
        if not data or size == 0 or cap == 0 or size > cap or cap > 1 << 20:
            return []
        raw = r.read(data, cap * self.item_size)
        out: list[dict] = []
        for k in range(size):
            b = ((head + k) % cap) * self.item_size
            if start <= d < end:
                s = b + o["it_stack"]
                count = int.from_bytes(raw[s + o["st_count"] : s + o["st_count"] + 4], "little")
                item = int.from_bytes(raw[s + o["st_item"] : s + o["st_item"] + 2], "little")
                q = raw[s + o["st_q"]]
                name, quality = self.items.get(item, f"?{item}"), self.qualities.get(q, f"?{q}")
                hit = next((x for x in out if x["name"] == name and x["quality"] == quality), None)
                if hit:
                    hit["count"] += count
                else:
                    out.append({"name": name, "quality": quality, "count": count})
            d += int.from_bytes(raw[b + o["it_gap"] : b + o["it_gap"] + 4], "little", signed=True)
        return out

    def health(self, ent: int) -> float | None:
        """只读血量 (和 read 里同样的算法); 没有血量的类型 None"""
        cls = self.vt.get(self.r.u64(ent))
        if not cls or cls in ("ResourceEntity", "ItemEntity"):
            return None
        return self.r.f32(ent + self.o["health"]) * self.max_health(self.r.u64(ent + self.proto_off))

    def max_health(self, proto: int) -> float:
        hit = self.max_health_cache.get(proto)
        if hit is None:
            hit = self.max_health_cache[proto] = self.r.f32(proto + self.max_health_off)
        return hit

    def read(self, ent: int) -> dict | None:
        cls = self.vt.get(self.r.u64(ent))
        if not cls:
            return None
        o, r = self.o, self.r
        d: dict = {"cls": cls}
        if cls == "ResourceEntity":
            d["amount"] = r.u32(ent + o["res_amount"])
            return d
        if cls == "ItemEntity":  # 地上的物品: 不是 EntityWithHealth, 下面那些偏移不能读
            st = ent + o["ie_stack"]
            cnt = r.u32(st + o["st_count"])
            d["stack"] = {"name": self.items.get(r.u16(st + o["st_item"])), "quality": self.qualities.get(r.u8(st + o["st_q"])), "count": cnt} if cnt else None
            return d
        # 内存里血量是比例 (满血 = 1), 上限在原型里
        proto = r.u64(ent + self.proto_off)
        d["health"] = r.f32(ent + o["health"]) * r.f32(proto + self.max_health_off)
        d["force"] = r.u8(ent + o["force"])
        d["quality"] = self.qualities.get(r.u8(ent + o["quality"]))
        d["usage"] = r.u16(ent + o["usage"])
        if cls in ("AssemblingMachine", "Furnace"):
            d["direction"] = r.u8(ent + o["cm_dir"])
            d["mirroring"] = bool(r.u8(ent + o["cm_mirror"]))
            d["flags"] = r.u8(ent + o["cm_flags"])
            d["sleep"] = r.u8(ent + o["cm_sleep"])
            rid = r.u16(ent + o["cm_recipe"])
            d["recipe"] = self.recipes.get(rid) if rid else None
            d["done"] = r.u32(ent + o["cm_done"])
            d["stored"] = r.f64(ent + o["cm_stored"])
            d["bonus"] = r.f64(ent + o["cm_bonus"])
            d["recipeEnergy"] = self.recipe_energy(rid) if rid else 0.0
            d["active"] = r.u8(ent + self.upd["CraftingMachine"] + o["u_flags"]) & 1
            d["input"] = self.stacks(ent + o["cm_src"])
            d["output"] = self.stacks(ent + o["cm_res"])
            d["modules"] = self.stacks(ent + o["cm_mods"])
            d["moduleSlots"] = r.u16(ent + o["cm_mods"] + o["inv_size"])
            d["effect"] = self.effect(ent + o["cm_eff"])
            d["power"] = self.energy(ent + o["cm_energy"])
            if cls == "AssemblingMachine" and d["stored"] <= 0 and d["output"] and self.recipe_items:
                d["outFull"] = self.output_over(ent, d)
        elif cls == "MiningDrill":
            d["direction"] = r.u8(ent + o["md_dir"])
            d["mirroring"] = bool(r.u8(ent + o["md_mirror"]))
            d["output"] = self.stacks(ent + o["md_buf"])
            d["bufferEmpty"] = r.u8(ent + o["md_empty"])
            d["waitingForFluid"] = r.u8(ent + o["md_fluid"])
            mining = r.u64(ent + o["md_target"] + o["tg_target"])
            d["hasTarget"] = 1 if mining else 0
            d["miningTarget"] = mining if plausible(mining) else 0
            d["active"] = r.u8(ent + self.upd["MiningDrill"] + o["u_flags"]) & 1
            d["stuck"] = r.u64(ent + o["md_stuck"] + 32)  # std::deque 的元素个数 (MSVC: _Map, _Mapsize, _Myoff, _Mysize; getStatus 读的就是 +0x20)
            d["resources"] = (r.u64(ent + o["md_res"] + 8) - r.u64(ent + o["md_res"])) // 32
            drop = r.u64(ent + o["md_drop"] + o["tg_target"])
            d["dropDeconstruct"] = bool(plausible(drop) and r.u16(drop + o["usage"]) & 0x4000)
            d["dropFull"] = self.target_full(drop)
            d["dropTarget"] = drop if plausible(drop) else 0
            d["modules"] = self.stacks(ent + o["md_mods"])
            d["moduleSlots"] = r.u16(ent + o["md_mods"] + o["inv_size"])
            d["effect"] = self.effect(ent + o["md_eff"])
            d["power"] = self.energy(ent + o["md_energy"])
        elif cls == "Lab":
            d["input"] = self.stacks(ent + o["lab_in"])
            d["last"] = r.u8(ent + o["lab_last"])
            d["modules"] = self.stacks(ent + o["lab_mods"])
            d["moduleSlots"] = r.u16(ent + o["lab_mods"] + o["inv_size"])
            d["effect"] = self.effect(ent + o["lab_eff"])
            d["power"] = self.energy(ent + o["lab_energy"])
        elif cls == "Inserter":
            d["direction"] = r.u8(ent + o["ins_dir"])
            held = ent + o["ins_held"]
            cnt = r.u32(held + o["st_count"])
            d["held"] = {"name": self.items.get(r.u16(held + o["st_item"])), "count": cnt} if cnt else None
            d["flags"] = r.u16(ent + o["ins_flags"])
            d["active"] = r.u8(ent + self.upd["Inserter"] + o["u_flags"]) & 1
            d["heldItem"] = r.u16(held + o["st_item"])
            drop = r.u64(ent + o["ins_drop"] + o["tg_target"])
            raw = r.read(ent + o["ins_filter"], 20)
            filters = [self.items.get(int.from_bytes(raw[i * 4 : i * 4 + 2], "little")) if int.from_bytes(raw[i * 4 : i * 4 + 2], "little") else None for i in range(5)]
            if any(filters):
                d["filters"] = filters
            d["spoil"] = r.u8(ent + o["ins_spoil"])
            d["handOverride"] = r.u8(ent + o["ins_over"])
            d["hasDrop"] = 1 if plausible(drop) else 0
            d["dropTarget"] = drop if plausible(drop) else 0
            pick = r.u64(ent + o["ins_pick"] + o["tg_target"])
            d["pickTarget"] = pick if plausible(pick) else 0
            d["dropFull"] = self.target_full(drop)
            head = r.read(ent + o["ins_head"], 4)
            d["atPickup"] = head == r.read(ent + o["ins_ph"] + o["ht_or"], 4) and abs(r.f64(ent + o["ins_ph"] + o["ht_dist"]) - r.f64(ent + o["ins_dist"])) < 1e-3
            d["atDrop"] = head == r.read(ent + o["ins_dh"] + o["ht_or"], 4) and r.f64(ent + o["ins_dh"] + o["ht_dist"]) == r.f64(ent + o["ins_dist"])
            d["pickVec"] = [r.f64(ent + o["ins_pv"]), r.f64(ent + o["ins_pv"] + 8)]
            d["dropVec"] = [r.f64(ent + o["ins_dv"]), r.f64(ent + o["ins_dv"] + 8)]
            d["power"] = self.energy(ent + o["ins_energy"])
        elif cls in ("TransportBelt", "UndergroundBelt", "Splitter"):
            d["direction"] = r.u8(ent + o["belt_dir"])
            raw = r.read(ent + o["belt_conn"], 32)
            # 北东南西四个方向连着谁 (0 = 没有); 朝向那一格是下游, 别的是上游
            d["conn"] = [int.from_bytes(raw[i * 8 : i * 8 + 8], "little") for i in range(4)]
            if cls == "TransportBelt":
                d["lines"] = [self.line(ent + o["belt_l"]), self.line(ent + o["belt_r"])]
                d["shape"] = r.u8(ent + o["tb_shape"])
            elif cls == "UndergroundBelt":
                d["ugType"] = r.u8(ent + o["ug_type"])
                pair = r.u64(ent + o["ug_conn"])
                d["ugPair"] = pair if plausible(pair) else 0
            else:
                raw = r.read(ent + o["sp_conn2"], 32)
                d["conn2"] = [int.from_bytes(raw[i * 8 : i * 8 + 8], "little") for i in range(4)]
        elif cls in ("ContainerEntity", "LogisticContainer"):
            inv = r.u64(ent + o["c_inv"])
            d["chest"] = self.stacks(inv) if plausible(inv) else []
            if self.default_status:
                ds = self.default_status.get(r.msvc_string(proto + self.name_off))
                if ds:
                    d["defaultStatus"] = ds
        elif cls == "Boiler":
            d["direction"] = r.u8(ent + o["bo_dir"])
            d["power"] = self.energy(ent + o["bo_energy"])
        elif cls == "Generator":
            d["direction"] = r.u8(ent + o["ge_dir"])
            d["power"] = self.energy(ent + o["ge_energy"])
        elif cls == "AmmoTurret":
            d["ammo"] = self.stacks(ent + o["at_inv"])
        elif cls == "Character":
            d["main"] = self.stacks(ent + o["ch_inv"])
            d["mainSlots"] = self.slots(ent + o["ch_inv"])
            d["guns"] = self.stacks(ent + o["ch_guns"])
            d["ammo"] = self.stacks(ent + o["ch_ammo"])
            d["armor"] = self.stacks(ent + o["ch_armor"])
        elif cls == "Radar":
            d["power"] = self.energy(ent + o["rad_energy"])
        elif cls == "ElectricPole":
            net = r.u64(ent + o["pole_conn"] + o["cw_net"])
            if plausible(net):
                d["netId"] = r.u32(net + o["net_index"]) + 1
            # 铜线连着谁: 连接器的 SmallVector<WireConnection> → 对方连接器 → 它的 owner (对方实体地址)
            conns = ent + o["pole_conn"] + o["wc_conns"]
            begin, end = r.u64(conns + o["sv_begin"]), r.u64(conns + o["sv_end"])
            wires = []
            if plausible(begin) and 0 <= end - begin <= 16 * 64:
                raw = r.read(begin, end - begin)
                for i in range(0, len(raw), 16):
                    target = int.from_bytes(raw[i + o["wc_target"] : i + o["wc_target"] + 8], "little")
                    if plausible(target):
                        wires.append({"addr": r.u64(target + o["cw_owner"]), "origin": raw[i + o["wc_origin"]]})
            d["wires"] = wires
        return d


class EntityScan:
    """读一个地表上的实体: 全部、按区块、按地址 (游戏外的模组宿主按需读, 不用每次读全图)"""

    CELL = 8

    def __init__(self, r: Reader, base: int, pd: str, exe: str, off, surface: int, is_owned, details: bool = True):
        self.r, self.surface, self.is_owned = r, surface, is_owned
        # 基类偏移 pdb-dump 不按成员列: Surface 的成员表里写 "+24 base InfiniteRectangle<Chunk *>", 这里按同样的办法取
        self.o_rect = cached_layout(pd, exe, "off:Surface.base.InfiniteRectangle", lambda: base_offset(pd, exe, "Surface", "InfiniteRectangle<Chunk *>"))
        self.o_tiles = off("Chunk", "advancedTiles", "ChunkAdvancedTiles")
        self.o_c_surface = off("Chunk", "surface", "Surface*")
        self.o_c_pos = off("Chunk", "position", "ChunkPosition")
        self.o_proto = off("Entity", "prototype", "EntityPrototype*")
        self.o_pos = off("Entity", "position", "MapPosition")
        self.o_e_surface = off("Entity", "surface", "Surface*")
        self.o_unit = off("EntityWithOwner", "unitNumber", "uint64")
        self.o_force = off("EntityWithOwner", "forceID", "ForceID")
        self.o_name = off("PrototypeBase", "name", "std::basic_string")
        self.o_next = off("EntityConnector", "nextOnTile", "EntityConnector*")
        self.o_entity = off("EntityConnector", "entity", "Entity*")
        self.o_back = off("EntityConnector", "advancedTile", "AdvancedTile*")
        self.details = Details(r, base, pd, exe, off) if details else None
        self.proto_names: dict[int, str] = {}
        self.eager = bool(details)  # True: 读实体时细节一起读 (留底、核对); LiveSource 改成 False, 模组用到才读
        self.wild: dict[int, tuple[float, list]] = {}

    def new_dropped(self) -> dict:
        return {"chunk": 0, "back": 0, "entity": 0, "loop": 0, "read": 0}

    def chunk_at(self, cx: int, cy: int) -> int:
        """InfiniteRectangle<Chunk*>: 外层下标 x, 内层下标 y, 各带 zeroIndex (2026-11-06 对过 Chunk.position); 没有回 0"""
        r = self.r
        rect = self.surface + self.o_rect
        raw = r.read(rect, 16)
        data, rows, zero = int.from_bytes(raw[0:8], "little"), int.from_bytes(raw[8:12], "little", signed=True), int.from_bytes(raw[12:16], "little", signed=True)
        i = cx + zero
        if not data or not 0 <= i < rows:
            return 0
        raw = r.read(data + i * 16, 16)
        cells, n, z = int.from_bytes(raw[0:8], "little"), int.from_bytes(raw[8:12], "little", signed=True), int.from_bytes(raw[12:16], "little", signed=True)
        j = cy + z
        if not cells or not 0 <= j < n:
            return 0
        return r.u64(cells + j * 8)

    def details_of(self, ent: int) -> dict:
        """一个实体的细节 (背包、状态、带子上的货…): 模组用到才读 (fake_game.lua ROW_MT), 不用的不花时间"""
        try:
            d = self.details.read(ent) if self.details else None
            if not d:
                return {}
            status = mem_status(d)
            return {"d": d} if status is None else {"d": d, "status": status}
        except (OSError, ValueError) as e:
            return {"d_error": str(e)[:120]}

    def fill_health(self, rows: list, force: int) -> None:
        """比对受损用: 只读我方的血量, 不读别的细节 (row["hp"]; 一个实体 3 次读内存)"""
        for row in rows:
            if row.get("force") == force:
                try:
                    h = self.details.health(row["addr"]) if self.details else None
                except (OSError, ValueError):
                    h = None
                if h is not None:
                    row["hp"] = h

    def read_entity(self, ent: int, dropped: dict) -> dict | None:
        r = self.r
        o_proto, o_pos = self.o_proto, self.o_pos
        head = r.read(ent + o_proto, o_pos + 8 - o_proto)
        proto = int.from_bytes(head[0:8], "little")
        px = int.from_bytes(head[o_pos - o_proto : o_pos - o_proto + 4], "little", signed=True)
        py = int.from_bytes(head[o_pos - o_proto + 4 : o_pos - o_proto + 8], "little", signed=True)
        if r.u64(ent + self.o_e_surface) != self.surface or not plausible(proto):
            dropped["entity"] += 1
            return None
        name = self.proto_names.get(proto)
        if name is None:
            name = r.msvc_string(proto + self.o_name)
            self.proto_names[proto] = name
        row = {"name": name, "x": px / 256.0, "y": py / 256.0, "addr": ent}
        if self.is_owned(name):
            row["unit"] = r.u64(ent + self.o_unit)
            row["force"] = r.u8(ent + self.o_force)
        if self.eager:
            row.update(self.details_of(ent))
        return row

    def read_chunk(self, ch: int, seen: set, out: list, dropped: dict, pending: list | None = None, pending_seen: set | None = None) -> None:
        """pending 不是 None 时只把有主的放进 out, 树石这些放 pending (全新地星 26.7 万件里只有 4.4 万是我方, 大多数查询用不到它们)"""
        r = self.r
        o_back, o_entity, o_next = self.o_back, self.o_entity, self.o_next
        try:
            if r.u64(ch + self.o_c_surface) != self.surface:
                dropped["chunk"] += 1
                return
            tiles = r.read(ch + self.o_tiles, 16 * 16 * self.CELL)
        except OSError:
            dropped["read"] += 1
            return
        for k in range(16 * 16):
            node = int.from_bytes(tiles[k * self.CELL : k * self.CELL + 8], "little")
            cell = ch + self.o_tiles + k * self.CELL
            guard = 0
            while node:
                guard += 1
                if guard > 4096:
                    dropped["loop"] += 1
                    break
                try:
                    raw = r.read(node, 40)
                    if int.from_bytes(raw[o_back:o_back + 8], "little") != cell:
                        dropped["back"] += 1  # 这个节点这一刻不属于这一格 (游戏线程在改) 或布局错了
                        break
                    ent = int.from_bytes(raw[o_entity:o_entity + 8], "little")
                    node = int.from_bytes(raw[o_next:o_next + 8], "little")
                    if ent in seen or not plausible(ent) or (pending_seen is not None and ent in pending_seen):
                        continue
                    row = self.read_entity(ent, dropped)
                    if row is None:
                        continue
                    if pending is not None and "unit" not in row:
                        pending_seen.add(ent)
                        pending.append(row)
                    else:
                        seen.add(ent)
                        out.append(row)
                except (OSError, ValueError):
                    dropped["read"] += 1
                    break

    def read_chunks(self, positions: list, seen: set, out: list, dropped: dict) -> None:
        for cx, cy in positions:
            ch = self.chunk_at(int(cx), int(cy))
            if ch:
                self.read_chunk(ch, seen, out, dropped)

    def refresh_near(self, cx: int, cy: int, radius: int = 3) -> None:
        """身体旁边的野外区块下次重读: 刚在这儿放的东西要马上看得到"""
        if not self.wild:
            return
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                ch = self.chunk_at(cx + dx, cy + dy)
                if ch:
                    self.wild.pop(ch, None)

    def read_all(self, seen: set | None = None, pending: list | None = None, fresh: bool = False) -> tuple[list, dict, int]:
        """读全地表。没有东西归谁的野外区块隔一会才重读一次 (self.wild, WILD_TTL 秒): 区块大半是野外, 树和矿不会自己变。
        pending 给了: out 只放有主的, 无主的进 pending (查询用到才转给模组)。
        fresh: 不用缓存, 顺带更新它。比对事件要这样: 虫子走进缓存的区块看着就像死了 (2026-11-06 回归查出 100 条假死亡)"""
        out: list = []
        dropped = self.new_dropped()
        chunks = grid_chunks(self.r, self.surface + self.o_rect)
        seen = set() if seen is None else seen
        pending_seen: set = set()
        now = time.monotonic()
        for ch in chunks:
            hit = None if fresh else self.wild.get(ch)
            if hit and now < hit[0]:
                for row in hit[1]:
                    ent = row["addr"]
                    if ent in seen or ent in pending_seen:
                        continue
                    if pending is not None:
                        pending_seen.add(ent)
                        pending.append(row)
                    else:
                        seen.add(ent)
                        out.append(row)
                continue
            mine: list = []
            natural: list = []
            if pending is None:
                self.read_chunk(ch, seen, mine, dropped)  # 一个列表, 区块里的顺序和游戏一样
                natural = [row for row in mine if "unit" not in row]
            else:
                self.read_chunk(ch, seen, mine, dropped, natural, pending_seen)
                pending.extend(natural)
            if any("unit" in row for row in mine):
                self.wild.pop(ch, None)
            elif not self.eager:
                self.wild[ch] = (now + WILD_TTL + (ch >> 6) % 16, natural)  # 错开重读, 不要一起到期
            out.extend(mine)
        return out, dropped, len(chunks)


def default_pdb_dump() -> str:
    return proto_default_pdb_dump()


def layout_reader(pd: str, exe: str):
    """深度 0: 只看这个结构自己的成员。展开一层会撞上嵌套里的同名成员 (Game 的 chartBundleRequest 里也有 Map* map, 读到 +8, 2026-11-06 踩过)"""
    return lambda struct, member, prefix: cached_layout(pd, exe, f"off0:{struct}.{member}", lambda: member_offset(pd, exe, struct, member, prefix, 0))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--exe", default=None)
    ap.add_argument("--pdb-dump", default=default_pdb_dump())
    ap.add_argument("--surface", default="nauvis")
    ap.add_argument("--owned", help="JSON 文件: 实体名的列表, 这些读 unitNumber (从游戏数据按类型算; 没给就都不读)")
    ap.add_argument("--details", action="store_true", help="按类读细节 (方向、血量、配方、进出料、燃料、能量、带上物品), 放在每个实体的 d 里")
    ap.add_argument("--proto", help="导出的 data-raw-dump.json: 推算状态要配方产物 (堵料) 和原型的默认状态; 没给就按没有算")
    args = ap.parse_args()
    args.exe = args.exe or default_exe()
    t0 = time.perf_counter()
    r = Reader(args.pid)
    base = r.module_base("factorio.exe")
    pd, exe = args.pdb_dump, args.exe
    off = layout_reader(pd, exe)
    _, surface = find_surface(r, base, pd, exe, off, args.surface)
    owned = set(json.load(open(args.owned, encoding="utf-8"))) if args.owned else set()
    scan = EntityScan(r, base, pd, exe, off, surface, owned.__contains__, args.details)
    if args.proto and scan.details:
        with open(args.proto, encoding="utf-8") as f:
            raw = json.load(f)
        scan.details.use_recipes(raw.get("recipe") or {})
        scan.details.use_prototypes(raw)
    t_layout = time.perf_counter()
    entities, dropped, chunks = scan.read_all()
    t1 = time.perf_counter()
    print(json.dumps({"surface": args.surface, "chunks": chunks, "count": len(entities), "dropped": dropped, "layout_ms": round((t_layout - t0) * 1000), "ms": round((t1 - t_layout) * 1000), "entities": entities}, ensure_ascii=False))
    return 0


def base_offset(pdb_dump: str, exe: str, struct: str, base_name: str) -> int:
    import re
    import subprocess
    out = subprocess.run([pdb_dump, exe, "struct", struct], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    for line in out.stdout.splitlines():
        m = re.match(r"\s*\+(\d+)\tbase\t(.+?) \(", line)
        if m and m.group(2) == base_name:
            return int(m.group(1))
    raise RuntimeError(f"{struct} 没有基类 {base_name}: {out.stdout[:300]}")


if __name__ == "__main__":
    sys.exit(main())
