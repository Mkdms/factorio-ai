#!/usr/bin/env node
// 开班主循环: 一个 AI = 一个干净的真客户端 (独立版, 不装模组) + 游戏外的模组 + 玩家操作 + 大脑。沙盘和联机同一条路。
//   npm run run:online -- --lab [--save 存档.zip] --minutes 5                沙盘试: 本机起一个干净的服务器 (不装任何模组), 不叫模型
//   npm run run:online -- --server --read-only --minutes 5                   连 data/accounts/keys.json 的 server, 只读, 不叫模型 (上真服要用户在场)
//   npm run run:online -- --lab --brain claude --minutes 30                  真模型 (大脑那块搬进来之前报错)
// --minutes 从进世界开始算。停: 记录目录里放 STOP 文件; 模型做完在角色目录放 DONE。
// --read-only 怎么保证只读: 不注入客户端、不发键鼠; 只有游戏外的进程 ReadProcessMemory 和读客户端日志; 所有动作在代理就拒了。对服务器只是多了一个站着不动的玩家。
// --backend auto|memory|rcon (默认 auto): 没填 RCON 走外挂; 填了 RCON 的自动: 先用干净客户端试进, 进得去 = 服务器没装模组, 走外挂, 一条 Lua 都不跑 (RCON 上跑了这张图就不能拿成就); 进不去就带上我们的模组再试, 进得去才走 RCON。
// --steam-pid 进程号: 不开新客户端, 挂到已经连着的 Steam 客户端 (操控用户的账号, 用户要拿成就: 只有玩家操作这条路; 用户自己在玩时不许用)。
// --own-world: 用户自己的新图, 没有协助模式。--lua: 只读时也注入客户端做只读查询 (流体、红绿线、物流网、别的玩家)。
// 还没搬进来的 (旧项目有): 大脑驱动、真人聊天进模型回复、教训自动带出、./know ./calc ./bp、监工和体检。
import fs from "node:fs";
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

