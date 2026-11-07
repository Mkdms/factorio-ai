// 带子 Z 字弯检查 (src/play/belt-lint.ts):
import test from "node:test";
import assert from "node:assert/strict";
import { jogNote, newJogs, normalizeJogs } from "../src/play/belt-lint.ts";

test("回复 → 结构: 字符串要解一层; Lua 空表回来是 {}; 坏数据当没有", () => {
  assert.deepEqual(normalizeJogs({ belts: 10, jogs: 2, free: 1, list: [{ x: 1.5, y: 2.5, run: 2 }] }), { belts: 10, jogs: 2, free: 1, list: [{ x: 1.5, y: 2.5, run: 2 }] });
  assert.deepEqual(normalizeJogs(JSON.stringify({ belts: 3, jogs: 0, free: 0, list: {} })), { belts: 3, jogs: 0, free: 0, list: [] });
  assert.deepEqual(normalizeJogs(null), { belts: 0, jogs: 0, free: 0, list: [] });
  assert.deepEqual(normalizeJogs({ list: [{ x: "a", y: 1 }] }).list, []);
});

test("只报新出现的; 拆掉的忘掉, 以后再出现还报", () => {
  const seen = new Set<string>();
  const a = { x: 1.5, y: 2.5, run: 1 }, b = { x: 3.5, y: 4.5, run: 2 };
  assert.deepEqual(newJogs([a], seen), [a]);
  assert.deepEqual(newJogs([a], seen), [], "报过了");
  assert.deepEqual(newJogs([a, b], seen), [b]);
  assert.deepEqual(newJogs([b], seen), [], "a 拆了");
  assert.deepEqual(newJogs([a, b], seen), [a], "a 又出现");
});

test("给大脑的话: 带坐标, 多的写等", () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ x: i + 0.5, y: 0.5, run: 1 }));
  const t = jogNote(list);
  assert.match(t, /新出现 7 处/);
  assert.ok(t.includes("(0.5, 0.5)") && t.includes("(4.5, 0.5)") && !t.includes("(5.5, 0.5)") && t.includes(" 等"));
  assert.ok(!jogNote(list.slice(0, 2)).includes(" 等。"));
});
