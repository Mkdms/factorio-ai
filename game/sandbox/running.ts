// 在跑的游戏进程的记录: 换班不关游戏靠它 —— 服务器 / 观看窗口起来时把 pid、端口、密码写进实例目录的 running.json,
// 下一班读它接上 (不读档、不重起); 进程没了就当没有。进程要用 detached 起 (不随起它的程序一起退出)。
import fs from "node:fs";
import path from "node:path";

export type Running = { pid: number; gamePort: number; udpPort: number; rconPort: number; password: string; save: string; startedAt: string };
export const RUNNING_FILE = "running.json";

/** 进程还在 (Windows / Linux 都用 kill(pid, 0) 探; 没权限 EPERM 也算在) */
export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function parseRunning(text: string): Running | null {
  let o: any;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  const pid = n(o.pid), gamePort = n(o.gamePort), rconPort = n(o.rconPort), udpPort = n(o.udpPort) ?? 0;
  if (!pid || !gamePort || !rconPort || typeof o.password !== "string" || !o.password) return null;
  return { pid, gamePort, udpPort, rconPort, password: o.password, save: typeof o.save === "string" ? o.save : "m", startedAt: typeof o.startedAt === "string" ? o.startedAt : "" };
}
/** 实例目录里的 running.json; 没有 / 坏了 / 进程已不在 → null (并把过期的文件删掉) */
export function readRunning(dir: string): Running | null {
  const f = path.join(dir, RUNNING_FILE);
  let text: string;
  try { text = fs.readFileSync(f, "utf8"); } catch { return null; }
  const r = parseRunning(text);
  if (!r || !pidAlive(r.pid)) { try { fs.unlinkSync(f); } catch { /* 已经没了 */ } return null; }
  return r;
}
export function writeRunning(dir: string, r: Running): void { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, RUNNING_FILE), JSON.stringify(r, null, 1)); }
export function clearRunning(dir: string): void { try { fs.unlinkSync(path.join(dir, RUNNING_FILE)); } catch { /* 没有 */ } }

/** 等一个 pid 退出, 最多 timeoutMs; 返回退没退 */
export async function waitPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (!pidAlive(pid)) return true; await new Promise((r) => setTimeout(r, 250)); }
  return !pidAlive(pid);
}
/** 结束一个不是本进程起的进程 (Windows 上 process.kill 走 TerminateProcess) */
export function killPid(pid: number): void { try { process.kill(pid); } catch { /* 已经没了 */ } }
