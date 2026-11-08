// 交接 (库): 新一班的 notes.md 顶上放"上一班实测" —— 从上一班角色自己的 journal 数出来的事实 (动手几次、站着多久、什么都没搬动的、失败最多的),
// 然后是上一班的笔记 (超过 16000 字就截: 日志先只留最近 10 行, 再从不是"现在 / 认领 / 约定 / 答应 / 看板 / 下一步"的节、文件里靠前的先截; 全文进 notes-archive.md)。
// 照 factorio-ai-party (MIT) tools/handover.py 的 carry 改写成 TypeScript (NOTICE 署名; 那边的理由: 例行做法没人量就一直留着, 笔记长到 134 KB 每班整个读),
// 两条路共用: 装模组那条路 src/play/run.ts、不装模组那条路 core/run/online.ts (原来调派对仓库的 handover.py, 重构后不下载别人的项目, 每班静默失败)。
// 只给事实, 不给建议。输出中文; 认上一班笔记里中文 / 英文两种节标题。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { ROOT } from "../../game/sandbox/paths.ts";

export const NOTES_MAX = 16000;
export const MEASURED = "## 上一班实测";
const MEASURED_OLD = "## Last shift, measured"; // 第二版接过来的笔记里是派对的英文标题
const READS = new Set(["status", "observe", "inspect", "chat", "tells", "board", "board_plan", "board_events", "recipes", "technologies", "describe", "placements", "inventory", "queue_status", "profiles", "clock", "research_done", "defense", "scan", "map", "nearest", "craftable", "power", "grid", "rates", "bottleneck", "stock", "platforms", "blueprint_list", "blueprint_export", "screenshot", "where_is", "research_options", "labs", "flamers", "sleep_check", "votes", "players", "cameras"]);
const WAITS = new Set(["sleep", "wait_ticks", "wait_until"]);
const TALK = new Set(["say", "tell", "board_post", "board_update", "board_plan", "confess", "operator", "profile", "harness_request", "vote", "chat_ack"]);
const MOD = path.join(ROOT, "game", "mod", "factorio-ai-harness");

let kinds: { reads: Set<string>; talk: Set<string> } | null = null;
/** 模组自己算作读 / 说话的动作 (runtime.lua 的 reads 表, board / players / votes / owed 的 handlers); 读不到就是空的 */
function runtimeKinds() {
  if (kinds) return kinds;
  const reads = new Set<string>(), talk = new Set<string>();
  try {
    const src = fs.readFileSync(path.join(MOD, "runtime.lua"), "utf8");
    const m = /^local reads=\{([^}]*)\}/m.exec(src);
    if (m) for (const x of m[1].matchAll(/([A-Za-z_]+)=true/g)) reads.add(x[1]);
    for (const x of src.matchAll(/^reads\.([A-Za-z_]+)=true/gm)) reads.add(x[1]);
    for (const mod of ["board", "players", "votes", "owed"]) {
      const text = fs.readFileSync(path.join(MOD, `${mod}.lua`), "utf8");
      for (const x of text.matchAll(/handlers\.([a-z_]+) ?=|function M\.handlers\.([a-z_]+)/g)) talk.add(x[1] ?? x[2]);
    }
  } catch { /* 读不到模组源码: 只用上面的表 */ }
  kinds = { reads, talk };
  return kinds;
}

const normError = (msg: unknown) => String(msg ?? "").replace(/-?\d+(\.\d+)?/g, "N").slice(0, 70);

export type JournalStats = {
  actions: number; reads: number; talk: number; waits: number; waitS: number; idleS: number; spanS: number;
  byAction: Map<string, number>; noop: Map<string, number>; errors: [string, number][]; first: number | null; last: number | null;
  gap: [number, number | null, number | null]; queueJobs: number | null;
};

