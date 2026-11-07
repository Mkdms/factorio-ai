// 用模型玩用户账号的本机图 (mk-world.ts) 的共用部分: 界面开局、停局、看状态都靠这里 (mk-world.ts 是脚本, import 会直接运行)。
// ; 这条路不走班次那套 (play/runs、current-run.json), 记录在 play/online/<runId>。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { RosterSeat } from "./roster.ts";

export type MkResult = { before: number; after: number | null; fresh: string[] };
export type MkCurrent = {
  runId: string; runDir: string; pid: number; startedAt: string;
  group?: string; brain: string; model?: string; effort: string; minutes: number;
  /** 收工的时间; 没有 = 还在跑 (进程还活着的话) */
  ended?: string;
  result?: MkResult;
  error?: string;
};

export const mkCurrentFile = (playDir: string) => path.join(playDir, "mk-current.json");

export function readMkCurrent(playDir: string): MkCurrent | null {
  try { return JSON.parse(fs.readFileSync(mkCurrentFile(playDir), "utf8")) as MkCurrent; } catch { return null; }
}

export function writeMkCurrent(playDir: string, c: MkCurrent): void {
  fs.mkdirSync(playDir, { recursive: true });
  fs.writeFileSync(mkCurrentFile(playDir), JSON.stringify(c, null, 1));
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 这一局还在不在跑: 没写收工且进程活着 (被强行结束时写不了收工, 只能看进程) */
export const mkRunning = (c: MkCurrent | null, alive: (pid: number) => boolean = pidAlive): boolean => !!c && !c.ended && alive(c.pid);

/** 用户的 Steam 版开着吗: 开着 = 他在玩, 账号归他, 不碰; 独立版和沙盘的服务器不算 */
export function isSteamClientLine(line: string, exe: string): boolean {
  return line.toLowerCase().startsWith(exe.toLowerCase().replace(/\//g, "\\")) && !/--start-server|--create/.test(line);
}

export function steamClientRunning(exe: string): boolean {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='factorio.exe'\" | ForEach-Object { $_.ExecutablePath + '|' + $_.CommandLine }"], { encoding: "utf8", windowsHide: true });
  return out.split(/\r?\n/).some((l) => isSteamClientLine(l, exe));
}

/** 第 1 席 + 群的设置 → mk-world.ts 的参数。每个群一张图 (--world) */
export function mkArgs(group: { id: string; minutes: number; seats: RosterSeat[] }, goalFile?: string): string[] {
  const s = group.seats[0];
  if (!s) throw new Error("这个群没有选模型");
  return ["--world", group.id, "--brain", s.brain, ...(s.model ? ["--model", s.model] : []), "--effort", s.effort ?? "low", "--minutes", String(group.minutes), ...(goalFile ? ["--goal-file", goalFile] : [])];
}

/** 请这一局收工: 往它的记录目录放 STOP (online.ts 2 秒内看到, 关模型; mk-world 再关游戏、比成就) */
export function mkStop(playDir: string, why: string): { ok: boolean; runId?: string; error?: string } {
  const c = readMkCurrent(playDir);
  if (!c || c.ended) return { ok: false, error: "没有在跑的局" };
  const root = path.resolve(playDir, "online");
  const dir = path.resolve(c.runDir);
  if (!dir.startsWith(root + path.sep)) return { ok: false, error: `${dir} 不在 ${root} 下面, 不写` };
  fs.mkdirSync(dir, { recursive: true });
  const stop = path.join(dir, "STOP");
  if (!fs.existsSync(stop)) fs.writeFileSync(stop, `${why}\n`);
  return { ok: true, runId: c.runId };
}

/** 模型最近说的几句 (turn-*.jsonl 尾部): 界面右栏看它在干嘛 */
export function mkModelLines(runDir: string, n = 6): string[] {
  let files: string[] = [];
  try { files = fs.readdirSync(runDir).filter((f) => /^turn-\d+\.jsonl$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])); } catch { return []; }
  const out: string[] = [];
  for (const f of files.reverse()) {
    const text = tail(path.join(runDir, f), 256 * 1024);
    const found: string[] = [];
    for (const l of text.split(/\r?\n/)) {
      let j: { type?: string; message?: { content?: { type?: string; text?: string }[] } };
      try { j = JSON.parse(l); } catch { continue; } // 尾部切开的半行
      if (j.type !== "assistant") continue;
      for (const c of j.message?.content ?? []) if (c.type === "text" && c.text?.trim()) found.push(c.text.trim().replace(/\s+/g, " ").slice(0, 200));
    }
    out.unshift(...found);
    if (out.length >= n) break;
  }
  return out.slice(-n);
}

function tail(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}

/** 界面要的状态 */
export function mkView(playDir: string, alive: (pid: number) => boolean = pidAlive) {
  const c = readMkCurrent(playDir);
  if (!c) return { current: null, running: false, stopping: false, lines: [] as string[] };
  return { current: c, running: mkRunning(c, alive), stopping: !c.ended && fs.existsSync(path.join(c.runDir, "STOP")), lines: mkModelLines(c.runDir) };
}
