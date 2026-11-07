// 一次性手动测试 (2026-11-07): 装着模组、整局不发任何控制台命令, Steam 给不给成就?
// 本机新图 + 小模组 achievement-probe (进游戏时往背包放机车 / 铁轨 / 太阳能板) + 用户的 Steam 版 (单独配置目录, 不碰用户自己的设置)。
// 不开 RCON; 开着 --enable-lua-udp 但没人发包。用户手动放东西、关窗口; 之后比 Steam 成就缓存。
// 还临时借用旧项目的三个函数 (看客户端日志、读 Steam 缓存、查 Steam 版开没开), 搬到新项目后要换掉。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { findFactorioDir, factorioExe, writeGameDir } from "../../game/sandbox/paths.ts";
import { freeUdpPort } from "../../game/sandbox/server.ts";
const OLD = "I:/fn/factorio-pilot/src";
const imp = (p) => import(pathToFileURL(`${OLD}/${p}`).href);
const { clientPhase } = await imp("play/online-lib.ts");
const { localAchievements, newlyUnlocked } = await imp("play/steam-stats.ts");
const { steamClientRunning } = await imp("play/mk-lib.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} 分] ${s}`);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MOD = path.join(here, "achievement-probe");
const ROOT = "I:/fn/factorio-ai/data/probe";
const gameDir = findFactorioDir();
const exe = factorioExe(gameDir);
const steamEnv = { ...process.env, SteamAppId: "427520", SteamGameId: "427520" };

if (steamClientRunning(exe)) { console.log("你的 Steam 版 Factorio 开着, 先关掉"); process.exit(2); }
const before = localAchievements();
if (!before) { console.log("读不到 Steam 成就缓存"); process.exit(2); }
log(`Steam 上已有 ${before.have.length} / ${before.total}`);

// 服务器和客户端各一套配置目录, 模组只有 achievement-probe (+ 游戏自带的)
function gameDirWithProbe(dir, extra) {
  writeGameDir(dir, gameDir, { dlc: true, locale: "zh-CN", noMod: true, extra });
  fs.cpSync(MOD, path.join(dir, "mods", "achievement-probe"), { recursive: true });
  const listFile = path.join(dir, "mods", "mod-list.json");
  const list = JSON.parse(fs.readFileSync(listFile, "utf8"));
  if (!list.mods.some((m) => m.name === "achievement-probe")) list.mods.push({ name: "achievement-probe", enabled: true });
  fs.writeFileSync(listFile, JSON.stringify(list, null, 2));
}
const serverDir = path.join(ROOT, "server"), clientDir = path.join(ROOT, "client");
fs.rmSync(ROOT, { recursive: true, force: true });
gameDirWithProbe(serverDir);
gameDirWithProbe(clientDir, ["[graphics]", "full-screen=false"]);

const save = path.join(serverDir, "saves", "probe.zip");
log("建新图");
execFileSync(exe, ["-c", path.join(serverDir, "config.ini"), "--create", save], { stdio: "ignore", env: steamEnv, windowsHide: true });
const password = crypto.randomBytes(9).toString("hex");
const settings = path.join(serverDir, "server-settings.json");
fs.writeFileSync(settings, JSON.stringify({ name: "成就测试", description: "", tags: [], max_players: 0, visibility: { public: false, lan: false }, require_user_verification: false, game_password: password, allow_commands: "false", autosave_interval: 5, autosave_slots: 2, auto_pause: true, only_admins_can_pause_the_game: true, afk_autokick_interval: 0 }, null, 1));
const [port, udp] = [await freeUdpPort(), await freeUdpPort()];
const serverLog = path.join(serverDir, "factorio-current.log");
const out = fs.openSync(path.join(serverDir, "server.out"), "w");
// 没有 --rcon-*: 整局没有 RCON; --enable-lua-udp 开着但没人发包
const server = spawn(exe, ["-c", path.join(serverDir, "config.ini"), "--start-server", save, "--server-settings", settings, "--port", String(port), "--bind", "127.0.0.1", "--enable-lua-udp", String(udp)], { stdio: ["ignore", out, out], windowsHide: true, env: steamEnv });
fs.closeSync(out);
let client = null;
const cleanup = async () => {
  if (client?.pid && client.exitCode === null) { try { execFileSync("taskkill", ["/PID", String(client.pid)], { stdio: "ignore", windowsHide: true }); } catch { /* 已关 */ } for (let i = 0; i < 30 && client.exitCode === null; i++) await sleep(1000); }
  if (server.exitCode === null) { server.kill(); await sleep(1000); }
};
try {
  for (let i = 0; ; i++) {
    if (i >= 120) throw new Error("服务器 2 分钟没起来");
    if (server.exitCode !== null) throw new Error(`服务器退出了: ${fs.readFileSync(path.join(serverDir, "server.out"), "utf8").slice(-600)}`);
    let text = ""; try { text = fs.readFileSync(serverLog, "utf8"); } catch { /* 还没写 */ }
    if (clientPhase(text).phase === "in_game") break;
    await sleep(1000);
  }
  log("服务器起来了 (有模组 achievement-probe, 没有 RCON)");
  const clientLog = path.join(clientDir, "factorio-current.log");
  fs.rmSync(clientLog, { force: true });
  client = spawn(exe, ["-c", path.join(clientDir, "config.ini"), "--mp-connect", `127.0.0.1:${port}`, "--password", password], { stdio: "ignore", detached: true, env: steamEnv });
  client.unref();
  log(`开你的 Steam 版 (单独配置目录) 连进去, 进程 ${client.pid}`);
  for (let i = 0; ; i++) {
    if (i >= 180) throw new Error("客户端 3 分钟没进世界");
    if (client.exitCode !== null) throw new Error(`客户端退出了 (${client.exitCode})`);
    try {
      const { phase, reason } = clientPhase(fs.readFileSync(clientLog, "utf8"));
      if (phase === "in_game") break;
      if (phase === "disconnected" || phase === "server_left") throw new Error(`连不上: ${reason ?? phase}`);
    } catch (e) { if (e.code !== "ENOENT" && e.code !== "EBUSY") throw e; }
    await sleep(1000);
  }
  log("进世界了。请在游戏里: 放下太阳能板, 铺几节铁轨放上机车, 然后关掉游戏窗口 (最多等 15 分钟)");
  for (let i = 0; i < 900 && client.exitCode === null; i++) await sleep(1000);
  log(client.exitCode === null ? "15 分钟到, 替你关窗口" : "你关了窗口");
} catch (e) {
  log(`出错: ${e.message}`);
} finally {
  await cleanup();
}
await sleep(6000);
const after = localAchievements();
const fresh = after ? newlyUnlocked(before.have, after.have) : [];
log(after ? `成就 ${before.have.length} → ${after.have.length}${fresh.length ? `; 新拿到: ${fresh.map((a) => `${a} (${after.names[a]})`).join("、")}` : "; 没有新的"}` : "读不到 Steam 缓存");
let cmds = 0; try { cmds = (fs.readFileSync(serverLog, "utf8").match(/COMMAND|silent-command/g) ?? []).length; } catch { /* */ }
log(`服务器日志里控制台命令的痕迹: ${cmds} 处`);
