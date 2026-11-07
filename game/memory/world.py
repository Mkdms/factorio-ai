#!/usr/bin/env python
"""进程外读游戏内存: 世界级的东西 (研究、科技、势力修正、产量 / 污染统计、污染量、进化度; 只读, 不注入)。

  python -I game/memory/world.py --pid <factorio.exe 的进程号> --exe <它的 exe> [--surface nauvis]

指针链 (游戏 2.1.24, 布局由 pdb-dump 从 factorio.pdb 现场取, 不存偏移表):
  Map.forceManager.forceDataList → ForceData {researchManager, technologies, statistics, evolutionFactorData, 各种修正}
  ResearchManager {researchQueue, researchProgress, technologyInResearch}; ResearchQueue.queue 是 MSVC deque<uint16>
  FlowStatistics<键, 值> {precisions[8], input / output / storageRunningCounts}; 键带品质的是 IDWithQuality (u16 + u8), 值是 uint64, 不带品质的值是 double
  Precision {interval, input / output / storage: FlatMap<键, ElementUsageStatistics>}; ElementUsageStatistics {history: CircularBuffer<float>, currentSample, numZeroSamples, interval}
读不到的不编: 这一块出错就在输出里记 errors。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I 不把脚本目录放进搜索路径
from entities import find_game, find_surface, grid_chunks, plausible  # noqa: E402
from reader import Reader, cached_layout, default_exe, default_pdb_dump, member_offset, read_list, rva  # noqa: E402

ITEM_FLOW = "FlowStatistics<IDWithQuality<ID<ItemPrototype,unsigned short> >,unsigned __int64,void>"
FLUID_FLOW = "FlowStatistics<ID<FluidPrototype,unsigned short>,double,void>"
ENTITY_Q_FLOW = "FlowStatistics<IDWithQuality<ID<EntityPrototype,unsigned short> >,unsigned __int64,void>"
ENTITY_FLOW = "FlowStatistics<ID<EntityPrototype,unsigned short>,double,void>"
ELECTRIC_FLOW = "FlowStatistics<IDWithQuality<ID<EntityPrototype,unsigned short> >,double,ElectricityTag>"
# LuaForce 的属性名 → ForceData 的成员名 (SimpleModifierTarget: value 在 +8)
MODIFIERS = {
    "laboratory_speed_modifier": "laboratorySpeedModifier", "laboratory_productivity_bonus": "laboratoryProductivityBonus",
    "manual_crafting_speed_modifier": "manualCraftingSpeedModifier", "manual_mining_speed_modifier": "manualMiningSpeedModifier",
    "character_running_speed_modifier": "runningSpeedModifier", "character_build_distance_bonus": "buildDistanceBonus",
    "character_item_drop_distance_bonus": "itemDropDistanceBonus", "character_reach_distance_bonus": "reachDistanceBonus",
    "character_resource_reach_distance_bonus": "resourceReachDistanceBonus", "character_item_pickup_distance_bonus": "itemPickupDistanceBonus",
    "character_loot_pickup_distance_bonus": "lootPickupDistanceBonus", "character_inventory_slots_bonus": "characterInventorySlotCountBonus",
    "character_health_bonus": "characterHealthBonus", "mining_drill_productivity_bonus": "miningDrillProductivityBonus",
    "inserter_stack_size_bonus": "inserterStackSizeBonus", "bulk_inserter_capacity_bonus": "bulkInserterCapacityBonus",
    "worker_robots_speed_modifier": "workerRobotsSpeedModifier", "worker_robots_storage_bonus": "workerRobotsStorageBonus", "worker_robots_battery_modifier": "workerRobotsBatteryModifier",
    "belt_stack_size_bonus": "beltStackSizeBonus", "character_trash_slot_count": "characterLogisticTrashSlotCount", "maximum_following_robot_count": "maximumFollowingRobotsCount",
}


class WorldReader:
    def __init__(self, r: Reader, base: int, pd: str, exe: str, off, the_map: int, surface: int):
        self.r, self.pd, self.exe, self.the_map, self.surface = r, pd, exe, the_map, surface
        self.off = off
        flip = lambda d: {v: k for k, v in d.items()}
        self.items = flip(read_list(r, base, pd, exe, "Item", 2)["by_name"])
        self.qualities = flip(read_list(r, base, pd, exe, "Quality", 1)["by_name"])
        self.techs = flip(read_list(r, base, pd, exe, "Technology", 2)["by_name"])
        self.fluids = flip(read_list(r, base, pd, exe, "Fluid", 2)["by_name"])
        self.entity_names = flip(read_list(r, base, pd, exe, "Entity", 2)["by_name"])
        self.o = {
            "ticks": off("Map", "ticksPlayed", "MapTick"), "update_tick": off("Map", "updateTick", "MapTick"), "entity_tick": off("Map", "entityTick", "MapTick"),
            "forces": off("Map", "forceManager", "ForceManager"), "force_list": off("ForceManager", "forceDataList", "std::vector<ForceData"),
            "fd_id": off("ForceData", "id", "ForceID"), "fd_name": off("ForceData", "name", "std::basic_string"), "fd_rm": off("ForceData", "researchManager", "std::unique_ptr<ResearchManager"), "fd_tech": off("ForceData", "technologies", "std::unique_ptr<Technologies"), "fd_stats": off("ForceData", "statistics", "std::vector<ForceStatistics"), "fd_evo": off("ForceData", "evolutionFactorData", "EvolutionFactorData"), "fd_rockets": off("ForceData", "rocketsLaunched", "uint32"),
            "rm_queue": off("ResearchManager", "researchQueue", "ResearchQueue"), "rq_deque": off("ResearchQueue", "queue", "std::deque"), "rm_progress": off("ResearchManager", "researchProgress", "double"), "rm_current": off("ResearchManager", "technologyInResearch", "Technology*"), "rm_units": off("ResearchManager", "numResearchUnits", "uint64"), "rm_state": off("ResearchManager", "researchState", "ResearchState"),
            "t_list": off("Technologies", "indexToInstance", "std::vector<Technology"), "t_proto": off("Technology", "prototype", "TechnologyPrototype*"), "t_enabled": off("Technology", "enabled", "bool"), "t_count": off("Technology", "researchCount", "uint32"), "t_visible": off("Technology", "visibleWhenDisabled", "bool"),
            "p_name": off("PrototypeBase", "name", "std::basic_string"),
            "fs_items": off("ForceStatistics", "itemProductionStatistics", "LazyCreatedStatistics"), "fs_fluids": off("ForceStatistics", "fluidProductionStatistics", "LazyCreatedStatistics"), "fs_kills": off("ForceStatistics", "killCountStatistics", "LazyCreatedStatistics"), "fs_builds": off("ForceStatistics", "buildCountStatistics", "LazyCreatedStatistics"),
            "s_pollution": off("Surface", "pollutionStatistics", "LazyCreatedStatistics"), "s_index": off("Surface", "index", "SurfaceIndex"), "s_platform": off("Surface", "platform", "SpacePlatform*"),
            "ch_pos": off("Chunk", "position", "ChunkPosition"), "ch_pollution": off("Chunk", "pollution", "Pollution"), "po_value": off("Pollution", "value", "double"),
            "cd_data": off("CompactDeque<float>", "_data", "float*"), "cd_cap": off("CompactDeque<float>", "_capacity", "uint32"), "cd_head": off("CompactDeque<float>", "_head", "uint32"), "cd_size": off("CompactDeque<float>", "_size", "uint32"),
        }
        self.o_rect = cached_layout(pd, exe, "off:Surface.base.InfiniteRectangle", lambda: __import__("entities").base_offset(pd, exe, "Surface", "InfiniteRectangle<Chunk *>"))
        self.modifiers = {lua: off("ForceData", member, "SimpleModifierTarget") + 8 for lua, member in MODIFIERS.items()}
        self.flow_off = {}
        self.net = {
            "manager": off("Map", "electricNetworkManager", "std::unique_ptr<ElectricNetworkManager"), "m_list": off("ElectricNetworkManager", "electricNetworkList", "IntrusiveList"),
            "subs": off("ElectricNetwork", "electricSubNetworkList", "IntrusiveList"), "stats": off("ElectricNetwork", "statistics", "std::unique_ptr<FlowStatistics"), "consumers": off("ElectricNetwork", "connectedConsumers", "uint32"), "producers": off("ElectricNetwork", "connectedProducers", "uint32"),
            "index": off("ElectricSubNetwork", "index", "uint32"), "counts": off("ElectricSubNetwork", "connectedEntitiesCounts", "FlatMap"), "type": off("ElectricNetwork", "type", "ElectricNetworkType"), "hook_n": 24, "hook_s": 24,  # 两个类都是 Targetable (24 字节) 后面跟链表钩子; pdb-dump struct 列的基类
        }
        self.chart_off = {"charts": off("ForceData", "charts", "std::map"), "c_chunks": off("Chart", "chartedChunks", "InfiniteRectangle"), "sc_tick": off("SubChart", "tickOfCharting", "MapTick")}
        self.fog_timeout = 600  # SubChart::fogOfWarTimeout 是常量, pdb 里没符号; LuaForce::luaIsChunkVisible 反汇编 (add rcx, 0x258; cmp [map+entityTick], rcx) + 真值 (可见最老 431, 不可见最新 2431)
        self.o["s_global_net"] = off("Surface", "globalElectricNetwork", "ElectricSubNetwork*")
        self.o["paused"] = off("Map", "paused", "bool")
        for flow in (ITEM_FLOW, FLUID_FLOW, ENTITY_Q_FLOW, ENTITY_FLOW, ELECTRIC_FLOW):
            self.flow_off[flow] = {
                "precisions": off(flow, "precisions", "std::array"), "input": off(flow, "inputRunningCounts", "FlatMap"), "output": off(flow, "outputRunningCounts", "FlatMap"), "storage": off(flow, "storageRunningCounts", "FlatMap"),
            }
        precision = f"{ENTITY_FLOW}::Precision"
        self.prec = {"interval": off(precision, "interval", "uint32"), "input": off(precision, "inputElements", "FlatMap"), "output": off(precision, "outputElements", "FlatMap"), "storage": off(precision, "storageElements", "FlatMap")}
        element = f"{precision}::ElementUsageStatistics"
        self.el = {"history": off(element, "history", "CircularBuffer"), "current": off(element, "currentSample", "double"), "zeros": off(element, "numZeroSamples", "uint32"), "interval": off(element, "interval", "uint32")}
        self.precision_size = 128  # std::array<Precision, 8> 是 1024 字节; pdb-dump 的 size 也是 128
        self.pair_el = 72  # Pair<键, ElementUsageStatistics>: 键 4 字节以内, 值对齐到 +8, 64 字节

    def deque_u16(self, deque: int) -> list[int]:
        """MSVC std::deque<uint16>: +8 _Map, +16 _Mapsize, +24 _Myoff, +32 _Mysize; 每块 8 个"""
        r = self.r
        block_map, map_size, first, size = r.u64(deque + 8), r.u64(deque + 16), r.u64(deque + 24), r.u64(deque + 32)
        if size == 0:
            return []
        if size > 4096 or map_size == 0 or map_size > 1 << 20:
            raise ValueError(f"deque 不合理 size={size} map={map_size}")
        out = []
        for i in range(size):
            at = first + i
            block = r.u64(block_map + ((at // 8) & (map_size - 1)) * 8)
            out.append(r.u16(block + (at % 8) * 2))
        return out

    def research(self, fd: int) -> dict:
        o, r = self.o, self.r
        rm = r.u64(fd + o["fd_rm"])
        if not plausible(rm):
            return {}
        cur = r.u64(rm + o["rm_current"])
        name = r.msvc_string(r.u64(cur + o["t_proto"]) + o["p_name"]) if plausible(cur) else None
        queue = [self.techs.get(i, f"?{i}") for i in self.deque_u16(rm + o["rm_queue"] + o["rq_deque"])]
        # 内存里 researchProgress 是做了多少单位, LuaForce.research_progress 是比例 (38.5 / 200 = 0.1925, 2026-11-06 对过真值)
        units = r.u64(rm + o["rm_units"])
        done = r.f64(rm + o["rm_progress"])
        return {"current": name, "progress": done / units if units else 0.0, "units_done": done, "units": units, "state": r.u8(rm + o["rm_state"]), "queue": queue}

    def technologies(self, fd: int) -> dict:
        o, r = self.o, self.r
        ts = r.u64(fd + o["fd_tech"])
        if not plausible(ts):
            return {}
        begin, end = r.u64(ts + o["t_list"]), r.u64(ts + o["t_list"] + 8)
        n = (end - begin) // 32
        if not 0 < n < 100000:
            raise ValueError(f"科技表长度不合理 {n}")
        raw = r.read(begin, n * 32)
        out = {}
        for i in range(n):
            b = i * 32
            p = int.from_bytes(raw[b + o["t_proto"] : b + o["t_proto"] + 8], "little")
            if not plausible(p):
                continue
            out[r.msvc_string(p + o["p_name"])] = {"enabled": bool(raw[b + o["t_enabled"]]), "count": int.from_bytes(raw[b + o["t_count"] : b + o["t_count"] + 4], "little")}
        return out

    def evolution(self, fd: int, surface_index: int) -> dict | None:
        """std::map<SurfaceIndex, EvolutionFactors> (MSVC _Tree: +0 _Myhead, +8 _Mysize; 节点 +0 左 +8 父 +16 右 +25 _Isnil, 值 +32)"""
        r = self.r
        tree = fd + self.o["fd_evo"]
        head, size = r.u64(tree), r.u64(tree + 8)
        if size == 0 or size > 4096:
            return None
        node, guard = r.u64(head + 8), 0
        while node != head and guard < 4096:
            guard += 1
            key = r.u32(node + 32) & 0xFFFF  # SurfaceIndex 只有 2 字节, 后面是对齐
            if key == surface_index:
                v = node + 40
                return {"factor": r.f64(v), "by_pollution": r.f64(v + 8), "by_time": r.f64(v + 24), "by_spawners": r.f64(v + 40)}
            node = r.u64(node + (16 if key < surface_index else 0))
            if r.u8(node + 25):
                break
        return None

    def flow_key(self, raw: bytes, with_quality: bool, names: dict) -> str:
        base = int.from_bytes(raw[0:2], "little")
        name = names.get(base, f"?{base}")
        if with_quality:
            q = self.qualities.get(raw[2], f"?{raw[2]}")
            if q != "normal":
                return f"{name}@{q}"
        return name

    def pairs(self, vec: int, size: int) -> list[bytes]:
        r = self.r
        begin, end = r.u64(vec), r.u64(vec + 8)
        if begin == end:
            return []
        if (end - begin) % size or end - begin > 1 << 26:
            raise ValueError(f"FlatMap 长度不合理 {end - begin} / {size}")
        raw = r.read(begin, end - begin)
        return [raw[i : i + size] for i in range(0, len(raw), size)]

    def flow(self, addr: int, flow: str, names: dict, histories: bool = True) -> dict | None:
        if not plausible(addr):
            return None
        o, r = self.flow_off[flow], self.r
        q = flow.startswith("FlowStatistics<IDWithQuality")  # 键带品质 (u16 + u8)
        integer = "unsigned __int64" in flow  # 值是整数; 电网和流体是 double
        out: dict = {"input": {}, "output": {}, "storage": {}, "precisions": []}
        for cat in ("input", "output", "storage"):
            for raw in self.pairs(addr + o[cat], 16):
                key = self.flow_key(raw, q, names)
                out[cat][key] = int.from_bytes(raw[8:16], "little") if integer else __import__("struct").unpack("<d", raw[8:16])[0]
        if not histories:
            return out
        for i in range(8):
            pa = addr + o["precisions"] + i * self.precision_size
            rec: dict = {"interval": r.u32(pa + self.prec["interval"])}
            for cat in ("input", "output", "storage"):
                rows = {}
                for raw in self.pairs(pa + self.prec[cat], self.pair_el):
                    key = self.flow_key(raw, q, names)
                    rows[key] = self.element(raw[8:])
                if rows:
                    rec[cat] = rows
            out["precisions"].append(rec)
        return out

    def element(self, raw: bytes) -> dict:
        """一个元素在这个精度下的采样 (新的在后): 窗口是 300 个间隔, 只留算 get_flow_count 要的三个数: 当前没满的采样 cur、最近 299 个之和 recent、第 300 个 oldest"""
        import struct
        h, c, r = self.el["history"], self.o, self.r
        data = int.from_bytes(raw[h + c["cd_data"] : h + c["cd_data"] + 8], "little")
        cap = int.from_bytes(raw[h + c["cd_cap"] : h + c["cd_cap"] + 4], "little")
        head = int.from_bytes(raw[h + c["cd_head"] : h + c["cd_head"] + 4], "little")
        size = int.from_bytes(raw[h + c["cd_size"] : h + c["cd_size"] + 4], "little")
        recent, oldest = 0.0, 0.0
        if data and 0 < size <= cap <= 1 << 16:
            blob = r.read(data, cap * 4)
            for k in range(max(0, size - 299), size):
                recent += struct.unpack_from("<f", blob, ((head + k) % cap) * 4)[0]
            if size >= 300:
                oldest = struct.unpack_from("<f", blob, ((head + size - 300) % cap) * 4)[0]
        return {"cur": struct.unpack_from("<d", raw, self.el["current"])[0], "recent": recent, "oldest": oldest}

    def intrusive(self, head: int, hook: int) -> list[int]:
        """侵入式链表 (List.data 是哨兵钩子, Hook.next 在 +0): 返回各元素地址"""
        out, node, guard = [], self.r.u64(head), 0
        while node and node != head and guard < 65536:
            guard += 1
            out.append(node - hook)
            node = self.r.u64(node)
        return out

    def networks(self) -> dict:
        """电网: 子网编号 (electric_network_id) → 所属总网的发电 / 用电统计。同一个总网的子网共用一份"""
        n, r = self.net, self.r
        manager = r.u64(self.the_map + n["manager"])
        if not plausible(manager):
            return {}
        out = {}
        for net in self.intrusive(manager + n["m_list"], n["hook_n"]):
            # LuaEntity.electric_network_id = 子网 index + 1 (2026-11-06 两个电网都对过真值: 4↔3, 25↔24)
            sub_addrs = self.intrusive(net + n["subs"], n["hook_s"])
            subs = [r.u32(s + n["index"]) + 1 for s in sub_addrs]
            flow = self.flow(r.u64(net + n["stats"]), ELECTRIC_FLOW, self.entity_names)
            # get_flow_count{count=true} 在电网统计上是接着的机器台数 (2026-11-06 对真值: 78 台机械臂), 不是总量; 内存里是每个子网的 connectedEntitiesCounts, 按名字 + 品质
            counts: dict = {}
            for s in sub_addrs:
                for raw in self.pairs(s + n["counts"], 8):
                    key = self.flow_key(raw[0:4], True, self.entity_names)
                    counts[key] = counts.get(key, 0) + int.from_bytes(raw[4:8], "little")
            row = {"subs": subs, "consumers": r.u32(net + n["consumers"]), "producers": r.u32(net + n["producers"]), "flow": flow, "counts": counts}
            for s in subs:
                out[str(s)] = row
        return out

    def tree(self, addr: int, value_at: int = 32):
        """MSVC std::map / set: +0 _Myhead, +8 _Mysize; 节点 +0 左 +8 父 +16 右 +25 _Isnil, 键从 +32。中序遍历, 回各节点地址"""
        r = self.r
        head, size = r.u64(addr), r.u64(addr + 8)
        if size == 0:
            return []
        if size > 1 << 22:
            raise ValueError(f"map 大小不合理 {size}")
        out, stack, node = [], [], r.u64(head + 8)
        while len(out) < size + 1:
            while node != head and not r.u8(node + 25):
                stack.append(node)
                node = r.u64(node)
            if not stack:
                break
            node = stack.pop()
            out.append(node)
            node = r.u64(node + 16)
        return out

    def chart(self, fd: int, surface_index: int) -> dict:
        """已探: charts[地表].chartedChunks (InfiniteRectangle<SubChart*>, 一个 SubChart 一个区块, 非空 = 探过): 外层下标是 x, 内层是 y (2026-11-06 对真值); 带 tickOfCharting, 超过迷雾时间就不可见"""
        o, r = self.chart_off, self.r
        charted = []
        for node in self.tree(fd + o["charts"]):
            if r.u32(node + 32) & 0xFFFF != surface_index:
                continue
            chart = r.u64(node + 40)
            rect = chart + o["c_chunks"]
            data, rows, zero = r.u64(rect), int.from_bytes(r.read(rect + 8, 4), "little", signed=True), int.from_bytes(r.read(rect + 12, 4), "little", signed=True)
            if data and 0 < rows < 200_000:
                raw = r.read(data, rows * 16)
                for i in range(rows):
                    row = int.from_bytes(raw[i * 16 : i * 16 + 8], "little")
                    n = int.from_bytes(raw[i * 16 + 8 : i * 16 + 12], "little", signed=True)
                    z = int.from_bytes(raw[i * 16 + 12 : i * 16 + 16], "little", signed=True)
                    if not row or n <= 0:
                        continue
                    cells = r.read(row, n * 8)
                    for j in range(n):
                        sub = int.from_bytes(cells[j * 8 : j * 8 + 8], "little")
                        if sub:
                            charted.append([i - zero, j - z, r.u64(sub + o["sc_tick"])])
        return {"charted": charted, "fog_timeout": self.fog_timeout}

    def pollution(self) -> dict:
        """每个区块: 位置和污染量 (Chunk.pollution.value); 地表总量 = 全部加起来。chunks 只留有污染的, all 是全部生成过的区块"""
        o, r = self.o, self.r
        total, chunks, every = 0.0, {}, []
        for ch in grid_chunks(r, self.surface + self.o_rect):
            raw = r.read(ch + o["ch_pos"], 8)
            cx, cy = int.from_bytes(raw[0:4], "little", signed=True), int.from_bytes(raw[4:8], "little", signed=True)
            every.append([cx, cy])
            v = r.f64(ch + o["ch_pollution"] + o["po_value"])
            if v:
                chunks[f"{cx},{cy}"] = v
                total += v
        return {"total": total, "chunks": chunks, "all": every}

    def read(self) -> dict:
        o, r, the_map = self.o, self.r, self.the_map
        errors = {}
        surface_index = r.u16(self.surface + o["s_index"])
        # game.tick = entityTick (暂停时不走); updateTick / ticksPlayed 暂停时也走 (2026-11-06 对过真值)
        out: dict = {"tick": r.u64(the_map + o["entity_tick"]), "update_tick": r.u64(the_map + o["update_tick"]), "ticks_played": r.u64(the_map + o["ticks"]), "surface_index": surface_index, "forces": {}, "has_global_network": bool(r.u64(self.surface + o["s_global_net"])), "paused": bool(r.u8(the_map + o["paused"]))}
        begin, end = r.u64(the_map + o["forces"] + o["force_list"]), r.u64(the_map + o["forces"] + o["force_list"] + 8)
        if not 0 < (end - begin) // 8 < 256:
            raise RuntimeError(f"势力表长度不合理 {(end - begin) // 8}")
        for i in range((end - begin) // 8):
            fd = r.u64(begin + i * 8)
            if not plausible(fd):
                continue
            name = r.msvc_string(fd + o["fd_name"])
            f: dict = {"id": r.u8(fd + o["fd_id"]), "name": name, "rockets": r.u32(fd + o["fd_rockets"])}
            for label, fn in (("research", self.research), ("technologies", self.technologies), ("evolution", lambda a: self.evolution(a, surface_index))):
                try:
                    f[label] = fn(fd)
                except (OSError, ValueError) as e:
                    errors[f"{name}.{label}"] = str(e)[:160]
            f["modifiers"] = {lua: r.f64(fd + at) for lua, at in self.modifiers.items()}
            if name == "player":
                try:
                    f["chart"] = self.chart(fd, surface_index)
                except (OSError, ValueError) as e:
                    errors["player.chart"] = str(e)[:160]
            s_begin, s_end = r.u64(fd + o["fd_stats"]), r.u64(fd + o["fd_stats"] + 8)
            if s_begin and (s_end - s_begin) // 32 > surface_index:
                row = s_begin + surface_index * 32
                for label, member, flow, names in (("items", "fs_items", ITEM_FLOW, self.items), ("fluids", "fs_fluids", FLUID_FLOW, self.fluids), ("kills", "fs_kills", ENTITY_Q_FLOW, self.entity_names), ("builds", "fs_builds", ENTITY_Q_FLOW, self.entity_names)):
                    if name != "player" and label != "kills":
                        continue
                    try:
                        f[label] = self.flow(r.u64(row + o[member]), flow, names)
                    except (OSError, ValueError) as e:
                        errors[f"{name}.{label}"] = str(e)[:160]
            out["forces"][name] = f
        try:
            out["pollution"] = self.pollution()
            out["pollution"]["stats"] = self.flow(r.u64(self.surface + o["s_pollution"]), ENTITY_FLOW, self.entity_names)
        except (OSError, ValueError) as e:
            errors["pollution"] = str(e)[:160]
        try:
            out["networks"] = self.networks()
        except (OSError, ValueError) as e:
            errors["networks"] = str(e)[:160]
        if errors:
            out["errors"] = errors
        return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--exe", default=None)
    ap.add_argument("--pdb-dump", default=default_pdb_dump())
    ap.add_argument("--surface", default="nauvis")
    args = ap.parse_args()
    args.exe = args.exe or default_exe()
    t0 = time.perf_counter()
    r = Reader(args.pid)
    base = r.module_base("factorio.exe")
    pd, exe = args.pdb_dump, args.exe
    off = lambda struct, member, prefix: cached_layout(pd, exe, f"off0:{struct}.{member}", lambda: member_offset(pd, exe, struct, member, prefix, 0))
    the_map, surface = find_surface(r, base, pd, exe, off, args.surface)
    w = WorldReader(r, base, pd, exe, off, the_map, surface)
    t1 = time.perf_counter()
    out = w.read()
    out["layout_ms"] = round((t1 - t0) * 1000)
    out["ms"] = round((time.perf_counter() - t1) * 1000)
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
