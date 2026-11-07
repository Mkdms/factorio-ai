// 摆放规则: 全部从本机导出的原型数据 (data-raw-dump.json) 提取, 不手写数值。
//  —— 规则在数据里, 检查器要用数据, 不靠记忆。
import fs from "node:fs";
import path from "node:path";
import { labRoot, builtinMods, findFactorioDir } from "../lab/gamedir.ts";

export type Dir = 0 | 4 | 8 | 12;

export interface FluidConn {
  /** 相对实体中心的位置 (实体朝北时) */
  x: number;
  y: number;
  /** 接口朝向 (实体朝北时), 0/4/8/12 */
  dir: number;
  flow: "input" | "output" | "input-output";
  underground?: boolean;
  maxUnderground?: number;
  /** 有配方的机器: 接口是否只在某些配方下有效 (这里只标记) */
  recipeDependent?: boolean;
  /** 有配方的机器: 这是第几个进口 / 出口 (从 0 起); 配方有 n 种流体原料就只用前 n 个进口, 出口同理 */
  boxIndex?: number;
  /** 属于实体的第几个流体箱 (同一个箱子的接口互通; 化工厂的进口箱和出口箱不通) */
  box: number;
  /** 流体箱的 production_type: input / output / input-output (管道、泵、储液罐没有) */
  production: "input" | "output" | "input-output" | "none";
  /** 原型里写死的流体 (锅炉进口 water、出口 steam, 蒸汽机 steam) */
  filter?: string;
  /** 2.0 连接类别 (聚变堆专用口), 没写就是 default */
  category: string[];
}

export interface EntityRule {
  name: string;
  type: string;
  /** 朝北时的占地 (格), 由碰撞盒取整 */
  w: number;
  h: number;
  /** 碰撞盒 (朝北时) */
  box: [number, number, number, number];
  electricConsumer: boolean;
  electricProducer: boolean;
  pole?: { supply: number; wire: number };
  undergroundBeltMax?: number;
  inserter?: { pickup: [number, number]; drop: [number, number] };
  /** 采矿机的出料点 (朝北时, 相对中心) */
  dropVector?: [number, number];
  fluid: FluidConn[];
  roboport?: { logistics: number; construction: number };
  /** 炮塔: 射程和最小射程 (attack_parameters.range / min_range); kind 按原型类型 */
  turret?: { range: number; minRange: number; kind: "ammo" | "electric" | "fluid" | "artillery" };
  /** 墙和闸门 (炮塔射程覆盖检查用) */
  wall: boolean;
  beltLike: boolean;
  /** 能放东西进去 / 从里面拿东西的 (机械臂目标) */
  holdsItems: boolean;
  rail: boolean;
}

export interface Rules {
  version: string;
  get(name: string): EntityRule | undefined;
  all: Map<string, EntityRule>;
  /** 配方的流体原料和流体产物 (按配方里的顺序, 和机器的进口 / 出口箱一一对应); 不认识的配方返回 undefined */
  recipeFluid(name: string): { in: string[]; out: string[] } | undefined;
}

const BELT_TYPES = new Set(["transport-belt", "underground-belt", "splitter", "loader", "loader-1x1", "linked-belt", "lane-splitter"]);
const RAIL_TYPES = new Set(["straight-rail", "curved-rail-a", "curved-rail-b", "half-diagonal-rail", "legacy-straight-rail", "legacy-curved-rail", "rail-ramp", "rail-support", "elevated-straight-rail", "elevated-curved-rail-a", "elevated-curved-rail-b", "elevated-half-diagonal-rail"]);
const PRODUCER_TYPES = new Set(["generator", "solar-panel", "burner-generator", "electric-energy-interface", "accumulator", "fusion-generator", "lightning-attractor"]);
const HOLDS_ITEMS = new Set([
  "container", "logistic-container", "infinity-container", "linked-container", "assembling-machine", "furnace", "lab", "rocket-silo", "boiler", "reactor", "burner-generator",
  "cargo-wagon", "locomotive", "artillery-wagon", "artillery-turret", "ammo-turret", "roboport", "beacon", "mining-drill", "agricultural-tower", "cargo-landing-pad", "space-platform-hub",
  "asteroid-collector", "car", "spider-vehicle", "character", "fluid-wagon",
]);

function connsOf(fb: any, box: number, recipeDependent = false, boxIndex?: number): FluidConn[] {
  const out: FluidConn[] = [];
  const production = (fb?.production_type ?? "none") as FluidConn["production"];
  for (const c of fb?.pipe_connections ?? []) {
    const positions: [number, number][] = c.position ? [c.position] : (c.positions ?? [])[0] ? [c.positions[0]] : [];
    for (const p of positions) {
      out.push({
        x: p[0], y: p[1], dir: c.direction ?? 0,
        flow: c.flow_direction ?? "input-output",
        underground: c.connection_type === "underground",
        maxUnderground: c.max_underground_distance,
        recipeDependent,
        boxIndex,
        box,
        production,
        filter: typeof fb?.filter === "string" ? fb.filter : undefined,
        category: Array.isArray(c.connection_category) ? c.connection_category : typeof c.connection_category === "string" ? [c.connection_category] : ["default"],
      });
    }
  }
  return out;
}

