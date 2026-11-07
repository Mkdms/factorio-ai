// 从内存读到的原始字段推算机器状态 (库): LuaEntity.status 是游戏现算的函数, 内存里没有现成的值, 进程外也调不了函数, 只能照它的规则算。
// 规则来自反汇编 factorio.exe 2.1.24 的 getStatus (Entity / CraftingMachine / MiningDrill / Lab / Inserter / AmmoTurret / Burner / ElectricEnergySource): **每个条件给一个候选, 取编号最大的**, 所以编号就是优先级 (游戏枚举和 Lua defines.entity_status 数值一样, 2026-11-06 对过)。
// 只算核对过的类; 别的类回 null, 不瞎猜。沙盘测试 test/sandbox/memory.test.ts 按类和 RCON 真值比, 对不上的类不要用。Python 版 status.py 规则相同 (test/memory.test.ts 比)。
export const STATUS = { working: 1, normal: 2, broken: 4, low_power: 14, no_ingredients: 18, no_recipe: 19, no_research_in_progress: 20, no_minable_resources: 21, fluid_ingredient_shortage: 30, item_ingredient_shortage: 31, full_output: 32, missing_science_packs: 35, waiting_for_source_items: 36, waiting_for_more_items: 37, waiting_for_space_in_destination: 38, no_ammo: 57, no_fuel: 59, no_power: 60, marked_for_deconstruction: 68 } as const;
type Power = { src?: string; energy?: number; capacity?: number; remaining?: number; burning?: string | null; network?: number; fuel?: unknown[] };
export type Raw = { cls: string; usage?: number; power?: Power; defaultStatus?: string; recipe?: string | null; stored?: number; recipeEnergy?: number; sleep?: number; flags?: number; outFull?: boolean; last?: number; active?: number; bufferEmpty?: number; stuck?: number; resources?: number; dropDeconstruct?: boolean; heldItem?: number; atPickup?: boolean; atDrop?: boolean; dropFull?: boolean | null; hasDrop?: number; ammo?: unknown[] };

/** 能量那一项 (Entity::getEnergyStatus): 烧的: 没热量、没在烧、燃料格也空 → 没燃料 (Burner::getStatus; 燃料格有煤但没在烧不算, 比如炉子没配方); 电的: 缓冲是空的 → 没电, 没满 → 低电 */
export function powerStatus(p: Power | undefined): number {
  if (!p?.src) return 0;
  if (p.src === "burner") return p.energy === 0 && (p.remaining ?? 0) <= 0 && !p.burning && !p.fuel?.length ? STATUS.no_fuel : 0;
  if (p.src === "electric") {
    if (p.energy === 0) return STATUS.no_power;
    if (p.capacity !== undefined && p.energy !== undefined && p.energy < p.capacity * 0.999) return STATUS.low_power;
  }
  return 0;
}
const SLEEP = { itemOverload: 6, fluidOverload: 7, itemShortage: 8, fluidShortage: 9 };
/** CraftingMachineFlags::FULL */
const FLAG_FULL = 2;

/** 推算状态编号; 这个类没核对过 → null */
export function memStatus(d: Raw): number | null {
  const base = Math.max((d.usage ?? 0) & 0x4000 ? STATUS.marked_for_deconstruction : 0, powerStatus(d.power));
  switch (d.cls) {
    case "AssemblingMachine": case "Furnace": {
      let c: number = STATUS.working;
      if (!d.recipe) c = d.cls === "Furnace" ? STATUS.no_ingredients : STATUS.no_recipe;
      else {
        const stored = d.stored ?? 0;
        if (d.sleep === SLEEP.itemOverload || (d.recipeEnergy ?? 0) > 0 && stored >= (d.recipeEnergy ?? 0)) c = STATUS.full_output;
        // 没在做: FULL 标记 = 机械臂不用再喂 (isFullForInserters), 没做又不用喂只能是出料堵了; outFull = 产物多到游戏算堵料 (标记机械臂碰过才有, 刚读完地图时大多没有; entities.py output_over); 不然看上次卡在哪
        else if (stored <= 0) c = (d.flags ?? 0) & FLAG_FULL || d.outFull ? STATUS.full_output : d.sleep === SLEEP.fluidShortage ? STATUS.fluid_ingredient_shortage : d.sleep === SLEEP.itemShortage ? STATUS.item_ingredient_shortage : STATUS.working;
      }
      return Math.max(base, c);
    }
    case "MiningDrill": {
      let c: number = STATUS.working;
      if (!d.active) {
        if (d.bufferEmpty && !d.stuck && !d.resources) c = STATUS.no_minable_resources;
        else if (d.dropDeconstruct) c = STATUS.waiting_for_space_in_destination;
      }
      if (d.stuck) c = Math.max(c, STATUS.waiting_for_space_in_destination);
      // 输出缓冲里有东西: 睡着了就是放不下; 醒着时游戏要调目标的 canInsert, 外面调不了, 用目标满不满近似 (放到带子上的: 下一刻就放走了, 算在挖)
      if (!d.bufferEmpty && (!d.active || d.dropFull !== false)) c = Math.max(c, STATUS.waiting_for_space_in_destination);
      return Math.max(base, c);
    }
    case "Lab": {
      const m = [STATUS.working, STATUS.no_power, STATUS.no_research_in_progress, STATUS.missing_science_packs][d.last ?? 0] ?? STATUS.working;
      return Math.max(base, m);
    }
    case "Inserter": {
      let c: number = STATUS.working;
      if (!d.active) {
        c = STATUS.waiting_for_source_items;
        if (d.heldItem) c = Math.max(c, (d.flags ?? 0) & 4 ? STATUS.waiting_for_more_items : STATUS.waiting_for_space_in_destination);
        if (d.dropFull) c = Math.max(c, STATUS.waiting_for_space_in_destination);
      } else if (!d.heldItem) {
        if (d.dropFull) c = Math.max(c, STATUS.waiting_for_space_in_destination);
        if (d.atPickup) c = Math.max(c, STATUS.waiting_for_source_items);
      } else if (d.atDrop) c = Math.max(c, STATUS.waiting_for_space_in_destination);
      return Math.max(base, c);
    }
    case "AmmoTurret": return Math.max(base, Array.isArray(d.ammo) && d.ammo.length ? STATUS.working : STATUS.no_ammo);
    // 原型带 default_status 的 (开局坠机残骸的容器 broken) 用它代替 normal; 只认见过的名字
    case "ContainerEntity": case "LogisticContainer": return Math.max(base, ({ working: STATUS.working, normal: STATUS.normal, broken: STATUS.broken } as Record<string, number>)[d.defaultStatus ?? ""] ?? STATUS.normal);
    // 发电机的电缓冲是往外送的, 没满不算低电
    case "Generator": return Math.max((d.usage ?? 0) & 0x4000 ? STATUS.marked_for_deconstruction : 0, STATUS.working);
    case "TransportBelt": case "Splitter": case "Pipe": case "PipeToGround": case "OffshorePump": case "Radar": case "Boiler": return Math.max(base, STATUS.working);
    default: return null;
  }
}
