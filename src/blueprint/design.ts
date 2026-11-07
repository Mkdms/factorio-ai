// 游戏外设计 → 精准落格的蓝图。
// 做法 (第一版在 2.1.23 试过, 2.1.24 由 experiments/blueprint-snap.ts 重新核实):
//   蓝图加 "snap-to-grid" {W,H} + "absolute-snapping" + "position-relative-to-grid" {dx,dy},
//   它就只能落在世界格子 (k·W+dx, m·H+dy) 上; 格子左上 = 蓝图坐标 (0,0), 实体坐标原样使用。
//   所以: 取设计包围盒左上再退几格、取偶数作 (x0,y0) (偶数保证铁轨这类 2 格对齐的东西不错位),
//   实体坐标减去 (x0,y0) 写进蓝图, dx = x0 mod W, dy = y0 mod H; 放的时候鼠标指着格子中心附近即可。
import { encodeBlueprint, mapVersion } from "../lab/blueprint.ts";

export interface Placement {
  name: string;
  /** 世界坐标 (实体中心, 和游戏里 entity.position 一样) */
  x: number;
  y: number;
  /** 16 方向: 北 0, 东 4, 南 8, 西 12 */
  direction?: number;
  recipe?: string;
  [k: string]: unknown;
}

export interface AbsoluteBlueprint {
  string: string;
  /** 格子左上的世界坐标 */
  origin: { x: number; y: number };
  cell: { w: number; h: number };
  /** 放的时候鼠标指这里 (格子中心) */
  cursor: { x: number; y: number };
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
const evenFloor = (v: number) => Math.floor(v / 2) * 2;
const evenCeil = (v: number) => Math.ceil(v / 2) * 2;

export function encodeAbsolute(
  placements: Placement[],
  opts: { label?: string; gameVersion: string; margin?: number; wires?: number[][] },
): AbsoluteBlueprint {
  const margin = opts.margin ?? 6; // 包住最大的建筑 (炼油厂 5×5、火箭发射井 9×9 要更大的余量时调大)
  const xs = placements.map((p) => p.x), ys = placements.map((p) => p.y);
  const x0 = evenFloor(Math.min(...xs) - margin), y0 = evenFloor(Math.min(...ys) - margin);
  const w = evenCeil(Math.max(...xs) + margin - x0), h = evenCeil(Math.max(...ys) + margin - y0);
  const entities = placements.map((p, i) => {
    const { x, y, ...rest } = p;
    return { entity_number: i + 1, ...rest, position: { x: x - x0, y: y - y0 } };
  });
  const bp = {
    item: "blueprint",
    label: opts.label ?? "Factorio Pilot 设计",
    entities,
    ...(opts.wires ? { wires: opts.wires } : {}),
    "snap-to-grid": { x: w, y: h },
    "absolute-snapping": true,
    "position-relative-to-grid": { x: mod(x0, w), y: mod(y0, h) },
    version: mapVersion(opts.gameVersion),
  };
  return { string: encodeBlueprint({ blueprint: bp }), origin: { x: x0, y: y0 }, cell: { w, h }, cursor: { x: x0 + w / 2, y: y0 + h / 2 } };
}

export interface Built {
  name: string;
  x: number;
  y: number;
  direction?: number;
}

/** 逐格核对: 设计 vs 实际 (名字 + 位置 + 方向), 返回缺的、多的、方向不对的 */
export function diffPlacements(design: Placement[], actual: Built[]) {
  const key = (n: string, x: number, y: number) => `${n}@${x.toFixed(2)},${y.toFixed(2)}`;
  const got = new Map(actual.map((a) => [key(a.name, a.x, a.y), a]));
  const missing: Placement[] = [], wrongDirection: { design: Placement; actual: Built }[] = [];
  for (const d of design) {
    const a = got.get(key(d.name, d.x, d.y));
    if (!a) missing.push(d);
    else {
      if ((d.direction ?? 0) !== (a.direction ?? 0)) wrongDirection.push({ design: d, actual: a });
      got.delete(key(d.name, d.x, d.y));
    }
  }
  return { ok: missing.length === 0 && wrongDirection.length === 0 && got.size === 0, missing, extra: [...got.values()], wrongDirection };
}
