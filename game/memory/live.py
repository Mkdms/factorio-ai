#!/usr/bin/env python
"""游戏外模组宿主的数据来源: 给 fake_game.lua 一个统一的读取接口, 要么读活内存 (LiveSource), 要么读留底的快照 (SnapshotSource, 核对时回放用)。

接口: begin() 一次提问开始; tick(); rows_all(); rows_chunks([[cx, cy], ...]); row(addr); world(); player()
每次提问各读各的: 世界数据 (约 25 毫秒) 用到才读, 实体只读用到的区块, 全图约 400 毫秒。
只读: 只有 ReadProcessMemory, 不注入, 不写。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I 不把脚本目录放进搜索路径
from entities import EntityScan, Details, default_pdb_dump, find_game, find_surface, layout_reader, plausible  # noqa: E402
from reader import Reader, cached_layout, rva  # noqa: E402
from world import WorldReader  # noqa: E402

# 没有 unit_number / force 的原型类型 (不是 EntityWithOwner, 这几个偏移上读出来是别的东西)。2026-11-06 对真值: 这些类型全没有编号, 其余全有; 别的类型遇到再核
OWNERLESS_TYPES = {"cliff", "tree", "fish", "simple-entity", "resource", "item-entity", "corpse", "rail-remnants", "fire", "stream", "projectile", "smoke-with-trigger", "explosion", "particle-source", "sticker", "beam", "arrow", "flying-text", "highlight-box", "speech-bubble", "deconstructible-tile-proxy", "tile-ghost", "lightning"}


TRANSIENT_TYPES = {"logistic-robot", "construction-robot", "combat-robot", "cargo-pod", "rocket-silo-rocket", "rocket-silo-rocket-shadow", "entity-ghost", "tile-ghost", "item-request-proxy", "deconstructible-tile-proxy"}


class LocalPlayer:
    """本地玩家: global → game → localPlayer → controllerManager.controller; 是角色控制器才有身体 (观战、远程视图没有)"""

    def __init__(self, r: Reader, base: int, pd: str, exe: str, off, details: Details):
        self.r, self.details = r, details
        self.o_global = base + cached_layout(pd, exe, "rva:global", lambda: rva(pd, exe, "global"))
        self.o_game = off("GlobalContext", "game", "Game*")
        self.o_map = off("Game", "map", "Map*")
        self.o_map_game = off("Map", "game", "Game*")
        self.o_local = off("Game", "localPlayer", "Player*")
        self.o_cm = off("Player", "controllerManager", "ControllerManager")
        self.o_cm_player = off("ControllerManager", "player", "Player*")
        self.o_ctrl = off("ControllerManager", "controller", "Controller*")
        self.o_phys = off("ControllerManager", "physicalController", "std::unique_ptr")
        self.o_ctrl_player = off("Controller", "player", "Player*")
        self.o_char = off("CharacterController", "character", "Targeter<Character")
        self.o_target = off("TargeterBase", "target", "Targetable*")
        self.o_pos = off("Entity", "position", "MapPosition")
        self.o_unit = off("EntityWithOwner", "unitNumber", "uint64")
        self.o_index = off("Player", "index", "uint16")
        self.o_name = off("Player", "username", "LowercaseString")
        self.o_admin = off("Player", "admin", "bool")
        self.o_inv = off("Character", "inventory", "InventoryWithFilters")
        self.o_inv_size = off("Inventory", "dataSize", "uint16")
        self.o_e_surface = off("Entity", "surface", "Surface*")

    def surface_addr(self) -> int:
        """身体现在在哪个地表 (Surface*); 观战、远程视图没有身体回 0。每次提问前都问, 只有几次读内存"""
        body = self.body(self.player_addr())
        return self.r.u64(body + self.o_e_surface) if body else 0

    def body(self, player: int) -> int:
        """身体的地址, 没有回 0。controller 是当前视角, 开地图 (远程视图) 时换成 RemoteController, 那个偏移上是别的东西; 身体在 physicalController 上。
        2026-11-06 真服: 有人开地图看基地, 读数就成了"没有身体", 所有读命令报 a living survival character is required; 沙盘 set_controller 复现"""
        r = self.r
        for o in (self.o_phys, self.o_ctrl):
            c = r.u64(player + self.o_cm + o)
            if plausible(c) and r.u64(c + self.o_ctrl_player) == player:
                b = r.u64(c + self.o_char + self.o_target)
                if plausible(b) and self.details.vt.get(r.u64(b)) == "Character":
                    return b
        return 0

    def player_addr(self) -> int:
        r = self.r
        game = find_game(r, self.o_global, self.o_game, self.o_map, self.o_map_game)
        player = r.u64(game + self.o_local)
        if not plausible(player) or r.u64(player + self.o_cm + self.o_cm_player) != player:
            raise RuntimeError("本地玩家这条链不自洽 (不在游戏里?)")
        return player

    def read(self) -> dict:
        r = self.r
        player = self.player_addr()
        controller = r.u64(player + self.o_cm + self.o_ctrl)
        if not plausible(controller) or r.u64(controller + self.o_ctrl_player) != player:
            raise RuntimeError("控制器这条链不自洽")
        # Player.index 从 0 数, LuaPlayer.index 从 1 数
        out: dict = {"index": r.u16(player + self.o_index) + 1, "name": r.msvc_string(player + self.o_name), "admin": bool(r.u8(player + self.o_admin))}
        body = self.body(player)
        if body:
            raw = r.read(body + self.o_pos, 8)
            out["position"] = {"x": int.from_bytes(raw[0:4], "little", signed=True) / 256.0, "y": int.from_bytes(raw[4:8], "little", signed=True) / 256.0}
            out["unit"] = r.u64(body + self.o_unit)
            out["addr"] = body
            d = self.details.read(body)
            out.update(main=d["main"], slots=d["mainSlots"], guns=d["guns"], ammo=d["ammo"], armor=d["armor"], health=d["health"], size=r.u16(body + self.o_inv + self.o_inv_size))
        return out


class ChatReader:
    """聊天: Player.outputConsole.items (MSVC std::list: +0 _Myhead, +8 _Mysize; 节点 +0 next, +8 prev, 值 +16)。从尾巴往回读到上次读过的地方。服务器看不到: 只读本机内存"""

    def __init__(self, r: Reader, off):
        self.r = r
        self.o_console = off("Player", "outputConsole", "OutputConsole*")
        self.o_items = off("OutputConsole", "items", "std::list")
        item = "OutputConsole::Item"
        self.o_tick, self.o_name, self.o_body, self.o_index = off(item, "updateTick", "MapTick"), off(item, "playerName", "std::basic_string"), off(item, "bodyText", "LocalisedString"), off(item, "playerIndex", "uint16")
        self.o_key = off("LocalisedString", "key", "std::basic_string")
        self.o_mode = off("LocalisedString", "mode", "LocalisedString::Mode")
        self.last_tick = None
        self.seen_at_last: set = set()

    def read(self, player: int) -> list:
        r = self.r
        console = r.u64(player + self.o_console)
        if not plausible(console):
            return []
        head, size = r.u64(console + self.o_items), r.u64(console + self.o_items + 8)
        if not plausible(head) or size > 100_000:
            return []
        first_read = self.last_tick is None
        # 最新的在表头 (2026-11-06 对过: 按表尾读会把老消息一遍遍当新的)。从表头读到上次读过的 tick
        out, node, n = [], r.u64(head), 0
        while node != head and n < min(size, 2000):
            n += 1
            item = node + 16
            tick = r.u64(item + self.o_tick)
            if self.last_tick is not None and tick < self.last_tick:
                break
            out.append({"tick": tick, "player": r.msvc_string(item + self.o_name), "index": r.u16(item + self.o_index), "text": r.msvc_string(item + self.o_body + self.o_key), "mode": r.u8(item + self.o_body + self.o_mode), "at": item})
            node = r.u64(node)
        out.reverse()  # 老的在前, 按时间顺序发
        fresh = [m for m in out if m["at"] not in self.seen_at_last]
        if out:
            self.last_tick = out[-1]["tick"]
            self.seen_at_last = {m["at"] for m in out if m["tick"] == self.last_tick}
        return [] if first_read else fresh  # 第一次只记位置: 模组接上之前的聊天不算新消息


class EventWatch:
    """模组靠事件记账 (谁建的、谁死了、受伤), 外面没有事件: 隔几秒读一遍全图, 和上一遍比。比不出的: 谁打的、什么伤害, 中间生了又没了的; 见 docs/io-client.md 11j。
    拆掉 vs 死掉: 死了原地留残骸 (corpse), 拆掉不留"""

    def __init__(self, scan: EntityScan, proto_types: dict, every_seconds: float = 5.0):
        self.scan, self.types, self.every = scan, proto_types, every_seconds
        self.prev: dict | None = None
        self.prev_techs: dict | None = None
        self.next_at = 0.0
        self.player_force = 1  # LiveSource 开起来时按名字查过再改

    def set_forces(self, forces: dict) -> None:
        pf = (forces or {}).get("player") or {}
        if "id" in pf:
            self.player_force = pf["id"]

    def due(self, now: float) -> bool:
        return now >= self.next_at

    def reset(self) -> None:
        """换了地表: 上一遍的实体全在别的地表, 不能拿来比 (不然全算被拆了); 下一遍只记基线"""
        self.prev = None
        self.next_at = 0.0

    def transient(self, row: dict) -> bool:
        """自己会消失的: 不是谁建的也不是谁拆的 (2026-11-06 真服 100 条事件里 29 条物流机器人进港、3 条货舱落地, 还被算成 "Claude-Opus removed 20 of the team's entities")"""
        return self.types.get(row["name"]) in TRANSIENT_TYPES or row["name"].endswith("-shadow")

    def poll(self, now: float) -> list:
        t0 = time.perf_counter()
        fill = getattr(self.scan, "fill_health", None)
        rows, _, _ = self.scan.read_all(fresh=True) if fill else self.scan.read_all()
        if fill:
            fill(rows, self.player_force)
        # 世界大了读一遍就慢 (联机服务器的存档 41MB, 沙盘 1.7MB): 比对最多占一个核的十分之一, 事件晚一点也不要把回答堵住
        self.next_at = now + max(self.every, (time.perf_counter() - t0) * 10)
        cur = {row["addr"]: row for row in rows if "unit" in row}
        prev, self.prev = self.prev, cur
        if prev is None:
            return []
        corpses = {(row["x"], row["y"]) for row in rows if self.types.get(row["name"]) == "corpse"}
        out: list = []
        for addr, row in cur.items():
            old = prev.get(addr)
            if old is None or old.get("unit") != row.get("unit"):
                # 只有玩家势力的算建造; 虫子生成、角色重生不是 (2026-11-06: 一轮 20 条"建造"里 16 条是虫子)
                if row.get("force") == self.player_force and self.types.get(row["name"]) not in ("unit", "character", "corpse", "character-corpse") and not self.transient(row):
                    out.append({"kind": "built", "row": row})
                continue
            # hp: 只读血量那一遍填的 (EntityScan.fill_health); 回放和测试的行带完整细节
            h0, h1 = old.get("hp", (old.get("d") or {}).get("health")), row.get("hp", (row.get("d") or {}).get("health"))
            if h0 is not None and h1 is not None and h1 < h0:
                out.append({"kind": "damaged", "row": row, "amount": h0 - h1})
        for addr, row in prev.items():
            now_row = cur.get(addr)
            if (now_row is None or now_row.get("unit") != row.get("unit")) and not self.transient(row):
                out.append({"kind": "died" if (row["x"], row["y"]) in corpses or row.get("force") != self.player_force else "mined", "row": row})
        return out

    def techs(self, forces: dict) -> list:
        fs = (forces or {}).get("player") or {}
        cur = {k: v.get("count", 0) for k, v in (fs.get("technologies") or {}).items()}
        prev, self.prev_techs = self.prev_techs, cur
        if prev is None:
            return []
        return [k for k, v in cur.items() if v > prev.get(k, 0)]


class LiveSource:
    def __init__(self, pid: int, exe: str, proto_types: dict, surface: str = "nauvis", pdb_dump: str | None = None):
        pd = pdb_dump or default_pdb_dump()
        self.r = Reader(pid)
        base = self.r.module_base("factorio.exe")
        off = layout_reader(pd, exe)
        self.the_map, self.surface = find_surface(self.r, base, pd, exe, off, surface)
        is_owned = lambda name: proto_types.get(name) not in OWNERLESS_TYPES and name in proto_types  # noqa: E731
        self.make_scan = lambda s: EntityScan(self.r, base, pd, exe, off, s, is_owned, False)
        self.o_surfaces = off("Map", "surfaces", "std::vector<Surface")
        self.o_s_name = off("Surface", "name", "std::basic_string")
        self.o_s_index = off("Surface", "index", "SurfaceIndex")
        self.surface_name = surface
        self.scan = EntityScan(self.r, base, pd, exe, off, self.surface, is_owned, True)
        self.scan.eager = False  # 细节模组用到才读 (__py_row_details); 留底 (--dump) 时改回 True
        self.pending: list = []
        self.worlds = WorldReader(self.r, base, pd, exe, off, self.the_map, self.surface)
        self.local = LocalPlayer(self.r, base, pd, exe, off, self.scan.details)
        self.o_tick = off("Map", "entityTick", "MapTick")
        self.o_paused = off("Map", "paused", "bool")
        self.seen: set = set()
        self.dropped = self.scan.new_dropped()
        self.chat_reader = ChatReader(self.r, off)
        self.watch = EventWatch(self.scan, proto_types)
        self.watch.set_forces(self.worlds.read().get("forces"))

    def begin(self) -> None:
        self.seen = set()
        self.pending = []
        self.dropped = self.scan.new_dropped()
        self.follow_body()
        try:
            body = self.local.body(self.local.player_addr())
            if body and self.scan.wild:
                raw = self.r.read(body + self.local.o_pos, 8)
                self.scan.refresh_near(int.from_bytes(raw[0:4], "little", signed=True) // (256 * 32), int.from_bytes(raw[4:8], "little", signed=True) // (256 * 32))
        except (OSError, RuntimeError, ValueError):
            pass  # 客户端正在切换: 这次用缓存

    def surfaces(self) -> list:
        r = self.r
        first, last = r.u64(self.the_map + self.o_surfaces), r.u64(self.the_map + self.o_surfaces + 8)
        n = (last - first) // 8
        if not 0 < n < 4096:
            raise RuntimeError(f"地表个数不合理 {n}")
        return [s for s in (r.u64(first + i * 8) for i in range(n)) if plausible(s)]

    def follow_body(self) -> None:
        """读数跟着身体走 (坐火箭、脚本传送都会换地表): 联机服务器的世界里角色就在 gleba 和 platform-15 上。没有身体就留在原地"""
        try:
            s = self.local.surface_addr()
            if not s or s == self.surface or s not in self.surfaces():
                return
            name = self.r.msvc_string(s + self.o_s_name)
        except (OSError, RuntimeError, ValueError):
            return  # 客户端正在切换: 这次还读原来的, 下次提问再看
        self.surface, self.surface_name = s, name
        self.scan.surface = s
        self.worlds.surface = s
        self.watch.reset()

    def surface_meta(self) -> dict:
        """当前地表的名字和编号 (fake_game.lua 的 LuaSurface 用)。Surface.index 从 0 数, LuaSurface.index 从 1 数 (和 Player.index 一样; 2026-11-06 对真值)"""
        return {"name": self.surface_name, "index": self.r.u16(self.surface + self.o_s_index) + 1}

    def where(self) -> dict:
        """本地玩家在哪, 世界有哪些地表、各有多少东西 (开班时打一行, 也用来核对; 要读全部地表, 只在开班问)"""
        counter = self.make_scan(0)
        rows = []
        for s in self.surfaces():
            counter.surface = s
            ents, dropped, chunks = counter.read_all()
            rows.append({"name": self.r.msvc_string(s + self.o_s_name), "index": self.r.u16(s + self.o_s_index) + 1, "chunks": chunks, "entities": len(ents), "mine": sum(1 for e in ents if e.get("force") == self.watch.player_force), "dropped": sum(dropped.values()), "here": s == self.surface})
        p = self.local.read()
        return {"player": {k: p.get(k) for k in ("name", "index", "admin", "position", "unit")}, "hasBody": "addr" in p, "surfaces": rows}

    def tick(self) -> int:
        return self.r.u64(self.the_map + self.o_tick)

    def paused(self) -> bool:
        return bool(self.r.u8(self.the_map + self.o_paused))

    def rows_all(self) -> list:
        out, dropped, _ = self.scan.read_all(self.seen)
        for k, v in dropped.items():
            self.dropped[k] += v
        return out

    def rows_owned(self) -> list:
        """全地表有主的 (建筑、虫子); 无主的 (树、石头、矿) 留在 pending, 查询用到才给 (rows_natural)"""
        out, dropped, _ = self.scan.read_all(self.seen, self.pending)
        for k, v in dropped.items():
            self.dropped[k] += v
        return out

    def rows_natural(self) -> list:
        out = [row for row in self.pending if row["addr"] not in self.seen]
        self.seen.update(row["addr"] for row in out)
        self.pending = []
        return out

    def row_details(self, addr: int) -> dict:
        return self.scan.details_of(addr)

    def rows_chunks(self, positions: list) -> list:
        out: list = []
        self.scan.read_chunks(positions, self.seen, out, self.dropped)
        return out

    def row(self, addr: int) -> dict | None:
        """按地址读一个实体; 读不了或已经不在这个地表 → None"""
        if not plausible(addr):
            return None
        try:
            return self.scan.read_entity(addr, self.dropped)
        except (OSError, ValueError):
            return None

    def world(self) -> dict:
        return self.worlds.read()

    def player(self) -> dict:
        return self.local.read()

    def events(self) -> list:
        """到点了就比一遍, 回新事件 (建造、死亡、拆除、受损、研究完成、聊天); 没到点回 []"""
        now = time.perf_counter()
        out: list = []
        try:
            player = self.local.player_addr()
            for m in self.chat_reader.read(player):
                out.append({"kind": "chat", **m})
        except (OSError, RuntimeError):
            pass
        if self.watch.due(now):
            out.extend(self.watch.poll(now))
            out.extend({"kind": "research", "name": name} for name in self.watch.techs(self.worlds.read().get("forces")))
        return out


class SnapshotSource:
    """核对时回放: 数据全在留底的 JSON 里"""

    def __init__(self, snap: dict):
        self.snap = snap
        self.rows = snap.get("entities") or []
        self.by_addr = {row["addr"]: row for row in self.rows if "addr" in row}
        self.by_chunk: dict = {}
        for row in self.rows:
            self.by_chunk.setdefault((int(row["x"] // 32), int(row["y"] // 32)), []).append(row)

    def begin(self) -> None:
        pass

    def tick(self) -> int:
        return (self.snap.get("world") or {}).get("tick") or self.snap.get("tick") or 0

    def rows_all(self) -> list:
        return self.rows

    def rows_owned(self) -> list:
        return [row for row in self.rows if "unit" in row]

    def rows_natural(self) -> list:
        return [row for row in self.rows if "unit" not in row]

    def row_details(self, addr: int) -> dict:
        return {}  # 留底的行细节都在

    def rows_chunks(self, positions: list) -> list:
        out: list = []
        for cx, cy in positions:
            out.extend(self.by_chunk.get((int(cx), int(cy)), []))
        return out

    def row(self, addr: int) -> dict | None:
        return self.by_addr.get(addr)

    def world(self) -> dict:
        return self.snap.get("world") or {}

    def player(self) -> dict:
        return self.snap.get("player") or {}

    def events(self) -> list:
        return []  # 回放的世界不动


def use_raw(src, raw: dict):
    """把导出数据里 LiveSource 要用的给它 (配方产物: 算堵料); 回放的快照细节都在, 不用"""
    if hasattr(src, "scan") and src.scan.details:
        src.scan.details.use_recipes(raw.get("recipe") or {})
        src.scan.details.use_prototypes(raw)
    return src


def proto_types_of(raw: dict) -> dict:
    """原型名 → 类型: 有占地框的才算实体; 物品、配方这些表也有同名条目 (比如 lab 既是物品也是实体)"""
    out: dict = {}
    for kind, rows in raw.items():
        if not isinstance(rows, dict):
            continue
        for name, p in rows.items():
            if isinstance(p, dict) and (p.get("selection_box") or p.get("collision_box") or kind == "resource"):
                out.setdefault(name, kind)
    return out


def selftest_events(scans: list, types: dict) -> list:
    """单元测试用 (test/modhost-events.test.ts): 给几遍扫描结果, 回每遍比出来的事件"""
    class FakeScan:
        def __init__(self):
            self.i = -1

        def read_all(self):
            self.i += 1
            return scans[self.i], {}, 0

    w = EventWatch(FakeScan(), types)
    return [w.poll(float(n)) for n in range(len(scans))]


if __name__ == "__main__":
    if "--selftest-events" in sys.argv:
        job = json.loads(sys.stdin.read())
        print(json.dumps(selftest_events(job["scans"], job["types"])))
    else:
        print(json.dumps({"ownerless": sorted(OWNERLESS_TYPES)}))
