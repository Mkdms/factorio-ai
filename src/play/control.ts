#!/usr/bin/env node
// 控制接口 (本机服务, 只听 127.0.0.1): 界面 (Tauri, 照 x.ai/bot 三栏聊天) 和操作员都连它。不碰正在跑的 run.ts —— 读每班的记录文件,
// 发话走和监工同一个操作员私信通道 (agent_harness dispatch, operator: true)。。
//   npm run play:control [-- --port 4330]
// GET  /api/state                 当前班次、每个角色 (名字、在不在忙)、游戏读数 (研究、研究中心、近 10 分钟每分钟产量)、体检、额度、上一班复盘
//                                  agents[].name = 游戏里的名字 (会话文件的 name → bot 名 → 游戏在跑时后台用 RCON 读到的 → "玩家 N");
//                                  agents[].model (2026-11-03 加) = 大脑模型显示名 "Claude Opus 5.5" (界面显示 "Claude Opus 5.5 · A")
// GET  /api/brain?agent=a&n=30    这个角色最近说的话、执行的命令和结果: {agent, lines: [{kind: "说"|"命令"|"结果", text}]}
//        &detail=1                 (2026-11-03 为 Tauri 界面加) 每行多带 at (ISO 时间)、命令的 desc (大脑写的说明)、结果的 error (失败);
//                                  不带 detail 时格式不变 (control-lib.ts BrainLineDetail)
// GET  /api/review                (2026-11-03 加) 最近一份复盘 {run, lines, fixes}: 从最新一班往前找, 在跑的这班还没有就是上一班的; 都没有 → null
// GET  /api/names?n=a,b           (2026-11-03 加) 内部名 → 官方中文名 {names: {a: "…"}}, 找不到的原样回; 界面显示研究名、科技包名用
// POST /api/tell   {agent, text}  对这个角色说话 (进它下一条回复, 能叫醒在睡的)
// POST /api/fh     {agent, args}  用这个角色执行一条 ./fh 命令 (例 "call status"), 只许 ./fh 的参数
// POST /api/stop                  这一班存档收尾 (记录目录放 STOP 文件, run.ts 看到后收尾)
// POST /api/roster/join {seat} / /api/roster/leave {agent}  (2026-11-05 加) 中途加人 / 移出: 记进 roster.jsonl, run.ts 30 秒内照做; 这一班不支持回 409
// GET  /api/accounts[?fresh=1]    (2026-11-03 加, 账号页) 三家命令行 Claude Code / Grok Build / Codex: {accounts: [{id, label, installed, version,
//                                  signedIn (null = 说不准), plan, usage: [{label, used (已用 %), resetsAt}], usageWhy, login, install}]}; 缓存 60 秒,
//                                  fresh=1 重读。不回令牌和邮箱 (src/play/accounts.ts)
// POST /api/login  {provider}     (2026-11-03 加) 开一个看得见的命令行窗口跑这家自己的登录 (claude auth login / grok login / codex login),
//                                  浏览器里登, 我们不经手密码: {opened: true, command}; 没装回 400 {error, install}
//                                  accounts 里还有填密钥的两家 DeepSeek / GLM 编程套餐 (kind: "key", keyTail = 密钥末 4 位, balance = 余额)
// GET  /api/worlds               世界和各自的班次: {worlds: [{id, name, kind, runs: [{id, label, running, ended,
//                                  interrupted, hidden, lastAt}]}]} (新的在前); 11-03 以前没记世界的班次在 id = legacy 那一组 (src/play/worlds.ts)
// ?run=<班次>                      (2026-11-03 加) /api/state、/api/brain、/api/review 都可以带, 看那一班; 不带还是最新一班 (以前的行为)。
//                                  /api/state 多带 world {id, name} 和 latest {id, running} (最新一班, 界面判断要不要跳过去)
// POST /api/hide   {run, hidden}  (2026-11-03 加) 收起 / 放出一班: 只在班次目录放 hidden 标记, 不删记录
// POST /api/purge  {runs: [id…]}  (2026-11-04 加) 彻底删这几班的对话 / 命令 / 读数 / 截图记录 (留复盘、统计、world.json、存档链; 大脑笔记 / 知识库不碰) → {purged: [{run, deleted, bytes, kept}], skipped: [{run, why}]}
// GET/POST /api/relay/verify      (2026-11-04 加) 中转站模型核实: POST {models?} 开始一轮 (每个模型发一句, 花站里余额), GET 看 {running, total, done, current, results}
// GET  /api/blueprints[?run=]     (2026-11-04 加) 这一班大脑看过 / 用过的蓝图 (bp.ts 记的 blueprints.jsonl): {editor, blueprints: [{no, label, source, w, h, cmd, at, agent, link}]}
// POST /api/editor                (2026-11-04 加) 起本机蓝图编辑器 (已开着就直接回; 第一次最多等 90 秒): {url}
// POST /api/open   {url}          (2026-11-04 加) 在系统浏览器里打开, 只许编辑器自己的地址 (预览链接)
// POST /api/key    {provider, key} (2026-11-03 加) 存 DeepSeek / GLM 的 API 密钥 (key 空 = 删) 到 <lab-data>/accounts/keys.json, 立刻用它查一次:
//                                  {account}; 格式不对回 400。整个密钥不回给界面
//                  provider = relay (2026-11-04 加, 中转站 New API) 还收 url (站点) 和 model; 没给的字段不动, key 空 = 整个中转站配置删掉;
//                                  回的 account 多带 url / model / models (这个令牌能用的模型, 从站的 /v1/models 读; 带 formats)
//                                  /api/state 还带 alerts: 最近 20 条大脑接口警报 [{at, agent, name, brain, model, kind: probe|api, text}]
// GET  /api/scan[?run=]           开班扫描 {at, stage, summary, lines, judgement, plan} (run.ts 开班写的 world-scan.json); 没有 → null
// GET  /api/groups                群 (= 对话 = 世界) {groups: [{id, name, kind: new|save|server, save?, server?, seats, minutes, createdAt}]}
// POST /api/groups {name, kind, save?, server?, seats?, minutes?}  新建一个群 → {group}; 不合格 400。/api/worlds 里没开过班的群也列出来 (runs 空, group: true)
// POST /api/group/reveal {id, on} (2026-11-06 加) 联机服务器的群: 没探过的区块读不读 (默认关) → {group}
// POST /api/group/backend {id, backend} (2026-11-06 加) 联机服务器的群走哪条路: auto / memory / rcon → {group}
// POST /api/group/rcon {id, address, password} (2026-11-06 加) 这个群的 RCON, 存 keys.json; address 空 = 清掉 → {group}
// POST /api/group/connect {id}    (2026-11-06 加) 只读连一次 (play:online --group, 不叫模型, 5 分钟) → {started, log}。联机群 GET 回的 server 是 {address, hasPassword, rcon}, 密码不回
// POST /api/group/start {id}      按群开一班 (run.ts --group <id> --brains <群成员> …, 接这个群最近一班的 end.zip; 脱离控制接口跑) → {started, args, log};
//                                  有一班在跑 / 联机的群 → 400
// GET  /api/lineup[?group=<群>]    下一班阵容 {seats: [{brain, model}], file}; 没存过是 []; 带 group = 那个群的成员
// POST /api/lineup {seats}        存阵容 (1~4 个角色, 每个 {brain: claude/grok/deepseek/relay/none, model}; 空数组 = 删掉) → {seats}; run.ts 没给
//                                  --brains / --brain / --agents 时按它开班 (src/play/roster.ts)
// 只许本机的界面调 (2026-11-03 起): 带 Origin 头的请求只认 Tauri 界面和 npm run dev 的页面, 别的网页回 403 (以前是 *, 任何网页都能调 /api/fh)。
// 新加端点只能加, 不能改已有端点的返回格式 (界面 app/ 按这个格式读; 测试 test/play-control.test.ts)。
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { factorioExe, findFactorioDir, labRoot, REPO } from "../lab/gamedir.ts";
import { mkArgs, mkRunning, mkStop, mkView, readMkCurrent, steamClientRunning } from "./mk-lib.ts";
import { spawn } from "node:child_process";
import { connectArgs, createGroup, groupsDir, readGroup, readGroups, saveGroupSeats, setBackend, setGroupGoal, setRevealUncharted, startArgs, type Group } from "./groups.ts";
import { cleanServerConn, readServer, serverView } from "./online-lib.ts";
import { RconClient } from "../lab/rcon.ts";
import { luaString } from "./harness.ts";
import { readPlanUsage, describeQuota, type Quota } from "./quota.ts";
import { loadZhNames } from "./chattags.ts";
import { agentsOf, allowedOrigin, blueprintsOf, brainLines, currentRun, gameNameOf, gameState, healthNow, latestReview, latestRunQuota, nameFromTurns, namesFor, parseFhRead, reviewFor, runDirOf, runStatus, safeFhArgs, watchdogNow, worldOfRun, worldsOf } from "./control-lib.ts";
import { ensureEditor, fbeUrl } from "../blueprint/render.ts";
import { setHidden, setWorldName } from "./worlds.ts";
import { modelStats, shiftStats } from "./stats.ts";
import { useSystemProxy } from "./sysproxy.ts";
import { bashExe, decodeOutput } from "./shell.ts";
import { cleanSeat, readRoster, saveRoster } from "./roster.ts";
import { ROSTER_FILE, appendRosterOp } from "./roster-live.ts";
import { readAlerts } from "./alerts.ts";
import { isUrgent, tellText } from "./human-chat.ts";
import { readTells, replyStatus, tailRequests, type ReplyStatus } from "./replies.ts";
/** 控制接口替界面起的蓝图编辑器 (POST /api/editor): 退出时收掉 (原来就开着的 ensureEditor 不会关) */
let editorStop: (() => void) | null = null;
process.on("exit", () => editorStop?.());
import { accountsAll, defaultKeysFile, KEY_PROVIDERS, keyAccountOf, openLogin, PROVIDERS, readKeys, readRelayFormats, relayConfig, saveGroupServer, saveKey, saveRelay, saveRelayVerified, type Account, type ProviderId } from "./accounts.ts";
import { purgeRun } from "./purge.ts";
import { VerifyJob, verifyRelayModel } from "./relay-verify.ts";
import { relayRoute } from "./relay-route.ts";
/** 中转站模型核实任务 (同时只跑一个) */
const verifyJob = new VerifyJob();

