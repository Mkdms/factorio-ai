// 看门狗 + 崩溃恢复 (M6): 沙盘无界面服务器进程没了 / RCON 答不上 → 用最新且完整的自动存档重启, 端口密码不变, 停机时间记账。
// 搬自第一版 pilot/src/game/recovery.ts 的 crashedInLog / newestAutosave (2026-11-04, context/v1-code-assets.md 第 9 条), 去掉了
// 走菜单读档和经 Steam 重启 (沙盘是无界面服务器, 直接用存档重启); 判定门槛照第一版 main.ts 的经验: 45 秒不可用才恢复, 5 分钟内不重复。
// 纯函数 (newestAutosave / crashedInLog / observe / recovered) 有单元测试 test/watchdog.test.ts; recoverLab 有沙盘测试 test/sandbox/watchdog.test.ts。
import fs from "node:fs";
import path from "node:path";
import type { LabInstance } from "../lab/instance.ts";

export type AutosavePick = { name: string; file: string; mtimeMs: number };

/**
 * saves 目录里最新且完整的自动存档 (_autosaveN.zip; 游戏写到一半的 .tmp 文件名对不上, 自然跳过)。
 * notBefore: 只认这个时刻之后写的 —— 同名实例上一班留下的旧自动存档不算 (接着上一班时实例目录是复用的)。
 */
export function newestAutosave(savesDir: string, opts: { notBefore?: number } = {}): AutosavePick | null {
  let names: string[];
  try { names = fs.readdirSync(savesDir); } catch { return null; }
  let best: AutosavePick | null = null;
  for (const f of names) {
    if (!/^_autosave\d+\.zip$/.test(f)) continue;
    const file = path.join(savesDir, f);
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    if (opts.notBefore !== undefined && mtimeMs < opts.notBefore) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { name: f.replace(/\.zip$/, ""), file, mtimeMs };
  }
  return best;
}

/** 日志末尾有崩溃报告 (游戏每次崩溃在末尾写一次; 第一版 10-28 实测的两种字样); 只读末尾 4000 字 */
export function crashedInLog(logPath: string): boolean {
  try {
    const size = fs.statSync(logPath).size;
    const len = Math.min(size, 4000);
    const fd = fs.openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return /Factorio crashed|Unexpected error occurred/.test(buf.toString("utf8"));
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

export type WatchState = { downSince: number; lastRecovery: number; recoveries: number; failed: number; downtimeMs: number };
export type WatchOptions = { downAfterMs?: number; minIntervalMs?: number; maxRecoveries?: number };
export const WATCH_DEFAULTS = { downAfterMs: 45_000, minIntervalMs: 300_000, maxRecoveries: 10 };
export const newWatchState = (): WatchState => ({ downSince: 0, lastRecovery: 0, recoveries: 0, failed: 0, downtimeMs: 0 });

export type Verdict = "ok" | "down" | "recover" | "gave-up";

/**
 * 每次采样调一次。alive = 进程在且 RCON 能答。
 * "down" = 还在等 (没到 45 秒门槛, 或 5 分钟内刚恢复过); "recover" = 该重启了 (调用方做完要调 recovered); "gave-up" = 这一班恢复次数用完。
 */
export function observe(st: WatchState, alive: boolean, now: number, opts: WatchOptions = {}): Verdict {
  const o = { ...WATCH_DEFAULTS, ...opts };
  if (alive) {
    if (st.downSince) { st.downtimeMs += now - st.downSince; st.downSince = 0; }
    return "ok";
  }
  if (!st.downSince) { st.downSince = now; return "down"; }
  if (now - st.downSince < o.downAfterMs) return "down";
  if (st.recoveries >= o.maxRecoveries) return "gave-up";
  if (st.lastRecovery && now - st.lastRecovery < o.minIntervalMs) return "down";
  return "recover";
}

/** 恢复做完: 成功 → 停机窗口结束并记进 downtimeMs; 失败 → 窗口不关, 到了间隔再试 */
export function recovered(st: WatchState, now: number, ok: boolean) {
  st.lastRecovery = now;
  st.recoveries++;
  if (ok) { if (st.downSince) st.downtimeMs += now - st.downSince; st.downSince = 0; } else st.failed++;
}

/** 停机总时长 (含还没结束的这一段) */
export const downtimeMs = (st: WatchState, now: number) => st.downtimeMs + (st.downSince ? now - st.downSince : 0);

export type RecoverResult = { save: string | null; saveAgeMs: number | null; fallback: boolean; crashed: boolean; evidence: string | null };

/**
 * 用最新且完整的自动存档重启沙盘服务器 (端口、密码不变: 大脑的 ./fh / ./fp、观看窗口、控制接口都不用改配置)。
 * startSave = 开班用的存档名 (run.ts 用 "m"): 自动存档复制过去再启动, 班末 /quit 仍存回它; 没有合格的自动存档就直接用它 (= 回到开班时, fallback)。
 * 旧进程还活着 (卡死) 就先结束它; server.out 会被新进程覆盖, 先整份复制到 evidenceDir 留证。
 */
export async function recoverLab(lab: LabInstance, opts: { startSave?: string; notBefore?: number; evidenceDir?: string; log?: (s: string) => void } = {}): Promise<RecoverResult> {
  const { startSave = "m", log = () => undefined } = opts;
  const serverLog = path.join(lab.dir, "server.out");
  const crashed = crashedInLog(serverLog);
  let evidence: string | null = null;
  if (opts.evidenceDir) {
    try {
      evidence = path.join(opts.evidenceDir, `crash-${new Date().toISOString().replace(/[:.]/g, "-")}.out`);
      fs.copyFileSync(serverLog, evidence);
    } catch { evidence = null; }
  }
  if (lab.proc && lab.proc.exitCode === null) log("看门狗: 旧进程还在 (卡死), 先结束它");
  await lab.stop({ save: false, timeoutMs: 10_000 });
  const pick = newestAutosave(path.join(lab.dir, "saves"), { notBefore: opts.notBefore });
  const now = Date.now();
  if (pick) fs.copyFileSync(pick.file, lab.savePath(startSave));
  log(pick ? `看门狗: 用自动存档 ${pick.name} (${Math.round((now - pick.mtimeMs) / 60_000)} 分钟前) 重启` : `看门狗: 没有这一班的自动存档, 用开班存档 ${startSave}.zip 重启`);
  await lab.restart(startSave);
  return { save: pick?.name ?? null, saveAgeMs: pick ? now - pick.mtimeMs : null, fallback: !pick, crashed, evidence };
}
