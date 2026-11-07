// 计算器: 给目标产量 (每分钟) 和每个配方用什么机器 / 插件 / 分享塔, 解出每个配方要多少台、吃多少、耗多少电和燃料。
// 有循环的链 (句芒: 营养素喂生物室、生物室又做营养素; 细菌培养) 和副产物用线性规划解 (yalps, MIT), 不自己写求解器。
// 规则 (都有沙盘核实或原型来源, 见 docs/calc.md): 每次产出 = 期望量 + (期望量 - 产能忽略量) × 产能; 速度 = 机器速度 × 品质倍率 × (1 + 速度加成) / 配方时间;
// 分享塔每座 = 插件效果 × 分享效率 × 递减表[塔数 - 1] (第四批核实 1.5√n 规则); 产能夹在 [0, 配方上限], 速度和耗能不低于 -80%。
import { solve, type Model } from "yalps";
import type { Effects, GameData, Machine, Recipe } from "./data.ts";

export interface MachineSetup {
  machine: string;
  /** 机器品质 (等级数字或名字 normal / uncommon / rare / epic / legendary), 速度 × (1 + 0.3 × 等级) (calc.quality-machine-speed ✅) */
  quality?: number | string;
  /** 插件, 可写 "名字@品质" (例: "speed-module-3@legendary") */
  modules?: string[];
  /** 每台机器被几座分享塔照到, 每座塔装什么插件; quality = 塔的品质 */
  beacons?: { name: string; count: number; modules: string[]; quality?: number | string };
  /** 研究给这个配方的产能加成 (例: 0.1) */
  researchProductivity?: number;
  /** 烧什么燃料 (烧燃料的机器); 默认按燃料类别: chemical → 煤, nutrients → 营养素 */
  fuel?: string;
  /** 固定台数 (最多满负荷开工); 用来"已经摆好的设计能出多少" */
  count?: number;
}

export interface Plan {
  /** 物品 → 每分钟要多少 (净产出) */
  targets: Record<string, number>;
  /** 用到的配方 → 怎么做 */
  recipes: Record<string, MachineSetup>;
  /** 可以从外面进的东西; 不给就是"所有配方都不产出的东西都能进" */
  imports?: string[];
  /** 求这个物品的最大净产出 (配合 count 固定的机器); 不给就是满足 targets 时用料最少 */
  maximize?: string;
}

export interface Row {
  recipe: string;
  machine: string;
  /** 每分钟做几次 (全部机器合计) */
  craftsPerMin: number;
  /** 要几台 (小数, 满负荷) */
  machines: number;
  effects: Effects;
  /** 每台每分钟做几次 */
  perMachine: number;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  powerW: number;
  fuel?: { item: string; perMin: number };
}

export interface Result {
  rows: Row[];
  imports: Record<string, number>;
  surplus: Record<string, number>;
  powerW: number;
  /** 会坏又在链里被用掉的东西: 一批太大、用得太慢时至少要做 批量 ÷ 保质期, 多出来的会坏 */
  spoilWaste: { item: string; batch: number; lifeMin: number; minPerMin: number; usedPerMin: number; wastePerMin: number }[];
}

const ZERO: Effects = { speed: 0, productivity: 0, consumption: 0, pollution: 0, quality: 0 };
const KEYS = ["speed", "productivity", "consumption", "pollution", "quality"] as const;

export const QUALITY_LEVEL: Record<string, number> = { normal: 0, uncommon: 1, rare: 2, epic: 3, legendary: 5 };
export const levelOf = (q?: number | string) => (typeof q === "number" ? q : q ? (QUALITY_LEVEL[q] ?? 0) : 0);
export const qualityMultiplier = (q?: number | string) => 1 + 0.3 * levelOf(q);

/** 插件效果按品质放大: 只放大正面的 (速度、产能、品质为正, 耗能、污染为负), 每级 +30%, 向下取整到 0.1% (calc.quality-module-positive-only ✅) */
export function moduleEffect(effect: Partial<Effects>, quality?: number | string): Partial<Effects> {
  const m = qualityMultiplier(quality);
  if (m === 1) return effect;
  const out: Partial<Effects> = {};
  for (const k of KEYS) {
    const v = effect[k];
    if (v === undefined) continue;
    const good = k === "consumption" || k === "pollution" ? v < 0 : v > 0;
    out[k] = good ? Math.sign(v) * Math.floor(Math.abs(v) * m * 1000 + 1e-9) / 1000 : v;
  }
  return out;
}
const parseModule = (s: string) => { const [name, q] = s.split("@"); return { name, quality: q }; };

