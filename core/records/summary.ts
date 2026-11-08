// 班末总结和复盘 (库, 不直接运行; online.ts 收工时写 summary.json + review.md): 这班做了什么、用了多少、失败在哪、监工催了几次, 下一班先修什么 (最多 3 条, 按影响排)。
// 数据来源: 角色目录的 journal.jsonl (每条请求和回复)、记录目录的 turn-N.jsonl (每轮的 result 行: 回合数、用量、估价)、monitor.jsonl (监工采样)、health.jsonl。
import fs from "node:fs";
import path from "node:path";
import { ratesFrom, type Rates } from "../run/science.ts";

export type JournalStats = { requests: number; byAction: Record<string, number>; failures: { count: number; byReason: Record<string, number> }; built: Record<string, number>; lessonsShown: number; says: number; sleepSeconds: number; helps: number };
const firstLine = (s: string) => s.split("\n")[0].replace(/\(.*$/, "").trim();

/** journal.jsonl 的行 → 统计 */
export function journalStats(lines: string[]): JournalStats {
  const st: JournalStats = { requests: 0, byAction: {}, failures: { count: 0, byReason: {} }, built: {}, lessonsShown: 0, says: 0, sleepSeconds: 0, helps: 0 };
  for (const line of lines) {
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.event === "help") { st.helps++; continue; }
    if (o.event === "request") {
      const a = String(o.request?.action ?? "?");
      st.requests++; st.byAction[a] = (st.byAction[a] ?? 0) + 1;
      if (a === "say") st.says++;
      if (a === "sleep") st.sleepSeconds += Number(o.request?.args?.seconds) || 0;
      continue;
    }
    if (o.event === "response") {
      const r = o.response ?? {};
      if (r.ok === false) { st.failures.count++; const why = firstLine(String(r.error?.message ?? r.error?.code ?? "?")).slice(0, 80); st.failures.byReason[why] = (st.failures.byReason[why] ?? 0) + 1; }
      const e = r.result?.entity?.name; if (typeof e === "string") st.built[e] = (st.built[e] ?? 0) + 1;
      if (Array.isArray(r.result?.lessons)) st.lessonsShown += r.result.lessons.length;
    }
  }
  return st;
}

export type TurnStats = { rounds: number; turns: number; seconds: number; costUsd: number; inputTokens: number; cacheRead: number; cacheWrite: number; outputTokens: number; errors: number };
/** turn-N.jsonl 各文件的行 → 用量 (每轮最后一条 result) */
export function turnStats(files: string[][]): TurnStats {
  const t: TurnStats = { rounds: 0, turns: 0, seconds: 0, costUsd: 0, inputTokens: 0, cacheRead: 0, cacheWrite: 0, outputTokens: 0, errors: 0 };
  for (const lines of files) {
    const res = lines.filter((l) => l.includes('"type":"result"')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).at(-1);
    if (!res) continue;
    t.rounds++;
    t.turns += Number(res.num_turns) || 0; t.seconds += (Number(res.duration_ms) || 0) / 1000; t.costUsd += Number(res.total_cost_usd) || 0;
    const u = res.usage ?? {};
    t.inputTokens += Number(u.input_tokens) || 0; t.cacheRead += Number(u.cache_read_input_tokens) || 0; t.cacheWrite += Number(u.cache_creation_input_tokens) || 0; t.outputTokens += Number(u.output_tokens) || 0;
    if (res.is_error || res.subtype !== "success") t.errors++;
  }
  t.seconds = Math.round(t.seconds); t.costUsd = Math.round(t.costUsd * 1000) / 1000;
  return t;
}

export type MonitorRow = { t: number; tick: number; redTotal?: number; greenTotal?: number; blueTotal?: number; labs?: number; labsWorking?: number; research?: string; researched?: number; entities?: number; machines?: number; idle?: boolean };
export type ShiftData = { runId: string; brain: string; model: string; minutes: number; why: string; journal: JournalStats; turns: TurnStats; monitor: MonitorRow[]; health: { lines: string[] }[]; supervisor: Record<string, number>; lessons: { shown: number; distinct: number; collected: number } | null; prevRates?: Rates | null };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const f1 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(1));

