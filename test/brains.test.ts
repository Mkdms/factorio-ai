// 大脑驱动 (core/brains): 参数、拦截、跑一轮的会话号接力、轮次循环、一句试通的判定; 不开游戏、不叫模型 (假的命令行 = node -e)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BRAINS, DEEPSEEK_ANTHROPIC_URL, RELAY_KEY_ENV, brainDriver, brainProblem, defaultModel, probeBrain, runBrainTurn, translators, type Driver } from "../core/brains/driver.ts";
import { ccArgs } from "../core/brains/claude-code.ts";
import { brainLoop } from "../core/brains/loop.ts";
import { brainSettings } from "../core/brains/hooks/context.ts";

const opts = { effort: "low", allow: ["Bash(./fh *)"], tools: ["Bash"], system: "中文" };

/** 临时的 keys.json */
const keysFile = (o: Record<string, unknown>): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "brain-keys-")); const f = path.join(d, "keys.json"); fs.writeFileSync(f, JSON.stringify(o)); return f; };

test("八家都认; 没给模型的: gemini 可以 (用账号默认), 中转站说去哪选, 别家要给; 不认识的报不认识; 默认模型按家, 中转站读 keys.json", () => {
  assert.deepEqual([...BRAINS], ["none", "claude", "claude-api", "deepseek", "relay", "codex", "grok", "gemini"]);
  assert.equal(brainProblem("none", ""), null);
  assert.equal(brainProblem("claude", "opus"), null);
  assert.equal(brainProblem("codex", "gpt-6.1-sol"), null);
  assert.equal(brainProblem("gemini", ""), null);
  assert.match(brainProblem("claude", "")!, /要给 --model/);
  assert.match(brainProblem("relay", "")!, /relay_model/);
  assert.match(brainProblem("gpt", "x")!, /不认识/);
  assert.equal(defaultModel("claude"), "opus");
  assert.equal(defaultModel("none"), "");
  assert.equal(defaultModel("codex"), "gpt-6.1-sol");
  assert.equal(defaultModel("relay", keysFile({ relay_model: "glm-5.3" })), "glm-5.3");
  assert.equal(defaultModel("relay", keysFile({})), "");
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
  await assert.rejects(brainDriver({ brain: "gpt", model: "x", ...opts }), /不认识/);
});

