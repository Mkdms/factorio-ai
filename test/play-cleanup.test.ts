// 清场的分组和选箱子 (src/play/cleanup.ts; 不开游戏)
import test from "node:test";
import assert from "node:assert/strict";
import { clusters, pickChest } from "../src/play/cleanup.ts";

test("树石按 16 格一片分组, 每片范围外扩 1 格", () => {
  const a = clusters([{ x: 41.6, y: 40.9, name: "t" }, { x: 43.3, y: 47.3, name: "t" }, { x: 60.2, y: 33.1, name: "t" }]);
  assert.equal(a.length, 2);
  assert.deepEqual(a.find((r) => r.left_top.x === 40), { left_top: { x: 40, y: 39 }, right_bottom: { x: 45, y: 49 } });
});

test("先放进已经存着同类东西的箱子, 再挑最近的空箱子, 满的不要", () => {
  const chests = [
    { x: 1, y: 1, free: 5, has: {}, d: 2 },
    { x: 9, y: 9, free: 3, has: { wood: true }, d: 12 },
    { x: 2, y: 2, free: 0, has: { stone: true }, d: 1 },
  ];
  assert.equal(pickChest("wood", chests)?.x, 9);
  assert.equal(pickChest("stone", chests)?.x, 1);
  assert.equal(pickChest("coal", []), undefined);
});

test("供料箱 (有机械臂从里面取) 不当存放箱", () => {
  const chests = [{ x: 55.5, y: 36.5, free: 10, has: { coal: true }, d: 1, feeds: true }, { x: 70, y: 40, free: 2, has: {}, d: 20 }];
  assert.equal(pickChest("wood", chests)?.x, 70);
  assert.equal(pickChest("wood", [chests[0]]), undefined); // 只剩供料箱 → 造新箱子
});