// 双击界面程序时控制接口没有 HTTPS_PROXY (只继承 Explorer 的环境), 读各家额度会被地区拦截: 用 Windows 系统代理 (src/play/sysproxy.ts)
const sysProxy = useSystemProxy();
const { values } = parseArgs({ options: { port: { type: "string", default: process.env.CONTROL_PORT ?? "4330" } } });
const PLAY = path.join(labRoot(), "play");
/** 给界面的群: 联机群带上服务器信息 (从 keys.json 读, 密码只说有没有) */
const groupView = (g: Group) => (g.kind === "server" ? { ...g, server: serverView(readServer(defaultKeysFile(), g.id)) } : g);
/** 联机客户端 (play:online 用的 clients/online-a) 还开着吗 */
const onlineClientAlive = (): boolean => {
  try { const { pid } = JSON.parse(fs.readFileSync(path.join(labRoot(), "clients", "online-a", "viewer.json"), "utf8")) as { pid?: number }; if (!pid) return false; process.kill(pid, 0); return true; } catch { return false; }
};
const brainRoot = process.env.BRAIN_DIR ?? path.join(os.homedir(), "factorio-pilot-brain");

let zhMap: Map<string, string> | null = null;
const zh = (n: string) => (zhMap ??= loadZhNames(path.join(labRoot(), "prototypes"))).get(n) ?? n;

