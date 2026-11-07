"""冶炼列生成器 (数据集"自己生成", docs/blueprint-dataset.md): 参数化积木 → 一本蓝图书, 每个变体一张。

用成熟库 factorio-draftsman (MIT; 4.0.1 自带 2.1.20 数据) 生成蓝图; 电线杆按 draftsman 里的供电半径 / 连线距离算 (区间覆盖贪心 + 连线核对), 不手摆。
布局 (从西到东, 物料从北往南流):
  西出料带 | 出料臂 | 炉子 | 进料臂 | 中间进料带 (矿 + 煤) | 进料臂 | 炉子 | 出料臂 | 东出料带
每个炉子在它顶上那一行有一个进料臂和一个出料臂, 炉子其余几行的机械臂格子空着放电线杆。
用法: python -I tools/generators/smelter_column.py <输出文件>  (需要装 factorio-draftsman)
机械臂 direction = 取货那一侧 (CLAUDE.md 游戏事实)。
"""
import itertools
import json
import os
import sys

import draftsman.data.entities as E
from draftsman.blueprintable import Blueprint, BlueprintBook
from draftsman.constants import Direction
from draftsman.signatures import Icon

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I 不把脚本目录放进搜索路径
from gen_common import plan_poles, size_of  # noqa: E402

FURNACES = ["stone-furnace", "steel-furnace", "electric-furnace"]
INSERTERS = ["inserter", "fast-inserter"]
BELTS = ["transport-belt", "fast-transport-belt"]
LENGTHS = [8, 12, 16]
POLE = "small-electric-pole"


def column(furnace, inserter, belt, n):
    w, h = size_of(furnace)
    x = {"ob_l": 0, "oi_l": 1, "f_l": 2, "ii_l": 2 + w, "ib": 3 + w, "ii_r": 4 + w, "f_r": 5 + w, "oi_r": 5 + 2 * w, "ob_r": 6 + 2 * w}
    bp = Blueprint()
    bp.label = f"冶炼列 {furnace} × {2 * n} / {inserter} / {belt}"
    bp.icons = [Icon(index=0, signal="iron-plate")]  # 喂料实测按图标猜炉子做铁板
    targets, free = [], []
    for k in range(n):
        top = k * h
        bp.entities.append(furnace, tile_position=(x["f_l"], top))
        bp.entities.append(furnace, tile_position=(x["f_r"], top))
        for col, pick in (("oi_l", Direction.EAST), ("ii_l", Direction.EAST), ("ii_r", Direction.WEST), ("oi_r", Direction.WEST)):
            bp.entities.append(inserter, tile_position=(x[col], top), direction=pick)
            targets.append((x[col], top, x[col] + 1, top + 1))
            for r in range(1, h):
                free.append((x[col] + 0.5, top + r + 0.5))
        if furnace == "electric-furnace":
            for fx in (x["f_l"], x["f_r"]):
                targets.append((fx, top, fx + w, top + h))
    for col in ("ob_l", "ib", "ob_r"):
        for y in range(-1, n * h + 1):  # 进料带顶上多一格当起点; 出料带底下多一格当尽头
            bp.entities.append(belt, tile_position=(x[col], y), direction=Direction.SOUTH)
    supply = E.raw[POLE]["supply_area_distance"]
    wire = E.raw[POLE]["maximum_wire_distance"]
    poles = plan_poles(targets, free, supply, wire)
    for cx, cy in poles:
        bp.entities.append(POLE, tile_position=(int(cx - 0.5), int(cy - 0.5)))
    bp.generate_power_connections()
    return bp, {"furnace": furnace, "inserter": inserter, "belt": belt, "furnaces": 2 * n, "poles": len(poles), "w": 7 + 2 * w, "h": n * h + 2}


def main(out):
    book = BlueprintBook()
    book.label = "生成: 冶炼列"
    meta = []
    for i, (f, ins, belt, n) in enumerate(itertools.product(FURNACES, INSERTERS, BELTS, LENGTHS)):
        bp, m = column(f, ins, belt, n)
        bp.index = i
        book.blueprints.append(bp)
        meta.append(m)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(book.to_string())
    with open(out + ".meta.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False)
    print(f"{len(meta)} 个变体 → {out}")


if __name__ == "__main__":
    main(sys.argv[1])