const TURRET_KIND: Record<string, "ammo" | "electric" | "fluid" | "artillery"> = { "ammo-turret": "ammo", "electric-turret": "electric", "fluid-turret": "fluid", "artillery-turret": "artillery" };

export function loadRules(dumpPath?: string): Rules {
  const file = dumpPath ?? defaultDumpPath();
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const all = new Map<string, EntityRule>();
  for (const [type, group] of Object.entries<any>(raw)) {
    if (!group || typeof group !== "object") continue;
    for (const [name, e] of Object.entries<any>(group)) {
      if (!e || typeof e !== "object" || !e.collision_box) continue;
      const [[x1, y1], [x2, y2]] = e.collision_box;
      const es = e.energy_source;
      const electric = es && es.type === "electric";
      const fluid: FluidConn[] = [];
      let box = 0;
      if (e.fluid_box) fluid.push(...connsOf(e.fluid_box, box++));
      if (e.output_fluid_box) fluid.push(...connsOf(e.output_fluid_box, box++));
      if (Array.isArray(e.fluid_boxes)) {
        const counters: Record<string, number> = {};
        for (const fb of e.fluid_boxes) {
          const kind = fb.production_type ?? "input-output";
          const idx = counters[kind] ?? 0;
          counters[kind] = idx + 1;
          fluid.push(...connsOf(fb, box++, true, idx));
        }
      }
      const rule: EntityRule = {
        name, type,
        w: Math.max(1, Math.ceil(x2 - x1 - 0.01)), h: Math.max(1, Math.ceil(y2 - y1 - 0.01)),
        box: [x1, y1, x2, y2],
        electricConsumer: !!electric && type !== "electric-pole" && !PRODUCER_TYPES.has(type),
        electricProducer: PRODUCER_TYPES.has(type) || type === "electric-pole" && false,
        pole: type === "electric-pole" ? { supply: e.supply_area_distance, wire: e.maximum_wire_distance } : undefined,
        undergroundBeltMax: type === "underground-belt" ? e.max_distance : undefined,
        inserter: type === "inserter" ? { pickup: e.pickup_position ?? [0, -1], drop: e.insert_position ?? [0, 1.2] } : undefined,
        dropVector: type === "mining-drill" && Array.isArray(e.vector_to_place_result) && !(e.vector_to_place_result[0] === 0 && e.vector_to_place_result[1] === 0) ? [e.vector_to_place_result[0], e.vector_to_place_result[1]] : undefined,
        fluid,
        roboport: type === "roboport" ? { logistics: e.logistics_radius, construction: e.construction_radius } : undefined,
        turret: TURRET_KIND[type] && e.attack_parameters ? { range: e.attack_parameters.range, minRange: e.attack_parameters.min_range ?? 0, kind: TURRET_KIND[type] } : undefined,
        wall: type === "wall" || type === "gate",
        beltLike: BELT_TYPES.has(type),
        holdsItems: HOLDS_ITEMS.has(type) || BELT_TYPES.has(type),
        rail: RAIL_TYPES.has(type),
      };
      all.set(name, rule);
    }
  }
  const recipes = new Map<string, { in: string[]; out: string[] }>();
  for (const [name, r] of Object.entries<any>(raw.recipe ?? {})) {
    const fluids = (x: unknown) => (Array.isArray(x) ? x : []).filter((i: any) => i && i.type === "fluid").map((i: any) => String(i.name)); // 导出的数据里空列表是 {} 不是 []
    recipes.set(name, { in: fluids(r.ingredients), out: fluids(r.results) });
  }
  const version = path.basename(path.dirname(file));
  return { version, all, get: (n) => all.get(n), recipeFluid: (n) => recipes.get(n) };
}

export function defaultDumpPath(): string {
  const dir = findFactorioDir();
  const key = builtinMods(dir).map((m) => `${m.name}-${m.version}`).join("_");
  return path.join(labRoot(), "prototypes", key, "data-raw-dump.json");
}

/** 把朝北时的向量按实体朝向旋转 (顺时针, 每 4 = 90°) */
export function rotate(x: number, y: number, dir: number): [number, number] {
  const q = ((Math.round(dir / 4) % 4) + 4) % 4;
  let [a, b] = [x, y];
  for (let i = 0; i < q; i++) [a, b] = [-b, a];
  return [a, b];
}

export const DIRV: Record<number, [number, number]> = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };
