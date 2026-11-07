// 大脑驱动 (core/brains): 参数、拦截、跑一轮的会话号接力、轮次循环、一句试通的判定; 不开游戏、不叫模型 (假的命令行 = node -e)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brainDriver, brainProblem, defaultModel, probeBrain, runBrainTurn, type Driver } from "../core/brains/driver.ts";
import { ccArgs } from "../core/brains/claude-code.ts";
import { brainLoop } from "../core/brains/loop.ts";
import { brainSettings } from "../core/brains/hooks/context.ts";

const opts = { effort: "low", allow: ["Bash(./fh *)"], tools: ["Bash"], system: "中文" };

test("能开的只有 none 和 claude; 旧项目的别家报'还没搬', 不认识的报不认识", () => {
  assert.equal(brainProblem("none", ""), null);
  assert.equal(brainProblem("claude", "opus"), null);
  assert.match(brainProblem("claude", "")!, /要给 --model/);
  assert.match(brainProblem("codex", "gpt-6.1-sol")!, /还没搬/);
  assert.match(brainProblem("relay", "glm")!, /还没搬/);
  assert.match(brainProblem("gpt", "x")!, /不认识/);
  assert.equal(defaultModel("claude"), "opus");
  assert.equal(defaultModel("none"), "");
});

test("Claude Code 的参数: 模型、强度、提示词带上; 第 1 轮 --session-id 新会话, 之后 --resume 接着; 只读角色目录的设置; dontAsk", async () => {
  const d = await brainDriver({ brain: "claude", model: "claude-haiku-5-5", ...opts });
  const a1 = d.args(1, "s", "干活"), a2 = d.args(2, "s", "继续");
  assert.ok(a1.includes("claude-haiku-5-5") && a1.includes("low") && a1.includes("干活"));
  assert.equal(a1[a1.indexOf("--session-id") + 1], "s");
  assert.equal(a2[a2.indexOf("--resume") + 1], "s");
  assert.equal(a1[a1.indexOf("--setting-sources") + 1], "project,local");
  assert.equal(a1[a1.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(a1[a1.indexOf("--allowedTools") + 1], "Bash(./fh *)");
  const env = d.env({ ANTHROPIC_API_KEY: "开发会话的", PATH: "x", CLAUDECODE: "1" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "开发会话继承来的密钥不能进大脑");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.PATH, "x");
  assert.deepEqual(ccArgs({ model: "m", effort: "high", allow: [], tools: ["Bash"], system: "s" })(1, "id", "p").slice(0, 2), ["-p", "p"]);
  await assert.rejects(brainDriver({ brain: "codex", model: "x", ...opts }), /还没搬/);
});

// 假的命令行 = node -e; 末尾的 -- 让试通追加的 --max-turns 不被 node 当成自己的选项
const fake = (script: string): Driver => ({ bin: process.execPath, args: () => ["-e", script, "--"], env: (e) => e });

test("跑一轮: 不用翻译的原样写进 turn-N.jsonl, 会话号不变, 事件回调收到; 命令行不存在不崩", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-turn-"));
  const seen: unknown[] = [];
  const r = await runBrainTurn(fake(`console.log("{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"收到\\"}]}}")`), { n: 2, sessionId: "s", prompt: "p", cwd: runDir, runDir, model: "m", onEvent: (ev) => seen.push(ev) });
  assert.deepEqual(r, { code: 0, sessionId: "s" });
  assert.match(fs.readFileSync(path.join(runDir, "turn-2.jsonl"), "utf8"), /收到/);
  assert.equal((seen[0] as { type: string }).type, "assistant");
  const none = await runBrainTurn({ bin: path.join(runDir, "没有这个程序.exe"), args: () => [], env: (e) => e }, { n: 3, sessionId: "s", prompt: "p", cwd: runDir, runDir, model: "m" });
  assert.notEqual(none.code, 0);
  assert.match(fs.readFileSync(path.join(runDir, "brain-stderr.txt"), "utf8"), /起不来/);
  assert.throws(() => runBrainTurn({ ...fake("1"), normalize: "codex" }, { n: 1, sessionId: "s", prompt: "p", cwd: runDir, runDir, model: "m" }), /翻译还没搬/);
});

test("轮次循环: 第 1 轮开场、之后'继续'; 很快结束就等够间隔再叫, 等的时候每秒看停没停; 停了不再叫; 被打断的下一轮马上开", async () => {
  const prompts: string[] = [];
  let clock = 0, stopAfter = 3;
  const slept: number[] = [];
  const r = await brainLoop({
    turn: async (n, p) => { prompts.push(p); clock += 5_000; return n === 2 ? 1 : 0; },
    stopped: () => prompts.length >= stopAfter,
    first: "开场", next: "继续", minGapMs: 30_000,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    now: () => clock,
  });
  assert.equal(r.rounds, 3);
  assert.deepEqual(prompts, ["开场", "继续", "继续"]);
  // 第 1、2 轮各只用了 5 秒: 等满 30 秒 (25 秒, 1 秒一片); 第 3 轮后已停, 不等
  assert.equal(slept.length, 50);
  assert.ok(slept.every((ms) => ms <= 1000));
  // 停在等待中途: 不再开下一轮
  prompts.length = 0; clock = 0; stopAfter = 2; slept.length = 0;
  let stop = false;
  await brainLoop({ turn: async () => { clock += 1000; return 0; }, stopped: () => stop || prompts.length >= 9, first: "a", next: "b", minGapMs: 10_000, sleep: async (ms) => { clock += ms; if (clock >= 5000) stop = true; }, now: () => clock });
  assert.equal(prompts.length, 0);
  // 被打断: 不等间隔
  let n = 0;
  const gaps: number[] = [];
  await brainLoop({ turn: async () => { n++; return 0; }, stopped: () => n >= 2, first: "a", next: "b", minGapMs: 10_000, interrupted: () => true, sleep: async (ms) => { gaps.push(ms); }, now: () => 0 });
  assert.equal(gaps.length, 0);
});

test("一句试通: 读 result 行判通不通, 正文和花费带回; is_error 算不通; 起不来算不通", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "brain-probe-"));
  const lines = (ok: boolean) => [
    { type: "assistant", message: { content: [{ type: "text", text: "收到" }] } },
    { type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: ok ? "收到" : "接口 401", total_cost_usd: 0.0123 },
  ];
  const good = await probeBrain(fake(`for (const l of ${JSON.stringify(lines(true))}) console.log(JSON.stringify(l))`), { cwd: d, model: "m" });
  assert.equal(good.ok, true);
  assert.equal(good.text, "收到");
  assert.equal(good.costUsd, 0.0123);
  const bad = await probeBrain(fake(`for (const l of ${JSON.stringify(lines(false))}) console.log(JSON.stringify(l))`), { cwd: d, model: "m" });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /401/);
  const none = await probeBrain({ bin: path.join(d, "没有.exe"), args: () => [], env: (e) => e }, { cwd: d, model: "m" });
  assert.equal(none.ok, false);
  assert.match(none.text, /起不来/);
});

test("角色目录的设置: 钩子命令指向仓库里真实存在的 hook.ts", () => {
  const hook = path.join(import.meta.dirname, "..", "core", "brains", "hooks", "hook.ts");
  assert.ok(fs.existsSync(hook));
  const s = brainSettings(150_000, (e, ...x) => ["node", hook, e, ...x].join(" "));
  assert.equal(s.hooks.PreToolUse[0].matcher, "Bash");
  assert.equal(s.hooks.PreToolUse[1].matcher, "Read|Grep|Glob");
  assert.match(s.hooks.PostToolUse[0].hooks[0].command, /post-tool --at 150000$/);
});