// 额度: 有一班在跑时用大脑 (Claude Code) 自己输出的额度事件 —— 官方数据, 和 claude-hud 从 Claude Code
// 拿到的同一份; 没在跑才读没公开的用量接口, 最多 5 分钟一次 (以前每 60 秒; claude-hud 0.7 起就不再这样读了)。
let quota: { q: Quota | null; why?: string; at: number } = { q: null, at: 0 };
function officialQuota(): Quota | null {
  const runDir = currentRun(PLAY);
  if (!runDir) return null;
  const st = runStatus(runDir);
  return !st.ended && !st.interrupted ? latestRunQuota(runDir) : null;
}
async function quotaNow() {
  const official = officialQuota();
  if (!official && Date.now() - quota.at > 5 * 60_000) quota = { ...(await readPlanUsage()), at: Date.now() };
  const q = official ?? quota.q;
  return { text: describeQuota(q), utilization: q ? Math.max(...Object.values(q.windows).map((w) => w.utilization)) : null, why: official ? null : quota.why ?? null, source: official ? "大脑输出" : "用量接口" };
}

let accounts: { list: Account[]; at: number } | null = null;
let accountsBusy: Promise<Account[]> | null = null;
async function accountsNow(fresh: boolean) {
  if (!fresh && accounts && Date.now() - accounts.at < 60_000) return accounts.list;
  accountsBusy ??= accountsAll(process.env, undefined, undefined, undefined, officialQuota()).then((list) => { accounts = { list, at: Date.now() }; return list; }).finally(() => { accountsBusy = null; });
  return accountsBusy;
}

/** 这一班某个角色: 会话文件、大脑目录、游戏里的名字 */
function agentInfo(runDir: string, id: string) {
  const a = agentsOf(runDir).find((x) => x.id === id);
  if (!a) return null;
  const multi = agentsOf(runDir).length > 1;
  return { ...a, dir: path.join(brainRoot, path.basename(runDir), multi ? id : "") };
}

async function rconFor(session: string) {
  const s = JSON.parse(fs.readFileSync(session, "utf8"));
  // 界面等着回音: 连不上 8 秒就报错 (默认会按退避重试 120 秒, 游戏没起来时发一句话要卡 2 分钟)
  const r = new RconClient({ port: s.rconPort, password: s.password, connectDeadlineMs: 8_000, timeoutMs: 20_000 });
  await r.connect();
  return r;
}

/** 旧会话文件没有游戏名 (name) 的角色: 游戏在跑时后台用 RCON 读一次 game.players[N].name 记住 (键: 记录目录|角色);
 *  不在 /api/state 里等它 (游戏没起来时 RCON 要等 8 秒), 读不到 1 分钟后再试, 这期间显示 "玩家 N" */
const fromGame = new Map<string, string>();
const asking = new Set<string>();
function lookUpGameName(runDir: string, a: { id: string; session: string; player?: number }) {
  const k = `${runDir}|${a.id}`;
  if (fromGame.has(k) || asking.has(k)) return;
  asking.add(k);
  rconFor(a.session)
    .then(async (r) => { try { const n = String(await r.exec(`/silent-command rcon.print(game.players[${a.player ?? 1}].name)`)).trim(); if (n) fromGame.set(k, n); } finally { r.close(); } })
    .catch(() => { /* 游戏没开 */ })
    .finally(() => setTimeout(() => asking.delete(k), 60_000).unref());
}

/** scope: team = 界面群里对全队 (每个角色各收一遍), direct = 私聊 / @ 点名 / 等你卡片的回复。
 *  私信开头写明是管理员说的、怎么回;
 *  同时记进 <班次>/tells.jsonl, 监工 2 分钟没见回话就催 (src/play/replies.ts) */
async function tell(runDir: string, id: string, text: string, scope: "team" | "direct" = "direct") {
  const a = agentInfo(runDir, id);
  if (!a) throw new Error(`没有角色 ${id}`);
  const r = await rconFor(a.session);
  try {
    const k = `${runDir}|${id}`;
    const to = a.bot ?? a.name ?? fromGame.get(k) ?? String(await r.exec(`/silent-command rcon.print(game.players[${a.player ?? 1}].name)`)).trim();
    if (!a.bot && !a.name) fromGame.set(k, to);
    // 群发别让每个人都回 "收到"; 不紧急不打断, 手上的事做完再回 (同日 "不打断 让他忙完手头上的事情在做。除非真人玩家说特别紧急": 紧急的 run.ts 5 秒内打断)
    const full = tellText("界面", "管理员", text, scope, isUrgent(text));
    const parts: string[] = [];
    let cur = "";
    for (const ch of full) { if (Buffer.byteLength(cur + ch) > 480) { parts.push(cur); cur = ""; } cur += ch; }
    if (cur) parts.push(cur);
    for (const part of parts) {
      const body = JSON.stringify({ id: `gui-${Date.now()}-${id}-${Math.random().toString(36).slice(2, 7)}`, operator: true, action: "tell", args: { to, text: part } });
      const o = JSON.parse(await r.exec(`/silent-command rcon.print(remote.call("agent_harness", "dispatch", ${luaString(body)}))`));
      if (!o.ok) throw new Error(o.error?.message ?? "私信没发成");
    }
    try { fs.appendFileSync(path.join(runDir, "tells.jsonl"), JSON.stringify({ at: new Date().toISOString(), agent: id, to, scope, text }) + "\n"); } catch { /* 记不上不影响发话 */ }
    return { to, parts: parts.length };
  } finally { r.close(); }
}

