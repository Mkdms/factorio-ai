// 控制接口的读数 (库; src/play/control.ts 用): 从一班的记录文件拼出界面要的状态, 不碰正在跑的 run.ts。
//  / 选了 Tauri, "按你说的顺序开始做" (先控制接口)。
import fs from "node:fs";
import path from "node:path";
import { ratesFrom } from "./science.ts";
import { DEFAULT_MODEL_NAME, modelDisplayName } from "./model-name.ts";
import type { Quota } from "./quota.ts";
import { LEGACY, isHidden, readWorld, runLabelZh, type World } from "./worlds.ts";
import { isPurged } from "./purge.ts";
import { LINK_INLINE_MAX, previewLink, fbeUrl } from "../blueprint/render.ts";

export type BrainLine = { kind: "说" | "命令" | "结果"; text: string };
/** detail = true (GET /api/brain?detail=1, 2026-11-03 给 Tauri 界面加) 时每行多带的字段; 不带 detail 时还是 {kind, text}, 格式不变。
 *  at = 这条消息的时间 (ISO, claude stream-json 的 timestamp, 界面拿它和自己发的话排先后); desc = 大脑给这条命令写的说明 (Bash 工具的 description);
 *  error = 这条结果是失败 (tool_result 的 is_error) */
export type BrainLineDetail = BrainLine & { at?: string; desc?: string; error?: boolean };

const jsonl = <T>(f: string): T[] => { try { return fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } }); } catch { return []; } };

/** 大脑最近说的话和执行的命令 (claude stream-json 的 turn 文件; 多角色时 turn-<id>-<n>.jsonl), 新的在后, 最多 n 条; detail 见 BrainLineDetail */
export function brainLines(runDir: string, agentId: string | null, n = 30, detail = false): BrainLineDetail[] {
  const re = agentId ? new RegExp(`^turn-${agentId}-(\\d+)\\.jsonl$`) : /^turn-(\d+)\.jsonl$/;
  const files = (fs.existsSync(runDir) ? fs.readdirSync(runDir) : []).map((f) => [f, re.exec(f)] as const).filter(([, m]) => m).sort((a, b) => Number(a[1]![1]) - Number(b[1]![1])).map(([f]) => f);
  const out: BrainLineDetail[] = [];
  for (const f of files.slice(-3)) for (const m of jsonl<any>(path.join(runDir, f))) {
    const at = detail && typeof m.timestamp === "string" ? { at: m.timestamp as string } : {};
    if (m.type === "assistant") for (const b of m.message?.content ?? []) {
      if (b.type === "text" && b.text?.trim()) out.push({ kind: "说", text: b.text.trim().slice(0, 600), ...at });
      else if (b.type === "tool_use" && b.name === "Bash") {
        const desc = detail && typeof b.input?.description === "string" && b.input.description.trim() ? { desc: b.input.description.trim().slice(0, 200) } : {};
        out.push({ kind: "命令", text: String(b.input?.command ?? "").slice(0, 300), ...at, ...desc });
      }
    } else if (m.type === "user" && !m.isReplay) for (const b of m.message?.content ?? []) {
      if (b.type === "tool_result") {
        const t = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join(" ") : String(b.content ?? "");
        if (t.trim()) out.push({ kind: "结果", text: t.trim().slice(0, 300), ...at, ...(detail && b.is_error === true ? { error: true } : {}) });
      }
    }
  }
  return out.slice(-n);
}

/** 最近一份复盘 (班末 run.ts 写的 review.json): 从最新一班往前找第一份; 当前这一班还在跑时就是上一班的。没有就 null */
export function latestReview(playDir: string): { run: string; lines: string[]; fixes: string[] } | null {
  for (const d of runDirs(playDir).reverse()) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(playDir, "runs", d, "review.json"), "utf8"));
      return { run: d, lines: Array.isArray(r.lines) ? r.lines : [], fixes: Array.isArray(r.fixes) ? r.fixes : [] };
    } catch { /* 这一班没有复盘 (还在跑或没跑完) */ }
  }
  return null;
}

/** 按名字找一班的目录 (只认班次目录名的格式, 防路径穿越); 没有返回 null */
export function runDirOf(playDir: string, id: string): string | null {
  if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d$/.test(id)) return null;
  const d = path.join(playDir, "runs", id);
  return fs.existsSync(d) ? d : null;
}

/** 这一班属于哪个世界 (没记的算旧记录) */
import { applyWorldName } from "./worlds.ts";
/** 这一班的世界 (没记的算旧记录), 套上用户改过的标题 (<play>/world-names.json) */
export const worldOfRun = (runDir: string): World & { renamed: boolean } => applyWorldName(path.dirname(path.dirname(runDir)), readWorld(runDir) ?? LEGACY);

