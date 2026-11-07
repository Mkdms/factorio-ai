// 开虫子前先留一段和平 (库, 不直接运行; 依据: 没有防御的存档直接开虫子, 第 4 分钟起被啃, 8 分钟实体 1320 → 949):
// 开班时还开着和平, 从大脑开始干活起算, 到点由监工关掉并告诉全队; 没用完的时间留给下一班, 用完了这个世界以后就不再有。
// 只算真实时间, 和 --minutes 同一个钟。

export type Peace = { minutes: number; /** 什么时候到点; null = 大脑还没开始, 钟没走 */ until: number | null; warned: boolean; over: boolean };
export type EnemyFacts = { nests: number; nearest: number; x: number; y: number; turrets: number };

const MAX_MINUTES = 120;
/** 还剩多少分钟才提醒一次 */
const WARN_MS = 120_000;

export function makePeace(minutes: number): Peace {
  const m = Number.isFinite(minutes) ? Math.min(MAX_MINUTES, Math.max(0, Math.ceil(minutes))) : 0;
  return { minutes: m, until: null, warned: false, over: m === 0 };
}
/** 世界这时候该不该开着和平 (这段时间内, 包括大脑开始之前) */
export const peaceActive = (p: Peace): boolean => !p.over;
/** 大脑开始干活时开始走钟; 只走一次 */
export function beginPeace(p: Peace, now: number): void {
  if (!p.over && p.until === null) p.until = now + p.minutes * 60_000;
}
export const peaceLeftMs = (p: Peace, now: number): number => (p.over ? 0 : p.until === null ? p.minutes * 60_000 : Math.max(0, p.until - now));
/** 向上取整的分钟: 还剩 30 秒也写 1 分钟, 没用完的留给下一班时不会变 0 */
export const minutesLeft = (ms: number): number => Math.ceil(ms / 60_000);
/** 监工每次采样调一次: warn = 快到了, 提醒一次; end = 到点, 该关了 (只回一次) */
export function peaceTick(p: Peace, now: number): "warn" | "end" | null {
  if (p.over || p.until === null) return null;
  const left = p.until - now;
  if (left <= 0) { p.over = true; return "end"; }
  if (!p.warned && left <= WARN_MS && p.minutes * 60_000 > WARN_MS) { p.warned = true; return "warn"; }
  return null;
}
/** 告诉全队的话: 只讲世界变了什么和现在的读数, 怎么应对它们自己定 */
export function peaceText(kind: "warn" | "end", leftMs: number, e?: EnemyFacts | null): string {
  const facts = e ? ` 现在炮塔 ${e.turrets} 座, 虫巢 ${e.nests} 个${e.nests ? `, 最近 ${e.nearest} 格 (${e.x},${e.y})` : ""}。` : "";
  return kind === "end" ? `和平模式刚关了, 虫子从现在起会按污染来打。${facts}` : `和平模式还有 ${minutesLeft(leftMs)} 分钟自动关, 之后虫子会按污染来打。${facts}`;
}
