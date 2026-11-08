#!/usr/bin/env node
// 开班主循环: 一个 AI = 一个干净的真客户端 (独立版, 不装模组) + 游戏外的模组 + 玩家操作 + 大脑。沙盘和联机同一条路。
//   npm run run:online -- --lab [--save 存档.zip] --minutes 5                沙盘试: 本机起一个干净的服务器 (不装任何模组), 不叫模型
//   npm run run:online -- --server --read-only --minutes 5                   连 data/accounts/keys.json 的 server, 只读, 不叫模型 (上真服要用户在场)
//   npm run run:online -- --lab --brain claude --model opus --effort low --minutes 30   真模型 (Claude Code 订阅登录; 花额度, 用户说开才跑)
// --minutes 从进世界开始算。停: 记录目录里放 STOP 文件; 模型做完在角色目录放 DONE。
// --brain none|claude|claude-api|deepseek|relay|codex|grok|gemini (core/brains/driver.ts; 密钥在 data/accounts/keys.json), --model (没给按家默认, 中转站用 keys.json 的 relay_model), --effort low|medium|high, --compact-at token 数 (压缩点, 默认按模型 core/brains/hooks/context.ts)。
// codex / gemini / 中转站的 Responses 模型没有命令白名单钩子, 只能在本机的图上用 (--server 直接拒)。--name 不给 = 模型名规范写法 (lineup.ts botName)。
// --read-only 怎么保证只读: 不注入客户端、不发键鼠; 只有游戏外的进程 ReadProcessMemory 和读客户端日志; 所有动作在代理就拒了。对服务器只是多了一个站着不动的玩家。
// --backend auto|memory|rcon (默认 auto): 没填 RCON 走外挂; 填了 RCON 的自动: 先用干净客户端试进, 进得去 = 服务器没装模组, 走外挂, 一条 Lua 都不跑 (RCON 上跑了这张图就不能拿成就); 进不去就带上我们的模组再试, 进得去才走 RCON。
// --steam-pid 进程号: 不开新客户端, 挂到已经连着的 Steam 客户端 (操控用户的账号, 用户要拿成就: 只有玩家操作这条路; 用户自己在玩时不许用)。
// --own-world: 用户自己的新图, 没有协助模式。--lua: 只读时也注入客户端做只读查询 (流体、红绿线、物流网、别的玩家)。
// 同一个世界连续跑: 沙盘班收工存 <记录目录>/end.zip; 下一班 --save 那个 end.zip --notes 上一班的角色目录 (笔记接着传)。
// 还没搬进来的 (旧项目有): ./calc ./bp ./plan、换班不关游戏、看门狗、多角色 (docs/brains.md 的顺序)。
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { SandboxServer, freeTcpPort } from "../../game/sandbox/server.ts";
import { Viewer } from "../../game/sandbox/viewer.ts";
import { ROOT, dataRoot, factorioExe, findFactorioDir } from "../../game/sandbox/paths.ts";
import { RconClient } from "../../game/sandbox/rcon.ts";
import { loadDefines } from "../../game/sandbox/defines.ts";
import { hostArgs, venvPython, venvReady, HARNESS_MOD } from "../../game/offgame/host.ts";
import { clientReady } from "../../game/client/connect.ts";
import { pdbDumpExe } from "../../game/memory/read.ts";
import { BACKEND_PREFS, chooseBackend, cleanBackendPref, type BackendChoice, type BackendPref } from "../../commands/backend.ts";
import { CommandBroker, RconPipe } from "../../commands/broker.ts";
import { Body } from "../../commands/body.ts";
import { PlayerActions, readOnlyActions } from "../../commands/actions.ts";
import { startDragGuard } from "../../commands/drag-guard.ts";
import { readPlayer } from "../../commands/query.ts";
import { botNameCandidates, clientPhase, onlineBrief, parseHostPort, readServer, scrubClientLogs, scrubText, secretsOf, whereLine, type ClientPhase, type ServerConn } from "./online-lib.ts";
import { setupWorkspace } from "./workspace.ts";
import { writeScan } from "./scan.ts";
import { brainDriver, brainProblem, defaultModel, killBrain, runBrainTurn, type Driver } from "../brains/driver.ts";
import { brainLoop } from "../brains/loop.ts";
import { botName, modelDisplayName } from "../brains/lineup.ts";
import { brainSettings, compactAt, COMPACT_INSTRUCTIONS } from "../brains/hooks/context.ts";
import { appendScanHints, collectNotesLessons, lessonDelivery } from "./deliver.ts";
import { composeBrief } from "./brief.ts";
import { loadZhNames } from "../../commands/chattags.ts";
import { Supervisor } from "./supervisor.ts";
import { tellModel } from "./tell.ts";
import { HumanChatBridge, isUrgent, mentioned, tellText } from "./human-chat.ts";
import { pointsMd } from "./training.ts";
import { writeSummary } from "../records/summary.ts";
import { groupWorld, readGroup } from "../../src/play/groups.ts";
import { writeWorld } from "../../src/play/worlds.ts";
import { writeCurrentRun } from "../../src/play/shift-recover.ts";

