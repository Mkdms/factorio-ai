#!/usr/bin/env node
// 从零跑起来: npm ci 之后 npm run setup 一条命令把仓库放不下的准备好。可以重复跑, 已有的跳过。
// 仓库里放不了的: 游戏本体和它导出的数据 (Wube 的版权, 从你本机的游戏现导)、派对工程 (MIT, 按固定提交取)、MCP (czp 工程的 fork, 取编好的程序)。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { findFactorioDir, labRoot, REPO } from "../src/lab/gamedir.ts";
import { LabInstance } from "../src/lab/instance.ts";

/** 和我们移植、核对过的派对提交 (NOTICE; src/play/party-upstream.ts) */
const PARTY = { url: "https://github.com/nwinter/factorio-ai-party.git", commit: "a9a5556a83993e1c2605c4663da4f34312cf0d3b" };
/** MCP: 2026-11-06 在 Factorio 2.1.24 上核过 (FORK.md) */
const MCP = { url: "https://github.com/Mkdms/factorio-mcp/releases/download/pilot-e460220/factorio-mcp-pilot-win64.zip", sha256: "494AC4FF6C28A98E6D808044ED410D12BB9C3B5BAA60DF4E95BCB2F780E0A5CC" };

const VENDOR = path.join(labRoot(), "vendor");
const ENV = path.join(REPO, ".env");
const run = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8", windowsHide: true });
/** 在子工程里跑 npm: 明确给 --prefix, 不然 npm --prefix 仓库 run setup 带下来的环境会让它落到仓库根 */
const npm = (dir: string, ...args: string[]) => {
  const cli = process.env.npm_execpath;
  if (cli) return run(process.execPath, [cli, "--prefix", dir, ...args], dir);
  return process.platform === "win32" ? run("cmd", ["/d", "/c", "npm", "--prefix", dir, ...args], dir) : run("npm", ["--prefix", dir, ...args], dir);
};
const results: string[] = [];
const ok = (s: string) => { results.push(`✅ ${s}`); console.log(`✅ ${s}`); };
const warn = (s: string) => { results.push(`⚠️ ${s}`); console.log(`⚠️ ${s}`); };

/** 写 .env 的一项: 已经有值的不动 (用户自己配的优先) */
function setEnv(key: string, value: string): void {
  const text = fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8") : "";
  if (new RegExp(`^${key}=.+`, "m").test(text)) return;
  fs.writeFileSync(ENV, `${text.replace(/\s*$/, "\n")}${key}=${value.replace(/\\/g, "/")}\n`);
  process.env[key] = value;
}

// 1. .env + 游戏目录
if (!fs.existsSync(ENV)) { fs.writeFileSync(ENV, "LAB_VIEW=0\n"); ok(".env 建好了"); }
let hasGame = true;
/** Steam 可以装在任意盘: 查注册表里的 Steam 目录, 再看它记的每个库 (libraryfolders.vdf) */
function steamFactorio(): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const steam = /SteamPath\s+REG_SZ\s+(.+)/.exec(run("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"]))?.[1]?.trim();
    if (!steam) return undefined;
    const vdf = fs.readFileSync(path.join(steam, "steamapps", "libraryfolders.vdf"), "utf8");
    const libs = [steam, ...[...vdf.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => m[1].replace(/\\\\/g, "\\"))];
    return libs.map((l) => path.join(l, "steamapps", "common", "Factorio")).find((d) => fs.existsSync(path.join(d, "bin", "x64", "factorio.exe")));
  } catch { return undefined; }
}
try {
  const found = process.env.FACTORIO_DIR ? undefined : steamFactorio();
  if (found) process.env.FACTORIO_DIR = found;
  const dir = findFactorioDir();
  setEnv("FACTORIO_DIR", dir);
  ok(`Factorio: ${dir}`);
}
catch { hasGame = false; warn("没找到 Factorio: 在 .env 里写 FACTORIO_DIR=安装目录, 再跑一次 npm run setup (游戏要 2.1, 带太空时代)"); }

// 2. Python 环境
const venv = path.join(labRoot(), "venv");
const py = path.join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
try {
  if (!fs.existsSync(py)) run("python", ["-m", "venv", venv]);
  run(py, ["-m", "pip", "install", "--quiet", "-r", path.join(REPO, "requirements.txt")]);
  ok(`Python 依赖: ${venv}`);
} catch (e) { warn(`Python 依赖没装上 (要 Python 3.11+): ${(e as Error).message.slice(0, 200)}`); }

// 3. 派对工程 (简报、手册、./fh 命令行)
const party = path.join(VENDOR, "factorio-ai-party");
try {
  fs.mkdirSync(party, { recursive: true });
  const at = fs.existsSync(path.join(party, ".git")) ? run("git", ["rev-parse", "HEAD"], party).trim() : "";
  if (at !== PARTY.commit) {
    if (!at) { run("git", ["init", "-q"], party); run("git", ["remote", "add", "origin", PARTY.url], party); }
    run("git", ["fetch", "-q", "--depth", "1", "origin", PARTY.commit], party);
    run("git", ["checkout", "-q", "FETCH_HEAD"], party);
  }
  // 模型的 ./fh 走它编出来的命令行, dist 不进 git; 没编 ./fh 一条都跑不了 (2026-11-06 全新目录联机试出来的)
  const harness = path.join(party, "vendor", "factorio-harness");
  if (at !== PARTY.commit || !fs.existsSync(path.join(harness, "dist", "host", "cli.js"))) {
    npm(harness, "ci", "--ignore-scripts");
    npm(harness, "run", "build");
  }
  setEnv("PARTY_REPO", party);
  ok(`派对工程 (${PARTY.commit.slice(0, 8)}): ${party}`);
} catch (e) { warn(`派对工程没取到: ${(e as Error).message.slice(0, 200)}`); }

