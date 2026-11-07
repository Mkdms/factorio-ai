// 计算器的数据: 全从本机原型导出 (data-raw-dump.json) 读, 不手写数值。字段默认值照原型 API 文件 (prototype-api.json, 2.1.24):
// 配方时间默认 0.5 秒、类别默认 crafting、产能上限默认 3 (300%)、产物 ignored_by_productivity 默认 = ignored_by_stats (默认 0)。
// 沙盘核实过 (第十九批 calc.*): 电力机器的待机耗电没写时 = energy_usage / 30; 机器品质速度 × (1 + 0.3 × 等级);
// 插件品质只放大正面效果、每级 +30% (向下取整到 0.1%); 分享塔品质每级 +0.2 分享效率 (原型字段)。
import fs from "node:fs";
import path from "node:path";
import { defaultDumpPath } from "../blueprint/rules.ts";

export interface Amount { name: string; type: "item" | "fluid"; amount: number }
export interface Product extends Amount {
  /** 产能只作用在 amount - ignored 那部分 (例: 五足虫卵繁殖只算净增, 第十二批核实) */
  ignored: number;
}
export interface Recipe {
  name: string;
  categories: string[];
  /** 秒 (速度 1 的机器做一次) */
  time: number;
  ingredients: Amount[];
  /** 期望产量 (概率、区间、额外小数都折算进 amount) */
  products: Product[];
  allowProductivity: boolean;
  maxProductivity: number;
}
export interface Effects { speed: number; productivity: number; consumption: number; pollution: number; quality: number }
export interface Machine {
  name: string;
  speed: number;
  categories: string[];
  /** 满负荷耗能 (瓦) */
  energyW: number;
  /** 待机耗电 (瓦; 只有电力机器) */
  drainW: number;
  source: "electric" | "burner" | "void" | "heat" | "fluid";
  fuelCategories: string[];
  effectivity: number;
  moduleSlots: number;
  baseEffect: Partial<Effects>;
  allowedEffects: string[] | null;
}
export interface Module { name: string; effect: Partial<Effects>; category: string }
export interface Beacon { name: string; effectivity: number; effectivityPerQuality: number; profile: number[]; moduleSlots: number; energyW: number }
export interface GameData {
  version: string;
  recipes: Map<string, Recipe>;
  machines: Map<string, Machine>;
  modules: Map<string, Module>;
  beacons: Map<string, Beacon>;
  /** 燃料: 物品 → {燃烧值 J, 燃料类别} */
  fuels: Map<string, { value: number; category: string }>;
  /** 会坏的物品 → 保质期 (分钟) */
  spoil: Map<string, number>;
}

const UNITS: Record<string, number> = { "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 };
/** "500kW" / "2MJ" → 500000 / 2000000 (瓦或焦耳) */
export function energy(s: unknown): number {
  if (typeof s === "number") return s;
  const m = /^([\d.]+)\s*([kMGTP]?)[WJ]$/.exec(String(s ?? "").trim());
  if (!m) return 0;
  return Number(m[1]) * UNITS[m[2]];
}

type Raw = Record<string, any>;
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []); // 空表导出成 {} (FBE CLAUDE.md 同一个坑)

function product(r: Raw): Product {
  const base = r.amount ?? ((r.amount_min ?? 0) + (r.amount_max ?? 0)) / 2;
  const p = r.probability ?? r.independent_probability ?? 1;
  const ignored = r.ignored_by_productivity ?? r.ignored_by_stats ?? 0;
  return { name: r.name, type: r.type === "fluid" ? "fluid" : "item", amount: base * p + (r.extra_count_fraction ?? 0), ignored };
}

export function loadGameData(dumpPath = defaultDumpPath()): GameData {
  const raw = JSON.parse(fs.readFileSync(dumpPath, "utf8")) as Raw;
  const recipes = new Map<string, Recipe>();
  for (const [name, r] of Object.entries(raw.recipe ?? {}) as [string, Raw][]) {
    recipes.set(name, {
      name,
      categories: list<string>(r.categories).length ? list<string>(r.categories) : r.category ? [r.category] : ["crafting"],
      time: r.energy_required ?? 0.5,
      ingredients: list<Raw>(r.ingredients).map((i) => ({ name: i.name, type: i.type === "fluid" ? "fluid" : "item", amount: i.amount })),
      products: list<Raw>(r.results).map(product),
      allowProductivity: !!r.allow_productivity,
      maxProductivity: r.maximum_productivity ?? 3,
    });
  }
  const machines = new Map<string, Machine>();
  for (const t of ["assembling-machine", "furnace", "rocket-silo"]) {
    for (const [name, m] of Object.entries(raw[t] ?? {}) as [string, Raw][]) {
      const src = m.energy_source ?? {};
      const energyW = energy(m.energy_usage);
      machines.set(name, {
        name, speed: m.crafting_speed ?? 1, categories: list<string>(m.crafting_categories),
        energyW, drainW: src.type === "electric" ? (src.drain !== undefined ? energy(src.drain) : energyW / 30) : 0,
        source: src.type ?? "void", fuelCategories: list<string>(src.fuel_categories).length ? list<string>(src.fuel_categories) : src.fuel_category ? [src.fuel_category] : [],
        effectivity: src.effectivity ?? 1, moduleSlots: m.module_slots ?? 0,
        baseEffect: m.effect_receiver?.base_effect ?? {}, allowedEffects: Array.isArray(m.allowed_effects) ? m.allowed_effects : null,
      });
    }
  }
  const modules = new Map<string, Module>();
  for (const [name, m] of Object.entries(raw.module ?? {}) as [string, Raw][]) modules.set(name, { name, effect: m.effect ?? {}, category: m.category });
  const beacons = new Map<string, Beacon>();
  for (const [name, b] of Object.entries(raw.beacon ?? {}) as [string, Raw][]) {
    beacons.set(name, { name, effectivity: b.distribution_effectivity ?? 1, effectivityPerQuality: b.distribution_effectivity_bonus_per_quality_level ?? 0, profile: list<number>(b.profile), moduleSlots: b.module_slots ?? 0, energyW: energy(b.energy_usage) });
  }
  const fuels = new Map<string, { value: number; category: string }>();
  const spoil = new Map<string, number>();
  for (const t of ["item", "tool", "ammo", "capsule", "module", "item-with-entity-data", "rail-planner"]) {
    for (const [name, it] of Object.entries(raw[t] ?? {}) as [string, Raw][]) {
      if (it.fuel_value) fuels.set(name, { value: energy(it.fuel_value), category: it.fuel_category ?? "chemical" });
      if (it.spoil_ticks) spoil.set(name, it.spoil_ticks / 3600);
    }
  }
  return { version: path.basename(path.dirname(dumpPath)), recipes, machines, modules, beacons, fuels, spoil };
}
