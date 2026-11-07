// 常驻 Claude 会话 (src/play/claude-stream.ts; play:run --stream): 用假的 claude (test/fake-claude-stream.mjs) 测, 不花额度
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { ClaudeStream, userMessage } from "../src/play/claude-stream.ts";

const FAKE = path.join(import.meta.dirname, "fake-claude-stream.mjs");
const open = (env: Record<string, string> = {}, graceMs?: number) => {
  const lines: any[] = [], taken: string[] = [];
  const s = new ClaudeStream({ bin: process.execPath, args: [FAKE], cwd: os.tmpdir(), env: { ...process.env, ...env }, onLine: (m) => lines.push(m), onSteerTaken: (u) => taken.push(u), graceMs });
  return { s, lines, taken };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("用户消息的形状 (插话带 uuid)", () => {
  assert.deepEqual(userMessage("你好"), { type: "user", message: { role: "user", content: "你好" } });
  assert.equal(userMessage("x", "u1").uuid, "u1");
});

test("一轮一条消息, 进程不退, 下一轮接着用; 花费是累计数", async () => {
  const { s } = open();
  const r1 = await s.turn("第一轮");
  assert.deepEqual([r1.ok, r1.text], [true, "第一轮"]);
  assert.equal(s.busy, false);
  assert.equal(s.steer("没在跑"), false); // 没有一轮在跑: 插不进去, 调用方留到下一轮提示
  const r2 = await s.turn("第二轮");
  assert.equal(r2.text, "第二轮");
  assert.equal(s.exited, false);
  assert.equal(s.lastCost, 0.02); // 两轮累计, 不是每轮 0.01
  s.close();
});

test("跑到一半插话: 下一次调用模型前并进这一轮", async () => {
  const { s, lines, taken } = open();
  const p = s.turn("铺传送带");
  await wait(40);
  assert.equal(s.steer("监工: 缺燃料 3 台"), true);
  const r = await p;
  assert.equal(r.text, "铺传送带 | 监工: 缺燃料 3 台");
  assert.equal(lines.filter((m) => m.type === "user" && m.isReplay).length, 2); // 提示 + 插话都回显
  assert.equal(taken.length, 1); // "收下插话" 只算我们插的那条
  assert.equal(s.pendingSteers, 0);
  s.close();
});

test("插话赶上最后一次模型调用: result 之后单独跑一轮, 算同一轮", async () => {
  const { s } = open({ FAKE_LATE: "1" });
  const p = s.turn("写笔记");
  await wait(40);
  assert.ok(s.steer("监工: 研究中心停了"));
  const r = await p;
  assert.equal(r.text, "监工: 研究中心停了"); // 等到续上的那一轮结束才返回
  assert.equal(s.busy, false);
  s.close();
});

test("插话一直没被收下: 宽限过了按原来的 result 结束", async () => {
  const { s } = open({ FAKE_DROP: "1" }, 100);
  const p = s.turn("建炉子");
  await wait(40);
  assert.ok(s.steer("会被丢掉"));
  const t0 = Date.now();
  const r = await p;
  assert.equal(r.text, "建炉子");
  assert.ok(Date.now() - t0 >= 80, "要等宽限");
  s.close();
});

test("进程中途退出: 这一轮按退出返回, 之后不能再开", async () => {
  const { s } = open();
  const r = await s.turn("退出");
  assert.deepEqual([r.ok, r.exited, r.code], [false, true, 3]);
  assert.equal(s.exited, true);
  assert.equal((await s.turn("再来")).subtype, "exited");
});

test("被杀掉 (截止 / 停止): 正在等的一轮马上返回", async () => {
  const { s } = open({ FAKE_TOOL_MS: "5000" });
  const p = s.turn("长动作");
  await wait(100);
  s.close();
  const r = await p;
  assert.equal(r.exited, true);
});