/** 只读命令走模组的 reader (派对流媒体服务也这么读): 不占角色的一次性提醒、队友消息、计时和聊天, 不打断它的队列 (2026-11-05: 用 ./fh board 看看板把发给 Claude 的 3 条监工提醒读走了);
 *  动作类模组会拒 ("a reader request takes reads only") → 返回 null, 走真的 ./fh; 连不上也返回 null */
async function readerFh(a: { session: string; bot?: string; player?: number }, safe: string): Promise<{ code: number; out: string } | null> {
  const parsed = parseFhRead(safe);
  if (!parsed) return null;
  let r;
  try { r = await rconFor(a.session); } catch { return null; }
  try {
    const body = JSON.stringify({ id: `gui-${Date.now()}`, action: parsed.action, ...(a.bot ? { bot: a.bot } : { player: a.player ?? 1 }), args: parsed.args, reader: "gui" });
    const o = JSON.parse(await r.exec(`/silent-command rcon.print(remote.call("agent_harness", "dispatch", ${luaString(body)}))`));
    if (!o.ok) {
      if (/reads only/.test(String(o.error?.message))) return null;
      return { code: 1, out: `error: ${o.error?.message ?? "?"}` };
    }
    return { code: 0, out: JSON.stringify(o.result ?? null, null, 1).slice(0, 20_000) };
  } catch { return null; } finally { r.close(); }
}