/** purged = 删过对话记录 (src/play/purge.ts 标记): /api/worlds 不列它 */
export type RunBrief = { id: string; label: string; running: boolean; ended: boolean; interrupted: boolean; hidden: boolean; purged: boolean; lastAt: number | null };
/** GET /api/worlds: 每个世界和它的班次 (新的在前); 世界按最近一班排, 新的在前 */
export function worldsOf(playDir: string, now = Date.now()): (Pick<World, "id" | "name" | "kind"> & { renamed: boolean; runs: RunBrief[] })[] {
  const byId = new Map<string, Pick<World, "id" | "name" | "kind"> & { renamed: boolean; runs: RunBrief[] }>();
  for (const id of runDirs(playDir).reverse()) {
    const dir = path.join(playDir, "runs", id);
    const w = worldOfRun(dir);
    const st = runStatus(dir, now);
    const g = byId.get(w.id) ?? { id: w.id, name: w.name, kind: w.kind, renamed: w.renamed, runs: [] };
    g.runs.push({ id, label: runLabelZh(id), running: !st.ended && !st.interrupted, ended: st.ended, interrupted: st.interrupted, hidden: isHidden(dir), purged: isPurged(dir), lastAt: st.lastAt });
    byId.set(w.id, g);
  }
  return [...byId.values()];
}

/** 一班看到的复盘: 从这一班往前, 在同一个世界里找最近的 review.json (世界不同的不算) */
export function reviewFor(playDir: string, runId: string): { run: string; lines: string[]; fixes: string[] } | null {
  const ids = runDirs(playDir);
  const at = ids.indexOf(runId);
  if (at < 0) return null;
  const wid = worldOfRun(path.join(playDir, "runs", runId)).id;
  for (const d of ids.slice(0, at + 1).reverse()) {
    const dir = path.join(playDir, "runs", d);
    if (worldOfRun(dir).id !== wid) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, "review.json"), "utf8"));
      return { run: d, lines: Array.isArray(r.lines) ? r.lines : [], fixes: Array.isArray(r.fixes) ? r.fixes : [] };
    } catch { /* 这一班没有复盘 */ }
  }
  return null;
}

/** GET /api/names?n=a,b 的回复: 逗号分开的内部名 → 官方中文名 (zh 找不到就原样); 最多 200 个、每个最长 100 字, 空的不算 */
export function namesFor(query: string, zh: (name: string) => string): Record<string, string> {
  const list = [...new Set(query.split(",").map((s) => s.trim()).filter((s) => s && s.length <= 100))].slice(0, 200);
  return Object.fromEntries(list.map((k) => [k, zh(k)]));
}

const runDirs = (playDir: string): string[] => {
  const runs = path.join(playDir, "runs");
  return fs.existsSync(runs) ? fs.readdirSync(runs).filter((x) => /^\d{4}-\d\d-\d\dT/.test(x)).sort() : [];
};

type Row = { t?: number; tick: number; researched?: number; research?: string; labs?: number; labsWorking?: number; busyBy?: Record<string, boolean>; thinkBy?: Record<string, boolean>; machines?: number; redTotal?: number; greenTotal?: number; blueTotal?: number };
/** 游戏读数: 最新一次采样 + 近 10 游戏分钟每分钟产量 */
export function gameState(runDir: string) {
  const rows = jsonl<Row>(path.join(runDir, "monitor.jsonl"));
  const last = rows.at(-1);
  if (!last) return null;
  const recent = rows.filter((r) => r.tick >= last.tick - 36000);
  return { tick: last.tick, gameMinutes: +(last.tick / 3600).toFixed(1), researched: last.researched, research: last.research, labs: last.labs, labsWorking: last.labsWorking, machines: last.machines, busy: last.busyBy ?? {}, thinking: last.thinkBy ?? {}, perMin10: ratesFrom(recent), at: last.t };
}

/** 最新一次体检的几行 */
/** 这一班大脑 (Claude Code) 输出里最近一次额度事件 (run.ts 存进 quota.jsonl; 官方数据, 和 claude-hud 拿到的同一份); 超过 maxAgeMs 没新的就 null */
export function latestRunQuota(runDir: string, maxAgeMs = 15 * 60_000, now = Date.now()): Quota | null {
  const rows = jsonl<Quota & { agent?: string }>(path.join(runDir, "quota.jsonl")).filter((q) => typeof q?.t === "number" && q.windows && typeof q.windows === "object");
  const q = rows.at(-1);
  if (!q || now - q.t > maxAgeMs) return null;
  const { agent: _agent, ...rest } = q;
  return rest;
}

export function healthNow(runDir: string): string[] {
  return jsonl<{ lines: string[] }>(path.join(runDir, "health.jsonl")).at(-1)?.lines ?? [];
}

