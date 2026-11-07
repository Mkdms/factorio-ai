#!/usr/bin/env python
"""从内存读到的原始字段推算机器状态: status.ts 的 Python 版 (游戏外的模组宿主是 Python, 每读一个实体都要算)。两边规则必须一样, test/memory.test.ts 拿同一批输入比。

规则来自反汇编 factorio.exe 2.1.24 的 getStatus: 每个条件给一个候选, 取编号最大的; 只算核对过的类, 别的类回 None, 不瞎猜。

  python -I game/memory/status.py --batch   # 标准输入一行 JSON 数组, 标准输出同长度的状态编号数组 (单元测试用)
"""
import json
import sys

WORKING, NORMAL, BROKEN, LOW_POWER, NO_INGREDIENTS, NO_RECIPE, NO_RESEARCH, NO_MINABLE = 1, 2, 4, 14, 18, 19, 20, 21
# 原型 default_status 的状态名 → 编号 (只列见过的; 别的名字当没有)
DEFAULT_STATUS = {"working": WORKING, "normal": NORMAL, "broken": BROKEN}
FLUID_SHORT, ITEM_SHORT, FULL_OUTPUT, MISSING_PACKS, WAIT_SOURCE, WAIT_MORE, WAIT_SPACE = 30, 31, 32, 35, 36, 37, 38
NO_AMMO, NO_FUEL, NO_POWER, MARKED = 57, 59, 60, 68
SLEEP_ITEM_OVERLOAD, SLEEP_ITEM_SHORT, SLEEP_FLUID_SHORT = 6, 8, 9
FLAG_FULL = 2  # CraftingMachineFlags::FULL


def power_status(p) -> int:
    """能量那一项 (Entity::getEnergyStatus): 烧的: 没热量、没在烧、燃料格也空 → 没燃料; 电的: 缓冲是空的 → 没电, 没满 → 低电"""
    if not p or not p.get("src"):
        return 0
    if p["src"] == "burner":
        return NO_FUEL if p.get("energy") == 0 and (p.get("remaining") or 0) <= 0 and not p.get("burning") and not p.get("fuel") else 0
    if p["src"] == "electric":
        energy, cap = p.get("energy"), p.get("capacity")
        if energy == 0:
            return NO_POWER
        if cap is not None and energy is not None and energy < cap * 0.999:
            return LOW_POWER
    return 0


def mem_status(d: dict):
    """推算状态编号; 这个类没核对过 → None"""
    marked = MARKED if (d.get("usage") or 0) & 0x4000 else 0
    base = max(marked, power_status(d.get("power")))
    cls = d.get("cls")
    if cls in ("AssemblingMachine", "Furnace"):
        c = WORKING
        if not d.get("recipe"):
            c = NO_INGREDIENTS if cls == "Furnace" else NO_RECIPE
        else:
            stored = d.get("stored") or 0
            energy = d.get("recipeEnergy") or 0
            if d.get("sleep") == SLEEP_ITEM_OVERLOAD or (energy > 0 and stored >= energy):
                c = FULL_OUTPUT
            elif stored <= 0:
                # 没在做: FULL 标记 = 机械臂不用再喂, 没做又不用喂只能是出料堵了; outFull = 产物多到游戏算堵料 (标记机械臂碰过才有, 刚读完地图时大多没有); 不然看上次卡在哪
                if (d.get("flags") or 0) & FLAG_FULL or d.get("outFull"):
                    c = FULL_OUTPUT
                elif d.get("sleep") == SLEEP_FLUID_SHORT:
                    c = FLUID_SHORT
                elif d.get("sleep") == SLEEP_ITEM_SHORT:
                    c = ITEM_SHORT
        return max(base, c)
    if cls == "MiningDrill":
        c = WORKING
        if not d.get("active"):
            if d.get("bufferEmpty") and not d.get("stuck") and not d.get("resources"):
                c = NO_MINABLE
            elif d.get("dropDeconstruct"):
                c = WAIT_SPACE
        if d.get("stuck"):
            c = max(c, WAIT_SPACE)
        # 输出缓冲里有东西: 睡着了就是放不下; 醒着时游戏要调目标的 canInsert, 外面调不了, 用目标满不满近似
        if not d.get("bufferEmpty") and (not d.get("active") or d.get("dropFull") is not False):
            c = max(c, WAIT_SPACE)
        return max(base, c)
    if cls == "Lab":
        table = [WORKING, NO_POWER, NO_RESEARCH, MISSING_PACKS]
        last = d.get("last") or 0
        return max(base, table[last] if last < len(table) else WORKING)
    if cls == "Inserter":
        c = WORKING
        if not d.get("active"):
            c = WAIT_SOURCE
            if d.get("heldItem"):
                c = max(c, WAIT_MORE if (d.get("flags") or 0) & 4 else WAIT_SPACE)
            if d.get("dropFull"):
                c = max(c, WAIT_SPACE)
        elif not d.get("heldItem"):
            if d.get("dropFull"):
                c = max(c, WAIT_SPACE)
            if d.get("atPickup"):
                c = max(c, WAIT_SOURCE)
        elif d.get("atDrop"):
            c = max(c, WAIT_SPACE)
        return max(base, c)
    if cls == "AmmoTurret":
        return max(base, WORKING if d.get("ammo") else NO_AMMO)
    if cls in ("ContainerEntity", "LogisticContainer"):  # 原型带 default_status 的 (坠机残骸 broken) 用它代替 normal
        return max(base, DEFAULT_STATUS.get(d.get("defaultStatus") or "", NORMAL))
    if cls == "Generator":  # 发电机的电缓冲是往外送的, 没满不算低电
        return max(marked, WORKING)
    if cls in ("TransportBelt", "Splitter", "Pipe", "PipeToGround", "OffshorePump", "Radar", "Boiler"):
        return max(base, WORKING)
    return None


if __name__ == "__main__":
    if "--batch" in sys.argv:
        print(json.dumps([mem_status(d) for d in json.loads(sys.stdin.read())]))
