// 每班自动复盘 (库): 班末由 run.ts 写 review.md / review.json, 下一班开班时把"先修的三条"写进每个人笔记的最前面。
// 照 factorio-ai-party 的复盘思路 (tools/analysis/ 的 journal_gaps、sleep_share 等, idle_report.py; 每轮出摩擦表、修损失时间最多的前三),
// 用我们自己的记录重算 (他们的脚本读压缩日志、按太平洋时区算, 在我们这儿直接跑不对: 第 2 班被算成 960 分钟)。
import fs from "node:fs";
import path from "node:path";
import { ratesFrom, type Rates } from "./science.ts";
import { healthCategory } from "./health.ts";

type MonitorRow = { tick: number; machines?: number; researched?: number; labs?: number; labsWorking?: number; busyBy?: Record<string, boolean>; redTotal?: number; greenTotal?: number; blueTotal?: number };
type HealthRow = { tick?: number; lines: string[] };
type Req = { t: number; action: string; ok: boolean; agent?: string; args?: { seconds?: number } };
type DigestRow = { hauls?: { name: string; items?: number; top?: { item: string; times?: number; to_name?: string } }[] };
export type ShiftData = { monitor: MonitorRow[]; health: HealthRow[]; requests: Req[]; digest: DigestRow[]; friction: string[]; english: Record<string, string>; /** 带子 Z 字弯 (src/play/belt-lint.ts; 监工最后一次扫的) */ jogs?: { belts: number; jogs: number; free: number; list: { x: number; y: number }[] } | null };
export type Review = { lines: string[]; fixes: string[] };

/** 查询类动作 (统计 src/play/stats.ts 也用) */
export const READS = new Set(["observe", "status", "inspect", "describe", "chat", "help"]);
// 建造类动作 (扩产量化)
export const BUILDS = new Set(["build", "place_ghosts", "construct", "build_path", "belt_route", "pole_route", "blueprint_place", "blueprint_paste", "place", "upgrade"]);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const share = <T>(rows: T[], f: (r: T) => boolean) => (rows.length ? rows.filter(f).length / rows.length : 0);

