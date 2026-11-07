// 我们的联机接口 (src/io/ours.ts) 和 defines 对照表 (src/lab/defines.ts) 的纯逻辑; 连游戏的部分在 npm run io:suite -- --target ours
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OTHERS_MARGIN_TICKS, othersActed, splitPlan } from "../commands/body.ts";

test("右键分段计划: 空格第 1 次 ID 0, 之后带物品 + 品质 ID, 一条最多 burst 次 (沙盘 2026-11-04: 不带 ID 从第 32 个起全丢)", () => {
  // 空格放 37 个: 1 (ID 0) + 36 (带 ID)
  assert.deepEqual(splitPlan(0, 37, 159, 1), [{ count: 1 }, { count: 36, item: 159, quality: 1 }]);
  // 那格已有 5 个: 全带 ID
  assert.deepEqual(splitPlan(5, 10, 159, 1), [{ count: 10, item: 159, quality: 1 }]);
  // 分段: 空格放 130 个, burst 64 → 1 + 64 + 64 + 1
  assert.deepEqual(splitPlan(0, 130, 159, 1, 64).map((s) => s.count), [1, 64, 64, 1]);
  // 0 个 / 负数: 什么都不发
  assert.deepEqual(splitPlan(0, 0, 159, 1), []);
  assert.deepEqual(splitPlan(3, -2, 159, 1), []);
});
import { defineName, definesFile, loadDefines } from "../game/sandbox/defines.ts";

test("有没有别人按过键: 空闲 tick 明显短于距我们最后一次输入才算", () => {
  // 我们 tick 1000 发过输入, 现在 1100: 空闲 100 左右 = 只有我们; 空闲 10 = 90 tick 前有别人按过
  assert.equal(othersActed(1100, 1000, 100), false);
  assert.equal(othersActed(1100, 1000, 100 - OTHERS_MARGIN_TICKS + 1), false, "误差以内不算");
  assert.equal(othersActed(1100, 1000, 10), true);
  assert.equal(othersActed(1100, null, 10), true, "我们没发过输入, 玩家刚动过");
  assert.equal(othersActed(1100, null, 5000), false);
  assert.equal(othersActed(1100, 1000, undefined), false, "读不到空闲 tick 不乱报");
});

test("defines 对照: 数字 → 名字; 没导出 / 表里没有返回 null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "defines-test-"));
  assert.equal(loadDefines(dir), null);
  fs.writeFileSync(definesFile(dir), JSON.stringify({ entity_status: { working: 1, no_ingredients: 31, no_power: 60 } }));
  const d = loadDefines(dir);
  assert.equal(defineName(d, "entity_status", 31), "no_ingredients");
  assert.equal(defineName(d, "entity_status", 999), null);
  assert.equal(defineName(d, "controllers", 1), null);
  assert.equal(defineName(null, "entity_status", 31), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
