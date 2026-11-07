// 科技到手就告诉模型该用了 (src/play/milestones.ts)
import test from "node:test";
import assert from "node:assert/strict";
import { MILESTONE_LUA, dueMilestones, normalizeMilestone } from "../src/play/milestones.ts";

const st = (done: Record<string, boolean>, extra = {}) => ({ done, roboports: 0, logisticChests: 0, queue: [] as string[], ...extra });
const ids = (s: ReturnType<typeof st>, said = new Set<string>()) => dueMilestones(s, said).map((m) => m.id);

test("条件没到不说; 到了说一次, 不重复", () => {
  assert.deepEqual(ids(st({})), []);
  const said = new Set<string>();
  assert.deepEqual(ids(st({ "chemical-science-pack": true }), said), ["research-robots"]);
  assert.deepEqual(ids(st({ "chemical-science-pack": true }), said), [], "说过了");
});

test("已经排进队列或已经建了就不说", () => {
  assert.deepEqual(ids(st({ "chemical-science-pack": true }, { queue: ["construction-robotics"] })), []);
  assert.deepEqual(ids(st({ "chemical-science-pack": true, "construction-robotics": true })), ["build-roboport"]);
  assert.deepEqual(ids(st({ "construction-robotics": true }, { roboports: 1 })), []);
  assert.deepEqual(ids(st({ "construction-robotics": true, "logistic-robotics": true }, { roboports: 2 })), ["use-logistics"]);
  assert.deepEqual(ids(st({ "logistic-robotics": true }, { roboports: 2, logisticChests: 4 })), []);
});

test("Lua 回来的空表和 JSON 字符串都认", () => {
  assert.deepEqual(normalizeMilestone({ done: { a: true }, roboports: 1, logisticChests: 0, queue: {} }).queue, []);
  assert.deepEqual(normalizeMilestone('{"done":{},"roboports":0,"logisticChests":0,"queue":{"1":"robotics"}}').queue, ["robotics"]);
  assert.deepEqual(normalizeMilestone(null).done, {});
  assert.match(MILESTONE_LUA, /"construction-robotics"/);
  assert.doesNotMatch(MILESTONE_LUA, /pairs\(\[/, "Lua 表不是 JSON 数组");
});
