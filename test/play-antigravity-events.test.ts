// Antigravity CLI (agy) 事件翻译 (src/play/antigravity-events.ts): 样本按官方 headless 文档的字段形状写 (2026-11-04 读), **真样本还没抓** (agy 本机还没装), 装好后换成真的
import test from "node:test";
import assert from "node:assert/strict";
import { agyArgs, agyEffort, agyState, agyToolInput, agyToolName, agyUsage, normalizeAgyLine, parseAgyModels } from "../src/play/antigravity-events.ts";

const j = (o: object) => JSON.stringify(o);

test("normalizeAgyLine: init → system/init 带 conversation_id; 回答按 text_delta 攒到 DONE 才发; 工具一开就是 tool_use、DONE 给 tool_result; result 带用量", () => {
  const s = agyState("gemini-3.5-pro");
  const all: any[] = [];
  const feed = (o: object) => all.push(...normalizeAgyLine(s, j(o)));
  feed({ event: "init", conversation_id: "conv-1", init: { cwd: "I:/x", tools: ["run_command", "write_file"], permission_mode: "always-proceed" } });
  assert.equal(s.conversationId, "conv-1");
  assert.deepEqual(all[0].type, "system");
  assert.deepEqual([all[0].subtype, all[0].session_id, all[0].model, all[0].tools], ["init", "conv-1", "gemini-3.5-pro", ["run_command", "write_file"]]);
  feed({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "我先看" } });
  assert.equal(all.length, 1, "没 DONE 不发");
  feed({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "一眼基地。", duration_seconds: 1.2 } });
  assert.equal(all[1].type, "assistant");
  assert.deepEqual(all[1].message.content, [{ type: "text", text: "我先看一眼基地。" }]);
  feed({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { command: "./fh call status" } } } });
  assert.deepEqual(all[2].message.content, [{ type: "tool_use", id: "agy-tool-2", name: "Bash", input: { command: "./fh call status" } }]);
  feed({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 2, state: "ACTIVE", step_type: "tool", tool_info: { name: "run_command", parameters: { command: "./fh call status" } } } });
  assert.equal(all.length, 3, "同一步再来 ACTIVE 不重复发 tool_use");
  feed({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 2, state: "DONE", step_type: "tool", tool_info: { name: "run_command", parameters: { command: "./fh call status" }, output: "tick 120\n" } } });
  assert.deepEqual(all[3], { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "agy-tool-2", content: "tick 120\n", is_error: false }] }, session_id: "conv-1" });
  feed({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 3, state: "DONE", step_type: "tool", tool_info: { name: "write_file", parameters: { path: "notes.md", content: "x" }, output: "", error: { type: "permission", message: "denied" } } } });
  assert.equal(all[4].message.content[0].name, "Write");
  assert.equal(all[4].message.content[0].input.file_path, "notes.md");
  assert.deepEqual([all[5].message.content[0].is_error, all[5].message.content[0].content], [true, "(error: denied)"]);
  feed({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 4, state: "DONE", step_type: "checkpoint" } });
  assert.equal(all.length, 6, "checkpoint 不翻");
  feed({ event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: "我先看一眼基地。", duration_seconds: 6.9, num_turns: 1, usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 1000 } } });
  const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
  assert.deepEqual(all[6].message.content, [], "用量挂在空内容的 assistant 上");
  assert.deepEqual(all[6].message.usage, usage);
  assert.deepEqual(all[7], { type: "result", subtype: "success", is_error: false, session_id: "conv-1", num_turns: 1, usage, total_cost_usd: 0, result: "我先看一眼基地。" });
  assert.equal(all.length, 8, "response 和最后一段回答一样就不重复发");
});

