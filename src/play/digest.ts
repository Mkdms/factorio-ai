// 按负责人发的工厂摘要 (库; 监工每 10 分钟用)。搬自 factorio-ai-party tools/factory_digest.py (owners / current / moved / delta,
// MIT, 见 NOTICE) 和 tools/stream/hauling.py (shift_rows / haul_line)。数据是分支版模组的操作员读数: factory_digest (缓存的工厂普查)、
// board (公告板认领)、hauling (手搬记录)。 —— 以前体检每次把整张清单发给所有人,
// 现在只发和上次比新出现 / 变化明显 / 已解决的, 发给负责那片的人。
// 和派对不同: 中文; 公告板没有认领时按分工发 (第十三轮接续第 3 班两人一个认领都没登记); 缺料、堵满也带前 3 个坐标;
// 出口堵满照派对一律算阻塞 (只发变化来控制噪音), 同一星球同时有机器缺料时加一句"料没送到"。

export type Pos = { x: number; y: number };
export type Machine = { type?: string; total?: number; counts?: Record<string, number>; positions?: Record<string, Pos[]> };
export type Surface = { surface: string; machines?: Record<string, Machine> | null; fuel?: Record<string, { type?: string; total?: number; empty?: number; low?: number }> | null };
export type Report = { tick?: number; surfaces?: Surface[] };
export type Claim = { owner?: string; surface?: string; status?: string; area?: { left_top?: Pos; right_bottom?: Pos }; covers?: { name?: string }[] };
export type Fact = { value: number; to: string[]; text: string };
export type Row = { to: string; text: string };

const INPUT = ["item_ingredient_shortage", "fluid_ingredient_shortage", "no_input_fluid", "low_input_fluid", "no_ingredients"];
const DRY = ["no_minable_resources", "no_resources"];
const LAB_ZH: Record<string, string> = { missing_science_packs: "缺科技包", no_research_in_progress: "没在研究", no_power: "没电", low_power: "电不够" };
export const at = (p: Pos) => `(${+p.x.toFixed(1)},${+p.y.toFixed(1)})`;
const sum = (c: Record<string, number>, keys: string[]) => keys.reduce((n, k) => n + (c[k] ?? 0), 0);
/** Lua 空表回到 JSON 是 {} 不是 [] */
export const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []) as T[];

export function inside(p: Pos, a?: Claim["area"]): boolean {
  const lt = a?.left_top, rb = a?.right_bottom;
  return !!lt && !!rb && lt.x <= p.x && p.x <= rb.x && lt.y <= p.y && p.y <= rb.y;
}
const claimNames = (c: Claim) => [c.owner!, ...list<{ name?: string }>(c.covers).map((x) => x?.name).filter((n): n is string => !!n)];

/** 发给谁: 坐标落在谁的认领里 → 那几个人 (含帮忙看着的); 这个星球上有认领但都不含 → 所有认领人; 没有认领 → 分工后备 */
export function owners(surface: string, positions: Pos[], claims: Claim[], fallback: string[]): string[] {
  const on = claims.filter((c) => c.owner && c.surface === surface && ["open", "claimed", "doing"].includes(c.status ?? ""));
  const hit = [...new Set(on.flatMap((c) => (positions.some((p) => inside(p, c.area)) ? claimNames(c) : [])))].sort();
  if (hit.length) return hit;
  if (on.length) return [...new Set(on.flatMap(claimNames))].sort();
  return fallback;
}

/**
 * 这一次要比的事实 {键: {数量, 发给谁, 说法}}: 每个星球的采空采矿机、缺料、出口堵满 (同时有缺料才算)、没燃料、研究中心停着。
 * roleOf(机器类型) = 没有认领时发给谁 (冶炼 / 采矿 / 锅炉 → 基地负责人, 组装机 / 研究中心 → 科研负责人)
 */