test("别家的接线: 用哪个程序、参数、环境、要不要翻译; 密钥没填就报在哪填; 不开游戏不叫模型", async () => {
  const dev = { PATH: "x", ANTHROPIC_API_KEY: "开发会话的", OPENAI_API_KEY: "dev-openai", GEMINI_API_KEY: "dev-gemini", CLAUDECODE: "1" };
  // claude-api: node 跑 Agent SDK 跑器, Console 密钥 + 工作区头进环境, 开发会话的密钥不混进去
  await assert.rejects(brainDriver({ brain: "claude-api", model: "claude-haiku-5-5", keysFile: keysFile({}), ...opts }), /anthropic/);
  const api = await brainDriver({ brain: "claude-api", model: "claude-haiku-5-5", keysFile: keysFile({ anthropic: "sk-ant-usr-1", anthropic_workspace: "wrk_1" }), ...opts });
  assert.equal(api.bin, process.execPath);
  const a1 = api.args(1, "s", "干活");
  assert.match(a1[0], /agent-sdk-runner\.ts$/);
  assert.deepEqual([a1[a1.indexOf("--session-id") + 1], a1[a1.indexOf("--model") + 1], a1[a1.indexOf("--allow") + 1]], ["s", "claude-haiku-5-5", "Bash(./fh *)"]);
  assert.equal(api.args(2, "s", "继续").includes("--resume"), true);
  const apiEnv = api.env(dev);
  assert.deepEqual([apiEnv.ANTHROPIC_API_KEY, apiEnv.ANTHROPIC_CUSTOM_HEADERS, apiEnv.CLAUDECODE, api.normalize, api.unguarded], ["sk-ant-usr-1", "anthropic-workspace-id: wrk_1", undefined, undefined, undefined]);
  // deepseek: Claude Code 换接口地址和令牌; noEffort 就不逼它发强度
  await assert.rejects(brainDriver({ brain: "deepseek", model: "deepseek-flash[1m]", keysFile: keysFile({}), ...opts }), /deepseek/);
  const ds = await brainDriver({ brain: "deepseek", model: "deepseek-flash[1m]", keysFile: keysFile({ deepseek: "ds-key" }), ...opts });
  const dsEnv = ds.env(dev);
  assert.deepEqual([ds.bin, dsEnv.ANTHROPIC_BASE_URL, dsEnv.ANTHROPIC_AUTH_TOKEN, dsEnv.ANTHROPIC_MODEL, dsEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, dsEnv.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, dsEnv.ANTHROPIC_API_KEY], ["claude", DEEPSEEK_ANTHROPIC_URL, "ds-key", "deepseek-flash[1m]", "deepseek-flash", "1", undefined]);
  const ds2 = await brainDriver({ brain: "deepseek", model: "deepseek-flash[1m]", keysFile: keysFile({ deepseek: "ds-key" }), noEffort: true, ...opts });
  assert.equal(ds2.env(dev).CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, undefined);
  // relay: 站标 Claude 格式 → Claude Code 经本机代理 (环境指向 127.0.0.1, 绕过系统代理, 班末 close); Responses → Codex 指向站, 令牌经环境变量; 图片模型用不了; 没配站报在哪填
  await assert.rejects(brainDriver({ brain: "relay", model: "glm-5.3", keysFile: keysFile({}), ...opts }), /relay_url/);
  const relayKeys = { relay_url: "http://127.0.0.1:9/base/v1", relay: "tok-1", relay_formats: JSON.stringify({ "glm-5.3": ["anthropic", "openai"], "gpt-6.1-terra": ["openai", "openai-response"], "gpt-image-2": ["image-generation"] }) };
  const logs: string[] = [];
  const rc = await brainDriver({ brain: "relay", model: "glm-5.3", keysFile: keysFile(relayKeys), log: (s) => logs.push(s), ...opts });
  try {
    const e = rc.env({ ...dev, HTTPS_PROXY: "http://proxy:1" });
    assert.match(e.ANTHROPIC_BASE_URL!, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual([e.ANTHROPIC_AUTH_TOKEN, e.ANTHROPIC_MODEL, e.NO_PROXY, rc.bin, rc.normalize, rc.unguarded], ["tok-1", "glm-5.3", "127.0.0.1,localhost", "claude", undefined, undefined]);
    assert.ok(logs.some((s) => /本机代理 http:\/\/127\.0\.0\.1:\d+ → http:\/\/127\.0\.0\.1:9\/base/.test(s)), logs.join(" | "));
  } finally { await rc.close!(); }
  const rx = await brainDriver({ brain: "relay", model: "gpt-6.1-terra", keysFile: keysFile(relayKeys), ...opts });
  const rxArgs = rx.args(1, "", "开始");
  assert.deepEqual([rx.normalize, !!rx.unguarded, rx.close, rxArgs.includes('model_provider="relay"'), rxArgs.includes('model_providers.relay.base_url="http://127.0.0.1:9/base/v1"'), rxArgs.includes(`model_providers.relay.env_key="${RELAY_KEY_ENV}"`)], ["codex", true, undefined, true, true, true]);
  assert.equal(rx.env(dev)[RELAY_KEY_ENV], "tok-1");
  assert.ok(!rxArgs.some((x) => x.includes("tok-1")), "令牌不进命令行");
  await assert.rejects(brainDriver({ brain: "relay", model: "gpt-image-2", keysFile: keysFile(relayKeys), ...opts }), /用不了/);
  // codex / grok / gemini: 事件要翻译; 开发会话的 OPENAI / GEMINI 密钥不混进去 (走订阅登录)
  const cx = await brainDriver({ brain: "codex", model: "gpt-6.1-sol", ...opts });
  const cxArgs = cx.args(1, "", "开始");
  assert.deepEqual([cx.normalize, !!cx.unguarded, cxArgs.includes("exec"), cxArgs.includes("--json"), cxArgs.at(-1), cx.env(dev).OPENAI_API_KEY], ["codex", true, true, true, "开始", undefined]);
  assert.deepEqual(cx.args(2, "t-1", "继续").slice(-2), ["t-1", "继续"]);
  const gk = await brainDriver({ brain: "grok", model: "grok-4.7", ...opts });
  const gkArgs = gk.args(1, "s", "开始");
  assert.deepEqual([gk.normalize, gk.unguarded, gkArgs.slice(0, 4), gkArgs.includes("Bash(./fh *)"), gkArgs.includes("--disable-web-search"), gk.env(dev).GROK_MEMORY], ["grok", undefined, ["-p", "开始", "-s", "s"], true, true, "0"]);
  const gm = await brainDriver({ brain: "gemini", model: "", ...opts });
  const gmArgs = gm.args(2, "conv-1", "继续");
  assert.deepEqual([gm.normalize, !!gm.unguarded, gmArgs.includes("--dangerously-skip-permissions"), gmArgs.includes("--model"), gmArgs[gmArgs.indexOf("--conversation") + 1], gm.env(dev).GEMINI_API_KEY], ["gemini", true, true, false, "conv-1", undefined]);
  assert.deepEqual(Object.keys(translators).sort(), ["codex", "gemini", "grok"]);
});

// 假的命令行 = node -e; 末尾的 -- 让试通追加的 --max-turns 不被 node 当成自己的选项
const fake = (script: string): Driver => ({ bin: process.execPath, args: () => ["-e", script, "--"], env: (e) => e, note: "假的" });

test("跑一轮: 不用翻译的原样写进 turn-N.jsonl, 会话号不变, 事件回调收到; 命令行不存在不崩", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-turn-"));
  const seen: unknown[] = [];
  const r = await runBrainTurn(fake(`console.log("{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"收到\\"}]}}")`), { n: 2, sessionId: "s", prompt: "p", cwd: runDir, runDir, model: "m", onEvent: (ev) => seen.push(ev) });
  assert.deepEqual(r, { code: 0, sessionId: "s" });
  assert.match(fs.readFileSync(path.join(runDir, "turn-2.jsonl"), "utf8"), /收到/);
  assert.equal((seen[0] as { type: string }).type, "assistant");
  const none = await runBrainTurn({ bin: path.join(runDir, "没有这个程序.exe"), args: () => [], env: (e) => e, note: "" }, { n: 3, sessionId: "s", prompt: "p", cwd: runDir, runDir, model: "m" });
  assert.notEqual(none.code, 0);
  assert.match(fs.readFileSync(path.join(runDir, "brain-stderr.txt"), "utf8"), /起不来/);
  // 要翻译的 (Codex 形状): turn-N.jsonl 是 Claude 形状, 原始行另存 -raw, 下一轮的会话号 = 它的 thread_id
  const codexLines = ['{"type":"thread.started","thread_id":"t-7"}', '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"收到"}}', '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}'];
  const tr = await runBrainTurn({ ...fake(`for (const l of ${JSON.stringify(codexLines)}) console.log(l)`), normalize: "codex" }, { n: 1, sessionId: "我们生成的", prompt: "p", cwd: runDir, runDir, model: "gpt-6.1-sol", onEvent: (ev) => seen.push(ev) });
  assert.deepEqual(tr, { code: 0, sessionId: "t-7" });
  const translated = fs.readFileSync(path.join(runDir, "turn-1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string });
  assert.deepEqual(translated.map((e) => e.type), ["system", "assistant", "assistant", "result"]);
  assert.match(fs.readFileSync(path.join(runDir, "turn-1-raw.jsonl"), "utf8"), /thread\.started/);
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
  // next 给函数: 拿到上一轮跑了多久和第几轮 (上一轮太短就换更硬的话)
  const seen: { lastMs: number; n: number }[] = [];
  let t = 0, k = 0;
  await brainLoop({ turn: async () => { k++; t += k === 1 ? 500_000 : 20_000; return 0; }, stopped: () => k >= 3, first: "a", next: (i) => { seen.push(i); return `b${i.n}`; }, minGapMs: 1, sleep: async () => { t += 1; }, now: () => t });
  assert.deepEqual(seen, [{ lastMs: 500_000, n: 2 }, { lastMs: 20_000, n: 3 }]);
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
  const none = await probeBrain({ bin: path.join(d, "没有.exe"), args: () => [], env: (e) => e, note: "" }, { cwd: d, model: "m" });
  assert.equal(none.ok, false);
  assert.match(none.text, /起不来/);
  // Grok 形状: result 不带正文, 正文从 assistant 事件取; 不追加 --max-turns (fake 的 -- 后面没东西也行)
  const grokLines = [{ type: "text", data: "收到" }, { type: "end", stopReason: "end_turn", sessionId: "g-1", usage: {}, num_turns: 1, total_cost_usd: 0.01 }].map((x) => JSON.stringify(x));
  const g = await probeBrain({ ...fake(`for (const l of ${JSON.stringify(grokLines)}) console.log(l)`), normalize: "grok" }, { cwd: d, model: "grok-4.7" });
  assert.deepEqual([g.ok, g.text, g.costUsd], [true, "收到", 0.01]);
});

test("角色目录的设置: 钩子命令指向仓库里真实存在的 hook.ts", () => {
  const hook = path.join(import.meta.dirname, "..", "core", "brains", "hooks", "hook.ts");
  assert.ok(fs.existsSync(hook));
  const s = brainSettings(150_000, (e, ...x) => ["node", hook, e, ...x].join(" "));
  assert.equal(s.hooks.PreToolUse[0].matcher, "Bash");
  assert.equal(s.hooks.PreToolUse[1].matcher, "Read|Grep|Glob");
  assert.match(s.hooks.PostToolUse[0].hooks[0].command, /post-tool --at 150000$/);
});
