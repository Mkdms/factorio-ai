// 进程外读游戏内存 (库): 起 game/memory 下的 Python 脚本读一个游戏客户端进程, 结果给 TypeScript 这边用。
// 只读 (OpenProcess VM_READ + ReadProcessMemory), 不注入、不写; 布局由 pdb-dump 从游戏自带的 factorio.pdb 现场取 (reader.py), 缓存在 data/memory/。
// 读哪个 exe 就传哪个 exe (Steam 版和独立版不一样, 布局缓存按 exe 分); 要先 npm run memory:setup 编出 data/tools/pdb-dump.exe。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, dataRoot } from "../sandbox/paths.ts";

export const MEMORY_DIR = path.join(ROOT, "game", "memory");

/** 本机的 python 3.12+ (.env 的 PYTHON 可指; 默认 PATH 上的 python / python3) */
export function pythonExe(): string {
  return process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
}

/** pdb-dump.exe 在数据目录的 tools 下 (reader.py default_pdb_dump 同一条规则) */
export function pdbDumpExe(): string {
  return path.join(dataRoot(), "tools", "pdb-dump.exe");
}

export type Row = { name: string; x: number; y: number; unit?: number; type?: string; d?: Record<string, any>; d_error?: string };
export type EntityScan = { surface: string; chunks: number; count: number; dropped: Record<string, number>; ms: number; layout_ms: number; entities: Row[] };
export type PlayerRead = { position: { x: number; y: number }; inventory: { size: number; slots: { slot: number; item: number; quality: number; count: number; name?: string | null }[] }; reads: number; ms: number };
export type ProtoIds = { pid: number; module_base: string } & Record<string, { count: number; by_name: Record<string, number>; mismatch: unknown[] }>;

function runPy(script: string, args: string[], opts: { timeoutMs?: number } = {}): unknown {
  const raw = execFileSync(pythonExe(), ["-I", path.join(MEMORY_DIR, script), ...args], {
    encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: opts.timeoutMs ?? 300_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  return JSON.parse(raw);
}
const common = (exe: string) => ["--exe", exe, "--pdb-dump", pdbDumpExe()];

/** 一个地表的全部实体 (名字、位置; owned 里列的类型读编号; details 时按类读细节和推算状态, proto = 导出的 data-raw-dump.json, 推算堵料和默认状态要) */
export function readEntities(pid: number, exe: string, opts: { surface?: string; owned?: string[]; details?: boolean; proto?: string } = {}): EntityScan {
  const args = ["--pid", String(pid), ...common(exe), ...(opts.surface ? ["--surface", opts.surface] : []), ...(opts.details ? ["--details"] : []), ...(opts.proto ? ["--proto", opts.proto] : [])];
  let ownedFile: string | null = null;
  if (opts.owned) {
    ownedFile = path.join(os.tmpdir(), `factorio-ai-owned-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(ownedFile, JSON.stringify(opts.owned));
    args.push("--owned", ownedFile);
  }
  try { return runPy("entities.py", args) as EntityScan; }
  finally { if (ownedFile) fs.rmSync(ownedFile, { force: true }); }
}

/** 本地玩家的角色位置 + 主背包 (names: 把物品 ID 翻成名字) */
export function readPlayer(pid: number, exe: string, opts: { names?: boolean } = {}): PlayerRead {
  return runPy("player.py", ["--pid", String(pid), ...common(exe), ...(opts.names ? ["--names"] : [])]) as PlayerRead;
}

/** 世界级的东西: 研究、科技、修正、统计、污染、进化度 (形状见 world-compare.ts WorldMem) */
export function readWorld(pid: number, exe: string, surface = "nauvis"): Record<string, any> {
  return runPy("world.py", ["--pid", String(pid), ...common(exe), "--surface", surface]) as Record<string, any>;
}

/** 物品 / 品质原型的 名字 → 数字 ID (发玩家动作时格子要带的 ID) */
export function readProtoIds(pid: number, exe: string, kinds = "Item,Quality"): ProtoIds {
  return runPy("reader.py", ["--pid", String(pid), ...common(exe), "--kinds", kinds]) as ProtoIds;
}
