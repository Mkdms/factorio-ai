// 沙盘集成测试: 开班主循环在"干净的服务器" (不装任何模组, 当联机服务器的替身) 上不叫模型跑一班 (第一块的验收)。npm run test:sandbox
// 要: data/client、data/venv、data/tools/pdb-dump.exe, .env 的 FACTORIO_VIEWER_DIR (独立版)。开一个游戏窗口。
// 核的: 干净客户端进世界、注入、游戏外的模组起来、角色目录的 ./fh (sh 和 PowerShell 两版) 经管道能读能动、开班扫描写出来、放 STOP 正常收工、服务器没装模组也没有不同步。
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
  for (const f of ["fh", "fh.ps1", "AGENTS.md", "CLAUDE.md", "notes.md", "deadline.txt", "ref"]) assert.ok(fs.existsSync(path.join(roleDir, f)), `角色目录缺 ${f}`);
  assert.doesNotMatch(fs.readFileSync(path.join(roleDir, "fh"), "utf8"), /rcon|password/i, "包装脚本里不能有 RCON 密码");
  console.log(`  ${out.split("\n").filter((l) => /客户端: |挂上|起来了|控制台命令/.test(l)).join("\n  ").slice(0, 800)}`);
});

test("开班扫描写出来了 (Lua 跑在游戏外)", async () => {
  await waitFor("开班扫描", () => /开班扫描/.test(out), 3 * 60_000);
  assert.match(out, /开班扫描: /, out.slice(-800));
  const md = fs.readFileSync(path.join(roleDir, "world-scan.md"), "utf8");
  assert.match(md, /## 现状/);
  assert.match(md, /在线 1 人/);
  const json = readJson(path.join(runDir, "world-scan.json")) as { stage: string; lines: string[] };
  console.log(`  ${json.stage}; ${json.lines[0]}`);
});

test("角色目录的 ./fh (sh 版) 经管道: 读走外面, 动作走玩家操作", async () => {
  await waitFor("不叫模型", () => /不叫模型: 等到点/.test(out), 60_000);
  const sh = async (...argv: string[]) => { const { stdout } = await run(bashExe(), [path.join(roleDir, "fh"), ...argv, "--format", "json"], { cwd: roleDir, encoding: "utf8", timeout: 120_000, windowsHide: true }); return JSON.parse(stdout) as { ok?: boolean; result?: Record<string, any>; error?: { message?: string } }; };
  const inv = await sh("call", "inventory");
  assert.ok(inv.ok, JSON.stringify(inv).slice(0, 300));
  assert.match(String(inv.result?.inventory ?? ""), /stone-furnace/);
  const st = await sh("call", "status");
  assert.ok(st.ok, JSON.stringify(st).slice(0, 300));
  const built = await sh("call", "build", "--args", JSON.stringify({ item: "wooden-chest", position: { x: 0, y: 0 }, walk: true }), "--wait");
  console.log(`  build: ${JSON.stringify(built.result ?? built.error).slice(0, 200)}`);
  assert.ok(built.ok, JSON.stringify(built).slice(0, 400));
  const again = await sh("call", "inventory");
  assert.match(String(again.result?.inventory ?? ""), /wooden-chest\*3|wooden-chest 3/);
  const journal = fs.readFileSync(path.join(roleDir, "journal.jsonl"), "utf8").trim().split("\n");
  assert.ok(journal.length >= 4, `journal ${journal.length} 行`);
});

test("角色目录的 fh.ps1 (PowerShell 版) 同样能用, JSON 参数不拆坏", async () => {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(roleDir, "fh.ps1"), "call", "observe", "--args", '{"radius": 8}', "--format", "json"], { cwd: roleDir, encoding: "utf8", timeout: 120_000, windowsHide: true });
  const r = JSON.parse(stdout) as { ok?: boolean; result?: Record<string, any> };
  assert.ok(r.ok, stdout.slice(0, 300));
  assert.ok(JSON.stringify(r.result).includes("wooden-chest"), JSON.stringify(r.result).slice(0, 300));
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
