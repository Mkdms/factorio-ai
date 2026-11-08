#!/usr/bin/env node
// 上真服只读之前的彩排 (2026-11-06): 本机起一个和联机服务器配置一样的服务器 (只有游戏自带的模组、有密码、不开正版验证、没有 RCON), 用 play:online --server --read-only 连它。
//   npm run io:rehearse -- [--save 存档.zip] [--only 名字,名字]   名字: 自动没模组 选RCON没模组 选RCON没填 选外挂有模组 自动有模组 RCON只读 RCON动手 群选项 只读加Lua 界面连接 错密码 进世界 掉线 连不上 动手
// 只碰本机; 不叫大脑、不花额度。服务器地址和密码是这里现编的, 写在临时文件里 ("界面连接"走真的控制接口, 往 keys.json 加这个临时群一条, 跑完删)。
// 查: 走哪条路的选项 (src/io/backend.ts) 每种组合; 错密码报得出原因; 干净客户端 (不带我们的模组) 进得去; 只读时客户端没被注入; ./fh 读得到、动作被拒; 服务器断了发现得了; 日志和记录里没有地址和密码。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { factorioExe, findFactorioDir, labRoot, REPO, writeGameDir } from "../lab/gamedir.ts";
import { freeTcpPort, freeUdpPort } from "../lab/instance.ts";
import { defaultLabSave } from "../lab/default-save.ts";
import { RconClient } from "../lab/rcon.ts";
import { defaultKeysFile, saveGroupServer } from "../play/accounts.ts";
import { clientPhase } from "../play/online-lib.ts";
import { bashExe } from "../play/shell.ts";

const { values } = parseArgs({ options: { save: { type: "string" }, only: { type: "string" } } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const execFileAsync = promisify(execFile);
const wanted = (name: string) => !values.only || values.only.split(",").includes(name);

const LOCK = path.join(labRoot(), "GAME_LOCK");
if (fs.existsSync(LOCK)) { console.error(`游戏锁被占: ${fs.readFileSync(LOCK, "utf8").trim()}`); process.exit(2); }
const lockText = `io-rehearse pid ${process.pid}`;
fs.writeFileSync(LOCK, lockText);
process.on("exit", () => { try { if (fs.readFileSync(LOCK, "utf8") === lockText) fs.rmSync(LOCK); } catch { /* 已删 */ } });

type Row = { name: string; pass: boolean; seen: string };
const rows: Row[] = [];
const check = (name: string, pass: boolean, seen: string) => { rows.push({ name, pass, seen }); console.log(`${pass ? "✅" : "❌"} ${name}: ${seen.slice(0, 600)}`); };

const work = fs.mkdtempSync(path.join(os.tmpdir(), "rehearse-"));
const password = `rehearse-${crypto.randomBytes(8).toString("hex")}`;
const clientDir = path.join(labRoot(), "clients", "online-a");

// ---------- 服务器: 配置照联机服务器的 ----------
const serverDir = path.join(labRoot(), "clients", "rehearse-server");
const gameDir = findFactorioDir();
let server: ChildProcess | null = null;
const rconPassword = `rehearse-rcon-${crypto.randomBytes(8).toString("hex")}`;
/** harness: 服务器装我们的模组 (这时干净客户端进不去); rcon: 开 RCON。回游戏端口和 RCON 端口 */
async function startServer(opts: { harness?: boolean; rcon?: boolean } = {}): Promise<{ port: number; rconPort: number }> {
  const save = values.save ?? defaultLabSave();
  if (!save) throw new Error("本机没有参考存档: 用 --save 指定一份");
  writeGameDir(serverDir, gameDir, { dlc: true, locale: "zh-CN", noLab: true, ...(opts.harness ? { repoMods: ["agent-harness-party"] } : {}) });
  fs.copyFileSync(save, path.join(serverDir, "saves", "m.zip"));
  const settings = path.join(serverDir, "server-settings.json");
  fs.writeFileSync(settings, JSON.stringify({ name: "彩排", description: "", tags: [], max_players: 0, visibility: { public: false, lan: false }, require_user_verification: false, game_password: password, allow_commands: "admins-only", autosave_interval: 0, auto_pause: false, only_admins_can_pause_the_game: true, afk_autokick_interval: 0 }, null, 1));
  const port = await freeUdpPort(), rconPort = await freeTcpPort();
  const log = path.join(serverDir, "factorio-current.log");
  fs.rmSync(log, { force: true });
  const out = fs.openSync(path.join(serverDir, "server.out"), "w");
  server = spawn(factorioExe(gameDir), ["-c", path.join(serverDir, "config.ini"), "--start-server", path.join(serverDir, "saves", "m.zip"), "--server-settings", settings, "--port", String(port), "--bind", "127.0.0.1", ...(opts.rcon ? ["--rcon-bind", `127.0.0.1:${rconPort}`, "--rcon-password", rconPassword] : [])], { stdio: ["ignore", out, out], windowsHide: true, env: { ...process.env, SteamAppId: "427520", SteamGameId: "427520" } });
  fs.closeSync(out);
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (server.exitCode !== null) throw new Error(`服务器退出了 (${server.exitCode}): ${fs.readFileSync(path.join(serverDir, "server.out"), "utf8").slice(-600)}`);
    let text = ""; try { text = fs.readFileSync(log, "utf8"); } catch { /* 还没写 */ }
    if (clientPhase(text).phase === "in_game") return { port, rconPort };
  }
  throw new Error("服务器 2 分钟没起来");
}
async function stopServer(): Promise<void> {
  if (server && server.exitCode === null) { server.kill(); await sleep(1500); }
  server = null;
}

// ---------- play:online 当子进程: 和用户要跑的是同一条命令 ----------
type Run = { proc: ChildProcess; out: () => string; done: Promise<number> };
type Conn = { address: string; password?: string; rcon?: { address: string; password: string } };
/** rawKeys: keys.json 的整个内容 (试 group_servers); 不给就是默认的 server */
function online(keys: Conn, minutes: number, args: string[] = ["--read-only"], rawKeys?: unknown): Run {
  const f = path.join(work, "keys.json");
  fs.writeFileSync(f, JSON.stringify(rawKeys ?? { server: keys }));
  let text = "";
  const proc = spawn(process.execPath, ["--env-file-if-exists=.env", path.join(REPO, "core", "run", "online.ts"), "--server", ...args, "--keys", f, "--minutes", String(minutes)], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const add = (d: Buffer) => { const s = d.toString("utf8"); text += s; for (const line of s.split(/\r?\n/)) if (line.trim()) console.log(`    | ${line.slice(0, 400)}`); };
  proc.stdout!.on("data", add);
  proc.stderr!.on("data", add);
  return { proc, out: () => text, done: new Promise((resolve) => proc.on("exit", (c) => resolve(c ?? -1))) };
}
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(1000); }
  return cond();
}

