"""化工厂排生成器 (数据集"自己生成"): 塑料、硫磺、硫酸、电池、润滑油, 以及要流体的组装机 (电动机、处理器)。
用 factorio-draftsman (MIT); 尺寸、机械臂、电线杆数据都从 draftsman 读, 电线杆按 gen_common 规划。喂料实测走 npm run bp -- feed (流体用永续管道)。
物料从西往东流; 机器朝北 (流体口: 化工厂北面 2 个进、南面 2 个出; 组装机北面中间进)。2.1.24 探针 (2026-11-05):
  一种流入流体时化工厂北面两个口通同一个箱, 一排直管就够; 两种流入 (硫磺) box 1 = 第一种 = 西口, box 2 = 第二种 = 东口。
布局 (从北到南, 机器占 y 0..2):
  A 一种流体 + 固体 → 固体 (塑料、电池、电动机、处理器): 进液管 y=-1 | 机器 | 机械臂 y=3 | 近带 y=4 | 远带 y=5。吃得多的一侧走近带 (普通 / 快速机械臂), 少的一侧走远带 (加长机械臂)
  B 两种流体 → 固体 (硫磺): 第二种的管 y=-4 | 地下管道 y=-3 | 第一种的管 y=-2 | 西口接管、东口地下管道 y=-1 | 机器 | 出料臂 y=3 | 出料带 y=4
  C 固体 + 一种流体 → 流体 (硫酸): 进液管 y=-4 | 地下管道 y=-3 | 进料带 y=-2 | 地下管道 + 进料臂 y=-1 | 机器 | 出液管 y=3
  D 一种流体 → 流体 (润滑油): 电线杆 y=-2 | 进液管 y=-1 | 机器 | 出液管 y=3
进液管西头留口、出液管东头留口, 接外面的管子。一条地下管道的 direction = 开口朝向, 配对在反方向 (存档实测 2026-11-05)。
用法: python -I tools/generators/chem_row.py <输出文件> [--spec <变体 JSON>]   # 不给 --spec 就出默认的一组; 每个变体的参数写进 <输出文件>.meta.json
"""
import argparse
import json
import math
import os
import sys

import draftsman.data.entities as E
import draftsman.data.recipes as R
from draftsman.blueprintable import Blueprint, BlueprintBook
from draftsman.constants import Direction

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I 不把脚本目录放进搜索路径
from gen_common import plan_poles, size_of, zh  # noqa: E402

SPEED = {"chemical-plant": 1.0, "assembling-machine-2": 0.75}
THR = {"inserter": 0.83, "fast-inserter": 2.31, "long-handed-inserter": 1.15}  # 每手 1 个 (没研究时)
LANE = {"transport-belt": 7.5, "fast-transport-belt": 15}
DEFAULT = [
    ("plastic-bar", "chemical-plant"), ("sulfur", "chemical-plant"), ("sulfuric-acid", "chemical-plant"),
    ("battery", "chemical-plant"), ("lubricant", "chemical-plant"),
    ("electric-engine-unit", "assembling-machine-2"), ("processing-unit", "assembling-machine-2"),
]


def recipe_io(name):
    r = R.raw[name]
    ings = r.get("ingredients", [])
    results = r.get("results", [])
    time = r.get("energy_required", 0.5)
    pick = lambda rows, kind: [x for x in rows if x.get("type", "item") == kind]
    return pick(ings, "item"), pick(ings, "fluid"), pick(results, "item"), pick(results, "fluid"), time


def arm_for(rate):
    """能带得动这个流量的机械臂: 普通 → 快速; 都不够就快速 (喂料实测的效率会写在块的说明里)"""
    return "inserter" if rate <= THR["inserter"] else "fast-inserter"


def belt_and_n(solids, solid_out, c, want):
    """一条道一种料: 每道放得下几台。基础带够放 3 台以上就用基础带, 不够换高速带"""
    per = [i["amount"] * c for i in solids] + [sum(p.get("amount", 1) for p in solid_out) * c]
    peak = max(per + [0.001])
    for belt in ("transport-belt", "fast-transport-belt"):
        n = min(want, math.floor(LANE[belt] / peak))
        if n >= 3 or belt == "fast-transport-belt":
            return belt, max(1, n)


