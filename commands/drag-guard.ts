// 拖游戏窗口不卡游戏: 见 drag-guard.ps1 (Windows 移动窗口的循环卡住主线程, 客户端每秒 0 tick; 脚本只能 ASCII, 系统自带的 PowerShell 5.1 按本地编码读)。
// 窗口自己的事, 不碰游戏数据、不注入; 起不来只报一句, 不影响别的。
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { ROOT } from "../game/sandbox/paths.ts";

export const DRAG_GUARD_SCRIPT = path.join(ROOT, "commands", "drag-guard.ps1");

/** 用系统自带的 Windows PowerShell: pwsh 7 不一定装了 */
export function dragGuardCommand(pid: number): { cmd: string; args: string[] } {
  return { cmd: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DRAG_GUARD_SCRIPT, String(pid)] };
}

/** 守卫的一行输出翻成日志; 平常拖一下不进日志 */
export function dragGuardLine(line: string): string | null {
  const s = line.trim();
  if (s === "up") return "窗口守卫起来了: 拖窗口不卡游戏";
  if (s.startsWith("fail:") || s.startsWith("stuck:")) return `窗口守卫: ${s} (拖窗口时游戏会停, 别的不受影响)`;
  return null;
}

type Spawn = (cmd: string, args: string[], opts: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: true }) => Pick<ChildProcess, "stdout" | "stderr" | "on" | "kill">;

/** 起守卫, 返回关它的函数; 不是 Windows 什么都不做。守卫自己也会跟着游戏退出 */
export function startDragGuard(pid: number, log: (s: string) => void, run: Spawn = spawn as unknown as Spawn, platform = process.platform): () => void {
  if (platform !== "win32") return () => undefined;
  const { cmd, args } = dragGuardCommand(pid);
  const c = run(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let rest = "";
  c.stdout?.setEncoding("utf8");
  c.stdout?.on("data", (d: string) => {
    const lines = (rest + d).split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const l of lines) { const out = dragGuardLine(l); if (out) log(out); }
  });
  let err = "";
  c.stderr?.setEncoding("utf8");
  c.stderr?.on("data", (d: string) => { err += d; });
  let stopped = false;
  c.on("error", (e: Error) => log(`窗口守卫起不来: ${e.message.slice(0, 160)} (拖窗口时游戏会停, 别的不受影响)`));
  c.on("exit", (code: number | null) => { if (!stopped && code) log(`窗口守卫退出了 (${code}): ${err.trim().slice(0, 200)} (拖窗口时游戏会停, 别的不受影响)`); });
  return () => { stopped = true; c.kill(); };
}