/** 客户端进程里有没有被注入的东西: 模块名带 mcp 的算 */
async function injected(pid: number): Promise<string[]> {
  const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/M", "/FO", "CSV"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout.split(/[",\r\n]+/).filter((m) => /mcp|factorio-native|pilot/i.test(m));
}
const mcpRunning = async () => (await execFileAsync("tasklist", ["/FI", "IMAGENAME eq factorio-mcp.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" })).stdout.includes("factorio-mcp");

/** 目录里所有文本文件里有没有这些字 */
function leaks(dir: string, secrets: string[]): string[] {
  const hits: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4 && !["mods", "saves", "gamedata", "ref", "temp"].includes(e.name)) walk(p, depth + 1); continue; }
      try { if (fs.statSync(p).size > 8 * 1024 * 1024) continue; const t = fs.readFileSync(p, "utf8"); if (secrets.some((s) => t.includes(s))) hits.push(path.relative(labRoot(), p)); } catch { /* 读不了就算了 */ }
    }
  };
  walk(dir, 0);
  return hits;
}

/** 在角色目录里跑一条命令 */
async function shIn(dir: string, cmd: string): Promise<string> {
  try { const { stdout, stderr } = await execFileAsync(bashExe(), ["-c", cmd], { cwd: dir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 150_000, windowsHide: true }); return `${stdout}${stderr}`; } catch (e) { const x = e as { stdout?: string; stderr?: string; message: string }; return `${x.stdout ?? ""}${x.stderr ?? ""}${x.stdout || x.stderr ? "" : x.message}`; }
}
const dirsOf = (text: string) => { const m = /角色目录 (.+?); 记录 (.+?); 停/.exec(text); return m ? { dir: m[1], runDir: m[2] } : null; };
const serverOut = () => fs.readFileSync(path.join(serverDir, "server.out"), "utf8");
/** 服务器日志里有 Lua 命令的痕迹: 跑过 /silent-command 这张图就不能拿成就了 */
const ranLua = () => /\[COMMAND\]|achievements? (will|are) |disable.*achievement/i.test(serverOut());

