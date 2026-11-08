// 中转站模型核实 (src/play/relay-verify.ts): 解析 Claude Code 的 json 输出、核实任务顺序跑并能看进度
import test from "node:test";
import assert from "node:assert/strict";
import { VerifyJob, parseClaudeJson } from "../src/play/relay-verify.ts";

test("parseClaudeJson: result 行通 / 不通; 没有 result 行就把输出当原因", () => {
  assert.deepEqual(parseClaudeJson('{"type":"system"}\n{"type":"result","is_error":false,"result":"收到"}\n', 0), { ok: true, text: "收到" });
  assert.deepEqual(parseClaudeJson('{"type":"result","is_error":true,"result":"API Error: 400 Unsupported parameter: metadata"}', 1), { ok: false, text: "API Error: 400 Unsupported parameter: metadata" });
  assert.deepEqual(parseClaudeJson("Error: fetch failed\n  at x", 1), { ok: false, text: "Error: fetch failed at x" });
  assert.equal(parseClaudeJson('{"type":"result","is_error":false,"result":"收到"}', null).ok, false, "没有退出码 (被杀) 不算通");
});

test("VerifyJob: 顺序核实、去重、进度和结果, 跑着时不能再开", async () => {
  const job = new VerifyJob();
  const order: string[] = [];
  const stored: string[] = [];
  const runOne = async (m: string) => { order.push(m); await new Promise((r) => setTimeout(r, 5)); return { ok: m !== "bad", ms: 5, text: m === "bad" ? "400" : "收到", at: "t" }; };
  assert.equal(job.start(["a", "bad", "a", " "], runOne, (m) => stored.push(m)), true);
  assert.equal(job.start(["x"], runOne), false, "跑着时不能再开");
  assert.deepEqual([job.running, job.total], [true, 2]);
  while (job.running) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ["a", "bad"]);
  assert.deepEqual(stored, ["a", "bad"]);
  const st = job.status();
  assert.deepEqual([st.done, st.current, st.results.a.ok, st.results.bad.ok, st.results.bad.text], [2, null, true, false, "400"]);
  assert.ok(st.finishedAt);
});
