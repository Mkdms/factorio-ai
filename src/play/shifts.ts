#!/usr/bin/env node
// 连续换班:
// 同一个世界连跑 N 班, 每班接上一班的结束存档 (end.zip) 和大脑目录 (笔记 + 上一班实测, run.ts 用派对 handover.py carry)。
// 派对 setup.md:105-108: 一条命令换班; 读错过 3 游戏小时前的存档白丢 47 枚火箭 → 只接上一班自己写的 last-run.json, 拿不到就停。
//   npm run play:shifts -- --shifts 4 [--continue] [--live] [run.ts 的其他参数: --kit party --agents 2 --mod agent-harness-party --minutes 180 --speed 3 …]
//   --continue: 第一班也接上一次 (lab-data/play/last-run.json) 的存档和笔记; 也可以直接给 --save / --notes 指定第一班接什么 (群开班这么用)
//   --shifts 0: 一直跑到停班 (界面"停班" = STOP 文件; 或 lab-data/play/STOP_AFTER 跑完这班就停)
//   --live: 班与班之间不关服务器和窗口, 只换大脑 (run.ts --keep-game / --attach, src/play/live-shift.ts)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { labRoot, REPO } from "../lab/gamedir.ts";
import { recoverShift, killOrphans, currentRunPath, type CurrentRun } from "./shift-recover.ts";
import { prevFromLast, shiftArgs, shiftLabel, type PrevShift } from "./live-shift.ts";

const argv = process.argv.slice(2);
const take = (flag: string) => { const i = argv.indexOf(flag); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (name: string) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const n = Math.max(0, Number(take("--shifts") ?? "1") || 0);
const cont = flag("--continue");
const live = flag("--live");
const initSave = take("--save"), initNotes = take("--notes");
const playDir = path.join(labRoot(), "play");
const lastPath = path.join(playDir, "last-run.json");
const readLast = () => { try { return JSON.parse(fs.readFileSync(lastPath, "utf8")); } catch { return null; } };
const readCurrentRun = (dir: string): CurrentRun | null => { try { return JSON.parse(fs.readFileSync(currentRunPath(dir), "utf8")); } catch { return null; } };
let crashes = 0;

// 开跑前看派对上游有没有改我们搬过 / 在用的东西 (src/play/party-upstream.ts); 只打印, 不拦
if (process.env.PARTY_REPO) spawnSync(process.execPath, ["--env-file-if-exists=" + path.join(REPO, ".env"), path.join(REPO, "src", "play", "party-upstream.ts")], { stdio: "inherit", cwd: REPO, windowsHide: true });
let prev: PrevShift | null = cont ? prevFromLast(readLast()) : initSave ? { runId: "(指定的存档)", endZip: initSave, brainDir: initNotes } : null;
if (cont && !(prev && fs.existsSync(prev.endZip))) { console.log(`error: --continue 但没有可接的上一班 (${lastPath})`); process.exit(1); }
if (initSave && !fs.existsSync(initSave)) { console.log(`error: --save 的存档不存在: ${initSave}`); process.exit(1); }
for (let i = 1; n === 0 || i <= n; i++) {
  const started = Date.now();
  const args = shiftArgs({ base: argv, i, n, live, prev });
  console.log(`\n=== ${shiftLabel(i, n)}${prev ? ` (接 ${prev.runId}${prev.gameKept ? ", 游戏没关, 直接接上" : ""})` : " (新世界)"}${live && (n === 0 || i < n) ? " · 班末不关游戏" : ""} ===`);
  const r = spawnSync(process.execPath, ["--env-file-if-exists=" + path.join(REPO, ".env"), path.join(REPO, "src", "play", "run.ts"), ...args], { stdio: "inherit", cwd: REPO, windowsHide: true }); // 隐藏的控制台给子进程继承: 换班程序自己没有控制台时, 出俯视图的无界面浏览器会弹一个黑窗口
  const last = readLast();
  // 只接这一班自己写的结束存档: last-run.json 要比这一班开跑晚, end.zip 要在
  if (!last || Date.parse(last.at) < started || !fs.existsSync(last.endZip)) {
    // run.ts 没正常结束 (崩了 / 被杀; M6 2026-11-04): 清掉它留下的游戏进程, 用这一班实例里最新的自动存档接着开 (src/play/shift-recover.ts); 连续 3 班这样才停
    const cur = readCurrentRun(playDir);
    const killed = cur && Date.parse(cur.startedAt) >= started ? killOrphans(cur.instanceDir) : [];
    const rec = recoverShift(playDir, started);
    if (!rec || ++crashes >= 3) { console.log(`第 ${i} 班没留下自己的结束存档 (退出码 ${r.status})${rec ? ", 连续 3 班异常" : ", 也没有可接的自动存档"}, 停止换班`); process.exit(1); }
    console.log(`第 ${i} 班没正常结束 (退出码 ${r.status}${killed.length ? `, 清掉残留进程 ${killed.join(", ")}` : ""}): 用它 ${rec.saveAgeS} 秒前的自动存档 ${rec.save} 当结束存档, 接着开`);
    prev = { runId: rec.runId, endZip: rec.endZip, brainDir: rec.brainDir, gameKept: false };
    continue;
  }
  crashes = 0;
  if (last.stoppedBy === "STOP") { console.log(`第 ${i} 班是被 STOP 停的, 不接着开下一班`); break; }
  // 跑完这一班就停 (lab-data/play/STOP_AFTER): 别直接结束换班程序 —— Windows 上 Node 的子进程和父进程在同一个作业里, 父进程一结束,
  // 正在跑的 run.ts、游戏服务器、窗口、大脑会被一起结束, 这一班不存档 (11-03 第二组第 1 班这样丢了约 20 分钟)。run.ts 看到这个文件会在班末关游戏
  const stopAfter = path.join(labRoot(), "play", "STOP_AFTER");
  if (fs.existsSync(stopAfter)) { fs.rmSync(stopAfter); console.log(`看到 STOP_AFTER: 第 ${i} 班跑完就停`); break; }
  prev = prevFromLast(last);
}
console.log("\n换班结束");