/** 看门狗 / 死亡现状 (run.ts 每次采样写的 watchdog.json; M6 2026-11-04): 停机、恢复、死亡、自动排研究; 没有就 null (11-04 之前的班) */
export type Watchdog = { at: string; recoveries: number; failed: number; downtimeS: number; downtimeShare: number; down: boolean; downS: number;
  last: { at: string; reason: string; save?: string | null; saveAgeS?: number | null; ok: boolean; downS: number } | null; deaths: number; deathsTotal: number; lastDeathAt: string | null; autoResearch: number };
export function watchdogNow(runDir: string): Watchdog | null {
  try { return JSON.parse(fs.readFileSync(path.join(runDir, "watchdog.json"), "utf8")); } catch { return null; }
}

/** 这一班大脑看过 / 用过的一张蓝图 (bp.ts 记的 blueprints.jsonl); link = 本机蓝图编辑器的预览链接 (没设 FBE_DIR 时长蓝图没有链接) */
export type ShiftBlueprint = { no: number; label: string; source: string; w: number; h: number; cmd: string; at: string; agent: string; link: string | null };
export function blueprintsOf(runDir: string): ShiftBlueprint[] {
  type Row = Omit<ShiftBlueprint, "link"> & { bp?: string };
  const rows = jsonl<Row>(path.join(runDir, "blueprints.jsonl")).filter((r) => r && r.label);
  const byKey = new Map<string, Row>();
  for (const r of rows) { byKey.delete(`${r.source}|${r.label}`); byKey.set(`${r.source}|${r.label}`, r); } // 同一张只留最后一次, 新的在前
  return [...byKey.values()].reverse().map(({ bp, ...r }) => {
    let link: string | null = null;
    try {
      const dir = process.env.FBE_DIR;
      if (bp && bp.length <= LINK_INLINE_MAX) link = previewLink(bp, dir ?? "", fbeUrl());
      else if (bp && dir) link = previewLink(bp, dir, fbeUrl());
    } catch { link = null; }
    return { ...r, link };
  });
}

/** 当前 (最新) 那一班的记录目录: runs/ 下按名字排最后的 (名字是开跑时间); 收起的班 (hidden 标记: 用户收起的、不叫大脑的验证班) 跳过, 全收起了才取最新 */
export function currentRun(playDir: string): string | null {
  const all = runDirs(playDir);
  const visible = all.filter((d) => !isHidden(path.join(playDir, "runs", d)));
  const d = (visible.length ? visible : all).at(-1);
  return d ? path.join(playDir, "runs", d) : null;
}

/** 这一班有哪些角色 (session-<id>.json; 单角色时 session.json)。
 *  name = 游戏里的名字 (会话文件 2026-11-03 起有; 旧的没有); model = 模型显示名: 会话文件的 → 大脑轮次文件第一行 (system/init) 的 → "Claude Opus 5.5" */
export function agentsOf(runDir: string): { id: string; session: string; bot?: string; player?: number; name?: string; model: string; /** 中途被移出 (run.ts applyRosterOp 在会话文件里标的) */ left?: boolean; /** 阵容里的那一席 (11-05 起的班才有) */ seat?: { brain: string; model: string } }[] {
  const files = fs.existsSync(runDir) ? fs.readdirSync(runDir) : [];
  const multi = files.filter((f) => /^session-[a-z]\.json$/.test(f)).sort(); // a~z (角色上限 26, 中途加人也按字母续; 以前只认 a~d)
  const list = multi.length ? multi.map((f) => ({ id: f.slice(8, 9), file: f })) : files.includes("session.json") ? [{ id: "a", file: "session.json" }] : [];
  return list.map(({ id, file }) => {
    const s = JSON.parse(fs.readFileSync(path.join(runDir, file), "utf8"));
    const model = typeof s.model === "string" && s.model ? s.model : modelFromTurns(runDir, multi.length ? id : null) ?? DEFAULT_MODEL_NAME;
    return { id, session: path.join(runDir, file), bot: s.bot, player: s.player, ...(typeof s.name === "string" && s.name ? { name: s.name } : {}), model, ...(s.left === true ? { left: true } : {}), ...(s.seat && typeof s.seat.brain === "string" ? { seat: { brain: s.seat.brain, model: String(s.seat.model ?? "") } } : {}) };
  });
}

/** 界面上的游戏名 (小字): 会话文件的 name → 服务器角色的 bot 名 → 控制接口用 RCON 读到的 → "玩家 N" */
export const gameNameOf = (a: { name?: string; bot?: string; player?: number }, fromGame?: string | null): string => a.name ?? a.bot ?? fromGame ?? `玩家 ${a.player ?? 1}`;