const { values } = parseArgs({ options: {
  lab: { type: "boolean", default: false }, server: { type: "boolean", default: false }, save: { type: "string" }, "read-only": { type: "boolean", default: false },
  brain: { type: "string", default: "none" }, model: { type: "string" }, effort: { type: "string", default: "low" }, "compact-at": { type: "string" },
  minutes: { type: "string", default: "5" }, "own-world": { type: "boolean", default: false },
  name: { type: "string" }, "steam-pid": { type: "string" },
  keys: { type: "string" }, backend: { type: "string" }, reveal: { type: "boolean", default: false }, lua: { type: "boolean", default: false },
  "run-id": { type: "string" }, "goal-file": { type: "string" }, notes: { type: "string" }, group: { type: "string" },
} });
const toServer = values.server;
if (values.lab === toServer) { console.error("要 --lab (本机沙盘试) 或 --server (联机服务器), 二选一"); process.exit(2); }
if (values.backend !== undefined && !BACKEND_PREFS.includes(values.backend as BackendPref)) { console.error(`--backend 只能是 ${BACKEND_PREFS.join(" / ")}`); process.exit(2); }
const brain = values.brain!;
const keysFile = values.keys ?? path.join(dataRoot(), "accounts", "keys.json");
const model = values.model ?? defaultModel(brain, keysFile);
{ const bad = brainProblem(brain, model); if (bad) { console.error(bad); process.exit(2); } }
/** 游戏里的角色名 = 模型名规范写法 (--name 可改); 不叫模型的验证班叫 Test */
const roleName = values.name ?? botName(brain, 1, model);
if (!/^(low|medium|high|xhigh|max)$/.test(values.effort!)) { console.error("--effort 只能是 low / medium / high / xhigh / max"); process.exit(2); }
if (values["run-id"] !== undefined && !/^[\w-]{1,40}$/.test(values["run-id"])) { console.error("--run-id 只能是字母数字和 - _"); process.exit(2); }
for (const [ok, what] of [[clientReady(), "data/client (npm run client:setup)"], [venvReady(), "data/venv 里的 lupa (npm run offgame:setup)"], [fs.existsSync(pdbDumpExe()), "data/tools/pdb-dump.exe (npm run memory:setup)"]] as const) if (!ok) { console.error(`缺 ${what}`); process.exit(2); }
const prefer = cleanBackendPref(values.backend);
const reveal = values.reveal;
const readOnly = values["read-only"]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} 分] ${s}`);
const fwd = (p: string) => p.replace(/\\/g, "/");

// 哪个模型来玩: 开游戏之前就建驱动, 没登录、没填密钥别等进了世界才发现。模型手里只有这些工具; Bash 只放行我们的命令 (循环 / 管道由钩子 core/brains/hooks/permit.ts 放行)
const ALLOW = ["Bash(./fh *)", "Bash(./know *)", "Bash(./calc *)", "Bash(./bp *)", "Bash(./plan *)", "Read", "Edit", "Write", "Grep", "Glob"];
const CC_TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob"];
const ZH = "语言: 你输出的每一句话 (包括一两个词的短句、做事前后的小结)、笔记、游戏聊天都用简体中文; 工具回复是英文也照样用中文说。建筑、物品、科技用游戏官方中文名; 命令和参数里的内部名照写。";
let driver: Driver | null = null;
if (brain !== "none") {
  try { driver = await brainDriver({ brain, model, effort: values.effort!, allow: ALLOW, tools: CC_TOOLS, system: ZH, log, keysFile }); }
  catch (e) { console.error((e as Error).message); process.exit(2); }
  if (toServer && driver.unguarded) { console.error(`${brain} ${driver.unguarded}; 联机只能用 claude / claude-api / deepseek / relay (站标 Claude 格式的模型) / grok`); process.exit(2); }
  log(`大脑: ${driver.note}`);
}
let child: ChildProcess | null = null;
let supervisor: Supervisor | null = null;
let supTimer: NodeJS.Timeout | null = null, chatTimer: NodeJS.Timeout | null = null;
/** 真人说紧急, 打断了这一轮: 下一轮马上开, 不等 */
let urgentNow = false;

const runId = values["run-id"] ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
// --group <群 id>: 界面的群点"开班"走这里 (src/play/control.ts, 路线 memory); 记录放进 play/runs/<runId> 并带 world.json, 界面按世界列班次、接力找上一班 (src/play/groups.ts latestRunOfGroup)
const group = values.group ? readGroup(path.join(dataRoot(), "play"), values.group) : null;
if (values.group && !group) { console.error(`没有这个群: ${values.group}`); process.exit(2); }
const runDir = path.join(dataRoot(), "play", group ? "runs" : "online", runId);
const brainRoot = process.env.BRAIN_DIR ?? path.join(os.homedir(), "factorio-ai-brain");
const dir = path.join(brainRoot, `online-${runId}`, "a");
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(dir, { recursive: true });
if (group) writeWorld(runDir, groupWorld(group));
// --notes 上一班的角色目录 (或 notes.md 文件): 笔记一班班往下传; 这班的角色目录已有 notes.md 就不覆盖
if (values.notes) {
  const src = fs.existsSync(values.notes) && fs.statSync(values.notes).isDirectory() ? path.join(values.notes, "notes.md") : values.notes;
  if (!fs.existsSync(src)) { console.error(`--notes 找不到 ${src}`); process.exit(2); }
  if (!fs.existsSync(path.join(dir, "notes.md"))) fs.copyFileSync(src, path.join(dir, "notes.md"));
}
const stopFile = path.join(runDir, "STOP");
const pipe = `\\\\.\\pipe\\factorio-ai-online-${process.pid}`;

// 沙盘试: 本机起一个干净的服务器 (一个我们的模组都不装, 当联机服务器的替身)
const lab = new SandboxServer({ name: "online", view: false, clean: true });
const viewer = new Viewer("online-a", undefined, { playerName: roleName });
const gameExe = values["steam-pid"] ? factorioExe(findFactorioDir()) : factorioExe(viewer.factorioDir);
let target: Body | null = null;
let broker: CommandBroker | null = null;
let rconPipe: RconPipe | null = null;
let rcon: RconClient | null = null;
let server: ServerConn | null = null;
let dropWatch: NodeJS.Timeout | null = null;
let clientDown: string | null = null;
let clientPid = 0;
let choice: BackendChoice | null = null;
let code = 0;

/** 用户点过头的位置, 协助模式可以动别人的建筑: data/play/online/assist-allow.json {"positions":[{"x":1.5,"y":2.5,"why":"…"}]}; 每次现读, 班中改了立刻生效 */
function assistAllowed(at: { x: number; y: number }): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataRoot(), "play", "online", "assist-allow.json"), "utf8")) as { positions?: { x: number; y: number }[] };
    return (j.positions ?? []).some((p) => Math.hypot(p.x - at.x, p.y - at.y) < 0.6);
  } catch { return false; }
}

// 挂到用户的 Steam 客户端时, 日志在它自己的数据目录
const clientLog = values["steam-pid"] ? path.join(process.env.APPDATA ?? "", "Factorio", "factorio-current.log") : path.join(viewer.dir, "factorio-current.log");
const readClientLog = () => { try { return fs.readFileSync(clientLog, "utf8"); } catch { return ""; } };
const PHASE_ZH: Record<ClientPhase, string> = { starting: "启动中", connecting: "连接中", waiting_map: "等服务器存图", downloading: "下载地图", loading: "读地图", catching_up: "追进度", in_game: "进世界了", server_left: "服务器断了", disconnected: "断开了" };
const PROBE_NAME = "FactorioAI-Probe";
const JOIN_TIMEOUT_MS = 10 * 60_000;
/** 连接这一步最多等多久: 服务器没开时客户端会一直停在这里不报错 */
const CONNECT_TIMEOUT_MS = 90_000;

/** 大脑输出的一行 (Claude 形状): 命令和说的话进日志; 一轮的结果不是 success 也记 */
function logBrainEvent(ev: unknown): void {
  const m = ev as { type?: string; subtype?: string; is_error?: boolean; result?: unknown; message?: { content?: { type?: string; name?: string; input?: { command?: unknown }; text?: string }[] } };
  if (m.type === "assistant") for (const b of m.message?.content ?? []) {
    if (b.type === "tool_use" && b.name === "Bash") log(`  大脑: ${String(b.input?.command ?? "").slice(0, 140)}`);
    else if (b.type === "text" && b.text?.trim()) log(`  大脑说: ${b.text.trim().replace(/\s+/g, " ").slice(0, 160)}`);
  }
  if (m.type === "result" && (m.is_error || m.subtype !== "success")) log(`  这一轮结束: ${m.subtype} ${String(m.result ?? "").slice(0, 200)}`);
}

/** 等客户端日志说进了世界 (不注入客户端, 只读模式靠这个)。连不上回原因, 不干等 */
async function waitInGame(): Promise<string | null> {
  const start = Date.now();
  let last: ClientPhase | null = null, badSince = 0, phaseSince = start;
  while (Date.now() - start < JOIN_TIMEOUT_MS) {
    const { phase, reason } = clientPhase(readClientLog());
    if (phase !== last) { log(`客户端: ${PHASE_ZH[phase]}`); last = phase; phaseSince = Date.now(); }
    if (phase === "in_game") return null;
    if (phase === "connecting" && Date.now() - phaseSince > CONNECT_TIMEOUT_MS) return `${CONNECT_TIMEOUT_MS / 1000} 秒没连上 (服务器没开, 或地址、端口不对)`;
    if (phase === "disconnected" || phase === "server_left") {
      badSince ||= Date.now();
      if (Date.now() - badSince > 3000) return reason ?? PHASE_ZH[phase];
    } else badSince = 0;
    if (!viewer.alive) return "客户端退出了";
    if (fs.existsSync(stopFile)) return "放了 STOP";
    await sleep(1000);
  }
  return `${JOIN_TIMEOUT_MS / 60_000} 分钟没进世界, 卡在${last ? PHASE_ZH[last] : "启动"}`;
}

/** 客户端连服务器 (默认干净的, 不带模组): 进世界回 null, 进不去回原因 (已抹掉地址和密码) */
async function joinClient(conn: ServerConn, clientMods: string[] = []): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try { fs.rmSync(clientLog, { force: true }); } catch { /* 还占着: 游戏启动时自己会换 */ }
    // 带模组那次只是试探: 用专门的名字, 不然服务器上留下一个叫正式名字的玩家, 之后造服务器角色会撞名
    const p = viewer.launch(0, { address: conn.address, password: conn.password, clientMods, ...(clientMods.length ? { as: PROBE_NAME } : {}) });
    clientPid = p.pid!;
    const problem = await waitInGame();
    if (problem === null) return null;
    const safe = scrubText(problem, secretsOf(conn));
    // 第一次连也可能是 Connection refused, 几秒后再连就进了: 再试一次。密码错、模组不一样也都是这一句 (原因只在服务器日志里), 所以不多试
    const refused = /refused/i.test(safe);
    if (!refused || attempt >= 2 || clientMods.length) return `${safe}${refused ? " (服务器拒绝了: 密码错、服务器的模组和客户端不一样, 客户端日志都只有这一句)" : ""}`;
    log(`连不上 (${safe}), 5 秒后再试一次`);
    viewer.close();
    await sleep(5000);
  }
}
/** 连上 RCON, 查服务器有没有 harness 模组。这是一条 Lua: 跑了这张图就不能拿成就, 只在用户选了 RCON 或已经知道服务器装了它时才查 */
async function probeHarness(r: { address: string; password: string }): Promise<boolean> {
  const at = parseHostPort(r.address);
  if (!at) throw new Error("RCON 地址要写成 主机:端口");
  rcon = new RconClient({ host: at.host, port: at.port, password: r.password, connectDeadlineMs: 20_000 });
  await rcon.connect();
  for (let i = 0; i < 4; i++) {
    const out = (await rcon.exec(`/silent-command rcon.print(remote.interfaces.agent_harness and "harness-yes" or "harness-no")`, { retry: true })).trim();
    if (out === "harness-yes") return true;
    if (out === "harness-no") return false;
  }
  throw new Error("RCON 连上了, 但答不上来有没有模组");
}
/** 定走哪条路, 走外挂的话客户端也进了世界 */
async function connectServer(conn: ServerConn): Promise<BackendChoice> {
  const fail = (p: string) => new Error(`进不去服务器: ${p}`);
  if (prefer === "rcon") {
    const c = chooseBackend({ kind: "server", rcon: !!conn.rcon, prefer, ...(conn.rcon ? { harnessOnServer: await probeHarness(conn.rcon) } : {}) });
    if (c.problem) throw fail(c.problem);
    return c;
  }
  const problem = await joinClient(conn);
  if (problem === null) return chooseBackend({ kind: "server", rcon: !!conn.rcon, prefer, ...(conn.rcon ? { harnessOnServer: false } : {}) });
  if (prefer === "memory" || !conn.rcon) throw fail(problem);
  viewer.close();
  await sleep(2000);
  log("干净客户端进不去; 带上我们的模组再试一次 (进得去 = 服务器装了它; 这一步不跑 Lua)");
  const withMod = await joinClient(conn, [HARNESS_MOD]);
  if (withMod !== null) throw fail(`${problem}; 带上我们的模组也进不去`);
  viewer.close();
  if (!(await probeHarness(conn.rcon))) throw fail("带上模组进得去, 但 RCON 调不到它");
  return chooseBackend({ kind: "server", rcon: true, harnessOnServer: true, prefer });
}

try {
  // 1. 客户端: 挂到已有的 Steam 客户端, 或开一个干净的独立版
  if (values["steam-pid"]) {
    if (prefer === "rcon") throw new Error("--steam-pid 操控用户的账号要拿成就, 不走 RCON");
    clientPid = Number(values["steam-pid"]);
    log(`挂到已有客户端 ${clientPid} (${readOnly ? "只读内存" : "操控这个账号的身体, 只走玩家操作"})`);
  } else {
    if (!viewer.playerName) throw new Error("开新客户端要 .env 的 FACTORIO_VIEWER_DIR (独立版), 不用 Steam 版: 不碰用户的账号");
    if (toServer) {
      server = readServer(keysFile);
      if (!server) throw new Error("keys.json 里没有 server (地址和密码只放本机 data/accounts/keys.json)");
      log(`连服务器 (地址和密码不写进日志); 选项 ${prefer}`);
      choice = await connectServer(server);
      log(`走哪条路: ${choice.why}`);
    } else {
      if (values.save) { lab.prepare(); fs.copyFileSync(values.save, lab.savePath("m")); }
      else { log("开一张新图 (干净的服务器, 不装任何模组)"); await lab.createMap("m"); }
      await lab.start("m");
      try { fs.rmSync(clientLog, { force: true }); } catch { /* 还占着 */ }
      // 按"连别人的服务器"的方式连 (address 形式 = 客户端不带任何我们的模组): 服务器是干净的, 客户端带了沙盘模组会被拒 (Connection refused, 2026-11-07 第一次跑查出)
      const p = viewer.launch(0, { address: `127.0.0.1:${lab.gamePort}` });
      clientPid = p.pid!;
      const problem = await waitInGame();
      if (problem !== null) throw new Error(`进不去沙盘: ${problem}`);
      // 沙盘是联机服务器的替身: 一条控制台命令都不发 (发了这张图就不算成就, 和真服一样)。开场动画按游戏提示的键跳过 (下面), 起始物资就是游戏给的。
      // defines.json 由沙盘测试 / 演示导出过 (在原型目录); 没有的话 dumpDefines 会经 RCON 读, 那是控制台命令 → 这里先查, 缺了就报怎么补
      if (!fs.existsSync(path.join(lab.prototypesDir(), "defines.json"))) throw new Error(`缺 ${path.join(lab.prototypesDir(), "defines.json")}: 先跑一次 npm run test:sandbox 或 npm run sandbox:demo 导出 (这里不经控制台读)`);
    }
  }
  const deadline = Date.now() + Number(values.minutes) * 60_000;
  const useRcon = choice?.backend === "rcon";
  // 2. 走外挂要动手才注入客户端; 只读默认不注入 (给 --lua 才注入, 只读 Lua, 不发键鼠); 走 RCON 没有客户端
  const useLua = !useRcon && (!readOnly || values.lua);
  let name = roleName;
  const protoDir = lab.prototypesDir();
  if (useLua) {
    target = new Body(await freeTcpPort(), loadDefines(protoDir), { gameExe });
    await target.start(log);
    await target.attach(clientPid);
    for (let i = 0; i < 90; i++) { const s = await target.status().catch(() => null); if (s?.state === "in_game") break; if (i === 89) throw new Error(`挂上了但 3 分钟没等到进世界: ${JSON.stringify(s?.raw ?? null).slice(0, 300)}`); await sleep(2000); }
    await target.prepare();
    if (!readOnly) { const stopGuard = startDragGuard(clientPid, log); process.on("exit", stopGuard); }
    // 新图的坠机过场 (freeplay 场景, 12.5 秒) 不用控制台: 游戏自己提示"按确认消息键跳过", 按一下; 没跳也等它自己结束
    if (!readOnly) {
      const cutscene = target.defines?.controllers?.cutscene;
      for (let i = 0; i < 40; i++) {
        const p = await readPlayer(target.call);
        if (p.hasCharacter && (cutscene === undefined || Number(p.controllerType) !== Number(cutscene))) { if (i) log(`开场动画结束 (${(i * 0.5).toFixed(1)} 秒)`); break; }
        if (i === 0) await target.pressKey(target.controls?.key("confirm-message") ?? "TAB").catch(() => undefined);
        await sleep(500);
      }
    }
    const me = await readPlayer(target.call);
    name = me.name || name;
    if (!me.hasCharacter) log("这个玩家没有身体 (观战 / 死了?): 动作会失败");
    if (!readOnly && (await target.ensureBody())) log("角色进世界时开着地图 (远程视图), 退出来了");
    const used = await target.call("world_query", { selection: { kind: "inspect", target: { kind: "game" }, path: [{ property: "console_command_used" }] }, limit: 4 });
    log(`这张图用过控制台命令吗 (game.console_command_used): ${JSON.stringify(used.ok ? (used.data as { objects?: { value?: unknown }[] })?.objects?.[0] ?? used.data : used.error).slice(0, 200)}`);
  }
  if (useRcon) {
    let misses = 0;
    dropWatch = setInterval(() => { rcon!.exec("/version").then(() => { misses = 0; }, () => { if (++misses >= 3) clientDown = "RCON 断了"; }); }, 20_000);
  } else {
    dropWatch = setInterval(() => { const { phase, reason } = clientPhase(readClientLog()); if (phase !== "in_game" && phase !== "catching_up") clientDown = scrubText(reason ?? PHASE_ZH[phase], server ? secretsOf(server) : []); }, 5000);
  }

  // 3. 走 RCON: ./fh 经管道直接到服务器上的模组; 走外挂: 游戏外的模组 + 行动层
  const probeArgs = hostArgs({ defines: path.join(protoDir, "defines.json"), proto: path.join(protoDir, "data-raw-dump.json"), pid: clientPid, exe: gameExe, extra: ["--state", path.join(runDir, "ledger.lua"), ...(reveal ? ["--reveal"] : []), ...(readOnly ? ["--read-only"] : []), "--serve"] });
  const raw = JSON.parse(fs.readFileSync(path.join(protoDir, "data-raw-dump.json"), "utf8")) as { recipe?: Record<string, { energy_required?: number }> };
  // 每种建筑的下一档 (原型的 next_upgrade): upgrade 用
  const upgradeOf = new Map<string, string>();
  for (const rows of Object.values(raw as Record<string, Record<string, { next_upgrade?: unknown }>>)) for (const [n, p] of Object.entries(rows ?? {})) if (p && typeof p === "object" && typeof p.next_upgrade === "string") upgradeOf.set(n, p.next_upgrade);
  const t = target;
  // 教训: 训练集里核实过的种子 + 之前各班模型记的, 做对应动作时行动层在回复里带出 (动作不经过模组; core/run/deliver.ts)
  const delivery = !useRcon && !readOnly && t ? lessonDelivery() : null;
  if (delivery) log(`教训: 种子 ${delivery.curated} 条 + 之前各班的 ${delivery.learned} 条, 做对应动作时带出`);
  const actions = useRcon ? null : readOnly || !t ? readOnlyActions(() => broker!.tick()) : new PlayerActions({
    call: t.call, controls: () => t.controls!, defines: () => t.defines, tick: () => t.tick(),
    holdItem: (i) => t.holdItem(i), placeHeld: (at) => t.placeHeld(at), clearCursor: () => t.clearCursor(), ensureBody: () => t.ensureBody(), setRecipe: (at, r) => t.setRecipe(at, r),
    insertExact: (at, i, n, inv) => t.insertExactDirect(at, i, n, inv), takeExact: (at, i, n, inv) => t.takeExactDirect(at, i, n, inv), itemCount: (at, inv, i) => t.entityItemCount(at, inv, i),
    stacks: () => t.inventorySlots(), chatSend: (x) => t.chatSend(x), recipeTime: (r) => raw.recipe?.[r]?.energy_required ?? (raw.recipe?.[r] ? 0.5 : null),
    assist: values["own-world"] ? undefined : { me: name, allowed: assistAllowed }, me: name, lessons: delivery?.pick,
    // 放不下时问模组 placements 找附近放得下的位置 (代理在下面才建, 用到时已经有了)
    read: (action, args, act) => (broker ? broker.read(action, args, act) : Promise.resolve(null)),
    nextUpgrade: (name) => upgradeOf.get(name) ?? null, setRequest: (at, item, min, max) => t.setRequest(at, item, min, max),
  });
  if (useRcon) {
    const conn = rcon!;
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(name)) throw new Error(`角色名不合规矩: ${name}`);
    rconPipe = new RconPipe({ pipe, send: (c) => conn.exec(c), readOnly, actions: readOnly ? readOnlyActions(async () => Number((await conn.exec(`/silent-command rcon.print(game.tick)`)).trim()) || 1) : null });
    await rconPipe.start();
    if (!readOnly) {
      for (const candidate of botNameCandidates(name)) {
        const made = (await conn.exec(`/silent-command local ok, r = pcall(remote.call, "agent_harness", "bot_create", "${candidate}") rcon.print(type(r) == "table" and helpers.table_to_json(r) or tostring(r))`)).trim();
        if (/already exists|unit_number/.test(made)) { name = candidate; break; }
        if (!/a player is named/.test(made) || candidate.endsWith("-5")) throw new Error(`造服务器角色 ${candidate} 失败: ${made.slice(0, 200)}`);
      }
    }
    log(`RCON + 模组; ${readOnly ? "只读 (没造角色, 读请求走 Lua)" : `服务器角色 ${name}`}, 不叫模型`);
  } else {
    // 模型问管理员的话: 记下来报在日志里 (界面那块接上后进界面)
    const onOperator = (text: string) => { fs.appendFileSync(path.join(runDir, "operator.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), text })}\n`); log(`模型问管理员: ${text.replace(/\s+/g, " ").slice(0, 400)}`); };
    broker = new CommandBroker({ pipe, python: venvPython(), probeArgs, mode: "server", rcon: null, actions, luaRead: useLua && t ? (a) => t.call("world_query", a) : null, onOperator });
    log("起游戏外的模组 (平时几秒; 第一次要从游戏符号算布局, 约 1~2 分钟)");
    await broker.start();
    const where = await broker.where();
    if (readOnly && where.player.name) name = where.player.name;
    fs.writeFileSync(path.join(runDir, "where.json"), JSON.stringify(where, null, 1));
    log(`游戏外的模组起来了; ${whereLine(where)}`);
    log(`${readOnly ? (useLua ? "只读 (注入了客户端, 只读 Lua, 不发键鼠)" : "只读 (没注入客户端)") : "动作走玩家操作"}${useLua ? ", 流体红绿线物流网别的玩家问注入的 Lua" : ""}${reveal ? ", 没探过的区块也读" : ""}, 不叫模型`);
  }

  // 4. 角色目录: 简报 + ./fh (sh 和 ps1), 经管道; 模型手里没有 RCON
  // 简报 = 训练集的模板 (manuals/brief.md) + 世界真实值那一节 + 用户目标 + 手册目录; 大脑会话再加压缩说明
  const world = onlineBrief({ name, server: toServer, readOnly, steam: !!values["steam-pid"], rcon: useRcon, ownWorld: values["own-world"] });
  const goal = values["goal-file"] && !readOnly ? fs.readFileSync(values["goal-file"], "utf8") : undefined;
  const ws = setupWorkspace({ dir, name, pipe, deadline, protoDir, brief: (refDir) => composeBrief({ world, name, refDir, goal }) + (driver ? COMPACT_INSTRUCTIONS : "") });
  log(`手册目录 ref/ ${ws.refFiles} 个文件; ./know 查积累`);
  // 大脑会话的设置 (只在角色目录生效): 压缩点、钩子 (命令放行、读文件禁区、压缩前后、收件箱); .context-hooks 标记让钩子只在这里起作用
  const at = Number(values["compact-at"] ?? compactAt(model));
  if (driver) {
    const hookCmd = (event: string, ...extra: string[]) => [`'${fwd(process.execPath)}'`, `'${fwd(path.join(ROOT, "core", "brains", "hooks", "hook.ts"))}'`, event, ...extra].join(" ");
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify(brainSettings(at, hookCmd), null, 2));
    fs.writeFileSync(path.join(dir, ".context-hooks"), "");
  }
  log(`角色目录 ${dir}; 记录 ${runDir}; 停: 放 STOP 文件`);
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId, name, dir, server: toServer, backend: choice?.backend ?? "memory", why: choice?.why ?? "沙盘试外挂", prefer, reveal, readOnly, brain, model, effort: values.effort, compactAt: at, steam: !!values["steam-pid"], group: values.group ?? null, startedAt: new Date().toISOString() }, null, 1));
  // 界面的角色列表 / 对话 / 输入框认 session.json (src/play/control-lib.ts agentsOf): 游戏名、模型显示名、角色目录; 没有 RCON (route memory), 说话写记录目录的 tell.txt (src/play/control.ts tell)
  // account: 挂在用户 Steam 客户端上 (--steam-pid, "我 · 管理员"那行选的模型) 才是在操控用户的账号; 沙盘 / 联机的独立版角色不是
  fs.writeFileSync(path.join(runDir, "session.json"), JSON.stringify({ name, model: modelDisplayName(brain, model), seat: { brain, model }, player: 1, dir, route: useRcon ? "rcon" : "memory", account: !!values["steam-pid"] }, null, 1));
  // 界面的"停班"和外壳按 play/current-run.json 找在跑的那一班 (src/play/control.ts currentRun / app 的 stop_run); 群开的班记一下
  if (group) writeCurrentRun(path.join(dataRoot(), "play"), { runId, runDir, brainDir: dir, instanceDir: lab.dir, startedAt: new Date().toISOString() });

  // 开班扫描: 现状写成 world-scan.md (Lua 跑在游戏外的假接口上, 服务器上一条都不跑); 第一轮提示词让模型先读
  let scanNote = "";
  if (broker) {
    const b = broker;
    try {
      log(`开班扫描: ${await writeScan((c) => b.evalLua(c), dir, runDir)}`);
      scanNote = "先读 world-scan.md (开班扫描: 按读数自动算的现状和相关要点), ";
      // 扫描的句子对得上的要点附在后面 (被动推送, 不等模型自己查)
      const sj = JSON.parse(fs.readFileSync(path.join(runDir, "world-scan.json"), "utf8")) as { stage?: string; lines?: string[] };
      const n = appendScanHints(path.join(dir, "world-scan.md"), [sj.stage ?? "", ...(sj.lines ?? [])]);
      if (n) log(`开班扫描附了 ${n} 条要点`);
    } catch (e) { log(`开班扫描没做成: ${(e as Error).message.slice(0, 200)}`); }
  }

  // 监工 + 真人聊天 (能动手时就开, 不叫模型的验证班也开: 话经模组账本 tell 进下一条回复)。只给事实: 闲了催、体检、研究队列空、产量播报、截止提醒、工具诉求
  const zhNames = loadZhNames(protoDir);
  const zh = (n: string) => zhNames.get(n) ?? n;
  if (broker && !readOnly && t) {
    const b = broker, tt = t;
    const tell = (text: string, from?: string) => tellModel(b, { to: name, dir, runDir, text, from });
    const idle = { ...(process.env.FA_IDLE_MS ? { idleMs: Number(process.env.FA_IDLE_MS), spawnIdleMs: Number(process.env.FA_IDLE_MS) } : {}), ...(process.env.FA_GRACE_MS ? { graceMs: Number(process.env.FA_GRACE_MS) } : {}) };
    supervisor = new Supervisor({ evalLua: (c) => b.evalLua(c), player: async () => { const p = await readPlayer(tt.call); return { x: p.position.x, y: p.position.y, hasCharacter: p.hasCharacter }; }, tell, journal: path.join(dir, "journal.jsonl"), runDir, t0: Date.now(), deadline, zh, log, points: pointsMd(), idle });
    supTimer = setInterval(() => void supervisor!.tick(), 30_000);
    // 真人的话: 自己客户端的聊天 + 管理员写在记录目录的 tell.txt; 进模型下一条回复, 说紧急才打断这一轮
    const bridge = new HumanChatBridge(tt, { self: name, aiNames: () => [] });
    await bridge.start().catch(() => undefined);
    let chatBusy = false;
    const interrupt = () => { if (child) { urgentNow = true; killBrain(child); } };
    chatTimer = setInterval(() => {
      if (chatBusy) return;
      chatBusy = true;
      void (async () => {
        const tellFile = path.join(runDir, "tell.txt");
        if (fs.existsSync(tellFile)) {
          const said = fs.readFileSync(tellFile, "utf8").trim();
          fs.rmSync(tellFile);
          if (said) { const urgent = isUrgent(said); await tell(tellText("界面", "管理员", said, "direct", urgent), "管理员"); log(`管理员的话转给模型: ${said.replace(/\s+/g, " ").slice(0, 120)}`); if (urgent) interrupt(); }
        }
        for (const m of await bridge.poll()) {
          const urgent = isUrgent(m.text);
          const scope = mentioned(m.text, [{ id: "a", name }]).length ? "direct" : "team";
          await tell(tellText("游戏聊天", m.from, m.text, scope, urgent), m.from);
          fs.appendFileSync(path.join(runDir, "chat.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), from: m.from, text: m.text, scope, urgent })}\n`);
          log(`真人 ${m.from} 说话, 转给模型${urgent ? " (紧急, 打断这一轮)" : ""}`);
          if (urgent) interrupt();
        }
      })().catch((e: Error) => log(`读聊天出错: ${e.message.slice(0, 120)}`)).finally(() => { chatBusy = false; });
    }, 5000);
    log("监工和真人聊天开着 (30 秒一采样, 5 秒一看聊天; 管理员要说话写记录目录的 tell.txt)");
  }

  // 5. 大脑 (不叫模型时只等到点, 留给人在角色目录里试 ./fh)
  const doneFile = path.join(dir, "DONE");
  const viewerAlive = () => useRcon ? true : values["steam-pid"] ? (() => { try { process.kill(clientPid, 0); return true; } catch { return false; } })() : viewer.alive;
  const stopped = () => Date.now() >= deadline || fs.existsSync(stopFile) || fs.existsSync(doneFile) || !viewerAlive() || clientDown !== null;
  if (!driver) {
    log("不叫模型: 等到点或 STOP; 这段时间可以在角色目录里跑 ./fh");
    while (!stopped()) await sleep(2000);
  } else {
    // 一轮一个命令行进程, 会话号接力 (第 1 轮新建, 之后 --resume); 停了就连子进程一起杀 (模型正在跑的 ./fh 也要停)
    const GOAL = values["goal-file"] && !readOnly ? `\n\n用户这一班给你的任务:\n${fs.readFileSync(values["goal-file"], "utf8").trim()}` : "";
    const FIRST = `先读 CLAUDE.md 最前面"先读这一节", 再读 notes.md。${scanNote}然后 ./fh call status 和 ./fh call observe 看清楚世界、队友在做什么、缺什么; ${readOnly ? "现在只读, 动作和聊天都发不出去, 不要试; 把看到的写进 notes.md。" : values["own-world"] || !toServer ? "然后先跑 ./plan automation-science-pack 30 看整条红瓶线要几台、放哪 (加 --build 一条命令放整块; 手放也行), 再动手。" : "在聊天里用一句话打招呼说你是谁、打算帮什么 (./fh call say), 然后动手 (整条线用 ./plan 物品 每分钟 --build, 手放也行)。"}${GOAL}`;
    // 第一版的 "继续。先看 status 有没有新消息; 真人的话先回" 被当成"汇报一下": Sonnet 2026-11-08 那班 17 轮里 12 轮不到 1 分钟就收 (查状态、补一次煤、写小结), 每轮重起进程重读上下文
    const NEXT = `接着干, 一直干到截止 (deadline.txt), 这一轮不用汇报、不用等任何人回话。顺手看一眼 ./fh call status 的消息和报警, 真人的话回一句就继续建。目标是机器做出科技包: 整条线用 ./plan 物品 每分钟 --build (料不够它会说差什么)。全程简体中文, 一两个词的小结也是。学到的写进 notes.md。${GOAL}`;
    // 上一轮不到 3 分钟就收了 (写了小结就停): 这一轮把话说死 —— 每轮重起进程要重读整段上下文, 短轮次纯浪费 (Sonnet 11-08 两班第 3 轮起都是几十秒一轮)
    const NEXT_SHORT = (sec: number) => `上一轮你只跑了 ${sec} 秒就停了, 没必要: 不用写小结、不用等人, 停下来只会浪费时间。这一轮一直发命令建东西, 直到截止 (deadline.txt) 或者你真的做完了 (做完就放 DONE 文件); 中途不要结束回合。目标还是机器做出科技包 (./plan 物品 每分钟 --build 能一条命令放整条线)。全程简体中文。${GOAL}`;
    const nextPrompt = ({ lastMs, n }: { lastMs: number; n: number }) => (n > 2 && lastMs < 3 * 60_000 ? NEXT_SHORT(Math.round(lastMs / 1000)) : NEXT);
    let sessionId = randomUUID();
    const watch = setInterval(() => { if (child && stopped()) killBrain(child); }, 2000);
    log(`大脑 ${brain} ${model} (强度 ${values.effort}, 压缩点 ${at}); 停: 放 STOP 文件, 模型做完会在角色目录放 DONE`);
    await brainLoop({
      turn: async (n, prompt) => {
        const r = await runBrainTurn(driver!, { n, sessionId, prompt, cwd: dir, runDir, model, onChild: (c) => { child = c; }, onEvent: (ev) => logBrainEvent(ev) });
        sessionId = r.sessionId;
        return r.code;
      },
      stopped, first: FIRST, next: nextPrompt, log,
      interrupted: () => { const u = urgentNow; urgentNow = false; return u; },
    });
    clearInterval(watch);
  }
  if (supTimer) clearInterval(supTimer);
  if (chatTimer) clearInterval(chatTimer);
  const why = clientDown !== null ? `掉线 (${clientDown})` : fs.existsSync(stopFile) ? "STOP" : fs.existsSync(doneFile) ? "模型说任务做完了" : viewerAlive() ? "到点" : "客户端关了";
  // 模型这班记的教训 (notes.md "## 教训") 收进训练集待核区, 留给以后的班 (通用的才记; 带坐标、只对这局有用的筛掉)
  let collected = 0;
  if (driver && !readOnly) {
    try {
      const m = collectNotesLessons(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), zhNames, model, runId);
      collected = m.added;
      log(`教训: 笔记里 ${m.candidates} 条, 收进待核区 ${m.added} 条${m.skipped.length ? ` (跳过 ${m.skipped.length}: ${m.skipped.slice(0, 2).map((s) => s.why).join(" / ")})` : ""}`);
    } catch (e) { log(`收教训没做成: ${(e as Error).message.slice(0, 160)}`); }
  }
  // 班末总结和复盘 (core/records/summary.ts): summary.json + review.md
  if (supervisor || driver) {
    try {
      const r = writeSummary({ runDir, dir, runId, brain, model, minutes: Number(values.minutes), why, supervisor: supervisor?.stats ?? {}, lessons: delivery ? { ...delivery.stats(), collected } : null, zh });
      log(`复盘: ${r.lines.slice(0, 2).join(" | ")}; 下一班先修 ${r.fixes.length} 条 (review.md)`);
    } catch (e) { log(`总结没写成: ${(e as Error).message.slice(0, 160)}`); }
    // 群的接力 (src/play/groups.ts latestRunOfGroup) 从 summary.json 读上一班的大脑目录和名单 (全是 none 的验证班不进接力): 补上这两个字段
    try { const f = path.join(runDir, "summary.json"); const s = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>; fs.writeFileSync(f, JSON.stringify({ ...s, brainDir: dir, lineup: [{ brain, model }] }, null, 1)); } catch { /* 总结没写成 */ }
  }
  if (broker) {
    log(`收工: ${why}; 走哪条路 ${JSON.stringify(Object.fromEntries(Object.entries(broker.stats.byAction).map(([k, v]) => [k, `${v.route}×${v.n} ${Math.round(v.ms / Math.max(v.n, 1))} 毫秒`])))}${delivery ? `; 教训带出 ${delivery.stats().shown} 次 (${delivery.stats().distinct} 条)` : ""}`);
    fs.writeFileSync(path.join(runDir, "probe-stats.json"), JSON.stringify({ broker: broker.stats, probe: await broker.probeStats().catch((e: Error) => ({ error: e.message })), lessons: delivery?.stats() ?? null }, null, 1));
  } else log(`收工: ${why}; RCON 发了 ${rconPipe?.stats.sent ?? 0} 条, 拒了 ${rconPipe?.stats.refused ?? 0} 条`);
  fs.writeFileSync(path.join(runDir, "end.json"), JSON.stringify({ why, endedAt: new Date().toISOString(), minutes: Math.round((Date.now() - t0) / 6000) / 10 }, null, 1));
  // 同一个世界连续跑 (用户的硬要求): 收工前存一次档 (/server-save 是服务器命令, 不是 Lua, 和 /version 探针一样不碰成就标记), 复制成 end.zip; 下一班 --save 它 --notes 这班的角色目录接着玩。
  // 之前每班都从空手开新图, 30 分钟永远停在烧煤阶段 (2026-11-08 三班都是), 比不出工具有没有用
  if (values.lab && !readOnly) {
    try { const f = await lab.saveNow(); fs.copyFileSync(f, path.join(runDir, "end.zip")); log(`存档: ${path.join(runDir, "end.zip")}; 下一班接着玩: --save 它 --notes ${dir}`); }
    catch (e) { log(`收工存档没成: ${(e as Error).message.slice(0, 160)}`); }
  }
} catch (e) {
  console.error("出错", server ? scrubText(String((e as Error).stack ?? e), secretsOf(server)) : e);
  code = 2;
} finally {
  if (dropWatch) clearInterval(dropWatch);
  if (supTimer) clearInterval(supTimer);
  if (chatTimer) clearInterval(chatTimer);
  killBrain(child);
  await driver?.close?.().catch(() => undefined);
  await broker?.stop().catch(() => undefined);
  await rconPipe?.stop().catch(() => undefined);
  (rcon as RconClient | null)?.close();
  await target?.stop().catch(() => undefined);
  if (!values["steam-pid"]) viewer.close();
  if (values.lab) await lab.stop({ save: false }).catch(() => undefined);
  if (server) { await sleep(1500); log(`抹掉客户端日志里的地址和密码: ${scrubClientLogs(viewer.dir, server)} 个文件`); }
}
process.exit(code);