const { values } = parseArgs({ options: {
  lab: { type: "boolean", default: false }, server: { type: "boolean", default: false }, save: { type: "string" }, "read-only": { type: "boolean", default: false },
  brain: { type: "string", default: "none" }, minutes: { type: "string", default: "5" }, "own-world": { type: "boolean", default: false },
  name: { type: "string", default: "Claude-Opus" }, "steam-pid": { type: "string" },
  keys: { type: "string" }, backend: { type: "string" }, reveal: { type: "boolean", default: false }, lua: { type: "boolean", default: false },
  "run-id": { type: "string" }, "goal-file": { type: "string" },
} });
const toServer = values.server;
if (values.lab === toServer) { console.error("要 --lab (本机沙盘试) 或 --server (联机服务器), 二选一"); process.exit(2); }
if (values.backend !== undefined && !BACKEND_PREFS.includes(values.backend as BackendPref)) { console.error(`--backend 只能是 ${BACKEND_PREFS.join(" / ")}`); process.exit(2); }
if (values.brain !== "none") { console.error(`--brain ${values.brain}: 大脑那块还没搬进来, 现在只有 none (不叫模型)`); process.exit(2); }
if (values["run-id"] !== undefined && !/^[\w-]{1,40}$/.test(values["run-id"])) { console.error("--run-id 只能是字母数字和 - _"); process.exit(2); }
for (const [ok, what] of [[clientReady(), "data/client (npm run client:setup)"], [venvReady(), "data/venv 里的 lupa (npm run offgame:setup)"], [fs.existsSync(pdbDumpExe()), "data/tools/pdb-dump.exe (npm run memory:setup)"]] as const) if (!ok) { console.error(`缺 ${what}`); process.exit(2); }
const prefer = cleanBackendPref(values.backend);
const reveal = values.reveal;
const readOnly = values["read-only"]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} 分] ${s}`);

const runId = values["run-id"] ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(dataRoot(), "play", "online", runId);
const brainRoot = process.env.BRAIN_DIR ?? path.join(os.homedir(), "factorio-ai-brain");
const dir = path.join(brainRoot, `online-${runId}`, "a");
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(dir, { recursive: true });
const stopFile = path.join(runDir, "STOP");
const pipe = `\\\\.\\pipe\\factorio-ai-online-${process.pid}`;
const keysFile = values.keys ?? path.join(dataRoot(), "accounts", "keys.json");

// 沙盘试: 本机起一个干净的服务器 (一个我们的模组都不装, 当联机服务器的替身)
const lab = new SandboxServer({ name: "online", view: false, clean: true });
const viewer = new Viewer("online-a", undefined, { playerName: values.name });
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
      // 沙盘不在乎成就: 一条 Lua 退出开场动画、给点料 (沙盘模组不在, 直接发控制台命令)
      await lab.rcon!.exec(`/silent-command local p = game.connected_players[1] if p.controller_type == defines.controllers.cutscene then pcall(p.exit_cutscene) end local inv = p.character and p.character.get_main_inventory() if inv then for _, st in pairs({{"stone-furnace", 6}, {"coal", 60}, {"iron-plate", 80}, {"wooden-chest", 4}, {"transport-belt", 30}}) do inv.insert{name = st[1], count = st[2]} end end`, { retry: true });
      await lab.dumpDefines();
    }
  }
  const deadline = Date.now() + Number(values.minutes) * 60_000;
  const useRcon = choice?.backend === "rcon";
  // 2. 走外挂要动手才注入客户端; 只读默认不注入 (给 --lua 才注入, 只读 Lua, 不发键鼠); 走 RCON 没有客户端
  const useLua = !useRcon && (!readOnly || values.lua);
  let name = values.name!;
  const protoDir = lab.prototypesDir();
  if (useLua) {
    target = new Body(await freeTcpPort(), loadDefines(protoDir), { gameExe });
    await target.start(log);
    await target.attach(clientPid);
    for (let i = 0; i < 90; i++) { const s = await target.status().catch(() => null); if (s?.state === "in_game") break; if (i === 89) throw new Error(`挂上了但 3 分钟没等到进世界: ${JSON.stringify(s?.raw ?? null).slice(0, 300)}`); await sleep(2000); }
    await target.prepare();
    if (!readOnly) { const stopGuard = startDragGuard(clientPid, log); process.on("exit", stopGuard); }
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
  const t = target;
  const actions = useRcon ? null : readOnly || !t ? readOnlyActions(() => broker!.tick()) : new PlayerActions({
    call: t.call, controls: () => t.controls!, defines: () => t.defines, tick: () => t.tick(),
    holdItem: (i) => t.holdItem(i), placeHeld: (at) => t.placeHeld(at), clearCursor: () => t.clearCursor(), ensureBody: () => t.ensureBody(), setRecipe: (at, r) => t.setRecipe(at, r),
    insertExact: (at, i, n, inv) => t.insertExactDirect(at, i, n, inv), takeExact: (at, i, n, inv) => t.takeExactDirect(at, i, n, inv), itemCount: (at, inv, i) => t.entityItemCount(at, inv, i),
    stacks: () => t.inventorySlots(), chatSend: (x) => t.chatSend(x), recipeTime: (r) => raw.recipe?.[r]?.energy_required ?? (raw.recipe?.[r] ? 0.5 : null),
    assist: values["own-world"] ? undefined : { me: name, allowed: assistAllowed },
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
  const brief = onlineBrief({ name, server: toServer, readOnly, steam: !!values["steam-pid"], rcon: useRcon, ownWorld: values["own-world"] }) + (values["goal-file"] && !readOnly ? `\n## 用户这一班给你的任务\n${fs.readFileSync(values["goal-file"], "utf8").trim()}\n` : "");
  setupWorkspace({ dir, name, pipe, brief, deadline });
  log(`角色目录 ${dir}; 记录 ${runDir}; 停: 放 STOP 文件`);
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId, name, dir, server: toServer, backend: choice?.backend ?? "memory", why: choice?.why ?? "沙盘试外挂", prefer, reveal, readOnly, brain: values.brain, steam: !!values["steam-pid"], startedAt: new Date().toISOString() }, null, 1));

  // 开班扫描: 现状写成 world-scan.md (Lua 跑在游戏外的假接口上, 服务器上一条都不跑)
  if (broker) {
    const b = broker;
    try { log(`开班扫描: ${await writeScan((c) => b.evalLua(c), dir, runDir)}`); }
    catch (e) { log(`开班扫描没做成: ${(e as Error).message.slice(0, 200)}`); }
  }

  // 5. 大脑 (不叫模型时只等到点, 留给人在角色目录里试 ./fh)
  const doneFile = path.join(dir, "DONE");
  const viewerAlive = () => useRcon ? true : values["steam-pid"] ? (() => { try { process.kill(clientPid, 0); return true; } catch { return false; } })() : viewer.alive;
  const stopped = () => Date.now() >= deadline || fs.existsSync(stopFile) || fs.existsSync(doneFile) || !viewerAlive() || clientDown !== null;
  log("不叫模型: 等到点或 STOP; 这段时间可以在角色目录里跑 ./fh");
  while (!stopped()) await sleep(2000);
  const why = clientDown !== null ? `掉线 (${clientDown})` : fs.existsSync(stopFile) ? "STOP" : fs.existsSync(doneFile) ? "模型说任务做完了" : viewerAlive() ? "到点" : "客户端关了";
  if (broker) {
    log(`收工: ${why}; 走哪条路 ${JSON.stringify(Object.fromEntries(Object.entries(broker.stats.byAction).map(([k, v]) => [k, `${v.route}×${v.n} ${Math.round(v.ms / Math.max(v.n, 1))} 毫秒`])))}`);
    fs.writeFileSync(path.join(runDir, "probe-stats.json"), JSON.stringify({ broker: broker.stats, probe: await broker.probeStats().catch((e: Error) => ({ error: e.message })) }, null, 1));
  } else log(`收工: ${why}; RCON 发了 ${rconPipe?.stats.sent ?? 0} 条, 拒了 ${rconPipe?.stats.refused ?? 0} 条`);
  fs.writeFileSync(path.join(runDir, "end.json"), JSON.stringify({ why, endedAt: new Date().toISOString(), minutes: Math.round((Date.now() - t0) / 6000) / 10 }, null, 1));
} catch (e) {
  console.error("出错", server ? scrubText(String((e as Error).stack ?? e), secretsOf(server)) : e);
  code = 2;
} finally {
  if (dropWatch) clearInterval(dropWatch);
  await broker?.stop().catch(() => undefined);
  await rconPipe?.stop().catch(() => undefined);
  (rcon as RconClient | null)?.close();
  await target?.stop().catch(() => undefined);
  if (!values["steam-pid"]) viewer.close();
  if (values.lab) await lab.stop({ save: false }).catch(() => undefined);
  if (server) { await sleep(1500); log(`抹掉客户端日志里的地址和密码: ${scrubClientLogs(viewer.dir, server)} 个文件`); }
}
process.exit(code);