/** 旧会话文件没存游戏名 (run.ts 11-03 才开始写 name) 时的后备: 大脑第一轮读到的交接笔记开头写着 "its notes.md for <游戏名>"
 *  (派对 tools/handover.py 的格式, 用的是游戏里的名字); 没有这一行返回 null */
export function nameFromTurns(runDir: string, agentId: string | null): string | null {
  const f = path.join(runDir, agentId ? `turn-${agentId}-1.jsonl` : "turn-1.jsonl");
  let fd: number | null = null;
  try {
    fd = fs.openSync(f, "r");
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return /its notes\.md for ([^\s,()"\\]+)/.exec(buf.subarray(0, n).toString("utf8"))?.[1] ?? null;
  } catch { return null; } finally { if (fd !== null) fs.closeSync(fd); }
}

/** 一班的状态: ended = 收尾了 (有 summary.json); interrupted = 没收尾、但超过 INTERRUPTED_MIN 分钟没有任何新记录 (监工读数、大脑轮次、会话文件都没动:
 *  进程被结束了, 例 11-03 19:17 那班); lastAt = 最后一次记录的时间 (毫秒) */
export const INTERRUPTED_MIN = 30;
export function runStatus(runDir: string, now = Date.now()): { ended: boolean; interrupted: boolean; lastAt: number | null } {
  const ended = fs.existsSync(path.join(runDir, "summary.json"));
  let lastAt = gameState(runDir)?.at ?? null;
  for (const f of fs.existsSync(runDir) ? fs.readdirSync(runDir) : []) {
    if (!/^(turn-.*\.jsonl|monitor\.jsonl|session.*\.json|health\.jsonl)$/.test(f)) continue;
    try { const t = fs.statSync(path.join(runDir, f)).mtimeMs; if (lastAt === null || t > lastAt) lastAt = t; } catch { /* 刚被删 */ }
  }
  return { ended, interrupted: !ended && lastAt !== null && now - lastAt > INTERRUPTED_MIN * 60_000, lastAt };
}

const turnModels = new Map<string, string | null>();
/** 大脑第一个轮次文件的第一行是 claude 的 system/init, 带着这次用的模型 (claude-opus-5-5); 只读开头 8KB, 读到就记住 */
export function modelFromTurns(runDir: string, agentId: string | null): string | null {
  const f = path.join(runDir, agentId ? `turn-${agentId}-1.jsonl` : "turn-1.jsonl");
  if (turnModels.has(f)) return turnModels.get(f)!;
  let fd: number | null = null;
  try {
    fd = fs.openSync(f, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString("utf8").split(/\r?\n/)[0];
    const m = JSON.parse(first);
    const got = m?.type === "system" && m.subtype === "init" && typeof m.model === "string" ? modelDisplayName("claude", m.model) : null;
    turnModels.set(f, got);
    return got;
  } catch { return null; /* 还没有轮次文件, 或第一行超过 8KB: 下次再读 */ } finally { if (fd !== null) fs.closeSync(fd); }
}

/** 控制接口只许这些网页调 (带 Origin 头的请求): Tauri 界面 (Windows 上是 http://tauri.localhost, 开了 https 方案是 https://, 其他系统 tauri://localhost)
 *  和 npm run dev 的页面 (localhost:1420)。没有 Origin 头的 (命令行、脚本) 不经这里。别的网页 (浏览器里随便打开的) 不许: 它们能叫 /api/fh、/api/login */
export function allowedOrigin(origin: string): boolean {
  return /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost|http:\/\/(localhost|127\.0\.0\.1):1420)$/.test(origin);
}

/** 手动命令只许 ./fh 的参数, 不许接别的命令 (; | & ` $( > < 换行) —— 界面只在本机, 也不给拼 shell 的口子 */
/** 界面 "/" 命令里的只读写法: `call 动作 [--args JSON]` 或单个动作名 (status、board…) → 动作和参数; 别的写法 (带选项、多个词) 返回 null, 走真的 ./fh */
export function parseFhRead(args: string): { action: string; args: Record<string, unknown> } | null {
  const m = /^(?:call\s+)?([a-z][a-z0-9_]*)(?:\s+--args\s+(.+))?$/.exec(args.trim());
  if (!m) return null;
  if (!m[2]) return { action: m[1], args: {} };
  const raw = m[2].trim().replace(/^'(.*)'$/s, "$1").replace(/^"(.*)"$/s, "$1").replace(/\\"/g, '"');
  try { const o = JSON.parse(raw); return o && typeof o === "object" && !Array.isArray(o) ? { action: m[1], args: o } : null; } catch { return null; }
}

export function safeFhArgs(args: string): string | null {
  const a = args.trim().replace(/^\.\/fh\s+/, "");
  if (!a || /[;|&`<>\r\n]|\$\(/.test(a)) return null;
  return a;
}