/** journal.jsonl (或 .gz) → 上一班做了什么: since = 只算这个时间 (毫秒) 之后的请求 */
export function journalStats(file: string, since?: number, maxBytes = 60_000_000): JournalStats | null {
  let text: string;
  try {
    if (!fs.existsSync(file) && fs.existsSync(`${file}.gz`)) text = zlib.gunzipSync(fs.readFileSync(`${file}.gz`)).toString("utf8");
    else {
      const size = fs.statSync(file).size;
      if (size > maxBytes) { const fd = fs.openSync(file, "r"); const buf = Buffer.alloc(maxBytes); fs.readSync(fd, buf, 0, maxBytes, size - maxBytes); fs.closeSync(fd); text = buf.toString("utf8"); text = text.slice(text.indexOf("\n") + 1); }
      else text = fs.readFileSync(file, "utf8");
    }
  } catch { return null; }
  const reqs = new Map<string, { a: string; gap: number }>();
  const errors = new Map<string, number>();
  const out: JournalStats = { actions: 0, reads: 0, talk: 0, waits: 0, waitS: 0, idleS: 0, spanS: 0, byAction: new Map(), noop: new Map(), errors: [], first: null, last: null, gap: [0, null, null], queueJobs: null };
  const jobs: number[] = [];
  let lastAction: number | null = null;
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const rk = runtimeKinds();
  for (const line of text.split(/\r?\n/)) {
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    const t = typeof r.at === "string" ? Date.parse(r.at) / 1000 : NaN;
    const tt = Number.isFinite(t) ? t : null;
    if (since && (tt === null || tt * 1000 < since)) continue;
    if (r.event === "request") {
      const q = r.request ?? {}, a = String(q.action ?? "");
      // 和上一个请求之间的空当: 回复里的 "character idle Ns" 最多算这么长 (并行和长请求会把同一段算两遍)
      const gap = tt !== null && out.last !== null ? Math.max(0, tt - out.last) : 0;
      reqs.set(String(q.id), { a, gap });
      out.first ??= tt; out.last = tt;
      if (WAITS.has(a)) { out.waits++; const g = q.args ?? {}; out.waitS += Number(g.seconds) || Number(g.ticks) / 60 || 0; }
      else if (TALK.has(a) || rk.talk.has(a) || a.startsWith("reminder_")) out.talk++;
      else if (READS.has(a) || rk.reads.has(a) || a.startsWith("queue_")) out.reads++;
      else {
        out.actions++; inc(out.byAction, a);
        const start = lastAction ?? out.first;
        if (tt !== null && start !== null && tt - start > out.gap[0]) out.gap = [tt - start, start, tt];
        lastAction = tt;
      }
    } else if (r.event === "response") {
      const p = r.response ?? {};
      const q = reqs.get(String(p.id)) ?? { a: "", gap: 0 };
      reqs.delete(String(p.id));
      const res = p.result && typeof p.result === "object" ? p.result : {};
      const m = /character idle (\d+)s of it/.exec(String(res.clock ?? ""));
      if (m) out.idleS += Math.min(Number(m[1]), q.gap);
      if (!p.ok) inc(errors, `${q.a}: ${normError(p.error?.message)}`);
      else if (["transfer", "feed", "collect"].includes(q.a) && (res.transferred === 0 || (!("transferred" in res) && res.moved === 0 && !res.timed))) inc(out.noop, q.a);
      if (["queue_status", "queue_submit", "queue_repeat", "queue_edit"].includes(q.a)) {
        const ids = [...JSON.stringify(res.pending ?? []).matchAll(/"id": ?"job-(\d+)"/g)].map((x) => Number(x[1]));
        if (ids.length) jobs.push(Math.min(...ids));
      }
    }
  }
  out.spanS = out.first !== null && out.last !== null ? out.last - out.first : 0;
  const start = lastAction ?? out.first;
  if (out.last !== null && start !== null && out.last - start > out.gap[0]) out.gap = [out.last - start, start, out.last];
  out.queueJobs = jobs.length >= 2 ? jobs.at(-1)! - jobs[0] : null;
  out.errors = [...errors].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return out;
}

const mins = (s: number) => `${Math.round(s / 60)} 分钟`;
const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);

