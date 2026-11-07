// Codex 命令行的事件翻成 Claude 形状 (core/brains/codex.ts); 样本是 2026-11-04 本机 codex-cli 0.166.0 试通抓的
import test from "node:test";
import assert from "node:assert/strict";
import { cleanCommand, codexExecArgs, codexLauncher, codexState, codexTranslator, normalizeCodexLine } from "../core/brains/codex.ts";

test("codexTranslator: 第一轮的 thread_id 当下一轮的会话号", () => {
  const t = codexTranslator("m");
  assert.equal(t.sessionId(), null);
  t.line('{"type":"thread.started","thread_id":"t-9"}');
  assert.equal(t.sessionId(), "t-9");
});

const SAMPLE = [
  '{"type":"thread.started","thread_id":"01a1a674-7c58-7be3-a9f6-4f23a70d6c3e"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"我先运行命令。"}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"\\"C:\\\\\\\\Program Files\\\\\\\\PowerShell\\\\\\\\7\\\\\\\\pwsh.exe\\" -Command \'echo hello-codex\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"\\"C:\\\\\\\\Program Files\\\\\\\\PowerShell\\\\\\\\7\\\\\\\\pwsh.exe\\" -Command \'echo hello-codex\'","aggregated_output":"hello-codex\\r\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"收到"}}',
  '{"type":"turn.completed","usage":{"input_tokens":160775,"cached_input_tokens":135552,"cache_write_input_tokens":0,"output_tokens":215,"reasoning_output_tokens":13}}',
];

test("样本整轮: init(带 thread_id) → 两句话 → 命令 tool_use / tool_result → 用量 + result", () => {
  const s = codexState("gpt-6.1-sol");
  const evs = SAMPLE.flatMap((l) => normalizeCodexLine(s, l)) as any[];
  assert.equal(s.threadId, "01a1a674-7c58-7be3-a9f6-4f23a70d6c3e");
  assert.deepEqual(evs.map((e) => e.type), ["system", "assistant", "assistant", "user", "assistant", "assistant", "result"]);
  assert.equal(evs[0].session_id, s.threadId);
  assert.deepEqual(evs[1].message.content, [{ type: "text", text: "我先运行命令。" }]);
  assert.deepEqual(evs[2].message.content, [{ type: "tool_use", id: "item_1", name: "Bash", input: { command: "echo hello-codex" } }], "pwsh 包装去掉, 只留命令");
  assert.deepEqual(evs[3].message.content, [{ type: "tool_result", tool_use_id: "item_1", content: "hello-codex\r\n", is_error: false }]);
  assert.equal(evs[4].message.content[0].text, "收到");
  assert.deepEqual(evs[5].message.usage, { input_tokens: 160775, output_tokens: 215, cache_read_input_tokens: 135552, cache_creation_input_tokens: 0 });
  assert.deepEqual(evs[5].message.content, [], "用量挂在空内容的 assistant 上");
  assert.equal(evs[6].subtype, "success");
  assert.equal(evs[6].result, "收到");
  assert.ok(evs.every((e) => e.type !== "assistant" || /^codex-\d+$/.test(e.message.id)), "每条 assistant 有 id (onBrainLine 按 id 收用量)");
});

test("失败: 命令退出码非 0 标 is_error 并附 exit; turn.failed → result error; 非 JSON 行忽略", () => {
  const s = codexState("m");
  assert.deepEqual(normalizeCodexLine(s, "Reading additional input from stdin..."), []);
  const r = normalizeCodexLine(s, '{"type":"item.completed","item":{"id":"c","type":"command_execution","command":"ls nope","aggregated_output":"not found","exit_code":2,"status":"failed"}}') as any[];
  assert.deepEqual(r[0].message.content[0], { type: "tool_result", tool_use_id: "c", content: "not found\n(exit 2)", is_error: true });
  const f = normalizeCodexLine(s, '{"type":"turn.failed","error":{"message":"rate limited"}}') as any[];
  assert.deepEqual([f[0].type, f[0].subtype, f[0].is_error, f[0].result], ["result", "error", true, "rate limited"]);
});

