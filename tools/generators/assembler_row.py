"""组装机排生成器 (数据集"自己生成" 第二块, docs/blueprint-dataset.md): 按配方出参数化的组装机排 → 一本蓝图书, 每个变体一张。

用成熟库 factorio-draftsman (MIT) 生成; 尺寸、机械臂取放距离、电线杆供电半径 / 连线距离都从 draftsman 数据读, 电线杆按区间覆盖贪心 + 连线核对 (gen_common), 不手摆。
物料从西往东流 (带子朝东), 进料带起点在西边多一格当喂料口, 出料带在东边多一格当尽头。
布局 (从北到南):
  single, 1 条进料带 (1~2 种料, 每道一种):  进料带 A | 进料臂 | 组装机 | 出料臂 | 出料带
  single, 2 条进料带 (3~4 种料):           进料带 B | 进料带 A | 进料臂 (普通取 A, 加长机械臂取 B) | 组装机 | 出料臂 | 出料带
  double (镜像双排, 两排共用中间的进料带):  出料带 | 出料臂 | 组装机 | 进料臂 | 进料带 A (| 进料带 B) | 进料臂 | 组装机 | 出料臂 | 出料带
每台组装机上下各一行 3 个机械臂格子: 放 per_input (+ 长臂) 个进料臂 / out 个出料臂, 空着的格子是电线杆候选。
机械臂 direction = 取货那一侧 (CLAUDE.md 游戏事实)。流体原料的配方不支持 (报错)。

用法:
  python -I tools/generators/assembler_row.py <输出文件> --spec <变体 JSON>   # [{recipe, machine, inserter, belt, n, per_input, out, layout}, ...]
  python -I tools/generators/assembler_row.py <输出文件> --grid <配方>        # 这个配方的一组默认变体
每个变体的参数和尺寸写进 <输出文件>.meta.json (搜索 / 排名用); 不合法的组合记 error、不进书。
"""
import argparse
import itertools
import json
import os
import sys

import draftsman.data.entities as E
import draftsman.data.recipes as R
from draftsman.blueprintable import Blueprint, BlueprintBook
from draftsman.constants import Direction
from draftsman.signatures import Icon

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I 不把脚本目录放进搜索路径
from gen_common import plan_poles, size_of, zh  # noqa: E402

MACHINES = ["assembling-machine-1", "assembling-machine-2", "assembling-machine-3"]
INSERTERS = ["inserter", "fast-inserter", "bulk-inserter"]
BELTS = ["transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt"]
LONG = "long-handed-inserter"
POLE = "small-electric-pole"
DEFAULT = {"machine": "assembling-machine-2", "inserter": "inserter", "belt": "transport-belt", "n": 8, "per_input": 1, "out": 1, "layout": "single"}


def reach(name):
    """机械臂取货 / 放货离自己几格 (原型 pickup_position / insert_position 的长度, 取整到格)"""
    r = E.raw[name]
    return round(abs(r["pickup_position"][1])), round(abs(r["insert_position"][1]))


def recipe_io(recipe):
    r = R.raw[recipe]
    ings = r.get("ingredients", [])
    if any(i.get("type") == "fluid" for i in ings):
        raise ValueError(f"{recipe}: 有流体原料, 组装机排不支持")
    items = [i["name"] for i in ings]
    products = [p["name"] for p in r.get("results", []) if p.get("type", "item") == "item"]
    if not 1 <= len(items) <= 4 or not products:
        raise ValueError(f"{recipe}: 固体原料 {len(items)} 种 / 产物 {len(products)} 种, 只支持原料 1~4 种、至少一种固体产物")
    return items, products, r.get("category", "crafting")