let code = 0;
try {
  // ---------- 走哪条路的选项 (src/io/backend.ts) ----------
  if (wanted("自动没模组")) {
    const { port, rconPort } = await startServer({ rcon: true });
    const conn = { address: `127.0.0.1:${port}`, password, rcon: { address: `127.0.0.1:${rconPort}`, password: rconPassword } };
    const r = online(conn, 10);
    await until(() => /角色目录 /.test(r.out()) || r.proc.exitCode !== null, 240_000);
    const d = dirsOf(r.out());
    const status = d ? await shIn(d.dir, "./fh call status") : "";
    check("自动 + 开了 RCON 没装模组: 走外挂, 一条 Lua 都不跑", /走哪条路: 服务器开了 RCON 但没装模组/.test(r.out()) && /tick/.test(status) && !ranLua(), `${(/走哪条路[^\n]*/.exec(r.out()) ?? ["没定下来"])[0]}; 服务器日志有 Lua 痕迹 ${ranLua()}; status ${status.slice(0, 80).replace(/\s+/g, " ")}`);
    if (d) fs.writeFileSync(path.join(d.runDir, "STOP"), "彩排");
    await r.done;
    await stopServer();
  }
  if (wanted("选RCON没模组")) {
    const { port, rconPort } = await startServer({ rcon: true });
    const r = online({ address: `127.0.0.1:${port}`, password, rcon: { address: `127.0.0.1:${rconPort}`, password: rconPassword } }, 1, ["--backend", "rcon", "--read-only"]);
    const c = await r.done;
    check("选 RCON 但服务器没装模组: 报错, 不偷偷换路", c === 2 && /没装我们的模组/.test(r.out()), `退出码 ${c}; ${(/进不去服务器[^\n]*/.exec(r.out()) ?? [r.out().slice(-200)])[0]}`);
    await stopServer();
  }
  if (wanted("选RCON没填")) {
    const r = online({ address: "127.0.0.1:1", password }, 1, ["--backend", "rcon", "--read-only"]);
    const c = await r.done;
    check("选 RCON 没填地址密码: 马上报错, 不开客户端", c === 2 && /没填 RCON/.test(r.out()), `退出码 ${c}; ${(/进不去服务器[^\n]*/.exec(r.out()) ?? [r.out().slice(-200)])[0]}`);
  }
  if (wanted("自动有模组") || wanted("选外挂有模组") || wanted("RCON只读") || wanted("RCON动手")) {
    const { port, rconPort } = await startServer({ harness: true, rcon: true });
    const conn = { address: `127.0.0.1:${port}`, password, rcon: { address: `127.0.0.1:${rconPort}`, password: rconPassword } };
    const secrets = [password, rconPassword, conn.address, conn.rcon.address];
    if (wanted("选外挂有模组")) {
      const r = online(conn, 1, ["--backend", "memory", "--read-only"]);
      const c = await r.done;
      check("选外挂但服务器有模组: 报错, 提到可能是模组不一样, 不跑 Lua", c === 2 && /模组和客户端不一样/.test(r.out()) && !ranLua(), `退出码 ${c}; 服务器日志 ${(/Refusing connection[^\n]*/.exec(serverOut()) ?? [""])[0].replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "<地址>").slice(0, 140)}; ${(/进不去服务器[^\n]*/.exec(r.out()) ?? [r.out().slice(-200)])[0]}`);
    }
    if (wanted("RCON只读") || wanted("自动有模组")) {
      const r = online(conn, 10);
      await until(() => /角色目录 /.test(r.out()) || r.proc.exitCode !== null, 240_000);
      const d = dirsOf(r.out());
      check("自动 + 服务器有模组: 走 RCON", /走哪条路: 服务器明确开了 RCON/.test(r.out()) && !!d, (/走哪条路[^\n]*/.exec(r.out()) ?? [r.out().slice(-300)])[0]);
      if (d) {
        const status = await shIn(d.dir, "./fh call status");
        check("RCON 只读: ./fh 读得到", /tick/.test(status) && !/RCON 出错|error:/.test(status.slice(0, 200)), status.slice(0, 200).replace(/\s+/g, " "));
        for (const [label, cmd] of [["聊天", './fh say "hello"'], ["放东西", `./fh call build --args '{"item":"wooden-chest","position":{"x":0.5,"y":0.5}}'`]] as const) {
          const t = await shIn(d.dir, cmd);
          check(`RCON 只读: ${label}被拒, 不误报回档`, /现在只读/.test(t) && !/rolled_back/.test(t), t.slice(0, 160).replace(/\s+/g, " "));
        }
        // 直接问服务器有哪些服务器角色; 探测用的名字留下一个真玩家, 正式名字不该被占
        const direct = new RconClient({ port: rconPort, password: rconPassword });
        await direct.connect();
        const bots = await direct.exec(`/silent-command local b = remote.call("agent_harness", "bots") rcon.print(type(b) == "table" and helpers.table_to_json(b) or tostring(b))`);
        const players = await direct.exec(`/silent-command local o = {} for _, p in pairs(game.players) do o[#o + 1] = p.name end rcon.print(table.concat(o, ","))`);
        direct.close();
        check("RCON 只读: 没造服务器角色, 正式名字没被占", !/Claude-Opus/.test(bots) && !/Claude-Opus/.test(players), `服务器角色 ${bots.slice(0, 160)}; 玩家 ${players.slice(0, 160)}`);
        fs.writeFileSync(path.join(d.runDir, "STOP"), "彩排");
        await r.done;
        const leaked = [...leaks(d.runDir, secrets), ...leaks(path.dirname(d.dir), secrets)];
        check("RCON: 角色目录和记录里没有地址和密码", leaked.length === 0, leaked.join(", ") || "都查过");
      } else { r.proc.kill(); await r.done; }
    }
    if (wanted("RCON动手")) {
      const r = online(conn, 10, ["--backend", "rcon"]);
      await until(() => /角色目录 /.test(r.out()) || r.proc.exitCode !== null, 120_000);
      const d = dirsOf(r.out());
      check("选 RCON + 服务器有模组: 走 RCON, 造了服务器角色", /走哪条路: 你选了 RCON/.test(r.out()) && /服务器角色 Claude-Opus/.test(r.out()) && !!d, (/RCON \+ 模组[^\n]*/.exec(r.out()) ?? [r.out().slice(-300)])[0]);
      if (d) {
        const said = await shIn(d.dir, './fh say "彩排"');
        check("RCON 动手: 聊天发出去了", !/error|只读/.test(said.slice(0, 200)), said.slice(0, 160).replace(/\s+/g, " "));
        fs.writeFileSync(path.join(d.runDir, "STOP"), "彩排");
      }
      await r.done;
      if (wanted("自动有模组")) {
        // 探测留下的真玩家叫 Pilot-Probe: 用这个名字造服务器角色要撞名, 按规矩排到 -2
        const r2 = online(conn, 10, ["--backend", "rcon", "--name", "Pilot-Probe"]);
        await until(() => /角色目录 /.test(r2.out()) || r2.proc.exitCode !== null, 120_000);
        const d2 = dirsOf(r2.out());
        check("撞真玩家的名字: 排到 -2", /服务器角色 Pilot-Probe-2/.test(r2.out()), (/服务器角色[^\n]*/.exec(r2.out()) ?? [r2.out().slice(-240)])[0]);
        if (d2) fs.writeFileSync(path.join(d2.runDir, "STOP"), "彩排");
        await r2.done;
      }
    }
    await stopServer();
  }
  if (wanted("群选项")) {
    // 端到端: 群文件 + keys.json group_servers → online.ts --group; 没探过的区块的开关也接上了
    const { port } = await startServer();
    const playDir = path.join(labRoot(), "play");
    const id = `g-rehearse${crypto.randomBytes(3).toString("hex")}`;
    const groupFile = path.join(playDir, "groups", `${id}.json`);
    const charted = async (on: boolean) => {
      fs.writeFileSync(groupFile, JSON.stringify({ id, name: "彩排群", createdAt: new Date().toISOString(), kind: "server", backend: "memory", ...(on ? { revealUncharted: true } : {}), seats: [{ brain: "none" }], minutes: 5 }));
      const conn = { address: `127.0.0.1:${port}`, password };
      const r = online(conn, 10, ["--group", id, "--read-only"], { server: { address: "127.0.0.1:1" }, group_servers: { [id]: conn } });
      await until(() => /角色目录 /.test(r.out()) || r.proc.exitCode !== null, 240_000);
      const d = dirsOf(r.out());
      const status = d ? await shIn(d.dir, "./fh call status") : "";
      if (d) fs.writeFileSync(path.join(d.runDir, "STOP"), "彩排");
      await r.done;
      const run = d ? JSON.parse(fs.readFileSync(path.join(d.runDir, "run.json"), "utf8")) as { group?: string; prefer?: string; reveal?: boolean; backend?: string } : null;
      return { n: Number(/charted_chunks=(\d+)/.exec(status)?.[1] ?? -1), run, status };
    };
    try {
      const off = await charted(false), on = await charted(true);
      check("群选项: --group 读群文件和 keys.json 里它自己的服务器", off.run?.group === id && off.run?.prefer === "memory" && off.run?.backend === "memory", JSON.stringify(off.run));
      check("没探过的区块: 关 = 只有探过的, 开 = 全部 (群的开关真生效)", off.n > 0 && on.n > off.n && on.run?.reveal === true && off.run?.reveal === false, `关 ${off.n} 块, 开 ${on.n} 块`);
    } finally { fs.rmSync(groupFile, { force: true }); }
    await stopServer();
  }

  if (wanted("只读加Lua")) {
    // --read-only --lua: 注入客户端读 Lua, 但不发键鼠, 动作照样拒; 服务器上不该有任何变化
    const { port } = await startServer();
    const r = online({ address: `127.0.0.1:${port}`, password }, 10, ["--read-only", "--lua"]);
    await until(() => /角色目录 /.test(r.out()) || r.proc.exitCode !== null, 240_000);
    const d = dirsOf(r.out());
    check("只读 + Lua: 进世界, 说清注入了", /只读 \(注入了客户端, 只读 Lua, 不发键鼠\)/.test(r.out()) && !!d, (/只读 \([^\n]*/.exec(r.out()) ?? [r.out().slice(-240)])[0]);
    if (d) {
      check("只读 + Lua: MCP 起了", await mcpRunning(), "");
      const players = await shIn(d.dir, "./fh call players");
      check("只读 + Lua: 读得到玩家", /Claude-Opus/.test(players) && !/error/.test(players.slice(0, 120)), players.slice(0, 200).replace(/\s+/g, " "));
      const t = await shIn(d.dir, `./fh call build --args '{"item":"wooden-chest","position":{"x":0.5,"y":0.5}}'`);
      check("只读 + Lua: 动作照样拒", /现在只读/.test(t) && /什么都没发给游戏/.test(t), t.slice(0, 140).replace(/\s+/g, " "));
      await sleep(20_000);
      const out = serverOut();
      check("只读 + Lua: 服务器没有不同步, 没被踢, 没跑 Lua 命令", /\[JOIN\] Claude-Opus/.test(out) && !/\[LEAVE\] Claude-Opus/.test(out) && !/desync/i.test(out) && !ranLua(), `JOIN ${/\[JOIN\] Claude-Opus/.test(out)}, LEAVE ${/\[LEAVE\]/.test(out)}, 不同步 ${/desync/i.test(out)}, Lua 命令 ${ranLua()}`);
      fs.writeFileSync(path.join(d.runDir, "STOP"), "彩排");
    }
    await r.done;
    await stopServer();
  }
  if (wanted("界面连接")) {
    // 界面"只读连接"那个按钮走的路: 控制接口 POST /api/groups → /api/group/connect → play:online --group。写真的 keys.json (只加这个临时群一条, 跑完删)
    const api = "http://127.0.0.1:4330";
    const up = () => fetch(`${api}/api/groups`).then((r) => r.ok, () => false);
    if (await up()) throw new Error("4330 已经有控制接口在跑 (界面开着?), 关了再跑这段");
    const { port } = await startServer();
    const control = spawn(process.execPath, ["--env-file-if-exists=.env", path.join(REPO, "src", "play", "control.ts")], { cwd: REPO, stdio: "ignore", windowsHide: true });
    let groupId = "";
    try {
      for (let i = 0; i < 40 && !(await up()); i++) await sleep(500);
      const post = async (p: string, body: unknown) => { const r = await fetch(`${api}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() as Record<string, any> }; };
      const conn = { address: `127.0.0.1:${port}`, password };
      const made = await post("/api/groups", { name: "彩排联机群", kind: "server", server: conn, backend: "memory", minutes: 5 });
      groupId = String(made.json.group?.id ?? "");
      const groupFile = path.join(labRoot(), "play", "groups", `${groupId}.json`);
      const inFile = fs.readFileSync(groupFile, "utf8");
      check("控制接口建联机群: 地址和密码不进群文件, 回给界面的也没有密码", made.status === 200 && !inFile.includes(password) && !inFile.includes(conn.address) && made.json.group?.server?.address === conn.address && made.json.group?.server?.hasPassword === true && !JSON.stringify(made.json).includes(password), JSON.stringify(made.json.group?.server));
      const go = await post("/api/group/connect", { id: groupId });
      let text = "";
      await until(() => { try { text = fs.readFileSync(String(go.json.log), "utf8"); } catch { /* 还没写 */ } return /角色目录 |出错/.test(text); }, 180_000);
      const d = dirsOf(text);
      const twice = await post("/api/group/connect", { id: groupId });
      check("只读连接按钮: 真的连上, 走群的选项, 不重复开", go.status === 200 && !!d && /走哪条路: 你选了内存外挂/.test(text) && /只读 \(没注入客户端\)/.test(text) && twice.status === 400, `第二次 ${twice.status} ${String(twice.json.error ?? "")}; ${(/走哪条路[^\n]*/.exec(text) ?? [text.slice(-200)])[0]}`);
      if (d) {
        fs.writeFileSync(path.join(d.runDir, "STOP"), "彩排");
        await until(() => { try { text = fs.readFileSync(String(go.json.log), "utf8"); } catch { /* 读不了 */ } return /抹掉客户端日志/.test(text); }, 60_000);
        check("只读连接的日志里没有地址和密码", !text.includes(password) && !text.includes(conn.address), `${text.length} 字`);
      }
      const bad = await post("/api/group/rcon", { id: groupId, address: "没端口", password: "x" });
      const rconOk = await post("/api/group/rcon", { id: groupId, address: "127.0.0.1:27015", password: rconPassword });
      const listed = await (await fetch(`${api}/api/groups`)).json() as { groups: { id: string; server?: { rcon?: string | null } }[] };
      check("填 RCON: 格式不对拒绝, 对的存下, 列表能看到", bad.status === 400 && rconOk.status === 200 && listed.groups.find((g) => g.id === groupId)?.server?.rcon === "127.0.0.1:27015" && !JSON.stringify(listed).includes(rconPassword), `格式错 ${bad.status}, 对的 ${rconOk.status}`);
      fs.rmSync(groupFile, { force: true });
    } finally {
      control.kill();
      if (groupId) saveGroupServer(defaultKeysFile(), groupId, null);
      await stopServer();
    }
  }

  // ---------- 只读这条路本身 ----------
  const { port } = wanted("错密码") || wanted("进世界") || wanted("掉线") || wanted("连不上") || wanted("动手") ? await startServer() : { port: 0 };
  const address = `127.0.0.1:${port}`;
  if (port) console.log(`彩排服务器起来了 (端口 ${port}, 只有自带模组, 有密码, 没有 RCON)`);

  if (wanted("错密码")) {
    const t0 = Date.now();
    const r = online({ address, password: "wrong-password" }, 1);
    const c = await r.done;
    const sec = Math.round((Date.now() - t0) / 1000);
    const said = (/进不去服务器[^\n]*/.exec(r.out()) ?? [""])[0];
    const onServer = /PasswordMismatch/.test(fs.readFileSync(path.join(serverDir, "server.out"), "utf8"));
    check("错密码: 一分钟内报错, 说得出是服务器拒绝", c === 2 && /服务器拒绝了/.test(said) && sec < 90 && onServer, `退出码 ${c}, ${sec} 秒, 服务器日志 PasswordMismatch ${onServer}; ${said}`);
  }

  if (wanted("进世界")) {
    const r = online({ address, password }, 10);
    const inWorld = await until(() => /角色目录 /.test(r.out()) || r.proc.exitCode !== null, 240_000);
    const dirMatch = /角色目录 (.+?); 记录 (.+?); 停/.exec(r.out());
    check("干净客户端连干净服务器: 带密码进世界", inWorld && !!dirMatch, (/客户端: 进世界了[^\n]*/.exec(r.out()) ?? ["没进去"])[0]);
    if (dirMatch) {
      const [, dir, runDir] = dirMatch;
      const clientLogText = fs.readFileSync(path.join(clientDir, "factorio-current.log"), "utf8");
      const mods = [...clientLogText.matchAll(/Loading mod (\S+) \S+ \(data\.lua\)/g)].map((m) => m[1]);
      check("客户端只带自带模组", !mods.some((m) => /io-lab|agent-harness|factoryplanner/.test(m)) && mods.includes("space-age"), mods.join(" "));
      const pid = (JSON.parse(fs.readFileSync(path.join(clientDir, "viewer.json"), "utf8")) as { pid: number }).pid;
      const dlls = await injected(pid), mcp = await mcpRunning();
      check("只读: 客户端没被注入, MCP 没起", dlls.length === 0 && !mcp, `进程 ${pid}; 可疑模块 ${JSON.stringify(dlls)}; MCP 进程 ${mcp}`);
      const where = JSON.parse(fs.readFileSync(path.join(runDir, "where.json"), "utf8")) as { player: { name?: string }; hasBody: boolean; surfaces: { name: string; here: boolean; entities: number }[] };
      check("读到玩家和地表", where.player.name === "Claude-Opus" && where.hasBody && where.surfaces.some((s) => s.here && s.entities > 0), JSON.stringify(where).slice(0, 300));
      const sh = async (cmd: string) => {
        try { const { stdout, stderr } = await execFileAsync(bashExe(), ["-c", cmd], { cwd: dir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 150_000, windowsHide: true }); return `${stdout}${stderr}`; } catch (e) { const x = e as { stdout?: string; stderr?: string; message: string }; return `${x.stdout ?? ""}${x.stderr ?? ""}${x.stdout || x.stderr ? "" : x.message}`; }
      };
      const status = await sh("./fh call status");
      check("./fh status 读得到", /"tick"|tick|clock/.test(status) && !/模组宿主出错/.test(status), status.slice(0, 240).replace(/\s+/g, " "));
      const inv = await sh("./fh call inventory");
      check("./fh inventory 读得到", !/模组宿主出错|error/i.test(inv.slice(0, 200)), inv.slice(0, 200).replace(/\s+/g, " "));
      const obs = await sh("./fh observe");
      check("./fh observe 读得到", obs.length > 100 && !/模组宿主出错/.test(obs), `${obs.length} 字: ${obs.slice(0, 160).replace(/\s+/g, " ")}`);
      for (const [label, cmd] of [["聊天", './fh say "hello"'], ["放东西", `./fh call build --args '{"item":"wooden-chest","position":{"x":0.5,"y":0.5}}'`], ["走路", `./fh call move_to --args '{"position":{"x":5,"y":5}}'`]] as const) {
        const t = await sh(cmd);
        check(`只读: ${label}被拒, 不误报回档`, /现在只读/.test(t) && /什么都没发给游戏/.test(t) && !/rolled_back/.test(t), t.slice(0, 200).replace(/\s+/g, " "));
      }
      // 进去后多待一会再看: 不同步要过一段才报
      await sleep(30_000);
      const before = fs.readFileSync(path.join(serverDir, "server.out"), "utf8");
      const joined = /\[JOIN\] Claude-Opus joined the game/.test(before), left = /\[LEAVE\] Claude-Opus/.test(before), desync = /desync/i.test(before);
      check("服务器: 玩家进来了, 没被踢, 没有不同步", joined && !left && !desync, `JOIN ${joined}, LEAVE ${left}, 不同步 ${desync}`);
      if (wanted("掉线")) {
        server!.kill();
        const t0 = Date.now();
        const c = await Promise.race([r.done, sleep(240_000).then(() => -9)]);
        check("服务器断了: 发现并收工", c === 0 && /收工: 掉线/.test(r.out()), `退出码 ${c}, ${Math.round((Date.now() - t0) / 1000)} 秒; ${(/收工: [^;\n]*/.exec(r.out()) ?? [""])[0]}`);
      } else { fs.writeFileSync(path.join(runDir, "STOP"), "彩排"); await r.done; }
      check("跑完留底", fs.existsSync(path.join(runDir, "probe-stats.json")), "probe-stats.json");
      await sleep(500);
      const secrets = [password, address];
      const leaked = [...leaks(clientDir, secrets), ...leaks(runDir, secrets), ...leaks(path.dirname(dir), secrets)];
      check("日志和记录里没有地址和密码", leaked.length === 0, leaked.length ? leaked.join(", ") : "客户端目录、班次记录、角色目录都查过");
    } else { r.proc.kill(); await r.done; }
  }

  if (wanted("连不上")) {
    if (server && (server as ChildProcess).exitCode === null) { (server as ChildProcess).kill(); await sleep(1500); }
    const t0 = Date.now();
    const r = online({ address, password }, 1);
    const c = await r.done;
    const sec = Math.round((Date.now() - t0) / 1000);
    check("服务器没开: 两分钟内报错退出, 不干等", c === 2 && /进不去服务器/.test(r.out()) && sec < 150, `退出码 ${c}, ${sec} 秒; ${(/进不去服务器[^\n]*/.exec(r.out()) ?? [""])[0]}`);
  }

  // 要动手的那条路 (--lab, 挂 MCP): 进世界的等法改了, 这条也要过。--lab 自己拿游戏锁, 先放开
  if (wanted("动手")) {
    if (server && (server as ChildProcess).exitCode === null) { (server as ChildProcess).kill(); await sleep(1500); }
    fs.rmSync(LOCK, { force: true });
    let text = "";
    const proc = spawn(process.execPath, ["--env-file-if-exists=.env", path.join(REPO, "core", "run", "online.ts"), "--lab", "--minutes", "5"], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const add = (d: Buffer) => { const s = d.toString("utf8"); text += s; for (const line of s.split(/\r?\n/)) if (line.trim()) console.log(`    | ${line.slice(0, 300)}`); };
    proc.stdout!.on("data", add);
    proc.stderr!.on("data", add);
    const done = new Promise<number>((resolve) => proc.on("exit", (c) => resolve(c ?? -1)));
    await until(() => /角色目录 /.test(text) || proc.exitCode !== null, 240_000);
    const m = /角色目录 (.+?); 记录 (.+?); 停/.exec(text);
    if (!m) check("--lab 动手: 进世界", false, text.slice(-300));
    else {
      const where = JSON.parse(fs.readFileSync(path.join(m[2], "where.json"), "utf8")) as { player: { position: { x: number; y: number } } };
      const run = async (cmd: string) => { try { const { stdout, stderr } = await execFileAsync(bashExe(), ["-c", cmd], { cwd: m[1], encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 150_000, windowsHide: true }); return `${stdout}${stderr}`; } catch (e) { const x = e as { stdout?: string; stderr?: string; message: string }; return `${x.stdout ?? ""}${x.stderr ?? ""}${x.stdout || x.stderr ? "" : x.message}`; } };
      // 接着真基地的存档, 身边可能有东西: 换几个地方放, 放不下算工具说了实话
      let built = "";
      for (const [dx, dy] of [[3.5, 3.5], [-4.5, 3.5], [3.5, -4.5], [-4.5, -4.5], [6.5, 0.5], [-6.5, 0.5], [0.5, 6.5], [0.5, -6.5]]) {
        const at = { x: Math.floor(where.player.position.x) + dx, y: Math.floor(where.player.position.y) + dy };
        built = await run(`./fh call build --args '{"item":"wooden-chest","position":{"x":${at.x},"y":${at.y}}}'`);
        if (/consumed/.test(built) || !/placement blocked/.test(built)) break;
      }
      check("--lab 动手: 挂 MCP 后放得下东西", /consumed/.test(built), built.slice(0, 240).replace(/\s+/g, " "));
      fs.writeFileSync(path.join(m[2], "STOP"), "彩排");
    }
    const c = await Promise.race([done, sleep(120_000).then(() => -9)]);
    check("--lab 动手: 收工干净", c === 0, `退出码 ${c}`);
  }
  console.log(`\n通过 ${rows.filter((r) => r.pass).length}/${rows.length}`);
  if (rows.some((r) => !r.pass)) code = 1;
} catch (e) {
  console.error("出错", e);
  code = 2;
} finally {
  if (server && (server as ChildProcess).exitCode === null) (server as ChildProcess).kill();
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(code);