export function effectsFor(gd: GameData, m: Machine, r: Recipe, s: MachineSetup): Effects {
  const e: Effects = { ...ZERO };
  const add = (x: Partial<Effects>, k = 1) => { for (const key of KEYS) e[key] += (x[key] ?? 0) * k; };
  add(m.baseEffect);
  for (const spec of s.modules ?? []) {
    const { name, quality } = parseModule(spec);
    const mod = gd.modules.get(name);
    if (!mod) throw new Error(`没有插件 ${name}`);
    add(moduleEffect(mod.effect, quality));
  }
  if (s.beacons && s.beacons.count > 0) {
    const b = gd.beacons.get(s.beacons.name);
    if (!b) throw new Error(`没有分享塔 ${s.beacons.name}`);
    // 分享效率 = 原型值 + 每级品质加成 (calc.quality-beacon-effectivity ✅: 普通 1.5、传说 2.5)
    const per = (b.effectivity + b.effectivityPerQuality * levelOf(s.beacons.quality)) * (b.profile[Math.min(s.beacons.count, b.profile.length) - 1] ?? 0);
    for (const spec of s.beacons.modules) {
      const { name, quality } = parseModule(spec);
      add(moduleEffect(gd.modules.get(name)?.effect ?? {}, quality), per * s.beacons.count);
    }
  }
  e.productivity += s.researchProductivity ?? 0;
  e.speed = Math.max(-0.8, e.speed);
  e.consumption = Math.max(-0.8, e.consumption);
  e.productivity = r.allowProductivity ? Math.min(r.maxProductivity, Math.max(0, e.productivity)) : 0;
  return e;
}

export function defaultFuel(gd: GameData, m: Machine): string | undefined {
  for (const cat of m.fuelCategories) {
    if (cat === "chemical") return "coal";
    if (cat === "nutrients") return "nutrients";
    for (const [name, f] of gd.fuels) if (f.category === cat) return name;
  }
  return undefined;
}

/** 一个配方在一台机器上: 每分钟做几次、每次吃 / 出多少、每台耗电和燃料 */
export function recipeOnMachine(gd: GameData, recipeName: string, s: MachineSetup) {
  const r = gd.recipes.get(recipeName);
  if (!r) throw new Error(`没有配方 ${recipeName}`);
  const m = gd.machines.get(s.machine);
  if (!m) throw new Error(`没有机器 ${s.machine}`);
  if (!r.categories.some((c) => m.categories.includes(c))) throw new Error(`${s.machine} 做不了 ${recipeName} (类别 ${r.categories.join("/")})`);
  const e = effectsFor(gd, m, r, s);
  const perMachine = (60 * m.speed * qualityMultiplier(s.quality) * (1 + e.speed)) / r.time;
  const out: Record<string, number> = {};
  for (const p of r.products) out[p.name] = (out[p.name] ?? 0) + p.amount + Math.max(0, p.amount - p.ignored) * e.productivity;
  const inp: Record<string, number> = {};
  for (const i of r.ingredients) inp[i.name] = (inp[i.name] ?? 0) + i.amount;
  const activeW = m.energyW * (1 + e.consumption);
  let fuel: { item: string; perCraft: number } | undefined;
  if (m.source === "burner") {
    const item = s.fuel ?? defaultFuel(gd, m);
    const f = item ? gd.fuels.get(item) : undefined;
    if (!item || !f) throw new Error(`${s.machine} 烧什么燃料? 原型燃料类别 ${m.fuelCategories.join("/")}`);
    fuel = { item, perCraft: ((activeW / m.effectivity) * 60) / f.value / perMachine };
  }
  return { r, m, e, perMachine, out, inp, activeW, fuel };
}

