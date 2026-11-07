// 中转站模型按站标的协议分流 + 核实的最小请求和判定 (core/brains/relay.ts); 来历: 2026-11-04 晚拿 Claude 格式去打只认 Responses 协议的模型, 一晚几千条请求
import test from "node:test";
import assert from "node:assert/strict";
import { errorText, formatsOf, judgeStream, looksOpenAi, minimalRequest, relayKind, relayRoute } from "../core/brains/relay.ts";

test("relayRoute: anthropic → claude; 没 anthropic 但有 responses → codex; 只有 chat → claude (站转格式); 图片 / 视频 → none; 没标按名字猜 (11-04 站价目表 44 个模型的三类)", () => {
  assert.equal(relayRoute("glm-5.3", ["openai-response", "openai", "anthropic"]).route, "claude");
  assert.equal(relayRoute("gpt-6.1-terra", ["openai", "openai-response", "openai-response-compact", "openai-alpha-search"]).route, "codex", "gpt: 没 Claude 格式, 有 Responses → Codex");
  assert.equal(relayRoute("grok-4.20-0309-reasoning", ["openai", "openai-response"]).route, "codex", "站里的 grok 也是 Responses 一类");
  assert.deepEqual(relayRoute("MiniMax-M3.1-Flash", ["openai"]).route, "claude", "只有 Chat: 仍走 Claude Code, 站转格式 (11-04 下午两班跑通过)");
  assert.match(relayRoute("MiniMax-M3.1-Flash", ["openai"]).why, /站转格式/);
  assert.equal(relayRoute("gpt-image-2", ["image-generation"]).route, "none");
  assert.equal(relayRoute("gpt-5.6-luna").route, "codex", "没标: gpt 当 Responses");
  assert.equal(relayRoute("kimi-k3", []).route, "claude", "没标: 别家当 Claude 格式");
  assert.deepEqual([looksOpenAi("gpt-6-sol"), looksOpenAi("o4-mini"), looksOpenAi("codex-mini"), looksOpenAi("deepseek-v4-pro"), looksOpenAi("gpt-oss-120b")], [true, true, true, false, true]);
  assert.deepEqual(formatsOf([{ id: "a", formats: ["anthropic"] }, { id: "b", formats: [] }]), { a: ["anthropic"], b: [] });
  assert.deepEqual([["anthropic", "openai"], ["openai", "openai-response"], ["openai"], ["image-generation"], []].map(relayKind), ["anthropic", "responses", "chat", "unusable", "anthropic"]);
});

test("minimalRequest: Claude 格式发 /v1/messages 流式; Responses 发 /v1/responses 流式 + input 列表 (11-04 实测站只收这种); none 不发", () => {
  const a = minimalRequest("claude", "glm-5.3")!;
  assert.equal(a.path, "/v1/messages");
  assert.deepEqual(a.body, { model: "glm-5.3", max_tokens: 64, stream: true, messages: [{ role: "user", content: "只回复两个字: 收到" }] });
  const b = minimalRequest("codex", "gpt-5.6-luna")!;
  assert.equal(b.path, "/v1/responses");
  assert.deepEqual(b.body, { model: "gpt-5.6-luna", stream: true, max_output_tokens: 64, input: [{ role: "user", content: "只回复两个字: 收到" }] });
  assert.equal(minimalRequest("none", "x"), null);
  assert.equal(minimalRequest("claude", "MiniMax-M3.1-Flash")!.path, "/v1/messages", "只有 Chat 协议的也用 Claude 格式核 (站转格式)");
});

test("judgeStream: 两种流里的正文、出错、HTTP 错误 (11-04 真回复的形状)", () => {
  const anth = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"收"}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"到"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n';
  assert.deepEqual(judgeStream("claude", 200, anth), { ok: true, text: "收到" });
  const resp = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"收到"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r"}}\n';
  assert.deepEqual(judgeStream("codex", 200, resp), { ok: true, text: "收到" });
  assert.deepEqual(judgeStream("codex", 200, 'data: {"type":"response.created","response":{}}\n'), { ok: false, text: "回复流里没有正文 (没到结束就断了)" });
  // 思考模型把 token 都花在思考上, 流正常结束但没正文 (11-05 实测 deepseek-v4-pro / glm-5.3 / kimi 7 个) = 通
  assert.deepEqual(judgeStream("claude", 200, 'data: {"type":"message_start","message":{}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"…"}}\n\ndata: {"type":"message_stop"}\n'), { ok: true, text: "通 (回复正常结束, 几十个 token 内没写出正文: 思考模型)" });
  assert.deepEqual(judgeStream("claude", 400, '{"error":{"type":"bad_response_status_code","message":"Stream must be set to true (request id: x)"},"type":"error"}'), { ok: false, text: "HTTP 400: Stream must be set to true (request id: x)" });
  assert.deepEqual(judgeStream("codex", 500, '{"error":{"message":"invalid character \'e\' looking for beginning of value","type":"bad_response_body"}}'), { ok: false, text: "HTTP 500: invalid character 'e' looking for beginning of value" });
  assert.deepEqual(judgeStream("claude", 200, 'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n'), { ok: false, text: "Overloaded" });
  assert.equal(errorText("<html>bad gateway</html>"), "<html>bad gateway</html>");
});
