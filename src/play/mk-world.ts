#!/usr/bin/env node
// 用户的账号在本机新图上从头玩, 真拿成就 (docs/lab.md #106):
//   npm run play:mk -- [--brain none|claude|claude-api|deepseek|relay|codex|grok|gemini] [--model 模型] [--effort low] [--minutes 5] [--goal-file 文件] [--read-only] [--new] [--world 群]
// 界面"我的账号"的群走这里 (control.ts); --world = 这个群自己的一张图, 不给就是命令行共用的那张。状态写 play/mk-current.json (mk-lib.ts)
// 成就要的条件都在这里保证: 服务器只有游戏自带的模组, 不开 RCON, 不跑控制台; 从第一刻在线 (没人在线时自动暂停), 游戏时间不会低于总时长的 50%; 开着虫子 (默认地图设置)。
// 做的事: 起本机服务器 → 用用户的 Steam 版连上 (读他自己的配置, 名字是他的账号) → 挂上 online.ts (--steam-pid) → 收工关客户端 → 比 Steam 的成就缓存多了哪个。
// 只在本机; 用户自己开着游戏就不开 (那时账号归他)。接着上次的图玩, --new 才开新图。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { steamClientRunning, writeMkCurrent, type MkCurrent } from "./mk-lib.ts";
import { parseArgs } from "node:util";
import { factorioExe, findFactorioDir, labRoot, REPO, writeGameDir } from "../lab/gamedir.ts";
import { freeUdpPort } from "../lab/instance.ts";
import { clientPhase } from "./online-lib.ts";
import { localAchievements, newlyUnlocked } from "./steam-stats.ts";

