// 连续换班的兜底 (M6, 2026-11-04): 一班的 run.ts 没正常结束 (进程崩了 / 被杀, 没留 end.zip), 换班程序 (src/play/shifts.ts) 不该整个停掉 ——
// 用这一班沙盘实例里最新的自动存档 (服务器每 3 分钟存) 当它的结束存档, 接着开下一班; 还活着的游戏进程 (node 被硬杀时 exit 钩子不跑) 先清掉。
// run.ts 开班时写 <lab-data>/play/current-run.json (这一班的记录目录、大脑目录、实例目录、开始时间), 这里按它找。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { newestAutosave } from "./watchdog.ts";

export type CurrentRun = { runId: string; runDir: string; brainDir: string; instanceDir: string; startedAt: string };
export type RecoveredShift = { runId: string; endZip: string; brainDir: string; save: string; saveAgeS: number; at: string };

export const currentRunPath = (playDir: string) => path.join(playDir, "current-run.json");

/** run.ts 开班时调: 记下这一班的位置 */
export function writeCurrentRun(playDir: string, cur: CurrentRun) {
  fs.writeFileSync(currentRunPath(playDir), JSON.stringify(cur, null, 2));
}

/**
 * 这一班 (started = 换班程序起它的时刻) 没留 end.zip 时: 找它实例里 started 之后写的最新自动存档, 复制成 <runDir>/end.zip, 写 recovered.json。
 * 不是这一班写的 current-run.json、或没有合格的自动存档 → null (换班程序照旧停)。
 */
export function recoverShift(playDir: string, started: number, now = Date.now()): RecoveredShift | null {
  let cur: CurrentRun;
  try { cur = JSON.parse(fs.readFileSync(currentRunPath(playDir), "utf8")); } catch { return null; }
  if (!cur.startedAt || Date.parse(cur.startedAt) < started) return null;
  const pick = newestAutosave(path.join(cur.instanceDir, "saves"), { notBefore: started });
  if (!pick) return null;
  const endZip = path.join(cur.runDir, "end.zip");
  fs.mkdirSync(cur.runDir, { recursive: true });
  fs.copyFileSync(pick.file, endZip);
  const rec: RecoveredShift = { runId: cur.runId, endZip, brainDir: cur.brainDir, save: pick.name, saveAgeS: Math.round((now - pick.mtimeMs) / 1000), at: new Date(now).toISOString() };
  fs.writeFileSync(path.join(cur.runDir, "recovered.json"), JSON.stringify(rec, null, 2));
  return rec;
}

/**
 * 清掉这一班还活着的游戏进程 (无界面服务器用 -c <实例目录>\config.ini 起, 观看窗口用 -c <clients>\<实例名>…\config.ini):
 * 按命令行里的实例目录 / 实例名找 factorio.exe 杀掉。只在 Windows 上做 (沙盘只在本机 Windows 跑); 返回杀掉的进程号
 */
export function killOrphans(instanceDir: string): number[] {
  if (process.platform !== "win32") return [];
  const name = path.basename(instanceDir);
  const ps = `Get-CimInstance Win32_Process -Filter "Name='factorio.exe'" | Where-Object { $_.CommandLine -like '*\\instances\\${name}\\*' -or $_.CommandLine -like '*\\clients\\${name}*' -or $_.CommandLine -like '*\\clients\\viewer-${name}*' } | ForEach-Object { $_.ProcessId }`;
  let out = "";
  try { out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true }); } catch { return []; }
  const pids = out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => n > 0);
  for (const pid of pids) { try { process.kill(pid); } catch { /* 已经没了 */ } }
  return pids;
}
