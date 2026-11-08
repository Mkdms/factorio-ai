"""放置检查 (game/offgame/placeable.lua) 的用例: 用真原型数据 (data-raw-dump.json) 和手搭的地块 / 实体, 在 lupa 里跑, 结果打成一行 JSON 给 test/placeable.test.ts 核。
用法: python -I placeable_check.py <placeable.lua> <data-raw-dump.json>"""
import json
import sys

from lupa.lua52 import LuaRuntime  # type: ignore

lua_path, dump_path = sys.argv[1], sys.argv[2]
dump = json.load(open(dump_path, encoding="utf-8"))


def proto(kind, name):
    p = dict(dump[kind][name])
    p.setdefault("type", kind)
    return p


PROTOS = {"offshore-pump": proto("offshore-pump", "offshore-pump"), "stone-furnace": proto("furnace", "stone-furnace"), "burner-mining-drill": proto("mining-drill", "burner-mining-drill"),
          "transport-belt": proto("transport-belt", "transport-belt")}
TILES = {name: dump["tile"][name].get("collision_mask", {}).get("layers", {}) for name in ("water", "deepwater", "grass-1", "dirt-1")}

lua = LuaRuntime(unpack_returned_tuples=True, register_eval=False)
M = lua.execute(open(lua_path, encoding="utf-8").read())


def L(obj):
    """Python 的字典 / 列表 → Lua 表 (递归; 列表从 1 起)"""
    if isinstance(obj, dict):
        return lua.table_from({k: L(v) for k, v in obj.items()})
    if isinstance(obj, list):
        return lua.table_from([L(v) for v in obj])
    return obj


def run(name, x, y, direction, tiles, entities):
    """tiles: {(tx,ty): 地块名}, 默认 grass-1, None = 没读到; entities: [{name,type,x0,y0,x1,y1}]"""
    def tile(tx, ty):
        key = (int(tx), int(ty))
        if key in tiles:
            return tiles[key]
        return "grass-1"

    def tile_layers(n):
        return L(TILES.get(n, {}))

    def ents(x0, y0, x1, y1):
        return L([e for e in entities if e["x1"] >= x0 and e["x0"] <= x1 and e["y1"] >= y0 and e["y0"] <= y1])

    args = lua.table(proto=L(PROTOS[name]), name=name, x=x, y=y, direction=direction, entities=ents, tile=tile, tile_layers=tile_layers)
    ok, why = M.check(args)
    return {"ok": bool(ok), "why": why}


def band(cols, rows, name="water"):
    return {(c, r): name for c in cols for r in rows}


out = {}
# 抽水机在 (0.5, 0.5) 的格 (0,0) 上朝北: 正面 3 宽 2 深 (x -1..1, y -2..-1) 全是水 → 放得下
out["pump_north_ok"] = run("offshore-pump", 0.5, 0.5, 0, band([-1, 0, 1], [-2, -1]), [])
# 只有紧挨的那一排是水 → 不行 (差第二排)
out["pump_one_row"] = run("offshore-pump", 0.5, 0.5, 0, band([-1, 0, 1], [-1]), [])
# 脚下就是水 → 不行
out["pump_on_water"] = run("offshore-pump", 0.5, 0.5, 0, {**band([-1, 0, 1], [-2, -1]), (0, 0): "water"}, [])
# 朝东: 水在 x 1..2, y -1..1
out["pump_east_ok"] = run("offshore-pump", 0.5, 0.5, 4, band([1, 2], [-1, 0, 1]), [])
# 朝北的水却要朝东放 → 不行
out["pump_east_wrong_dir"] = run("offshore-pump", 0.5, 0.5, 4, band([-1, 0, 1], [-2, -1]), [])
# 一棵树站在脚下 → 挡着
out["pump_tree"] = run("offshore-pump", 0.5, 0.5, 0, band([-1, 0, 1], [-2, -1]), [{"name": "tree-01", "type": "tree", "x0": 0.1, "y0": 0.1, "x1": 0.9, "y1": 0.9}])
# 水里有鱼 → 不挡
out["pump_fish"] = run("offshore-pump", 0.5, 0.5, 0, band([-1, 0, 1], [-2, -1]), [{"name": "fish", "type": "fish", "x0": -0.25, "y0": -1.75, "x1": 1.25, "y1": -0.25}])
# 石炉 (2x2, 中心整数) 在草地 → 放得下; 一格是水 → 不行; 脚下有矿 → 不挡; 旁边一台石炉压进来 → 挡; 角色站着 → 不挡
out["furnace_ok"] = run("stone-furnace", 10, 10, 0, {}, [])
out["furnace_water"] = run("stone-furnace", 10, 10, 0, {(9, 9): "water"}, [])
out["furnace_ore"] = run("stone-furnace", 10, 10, 0, {}, [{"name": "iron-ore", "type": "resource", "x0": 9.4, "y0": 9.4, "x1": 9.6, "y1": 9.6}])
out["furnace_neighbor"] = run("stone-furnace", 10, 10, 0, {}, [{"name": "stone-furnace", "type": "furnace", "x0": 10.3, "y0": 9.3, "x1": 11.7, "y1": 10.7}])
out["furnace_touching"] = run("stone-furnace", 10, 10, 0, {}, [{"name": "stone-furnace", "type": "furnace", "x0": 11.3, "y0": 9.3, "x1": 12.7, "y1": 10.7}])
out["furnace_character"] = run("stone-furnace", 10, 10, 0, {}, [{"name": "character", "type": "character", "x0": 9.8, "y0": 9.8, "x1": 10.2, "y1": 10.2}])
# 带子在格子上 → 挡
out["furnace_belt"] = run("stone-furnace", 10, 10, 0, {}, [{"name": "transport-belt", "type": "transport-belt", "x0": 9.1, "y0": 9.1, "x1": 9.9, "y1": 9.9}])
# 地块没读到 → 不行, 说清
out["furnace_unknown_tile"] = run("stone-furnace", 10, 10, 0, {(9, 9): None}, [])
# 热能采矿机 2x2 在草地 (不要求脚下有矿: 游戏也放得下, 只是不出矿)
out["drill_ok"] = run("burner-mining-drill", 4, 4, 0, {}, [])
# 占地框转向: 抽水机朝南, 水在 x -1..1, y 1..2
out["pump_south_ok"] = run("offshore-pump", 0.5, 0.5, 8, band([-1, 0, 1], [1, 2]), [])
# rot_box 自检: 朝东的框
bx = M.rot_box(L([[-0.6, -1.05], [0.6, 0.3]]), 0.5, 0.5, 4)
out["rot_box_east"] = list(bx)
print(json.dumps(out, ensure_ascii=True))  # 转义中文: Windows 下管道的编码是 GBK, 不转会乱码