export function currentFacts(report: Report, claims: Claim[], roleOf: (type: string) => string[], zh: (n: string) => string = (n) => n): Record<string, Fact> {
  const out: Record<string, Fact> = {};
  for (const s of list<Surface>(report.surfaces)) {
    const name = s.surface, machines = s.machines;
    if (!machines || typeof machines !== "object") continue;
    const full: [string, Fact][] = [];
    let anyShort = false;
    for (const [proto, m] of Object.entries(machines).sort(([a], [b]) => a.localeCompare(b))) {
      const c = m.counts ?? {}, type = m.type ?? proto, pos = m.positions ?? {};
      const pick = (keys: string[]) => keys.flatMap((k) => list<Pos>(pos[k])).sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 3);
      const fact = (n: number, keys: string[], what: string): Fact => {
        const shown = pick(keys);
        return { value: n, to: owners(name, shown, claims, roleOf(type)), text: `${zh(proto)} ${what} ${n} 台${shown.length ? ` 在 ${shown.map(at).join("、")}` : ""}` };
      };
      if (type === "mining-drill") { const n = sum(c, DRY); if (n) out[`dry|${name}|${proto}`] = fact(n, DRY, "采空"); }
      const short = sum(c, INPUT);
      if (short) { anyShort = true; out[`short|${name}|${proto}`] = fact(short, INPUT, "缺料"); }
      if (c.full_output) full.push([`full|${name}|${proto}`, fact(c.full_output, ["full_output"], "出口堵满")]);
      if (type === "lab") {
        const stopped = Object.entries(c).filter(([st]) => st !== "working" && st !== "unknown");
        const n = stopped.reduce((x, [, v]) => x + v, 0);
        if (n) out[`labs|${name}`] = { value: n, to: owners(name, [], claims, roleOf("lab")), text: `研究中心停着 ${n} 台 (${stopped.map(([st, v]) => `${LAB_ZH[st] ?? st} ${v}`).join("、")})` };
      }
    }
    for (const [k, f] of full) out[k] = anyShort ? { ...f, text: `${f.text} (同时有机器缺料: 料没送到)` } : f;
    for (const [proto, f] of Object.entries(s.fuel ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const n = (f.empty ?? 0) + (f.low ?? 0);
      if (n && ["boiler", "furnace", "mining-drill"].includes(f.type ?? "")) out[`fuel|${name}|${proto}`] = { value: n, to: owners(name, [], claims, roleOf(f.type ?? proto)), text: `${zh(proto)} 没燃料 ${f.empty ?? 0} 台、只剩最后一点燃料 ${f.low ?? 0} 台` };
    }
  }
  return out;
}

/**
 * 普查缓存过期时的后备: 用我们自己每 5 分钟的体检 (src/play/health.ts) 算同样几类事实。模组的普查是大脑查状态时顺带做的,
 * 大脑一阵子不查就过期 (survey.lua KEEP_TICKS; 11-03 第 3 班: 第 23 分钟还有, 第 35 分钟就空了); 监工不能替它查 (会重置大脑的计时)。
 * 体检里缺燃料 / 采空带坐标, 缺料 / 堵满只有台数 (键是配方或炉子名)。
 */
export type HealthLike = { noFuel?: string[]; depleted?: string[]; labs?: { total: number; working: number; missingPacks: number }; full?: Record<string, number>; short?: Record<string, number> };
export function factsFromHealth(h: HealthLike, claims: Claim[], roleOf: (type: string) => string[], zh: (n: string) => string = (n) => n, surface = "nauvis"): Record<string, Fact> {
  const out: Record<string, Fact> = {};
  const pos = (s: string): Pos | null => { const m = s.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/); return m ? { x: +m[1], y: +m[2] } : null; };
  const typeOf = (name: string) => (/furnace|炉/.test(name) ? "furnace" : // 体检把炉子合成一项, 键就叫"炉子"
 /boiler/.test(name) ? "boiler" : /drill/.test(name) ? "mining-drill" : "assembling-machine");
  const where = (ps: Pos[]) => (ps.length ? ` 在 ${ps.slice(0, 3).map(at).join("、")}` : "");
  const dep = list<string>(h.depleted).map(pos).filter((p): p is Pos => !!p);
  if (dep.length) out[`dry|${surface}|mining-drill`] = { value: dep.length, to: owners(surface, dep.slice(0, 3), claims, roleOf("mining-drill")), text: `采矿机 采空 ${dep.length} 台${where(dep)}` };
  const fuel = new Map<string, Pos[]>();
  for (const s of list<string>(h.noFuel)) { const name = s.replace(/\(.*$/, ""), p = pos(s); fuel.set(name, [...(fuel.get(name) ?? []), ...(p ? [p] : [])]); }
  for (const [name, ps] of fuel) out[`fuel|${surface}|${name}`] = { value: Math.max(ps.length, 1), to: owners(surface, ps.slice(0, 3), claims, roleOf(typeOf(name))), text: `${zh(name)} 没燃料 ${Math.max(ps.length, 1)} 台${where(ps)}` };
  const short = Object.entries(h.short ?? {}).filter(([, n]) => n > 0);
  for (const [name, n] of short) out[`short|${surface}|${name}`] = { value: n, to: owners(surface, [], claims, roleOf(typeOf(name))), text: `${zh(name)} 缺料 ${n} 台` };
  for (const [name, n] of Object.entries(h.full ?? {})) if (n > 0) out[`full|${surface}|${name}`] = { value: n, to: owners(surface, [], claims, roleOf(typeOf(name))), text: `${zh(name)} 出口堵满 ${n} 台${short.length ? " (同时有机器缺料: 料没送到)" : ""}` };
  const l = h.labs;
  if (l && l.total && l.working < l.total) out[`labs|${surface}`] = { value: l.total - l.working, to: owners(surface, [], claims, roleOf("lab")), text: `研究中心停着 ${l.total - l.working} 台 (缺科技包 ${l.missingPacks})` };
  return out;
}

