// 游戏外的模组宿主 (库): 起 host.py (lupa 跑 harness 模组的 Lua, 数据来自读内存), 一问一答。
// 游戏里不跑任何代码: 读世界 = game/memory 进程外读内存; 账本 (队列、消息、教训) = 本机文件; 后台任务在外面逐 tick 跑。
// 要 data/venv 里装 lupa (npm run offgame:setup)。协议 (host.py --serve): 标准输入一行一个 JSON 请求, 标准输出一行一个 JSON 回复。
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ROOT, dataRoot } from "../sandbox/paths.ts";

export const OFFGAME_DIR = path.join(ROOT, "game", "offgame");
/** harness 模组 (game/mod/ 下): 游戏外的宿主加载它的 Lua; 沙盘测试里装进游戏当真值 */
export const HARNESS_MOD = "factorio-ai-harness";
export const HARNESS_DIR = path.join(ROOT, "game", "mod", HARNESS_MOD);

/** data/venv 里的 python (lupa 装在这里) */
export function venvPython(): string {
  return path.join(dataRoot(), "venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
}
/** venv 在不在、lupa 装了没 (没有就提示 npm run offgame:setup) */
export function venvReady(): boolean {
  if (!fs.existsSync(venvPython())) return false;
  try { execFileSync(venvPython(), ["-I", "-c", "import lupa.lua52"], { stdio: "ignore", windowsHide: true, timeout: 60_000 }); return true; }
  catch { return false; }
}

export type HostArgs = {
  /** 导出的 defines.json (SandboxServer.dumpDefines) */
  defines: string;
  /** 导出的 data-raw-dump.json */
  proto: string;
  /** 读活内存: 游戏客户端进程号和它的 exe */
  pid?: number; exe?: string;
  /** 回放留底的快照 (不开游戏) */
  snapshot?: string;
  surface?: string;
  /** 直接追加的参数 (--serve、--state、--ask ...) */
  extra?: string[];
};
export function hostArgs(a: HostArgs): string[] {
  return [
    "-I", path.join(OFFGAME_DIR, "host.py"), "--defines", a.defines, "--proto", a.proto,
    ...(a.pid ? ["--pid", String(a.pid), "--exe", a.exe ?? ""] : []),
    ...(a.snapshot ? ["--snapshot", a.snapshot] : []),
    ...(a.surface ? ["--surface", a.surface] : []),
    ...(a.extra ?? []),
  ];
}

/** 一次性跑完 (--dump / --ask ... --out), 回标准输出的 JSON */
export function runHost(args: string[], opts: { timeoutMs?: number } = {}): unknown {
  const raw = execFileSync(venvPython(), args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: opts.timeoutMs ?? 180_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const last = raw.trim().split("\n").at(-1) ?? "";
  return JSON.parse(last);
}

export type Host = {
  child: ChildProcessWithoutNullStreams;
  /** 加载结果 (模块数、恢复了账本没) */
  load: { ok: boolean; error?: string; restored?: boolean; modules?: number; load_ms?: number };
  /** 下一行回复 */
  next: () => Promise<string>;
  /** 一问一答 */
  ask: (req: unknown) => Promise<any>;
  /** 正常退出 (账本写盘) 并等它结束 */
  stop: () => Promise<void>;
};

/** 起常驻宿主 (args 里要有 --serve) */
export async function startHost(args: string[], opts: { replyTimeoutMs?: number } = {}): Promise<Host> {
  const child = spawn(venvPython(), args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buf = "";
  const waiters: ((line: string) => void)[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (s: string) => {
    buf += s;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { const line = buf.slice(0, i); buf = buf.slice(i + 1); waiters.shift()?.(line); }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (s: string) => { stderr += s; });
  const next = () => new Promise<string>((resolve, reject) => {
    waiters.push(resolve);
    setTimeout(() => reject(new Error(`常驻宿主 ${opts.replyTimeoutMs ?? 60_000} 毫秒没回: ${stderr.slice(-300)}`)), opts.replyTimeoutMs ?? 60_000).unref();
  });
  const ready = JSON.parse(await next()) as { ready: boolean; load: Host["load"] };
  if (!ready.load?.ok) throw new Error(`宿主加载失败: ${ready.load?.error}`);
  const stop = () => new Promise<void>((r) => { if (child.exitCode !== null) return r(); child.once("exit", () => r()); child.stdin.end(); });
  return { child, load: ready.load, next, ask: async (req) => { child.stdin.write(`${JSON.stringify(req)}\n`); return JSON.parse(await next()); }, stop };
}