// 4. MCP (联机动手要; 只读和沙盘不要)
const mcpDir = path.join(VENDOR, "factorio-mcp"), exe = path.join(mcpDir, "factorio-mcp.exe");
if (process.platform !== "win32") warn("MCP 只有 Windows 版; 联机动手要在 Windows 上跑");
else try {
  if (!fs.existsSync(exe)) {
    fs.mkdirSync(mcpDir, { recursive: true });
    const zip = path.join(mcpDir, "mcp.zip");
    run("curl", ["-fsSL", "-o", zip, MCP.url]);
    const got = crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex").toUpperCase();
    if (got !== MCP.sha256) throw new Error(`校验不对: ${got}`);
    // 用 Python 解压: Git for Windows 的 tar 把 "I:\..." 当成远程主机; 从 pwsh 里调 PowerShell 5 的 Expand-Archive 也会失败 (2026-11-06 从零试出来的)
    run(py, ["-I", "-m", "zipfile", "-e", zip, mcpDir]);
    fs.rmSync(zip);
  }
  setEnv("CZP_MCP_EXE", exe);
  ok(`MCP: ${exe}`);
} catch (e) { warn(`MCP 没取到: ${(e as Error).message.slice(0, 200)}; 联机动手用不了, 沙盘不受影响`); }

// 5. pdb-dump: 联机读内存要它从游戏自带的 factorio.pdb 取偏移 (tools/memread 默认到本机数据目录的 tools 下找); 我们自己的源码, 用本机的 VS 现编 (2026-11-06 全新目录联机试出来的)
function buildPdbDump(out: string): void {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!fs.existsSync(vswhere)) throw new Error("没找到 Visual Studio");
  const vcvars = run(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-find", "VC\\Auxiliary\\Build\\vcvars64.bat"]).trim().split(/\r?\n/)[0];
  if (!vcvars) throw new Error("Visual Studio 没装 C++ 桌面开发组件");
  const dir = path.dirname(out), obj = out.replace(/\.exe$/, ".obj"), script = out.replace(/\.exe$/, "-build.cmd");
  fs.mkdirSync(dir, { recursive: true });
  // 写成 .cmd 再跑: vcvars 的路径带空格和括号, 直接经 cmd /c 传参容易被拆
  fs.writeFileSync(script, ["@echo off", "chcp 65001 >nul", `call "${vcvars}" >nul`, `cl /nologo /EHsc /O1 /std:c++17 /utf-8 /Fe:"${out}" /Fo:"${obj}" "${path.join(REPO, "tools", "pdb-dump", "pdb-dump.cpp")}" /link dbghelp.lib`, "exit /b %errorlevel%", ""].join("\r\n"));
  try { run("cmd", ["/d", "/c", script]); }
  catch (e) { throw new Error(`编译失败: ${String((e as { stdout?: string }).stdout ?? (e as Error).message).slice(-300)}`); }
  finally { fs.rmSync(script, { force: true }); fs.rmSync(obj, { force: true }); }
  if (!fs.existsSync(out)) throw new Error("编译后没找到 exe");
}
const pdbDump = path.join(labRoot(), "tools", "pdb-dump.exe");
if (process.platform === "win32") try {
  if (!fs.existsSync(pdbDump)) buildPdbDump(pdbDump);
  ok(`pdb-dump: ${pdbDump}`);
} catch (e) { warn(`pdb-dump 没准备好: ${(e as Error).message}; 要 Visual Studio 的 C++ 桌面开发组件, 装好再跑一次 npm run setup。联机读内存用不了, 沙盘不受影响`); }

// 6. 游戏数据 (从本机游戏现导, 不进仓库)
if (hasGame) {
  try {
    // 走 npm run lab:dump 同一条路: 除了原型数据还要开一次沙盘导 defines 和铁轨几何, 联机读内存缺了 defines.json 起不来 (2026-11-06 全新目录联机试出来的)
    run(process.execPath, ["--env-file-if-exists=.env", path.join("src", "lab", "cli.ts"), "dump-data"], REPO);
    const dir = new LabInstance({ name: "setup", view: false, label: "npm run setup" }).prototypesDir();
    const missing = ["data-raw-dump.json", "defines.json", "rail-geometry.json"].filter((f) => !fs.existsSync(path.join(dir, f)));
    if (missing.length) throw new Error(`导完还缺 ${missing.join("、")}`);
    ok(`游戏数据: ${dir}`);
  } catch (e) { warn(`游戏数据没导出来: ${(e as Error).message.slice(0, 300)}`); }
}

// 7. 要自己准备的
if (!process.env.FACTORIO_VIEWER_DIR) warn("联机时 AI 用的客户端要独立版: 从 factorio.com 下载解压, .env 写 FACTORIO_VIEWER_DIR=目录 (游戏要自己买, 不能打包); 只跑沙盘不要");

console.log(`\n完成: ${results.filter((r) => r.startsWith("✅")).length} 项好了, ${results.filter((r) => r.startsWith("⚠️")).length} 项要看。试试: npm test; npm run bp -- list furnace`);
process.exit(0);
