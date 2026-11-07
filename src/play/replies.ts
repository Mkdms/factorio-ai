// 真人的话要回 (库, 不直接运行):
//   ① 管理员在界面 (群 / 私聊) 说的话: control.ts 发私信时记 <班次>/tells.jsonl; 监工每次采样看哪条过了宽限还没回
//      (回 = 那个角色之后有成功的 operator 回话或 chat_ack), 催一次 (run.ts);
//   ② 游戏聊天里真人 (或队友) 的点名 / 没确认的私信: 模组 mention_counts (board.lua, 操作员读) 每个角色的未读数; 持续超过宽限就催, 之后隔一段再催。
import fs from "node:fs";

/** source = game: 游戏聊天里真人说的 (human-chat.ts), 对方在聊天里 say 回话也算回了; urgent 由 isUrgent 算 */
export type TellRecord = { at: string; agent: string; text: string; scope?: string; to?: string; source?: "ui" | "game"; from?: string };
export type Req = { t: number; action: string; ok: boolean };
/** 没回的宽限: 2 分钟 (派对实测: 队友点名具体故障 11 秒就动) */
export const REPLY_GRACE_MS = 120_000;
/** 算"回了"的动作: 回管理员 (operator) 或确认读了 (chat_ack); say / tell 是对队友说的, 不算 */
export const REPLY_ACTIONS = new Set(["operator", "chat_ack"]);

export function readTells(file: string): TellRecord[] {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out: TellRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o.at === "string" && typeof o.agent === "string" && typeof o.text === "string") out.push(o); } catch { /* 坏行跳过 */ }
  }
  return out;
}

export type Unanswered = { key: string; agent: string; text: string; ageMin: number; source?: "ui" | "game"; from?: string };
/** 这个角色回了这句吗: 管理员 → operator / chat_ack; 游戏聊天 → 也算 say / tell */
const repliedTo = (t: TellRecord, reqs: Req[], sent: number) => reqs.some((r) => r.ok && r.t >= sent && (REPLY_ACTIONS.has(r.action) || (t.source === "game" && (r.action === "say" || r.action === "tell"))));
/** 同一句发给全队的几条: 文字相同、时间相差 10 秒内 */
const sameBroadcast = (a: TellRecord, b: TellRecord) => a.scope === "team" && b.scope === "team" && a.text === b.text && Math.abs(Date.parse(a.at) - Date.parse(b.at)) < 10_000;
/**
 * 过了宽限还没回的话 (每条只催一次: nudged 记 key = at|agent, 调用方催完加进去)。
 * 发给全队的: 有一个回了就都算回了; 都没回就只催最近还在发命令的那一个 (2026-11-05 一句话催了 5 个, 全都打岔)。
 */
export function unansweredTells(tells: TellRecord[], reqs: (agent: string) => Req[], now: number, nudged: Set<string>, grace = REPLY_GRACE_MS): Unanswered[] {
  const out: Unanswered[] = [];
  const cache = new Map<string, Req[]>();
  const reqsOf = (id: string) => { if (!cache.has(id)) cache.set(id, reqs(id)); return cache.get(id)!; };
  const rowOf = (t: TellRecord, key: string): Unanswered => ({ key, agent: t.agent, text: t.text.replace(/\s+/g, " ").trim().slice(0, 80), ageMin: Math.max(1, Math.round((now - Date.parse(t.at)) / 60_000)), ...(t.source ? { source: t.source } : {}), ...(t.from ? { from: t.from } : {}) });
  const done = new Set<TellRecord>();
  for (const t of tells) {
    if (done.has(t)) continue;
    const key = `${t.at}|${t.agent}`;
    const sent = Date.parse(t.at);
    if (!Number.isFinite(sent) || now - sent < grace) continue;
    if (t.scope === "team") {
      const group = tells.filter((x) => sameBroadcast(t, x));
      for (const x of group) done.add(x);
      const keys = group.map((x) => `${x.at}|${x.agent}`);
      if (keys.some((k) => nudged.has(k))) continue;
      if (group.some((x) => repliedTo(x, reqsOf(x.agent), Date.parse(x.at)))) { for (const k of keys) nudged.add(k); continue; }
      const latest = (x: TellRecord) => Math.max(0, ...reqsOf(x.agent).map((r) => r.t));
      const pick = [...group].sort((a, b) => latest(b) - latest(a))[0];
      for (const k of keys) nudged.add(k);
      out.push(rowOf(pick, `${pick.at}|${pick.agent}`));
      continue;
    }
    if (nudged.has(key)) continue;
    if (repliedTo(t, reqsOf(t.agent), sent)) { nudged.add(key); continue; }
    out.push(rowOf(t, key));
  }
  return out;
}

