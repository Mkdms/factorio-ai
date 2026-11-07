// 大脑会话的上下文管理 (core/brains/hooks/context.ts、hook.ts; 不开游戏、不叫模型)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claudeWindow, compactAt, shouldNudge, trimLog, claudeTokens, recoveryBrief, brainSettings } from "../core/brains/hooks/context.ts";

const HOOK = path.join(import.meta.dirname, "..", "core", "brains", "hooks", "hook.ts");

test("压缩点: 按模型取, 换算成 autoCompactWindow (派对 2.1.296 探针的公式)", () => {
  assert.equal(compactAt("opus"), 150_000);
  assert.equal(compactAt("claude-haiku-5-5"), 100_000);
  assert.equal(compactAt("claude-sonnet-5-5"), 130_000);
  assert.deepEqual(claudeWindow(250_000), { window: 283_000 });
  assert.deepEqual(claudeWindow(40_000), { window: 100_000, pct: "50" }); // 低于 6.7 万时靠百分比
  const s = brainSettings(250_000, (e, ...x) => ["hook", e, ...x].join(" "));
  assert.equal(s.autoCompactWindow, 283_000);
  assert.equal(s.hooks.PostToolUse[0].hooks[0].command, "hook post-tool --at 250000");
  assert.equal(s.hooks.SessionStart[0].matcher, "compact");
  assert.equal(s.env.BASH_MAX_TIMEOUT_MS, "1200000");
});

test("提醒: 离压缩点不到 max(2 万, 1/5) 且过了起点到压缩点的一半", () => {
  assert.equal(shouldNudge(190_000, 250_000, 30_000), false);
  assert.equal(shouldNudge(200_000, 250_000, 30_000), true);
  assert.equal(shouldNudge(200_000, 250_000, 180_000), false); // 压缩后起点很高: 不在头一半就提醒
  assert.equal(shouldNudge(0, 250_000, 0), false);
});

test("日志一节只留最后 10 行, 别的节不动", () => {
  const notes = "# 笔记\n\n## 现在在做\n建冶炼列\n\n## 日志\n" + Array.from({ length: 15 }, (_, i) => `- ${i}`).join("\n") + "\n";
  const t = trimLog(notes);
  assert.match(t, /前 5 行省略/);
  assert.match(t, /- 14/);
  assert.doesNotMatch(t, /- 4\n/);
  assert.match(t, /建冶炼列/);
  assert.equal(trimLog("# 笔记\n\n## 日志\n- 1\n"), "# 笔记\n\n## 日志\n- 1\n");
});

test("会话日志: 取最后一条回复的上下文大小, since 之前的不算", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ctx-"));
  const f = path.join(d, "t.jsonl");
  const row = (n: number) => JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: n, output_tokens: 3 } } }) + "\n";
  fs.writeFileSync(f, row(100) + JSON.stringify({ type: "user" }) + "\n" + row(5000));
  assert.equal(claudeTokens(f), 5006);
  const size = fs.statSync(f).size;
  assert.equal(claudeTokens(f, size), 0);
  fs.appendFileSync(f, row(70));
  assert.equal(claudeTokens(f, size), 76);
  assert.equal(claudeTokens(path.join(d, "没有.jsonl")), 0);
});

test("钩子: 有标记才起作用; 快满时提醒一次; 收件箱塞给大脑; 压缩后贴回笔记; 截止前 2 分钟不自动压缩", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fa-hook-"));
  const t = path.join(d, "t.jsonl");
  const run = (args: string[], payload: object) => execFileSync(process.execPath, [HOOK, ...args], { input: JSON.stringify(payload), encoding: "utf8" });
  fs.writeFileSync(path.join(d, "notes.md"), "# 笔记\n\n## 现在在做\n铜线机缺铜\n");
  const at = (n: number) => fs.appendFileSync(t, JSON.stringify({ type: "assistant", message: { usage: { cache_read_input_tokens: n } } }) + "\n");
  at(210_000);
  assert.equal(run(["post-tool", "--at", "250000"], { cwd: d, transcript_path: t }), ""); // 没有标记
  fs.writeFileSync(t, "");
  fs.writeFileSync(path.join(d, ".context-hooks"), "");
  at(100_000);
  assert.equal(run(["post-tool", "--at", "250000"], { cwd: d, transcript_path: t }), ""); // 起点 10 万, 还早
  at(210_000);
  const out = run(["post-tool", "--at", "250000"], { cwd: d, transcript_path: t });
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /更新 notes\.md/);
  assert.equal(run(["post-tool", "--at", "250000"], { cwd: d, transcript_path: t }), ""); // 同一窗口只提醒一次
  fs.writeFileSync(path.join(d, ".inbox.md"), "研究中心 6 台只有 2 台在工作");
  assert.match(JSON.parse(run(["post-tool", "--at", "250000"], { cwd: d, transcript_path: t })).hookSpecificOutput.additionalContext, /监工.*2 台在工作/);
  assert.equal(run(["post-tool", "--at", "250000"], { cwd: d, transcript_path: t }), ""); // 收件箱读过就清空
  run(["post-compact"], { cwd: d, transcript_path: t, compact_summary: "摘要" });
  assert.match(run(["session-compact"], { cwd: d, source: "compact" }), /铜线机缺铜/);
  assert.match(fs.readFileSync(path.join(d, "compactions.md"), "utf8"), /摘要/);
  assert.match(recoveryBrief(d, "x"), /\.\/fh call status/);
  assert.match(JSON.parse(fs.readFileSync(path.join(d, ".context-state.json"), "utf8")).hooksSeen, /^\d{4}-/);
  // 截止 (workspace.ts 写的 ISO 形式) 不到 2 分钟: 自动压缩拦下 (退出码 2), 手动的不拦
  fs.writeFileSync(path.join(d, "deadline.txt"), `${new Date(Date.now() + 60_000).toISOString()}\n`);
  assert.throws(() => run(["pre-compact"], { cwd: d, transcript_path: t, trigger: "auto" }), /不压缩/);
  assert.equal(run(["pre-compact"], { cwd: d, transcript_path: t, trigger: "manual" }), "");
  fs.writeFileSync(path.join(d, "deadline.txt"), `${new Date(Date.now() + 3_600_000).toISOString()}\n`);
  assert.equal(run(["pre-compact"], { cwd: d, transcript_path: t, trigger: "auto" }), "");
});
