"""生成器共用: 建筑占地、电线杆规划 (按 draftsman 里的供电半径 / 连线距离算, 不手摆)。"""
import math
import os

import draftsman.data.entities as E


def size_of(name):
    (x1, y1), (x2, y2) = E.raw[name]["collision_box"]
    return math.ceil(x2 - x1), math.ceil(y2 - y1)  # 碰撞盒比占的格子小 (石炉 1.4 → 占 2 格)


def plan_poles(targets, candidates, supply, wire):
    """targets: [(x1, y1, x2, y2)] 要供电的格子框; candidates: [(cx, cy)] 能放电线杆的格子中心。
    贪心: 按从上到下处理还没盖到的目标, 选能盖到它、而且最靠下 (盖得最远) 的候选格。"""
    covered = lambda p, t: p[0] - supply < t[2] and p[0] + supply > t[0] and p[1] - supply < t[3] and p[1] + supply > t[1]
    poles = []
    for t in sorted(targets, key=lambda t: (t[1], t[0])):
        if any(covered(p, t) for p in poles):
            continue
        options = [c for c in candidates if covered(c, t) and c not in poles]
        if not options:
            raise ValueError(f"盖不到 {t}")
        poles.append(max(options, key=lambda c: (c[1], -abs(c[0] - (t[0] + t[2]) / 2))))
    connect_poles(poles, wire)
    return poles


def connect_poles(poles, wire):
    """连线核对: 所有电线杆在连线距离内连成一张网, 不连通就报错 (不靠游戏里自动补)"""
    seen, todo = {poles[0]}, [poles[0]]
    while todo:
        a = todo.pop()
        for b in poles:
            if b not in seen and ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 <= wire:
                seen.add(b)
                todo.append(b)
    if len(seen) != len(poles):
        raise ValueError("电线杆连不成一张网")


_ZH = None


def _lab_root():
    """本机数据目录: 环境变量 LAB_DATA_DIR → 仓库 .env 的 LAB_DATA_DIR → <仓库>/lab-data (和 src/lab/gamedir.ts labRoot 同一条规则)"""
    repo = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    v = os.environ.get("LAB_DATA_DIR")
    if not v:
        try:
            with open(os.path.join(repo, ".env"), encoding="utf-8") as f:
                for line in f:
                    k, sep, val = line.strip().partition("=")
                    if sep and k.strip() == "LAB_DATA_DIR":
                        v = val.strip().strip('"').strip("'")
                        break
        except OSError:
            pass
    return os.path.abspath(v or os.path.join(repo, "lab-data"))


def zh(name):
    """官方中文名: 读游戏导出的 zh-CN 名称 (lab-data/prototypes/<版本>/locale/zh-CN, 本机生成、不进仓库); 没导出就用内部名"""
    global _ZH
    if _ZH is None:
        import glob
        import json
        _ZH = {}
        root = os.path.join(_lab_root(), "prototypes")
        for d in sorted(glob.glob(os.path.join(root, "*", "locale", "zh-CN")))[-1:]:
            for f in ["fluid-locale.json", "recipe-locale.json", "item-locale.json", "entity-locale.json"]:
                try:
                    _ZH.update(json.load(open(os.path.join(d, f), encoding="utf-8"))["names"])
                except (OSError, KeyError, ValueError):
                    pass
    return _ZH.get(name, name)
