// ./bp build 备料不干等; 放机器提示带真实基地的图, 每种只给一次
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gather, type GatherIo, type HandRecipe, type Need } from "../src/play/bp-gather.ts";

const recipe: HandRecipe = (item) => (item === "inserter" ? { name: "inserter", yield: 1, ingredients: [{ name: "iron-plate", amount: 1 }] } : null);
const io = (held: Need, over: Partial<GatherIo> = {}): GatherIo & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, held: async () => ({ ...held }), collect: async (i) => { calls.push(`collect ${i}`); }, craft: async (r, n) => { calls.push(`craft ${r} ${n}`); return { ok: true }; }, recipe, sleep: async () => {}, craftWaitMs: 1, ...over };
};

test("上一次排的还在搓: 不再拿料不再排, 直接说先干别的", async () => {
  const w = io({ inserter: 1 }, { queued: async () => 5 });
  const g = await gather({ inserter: 10 }, w);
  assert.equal(g.crafting, true);
  assert.deepEqual(g.still, { inserter: 9 });
  assert.deepEqual(w.calls, [], "重跑同一条命令不能多搓一份");
  assert.match(g.notes.join(" "), /先干别的/);
});

test("队列在搓但料已经够了: 接着建", async () => {
  const g = await gather({ inserter: 2 }, io({ inserter: 2 }, { queued: async () => 3 }));
  assert.deepEqual(g.still, {});
  assert.ok(!g.crafting);
});

test("这次排上了, 等到点还没搓完: 返回 crafting, 不一直等", async () => {
  let n = 0;
  const w = io({}, { queued: async () => (n++ === 0 ? 0 : 4) });
  const t0 = Date.now();
  const g = await gather({ inserter: 10 }, w);
  assert.equal(g.crafting, true);
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(w.calls.includes("craft inserter 10"));
});

test("有一样搓不了: 不等别的搓完, 不说搓完再跑, 如实报缺 (2026-11-06 验证班: 组装机2型缺钢回了\"正在手搓\")", async () => {
  const hand: HandRecipe = (item) => ({ name: item, yield: 1, ingredients: [{ name: "iron-plate", amount: 1 }] });
  let slept = 0;
  const w = io({}, { recipe: hand, queued: async () => 0, craft: async (r) => (r === "assembling-machine-2" ? { ok: false, why: "steel-plate short" } : { ok: true }), sleep: async () => { slept++; }, craftWaitMs: 60_000 });
  const g = await gather({ inserter: 2, "assembling-machine-2": 3 }, w);
  assert.ok(!g.crafting, "crafting 会让 ./bp build 回\"正在手搓\"");
  assert.deepEqual(g.still, { inserter: 2, "assembling-machine-2": 3 });
  assert.equal(slept, 0, "放不成就不等");
  assert.match(g.notes.join(" "), /assembling-machine-2 搓不了: steel-plate short/);
  assert.match(g.notes.join(" "), /手搓: inserter/);
});

