// Factory Planner 对照 (src/calc/fp.ts): 方案 → FP 打包格式, FP 回复 → 机器数, 并排比
import { test } from "node:test";
import assert from "node:assert/strict";
import { packFactory, parseFpResult, compareRows, comparisonLines } from "../src/calc/fp.ts";
import type { GameData } from "../src/calc/data.ts";
import type { Result } from "../src/calc/solve.ts";

const gd = {
  recipes: new Map([["sulfuric-acid", { products: [{ name: "sulfuric-acid", type: "fluid", amount: 50 }], ingredients: [{ name: "iron-plate", type: "item", amount: 1 }] }]]),
  modules: new Map([["speed-module", { name: "speed-module", category: "speed", effect: {} }], ["productivity-module-2", { name: "productivity-module-2", category: "productivity", effect: {} }]]),
} as unknown as GameData;

test("方案打包成 FP 的工厂: 产品带每分钟数量, 流体标 fluid, 一个配方一条线, 研究产能进 productivity_boni, 插件 / 分享塔 / 品质转进去, 没转的记在 notes", () => {
  const { packed, notes } = packFactory(gd, { targets: { "automation-science-pack": 30, "sulfuric-acid": 100 }, recipes: {
    "automation-science-pack": { machine: "assembling-machine-2", researchProductivity: 0.1 },
    "iron-gear-wheel": { machine: "assembling-machine-2", quality: "rare", modules: ["speed-module", "speed-module", "productivity-module-2@legendary"], beacons: { name: "beacon", count: 8, modules: ["speed-module"] }, count: 3, fuel: "coal" },
  } });
  const gear = packed.top_floor.lines[1] as { machine: { quality_proto: { name: string }; module_set: { modules: { proto: { name: string; category: string }; quality_proto: { name: string }; amount: number }[] } }; beacon?: { proto: { name: string }; amount: number; module_set: { modules: { amount: number }[] } } };
  assert.equal(gear.machine.quality_proto.name, "rare", "机器品质 → FP 品质原型名");
  assert.deepEqual(gear.machine.module_set.modules.map((m) => [m.proto.name, m.proto.category, m.quality_proto.name, m.amount]), [["speed-module", "speed", "normal", 2], ["productivity-module-2", "productivity", "legendary", 1]], "同名同品质的插件合并计数, 类别从数据里取");
  assert.deepEqual([gear.beacon?.proto.name, gear.beacon?.amount, gear.beacon?.module_set.modules[0]?.amount], ["beacon", 8, 1], "分享塔: count → FP 的 amount (每台机器被几座照到)");
  assert.equal("beacon" in (packed.top_floor.lines[0] as object), false, "没分享塔的线不写 beacon 字段");
  assert.equal(packed.class, "Factory");
  assert.deepEqual(packed.items.map((i) => [i.proto.name, i.proto.category, +i.definition.amount.toFixed(4)]), [["automation-science-pack", "item", 0.5], ["sulfuric-acid", "fluid", 1.6667]], "FP 按秒: 每分钟 30 → 每秒 0.5");
  assert.equal(packed.top_floor.lines.length, 2);
  const line = packed.top_floor.lines[0] as { recipe: { proto: { name: string; category?: string } }; machine: { proto: { name: string; category?: string } } };
  assert.equal(line.recipe.proto.name, "automation-science-pack");
  assert.equal("category" in line.recipe.proto, false, "配方没有类别: 字段不能存在 (FP 的 find 要 nil)");
  assert.deepEqual([line.machine.proto.name, "category" in line.machine.proto], ["assembling-machine-2", false], "机器类别不写, 让 FP 按配方类别找");
  assert.deepEqual(packed.productivity_boni, { "automation-science-pack": 0.1 });
  assert.deepEqual(notes, [{ recipe: "iron-gear-wheel", skipped: ["固定 3 台", "燃料 coal (FP 用它的默认)"] }], "插件 / 分享塔 / 品质都转了, 只剩固定台数和燃料没转");
});

