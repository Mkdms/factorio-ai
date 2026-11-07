// 按指标搜索 (M3, docs/search.md): 参数化积木 (tools/generators) → 爬山 → 沙盘喂料实测打分 (src/dataset/feed.ts)。
// 纯函数 (参数空间、邻居、打分) 放这里, 有单元测试 (test/search.test.ts); 跑沙盘的流程在 cli.ts。

/** 一个变体的参数 (组装机排: recipe machine inserter belt n per_input out layout) */
export type Spec = Record<string, string | number>;

/** 参数空间: 有序列表 (邻居 = 前后一格) 或整数范围 (邻居 = ±1 和 ±四分之一) */
export type Dim = { values: (string | number)[] } | { min: number; max: number };
export type Space = Record<string, Dim>;

/** 组装机排的参数空间 (从低档到高档排, 邻居 = 换高一档或低一档) */
export const ASSEMBLER_ROW_SPACE: Space = {
  machine: { values: ["assembling-machine-1", "assembling-machine-2", "assembling-machine-3"] },
  inserter: { values: ["inserter", "fast-inserter", "bulk-inserter"] },
  belt: { values: ["transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt"] },
  per_input: { min: 1, max: 3 },
  out: { min: 1, max: 3 },
  layout: { values: ["single", "double"] },
  n: { min: 1, max: 40 },
};

/** 只保留允许的取值 (例: 还没研究组装机3型 → machine 只留 1、2 型; 科技上限原则, CLAUDE.md) */
export function restrict(space: Space, allow: Record<string, (string | number)[]>): Space {
  const out: Space = {};
  for (const [k, d] of Object.entries(space)) {
    const a = allow[k];
    if (!a) out[k] = d;
    else if ("values" in d) {
      const vs = d.values.filter((v) => a.map(String).includes(String(v)));
      if (!vs.length) throw new Error(`${k} 没有允许的取值 (${a.join(",")})`);
      out[k] = { values: vs };
    } else {
      const ns = a.map(Number);
      out[k] = { min: Math.max(d.min, Math.min(...ns)), max: Math.min(d.max, Math.max(...ns)) };
    }
  }
  return out;
}

/** 改一个参数的所有邻居 (固定的参数不动) */
export function neighbors(spec: Spec, space: Space, fixed: string[] = []): Spec[] {
  const out: Spec[] = [];
  for (const [k, d] of Object.entries(space)) {
    if (fixed.includes(k)) continue;
    if ("values" in d) {
      const i = d.values.findIndex((v) => String(v) === String(spec[k]));
      for (const j of [i - 1, i + 1]) if (i >= 0 && j >= 0 && j < d.values.length) out.push({ ...spec, [k]: d.values[j] });
    } else {
      const v = Number(spec[k]);
      // 范围大的 (台数) 再加 ±四分之一的大步, 免得一格一格爬; 范围小的 (每台几个机械臂) 只 ±1
      const steps = d.max - d.min >= 8 ? [1, Math.max(2, Math.round(v / 4))] : [1];
      for (const nv of new Set(steps.flatMap((s) => [v - s, v + s]))) if (nv >= d.min && nv <= d.max) out.push({ ...spec, [k]: nv });
    }
  }
  return out;
}

/**
 * 联动邻居 (一次改两个参数, 一次只改一个的爬山走不到; 2026-11-02 铁齿轮 600: 停在 组装机2型 7 台, 走不到 组装机3型 5 台):
 * 换机器档时按机器速度比例同步调台数; 单排换双排时每排台数减半, 双排换单排时翻倍 (总台数不变)。
 */
