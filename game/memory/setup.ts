#!/usr/bin/env node
// 读内存的准备: 用本机的 Visual Studio 把 pdb-dump.cpp 编成 data/tools/pdb-dump.exe (reader.py 靠它从 factorio.pdb 现场取布局)。
//   npm run memory:setup [-- --force]     源码比 exe 新或没有 exe 才编; --force 一定编
// 要 Visual Studio 的 C++ 桌面开发组件 (vswhere 找 vcvars64.bat)。只在 Windows 上有意义 (读的是 Windows 版游戏)。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { MEMORY_DIR, pdbDumpExe } from "./read.ts";

const run = (file: string, args: string[]) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 600_000 });

/** 编 pdb-dump.exe 到 out */
export function buildPdbDump(out: string): void {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!fs.existsSync(vswhere)) throw new Error("没找到 Visual Studio (vswhere.exe)");
  const vcvars = run(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-find", "VC\\Auxiliary\\Build\\vcvars64.bat"]).trim().split(/\r?\n/)[0];
  if (!vcvars) throw new Error("Visual Studio 没装 C++ 桌面开发组件");
  const dir = path.dirname(out), obj = out.replace(/\.exe$/, ".obj"), script = out.replace(/\.exe$/, "-build.cmd");
  fs.mkdirSync(dir, { recursive: true });
  // 写成 .cmd 再跑: vcvars 的路径带空格和括号, 直接经 cmd /c 传参容易被拆
  const src = path.join(MEMORY_DIR, "pdb-dump.cpp");
  fs.writeFileSync(script, ["@echo off", "chcp 65001 >nul", `call "${vcvars}" >nul`, `cl /nologo /EHsc /O1 /std:c++17 /utf-8 /Fe:"${out}" /Fo:"${obj}" "${src}" /link dbghelp.lib`, "exit /b %errorlevel%", ""].join("\r\n"));
  try { run("cmd", ["/d", "/c", script]); }
  catch (e) { throw new Error(`编译失败: ${String((e as { stdout?: string }).stdout ?? (e as Error).message).slice(-300)}`); }
  finally { fs.rmSync(script, { force: true }); fs.rmSync(obj, { force: true }); }
  if (!fs.existsSync(out)) throw new Error("编译后没找到 exe");
}

/** 没有 exe 或源码更新了就编; 返回 exe 路径 */
export function ensurePdbDump(force = false): string {
  const out = pdbDumpExe();
  const src = path.join(MEMORY_DIR, "pdb-dump.cpp");
  const stale = !fs.existsSync(out) || fs.statSync(src).mtimeMs > fs.statSync(out).mtimeMs;
  if (force || stale) buildPdbDump(out);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  if (process.platform !== "win32") { console.log("读内存只做了 Windows 版游戏, 这台机器不用编 pdb-dump"); process.exit(0); }
  try {
    const out = ensurePdbDump(process.argv.includes("--force"));
    console.log(`pdb-dump: ${out}`);
  } catch (e) {
    console.error(`pdb-dump 没准备好: ${(e as Error).message}; 要 Visual Studio 的 C++ 桌面开发组件, 装好再跑一次 npm run memory:setup`);
    process.exit(1);
  }
}
