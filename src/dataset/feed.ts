// 喂料测产量 (数据集第三层标签, docs/blueprint-dataset.md): 一张蓝图放进沙盘 → 接电 → 模组 feed_setup 自动上料 / 收料 → 预热 → 分两半测。
// 数据集命令 (ingest.ts feed) 和沙盘回归测试 (test/sandbox/feed.test.ts) 共用。
import type { LabInstance } from "../lab/instance.ts";
import { encodeBlueprint } from "../lab/blueprint.ts";
import { analyze } from "../blueprint/inspect.ts";

export interface FeedResult {
  feeds: number; sinks: number; inChests: number; outChests: number; crafters: number;
  /** 接了几张进料 / 出料管网 (永续管道; 2026-11-05 化工厂类蓝图) */
  fluidIn?: number; fluidOut?: number;
  /** 当出口用的装车臂 (从带子取货、没有放货目标: 车厢不在蓝图里) */
  wagonTaps?: number;
  /** 当入口用的卸车臂 (没有取货目标、往带子 / 箱子放: 每 tick 空手就塞一手) */
  unloaders?: number;
  unsupported: Record<string, number>;
  /** 测量条件: none = 只解锁配方 (默认); late = 全部科技研究完 (机械臂抓取数等按后期) */
  research?: string;
  /** 几条进料带要的料完全一样 (3 种以上), 分开放 (每道一种) 的起点数 */
  splitStarts?: number;
  /** 补了几处电 (靠相邻模块供电的拼接块) */
  powerFixed?: number;
  /** 炉子配方怎么猜的: by_downstream = 看产物被下游谁要, by_icon = 按蓝图图标 */
  guess?: Record<string, number>;
  perMin: Record<string, number>; theoryPerMin: Record<string, number>; final: string[];
  /** 成品实测 ÷ 成品机器满速 */
  efficiency: number | null;
  /** 成品产量 后半段 ÷ 前半段 (< 0.9 = 在往堵的方向走) */
  trend?: number | null;
  status: Record<string, number>; powerMW: number;
  sinkPerMin: Record<string, number>; fedPerMin: Record<string, number>;
  skipped?: string; error?: string; at: string;
}

type Raw = Record<string, unknown>;
type Obj = Record<string, number> | []; // Lua 空表回来是 []

const today = () => new Date().toISOString().slice(0, 10);
const obj = (o: Obj) => (Array.isArray(o) ? {} : o);
export const FEED_BLANK = { perMin: {}, theoryPerMin: {}, final: [], efficiency: null, status: {}, powerMW: 0, sinkPerMin: {}, fedPerMin: {} };

// fatul 拆出来的 JSON 里有 "inventory": null 这类空值, 游戏导入时不认 (import_stack 返回 -1, 2026-11-02): 编码前删掉
export function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
  return v;
}

