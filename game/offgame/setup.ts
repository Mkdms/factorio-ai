#!/usr/bin/env node
// 游戏外模组宿主的准备: 在 data/venv 建 Python 虚拟环境并装 lupa (带真正的 Lua 5.2, 和游戏同版本; 模组按 5.2 写, 5.3 / 5.4 的整数规则会让数字格式对不上)。
//   npm run offgame:setup
// 要本机 python 3.12+ (.env 的 PYTHON 可指)。lupa 2.8 = 2026-11-07 查的 pip 最新版。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { dataRoot } from "../sandbox/paths.ts";
import { pythonExe } from "../memory/read.ts";
import { venvPython, venvReady } from "./host.ts";

const LUPA = "lupa==2.8";

export function ensureVenv(): string {
  const venv = path.join(dataRoot(), "venv");
  if (!fs.existsSync(venvPython())) {
    fs.mkdirSync(dataRoot(), { recursive: true });
    execFileSync(pythonExe(), ["-m", "venv", venv], { stdio: "inherit", windowsHide: true, timeout: 300_000 });
  }
  if (!venvReady()) execFileSync(venvPython(), ["-m", "pip", "install", "--disable-pip-version-check", LUPA], { stdio: "inherit", windowsHide: true, timeout: 600_000 });
  if (!venvReady()) throw new Error("装了 lupa 还是 import 不了 lupa.lua52");
  return venvPython();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try { console.log(`venv: ${ensureVenv()} (${LUPA})`); }
  catch (e) { console.error(`venv 没准备好: ${(e as Error).message}`); process.exit(1); }
}
