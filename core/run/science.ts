// 科研读数的说法 (库, 不直接运行; 监工和班末总结用): 研究中心停了缺哪种瓶、一段时间的每分钟产量、和上一班比。
export function labLine(research: string, need: string[], have: Record<string, number>, zh: (n: string) => string = (n) => n): string {
  if (!research) return "现在没有在研究的科技 (研究队列空了, 先排上)。";
  const missing = need.filter((n) => !((have[n] ?? 0) > 0));
  return `当前研究 ${zh(research)} 要 ${need.map(zh).join(" + ")}; 研究中心里: ${need.map((n) => `${zh(n)} ${have[n] ?? 0} 个`).join("、")}${missing.length ? `, 缺 ${missing.map(zh).join("、")}` : ""}。`;
}

export type Rates = { red: number | null; green: number | null; blue: number | null };
export type RateRow = { tick: number; redTotal?: number; greenTotal?: number; blueTotal?: number };

/** 一段采样 (monitor.jsonl 的行) 的平均每分钟产量; 不到 minMinutes 游戏分钟或没有这个读数的给 null */
export function ratesFrom(rows: RateRow[], minMinutes = 5): Rates | null {
  const a = rows[0], b = rows.at(-1);
  if (!a || !b) return null;
  const m = (b.tick - a.tick) / 3600;
  if (m < minMinutes) return null;
  const r = (k: "redTotal" | "greenTotal" | "blueTotal") => (typeof a[k] === "number" && typeof b[k] === "number" ? (b[k]! - a[k]!) / m : null);
  return { red: r("redTotal"), green: r("greenTotal"), blue: r("blueTotal") };
}

const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(1));
/** "近 10 分钟每分钟: 红瓶 x、绿瓶 y、蓝瓶 z; 上一班平均: …" */
export function ratesLine(now: Rates, prev: Rates | null, span = "近 10 分钟"): string {
  const one = (r: Rates) => `红瓶 ${fmt(r.red)}、绿瓶 ${fmt(r.green)}、蓝瓶 ${fmt(r.blue)}`;
  const lower = prev ? (["red", "green", "blue"] as const).filter((k) => now[k] !== null && prev[k] !== null && now[k]! < prev[k]!) : [];
  const zhk = { red: "红瓶", green: "绿瓶", blue: "蓝瓶" };
  return `${span}科技包每分钟: ${one(now)}${prev ? `; 上一班平均: ${one(prev)}${lower.length ? ` (${lower.map((k) => zhk[k]).join("、")}比上一班低, 没达到硬指标)` : ""}` : ""}`;
}
