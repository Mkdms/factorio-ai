// Grok Build 的流事件 → Claude 形状 (src/play/grok-events.ts); 样本是 2026-11-04 本机 grok 1.0.70 探测到的
import test from "node:test";
import assert from "node:assert/strict";
import { grokState, normalizeGrokEvent, normalizeGrokLine } from "../src/play/grok-events.ts";

test("文字增量攒成一条 assistant; usage / end → result (花费、会话号); available_commands 忽略", () => {
  const s = grokState();
  const out: object[] = [];
  const push = (line: string) => out.push(...normalizeGrokLine(s, line));
  push(JSON.stringify({ type: "available_commands", tools: ["run_terminal_command"], commands: ["compact"] }));
  push(JSON.stringify({ type: "text", data: "收" }));
  push(JSON.stringify({ type: "text", data: "到" }));
  push(JSON.stringify({ type: "usage", usage: { input_tokens: 16544, output_tokens: 33, cache_read_input_tokens: 1664, cache_creation_input_tokens: 0, reasoning_tokens: 32 } }));
  push(JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "01a1a488-92db-74e3-9692-115771f7bfa5", usage: { input_tokens: 16544, output_tokens: 33, total_tokens: 18241 }, num_turns: 1, total_cost_usd: 0.0341 }));
  assert.equal(out.length, 2);
  const [a, r] = out as any[];
  assert.equal(a.type, "assistant"); assert.deepEqual(a.message.content, [{ type: "text", text: "收到" }]); assert.equal(a.message.usage.output_tokens, 33);
  assert.equal(r.type, "result"); assert.equal(r.subtype, "success"); assert.equal(r.is_error, false); assert.equal(r.total_cost_usd, 0.0341); assert.equal(r.session_id, "01a1a488-92db-74e3-9692-115771f7bfa5"); assert.equal(r.num_turns, 1);
});

test("工具调用: tool_call → assistant tool_use (Bash + command), 中间态忽略, completed / failed → user tool_result; 取消的 end → 不算 success", () => {
  const s = grokState();
  const out: object[] = [];
  const push = (ev: object) => out.push(...normalizeGrokEvent(s, ev as Record<string, unknown>));
  push({ type: "thought", data: "准备运行" });
  push({ type: "text", data: "我先运行。" });
  push({ type: "tool_call", toolCallId: "call-1", title: "run_terminal_command", kind: "execute", status: "pending", toolName: "run_terminal_command", rawInput: { command: "./fh call status", description: "看状态" }, content: [], locations: [] });
  push({ type: "tool_call_update", toolCallId: "call-1", status: null, content: [{ type: "content", content: { type: "text", text: "看状态" } }] });
  push({ type: "tool_call_update", toolCallId: "call-1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "" } }] });
  push({ type: "tool_call_update", toolCallId: "call-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok\r\n" } }] });
  push({ type: "tool_call", toolCallId: "call-2", toolName: "read_file", rawInput: { path: "notes.md" } });
  push({ type: "tool_call_update", toolCallId: "call-2", status: "failed", content: [{ type: "content", content: { type: "text", text: "User cancelled" } }] });
  push({ type: "end", stopReason: "cancelled", sessionId: "x", usage: { input_tokens: 1 }, num_turns: 2, total_cost_usd: 0.045856 });
  const types = (out as any[]).map((e) => `${e.type}:${e.message?.content?.[0]?.type ?? e.subtype}`);
  assert.deepEqual(types, ["assistant:text", "assistant:tool_use", "user:tool_result", "assistant:tool_use", "user:tool_result", "result:cancelled"]);
  const tool = (out as any[])[1].message.content[0];
  assert.deepEqual([tool.name, tool.input.command, tool.id], ["Bash", "./fh call status", "call-1"]);
  assert.deepEqual((out as any[])[2].message.content[0], { type: "tool_result", tool_use_id: "call-1", content: "ok\r\n", is_error: false });
  assert.deepEqual((out as any[])[3].message.content[0].input, { file_path: "notes.md" });
  assert.equal((out as any[])[4].message.content[0].is_error, true);
  const r = (out as any[])[5]; assert.equal(r.is_error, true); assert.equal(r.total_cost_usd, 0.045856);
});

test("非 JSON 行 (权限提示) 留痕为 system 事件; 空行丢掉", () => {
  const s = grokState();
  assert.deepEqual(normalizeGrokLine(s, "permission required: Execute `x` was not run, as a headless run cannot ask for approval"), [{ type: "system", subtype: "grok_stderr", text: "permission required: Execute `x` was not run, as a headless run cannot ask for approval" }]);
  assert.deepEqual(normalizeGrokLine(s, "   "), []);
  assert.equal((normalizeGrokLine(s, "{not json") as any[])[0].subtype, "grok_unparsed");
});