def row(spec):
    s = {**DEFAULT, **spec}
    recipe, machine, ins, belt, n = s["recipe"], s["machine"], s["inserter"], s["belt"], int(s["n"])
    per_input, out, layout = int(s["per_input"]), int(s["out"]), s["layout"]
    items, products, category = recipe_io(recipe)
    if category not in E.raw[machine]["crafting_categories"]:
        raise ValueError(f"{machine} 做不了 {recipe} (类别 {category})")
    w, h = size_of(machine)
    belts = 1 if len(items) <= 2 else 2
    slots = per_input * belts
    if slots > w or out > w:
        raise ValueError(f"每台机器一行只有 {w} 个机械臂格子: 进料 {slots}、出料 {out}")
    pick, drop = reach(ins)
    lpick, ldrop = reach(LONG)
    if (pick, drop) != (1, 1) or (lpick, ldrop) != (2, 2):
        raise ValueError(f"机械臂取放距离和布局假设不符: {ins} {pick}/{drop}, {LONG} {lpick}/{ldrop}")

    bp = Blueprint()
    tag = {"single": "单排", "double": "双排"}[layout]
    bp.label = f"组装机排 {zh(recipe)} × {n * (2 if layout == 'double' else 1)} / {zh(machine)} / {zh(ins)}×{per_input} 出×{out} / {zh(belt)} / {tag}"
    bp.icons = [Icon(index=0, signal=products[0])]
    targets, free = [], []
    x_end = n * w  # 机器占 [0, n*w)

    def put_inserters(y, names_dirs, k):
        x0 = k * w
        used = 0
        for name, d in names_dirs:
            bp.entities.append(name, tile_position=(x0 + used, y), direction=d)
            targets.append((x0 + used, y, x0 + used + 1, y + 1))
            used += 1
        for c in range(used, w):
            free.append((x0 + c + 0.5, y + 0.5))

    def put_belt(y, x_from, x_to):
        for x in range(x_from, x_to):
            bp.entities.append(belt, tile_position=(x, y), direction=Direction.EAST)

    def machines_at(y_top, y_in, y_out, toward_belt, away_belt):
        """y_in: 进料臂行 (取货朝向 toward_belt), y_out: 出料臂行 (取货朝向 = 机器那侧)"""
        for k in range(n):
            bp.entities.append(machine, tile_position=(k * w, y_top), recipe=recipe)
            targets.append((k * w, y_top, k * w + w, y_top + h))
            put_inserters(y_in, [(ins, toward_belt)] * per_input + [(LONG, toward_belt)] * (per_input if belts == 2 else 0), k)
            put_inserters(y_out, [(ins, away_belt)] * out, k)

    if layout == "single":
        # 北边进料带 (B 在最北), 南边出料带
        yb = 0
        if belts == 2:
            put_belt(yb, -1, x_end)
            yb += 1
        put_belt(yb, -1, x_end)  # A
        y_in = yb + 1
        y_top = y_in + 1
        y_out = y_top + h
        machines_at(y_top, y_in, y_out, Direction.NORTH, Direction.NORTH)
        put_belt(y_out + 1, 0, x_end + 1)
        height = y_out + 2
    elif layout == "double":
        put_belt(0, 0, x_end + 1)  # 上排出料带
        y_top1 = 2
        y_in1 = y_top1 + h
        # 上排: 出料臂在机器北边 (取货朝南 = 机器), 进料臂在机器南边 (取货朝南 = 进料带)
        ya = y_in1 + 1
        put_belt(ya, -1, x_end)  # A
        yb = ya
        if belts == 2:
            yb = ya + 1
            put_belt(yb, -1, x_end)  # B
        y_in2 = yb + 1
        y_top2 = y_in2 + 1
        y_out2 = y_top2 + h
        machines_at(y_top1, y_in1, 1, Direction.SOUTH, Direction.SOUTH)
        machines_at(y_top2, y_in2, y_out2, Direction.NORTH, Direction.NORTH)
        put_belt(y_out2 + 1, 0, x_end + 1)
        height = y_out2 + 2
    else:
        raise ValueError(f"不认识的布局 {layout}")

    supply = E.raw[POLE]["supply_area_distance"]
    wire = E.raw[POLE]["maximum_wire_distance"]
    poles = plan_poles(targets, free, supply, wire)
    for cx, cy in poles:
        bp.entities.append(POLE, tile_position=(int(cx - 0.5), int(cy - 0.5)))
    bp.generate_power_connections()
    meta = {**s, "machines": n * (2 if layout == "double" else 1), "belts_in": belts, "items": items, "products": products,
            "poles": len(poles), "w": x_end + 2, "h": height}
    return bp, meta


def grid(recipe):
    out = []
    for m, ins, belt, n, layout in itertools.product(MACHINES, ["inserter", "fast-inserter"], ["transport-belt", "fast-transport-belt"], [6, 10], ["single", "double"]):
        out.append({"recipe": recipe, "machine": m, "inserter": ins, "belt": belt, "n": n, "layout": layout})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--spec")
    ap.add_argument("--grid")
    a = ap.parse_args()
    specs = json.load(open(a.spec, encoding="utf-8")) if a.spec else grid(a.grid)
    book = BlueprintBook()
    book.label = "生成: 组装机排"
    meta = []
    for s in specs:
        try:
            bp, m = row(s)
        except ValueError as e:  # 不合法的组合 (一行放不下、机器做不了这个配方…) 记下原因, 不进书 (搜索时当不可行)
            meta.append({**s, "error": str(e)})
            continue
        bp.index = len(book.blueprints)
        book.blueprints.append(bp)
        meta.append({**m, "index": bp.index + 1})  # 书里第几张 (从 1 数, 和 bp 命令的 --index 一致)
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(book.to_string())
    with open(a.out + ".meta.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False)
    print(f"{len(book.blueprints)} variants ({sum(1 for m in meta if 'error' in m)} invalid) -> {a.out}")


if __name__ == "__main__":
    main()