/** 把蓝图放进沙盘 (清场、按原坐标拍下、每张电网接电力接口); 场地留出蓝图中心对位的余量 (lab.md #25) */
export async function placeBlueprint(lab: LabInstance, bp: Raw, label = "") {
  const info = analyze(label, "", bp);
  const xs = info.entities.map((e) => e.position.x), ys = info.entities.map((e) => e.position.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const area = [[Math.floor(Math.min(minX, minX - cx)) - 12, Math.floor(Math.min(minY, minY - cy)) - 12], [Math.ceil(Math.max(maxX, maxX - cx)) + 12, Math.ceil(Math.max(maxY, maxY - cy)) + 12]];
  await lab.rpc("prepare_area", { area, no_enemies: true }, { timeoutMs: 600_000 });
  const first = (bp as { entities?: { name: string; position: { x: number; y: number } }[] }).entities?.[0];
  const placed = (await lab.rpc("place_blueprint", { string: encodeBlueprint({ blueprint: dropNulls(bp) as Record<string, unknown> }), position: [0, 0], reference: first ? { index: 1, name: first.name, x: first.position.x, y: first.position.y } : undefined }, { timeoutMs: 600_000 })) as { built: number; ghosts: number; failed_count: number; align_error?: string };
  if (placed.align_error) throw new Error(`没对齐: ${placed.align_error}`);
  await lab.rpc("power_networks", { area }, { timeoutMs: 600_000 });
  return { area, placed };
}

/** 喂料实测一张蓝图 (已经用 placeBlueprint 放好的场地) */
export async function feedArea(lab: LabInstance, area: unknown, bp: Raw, opts: { warmS: number; measureS: number; research?: string; log?: (s: string) => void }): Promise<FeedResult> {
  try {
    // 机械臂的取放目标要过一个 tick 才算出来: 上一张测完游戏停在"暂停 + 按需跑 tick", 新放的 167 个机械臂取放目标全是空 (2026-11-02 第一次全量只有 1 张测成)
    await lab.runTicks(2);
    // 靠相邻模块供电的拼接块 (第二层报过 16 张): 不在任何电网里的用电建筑按数据补配电站 (power_fix), 记下补了几处
    const unp = (await lab.rpc("unpowered", { area }, { timeoutMs: 600_000 })) as { x: number; y: number; network: boolean }[] | Record<string, never>;
    const off = Array.isArray(unp) ? unp.filter((u) => !u.network) : [];
    const fix = off.length ? ((await lab.rpc("power_fix", { targets: off.map((u) => ({ x: u.x, y: u.y })) }, { timeoutMs: 600_000 })) as { fixed: number }) : { fixed: 0 };
    const icons = ((bp as { icons?: { signal?: { name?: string; type?: string } }[] }).icons ?? [])
      .filter((i) => !i.signal?.type || i.signal.type === "item").map((i) => i.signal?.name).filter(Boolean);
    const plan = (await lab.rpc("feed_setup", { area, icon_items: icons, research: opts.research }, { timeoutMs: 600_000 })) as {
      feeds: { n: number }; sinks: number; wagon_taps?: number; split_starts?: number; unloaders?: number; in_chests: { n: number }; out_chests: number; crafters: number; fluid_in?: number; fluid_out?: number;
      theory: Obj; final: { n: number; items: string[] | Record<string, never> }; unsupported: Obj;
      furnace_guess: Obj; starts: { n: number; items: unknown };
    };
    opts.log?.(`卸车臂 ${plan.unloaders ?? 0}、装车臂 ${plan.wagon_taps ?? 0}; 起点 ${plan.starts.n} 个: ${JSON.stringify(plan.starts.items)}; 炉子配方: ${JSON.stringify(plan.furnace_guess)}`);
    const base = { research: opts.research ?? "none", powerFixed: off.length ? fix.fixed : 0, guess: obj(plan.furnace_guess), feeds: plan.feeds.n, sinks: plan.sinks, wagonTaps: plan.wagon_taps ?? 0, splitStarts: plan.split_starts ?? 0, unloaders: plan.unloaders ?? 0, inChests: plan.in_chests.n, outChests: plan.out_chests, crafters: plan.crafters, fluidIn: plan.fluid_in ?? 0, fluidOut: plan.fluid_out ?? 0, unsupported: obj(plan.unsupported) };
    if (plan.feeds.n + plan.in_chests.n + (plan.unloaders ?? 0) + (plan.fluid_in ?? 0) === 0) return { ...base, ...FEED_BLANK, skipped: "找不到能喂料的入口 (没有带子起点或料箱对着机器)", at: today() };
    await lab.runTicks(opts.warmS * 60);
    await lab.rpc("feed_stats", { reset: true });
    // 分两半测: 后半段 ÷ 前半段 < 0.9 说明在往堵的方向走 (出口没收走的会越积越多)
    await lab.runTicks(Math.round(opts.measureS * 30));
    const mid = (await lab.rpc("feed_stats", {}, { timeoutMs: 600_000 })) as { produced: Obj };
    await lab.runTicks(Math.round(opts.measureS * 30));
    const st = (await lab.rpc("feed_stats", {}, { timeoutMs: 600_000 })) as { ticks: number; produced: Obj; sink: Obj; fed: Obj; samples: Obj; energy_j: number };
    const min = st.ticks / 3600;
    const per = (o: Obj) => Object.fromEntries(Object.entries(obj(o)).map(([k, v]) => [k, Number((v / min).toFixed(2))]));
    const theory = obj(plan.theory);
    const final = Array.isArray(plan.final.items) ? plan.final.items : [];
    const perMin = per(st.produced);
    const tSum = final.reduce((n, k) => n + (theory[k] ?? 0), 0);
    const mSum = final.reduce((n, k) => n + (perMin[k] ?? 0), 0);
    const half1 = final.reduce((n, k) => n + (obj(mid.produced)[k] ?? 0), 0);
    const half2 = final.reduce((n, k) => n + (obj(st.produced)[k] ?? 0), 0) - half1;
    const samples = obj(st.samples);
    const sTotal = Object.values(samples).reduce((x, y) => x + y, 0) || 1;
    return {
      ...base, perMin, final,
      theoryPerMin: Object.fromEntries(Object.entries(theory).map(([k, v]) => [k, Number(v.toFixed(2))])),
      efficiency: tSum > 0 ? Number((mSum / tSum).toFixed(3)) : null,
      trend: half1 > 0 ? Number((half2 / half1).toFixed(3)) : null,
      status: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, Number((v / sTotal).toFixed(3))])),
      powerMW: Number((st.energy_j / (st.ticks / 60) / 1e6).toFixed(3)),
      sinkPerMin: per(st.sink), fedPerMin: per(st.fed), at: today(),
    };
  } finally {
    await lab.rpc("feed_clear", {}).catch(() => undefined);
    // 测完清场: 生产统计是全阵营的, 上一张留在图上会一直运转、混进下一张的产量 (第一次全量: 朋友基地留着, 后面一张效率算出 756%)
    await lab.rpc("prepare_area", { area, no_enemies: true }, { timeoutMs: 600_000 }).catch(() => undefined);
  }
}

export function describeFeed(f: FeedResult): string {
  if (f.error) return "出错 " + f.error;
  if (f.skipped) return "跳过 " + f.skipped;
  return `入口 ${f.feeds} 料箱 ${f.inChests} 出口 ${f.sinks} 收料箱 ${f.outChests} 机器 ${f.crafters}; 效率 ${f.efficiency}; 趋势 ${f.trend}; 成品 ${f.final.map((k) => `${k} ${f.perMin[k] ?? 0}/${f.theoryPerMin[k]}`).join(", ")}; 状态 ${JSON.stringify(f.status)}; ${f.powerMW}MW; 喂 ${JSON.stringify(f.fedPerMin)}; 收 ${JSON.stringify(f.sinkPerMin)}; 不支持 ${JSON.stringify(f.unsupported)}`;
}