async function fh(runDir: string, id: string, args: string): Promise<{ code: number; out: string }> {
  const a = agentInfo(runDir, id);
  const safe = safeFhArgs(args);
  if (!a) return Promise.resolve({ code: 1, out: `没有角色 ${id}` });
  if (!safe) return Promise.resolve({ code: 1, out: "只许 ./fh 的参数, 不许 ; | & ` $( < > 换行" });
  const read = await readerFh(a, safe);
  if (read) return read;
  // 明确用 Git Bash (src/play/shell.ts): 双击界面时 PATH 上的 bash 是 WSL 的, 跑不了还输出 UTF-16 乱码
  return new Promise((resolve) => execFile(bashExe(), ["-c", `./fh ${safe}`], { cwd: a.dir, timeout: 120_000, maxBuffer: 1_000_000, windowsHide: true, encoding: "buffer" }, (err, stdout, stderr) =>
    resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${decodeOutput(stdout)}${decodeOutput(stderr)}`.slice(0, 20_000) })));
}

/** 这个角色多少秒没发过命令 (它的 journal 最后写入); 读不到 undefined */
function quietSeconds(runDir: string, id: string): number | undefined {
  try { const a = agentInfo(runDir, id); return a ? Math.max(0, Math.round((Date.now() - fs.statSync(path.join(a.dir, "journal.jsonl")).mtimeMs) / 1000)) : undefined; } catch { return undefined; }
}
const repliesCache = new Map<string, { at: number; v: ReplyStatus[] }>();
function repliesNow(runDir: string): ReplyStatus[] {
  const c = repliesCache.get(runDir);
  if (c && Date.now() - c.at < 5000) return c.v;
  const v = replyStatus(readTells(path.join(runDir, "tells.jsonl")), (id) => { const a = agentInfo(runDir, id); return a ? tailRequests(path.join(a.dir, "journal.jsonl")) : []; }, (t) => t.to ?? t.agent);
  repliesCache.set(runDir, { at: Date.now(), v });
  return v;
}

async function state(runParam: string | null) {
  const latestDir = currentRun(PLAY);
  const runDir = runParam ? runDirOf(PLAY, runParam) : latestDir;
  if (!runDir) return { run: null };
  const latestSt = latestDir ? runStatus(latestDir) : null;
  const latest = latestDir && latestSt ? { id: path.basename(latestDir), running: !latestSt.ended && !latestSt.interrupted } : null;
  const world = worldOfRun(runDir);
  const st = runStatus(runDir);
  const ended = st.ended || st.interrupted;
  let review: unknown = null;
  try { review = JSON.parse(fs.readFileSync(path.join(runDir, "review.json"), "utf8")); } catch { /* 班末才有 */ }
  return {
    // interrupted / lastAt (2026-11-03 加): 没收尾、30 分钟以上没有新记录 = 中断了 (界面不再当它"在跑")
    run: { id: path.basename(runDir), dir: runDir, running: !ended, stopping: fs.existsSync(path.join(runDir, "STOP")), interrupted: st.interrupted, lastAt: st.lastAt, rosterLive: fs.existsSync(path.join(runDir, ROSTER_FILE)) },
    agents: agentsOf(runDir).map((a) => {
      if (!a.name && !a.bot && !ended) lookUpGameName(runDir, a);
      const multi = agentsOf(runDir).length > 1;
      return { id: a.id, name: gameNameOf(a, fromGame.get(`${runDir}|${a.id}`) ?? nameFromTurns(runDir, multi ? a.id : null)), busy: gameState(runDir)?.busy?.[a.id] ?? null, thinking: gameState(runDir)?.thinking?.[a.id] ?? null, last: brainLines(runDir, agentsOf(runDir).length > 1 ? a.id : null, 1)[0] ?? null, model: a.model, ...(a.left ? { left: true } : {}), ...(a.bot ? { bot: a.bot } : {}), ...(a.seat ? { seat: a.seat } : {}),...(ended ? {} : { quietS: quietSeconds(runDir, a.id) }) };
    }),
    replies: repliesNow(runDir), // (2026-11-05 加) 你说的话谁回了谁没回, 界面显示在那句话下面
    game: gameState(runDir), health: healthNow(runDir), quota: await quotaNow(), review,
    watchdog: watchdogNow(runDir), // (2026-11-04 加) 看门狗 / 死亡现状, 旧班没有就 null
    alerts: readAlerts(runDir), // (2026-11-04 加) 大脑接口警报 (试通失败 / 轮次报 API 错误), 界面弹窗; 没有 []
    world: { id: world.id, name: world.name }, latest,
  };
}

const body = (req: http.IncomingMessage): Promise<any> => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", (d) => { b += d; if (b.length > 100_000) req.destroy(); });
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
});

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
  const send = (code: number, o: unknown) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...cors }); res.end(JSON.stringify(o)); };
  try {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (origin && !allowedOrigin(origin)) { res.writeHead(403, { "content-type": "application/json; charset=utf-8" }); return res.end(JSON.stringify({ error: "只许本机的界面调用" })); }
    if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST" }); return res.end(); }
    const runParam = u.searchParams.get("run");
    if (runParam && !runDirOf(PLAY, runParam)) return send(404, { error: `没有这一班: ${runParam.slice(0, 40)}` });
    if (req.method === "GET" && u.pathname === "/api/state") return send(200, await state(runParam));
    if (req.method === "GET" && u.pathname === "/api/worlds") {
      // 群 (界面"新建对话"建的; src/play/groups.ts) 也是世界: 还没开过班的群也列出来 (runs 空), 开过的标 group = true
      // 删过对话记录的班 (purged 标记) 不列; 班都删光的世界也不列 (群除外, 下面补回)
      const ws: (ReturnType<typeof worldsOf>[number] & { group?: boolean })[] = worldsOf(PLAY).map((w) => ({ ...w, runs: w.runs.filter((r) => !r.purged) })).filter((w) => w.runs.length);
      for (const g of readGroups(PLAY)) { const w = ws.find((x) => x.id === g.id); if (w) w.group = true; else ws.push({ id: g.id, name: g.name, kind: g.kind === "server" ? "server" : "sandbox", renamed: false, runs: [], group: true }); }
      return send(200, { worlds: ws });
    }
    // 群 = 对话 = 世界: 列 / 建 / 按群开班
    if (req.method === "GET" && u.pathname === "/api/groups") return send(200, { groups: readGroups(PLAY).map(groupView) });
    if (req.method === "POST" && u.pathname === "/api/groups") {
      const b = await body(req);
      // 界面选"接着某条存档链" 传 __run__:<班次> (界面不知道 lab-data 在哪): 换成那一班的 end.zip
      const save = typeof b.save === "string" ? (b.save.startsWith("__run__:") ? path.join(PLAY, "runs", b.save.slice(8).replace(/[^\w.-]/g, ""), "end.zip") : b.save) : undefined;
      try {
        // 地址和密码进 keys.json, 不进群文件 (群文件进备份): 先核对再建群, 不留半截
        const saved = readServer(defaultKeysFile());
        const conn = b.kind === "server" ? cleanServerConn(b.server, saved) : null;
        const g = createGroup(PLAY, { name: String(b.name ?? ""), kind: b.kind, save, server: conn ? { address: conn.address } : undefined, savedServer: !!saved, seats: Array.isArray(b.seats) ? b.seats : undefined, minutes: typeof b.minutes === "number" ? b.minutes : undefined, revealUncharted: b.revealUncharted === true, backend: b.backend, goal: b.goal });
        if (conn) saveGroupServer(defaultKeysFile(), g.id, conn);
        return send(200, { group: groupView(g) });
      } catch (e) { return send(400, { error: (e as Error).message }); }
    }
    // 联机服务器的群走哪条路: 自动 / 内存外挂 / RCON
    if (req.method === "POST" && u.pathname === "/api/group/backend") {
      const b = await body(req);
      try { return send(200, { group: groupView(setBackend(PLAY, String(b.id ?? ""), b.backend)) }); }
      catch (e) { return send(400, { error: (e as Error).message }); }
    }
    // 填 / 改 / 清这个群的 RCON (存 keys.json); address 空 = 清掉; 只改地址不重填密码时沿用原来的密码
    if (req.method === "POST" && u.pathname === "/api/group/rcon") {
      const b = await body(req);
      const id = String(b.id ?? "");
      const g = readGroup(PLAY, id);
      if (g?.kind !== "server") return send(400, { error: `没有这个联机服务器的群: ${id.slice(0, 40)}` });
      const cur = readServer(defaultKeysFile(), id);
      if (!cur) return send(400, { error: "这个群还没有服务器地址" });
      try {
        const address = String(b.address ?? "").trim();
        const password = String(b.password ?? "").trim() || cur.rcon?.password || "";
        const { rcon: _old, ...rest } = cur; void _old;
        const next = address ? cleanServerConn({ ...rest, rcon: { address, password } }, null) : rest;
        saveGroupServer(defaultKeysFile(), id, next);
        return send(200, { group: groupView(g) });
      } catch (e) { return send(400, { error: (e as Error).message }); }
    }
    // 只读连一次联机服务器 (不叫模型, 不注入, 5 分钟自己断开; 选项都按群的): 脱离控制接口跑, 输出写进群目录的日志 (日志里没有地址和密码)
    if (req.method === "POST" && u.pathname === "/api/group/connect") {
      const b = await body(req);
      const g = readGroup(PLAY, String(b.id ?? ""));
      if (!g) return send(400, { error: `没有这个群: ${String(b.id ?? "").slice(0, 40)}` });
      let args: string[];
      try { args = connectArgs(g); } catch (e) { return send(400, { error: (e as Error).message }); }
      if (onlineClientAlive()) return send(400, { error: "已经有一个联机客户端连着, 等它断开再连" });
      const logFile = path.join(PLAY, "groups", `${g.id}-connect-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.log`);
      const fd = fs.openSync(logFile, "a");
      const c = spawn(process.execPath, ["--env-file-if-exists=" + path.join(REPO, ".env"), path.join(REPO, "src", "play", "online.ts"), ...args], { cwd: REPO, detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env: { ...process.env } });
      c.unref();
      return send(200, { started: true, group: g.id, log: logFile });
    }
    // 联机服务器的群: 没探过的区块读不读
    if (req.method === "POST" && u.pathname === "/api/group/reveal") {
      const b = await body(req);
      try { return send(200, { group: setRevealUncharted(PLAY, String(b.id ?? ""), b.on === true) }); }
      catch (e) { return send(400, { error: (e as Error).message }); }
    }
    // 用模型玩用户的账号: 现在的状态 / 请它收工 / 改目标
    if (req.method === "GET" && u.pathname === "/api/mk") return send(200, mkView(PLAY));
    if (req.method === "POST" && u.pathname === "/api/mk/stop") { const r = mkStop(PLAY, "界面"); return send(r.ok ? 200 : 400, r.ok ? { stopping: true, run: r.runId } : { error: r.error }); }
    if (req.method === "POST" && u.pathname === "/api/group/goal") {
      const b = await body(req);
      try { return send(200, { group: groupView(setGroupGoal(PLAY, String(b.id ?? ""), b.goal)) }); }
      catch (e) { return send(400, { error: (e as Error).message }); }
    }
    if (req.method === "POST" && u.pathname === "/api/group/start") {
      const b = await body(req);
      const g = readGroup(PLAY, String(b.id ?? ""));
      if (!g) return send(400, { error: `没有这个群: ${String(b.id ?? "").slice(0, 40)}` });
      if (g.kind === "mine") {
        if (mkRunning(readMkCurrent(PLAY))) return send(400, { error: "你的账号已经有一局在跑, 先停了再开" });
        // 用户自己开着游戏就不开: 那时账号归他 (2026-11-05 定); mk-world 还会再查一次
        try { if (steamClientRunning(factorioExe(findFactorioDir()))) return send(400, { error: "你的 Steam 版 Factorio 开着: 你在玩时账号归你, 这里不碰。关掉再开。" }); }
        catch (e) { return send(400, { error: `查不了 Steam 版开没开: ${(e as Error).message.slice(0, 160)}` }); }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        fs.mkdirSync(groupsDir(PLAY), { recursive: true });
        let goalFile: string | undefined;
        if (g.goal) { goalFile = path.join(groupsDir(PLAY), `${g.id}-goal.md`); fs.writeFileSync(goalFile, g.goal); }
        const args = mkArgs(g, goalFile);
        const logFile = path.join(groupsDir(PLAY), `${g.id}-${stamp}.log`);
        const fd = fs.openSync(logFile, "a");
        const c = spawn(process.execPath, ["--env-file-if-exists=" + path.join(REPO, ".env"), path.join(REPO, "src", "play", "mk-world.ts"), ...args], { cwd: REPO, detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env: { ...process.env } });
        c.unref();
        return send(200, { started: true, group: g.id, args, log: logFile });
      }
      const cur = currentRun(PLAY);
      if (cur) { const st = runStatus(cur); if (!st.ended && !st.interrupted) return send(400, { error: `有一班在跑 (${path.basename(cur)}), 先停班再开` }); }
      let args: string[];
      try { args = startArgs(PLAY, g); } catch (e) { return send(400, { error: (e as Error).message }); }
      // 脱离控制接口跑 (关界面不影响这一班); 输出写进群目录的日志。
      // : 走 shifts.ts 连跑到停班 (--shifts 0 --live), 每班到点只换大脑, 服务器和窗口留着; 界面"停班" (STOP) 才关
      const logFile = path.join(PLAY, "groups", `${g.id}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.log`);
      const fd = fs.openSync(logFile, "a");
      const c = spawn(process.execPath, ["--env-file-if-exists=" + path.join(REPO, ".env"), path.join(REPO, "src", "play", "shifts.ts"), "--shifts", "0", "--live", ...args], { cwd: REPO, detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env: { ...process.env } });
      c.unref();
      return send(200, { started: true, group: g.id, args, log: logFile });
    }
    if (req.method === "POST" && u.pathname === "/api/hide") {
      const b = await body(req);
      const dir = runDirOf(PLAY, String(b.run ?? ""));
      if (!dir) return send(404, { error: "没有这一班" });
      setHidden(dir, b.hidden !== false);
      return send(200, { run: path.basename(dir), hidden: b.hidden !== false });
    }
    // POST /api/purge {runs: [...]} (2026-11-04 加): 彻底删这几班的对话 / 命令 / 读数 / 截图记录 (src/play/purge.ts),
    // 留 summary / review / world.json / 存档链; 大脑笔记、知识库、规则不在记录目录里, 碰不到; 在跑的那一班不删。删完标记收起。
    if (req.method === "POST" && u.pathname === "/api/purge") {
      const b = await body(req);
      const ids: string[] = Array.isArray(b.runs) ? b.runs.map(String) : b.run ? [String(b.run)] : [];
      if (!ids.length) return send(400, { error: "要 runs (班次 id 列表)" });
      const live = currentRun(PLAY);
      const purged: unknown[] = [], skipped: { run: string; why: string }[] = [];
      for (const id of ids) {
        const dir = runDirOf(PLAY, id);
        if (!dir) { skipped.push({ run: id, why: "没有这一班" }); continue; }
        const st = runStatus(dir);
        if (live && path.resolve(live) === path.resolve(dir) && !st.ended && !st.interrupted) { skipped.push({ run: id, why: "这一班在跑, 先停班" }); continue; }
        try { purged.push(purgeRun(dir)); } catch (e) { skipped.push({ run: id, why: (e as Error).message.slice(0, 120) }); }
      }
      return send(200, { purged, skipped });
    }
    // 中转站模型核实 (2026-11-04 加): POST 开始 (models 不给 = 这个令牌能用的全部; 已在跑回 409), GET 看进度和结果; 结果存 keys.json relay_verified
    if (req.method === "GET" && u.pathname === "/api/relay/verify") return send(200, verifyJob.status());
    if (req.method === "POST" && u.pathname === "/api/relay/verify") {
      const b = await body(req);
      const cfg = relayConfig(readKeys(defaultKeysFile()));
      if (!cfg.url || !cfg.key) return send(400, { error: "中转站没配好: 先在账号页填站点地址和令牌" });
      let models: string[] = Array.isArray(b.models) ? b.models.map(String) : [];
      if (!models.length) { const acct = (await accountsNow(false)).find((a) => a.id === "relay"); models = (acct?.models ?? []).map((m) => m.id); }
      if (!models.length) return send(400, { error: "没有可核实的模型 (令牌的模型列表是空的)" });
      // 2026-11-04 晚改 (站长: "不要再 DDOS 了 / 去模型广场看协议"): 每个模型只发 1 条按站标协议写的最小请求 (relay-verify.ts 自己发, 不经 Claude Code, 不重试);
      // 协议从账号页存的 relay_formats 读 (relay-route.ts), 只有 Chat 协议的不发
      const formats = readRelayFormats(defaultKeysFile());
      const ok = verifyJob.start(models, (m) => verifyRelayModel({ url: cfg.url, key: cfg.key, model: m, route: relayRoute(m, formats[m]).route }), (m, r) => { saveRelayVerified(defaultKeysFile(), m, r); accounts = null; });
      if (!ok) return send(409, { error: "已经有一轮核实在跑", ...verifyJob.status() });
      return send(200, { started: true, total: models.length });
    }
    // GET /api/stats: {models: [按模型汇总, 排行], shifts: [每班每角色]} (src/play/stats.ts, 只读记录目录)
    if (req.method === "GET" && u.pathname === "/api/stats") {
      const shifts = shiftStats(PLAY);
      return send(200, { models: modelStats(shifts), shifts });
    }
    // POST /api/world-name {world, name}: 改一个世界显示的标题 (存 <play>/world-names.json, 不动任何记录; 空名恢复原名)
    if (req.method === "POST" && u.pathname === "/api/world-name") {
      const b = await body(req);
      const id = String(b.world ?? "");
      const group = worldsOf(PLAY).find((w) => w.id === id);
      if (!id || !group) return send(404, { error: "没有这个世界" });
      try { setWorldName(PLAY, id, String(b.name ?? ""), group.name); }
      catch (e) { return send(400, { error: (e as Error).message }); }
      return send(200, { world: id, name: worldsOf(PLAY).find((w) => w.id === id)?.name ?? group.name });
    }
    if (req.method === "GET" && u.pathname === "/api/accounts") return send(200, { accounts: await accountsNow(u.searchParams.get("fresh") === "1") });
    // 下一班阵容: 和密钥放一起 <lab-data>/accounts/lineup.json
    // ?group=<群> / body.group: 读 / 改那个群的成员; 没给 = 全局的下一班阵容 (命令行开班用)
    if (req.method === "GET" && u.pathname === "/api/lineup") {
      const gid = u.searchParams.get("group");
      if (gid) { const g = readGroup(PLAY, gid); return g ? send(200, { seats: g.seats, group: g.id }) : send(404, { error: `没有这个群: ${gid.slice(0, 40)}` }); }
      const f = path.join(path.dirname(defaultKeysFile()), "lineup.json"); return send(200, { seats: readRoster(f), file: f });
    }
    if (req.method === "POST" && u.pathname === "/api/lineup") {
      const b = await body(req);
      try {
        if (b.group) return send(200, { seats: saveGroupSeats(PLAY, String(b.group), b.seats).seats, group: String(b.group) });
        return send(200, { seats: saveRoster(path.join(path.dirname(defaultKeysFile()), "lineup.json"), b.seats) });
      } catch (e) { return send(400, { error: (e as Error).message }); }
    }
    if (req.method === "POST" && u.pathname === "/api/login") {
      const id = String((await body(req)).provider ?? "") as ProviderId;
      const spec = PROVIDERS.find((p) => p.id === id);
      if (!spec) return send(400, { error: `没有这一家: ${id}` });
      const r = openLogin(id);
      if (!r) return send(400, { error: `本机没装 ${spec.label}`, install: spec.install });
      accounts = null; // 登完下一次读就重查
      return send(200, { opened: true, command: r.command });
    }
    if (req.method === "POST" && u.pathname === "/api/key") {
      const b = await body(req);
      const spec = KEY_PROVIDERS.find((p) => p.id === b.provider);
      if (!spec) return send(400, { error: `没有这一家: ${b.provider}` });
      const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
      try {
        if (spec.id === "relay") saveRelay(defaultKeysFile(), { key: str(b.key), url: str(b.url), model: str(b.model), access: str(b.access), user: str(b.user) });
        else saveKey(defaultKeysFile(), spec.id, String(b.key ?? ""));
      } catch (e) { return send(400, { error: (e as Error).message }); }
      accounts = null;
      return send(200, { account: await keyAccountOf(spec, defaultKeysFile()) });
    }
    if (req.method === "GET" && u.pathname === "/api/review") return send(200, runParam ? reviewFor(PLAY, runParam) : latestReview(PLAY));
    // 开班扫描: run.ts 开班时写的 world-scan.json (现状 / 判断 / 规划); 没有 → null
    if (req.method === "GET" && u.pathname === "/api/scan") {
      const d = runParam ? runDirOf(PLAY, runParam) : currentRun(PLAY);
      try { return send(200, d ? JSON.parse(fs.readFileSync(path.join(d, "world-scan.json"), "utf8")) : null); } catch { return send(200, null); }
    }
    // 蓝图预览入口: 这一班大脑看过 / 用过的蓝图 + 预览链接; POST /api/editor 起本机蓝图编辑器 (已开着就直接回); POST /api/open 只开编辑器自己的地址
    if (req.method === "GET" && u.pathname === "/api/blueprints") { const d = runParam ? runDirOf(PLAY, runParam) : currentRun(PLAY); return send(200, { editor: fbeUrl(), blueprints: d ? blueprintsOf(d) : [] }); }
    if (req.method === "POST" && u.pathname === "/api/editor") {
      try { editorStop ??= await ensureEditor(); return send(200, { url: fbeUrl() }); } catch (e) { return send(500, { error: (e as Error).message.slice(0, 300) }); }
    }
    if (req.method === "POST" && u.pathname === "/api/open") {
      const b = await body(req);
      const url = String(b.url ?? "");
      if (!url.startsWith(fbeUrl())) return send(400, { error: "只开本机蓝图编辑器的地址" });
      const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] as const : process.platform === "darwin" ? ["open", [url]] as const : ["xdg-open", [url]] as const;
      execFile(opener[0], [...opener[1]], { windowsHide: true }, () => undefined);
      return send(200, { opened: true, url });
    }
    if (req.method === "GET" && u.pathname === "/api/names") return send(200, { names: namesFor(u.searchParams.get("n") ?? "", zh) });
    const runDir = currentRun(PLAY);
    if (!runDir) return send(404, { error: "还没有任何一班的记录" });
    if (req.method === "GET" && u.pathname === "/api/brain") {
      const brainDir = runParam ? runDirOf(PLAY, runParam)! : runDir;
      const id = u.searchParams.get("agent") ?? "a";
      const detail = u.searchParams.get("detail") === "1";
      return send(200, { agent: id, lines: brainLines(brainDir, agentsOf(brainDir).length > 1 ? id : null, Number(u.searchParams.get("n") ?? 30), detail) });
    }
    if (req.method === "POST" && u.pathname === "/api/tell") { const b = await body(req); if (!b.text) return send(400, { error: "要 text" }); return send(200, await tell(runDir, b.agent ?? "a", String(b.text), b.scope === "team" ? "team" : "direct")); }
    if (req.method === "POST" && u.pathname === "/api/fh") { const b = await body(req); return send(200, await fh(runDir, b.agent ?? "a", String(b.args ?? ""))); }
    // 中途加人 / 移出 (src/play/roster-live.ts): 只往在跑那一班的 roster.jsonl 追加一行, run.ts 的监工 30 秒内照做
    if (req.method === "POST" && (u.pathname === "/api/roster/join" || u.pathname === "/api/roster/leave")) {
      const b = await body(req);
      const st = runStatus(runDir);
      if (st.ended || st.interrupted) return send(409, { error: "没有在跑的一班" });
      const file = path.join(runDir, ROSTER_FILE);
      if (!fs.existsSync(file)) return send(409, { error: "这一班开的时候还没有中途加人功能, 下一班才能用" });
      const at = new Date().toISOString();
      if (u.pathname === "/api/roster/join") {
        const seat = cleanSeat(b.seat);
        if (!seat) return send(400, { error: "seat 不对 (要 {brain, model})" });
        appendRosterOp(file, { at, op: "join", seat });
        return send(200, { queued: true, seat, run: path.basename(runDir) });
      }
      const agent = String(b.agent ?? "").trim();
      const a = agentsOf(runDir).find((x) => x.id === agent);
      if (!a) return send(404, { error: `这一班没有角色 ${agent.slice(0, 8)}` });
      if (!a.bot) return send(400, { error: "第 1 个角色 (玩家的身体) 不能移出" });
      appendRosterOp(file, { at, op: "leave", agent });
      return send(200, { queued: true, agent, run: path.basename(runDir) });
    }
    if (req.method === "POST" && u.pathname === "/api/stop") { fs.writeFileSync(path.join(runDir, "STOP"), "控制接口\n"); return send(200, { stopping: true, run: path.basename(runDir) }); }
    send(404, { error: "没有这个接口" });
  } catch (e) { send(500, { error: (e as Error).message.slice(0, 300) }); }
});
server.listen(Number(values.port), "127.0.0.1", () => console.log(`控制接口: http://127.0.0.1:${values.port}/api/state (只听本机)${sysProxy ? `; 用系统代理 ${sysProxy}` : ""}`));