const { values } = parseArgs({ options: {
  brain: { type: "string", default: "none" }, model: { type: "string" }, effort: { type: "string", default: "low" }, minutes: { type: "string", default: "5" },
  "goal-file": { type: "string" }, "read-only": { type: "boolean", default: false }, new: { type: "boolean", default: false }, world: { type: "string" },
} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s: string) => console.log(`[mk ${((Date.now() - t0) / 60000).toFixed(1)} 分] ${s}`);
// 界面靠这个文件知道在跑哪一局、往哪放 STOP; 起不来也要写上原因, 不然界面只看到什么都没发生
const PLAY = path.join(labRoot(), "play");
const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const current: MkCurrent = { runId, runDir: path.join(PLAY, "online", runId), pid: process.pid, startedAt: new Date().toISOString(), ...(values.world ? { group: values.world } : {}), brain: values.brain!, ...(values.model ? { model: values.model } : {}), effort: values.effort!, minutes: Number(values.minutes) };
writeMkCurrent(PLAY, current);
const fail = (s: string): never => { console.error(s); writeMkCurrent(PLAY, { ...current, ended: new Date().toISOString(), error: s }); process.exit(2); };

if (process.platform !== "win32") fail("只有 Windows 能挂客户端");
const gameDir = findFactorioDir();
const exe = factorioExe(gameDir);

if (steamClientRunning(exe)) fail("你的 Steam 版 Factorio 开着: 你在玩时账号归你, 这里不碰。关掉再跑。");

const before = localAchievements();
if (!before) fail("读不到 Steam 的成就缓存 (Steam 没登录过这个游戏?), 没法验证拿没拿到");
log(`Steam 上已有 ${before!.have.length} / ${before!.total} 个成就`);

// ---------- 本机服务器: 只有自带的模组, 不开 RCON ----------
const serverDir = path.join(labRoot(), "clients", values.world ? `mk-${values.world.replace(/[^\w-]/g, "")}` : "mk-server");
writeGameDir(serverDir, gameDir, { dlc: true, locale: "zh-CN", noLab: true });
const savesDir = path.join(serverDir, "saves");
fs.mkdirSync(savesDir, { recursive: true });
const saveFiles = () => fs.readdirSync(savesDir).filter((f) => f.endsWith(".zip")).map((f) => path.join(savesDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
const steamEnv = { ...process.env, SteamAppId: "427520", SteamGameId: "427520" }; // 不设的话 Steam 版会经 Steam 重开, 丢掉参数
if (values.new) for (const f of saveFiles()) fs.rmSync(f);
if (!saveFiles().length) {
  log("开新图 (默认设置, 开着虫子)");
  execFileSync(exe, ["-c", path.join(serverDir, "config.ini"), "--create", path.join(savesDir, "mk.zip")], { stdio: "ignore", env: steamEnv, windowsHide: true });
}
const save = saveFiles()[0];
if (!save) fail("建图失败");
const password = crypto.randomBytes(9).toString("hex");
const settings = path.join(serverDir, "server-settings.json");
fs.writeFileSync(settings, JSON.stringify({ name: "MK 成就局", description: "", tags: [], max_players: 0, visibility: { public: false, lan: false }, require_user_verification: false, game_password: password, allow_commands: "false", autosave_interval: 5, autosave_slots: 3, auto_pause: true, only_admins_can_pause_the_game: true, afk_autokick_interval: 0 }, null, 1));
const port = await freeUdpPort();
const address = `127.0.0.1:${port}`;
const serverLog = path.join(serverDir, "factorio-current.log");
fs.rmSync(serverLog, { force: true });
const serverOut = fs.openSync(path.join(serverDir, "server.out"), "w");
const server: ChildProcess = spawn(exe, ["-c", path.join(serverDir, "config.ini"), "--start-server", save!, "--server-settings", settings, "--port", String(port), "--bind", "127.0.0.1"], { stdio: ["ignore", serverOut, serverOut], windowsHide: true, env: steamEnv });
fs.closeSync(serverOut);
let client: ChildProcess | null = null;
const cleanup = async () => {
  // 窗口正常关 (不带 /F): 游戏才会把成就写给 Steam
  if (client?.pid && client.exitCode === null) {
    try { execFileSync("taskkill", ["/PID", String(client.pid)], { stdio: "ignore", windowsHide: true }); } catch { /* 已经关了 */ }
    for (let i = 0; i < 30 && client.exitCode === null; i++) await sleep(1000);
  }
  if (server.exitCode === null) { server.kill(); await sleep(1000); }
};
let code = 0;
try {
  for (let i = 0; ; i++) {
    if (i >= 120) throw new Error("服务器 2 分钟没起来");
    if (server.exitCode !== null) throw new Error(`服务器退出了 (${server.exitCode}): ${fs.readFileSync(path.join(serverDir, "server.out"), "utf8").slice(-500)}`);
    let text = ""; try { text = fs.readFileSync(serverLog, "utf8"); } catch { /* 还没写 */ }
    if (clientPhase(text).phase === "in_game") break;
    await sleep(1000);
  }
  log(`服务器起来了: ${path.basename(save!)}, 没有模组和 RCON`);

  // ---------- 用户的 Steam 版连上来 ----------
  const clientLog = path.join(process.env.APPDATA ?? "", "Factorio", "factorio-current.log");
  const launched = Date.now();
  client = spawn(exe, ["--mp-connect", address, "--password", password], { stdio: "ignore", detached: true, env: steamEnv });
  client.unref();
  log(`开你的 Steam 版连上去 (进程 ${client.pid})`);
  for (let i = 0; ; i++) {
    if (i >= 180) throw new Error("客户端 3 分钟没进世界");
    if (client.exitCode !== null) throw new Error(`客户端退出了 (${client.exitCode})`);
    try {
      if (fs.statSync(clientLog).mtimeMs >= launched) {
        const { phase, reason } = clientPhase(fs.readFileSync(clientLog, "utf8"));
        if (phase === "in_game") break;
        if (phase === "disconnected" || phase === "server_left") throw new Error(`连不上: ${reason ?? phase}`);
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "EBUSY") throw e; }
    await sleep(1000);
  }
  log("进世界了");

  // ---------- 挂上去: 只走玩家操作 ----------
  const keys = path.join(serverDir, "keys.json");
  fs.writeFileSync(keys, JSON.stringify({ server: { address, password } }));
  const args = ["--env-file-if-exists=.env", path.join(REPO, "core", "run", "online.ts"), "--server", "--own-world", "--run-id", runId, "--keys", keys, "--steam-pid", String(client.pid), "--brain", values.brain!, "--effort", values.effort!, "--minutes", values.minutes!, ...(values.model ? ["--model", values.model] : []), ...(values["goal-file"] ? ["--goal-file", values["goal-file"]] : []), ...(values["read-only"] ? ["--read-only"] : [])];
  code = await new Promise<number>((resolve) => {
    const c = spawn(process.execPath, args, { cwd: REPO, stdio: "inherit" });
    c.on("close", (x) => resolve(x ?? 1));
  });
  log(`联机主循环退出 (${code})`);
} catch (e) {
  log(`出错: ${(e as Error).message}`);
  current.error = (e as Error).message.slice(0, 300);
  code = 1;
} finally {
  await cleanup();
}

// ---------- 验证: Steam 通常在游戏退出时才写缓存 ----------
await sleep(5000);
const after = localAchievements();
const fresh = after ? newlyUnlocked(before!.have, after.have) : [];
log(after ? `成就 ${before!.have.length} → ${after.have.length}${fresh.length ? `; 新拿到: ${fresh.map((a) => after.names[a] ?? a).join("、")}` : "; 这次没有新的"}` : "收工后读不到 Steam 的成就缓存");
writeMkCurrent(PLAY, { ...current, ended: new Date().toISOString(), result: { before: before!.have.length, after: after ? after.have.length : null, fresh: fresh.map((a) => after?.names[a] ?? a) } });
process.exit(code);