/** 事实, 一行一条 */
export function measuredLines(st: JournalStats | null): string[] {
  if (!st || st.first === null) return ["- 上一班的 journal 里没有请求"];
  const lines = [`- 动手 ${st.actions} 次, 说话和看板 ${st.talk} 次, 读 ${st.reads} 次, 等 ${st.waits} 次 (要求等了 ${mins(st.waitS)}), 共 ${mins(st.spanS)}`];
  if (st.spanS) lines.push(`- 角色站着没动 ${mins(st.idleS)} (${Math.round((100 * st.idleS) / Math.max(1, st.spanS))}%, 按回复里的 clock 行)`);
  // 派对一班几个小时, 30 分钟才报; 我们连续班一班可能只有 10 分钟: 超过 3 分钟且占这一班三成以上也报
  const [g, g0, g1] = st.gap;
  if (g0 !== null && g1 !== null && (g >= 1800 || (g >= 180 && g >= st.spanS * 0.3))) {
    const hm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
    lines.push(`- 最长一段没动手: ${mins(g)} (${hm(g0)}-${hm(g1)} UTC${g1 === st.last && st.byAction.size && g0 !== st.first ? ", 一直到最后一个请求" : ""})`);
  }
  const used = top(st.byAction, 5).map(([a, n]) => `${a} ${n}`).join(", ");
  if (used) lines.push(`- 用得最多: ${used}`);
  if (st.noop.size) lines.push(`- 什么都没搬动: ${top(st.noop, 9).map(([a, n]) => `${a} ×${n}`).join(", ")}`);
  if (st.queueJobs !== null && st.queueJobs > 0) lines.push(`- 队列做完了约 ${st.queueJobs} 件`);
  for (const [msg, n] of st.errors) lines.push(`- 失败 ×${n}: ${msg}`);
  return lines;
}

/** 日志一节 (## 日志 / ## Log) 只留最近 keep 行 */
export function trimLogSection(notes: string, keep = 10): string {
  const m = /^## (日志|Log)[^\n]*\n/im.exec(notes);
  if (!m) return notes;
  const head = notes.slice(0, m.index + m[0].length), rest = notes.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  const body = next >= 0 ? rest.slice(0, next) : rest, tail = next >= 0 ? rest.slice(next) : "";
  const lines = body.split("\n").filter((l) => l.trim());
  if (lines.length <= keep) return notes;
  return `${head}[前 ${lines.length - keep} 行日志省略: 有用的并进上面各节, 再从 notes.md 删掉]\n${lines.slice(-keep).join("\n")}\n${tail ? `\n${tail}` : ""}`;
}

/** 截笔记时整节留着的: 标题里有这些词的 (现在在做、认领和坐标、约定和决定、答应的事、看板事项、下一步 / 计划) */
const KEEP_WORDS = ["now", "agreement", "decision", "commitment", "open board", "claim", "next check", "live check", "现在", "认领", "坐标", "约定", "决定", "答应", "看板", "下一步", "计划"];