export function coupledNeighbors(spec: Spec, space: Space, speeds: Record<string, number>, fixed: string[] = []): Spec[] {
  const out: Spec[] = [];
  const n = Number(spec.n), nd = space.n;
  const clampN = (v: number) => ("min" in nd ? Math.min(nd.max, Math.max(nd.min, v)) : v);
  if (fixed.includes("n")) return out;
  const md = space.machine;
  if (!fixed.includes("machine") && "values" in md) {
    const i = md.values.findIndex((v) => String(v) === String(spec.machine));
    for (const j of [i - 1, i + 1]) {
      if (i < 0 || j < 0 || j >= md.values.length) continue;
      const m = String(md.values[j]), s0 = speeds[String(spec.machine)], s1 = speeds[m];
      if (!s0 || !s1) continue;
      const nn = clampN(Math.ceil((n * s0) / s1 - 1e-9));
      if (nn !== n) out.push({ ...spec, machine: m, n: nn });
    }
  }
  const ld = space.layout;
  if (!fixed.includes("layout") && "values" in ld) {
    for (const l of ld.values) {
      if (l === spec.layout) continue;
      const nn = clampN(l === "double" ? Math.ceil(n / 2) : n * 2);
      if (nn !== n) out.push({ ...spec, layout: l, n: nn });
    }
  }
  return out;
}

/** 参数的规范写法 (缓存的键) */
export const keyOf = (s: Spec) => JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));

/** 一次实测的结果 (喂料实测的摘要) */
export interface Measured {
  outPerMin: number;
  tiles: number;
  powerMW: number;
  efficiency: number | null;
  trend: number | null;
  error?: string;
}

/**
 * 打分 (越大越好, 按位比较): 目标模式 = 先看达没达标 (实测 ≥ 目标 × 0.98), 达标的比占地小、再比耗电小 (按 0.1MW 取整,
 * 免得测量噪声当理由: 2026-11-02 为了少 0.001MW 把高速传送带换成了极速传送带), 再比档位 (cost = 各参数档位序号之和, 低档便宜);
 * 没达标的比产量高。趋势 < 0.9 (在往堵的方向走) 当没达标。出错 / 不合法 = 最差。
 */
export function score(m: Measured, target: number, cost = 0): number[] {
  if (m.error) return [-1];
  const steady = m.trend == null || m.trend >= 0.9;
  if (steady && m.outPerMin >= target * 0.98) return [1, -m.tiles, -Math.round(m.powerMW * 10) / 10, -cost];
  return [0, steady ? m.outPerMin : m.outPerMin * 0.5, -m.tiles];
}

/** 档位和: 有序列表参数的序号之和 (低档便宜), 打分平局时用 */
export function tierCost(spec: Spec, space: Space): number {
  let c = 0;
  for (const [k, d] of Object.entries(space)) if ("values" in d) c += Math.max(0, d.values.findIndex((v) => String(v) === String(spec[k])));
  return c;
}

export function better(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -Infinity, y = b[i] ?? -Infinity;
    if (x !== y) return x > y;
  }
  return false;
}

/** 可复现的随机数 (mulberry32): 随机重启用, 同一个种子每次走同样的起点 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 随机重启的起点: 有序列表参数随机取一档, 整数参数 (台数除外) 在范围内随机; 台数按机器速度比例从 base 换算 (保持满速产量差不多),
 * 固定的参数不动。爬山只改一步会停在局部最优 (2026-11-02 后期研究的铁齿轮: 停在 组装机2型 7 台, 走不到 3 型 + 高速机械臂)。
 */
export function randomSpec(base: Spec, space: Space, speeds: Record<string, number>, rand: () => number, fixed: string[] = []): Spec {
  const out: Spec = { ...base };
  for (const [k, d] of Object.entries(space)) {
    if (fixed.includes(k) || k === "n") continue;
    if ("values" in d) out[k] = d.values[Math.floor(rand() * d.values.length)];
    else out[k] = d.min + Math.floor(rand() * (d.max - d.min + 1));
  }
  const nd = space.n;
  if (!fixed.includes("n") && "min" in nd) {
    const s0 = speeds[String(base.machine)], s1 = speeds[String(out.machine)];
    const n = s0 && s1 ? Math.ceil((Number(base.n) * s0) / s1 - 1e-9) : Number(base.n);
    out.n = Math.min(nd.max, Math.max(nd.min, n));
  }
  return out;
}