/** 一班的复盘: 读数几行 + 下一班先修的 (最多 3 条, 按影响排); zh 把物品 / 建筑内部名换成官方中文名 */
export function reviewShift(d: ShiftData, prevMonitor: MonitorRow[] | null, zh: (n: string) => string = (n) => n, label: (id: string) => string = (id) => id.toUpperCase()): Review {
  const lines: string[] = [], fixes: string[] = [];
  const m = d.monitor, first = m[0], last = m.at(-1);
  const now = ratesFrom(m), prev = prevMonitor ? ratesFrom(prevMonitor) : null;
  const f1 = (v: number | null) => (v === null ? "—" : v.toFixed(1));
  const rateText = (r: Rates | null) => (r ? `红瓶 ${f1(r.red)}、绿瓶 ${f1(r.green)}、蓝瓶 ${f1(r.blue)}` : "—");
  lines.push(`科技包每分钟 (整班平均): ${rateText(now)}${prev ? `; 上一班: ${rateText(prev)}` : ""}`);
  if (first && last) lines.push(`研究: ${first.researched ?? "?"} → ${last.researched ?? "?"} 项; 游戏时间 ${((last.tick - first.tick) / 3600).toFixed(0)} 分钟`);
  const grew = first?.machines !== undefined && last?.machines !== undefined ? last.machines - first.machines : null;
  if (grew !== null) lines.push(`生产机器: 开班 ${first!.machines} → 班末 ${last!.machines} (新增 ${grew})`);
  const labsIdle = share(m.filter((r) => (r.labs ?? 0) > 0), (r) => (r.labsWorking ?? 0) * 2 < (r.labs ?? 0));
  lines.push(`研究中心一半以上停着的时间: ${pct(labsIdle)}`);
  const ids = [...new Set(m.flatMap((r) => Object.keys(r.busyBy ?? {})))].sort();
  if (ids.length) lines.push(`角色闲着的时间: ${ids.map((id) => `${label(id)} ${pct(share(m.filter((r) => r.busyBy && id in r.busyBy), (r) => r.busyBy![id] === false))}`).join("、")}`);
  const byAgent = new Map<string, Req[]>();
  for (const r of d.requests) byAgent.set(r.agent ?? "?", [...(byAgent.get(r.agent ?? "?") ?? []), r]);
  const readShare: [string, number][] = [];
  for (const [id, rs] of [...byAgent].sort()) {
    const reads = share(rs, (r) => READS.has(r.action)), builds = share(rs, (r) => BUILDS.has(r.action)), fails = rs.filter((r) => !r.ok).length;
    const sleeps = rs.filter((r) => r.action === "sleep"), asked = sleeps.reduce((s, r) => s + (r.args?.seconds ?? 0), 0);
    readShare.push([id, reads]);
    lines.push(`${label(id)}: 请求 ${rs.length} 次, 其中查询 ${pct(reads)}、建造 ${pct(builds)}、失败 ${fails} 次 (${pct(rs.length ? fails / rs.length : 0)}), 睡 ${sleeps.length} 次 (请求的时长合计 ${Math.round(asked / 60)} 分钟)${d.english[id] ? `, ${d.english[id]}` : ""}`);
  }
  const cats = new Map<string, number>();
  for (const h of d.health) for (const c of new Set(h.lines.map(healthCategory))) cats.set(c, (cats.get(c) ?? 0) + 1);
  const persistent = [...cats].map(([c, n]) => [c, d.health.length ? n / d.health.length : 0] as [string, number]).sort((a, b) => b[1] - a[1]);
  if (persistent.length) lines.push(`体检各类问题出现的比例: ${persistent.map(([c, s]) => `${c} ${pct(s)}`).join("、")}`);
  const hauls = d.digest.at(-1)?.hauls ?? [];
  for (const h of hauls) if (h.top) lines.push(`${h.name} 这一班手搬 ${h.items ?? 0} 个, 重复最多: ${zh(h.top.item)} ${h.top.times ?? 0} 次到${h.top.to_name ? zh(h.top.to_name) : "某处"}`);
  if (d.friction.length) lines.push(`摩擦 (失败到下次成功损失的时间) 前 3: ${d.friction.slice(0, 3).join(" | ")}`);
  if (d.jogs?.belts) lines.push(`带子 ${d.jogs.belts} 格, Z 字弯 ${d.jogs.jogs} 处, 其中拐弯那格前方是空地 ${d.jogs.free} 处${d.jogs.list.length ? `: ${d.jogs.list.slice(0, 5).map((j) => `(${j.x}, ${j.y})`).join("、")}` : ""}`);

  // 下一班先修 (按影响排, 最多 3 条)
  if (labsIdle >= 0.3) fixes.push(`研究中心整班有 ${pct(labsIdle)} 的时间一半以上停着 (缺瓶): 管科研的先把缺的那种瓶的线补上, 用 ./calc 倒推要几台机器、多少板子。`);
  if (grew !== null && grew <= Math.max(2, 0.05 * (first!.machines ?? 0)) && fixes.length < 3) fixes.push(`这一班只新增了 ${grew} 台生产机器, 产量上不去: 先扩产 —— ./calc 按每分钟 30 个倒推最缺那种瓶还差几台机器, 建上; 有建设机器人就整块贴蓝图让机器人建。`);
  const lower = now && prev ? (["red", "green", "blue"] as const).filter((k) => now[k] !== null && prev[k] !== null && now[k]! < prev[k]!) : [];
  if (lower.length) fixes.push(`科技包每分钟产量比上一班低 (${lower.map((k) => ({ red: "红瓶", green: "绿瓶", blue: "蓝瓶" })[k]).join("、")}): 这一班先把它们拉回来再扩。`);
  for (const [c, s] of persistent) if (s >= 0.5 && c !== "研究中心" && fixes.length < 3) fixes.push(`体检里"${c}"整班 ${pct(s)} 的时间都在报: 归负责的人, 先修掉。`);
  const top = [...hauls].filter((h) => (h.top?.times ?? 0) >= 50).sort((a, b) => (b.top!.times ?? 0) - (a.top!.times ?? 0))[0];
  if (top && fixes.length < 3) fixes.push(`${top.name} 手搬 ${zh(top.top!.item)} ${top.top!.times} 次到${top.top!.to_name ? zh(top.top!.to_name) : "某处"}: 改成传送带 + 机械臂 (燃料: 换电力设备或接煤带)。`);
  for (const [id, s] of readShare.sort((a, b) => b[1] - a[1])) if (s >= 0.6 && fixes.length < 3) fixes.push(`${label(id)} 上一班 ${pct(s)} 的请求是查询: 少查多做, 一次排好计划队列再等结果。`);
  return { lines, fixes: fixes.slice(0, 3) };
}

/** 从一班的记录目录读 (monitor / health / requests / digest .jsonl、summary.json); 缺的文件当空 */
export function loadShift(runDir: string): ShiftData {
  const rows = <T>(f: string): T[] => { try { return fs.readFileSync(path.join(runDir, f), "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as T); } catch { return []; } };
  let s: { friction?: string[]; agents?: { id: string; english?: string }[] } = {};
  try { s = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8")); } catch { /* 还没写 */ }
  let jogs: ShiftData["jogs"] = null;
  try { jogs = JSON.parse(fs.readFileSync(path.join(runDir, "belt-jogs.json"), "utf8")); } catch { /* 旧的班没有 */ }
  return { monitor: rows("monitor.jsonl"), health: rows("health.jsonl"), requests: rows("requests.jsonl"), digest: rows("digest.jsonl"), friction: s.friction ?? [], english: Object.fromEntries((s.agents ?? []).filter((a) => a.english).map((a) => [a.id, a.english!])), jogs };
}

/** review.md 的正文 */
export function reviewMarkdown(r: Review, runId: string): string {
  return `# 复盘 ${runId}\n\n${r.lines.map((l) => `- ${l}`).join("\n")}\n\n## 下一班先修\n${r.fixes.map((f, i) => `${i + 1}. ${f}`).join("\n") || "(没有)"}\n`;
}

/** 写进下一班笔记最前面的那一节 */
export function reviewNotes(fixes: string[], runId: string): string {
  return fixes.length ? `## 上一班复盘 (监工自动, ${runId}): 先修这几条\n${fixes.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\n` : "";
}
