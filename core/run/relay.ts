#!/usr/bin/env node
// 不装模组那条路 (route = memory, 群的默认路线) 的连续换班: 一班 core/run/online.ts 到点收工 (存 end.zip、笔记) 就接着同一个世界开下一班, 直到停班。
// 第二版群开班一律走装模组路的 shifts.ts --shifts 0 (连跑到停班、崩了接自动存档); 默认路线改成不装模组后, 控制接口只起一次 online.ts, 一班就停 (2026-11-08 对照时发现)。
//   node core/run/relay.ts --group <群 id>      (控制接口 POST /api/group/start 路线 memory 时起它)
// 停的条件: 用户点停班 (这一班 why = STOP; 两班之间 / 下一班还在起的时候点的, 控制接口写 play/RELAY_STOP, 这里等到那一班的记录目录出来就把 STOP 放进去)、
//   关了游戏窗口 ("客户端关了")、play/STOP_AFTER (跑完这一班就停, 和第二版一样)、连续 3 班异常退出 (没写 end.json / 退出码不是 0)、第 1 席是 none (验证班只跑一班, 不进存档链, 接着开只会一张张开新图)。
// 一班异常时下一班接上一份完好的 end.zip (这一班的进度丢了; 第二版装模组路用实例的自动存档接, 这条路还没有)。只用群的第 1 席 (这条路一班一个角色)。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { ROOT, dataRoot } from "../../game/sandbox/paths.ts";
import { onlineStartArgs, readGroup } from "../../src/play/groups.ts";

const { values } = parseArgs({ options: { group: { type: "string" } } });
const PLAY = path.join(dataRoot(), "play");
const log = (s: string) => console.log(`[接力 ${new Date().toISOString().slice(11, 19)}] ${s}`);
if (!values.group || !readGroup(PLAY, values.group)) { console.error(`没有这个群: ${values.group ?? "(没给 --group)"}`); process.exit(2); }
const groupId = values.group;
/** 接力在跑的标记 play/relay.json (控制接口看它: 两班之间也不让再开一个) */
const RELAY = path.join(PLAY, "relay.json");
/** 控制接口的"停班"在接力活着时还写这个 (src/play/control.ts /api/stop): 这一班还没写 current-run.json 时点的停班, 写进上一班的记录目录没人看 */
const RELAY_STOP = path.join(PLAY, "RELAY_STOP");
const STOP_AFTER = path.join(PLAY, "STOP_AFTER");
fs.rmSync(RELAY_STOP, { force: true }); // 上次留下的不算
fs.writeFileSync(RELAY, JSON.stringify({ pid: process.pid, group: groupId, startedAt: new Date().toISOString() }, null, 1));
const cleanup = () => {
  try { const j = JSON.parse(fs.readFileSync(RELAY, "utf8")); if (j.pid === process.pid) fs.rmSync(RELAY, { force: true }); } catch { /* 已经没了 */ }
  fs.rmSync(RELAY_STOP, { force: true });
};
process.on("exit", cleanup);

/** 这一班的收工原因 (end.json why); 没写 = 异常退出 */
function endWhy(runDir: string | null): string | null {
  if (!runDir) return null;
  try { return String(JSON.parse(fs.readFileSync(path.join(runDir, "end.json"), "utf8")).why ?? ""); } catch { return null; }
}
/** current-run.json 现在指的记录目录 (没有 → null) */
function currentRunDir(): string | null {
  try { return String(JSON.parse(fs.readFileSync(path.join(PLAY, "current-run.json"), "utf8")).runDir); } catch { return null; }
}
/** 开班后 online.ts 写的 current-run.json 指的那一班: 开班时间晚于 since、而且不是开班前就指着的那一班 (两班紧挨着时光看时间会认成上一班) */
function runDirSince(since: number, before: string | null): string | null {
  try { const j = JSON.parse(fs.readFileSync(path.join(PLAY, "current-run.json"), "utf8")); return Date.parse(j.startedAt) >= since - 5000 && String(j.runDir) !== before ? String(j.runDir) : null; } catch { return null; }
}

let crashes = 0;
for (let n = 1; ; n++) {
  const g = readGroup(PLAY, groupId);
  if (!g) { log("群没了, 停"); break; }
  let args: string[];
  try { args = onlineStartArgs(PLAY, g); } catch (e) { log(`开不了: ${(e as Error).message}`); break; }
  const verifyOnly = (g.seats[0]?.brain ?? "claude") === "none";
  log(`第 ${n} 班: ${args.join(" ")}`);
  const since = Date.now();
  const before = currentRunDir();
  let stopped = false; // 这一班里按 RELAY_STOP 放过 STOP 了
  const code = await new Promise<number>((resolve) => {
    // RELAY_CHILD: 只给单元测试换成假的一班 (test/relay.test.ts)
    const child = process.env.RELAY_CHILD ?? path.join(ROOT, "core", "run", "online.ts");
    const c = spawn(process.execPath, ["--env-file-if-exists=" + path.join(ROOT, ".env"), child, ...args], { cwd: ROOT, stdio: "inherit", windowsHide: true, env: process.env });
    // 这一班在跑的时候看停班标记: 点在两班之间 / 这一班还在起 (连服务器、注入要 1~2 分钟, 还没写 current-run.json) 的停班, 等记录目录出来就把 STOP 放进去, 这一班一就绪就收工存档
    const poll = setInterval(() => {
      if (stopped || !fs.existsSync(RELAY_STOP)) return;
      const d = runDirSince(since, before);
      if (!d) return;
      try { fs.writeFileSync(path.join(d, "STOP"), "接力: 开班前后点的停班\n"); stopped = true; log(`停班 (点在这一班起来之前): STOP 放进 ${path.basename(d)}`); } catch { /* 记录目录还没建好, 下次再放 */ }
    }, Number(process.env.RELAY_POLL_MS ?? 2000));
    c.on("exit", (x) => { clearInterval(poll); resolve(x ?? 1); });
    c.on("error", () => { clearInterval(poll); resolve(1); });
  });
  const runDir = runDirSince(since, before);
  const why = endWhy(runDir);
  log(`第 ${n} 班收工: ${why ?? "没写收工原因"} (退出码 ${code})`);
  if (fs.existsSync(STOP_AFTER)) { fs.rmSync(STOP_AFTER, { force: true }); log("STOP_AFTER: 跑完这一班就停"); break; }
  // 收工那一刻点的停班: 控制接口把 STOP 写进 current-run.json 指的这一班, 这一班已经在收尾, 也算停
  if (why === "STOP" || stopped || fs.existsSync(RELAY_STOP) || (runDir && fs.existsSync(path.join(runDir, "STOP")))) { log("停班"); break; }
  if (why === "客户端关了") { log("游戏窗口被关 = 停班"); break; }
  if (why === null || code !== 0) {
    crashes++;
    if (crashes >= 3) { log("连续 3 班异常退出, 停"); break; }
    log(`异常退出 (连续 ${crashes} 次), 接上一份完好的存档再开`);
    await new Promise((r) => setTimeout(r, Number(process.env.RELAY_RETRY_MS ?? 10_000)));
    continue;
  }
  crashes = 0;
  if (verifyOnly) { log("第 1 席是 none (验证班): 不进存档链, 只跑这一班"); break; }
}
cleanup();