def row(spec):
    recipe, machine, want = spec["recipe"], spec["machine"], int(spec.get("n", 6))
    solids, fluids, out_items, out_fluids, time = recipe_io(recipe)
    if not fluids:
        raise ValueError(f"{recipe}: 没有流体原料, 用组装机排")
    if len(fluids) > 2 or (len(fluids) == 2 and solids):
        raise ValueError(f"{recipe}: 这个布局不支持 (流体 {len(fluids)} 种、固体 {len(solids)} 种)")
    w, h = size_of(machine)
    c = SPEED[machine] / time
    belt, n = belt_and_n(solids, out_items, c, want)
    x_end = n * w
    bp = Blueprint()
    targets, free = [], []
    pole = "small-electric-pole"

    def put(name, x, y, **kw):
        bp.entities.append(name, tile_position=(x, y), **kw)

    def belt_row(y, x_from, x_to):
        for x in range(x_from, x_to):
            put(belt, x, y, direction=Direction.EAST)

    def arm(name, x, y, d):
        put(name, x, y, direction=d)
        targets.append((x, y, x + 1, y + 1))

    def pipe_row(y, x_from, x_to):
        for x in range(x_from, x_to):
            put("pipe", x, y)

    for k in range(n):
        put(machine, k * w, 0, recipe=recipe, direction=Direction.NORTH)
        targets.append((k * w, 0, k * w + w, h))

    hint = []
    if len(fluids) == 2:  # B: 两种流体
        pipe_row(-2, 0, x_end)
        pipe_row(-4, 0, x_end)
        for k in range(n):
            x0 = k * w
            put("pipe", x0, -1)
            put("pipe-to-ground", x0 + 2, -1, direction=Direction.SOUTH)
            put("pipe-to-ground", x0 + 2, -3, direction=Direction.NORTH)
            free += [(x0 + 1.5, -0.5)]
        hint = [f"{zh(fluids[0]['name'])}进近管", f"{zh(fluids[1]['name'])}进远管"]
    elif solids and out_fluids:  # C: 固体从北面进, 流体绕到带子北面
        pole = "medium-electric-pole"
        pipe_row(-4, 0, x_end)
        belt_row(-2, -1, x_end)
        rate = sum(i["amount"] for i in solids) * c
        ins = "fast-inserter"
        for k in range(n):
            x0 = k * w
            put("pipe-to-ground", x0, -1, direction=Direction.SOUTH)
            put("pipe-to-ground", x0, -3, direction=Direction.NORTH)
            arm(ins, x0 + 1, -1, Direction.NORTH)
            if rate > THR[ins]:
                arm(ins, x0 + 2, -1, Direction.NORTH)
            free += [(x0 + 1.5, -2.5), (x0 + 2.5, -2.5)]
        hint = [f"{zh(fluids[0]['name'])}进管"]
    else:  # A / D: 一种流体, 一排直管
        pipe_row(-1, 0, x_end)
        hint = [f"{zh(fluids[0]['name'])}进管"]

    if out_fluids:  # C / D: 出液管
        pipe_row(3, 0, x_end)
        if not solids:
            free += [(k * w + 0.5 + j, -1.5) for k in range(n) for j in range(w)]
        hint.append(f"{zh(out_fluids[0]['name'])}出管")
    elif not solids:  # B: 只有出料
        rate = sum(p.get("amount", 1) for p in out_items) * c
        ins = arm_for(rate)
        for k in range(n):
            arm(ins, k * w, 3, Direction.NORTH)
            free += [(k * w + 1.5, 3.5), (k * w + 2.5, 3.5)]
        belt_row(4, 0, x_end + 1)
    else:  # A: 吃得多的一侧走近带, 少的一侧走远带 (加长机械臂)
        in_rate = sum(i["amount"] for i in solids) * c
        out_rate = sum(p.get("amount", 1) for p in out_items) * c
        long_arm = "long-handed-inserter"
        if in_rate >= out_rate:
            belt_row(4, -1, x_end)  # 近带 = 进料
            belt_row(5, 0, x_end + 1)  # 远带 = 出料
            near = arm_for(in_rate)
            for k in range(n):
                arm(near, k * w, 3, Direction.SOUTH)
                arm(long_arm, k * w + 1, 3, Direction.NORTH)
            hint.append("进料走近带")
        else:
            belt_row(4, 0, x_end + 1)  # 近带 = 出料
            belt_row(5, -1, x_end)  # 远带 = 进料
            near = arm_for(out_rate)
            for k in range(n):
                arm(long_arm, k * w, 3, Direction.SOUTH)
                arm(near, k * w + 1, 3, Direction.NORTH)
            hint.append("进料走远带")
        free += [(k * w + 2.5, 3.5) for k in range(n)]

    supply = E.raw[pole]["supply_area_distance"]
    wire = E.raw[pole]["maximum_wire_distance"]
    poles = plan_poles(targets, free, supply, wire)
    for cx, cy in poles:
        put(pole, int(cx - 0.5) if cx >= 0 else math.floor(cx), int(math.floor(cy)))
    bp.generate_power_connections()
    head = "化工厂排" if machine == "chemical-plant" else "组装机排"
    product = (out_items or out_fluids)[0]["name"]
    bp.label = f"{head} {zh(recipe if recipe in ('electric-engine-unit', 'processing-unit') else product)} × {n} / {zh(machine)} / {'、'.join(hint)} / {zh(belt)}"
    meta = {"recipe": recipe, "machine": machine, "n": n, "belt": belt, "fluids": [f["name"] for f in fluids], "poles": len(poles), "w": x_end + 2}
    return bp, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--spec")
    a = ap.parse_args()
    specs = json.load(open(a.spec, encoding="utf-8")) if a.spec else [{"recipe": r, "machine": m, "n": n} for r, m in DEFAULT for n in (3, 6)]
    book = BlueprintBook()
    book.label = "生成: 化工厂排"
    meta, seen = [], set()
    for s in specs:
        try:
            bp, m = row(s)
        except ValueError as e:
            meta.append({**s, "error": str(e)})
            continue
        if bp.label in seen:  # 带子放不下那么多台时 3 台和 6 台是同一张
            continue
        seen.add(bp.label)
        bp.index = len(book.blueprints)
        book.blueprints.append(bp)
        meta.append({**m, "index": bp.index + 1})
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(book.to_string())
    with open(a.out + ".meta.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False)
    print(f"{len(book.blueprints)} variants ({sum(1 for m in meta if 'error' in m)} invalid) -> {a.out}")
    for m in meta:
        print(" ", m.get("recipe"), m.get("n"), m.get("belt"), m.get("error", ""))


if __name__ == "__main__":
    main()
