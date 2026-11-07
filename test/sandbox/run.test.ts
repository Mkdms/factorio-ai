// 沙盘集成测试: 开班主循环在"干净的服务器" (不装任何模组, 当联机服务器的替身) 上不叫模型跑一班 (第一块的验收)。npm run test:sandbox
// 要: data/client、data/venv、data/tools/pdb-dump.exe, .env 的 FACTORIO_VIEWER_DIR (独立版)。开一个游戏窗口。
// 核的: 干净客户端进世界、注入、游戏外的模组起来、角色目录的 ./fh (sh 和 PowerShell 两版) 经管道能读能动、开班扫描写出来并附要点、放东西时回复带出教训、./know 和 ./fh help 手册能用、放 STOP 正常收工、服务器没装模组也没有不同步。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { ROOT, dataRoot } from "../../game/sandbox/paths.ts";
import { bashExe } from "../../core/run/shell.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);
const runId = `test-run-${Date.now()}`;
const runDir = path.join(dataRoot(), "play", "online", runId);
let child: ChildProcess;
let out = "";
let exitCode: number | null = null;
let roleDir = "";
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const waitFor = async (what: string, f: () => boolean, ms: number) => { const t = Date.now(); while (!f()) { assert.ok(exitCode === null, `主循环提前退出 (${exitCode}) 等 ${what} 时:\n${out.slice(-1500)}`); assert.ok(Date.now() - t < ms, `${ms / 1000} 秒没等到 ${what}:\n${out.slice(-1500)}`); await sleep(1000); } };

before(() => {
  child = spawn(process.execPath, ["--env-file-if-exists=.env", "core/run/online.ts", "--lab", "--minutes", "15", "--name", "RunCheck", "--run-id", runId], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, BRAIN_DIR: path.join(dataRoot(), "brain-test") } });
  child.stdout!.setEncoding("utf8"); child.stdout!.on("data", (d: string) => { out += d; });
  child.stderr!.setEncoding("utf8"); child.stderr!.on("data", (d: string) => { out += d; });
  child.on("exit", (c) => { exitCode = c; });
});
after(async () => {
  if (exitCode === null) { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(path.join(runDir, "STOP"), "test"); for (let i = 0; i < 60 && exitCode === null; i++) await sleep(1000); }
  if (exitCode === null) child.kill();
  fs.rmSync(path.join(dataRoot(), "brain-test"), { recursive: true, force: true });
});