/** 复盘: 读数几行 + 下一班先修 (最多 3 条) */
export function reviewShift(d: ShiftData, zh: (n: string) => string = (n) => n): { lines: string[]; fixes: string[] } {
  const lines: string[] = [], fixes: string[] = [];
  const m = d.monitor, first = m[0], last = m.at(-1);
  const rates = ratesFrom(m, 1);
  lines.push(`大脑 ${d.brain} ${d.model}: ${d.turns.rounds} 轮 ${d.turns.turns} 回合 ${Math.round(d.turns.seconds / 60)} 分钟, 估价 $${d.turns.costUsd.toFixed(2)} (输入 ${d.turns.inputTokens} + 缓存读 ${d.turns.cacheRead} + 输出 ${d.turns.outputTokens} token)${d.turns.errors ? `, ${d.turns.errors} 轮出错` : ""}; 收工: ${d.why}`);
  if (rates) lines.push(`科技包每分钟 (整班平均): 红瓶 ${f1(rates.red)}、绿瓶 ${f1(rates.green)}、蓝瓶 ${f1(rates.blue)}${d.prevRates ? `; 上一班: 红瓶 ${f1(d.prevRates.red)}、绿瓶 ${f1(d.prevRates.green)}、蓝瓶 ${f1(d.prevRates.blue)}` : ""}`);
  if (first && last) lines.push(`研究 ${first.researched ?? 0} → ${last.researched ?? 0} 项; 研究中心 ${last.labs ?? 0} 台 (${last.labsWorking ?? 0} 在工作); 生产机器 ${first.machines ?? 0} → ${last.machines ?? 0} 台; 我方建筑 ${last.entities ?? 0} 件; 游戏时间 ${(((last.tick ?? 0) - (first.tick ?? 0)) / 3600).toFixed(0)} 分钟`);
  const idleShare = m.length ? m.filter((r) => r.idle).length / m.length : 0;
  if (m.length) lines.push(`角色闲着的时间: ${pct(idleShare)} (监工催了 ${d.supervisor.nudges ?? 0} 次)`);
  const j = d.journal;
  const top = Object.entries(j.byAction).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join("、");
  const failShare = j.requests ? j.failures.count / j.requests : 0;
  const topFail = Object.entries(j.failures.byReason).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v}× ${k}`).join("; ");
  lines.push(`请求 ${j.requests} 次 (${top}); 失败 ${j.failures.count} 次 (${pct(failShare)})${topFail ? `: ${topFail}` : ""}; 查手册 ${j.helps} 次; 说话 ${j.says} 次; sleep 合计 ${Math.round(j.sleepSeconds / 60)} 分钟`);
  const built = Object.entries(j.built).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${zh(k)} ${v}`).join("、");
  lines.push(`放下的建筑: ${built || "无"}`);
  if (d.lessons) lines.push(`经验: 回复里带出 ${d.lessons.shown} 次 (${d.lessons.distinct} 条), 笔记收进待核区 ${d.lessons.collected} 条`);
  const cats = new Map<string, number>();
  for (const h of d.health) for (const c of new Set(h.lines.map((l) => l.split(/[\s:：(（]/)[0]))) cats.set(c, (cats.get(c) ?? 0) + 1);
  const persistent = [...cats].map(([c, n]) => [c, d.health.length ? n / d.health.length : 0] as [string, number]).sort((a, b) => b[1] - a[1]);
  if (persistent.length) lines.push(`体检各类问题出现的比例: ${persistent.map(([c, s]) => `${c} ${pct(s)}`).join("、")}`);
  if (d.supervisor.toolRequests) lines.push(`模型提的工具诉求 ${d.supervisor.toolRequests} 条 (tool-requests.md)`);

  // 下一班先修
  if (last && !(last.labs ?? 0) && (last.researched ?? 0) < 5) fixes.push("没有研究中心、研究没开始: 先把研究中心 + 红瓶线建起来 (硬指标是科技包产量)。");
  if (rates && d.prevRates) {
    const lower = (["red", "green", "blue"] as const).filter((k) => rates[k] !== null && d.prevRates![k] !== null && rates[k]! < d.prevRates![k]!);
    if (lower.length) fixes.push(`科技包每分钟产量比上一班低 (${lower.map((k) => ({ red: "红瓶", green: "绿瓶", blue: "蓝瓶" })[k]).join("、")}): 先拉回来再扩。`);
  }
  if (idleShare >= 0.3 && fixes.length < 3) fixes.push(`角色闲着的时间 ${pct(idleShare)}: 想事情前先把能一口气做的动作发出去; 睡觉不算玩。`);
  if (failShare >= 0.15 && fixes.length < 3) fixes.push(`失败 ${pct(failShare)}, 最多的是 ${Object.entries(j.failures.byReason).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?"}: 动手前先 ./fh help 动作 和 inspect 看清楚, 同一个错别连试。`);
  for (const [c, s] of persistent) if (s >= 0.5 && fixes.length < 3) fixes.push(`体检里"${c}"整班 ${pct(s)} 的时间都在报: 先修掉。`);
  return { lines, fixes: fixes.slice(0, 3) };
}