/** 数量变得值得说: 新出现、清零, 或变了至少 2 且至少五分之一 */
export function moved(was: number | undefined, now: number): boolean {
  if (was === undefined || now === 0 || was === 0) return was !== now;
  return Math.abs(now - was) >= Math.max(2, 0.2 * was);
}

/** 和上次比: 新出现或变化明显的 (带上次的数), 已解决的 (发给当时收到的人) */
export function delta(prev: Record<string, Fact> | null, cur: Record<string, Fact>): Row[] {
  const rows: Row[] = [];
  for (const [k, f] of Object.entries(cur)) {
    const p = prev?.[k];
    if (!p || moved(p.value, f.value)) for (const to of f.to) rows.push({ to, text: f.text + (p ? ` (上次 ${p.value})` : "") });
  }
  for (const [k, p] of Object.entries(prev ?? {})) if (!(k in cur)) for (const to of p.to) rows.push({ to, text: `已解决: ${p.text}` });
  return rows;
}

export type Haul = { item: string; surface?: string; from?: Pos; to?: Pos; to_name?: string; times?: number; items?: number };
export type HaulAgent = { name: string; items?: number; calls?: number; hauls?: Haul[] };
const haulKey = (h: Haul) => `${h.item}|${h.surface ?? ""}|${h.from ? at(h.from) : ""}|${h.to ? at(h.to) : ""}`;

/** 这一班 (开班时的读数到现在) 每人的手搬: 次数多的在前; 读数变小 (换了存档) 从零算 */
export function shiftHauls(first: HaulAgent[], now: HaulAgent[]): HaulAgent[] {
  const base = new Map(first.map((a) => [a.name, a]));
  return now.map((a) => {
    let b = base.get(a.name);
    if ((a.items ?? 0) < (b?.items ?? 0)) b = undefined;
    const before = new Map(list<Haul>(b?.hauls).map((h) => [haulKey(h), h]));
    const hauls = list<Haul>(a.hauls).map((h) => ({ ...h, times: (h.times ?? 0) - (before.get(haulKey(h))?.times ?? 0), items: (h.items ?? 0) - (before.get(haulKey(h))?.items ?? 0) })).filter((h) => h.times > 0).sort((x, y) => y.times - x.times);
    return { name: a.name, items: (a.items ?? 0) - (b?.items ?? 0), calls: (a.calls ?? 0) - (b?.calls ?? 0), hauls };
  }).sort((x, y) => (y.items ?? 0) - (x.items ?? 0));
}

/** 一句话: 这一班重复最多的手搬 (至少 2 次), 再列两条; 没有就 null */
export function haulLine(row: HaulAgent | undefined, zh: (n: string) => string = (n) => n): string | null {
  const hauls = list<Haul>(row?.hauls), top = hauls[0];
  if (!top || (top.times ?? 0) < 2) return null;
  const one = (h: Haul) => `${zh(h.item)} 到${h.to_name ? zh(h.to_name) : "某处"} ${h.to ? at(h.to) : ""} ${h.times} 次`;
  const rest = hauls.slice(1, 3).filter((h) => (h.times ?? 0) > 1).map(one);
  return `你这一班重复最多的手搬: ${zh(top.item)} ${top.times} 次 (${top.items ?? 0} 个), 从 ${top.from ? at(top.from) : "背包"} 到${top.to_name ? zh(top.to_name) : "某处"} ${top.to ? at(top.to) : ""}${rest.length ? `; 其次: ${rest.join("、")}` : ""}。重复的搬运改成传送带 + 机械臂 (燃料: 换电力设备或接煤带), 不要靠常驻命令一直手搬。`;
}

/** 每个人这一次的摘要正文 (tellAgent 自己按 480 字节分段); 没有归他的变化也没有手搬就 null */
export function digestText(me: string, rows: Row[], haul: string | null, head: string): string | null {
  const mine = [...new Set(rows.filter((r) => r.to === me || r.to === "team").map((r) => r.text))];
  if (!mine.length && !haul) return null;
  return `${head}${mine.length ? `\n归你管的变化: ${mine.join("; ")}` : "\n归你管的没有新变化。"}${haul ? `\n${haul}` : ""}`;
}