/** 控制接口用: 只读 journal 末尾 (每几秒问一次, 整班的日志太大); 只要时间和动作名, 算回没回够了 */
export function tailRequests(file: string, bytes = 2_000_000): Req[] {
  try {
    const size = fs.statSync(file).size, len = Math.min(size, bytes);
    const b = Buffer.alloc(len), fd = fs.openSync(file, "r");
    try { fs.readSync(fd, b, 0, len, size - len); } finally { fs.closeSync(fd); }
    const out: Req[] = [];
    for (const line of b.toString("utf8").split(/\r?\n/)) {
      if (!line.includes('"event":"request"')) continue;
      try { const o = JSON.parse(line); out.push({ t: Date.parse(o.at), action: String(o.request?.action ?? ""), ok: true }); } catch { /* 开头半行 */ }
    }
    return out;
  } catch { return []; }
}

export type ReplyStatus = { at: string; text: string; scope: string; total: number; replied: string[]; waiting: string[] };
/** 界面在你说的话下面显示送达和回话: 最近几句, 每句谁回了、谁还没回 */
export function replyStatus(tells: TellRecord[], reqs: (agent: string) => Req[], nameOf: (t: TellRecord) => string, last = 6): ReplyStatus[] {
  const out: ReplyStatus[] = [];
  const seen = new Set<TellRecord>();
  const cache = new Map<string, Req[]>();
  const reqsOf = (id: string) => { if (!cache.has(id)) cache.set(id, reqs(id)); return cache.get(id)!; };
  for (const t of tells) {
    if (seen.has(t)) continue;
    const group = t.scope === "team" ? tells.filter((x) => sameBroadcast(t, x)) : [t];
    for (const x of group) seen.add(x);
    const replied = group.filter((x) => repliedTo(x, reqsOf(x.agent), Date.parse(x.at))).map(nameOf);
    out.push({ at: t.at, text: t.text, scope: t.scope ?? "direct", total: group.length, replied, waiting: group.map(nameOf).filter((n) => !replied.includes(n)) });
  }
  return out.slice(-last);
}

/** 模组 mention_counts 的一行 (board.lua: 每个角色) */
export type MentionCount = { name?: string; display_name?: string; unread_mentions?: number; at_mentions?: number; tells?: number; unacked_tells?: number; unacked_oldest_tick?: number };
export type MentionState = { firstSeen: Map<string, number>; lastNudge: Map<string, number> };
export const newMentionState = (): MentionState => ({ firstSeen: new Map(), lastNudge: new Map() });
export const MENTION_GRACE_TICKS = 2 * 3600;
export const MENTION_EVERY_TICKS = 5 * 3600;

export type MentionNudge = { name: string; mentions: number; unacked: number; waitedMin: number };
/** 未读的点名 / 没确认的私信持续超过宽限 → 催 (同一角色隔 everyTicks 再催); 读完了就清零 */
export function mentionNudges(counts: MentionCount[], nowTick: number, st: MentionState, graceTicks = MENTION_GRACE_TICKS, everyTicks = MENTION_EVERY_TICKS): MentionNudge[] {
  const out: MentionNudge[] = [];
  const seen = new Set<string>();
  for (const c of counts) {
    const name = c.name ?? c.display_name;
    if (!name) continue;
    seen.add(name);
    const mentions = Math.max(0, Number(c.unread_mentions) || 0), unacked = Math.max(0, Number(c.unacked_tells) || 0);
    if (mentions + unacked === 0) { st.firstSeen.delete(name); continue; }
    let first = st.firstSeen.get(name);
    if (first === undefined) { first = typeof c.unacked_oldest_tick === "number" ? Math.min(nowTick, c.unacked_oldest_tick) : nowTick; st.firstSeen.set(name, first); }
    const waited = nowTick - first;
    if (waited < graceTicks) continue;
    const last = st.lastNudge.get(name);
    if (last !== undefined && nowTick - last < everyTicks) continue;
    st.lastNudge.set(name, nowTick);
    out.push({ name, mentions, unacked, waitedMin: Math.max(1, Math.round(waited / 3600)) });
  }
  for (const k of [...st.firstSeen.keys()]) if (!seen.has(k)) st.firstSeen.delete(k);
  return out;
}