test("normalizeAgyLine: result 的 response 没经 step_update 到过就补一条; 非 SUCCESS → result 出错; error 事件; 非 JSON 行跳过", () => {
  const s = agyState("");
  const a = normalizeAgyLine(s, j({ event: "result", result: { conversation_id: "c2", status: "SUCCESS", response: "收到", num_turns: 1, usage: { prompt_tokens: 10, completion_tokens: 2 } } }));
  assert.deepEqual(a.map((x: any) => x.type), ["assistant", "assistant", "result"]);
  assert.deepEqual((a[0] as any).message.content, [{ type: "text", text: "收到" }]);
  assert.deepEqual((a[2] as any).usage, { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal((a[2] as any).session_id, "c2");
  const s2 = agyState("");
  const b = normalizeAgyLine(s2, j({ event: "result", result: { conversation_id: "c3", status: "ERROR", error: { message: "authentication required" }, response: "", num_turns: 1 } }));
  const r = b.at(-1) as any;
  assert.deepEqual([r.type, r.subtype, r.is_error, r.result], ["result", "error", true, "authentication required"]);
  const c = normalizeAgyLine(agyState(""), j({ event: "error", error: { message: "quota exceeded" } })) as any[];
  assert.deepEqual([c[0].type, c[0].is_error, c[0].result], ["result", true, "quota exceeded"]);
  assert.deepEqual(normalizeAgyLine(agyState(""), "Loading…"), []);
  assert.deepEqual(normalizeAgyLine(agyState(""), j({ event: "step_update", step_update: { step_type: "user_input", state: "DONE", step_index: 0 } })), []);
});

test("agyUsage: 几种字段名都认, 只有 total 时 input = total - output", () => {
  assert.deepEqual(agyUsage({ prompt_token_count: 100, candidates_token_count: 20, cached_content_token_count: 60 }), { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 });
  assert.deepEqual(agyUsage({ total_tokens: 50, output_tokens: 10 }), { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.deepEqual(agyUsage(undefined), { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test("agyToolName / agyToolInput: 工具名归到 Bash / Read / Edit / Write / Grep / Glob; Bash 的命令去掉 pwsh 包装", () => {
  assert.deepEqual(["run_command", "shell", "read_file", "write_file", "edit_file", "grep_search", "list_dir", "mcp(x)"].map(agyToolName), ["Bash", "Bash", "Read", "Write", "Edit", "Grep", "Glob", "mcp(x)"]);
  assert.deepEqual(agyToolInput("Bash", { CommandLine: "pwsh.exe -Command './fh call status'" }), { command: "./fh call status" });
  assert.deepEqual(agyToolInput("Bash", { foo: 1 }), { command: '{"foo":1}' });
  assert.deepEqual(agyToolInput("Read", { TargetFile: "a.md" }), { TargetFile: "a.md", file_path: "a.md" });
  assert.deepEqual(agyToolInput("Grep", { q: "x" }), { q: "x" });
});

test("agyArgs / agyEffort: 第 1 轮不带 --conversation, 第 2 轮起带; 模型空就不传 --model; 五档强度原样传 (agy 1.5.0 --help), 不认识的 medium", () => {
  assert.deepEqual(agyArgs({ n: 1, conversationId: "u", prompt: "开工", model: "", effort: "medium" }), ["-p", "开工", "--output-format", "stream-json", "--dangerously-skip-permissions", "--effort", "medium"]);
  assert.deepEqual(agyArgs({ n: 2, conversationId: "conv-1", prompt: "继续", model: "gemini-3.8-flash-high", effort: "max" }), ["-p", "继续", "--output-format", "stream-json", "--dangerously-skip-permissions", "--model", "gemini-3.8-flash-high", "--effort", "max", "--conversation", "conv-1"]);
  assert.deepEqual(["low", "high", "xhigh", "max", "weird"].map(agyEffort), ["low", "high", "xhigh", "max", "medium"]);
});

test("真样本 (agy 1.5.0, 2026-11-04 本机): 地区不合格的 result → 出错的 result, 原文进 result; usage 字段 input_tokens / output_tokens / thinking_tokens / cache_read_tokens / total_tokens", () => {
  const line = '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"error"}}';
  const out = normalizeAgyLine(agyState(""), line) as any[];
  const r = out.at(-1);
  assert.deepEqual([r.type, r.subtype, r.is_error, r.num_turns], ["result", "error", true, 1]);
  assert.match(r.result, /not eligible for Antigravity/);
  assert.deepEqual(agyUsage({ input_tokens: 12, output_tokens: 3, thinking_tokens: 5, cache_read_tokens: 7, total_tokens: 27 }), { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 });
});

test("parseAgyModels: agy models 的输出 (1.5.0 实测) → id + 显示名; 提示行和空行跳过", () => {
  const out = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n\n";
  assert.deepEqual(parseAgyModels(out), [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }, { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" }]);
  assert.deepEqual(parseAgyModels("error: authentication required"), []);
});
