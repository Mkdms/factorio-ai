import { test } from "node:test";
import assert from "node:assert/strict";
import { specsFor, missingRecipes } from "../tools/generators/asm_lib_spec.ts";

const recipe = (name: string, time: number, ingredients: [string, number][], products: [string, number][]) => [name, { name, time, categories: ["crafting"], ingredients: ingredients.map(([n, amount]) => ({ name: n, amount, type: n === "lubricant" ? "fluid" : "item" })), products: products.map(([n, amount]) => ({ name: n, amount, type: "item" })) }] as const;
const gd = (rows: ReturnType<typeof recipe>[]) => ({ recipes: new Map(rows), machines: new Map() }) as never;

test("慢配方: 普通机械臂 1 个, 黄带放满 6 台, 单排双排都出", () => {
  const s = specsFor(gd([recipe("science", 24, [["a", 1], ["b", 3], ["c", 2]], [["science", 2]])]), "science");
  assert.deepEqual(s.map((x) => [x.layout, x.n, x.inserter, x.belt, x.per_input, x.out]), [["single", 6, "inserter", "transport-belt", 1, 1], ["double", 6, "inserter", "transport-belt", 1, 1]]);
});

test("快配方一个出 2 个 (铜缆): 机械臂换快的 / 带子不够换红带, 不让带子吃满", () => {
  const [a] = specsFor(gd([recipe("copper-cable", 0.5, [["copper-plate", 1]], [["copper-cable", 2]])]), "copper-cable");
  // 每台: 进 1.5/秒, 出 3/秒: 普通臂要 2 进 4 出 (一行放不下) → 快速 1 进 2 出; 黄带每道 7.5 只够 2 台 → 红带 5 台
  assert.deepEqual([a.inserter, a.per_input, a.out, a.belt, a.n], ["fast-inserter", 1, 2, "fast-transport-belt", 5]);
});

test("开局版: 组装机1型 + 普通机械臂 + 基础传送带, 放不下就放满, 不换成没解锁的", () => {
  const [a, b] = specsFor(gd([recipe("copper-cable", 0.5, [["copper-plate", 1]], [["copper-cable", 2]])]), "copper-cable", { early: true });
  assert.deepEqual([a.machine, a.inserter, a.belt, a.per_input, a.out, a.n, a.layout], ["assembling-machine-1", "inserter", "transport-belt", 2, 2, 3, "single"], "每行留 1 格给电线杆");
  assert.equal(b.layout, "double");
  const [g] = specsFor(gd([recipe("inserter", 0.5, [["a", 1], ["b", 1], ["c", 1]], [["inserter", 1]])]), "inserter", { early: true });
  assert.equal(g.per_input, 1, "3 种料两条带, 留 1 格杆子后只放得下 1 + 1 个臂");
});

test("有流体原料 / 原料超过 4 种: 这个生成器不出", () => {
  assert.deepEqual(specsFor(gd([recipe("electric-engine-unit", 10, [["engine-unit", 1], ["lubricant", 15], ["electronic-circuit", 2]], [["electric-engine-unit", 1]])]), "electric-engine-unit"), []);
  assert.deepEqual(specsFor(gd([recipe("x", 1, [["a", 1], ["b", 1], ["c", 1], ["d", 1], ["e", 1]], [["x", 1]])]), "x"), []);
  assert.deepEqual(specsFor(gd([]), "没有"), []);
});

test("缺的配方不含库里已有的 4 个 (编号别动), 也不含非组装机的", () => {
  const data = {
    recipes: new Map([
      recipe("automation-science-pack", 5, [["iron-gear-wheel", 1], ["copper-plate", 1]], [["automation-science-pack", 1]]),
      recipe("iron-gear-wheel", 0.5, [["iron-plate", 2]], [["iron-gear-wheel", 1]]),
    ]),
    machines: new Map([["assembling-machine-2", { categories: ["crafting"] }]]),
  } as never;
  assert.deepEqual(missingRecipes(data), ["automation-science-pack"]);
});
