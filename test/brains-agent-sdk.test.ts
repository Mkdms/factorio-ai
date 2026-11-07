// Claude 走 Console 密钥 = Agent SDK 跑器 (core/brains/agent-sdk.ts): 主循环参数 ↔ 跑器参数 来回转, query() 的 options 形状 (字段名照官方文档 2026-11-05), Console 环境变量
import test from "node:test";
import assert from "node:assert/strict";
import { consoleEnv, parseRunnerArgs, runnerArgs, sdkOptions } from "../core/brains/agent-sdk.ts";

test("runnerArgs ↔ parseRunnerArgs: 第 1 轮 session-id, 之后 resume; 工具 / 放行 / 系统提示 / 设置来源原样; --add-dir 和 --max-turns 由外面追加也认", () => {
  const a = runnerArgs({ n: 1, sessionId: "u-1", prompt: "开工", model: "claude-opus-5-5", effort: "xhigh", allow: ["Bash(./fh *)", "Read"], tools: ["Bash", "Read"], appendSystemPrompt: "中文" });
  const p = parseRunnerArgs([...a, "--add-dir", "D:/brain", "--max-turns", "1"]);
  assert.deepEqual(p, { prompt: "开工", cwd: process.cwd(), model: "claude-opus-5-5", effort: "xhigh", sessionId: "u-1", resume: undefined, allowedTools: ["Bash(./fh *)", "Read"], tools: ["Bash", "Read"],
    appendSystemPrompt: "中文", settingSources: ["project", "local"], addDirs: ["D:/brain"], maxTurns: 1, permissionMode: "dontAsk" });
  const b = parseRunnerArgs(runnerArgs({ n: 3, sessionId: "s-9", prompt: "继续", model: "claude-sonnet-5-5", effort: "weird", allow: [], tools: ["Bash"], appendSystemPrompt: "" }));
  assert.deepEqual([b.resume, b.sessionId, b.effort, b.maxTurns, b.addDirs], ["s-9", undefined, "medium", undefined, []]);
  assert.throws(() => parseRunnerArgs(["--model", "x"]), /--prompt/);
});

test("sdkOptions: 字段名照官方文档 (resume / sessionId 二选一, systemPrompt 用 claude_code 预设 + append, dontAsk, strictMcpConfig, additionalDirectories)", () => {
  const env = { PATH: "x", ANTHROPIC_API_KEY: "k" };
  const o1 = sdkOptions(parseRunnerArgs(["--prompt", "p", "--cwd", "D:/a", "--session-id", "u-1", "--allow", "Read", "--tools", "Bash,Read", "--append-system-prompt", "中文", "--add-dir", "D:/brain"]), env);
  assert.deepEqual(o1, { cwd: "D:/a", env, model: "claude-opus-5-5", effort: "medium", sessionId: "u-1", permissionMode: "dontAsk", allowedTools: ["Read"], tools: ["Bash", "Read"],
    systemPrompt: { type: "preset", preset: "claude_code", append: "中文" }, settingSources: ["project", "local"], additionalDirectories: ["D:/brain"], mcpServers: {}, strictMcpConfig: true, includePartialMessages: false });
  const o2 = sdkOptions(parseRunnerArgs(["--prompt", "p", "--resume", "s-2", "--max-turns", "1"]), env);
  assert.equal(o2.resume, "s-2");
  assert.equal("sessionId" in o2, false);
  assert.equal(o2.maxTurns, 1);
  assert.deepEqual(o2.systemPrompt, { type: "preset", preset: "claude_code" }, "没有追加文字就只用预设");
});

test("consoleEnv: API 密钥 + 用户级密钥的工作区头 (2026-11-05 实测 sk-ant-usr 不带工作区回 400)", () => {
  assert.deepEqual(consoleEnv("sk-ant-api03-x"), { ANTHROPIC_API_KEY: "sk-ant-api03-x" });
  assert.deepEqual(consoleEnv("sk-ant-usr-x", "wrkspc_01"), { ANTHROPIC_API_KEY: "sk-ant-usr-x", ANTHROPIC_CUSTOM_HEADERS: "anthropic-workspace-id: wrkspc_01" });
});
