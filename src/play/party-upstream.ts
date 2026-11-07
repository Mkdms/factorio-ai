#!/usr/bin/env node
// 派对上游改了我们搬过 / 在用的东西没有。
// 拉取本机的派对克隆 (只 fetch, 不动工作区: 实跑时 run.ts 在用它), 对下面每一项列出 "我们搬的那个版本 → 上游最新" 之间改到这些文件的提交。
// 有改动: 照着改我们的版本、补测试, 再把这里的 base 改成新的提交号 (和 NOTICE 里写的一致)。直接调用的 (handover.py、brief.py) 拉取后自动是新版。
//   npm run party:check [-- --diff]   (--diff 连同改动内容一起打印, 每项最多 120 行)
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { diff: { type: "boolean", default: false } } });
const REPO = process.env.PARTY_REPO ?? "";
if (!REPO) { console.log("error: .env 里没设 PARTY_REPO"); process.exit(1); }

/** 我们从派对搬过 / 在用的: 上游路径 → 我们这边 (搬的方式) 和起点提交 */
export const PORTS: { upstream: string[]; ours: string; how: "搬成 TS" | "直接调用" | "翻译" | "模组移植"; base: string }[] = [
  { upstream: ["tools/factory_digest.py", "tools/stream/hauling.py"], ours: "src/play/digest.ts", how: "搬成 TS", base: "e98eb874" },
  { upstream: ["tools/analysis", "tools/idle_report.py"], ours: "src/play/review-shift.ts (思路)", how: "搬成 TS", base: "e98eb874" },
  { upstream: ["tools/idle_nudge.py", "tools/supervise.sh"], ours: "src/play/run.ts 监工 (私信、闲置、截止后总结)", how: "搬成 TS", base: "e98eb874" },
  { upstream: ["tools/handover.py"], ours: "run.ts 换班时调用", how: "直接调用", base: "e98eb874" },
  { upstream: ["tools/brief.py", "agent/PLAYBOOK.md", "agent/coop.md", "agent/harness-claude.md", "agent/compact.md", "agent/time-realtime.md"], ours: "src/play/partykit.ts 调用 + src/play/brief-zh.md (中文翻译, 要手动跟)", how: "翻译", base: "e98eb874" },
  { upstream: ["agent/ref", "agent/team.md"], ours: "大脑目录 ref/ (./fh help 主题)", how: "直接调用", base: "a9a5556a" }, // 11-04: 直接从派对仓库复制, 拉新就是新的 (waits-queues / space-age 两段说明跟着模组改)
  { upstream: ["vendor/factorio-harness"], ours: "mods/agent-harness-party (tools/port-party-harness.py 重新生成)", how: "模组移植", base: "a9a5556a" }, // 2026-11-05 重新生成没有差异: 83aea242 (rearm 取弹失败报错) 上次已带进来, 只是这里的基线没更新
  { upstream: ["tools/permit.py", "tools/test_permit.py"], ours: "src/play/permit.ts (放行钩子, 比他们紧: 没有沙箱) + test/play-permit.test.ts", how: "搬成 TS", base: "7ff35170" },
];

const git = (...args: string[]) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
git("fetch", "-q");
const head = git("rev-parse", "--short", "origin/HEAD");
console.log(`派对上游最新: ${git("log", "-1", "--format=%h %ci", "origin/HEAD")}`);
let changed = 0;
for (const p of PORTS) {
  const log = git("log", "--format=%h %ad %s", "--date=short", `${p.base}..origin/HEAD`, "--", ...p.upstream);
  const n = log ? log.split("\n").length : 0;
  if (n) changed++;
  console.log(`\n[${n ? "有改动" : "没变"}] ${p.upstream.join(", ")} → ${p.ours} (${p.how}, 起点 ${p.base})${n ? `: ${n} 个提交` : ""}`);
  if (n) console.log(log.split("\n").slice(0, 8).map((l) => `  ${l.slice(0, 140)}`).join("\n"));
  if (n && values.diff) console.log(git("diff", `${p.base}..origin/HEAD`, "--", ...p.upstream).split("\n").slice(0, 120).join("\n"));
}
console.log(`\n${changed ? `${changed} 项上游有改动: 照着改我们的版本、补测试, 再更新 PORTS 的 base 和 NOTICE。` : "都没变。"} (上游 ${head})`);