test("FP 回复解析 + 和我们的并排比", () => {
  const raw = { valid: true, items: [{ proto: { name: "automation-science-pack" }, category: "product", amount: 0.5 }], top_floor: { class: "Floor", lines: [
    { class: "Line", recipe: { proto: { name: "automation-science-pack" } }, machine: { proto: { name: "assembling-machine-2" }, amount: 3.333 }, products: [{ proto: { name: "automation-science-pack" }, amount: 0.5 }], ingredients: {} },
    { class: "Floor", lines: [{ class: "Line", recipe: { proto: { name: "iron-gear-wheel" } }, machine: { proto: { name: "assembling-machine-2" }, amount: 0.5 } }] },
  ] } };
  const fp = parseFpResult(raw);
  assert.deepEqual(fp.lines.map((l) => [l.recipe, l.machines]), [["automation-science-pack", 3.333], ["iron-gear-wheel", 0.5]], "子楼层也数进去");
  assert.deepEqual(fp.products, { "automation-science-pack": 30 }, "FP 每秒 0.5 → 每分钟 30");
  assert.deepEqual(fp.lines[0].products, { "automation-science-pack": 30 });
  const ours = { rows: [{ recipe: "automation-science-pack", machine: "assembling-machine-2", machines: 3.333 }, { recipe: "iron-gear-wheel", machine: "assembling-machine-2", machines: 0.6 }, { recipe: "copper-cable", machine: "assembling-machine-2", machines: 1 }] } as unknown as Result;
  const cmp = compareRows(ours, fp, [{ recipe: "iron-gear-wheel", skipped: ["插件 speed-module"] }]);
  assert.deepEqual(cmp.map((c) => [c.recipe, c.ours, c.fp, c.diffPct]), [["automation-science-pack", 3.333, 3.333, 0], ["iron-gear-wheel", 0.6, 0.5, -16.7], ["copper-cable", 1, null, null]]);
  const lines = comparisonLines(cmp);
  assert.match(lines[0], /^✅ automation-science-pack/);
  assert.match(lines[1], /^❌ iron-gear-wheel .*-16\.7%.*没转进 FP: 插件/);
  assert.match(lines[2], /^？FP 没算这条/);
  assert.deepEqual(parseFpResult({ error: "no player 1" }), { error: "no player 1", lines: [], products: {}, debug: undefined });
});

test("线按离目标的步数排 (FP 顺序求解器只让下面的线供上面的): 电路板 → 铜缆 → 铜板, 不按方案里写的顺序", () => {
  const gd2 = { modules: new Map(), recipes: new Map([
    ["copper-plate", { products: [{ name: "copper-plate", type: "item", amount: 1 }], ingredients: [{ name: "copper-ore", type: "item", amount: 1 }] }],
    ["copper-cable", { products: [{ name: "copper-cable", type: "item", amount: 2 }], ingredients: [{ name: "copper-plate", type: "item", amount: 1 }] }],
    ["electronic-circuit", { products: [{ name: "electronic-circuit", type: "item", amount: 1 }], ingredients: [{ name: "copper-cable", type: "item", amount: 3 }, { name: "iron-plate", type: "item", amount: 1 }] }],
  ]) } as unknown as GameData;
  const { packed } = packFactory(gd2, { targets: { "electronic-circuit": 60 }, recipes: { "copper-plate": { machine: "electric-furnace" }, "copper-cable": { machine: "assembling-machine-2" }, "electronic-circuit": { machine: "assembling-machine-2" } } });
  assert.deepEqual((packed.top_floor.lines as { recipe: { proto: { name: string } } }[]).map((l) => l.recipe.proto.name), ["electronic-circuit", "copper-cable", "copper-plate"]);
  // 铜板同时直接供目标 (第 1 层) 和供铜缆 (第 2 层): 要排在最深的消费者下面
  gd2.recipes.set("automation-science-pack", { products: [{ name: "automation-science-pack", type: "item", amount: 1 }], ingredients: [{ name: "copper-plate", type: "item", amount: 1 }, { name: "iron-gear-wheel", type: "item", amount: 1 }] } as never);
  const two = packFactory(gd2, { targets: { "automation-science-pack": 30, "electronic-circuit": 60 }, recipes: { "copper-plate": { machine: "electric-furnace" }, "automation-science-pack": { machine: "assembling-machine-2" }, "copper-cable": { machine: "assembling-machine-2" }, "electronic-circuit": { machine: "assembling-machine-2" } } });
  const names = (two.packed.top_floor.lines as { recipe: { proto: { name: string } } }[]).map((l) => l.recipe.proto.name);
  assert.equal(names.at(-1), "copper-plate", `铜板必须在最下面: ${names.join(" > ")}`);
  assert.ok(names.indexOf("electronic-circuit") < names.indexOf("copper-cable"));
});