export function reviewMarkdown(r: { lines: string[]; fixes: string[] }, runId: string): string {
  return `# 复盘 ${runId}\n\n${r.lines.map((l) => `- ${l}`).join("\n")}\n\n## 下一班先修\n${r.fixes.map((f, i) => `${i + 1}. ${f}`).join("\n") || "(没有)"}\n`;
}

const rows = <T>(f: string): T[] => { try { return fs.readFileSync(f, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as T); } catch { return []; } };

/** 收工时: 读记录目录和角色目录, 写 summary.json + review.md; 回复盘 */
export function writeSummary(o: { runDir: string; dir: string; runId: string; brain: string; model: string; minutes: number; why: string; supervisor: Record<string, number>; lessons: ShiftData["lessons"]; prevRates?: Rates | null; zh?: (n: string) => string }): { lines: string[]; fixes: string[] } {
  let journalLines: string[] = [];
  try { journalLines = fs.readFileSync(path.join(o.dir, "journal.jsonl"), "utf8").split(/\r?\n/).filter(Boolean); } catch { /* 没有 */ }
  const turnFiles = fs.existsSync(o.runDir) ? fs.readdirSync(o.runDir).filter((f) => /^turn-\d+\.jsonl$/.test(f)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0])).map((f) => fs.readFileSync(path.join(o.runDir, f), "utf8").split(/\r?\n/)) : [];
  const data: ShiftData = { runId: o.runId, brain: o.brain, model: o.model, minutes: o.minutes, why: o.why, journal: journalStats(journalLines), turns: turnStats(turnFiles), monitor: rows<MonitorRow>(path.join(o.runDir, "monitor.jsonl")), health: rows<{ lines: string[] }>(path.join(o.runDir, "health.jsonl")), supervisor: o.supervisor, lessons: o.lessons, prevRates: o.prevRates ?? null };
  const r = reviewShift(data, o.zh);
  const { monitor: _m, health: _h, ...rest } = data; void _m; void _h;
  fs.writeFileSync(path.join(o.runDir, "summary.json"), JSON.stringify({ ...rest, samples: data.monitor.length, review: r, endedAt: new Date().toISOString(), ...guiFields(data) }, null, 1));
  fs.writeFileSync(path.join(o.runDir, "review.md"), reviewMarkdown(r, o.runId));
  // 界面的群公告"上一班复盘先修这几条"读 review.json (src/play/control-lib.ts reviewFor)
  fs.writeFileSync(path.join(o.runDir, "review.json"), JSON.stringify(r, null, 1));
  return r;
}

/**
 * 界面的统计卡 (src/play/stats.ts shiftStats) 认的字段: 第二版 run.ts 的总结格式。不写这些, 不装模组那条路的班在统计里一班都不算 (realMinutes 0 被当成刚开就中断的)。
 * realMinutes = 监工采样的首尾真实时间; perMin10Total = 最后 10 游戏分钟的每分钟产量; fpCalls = ./fh 请求数; agents 只有一个角色 a
 */
export function guiFields(d: Pick<ShiftData, "brain" | "model" | "journal" | "turns" | "monitor" | "minutes">) {
  const m = d.monitor, first = m[0], last = m.at(-1);
  const realMinutes = first && last && last.t > first.t ? Math.round(((last.t - first.t) / 60000) * 10) / 10 : d.minutes;
  const tail = last ? m.filter((x) => x.tick >= last.tick - 36000) : [];
  const per10 = ratesFrom(tail, 1);
  const two = (x: number | null) => (x === null ? undefined : Math.round(x * 100) / 100);
  return {
    realMinutes,
    gameMinutes: last ? Math.round((last.tick / 3600) * 10) / 10 : null,
    idleShare: m.length ? Math.round((m.filter((x) => x.idle).length / m.length) * 100) / 100 : null,
    fpCalls: d.journal.requests,
    ...(per10 ? { perMin10Total: { red: two(per10.red), green: two(per10.green), blue: two(per10.blue) } } : {}),
    usage: { costUsd: d.turns.costUsd },
    agents: [{ id: "a", turns: d.turns.turns, brain: d.brain, model: d.model, costUsd: d.turns.costUsd }],
  };
}