/** 笔记截到 cap 字以内: 日志先只留 10 行; 再从不在 KEEP_WORDS 里的节、文件里靠前的先截 (每节从尾往头截到标题); 还不够才按比例截留着的。trimmed 记截了什么 */
export function capNotes(notes: string, cap = NOTES_MAX, trimmed: string[] = []): { notes: string; cut: boolean } {
  if (notes.length <= cap) return { notes, cut: false };
  const before = notes;
  notes = trimLogSection(notes);
  if (notes !== before) { const m = /\[前 (\d+) 行日志省略/.exec(notes); trimmed.push(`日志: 前 ${m?.[1] ?? "一些"} 行`); }
  if (notes.length <= cap) return { notes, cut: true };
  const parts = notes.split(/^(?=## )/m);
  const name = (p: string) => (p.startsWith("## ") ? p.split("\n", 1)[0].slice(3).trim() : "开头");
  const first = new Map<string, number>();
  parts.forEach((p, k) => { if (!p.startsWith("## ")) return; const w = KEEP_WORDS.find((x) => name(p).toLowerCase().includes(x)); if (w && !first.has(w)) first.set(w, k); });
  const keepAt = new Set(first.values());
  const budget = cap - 300;
  let excess = parts.join("").length - budget;
  const out = [...parts];
  parts.forEach((p, k) => {
    if (excess <= 0 || keepAt.has(k) || (!p.startsWith("## ") && p.length < 500)) return;
    const head = `${p.split("\n", 1)[0]}\n`;
    const mark = `\n[... 截掉 ${p.length} 字]\n`.length;
    const n = Math.min(excess + mark + 2, p.length - head.length);
    if (n <= mark) return;
    const cutText = `${p.slice(0, p.length - n).trimEnd()}\n[... 截掉 ${n} 字]\n`;
    out[k] = cutText;
    excess -= p.length - cutText.length;
    trimmed.push(`${name(p)}: ${p.length} 字里截掉 ${n} 字${p.length - n <= head.length ? " (只留标题)" : " (从尾往前)"}`);
  });
  if (excess <= 0) return { notes: out.join("").slice(0, cap), cut: true };
  const total = out.reduce((s, p) => s + p.length, 0);
  const final = out.map((p) => {
    let n = Math.floor((p.length * budget) / total);
    if (n >= p.length) return p;
    n = Math.max(200, n);
    trimmed.push(`${name(p)}: ${p.length} 字里截掉 ${p.length - n} 字 (从尾往前)`);
    return `${p.slice(0, n).trimEnd()}\n[... 截掉]\n`;
  });
  return { notes: final.join("").slice(0, cap), cut: true };
}

/** 去掉上一次的"上一班实测"一节 (每班换掉; 也认派对的英文标题) */
export function stripMeasured(notes: string): string {
  for (const h of [MEASURED, MEASURED_OLD]) notes = notes.replace(new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "gm"), "");
  return notes;
}

/** 第一个标题里有"现在 / now"的节的正文 (空白折叠), 没有就 null */
export function nowSection(notes: string): string | null {
  for (const p of notes.split(/^(?=## )/m)) {
    if (!p.startsWith("## ")) continue;
    const h = p.split("\n", 1)[0].toLowerCase();
    if (h.includes("now") || h.includes("现在")) return p.includes("\n") ? p.slice(p.indexOf("\n") + 1).split(/\s+/).filter(Boolean).join(" ") : "";
  }
  return null;
}

const NOW_FILE = ".now-history.json";
/** "现在在做"一节连续 2 班以上结束时一字不差: 报一行事实 (派对: 一个模型连着 7 班写的都是同一个"在做纸面设计") */
export function nowHistory(prevNotesFile: string, notes: string, outNotesFile: string, run: string): string | null {
  const text = nowSection(notes);
  if (text === null) return null;
  const h = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  let old: { hash?: string; since?: string; shifts?: number } = {};
  try { old = JSON.parse(fs.readFileSync(path.join(path.dirname(prevNotesFile), NOW_FILE), "utf8")); } catch { /* 第一次 */ }
  const same = old.hash === h;
  const rec = { hash: h, since: same ? old.since ?? run : run, shifts: same ? (old.shifts ?? 1) + 1 : 1 };
  try { fs.writeFileSync(path.join(path.dirname(outNotesFile), NOW_FILE), JSON.stringify(rec)); } catch { /* 写不上算了 */ }
  return rec.shifts < 2 ? null : `- 你笔记里"现在在做"那一节连续 ${rec.shifts} 班结束时一字不差 (${rec.since} 到 ${run})`;
}

/** 新一班的 notes.md: 接班说明 + 上一班实测 + 上一班的笔记 (截过的话全文进 notes-archive.md)。返回截没截 */
export function carryNotes(prevNotesFile: string, prevJournal: string, outNotesFile: string, run: string, player: string): boolean {
  let notes = fs.readFileSync(prevNotesFile, "utf8").replace(/\r\n/g, "\n");
  notes = stripMeasured(notes);
  // 上一次的接班说明也去掉 (这次重写)
  notes = notes.replace(/^\((从上一班接过来|Carried over from the previous shift)[^\n]*\)\n+(\((截掉的|Trimmed)[^\n]*\)\n+)?/, "");
  const trimmed: string[] = [];
  const { notes: capped, cut } = capNotes(notes, NOTES_MAX, trimmed);
  if (cut) fs.appendFileSync(path.join(path.dirname(outNotesFile), "notes-archive.md"), `\n\n# 班次 ${run} 留下的 notes.md (全文, ${notes.length} 字)\n\n${notes}`);
  const st = journalStats(prevJournal);
  const nowLine = nowHistory(prevNotesFile, notes, outNotesFile, run);
  const head = [
    `(从上一班接过来 (这一班 ${run}): ${player} 的 notes.md, 是上一班结束时的样子${cut ? `; 原来 ${Math.floor(notes.length / 1000)} 千字, 截到 ${NOTES_MAX / 1000} 千字, 全文在 notes-archive.md` : ""}。)`,
    ...(trimmed.length ? [`(截掉的: ${trimmed.slice(0, 5).join("; ")}${trimmed.length > 5 ? `; 另有 ${trimmed.length - 5} 节旧的截了` : ""}。整节留着的: 现在在做、认领和坐标、约定和决定、答应的事、看板事项、下一步和计划。)`] : []),
    "",
    `${MEASURED} (从你的 journal 数的, 每班换掉)`, ...measuredLines(st), ...(nowLine ? [nowLine] : []), "",
  ];
  fs.writeFileSync(outNotesFile, `${head.join("\n")}\n${capped}`);
  return cut;
}
