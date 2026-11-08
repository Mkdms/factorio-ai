// 控制接口 (src/play/control.ts, 只听本机 127.0.0.1:4330) 的调用。返回格式见那个文件开头的注释。
import type { Account, BackendPref, Group, KeyPatch, Line, MkState, ModelStat, NewGroupInput, Review, RosterSeat, Scan, ShiftAgentStat, ShiftBlueprint, State, VerifyStatus, WorldInfo } from "./logic.ts";

export const BASE = "http://127.0.0.1:4330";

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, {
      method, cache: "no-store", signal: ctl.signal,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const o = await r.json().catch(() => null);
    if (!r.ok) throw new Error((o as { error?: string } | null)?.error ?? `控制接口回 HTTP ${r.status}`);
    return o as T;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("控制接口没有回应 (超时)");
    throw e;
  } finally { clearTimeout(timer); }
}

export const api = {
  // run = 看哪一班 (不带 = 最新一班)
  state: (run?: string) => call<State>("GET", `/api/state${run ? `?run=${encodeURIComponent(run)}` : ""}`),
  brain: (agent: string, n: number, run?: string) => call<{ agent: string; lines: Line[] }>("GET", `/api/brain?agent=${encodeURIComponent(agent)}&n=${n}&detail=1${run ? `&run=${encodeURIComponent(run)}` : ""}`),
  review: (run?: string) => call<Review>("GET", `/api/review${run ? `?run=${encodeURIComponent(run)}` : ""}`),
  // 开班扫描: 现状 / 判断 / 规划, 右栏群公告最上面
  scan: (run?: string) => call<Scan>("GET", `/api/scan${run ? `?run=${encodeURIComponent(run)}` : ""}`),
  // 世界和班次 (按世界分对话); 收起 / 放出一班 (只放标记, 不删记录)
  worlds: () => call<{ worlds: WorldInfo[] }>("GET", "/api/worlds"),
  hide: (run: string, hidden: boolean) => call<{ run: string; hidden: boolean }>("POST", "/api/hide", { run, hidden }),
  /** 每个模型的统计和排行 */
  stats: () => call<{ models: ModelStat[]; shifts: ShiftAgentStat[] }>("GET", "/api/stats"),
  /** 改一个世界显示的标题 (空名恢复原名) */
  worldName: (world: string, name: string) => call<{ world: string; name: string }>("POST", "/api/world-name", { world, name }),
  names: (list: string[]) => call<{ names: Record<string, string> }>("GET", `/api/names?n=${list.map(encodeURIComponent).join(",")}`),
  // scope team = 群里对全队说的 (私信开头写"对全队说"), direct = 私聊 / @ 点名 / 等你卡片的回复
  tell: (agent: string, text: string, scope: "team" | "direct" = "direct") => call<{ to: string; parts: number }>("POST", "/api/tell", { agent, text, scope }),
  // ./fh 命令可能要等游戏里的动作做完 (控制接口那边最多 120 秒)
  fh: (agent: string, args: string) => call<{ code: number; out: string }>("POST", "/api/fh", { agent, args }, 130_000),
  stop: () => call<{ stopping: boolean; run: string }>("POST", "/api/stop", {}),
  /** 中途加人 / 移出: 控制接口记到在跑那一班的 roster.jsonl, run.ts 的监工 30 秒内照做 */
  rosterJoin: (seat: RosterSeat) => call<{ queued: boolean; seat: RosterSeat; run: string }>("POST", "/api/roster/join", { seat }),
  rosterLeave: (agent: string) => call<{ queued: boolean; agent: string; run: string }>("POST", "/api/roster/leave", { agent }),
  // 账号页: 三家命令行登没登、剩多少额度 (控制接口查命令行要几秒); fresh = 不用控制接口 60 秒的缓存
  accounts: (fresh = false) => call<{ accounts: Account[] }>("GET", `/api/accounts${fresh ? "?fresh=1" : ""}`, undefined, 30_000),
  // 开一个看得见的命令行窗口跑这家自己的登录 (浏览器里登, 界面和控制接口都不经手密码)
  login: (provider: string) => call<{ opened: boolean; command: string }>("POST", "/api/login", { provider }),
  // 存 DeepSeek / GLM / 中转站的 API 密钥 (空 = 删; 不给 = 不改), 控制接口存进本机 lab-data 并立刻用它查一次额度; 回的账号里只有密钥末 4 位。
  // 中转站 (relay) 还可以带 url (站点) 和 model (给大脑的模型), 2026-11-04 加
  setKey: (provider: string, key?: string, extra?: KeyPatch) => call<{ account: Account }>("POST", "/api/key", { provider, ...(key === undefined ? {} : { key }), ...(extra ?? {}) }, 30_000),
  // 下一班阵容: 每个角色一个模型; 存了以后开班没给 --brains 就按它
  lineup: (group?: string) => call<{ seats: RosterSeat[]; file?: string; group?: string }>("GET", `/api/lineup${group ? `?group=${encodeURIComponent(group)}` : ""}`),
  saveLineup: (seats: RosterSeat[], group?: string) => call<{ seats: RosterSeat[] }>("POST", "/api/lineup", { seats, ...(group ? { group } : {}) }),
  // 群 = 对话 = 世界: 列、建、按群开班 (开班 = 控制接口起一班 run.ts, 60 秒内回)
  groups: () => call<{ groups: Group[] }>("GET", "/api/groups"),
  createGroup: (input: NewGroupInput) => call<{ group: Group }>("POST", "/api/groups", input),
  setGroupBackend: (id: string, backend: BackendPref) => call<{ group: Group }>("POST", "/api/group/backend", { id, backend }),
  setGroupRcon: (id: string, address: string, password: string) => call<{ group: Group }>("POST", "/api/group/rcon", { id, address, password }),
  connectGroup: (id: string) => call<{ started: boolean; log: string }>("POST", "/api/group/connect", { id }),
  setGroupReveal: (id: string, on: boolean) => call<{ group: Group }>("POST", "/api/group/reveal", { id, on }),
  mk: () => call<MkState>("GET", "/api/mk"),
  stopMk: () => call<{ stopping: boolean; run?: string }>("POST", "/api/mk/stop", {}),
  setGroupGoal: (id: string, goal: string) => call<{ group: Group }>("POST", "/api/group/goal", { id, goal }),
  setGroupMe: (id: string, seat: RosterSeat | null) => call<{ group: Group }>("POST", "/api/group/me", { id, seat }),
  startGroup: (id: string) => call<{ started: boolean; group: string; log: string }>("POST", "/api/group/start", { id }, 60_000),
  // 蓝图预览入口: 这一班看过 / 用过的蓝图; 起本机蓝图编辑器 (第一次要等它起来, 最多 90 秒); 在系统浏览器里打开编辑器的地址
  blueprints: (run?: string) => call<{ editor: string; blueprints: ShiftBlueprint[] }>("GET", `/api/blueprints${run ? `?run=${encodeURIComponent(run)}` : ""}`),
  openEditor: () => call<{ url: string }>("POST", "/api/editor", {}, 100_000),
  openUrl: (url: string) => call<{ opened: boolean; url: string }>("POST", "/api/open", { url }),
  // 彻底删几班的对话记录: 留复盘 / 统计 / 存档链, 大脑笔记和知识库不碰
  purge: (runs: string[]) => call<{ purged: { run: string; deleted: number; bytes: number; kept: string[] }[]; skipped: { run: string; why: string }[] }>("POST", "/api/purge", { runs }, 60_000),
  // 中转站模型核实: 开始一轮 (每个模型发一句, 花站里余额) / 看进度
  relayVerify: (models?: string[]) => call<{ started: boolean; total: number }>("POST", "/api/relay/verify", models ? { models } : {}, 30_000),
  relayVerifyStatus: () => call<VerifyStatus>("GET", "/api/relay/verify"),
};