export function solvePlan(gd: GameData, plan: Plan): Result {
  const info = Object.fromEntries(Object.entries(plan.recipes).map(([name, s]) => [name, recipeOnMachine(gd, name, s)]));
  const produced = new Set(Object.values(info).flatMap((x) => Object.keys(x.out)));
  const items = new Set<string>([...Object.keys(plan.targets), ...Object.values(info).flatMap((x) => [...Object.keys(x.out), ...Object.keys(x.inp), ...(x.fuel ? [x.fuel.item] : [])])]);
  const importable = new Set(plan.imports ?? [...items].filter((i) => !produced.has(i)));
  const variables: Model["variables"] = {};
  for (const [name, x] of Object.entries(info)) {
    const coef: Record<string, number> = { cost: 1e-6 }; // 同样满足时少做一点
    for (const [k, v] of Object.entries(x.out)) coef[k] = (coef[k] ?? 0) + v;
    for (const [k, v] of Object.entries(x.inp)) coef[k] = (coef[k] ?? 0) - v;
    if (x.fuel) coef[x.fuel.item] = (coef[x.fuel.item] ?? 0) - x.fuel.perCraft;
    variables[`r:${name}`] = coef;
  }
  for (const i of importable) variables[`i:${i}`] = { [i]: 1, cost: 1 };
  const constraints: Model["constraints"] = {};
  for (const i of items) constraints[i] = { min: plan.targets[i] ?? 0 };
  // 固定台数: 这个配方每分钟做的次数 ≤ 台数 × 每台满负荷
  for (const [name, s] of Object.entries(plan.recipes)) {
    if (s.count !== undefined) { constraints[`cap:${name}`] = { max: s.count * info[name].perMachine }; (variables[`r:${name}`] as Record<string, number>)[`cap:${name}`] = 1; }
  }
  // 腐坏批量 (M3 生物核心验收时沙盘发现): 营养素一批 60 个、保质期 5 分钟, 消耗只有每分钟 4.6 时, 每批大半会坏 ——
  // 只要链里用到它, 产出它的配方每分钟至少做 批量 ÷ 保质期 个 (按全新算, 原料继承的新鲜度不算, 偏乐观)
  const internalUse = new Set(Object.values(info).flatMap((x) => [...Object.keys(x.inp), ...(x.fuel ? [x.fuel.item] : [])]));
  const spoilBatch: { item: string; recipe: string; batch: number; life: number }[] = [];
  for (const [name, x] of Object.entries(info)) {
    for (const [item, perCraft] of Object.entries(x.out)) {
      const life = gd.spoil.get(item);
      if (!life || !internalUse.has(item) || plan.targets[item] || plan.maximize === item) continue; // 要的成品不算 (多出来的是产出)
      spoilBatch.push({ item, recipe: name, batch: perCraft, life });
      constraints[`spoil:${item}:${name}`] = { min: perCraft / life };
      (variables[`r:${name}`] as Record<string, number>)[`spoil:${item}:${name}`] = perCraft;
    }
  }
  let model: Model = { direction: "minimize", objective: "cost", constraints, variables };
  if (plan.maximize) {
    // 最大净产出, 进口只算成本的一个小惩罚 (不让它无限进料却不用)
    for (const v of Object.values(variables) as Record<string, number>[]) v["score"] = (v[plan.maximize] ?? 0) - (v.cost ?? 0) * 1e-3;
    model = { direction: "maximize", objective: "score", constraints, variables };
  }
  const sol = solve(model);
  if (sol.status !== "optimal") throw new Error(`解不出来 (${sol.status}): 要的东西做不出来又不能从外面进? 能进的: ${[...importable].join(", ") || "无"}`);
  const val = new Map(sol.variables);
  const rows: Row[] = [];
  const net: Record<string, number> = {};
  let powerW = 0;
  for (const [name, x] of Object.entries(info)) {
    const c = val.get(`r:${name}`) ?? 0;
    const machines = c / x.perMachine;
    const inputs = Object.fromEntries(Object.entries(x.inp).map(([k, v]) => [k, v * c]));
    const outputs = Object.fromEntries(Object.entries(x.out).map(([k, v]) => [k, v * c]));
    const fuel = x.fuel ? { item: x.fuel.item, perMin: x.fuel.perCraft * c } : undefined;
    const w = x.m.source === "electric" ? machines * x.activeW + Math.ceil(machines - 1e-9) * x.m.drainW : 0;
    powerW += w;
    for (const [k, v] of Object.entries(outputs)) net[k] = (net[k] ?? 0) + v;
    for (const [k, v] of Object.entries(inputs)) net[k] = (net[k] ?? 0) - v;
    if (fuel) net[fuel.item] = (net[fuel.item] ?? 0) - fuel.perMin;
    rows.push({ recipe: name, machine: x.m.name, craftsPerMin: c, machines, effects: x.e, perMachine: x.perMachine, inputs, outputs, powerW: w, fuel });
  }
  const imports: Record<string, number> = {};
  for (const i of importable) { const v = val.get(`i:${i}`) ?? 0; if (v > 1e-9) { imports[i] = v; net[i] = (net[i] ?? 0) + v; } }
  const surplus: Record<string, number> = {};
  for (const [k, v] of Object.entries(net)) { const extra = v - (plan.targets[k] ?? 0); if (extra > 1e-6) surplus[k] = extra; }
  const spoilWaste = spoilBatch.map((b) => {
    const row = rows.find((r) => r.recipe === b.recipe)!;
    const made = row.outputs[b.item] ?? 0;
    const used = rows.reduce((n, r) => n + (r.inputs[b.item] ?? 0) + (r.fuel?.item === b.item ? r.fuel.perMin : 0), 0);
    return { item: b.item, batch: b.batch, lifeMin: b.life, minPerMin: b.batch / b.life, usedPerMin: used, wastePerMin: Math.max(0, made - used) };
  }).filter((w) => w.wastePerMin > 1e-6);
  return { rows, imports, surplus, powerW, spoilWaste };
}
