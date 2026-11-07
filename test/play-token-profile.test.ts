// token 账本 (src/play/token-profile.ts): 请求按 message.id 去重, 命令族切分, 回复字节归到命令族, 轮询计数
import test from "node:test";
import assert from "node:assert/strict";
import { commandFamilies, profileLines, profileTurns } from "../src/play/token-profile.ts";

test("commandFamilies: 去掉 cd, 按 && 切, ./fh call X / help / calc / bp / 其他; 管道后面不算", () => {
  assert.deepEqual(commandFamilies('cd "I:/brain/a" && ./fh call status && ./fh call chat && cat ../b/notes.md'), ["fh status", "fh chat", "cat"]);
  assert.deepEqual(commandFamilies("./fh help feed && ./fh help transfer | head -50"), ["fh help", "fh help"]);
  assert.deepEqual(commandFamilies(".\\fh.cmd call map --args '{}'"), ["fh map"]);
  assert.deepEqual(commandFamilies("./calc plans/x.json; ./bp list"), ["calc", "bp list"]);
  assert.deepEqual(commandFamilies("./fh chat && ./fh tell b hi && ./fh"), ["fh:chat", "fh:tell", "fh:(无参数)"]);
  assert.deepEqual(commandFamilies("cd x"), ["(空)"]);
});

test("profileTurns: 同一 message.id 的几行只算一次请求; tool_result 字节归到命令族; 连续相同 Bash 算轮询; 串联 ./fh 计数", () => {
  const a = (id: string, content: object[], usage = { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 10 }) => JSON.stringify({ type: "assistant", message: { id, usage, content } });
  const r = (toolId: string, text: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content: text }] } });
  const t1 = [
    JSON.stringify({ type: "system", subtype: "init" }),
    a("m1", [{ type: "thinking", thinking: "…" }]), a("m1", [{ type: "text", text: "先看" }]), a("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: 'cd "x" && ./fh call status && ./fh call map' } }]),
    r("t1", "x".repeat(500)),
    a("m2", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: 'cd "x" && ./fh call status' } }]), r("t2", "y".repeat(200)),
    a("m3", [{ type: "tool_use", id: "t3", name: "Bash", input: { command: 'cd "x" && ./fh call status' } }]), r("t3", "y".repeat(300)),
    a("m4", [{ type: "tool_use", id: "t4", name: "Read", input: { file_path: "notes.md" } }]), r("t4", "z".repeat(50)),
    "not json",
  ];
  const t2 = [a("m5", [{ type: "text", text: "完" }])];
  const p = profileTurns([t1, t2]);
  assert.deepEqual([p.requests, p.turns, p.bash, p.bashChained, p.repeats, p.textBlocks, p.thinkingBlocks], [5, 2, 3, 1, 1, 2, 1]);
  assert.deepEqual(p.usage, { input: 10, cacheRead: 5000, cacheWrite: 500, output: 50 });
  assert.deepEqual(p.tools["fh status"], { count: 3, resultBytes: 500, maxResultBytes: 300 }, "串联那条的回复记在第一个命令族 chain 上, 单独的 status 两条回复 200 + 300");
  assert.deepEqual(p.tools["chain(fh status+1)"], { count: 0, resultBytes: 500, maxResultBytes: 500 });
  assert.deepEqual(p.tools["fh map"].count, 1);
  assert.deepEqual(p.tools.Read, { count: 1, resultBytes: 50, maxResultBytes: 50 });
  assert.deepEqual(p.biggest.map((b) => b.bytes), [500, 300, 200, 50]);
  assert.equal(p.biggest[0].what, "./fh call status && ./fh call map");
  assert.equal(p.biggest[3].what, "Read notes.md");
  const lines = profileLines(p, 30);
  assert.match(lines[0], /请求 5 次 \(10 次\/小时\), 2 轮; 每次请求上下文 1\.1k \(缓存命中 91%/);
  assert.match(lines[1], /Bash 3 次 \(串 2 个以上 \.\/fh 的 1 次, 和上一条完全相同的 1 次\)/);
  assert.match(lines[2], /fh status ×3/);
});