test("cleanCommand: pwsh / cmd / bash -lc 的包装都剥掉, 普通命令原样", () => {
  assert.equal(cleanCommand("\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command './fh call status'"), "./fh call status");
  assert.equal(cleanCommand("powershell.exe -NoProfile -Command \"Get-ChildItem\""), "Get-ChildItem");
  assert.equal(cleanCommand("cmd.exe /c \"dir\""), "dir");
  assert.equal(cleanCommand("/bin/bash -lc './fh call status && echo ok'"), "./fh call status && echo ok");
  assert.equal(cleanCommand("./fh call status"), "./fh call status");
});

test("codexExecArgs: 第 1 轮 exec, 之后 resume <thread_id>; 带 --json / 模型 / 强度 / 沙箱放网 / 不读用户配置", () => {
  const a = codexExecArgs({ n: 1, threadId: "", prompt: "开始", model: "gpt-6.1-sol", effort: "high", addDir: "D:/brain" });
  assert.deepEqual(a.slice(0, 2), ["exec", "--json"]);
  assert.ok(a.includes("-m") && a[a.indexOf("-m") + 1] === "gpt-6.1-sol" && a.includes('model_reasoning_effort="high"') && a.includes("--ignore-user-config"));
  // 2026-11-05 班次 18-40-18: Windows 无界面下 workspace-write 被当只读, 模型一条命令不跑 → 用户选沙盘里完全访问 (每轮 -c 显式给, resume 也认)
  assert.ok(a.includes('sandbox_mode="danger-full-access"') && a.includes('approval_policy="never"') && !a.includes("-s") && !a.includes("workspace-write"));
  assert.deepEqual(a.slice(-3), ["--add-dir", "D:/brain", "开始"]);
  const b = codexExecArgs({ n: 2, threadId: "t-1", prompt: "继续", model: "", effort: "weird" });
  assert.deepEqual(b.slice(0, 3), ["exec", "resume", "--json"]);
  assert.ok(!b.includes("-m") && b.includes('model_reasoning_effort="medium"'), "没给模型就不传 -m; 不认识的强度回到 medium");
  assert.ok(b.includes('sandbox_mode="danger-full-access"') && b.includes('approval_policy="never"'), "resume 轮也要显式给沙箱 / 审批 (不然回到只读)");
  assert.ok(!b.includes("-s") && !b.includes("--add-dir"), "resume 不带 -s / --add-dir (0.166.0 的 resume 没这两个参数)");
  assert.deepEqual(b.slice(-2), ["t-1", "继续"]);
  assert.equal(codexExecArgs({ n: 1, threadId: "", prompt: undefined, model: "m", effort: "low" }).at(-1), "-", "没给提示词就从 stdin 读");
  // 中转站的 Responses 协议模型走 Codex (2026-11-04 晚): 自定义 model_provider 指向站, 令牌经环境变量 (不进命令行), wire_api 只有 responses
  const c = codexExecArgs({ n: 1, threadId: "", prompt: "开始", model: "gpt-6.1-terra", effort: "medium", provider: { id: "relay", baseUrl: "https://example.test/v1", envKey: "FP_RELAY_KEY" } });
  assert.ok(c.includes('model_provider="relay"') && c.includes('model_providers.relay.base_url="https://example.test/v1"') && c.includes('model_providers.relay.env_key="FP_RELAY_KEY"') && c.includes('model_providers.relay.wire_api="responses"'));
  assert.ok(!c.some((x) => /sk-/.test(x)), "令牌不进命令行");
  const d = codexExecArgs({ n: 2, threadId: "t-2", prompt: "继续", model: "gpt-6.1-terra", effort: "medium", provider: { id: "relay", baseUrl: "https://example.test/v1", envKey: "FP_RELAY_KEY" } });
  assert.ok(d.includes("resume") && d.includes('model_provider="relay"'), "resume 也要带服务商覆盖 (-c 是全局参数)");
});

test("codexLauncher: 有 CODEX_JS 文件就用 node 跑它, 没有就靠 PATH 上的 codex", () => {
  const here = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  assert.deepEqual(codexLauncher({ CODEX_JS: here }, "node.exe"), { bin: "node.exe", args: [here] });
  assert.deepEqual(codexLauncher({ CODEX_JS: "Z:/no/such.js", CODEX_BIN: "codex-x" }, "node.exe"), { bin: "codex-x", args: [] });
});
