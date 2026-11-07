// ./bp build 自己备料的逻辑 (src/play/bp-gather.ts)
import test from "node:test";
import assert from "node:assert/strict";
import { gather, lacking, rawNeeds, type HandRecipe, type Need } from "../src/play/bp-gather.ts";

const recipe: HandRecipe = (item) => ({
  "assembling-machine-1": { name: "assembling-machine-1", yield: 1, ingredients: [{ name: "electronic-circuit", amount: 3 }, { name: "iron-gear-wheel", amount: 5 }, { name: "iron-plate", amount: 9 }] },
  "electronic-circuit": { name: "electronic-circuit", yield: 1, ingredients: [{ name: "iron-plate", amount: 1 }, { name: "copper-cable", amount: 3 }] },
  "copper-cable": { name: "copper-cable", yield: 2, ingredients: [{ name: "copper-plate", amount: 1 }] },
  "iron-gear-wheel": { name: "iron-gear-wheel", yield: 1, ingredients: [{ name: "iron-plate", amount: 2 }] },
} as Record<string, ReturnType<HandRecipe>>)[item] ?? null;

test("还差多少", () => {
  assert.deepEqual(lacking({ a: 3, b: 2, c: 1 }, { a: 1, b: 2 }), { a: 2, c: 1 });
});

test("原料展开到手搓不了的; 背包里的中间件和原料先扣", () => {
  // 组装机1型: 电路 3 (铁 3 + 铜缆 9 → 铜 5) + 齿轮 5 (铁 10) + 铁 9 = 铁 22 铜 5
  assert.deepEqual(rawNeeds({ "assembling-machine-1": 1 }, {}, recipe), { "iron-plate": 22, "copper-plate": 5 });
  assert.deepEqual(rawNeeds({ "assembling-machine-1": 1 }, { "iron-gear-wheel": 5, "iron-plate": 2 }, recipe), { "iron-plate": 10, "copper-plate": 5 });
  assert.deepEqual(rawNeeds({ wood: 3 }, {}, recipe), { wood: 3 }, "手搓不了的就是原料");
});

function world(start: Need, chests: Need, craftable = true) {
  const inv = { ...start }, box = { ...chests };
  const log: string[] = [];
  return {
    inv, box, log,
    io: {
      held: async () => ({ ...inv }),
      collect: async (item: string, count: number) => { const n = Math.min(box[item] ?? 0, count); if (n) { box[item] -= n; inv[item] = (inv[item] ?? 0) + n; log.push(`拿 ${item}*${n}`); } },
      craft: async (r: string, count: number) => { if (!craftable) return { ok: false, why: "not researched" }; inv[r] = (inv[r] ?? 0) + count; log.push(`搓 ${r}*${count}`); return { ok: true }; },
      recipe, sleep: async () => undefined, craftWaitMs: 0,
    },
  };
}

test("箱子里有就拿, 不搓", async () => {
  const w = world({}, { "transport-belt": 50 });
  const r = await gather({ "transport-belt": 20 }, w.io);
  assert.deepEqual(r.still, {});
  assert.deepEqual(w.log, ["拿 transport-belt*20"]);
  assert.match(r.notes[0], /拿到/);
});

test("箱子没有就拿原料手搓; 都备齐了 still 是空", async () => {
  const w = world({}, { "iron-plate": 100, "copper-plate": 50 });
  const r = await gather({ "assembling-machine-1": 2 }, w.io);
  assert.deepEqual(r.still, {});
  assert.ok(w.log.includes("拿 iron-plate*44") && w.log.includes("拿 copper-plate*9") && w.log.includes("搓 assembling-machine-1*2"), w.log.join(" | "));
});

test("搓不了的如实报缺, 不假装备齐", async () => {
  const w = world({}, { "iron-plate": 100, "copper-plate": 50 }, false);
  const r = await gather({ "assembling-machine-1": 1 }, w.io);
  assert.deepEqual(r.still, { "assembling-machine-1": 1 });
  assert.match(r.notes.join(" "), /搓不了: not researched/);
});

test("没有配方的 (要冶炼的) 拿不到就缺着", async () => {
  const w = world({}, {});
  assert.deepEqual((await gather({ "iron-plate": 5 }, w.io)).still, { "iron-plate": 5 });
});