test("干净客户端进世界、注入、游戏外的模组起来, 角色目录和记录都写了", async () => {
  await waitFor("run.json", () => fs.existsSync(path.join(runDir, "run.json")), 6 * 60_000);
  const run1 = readJson(path.join(runDir, "run.json")) as { name: string; dir: string; backend: string; readOnly: boolean };
  roleDir = run1.dir;
  assert.equal(run1.backend, "memory");
  assert.equal(run1.readOnly, false);
  const where = readJson(path.join(runDir, "where.json")) as { player: { name?: string }; hasBody: boolean; surfaces: { name: string; here: boolean }[] };
  assert.equal(where.player.name, "RunCheck");
  assert.equal(where.hasBody, true);
  assert.equal(where.surfaces.find((s) => s.here)?.name, "nauvis");
  for (const f of ["fh", "fh.ps1", "know", "know.ps1", "AGENTS.md", "CLAUDE.md", "notes.md", "deadline.txt", "ref/building.md", "ref/pattern-production.md", "ref/facts.md", "ref/names.tsv"]) assert.ok(fs.existsSync(path.join(roleDir, f)), `角色目录缺 ${f}`);
  assert.doesNotMatch(fs.readFileSync(path.join(roleDir, "fh"), "utf8"), /rcon|password/i, "包装脚本里不能有 RCON 密码");
  const brief = fs.readFileSync(path.join(roleDir, "CLAUDE.md"), "utf8");
  assert.doesNotMatch(brief, /\{\{/, "简报模板没填满");
  assert.match(brief, /## 先读这一节[\s\S]*`RunCheck`[\s\S]*## 手册主题[\s\S]*`pattern-production`/);
  assert.match(out, /教训: 种子 \d+ 条/);
  console.log(`  ${out.split("\n").filter((l) => /客户端: |挂上|起来了|控制台命令/.test(l)).join("\n  ").slice(0, 800)}`);
});

test("开班扫描写出来了 (Lua 跑在游戏外)", async () => {
  await waitFor("开班扫描", () => /开班扫描/.test(out), 3 * 60_000);
  assert.match(out, /开班扫描: /, out.slice(-800));
  const md = fs.readFileSync(path.join(roleDir, "world-scan.md"), "utf8");
  assert.match(md, /## 现状/);
  assert.match(md, /在线 1 人/);
  assert.match(md, /## 相关要点[\s\S]*\(P-/, "开班扫描后面要附要点 (刚开局对得上)");
  const json = readJson(path.join(runDir, "world-scan.json")) as { stage: string; lines: string[] };
  console.log(`  ${json.stage}; ${json.lines[0]}`);
});

test("角色目录的 ./fh (sh 版) 经管道: 读走外面, 动作走玩家操作", async () => {
  await waitFor("不叫模型", () => /不叫模型: 等到点/.test(out), 60_000);
  const sh = async (...argv: string[]) => { const { stdout } = await run(bashExe(), [path.join(roleDir, "fh"), ...argv, "--format", "json"], { cwd: roleDir, encoding: "utf8", timeout: 120_000, windowsHide: true }); return JSON.parse(stdout) as { ok?: boolean; result?: Record<string, any>; error?: { message?: string } }; };
  // 起始物资就是游戏给的 (freeplay: 热能采矿机 1、石炉 1、手枪和弹药), 没经控制台加料
  const inv = await sh("call", "inventory");
  assert.ok(inv.ok, JSON.stringify(inv).slice(0, 300));
  assert.match(String(inv.result?.inventory ?? ""), /stone-furnace\*1|stone-furnace 1/, String(inv.result?.inventory));
  assert.doesNotMatch(String(inv.result?.inventory ?? ""), /wooden-chest/, "没有控制台给的料");
  assert.match(out, /console_command_used\)[^\n]*"value":false/, "这张图不能用过控制台命令");
  const st = await sh("call", "status");
  assert.ok(st.ok, JSON.stringify(st).slice(0, 300));
  const built = await sh("call", "build", "--args", JSON.stringify({ item: "stone-furnace", position: { x: 0, y: 0 }, walk: true }), "--wait");
  console.log(`  build: ${JSON.stringify(built.result ?? built.error).slice(0, 200)}`);
  assert.ok(built.ok, JSON.stringify(built).slice(0, 400));
  assert.ok(Array.isArray(built.result?.lessons) && built.result.lessons.length >= 1, `放东西的回复要带出教训: ${JSON.stringify(built.result).slice(0, 300)}`);
  // 不是给程序读的回复 (没 --format): 报错后面附相关经验和查法 (热能采矿机不能放在没矿的格子, 这里故意放不下)
  const drill = await run(bashExe(), [path.join(roleDir, "fh"), "call", "build", "--args", JSON.stringify({ item: "burner-mining-drill", position: { x: 4, y: 0 }, walk: true }), "--wait"], { cwd: roleDir, encoding: "utf8", timeout: 120_000, windowsHide: true }).catch((e: { stdout?: string }) => e);
  const drillOut = String(drill.stdout ?? "");
  assert.match(drillOut, /error: action_failed: placement blocked/, drillOut.slice(-600));
  assert.match(drillOut, /相关教训: /, "失败的动作也带教训");
  assert.match(drillOut, /查法: \.\/know build burner-mining-drill; 参数: \.\/fh help build/, drillOut.slice(-600));
  assert.ok(!fs.existsSync(path.join(roleDir, ".fh-hints.err")), fs.existsSync(path.join(roleDir, ".fh-hints.err")) ? fs.readFileSync(path.join(roleDir, ".fh-hints.err"), "utf8") : "");
  const again = await sh("call", "inventory");
  assert.doesNotMatch(String(again.result?.inventory ?? ""), /stone-furnace/, "石炉放下去了");
  const journal = fs.readFileSync(path.join(roleDir, "journal.jsonl"), "utf8").trim().split("\n");
  assert.ok(journal.length >= 4, `journal ${journal.length} 行`);
});

test("角色目录的 fh.ps1 (PowerShell 版) 同样能用, JSON 参数不拆坏", async () => {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(roleDir, "fh.ps1"), "call", "observe", "--args", '{"radius": 16}', "--format", "json"], { cwd: roleDir, encoding: "utf8", timeout: 120_000, windowsHide: true });
  const r = JSON.parse(stdout) as { ok?: boolean; result?: Record<string, any> };
  assert.ok(r.ok, stdout.slice(0, 300));
  assert.ok(JSON.stringify(r.result).includes("stone-furnace"), JSON.stringify(r.result).slice(0, 300));
});

test("角色目录的 ./know 和 ./fh help: 查积累 (sh 和 ps1), 手册大的先回目录、按段看", async () => {
  const { stdout: know } = await run(bashExe(), [path.join(roleDir, "know"), "研究中心"], { cwd: roleDir, encoding: "utf8", timeout: 60_000, windowsHide: true });
  assert.match(know, /^\[(思路|事实|要点|教训|资料) /m, know.slice(0, 300));
  assert.match(know, /还有 \d+ 条/);
  const { stdout: knowPs } = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(roleDir, "know.ps1"), "地下管道", "方向"], { cwd: roleDir, encoding: "utf8", timeout: 60_000, windowsHide: true });
  assert.match(knowPs, /地下管道|pipe-to-ground/, knowPs.slice(0, 300));
  const { stdout: toc } = await run(bashExe(), [path.join(roleDir, "fh"), "help", "building"], { cwd: roleDir, encoding: "utf8", timeout: 60_000, windowsHide: true });
  assert.match(toc, /building 共 \d+ 字 \d+ 段, 整份读太占上下文/, toc.slice(0, 300));
  const { stdout: sec } = await run(bashExe(), [path.join(roleDir, "fh"), "help", "pattern-production", "P-prod-01"], { cwd: roleDir, encoding: "utf8", timeout: 60_000, windowsHide: true });
  assert.match(sec, /pattern-production 第 \d+\/\d+ 段[\s\S]*一条带满载/, sec.slice(0, 300));
  const { stdout: topics } = await run(bashExe(), [path.join(roleDir, "fh"), "help"], { cwd: roleDir, encoding: "utf8", timeout: 60_000, windowsHide: true });
  assert.match(topics, /building/);
  assert.match(topics, /\.\/know 关键词/);
  assert.match(fs.readFileSync(path.join(roleDir, "journal.jsonl"), "utf8"), /"event":"help"/, "查手册也记 journal");
});

test("放 STOP 正常收工: 记录齐全, 服务器没装模组、没有不同步, 游戏进程都关了", async () => {
  fs.writeFileSync(path.join(runDir, "STOP"), "test");
  for (let i = 0; i < 90 && exitCode === null; i++) await sleep(1000);
  assert.equal(exitCode, 0, out.slice(-1500));
  assert.match(out, /收工: STOP/);
  const end = readJson(path.join(runDir, "end.json")) as { why: string };
  assert.equal(end.why, "STOP");
  assert.ok(fs.existsSync(path.join(runDir, "probe-stats.json")));
  const serverDir = path.join(dataRoot(), "sandbox", "online");
  const mods = readJson(path.join(serverDir, "mods", "mod-list.json")) as { mods: { name: string; enabled: boolean }[] };
  assert.deepEqual(mods.mods.filter((m) => m.enabled && !["base", "space-age", "elevated-rails", "quality", "recycler"].includes(m.name)), [], "服务器装了别的模组");
  const serverOut = fs.readFileSync(path.join(serverDir, "server.out"), "utf8");
  assert.match(serverOut, /\[JOIN\] RunCheck/);
  assert.doesNotMatch(serverOut, /desync/i);
  const { stdout } = await run("tasklist", [], { encoding: "utf8", windowsHide: true });
  assert.doesNotMatch(stdout, /factorio\.exe|factorio-ai-client\.exe/i, "游戏或客户端程序还在跑");
});
