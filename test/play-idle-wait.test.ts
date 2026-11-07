// fp 把 wait_until {idle} 改成"等角色空下来" (src/play/harness.ts; 不开游戏)
import test from "node:test";
import assert from "node:assert/strict";
import { idleState, idleWaitSeconds } from "../src/play/harness.ts";

test("只改写 harness 没有的写法", () => {
  assert.equal(idleWaitSeconds("wait_until", { idle: true }), 60);
  assert.equal(idleWaitSeconds("wait_until", { idle: true, ticks: 3000 }), 50);
  assert.equal(idleWaitSeconds("wait_until", { queue_empty: true, seconds: 999 }), 110); // Bash 调用 2 分钟超时
  assert.equal(idleWaitSeconds("wait_until", { until: "produced", position: { x: 0, y: 0 } }), null);
  assert.equal(idleWaitSeconds("sleep", { idle: true }), null);
});

test("status → 是否空下来 (第八轮读到的真实 status 形状)", () => {
  const pausedEmpty = { active: false, queues: { body: { paused: true, paused_by: "queue_cancel", pending: 0, active: false } } };
  assert.deepEqual(idleState(pausedEmpty), { idle: true, queue: "空" });
  assert.equal(idleState({ active: { kind: "gather" }, queues: { body: { pending: 0 } } }).idle, false);
  assert.equal(idleState({ active: false, queues: { body: { pending: 3, paused: false } } }).idle, false);
  const stuck = idleState({ active: false, queues: { body: { pending: 4, paused: true, paused_by: "your build call failed" } } });
  assert.equal(stuck.idle, true);
  assert.match(stuck.queue, /暂停了, 还有 4 步/);
});
