// ./plan 的纯逻辑 (src/play/plan-lib.ts):
import test from "node:test";
import assert from "node:assert/strict";
import { blocksWithout, chainPlan, downgrade, missingItems, otherBlocks, pickBlock, placementSteps, planText, recipeFor, resolveItem, siteLua, unreachableTier, type Block } from "../src/play/plan-lib.ts";
import type { HandRecipe } from "../src/play/bp-gather.ts";
import { deltas, normalizeExisting, type Delta } from "../src/play/expand.ts";
import { loadGameData } from "../src/calc/data.ts";
import { solvePlan } from "../src/calc/solve.ts";

const tech = { automation2: true, steelFurnace: true, electricFurnace: true, oil: true, electricDrill: true };
const zhMap = new Map([["chemical-science-pack", "化工科技包（蓝瓶）"], ["engine-unit", "内燃机"], ["electronic-circuit", "电路板"], ["assembling-machine-2", "组装机2型"]]);
const zh = (id: string) => zhMap.get(id) ?? id;

test("物品名: 内部名、官方全名、唯一包含都认; 认不出 null", () => {
  const known = (id: string) => zhMap.has(id);
  assert.equal(resolveItem("engine-unit", zhMap, known), "engine-unit");
  assert.equal(resolveItem("内燃机", zhMap, known), "engine-unit");
  assert.equal(resolveItem("化工科技包", zhMap, known), "chemical-science-pack", "括号不用写");
  assert.equal(resolveItem("没有这个", zhMap, known), null);
});

const block = (no: number, label: string, w = 10, h = 10, counts: Record<string, number> = {}): Block => ({ no, label, w, h, io: "", counts });
const asm = (key: string, add: number): Delta => ({ kind: "assembler", key, machine: "assembling-machine-2", need: add, have: 0, add });

test("挑蓝图: 同配方同机器, 够用里最小的; 不够就最大块放几份; 库里没有 null", () => {
  const blocks = [block(1, "组装机排 内燃机 × 8 / 组装机2型 / 单排"), block(2, "组装机排 内燃机 × 4 / 组装机2型 / 单排"), block(3, "组装机排 内燃机 × 16 / 组装机1型 / 单排"), block(4, "组装机排 电路板 × 6 / 组装机2型")];
  assert.equal(pickBlock(asm("engine-unit", 3), blocks, zh)!.block.no, 2);
  assert.equal(pickBlock(asm("engine-unit", 5), blocks, zh)!.block.no, 1);
  const big = pickBlock(asm("engine-unit", 20), blocks, zh)!;
  assert.deepEqual([big.block.no, big.copies], [1, 3], "只看组装机2型的块: 8 台放 3 份");
  assert.equal(pickBlock(asm("sulfur", 2), blocks, zh), null);
  const furnaces = [block(5, "冶炼列 stone-furnace × 16 / inserter"), block(6, "冶炼列 electric-furnace × 24 / inserter")];
  assert.equal(pickBlock({ kind: "furnace", key: "furnace", machine: "electric-furnace", need: 10, have: 0, add: 10 }, furnaces, zh)!.block.no, 6);
});

test("研究了但造不出来的机器: 按低一档重算, 只关缺的那一档; 缺别的或没有更低档 null (班次 2026-11-06T05-05-16 ./plan 红瓶 150 --build)", () => {
  const am2 = downgrade(tech, { "assembling-machine-2": 12, "transport-belt": 3 })!;
  assert.equal(am2.item, "assembling-machine-2");
  assert.deepEqual(am2.tech, { ...tech, automation2: false });
  assert.equal(downgrade(am2.tech, { "assembling-machine-2": 12 }), null, "已经关了就不再试, 不会死循环");
  assert.equal(downgrade(tech, { "transport-belt": 3, inserter: 1 }), null, "缺带子不是档位的事");
  assert.deepEqual(downgrade(tech, { "electric-furnace": 4 })!.tech, { ...tech, electricFurnace: false });
  const gd = loadGameData();
  const r = chainPlan(gd, "automation-science-pack", 30, am2.tech).recipes["automation-science-pack"];
  assert.equal(r.machine, "assembling-machine-1", "重算后红瓶用组装机1型");
});

test("放之前查高档机器拿不拿得到: 库存有机器或原料够 null; 缺钢回低一档和差什么; 查不了当拿得到", async () => {
  const hand: HandRecipe = (i) => (i === "assembling-machine-2" ? { name: i, yield: 1, ingredients: [{ name: "steel-plate", amount: 2 }, { name: "assembling-machine-1", amount: 1 }] } : i === "assembling-machine-1" ? { name: i, yield: 1, ingredients: [{ name: "iron-plate", amount: 9 }] } : null);
  const stock = (m: Record<string, number>) => async (i: string) => m[i] ?? 0;
  const lack = { "assembling-machine-2": 12, "transport-belt": 5 };
  const r = (await unreachableTier(lack, tech, {}, hand, stock({ "iron-plate": 500 })))!;
  assert.equal(r.item, "assembling-machine-2");
  assert.equal(r.tech.automation2, false);
  assert.deepEqual(r.short, { item: "steel-plate", need: 24, have: 0 });
  assert.equal(await unreachableTier(lack, tech, {}, hand, stock({ "steel-plate": 24, "iron-plate": 108 })), null, "原料够, 能搓");
  assert.equal(await unreachableTier(lack, tech, {}, hand, stock({ "assembling-machine-2": 12 })), null, "库存里有现成的");
  assert.equal(await unreachableTier(lack, tech, { "steel-plate": 24, "assembling-machine-1": 12 }, hand, stock({})), null, "背包里的算");
  assert.equal(await unreachableTier({ "transport-belt": 5 }, tech, {}, hand, stock({})), null, "缺的不是高档机器不管");
  assert.equal(await unreachableTier(lack, { ...tech, automation2: false }, {}, hand, stock({})), null, "这一档已经关了");
  assert.equal(await unreachableTier(lack, tech, {}, hand, async () => Infinity), null, "查不了不改方案");
});

test("拿不到高档机器时指给同产物的别的块: 小的在前, 别的产物和同档不算; 缺的不是机器为空", () => {
  const red = [block(205, "组装机排 红瓶 × 12 / 组装机2型 / 单排", 20, 13), block(204, "组装机排 红瓶 × 6 / 组装机2型 / 单排", 20, 7), block(241, "组装机排 红瓶 × 12 / 组装机1型 / 双排", 20, 13), block(240, "组装机排 红瓶 × 6 / 组装机1型 / 单排", 20, 7), block(300, "组装机排 绿瓶 × 6 / 组装机1型", 20, 7)];
  const alt = blocksWithout(red[0].label, { "assembling-machine-2": 12 }, red);
  assert.deepEqual(alt.map((a) => [a.block.no, a.size]), [[240, 6], [241, 12]]);
  assert.equal(alt[0].item, "assembling-machine-2");
  assert.deepEqual(blocksWithout(red[0].label, { "transport-belt": 3 }, red), []);
  assert.deepEqual(blocksWithout("组装机排 红瓶 × 6 / 组装机1型", { "assembling-machine-2": 1 }, red), [], "这块本来就不用缺的机器");
  const furn = [block(1, "冶炼列 electric-furnace × 24 / inserter"), block(2, "冶炼列 stone-furnace × 16 / inserter"), block(3, "组装机排 红瓶 × 6 / 组装机1型")];
  assert.deepEqual(blocksWithout(furn[0].label, { "electric-furnace": 24 }, furn).map((a) => a.block.no), [2]);
});

test("缺料: 蓝图要的减背包里的", () => {
  assert.deepEqual(missingItems({ inserter: 10, "transport-belt": 5 }, { inserter: 4, "transport-belt": 9 }), [{ item: "inserter", lack: 6 }]);
});

test("结果文字: 给能跑的 ./bp build; 机器够了就说不是机器的问题; 找不到空地和没有块都明说", () => {
  const d = asm("engine-unit", 8);
  const pick = { delta: d, block: block(42, "组装机排 内燃机 × 8", 14, 14), size: 8, copies: 2 };
  const t = planText({ item: "engine-unit", perMin: 30, zh, deltas: [d], steps: [{ pick, at: { x: 120.5, y: -40.5 }, lack: [{ item: "engine-unit", lack: 3 }] }], noBlock: [asm("electronic-circuit", 2)], imports: { "petroleum-gas": 50, "iron-ore": 9 } });
  assert.match(t, /\.\/bp build 42 --at 120\.5,-40\.5/);
  assert.match(t, /共要放 2 块/);
  assert.match(t, /缺的料 \.\/bp build 会先拿先搓: 内燃机 3/);
  // 一步到位和别的摆法 (不只推一种)
  const go = planText({ item: "engine-unit", perMin: 30, zh, deltas: [d], steps: [{ pick, at: { x: 1, y: 2 }, lack: [], others: otherBlocks(d, [block(42, "组装机排 内燃机 × 8 / 组装机2型 / 双排", 14, 14), block(50, "组装机排 内燃机 × 4 / 组装机2型 / 单排", 8, 7), block(51, "组装机排 内燃机 × 4 / 组装机2型 / 单排", 8, 7), block(60, "组装机排 铁齿轮 × 4", 8, 7)], zh, 42) }], noBlock: [], imports: {}, goCmd: "./plan 内燃机 30 --build" });
  assert.match(go, /一条命令按上面全放下.*\.\/plan 内燃机 30 --build/);
  assert.match(go, /别的摆法: \.\/bp show 50 \(组装机2型 单排 4 台 8x7\); 看真实基地怎么摆再自己设计: \.\/bp study engine-unit/);
  assert.doesNotMatch(go, /show 51/, "同样的摆法只列一个");
  assert.doesNotMatch(go, /show 60/, "别的产物不算");
  assert.match(t, /电路板: 差 2 台组装机2型, 库里没有现成的块/);
  assert.ok(t.includes("petroleum-gas 50/分") && !t.includes("iron-ore 9"), "矿走采矿机那一项, 这里只列别的");
  assert.match(planText({ item: "engine-unit", perMin: 30, zh, deltas: [{ ...d, add: 0 }], steps: [], noBlock: [], imports: {} }), /不是机器的问题/);
  assert.match(planText({ item: "engine-unit", perMin: 30, zh, deltas: [d], steps: [{ pick, at: null, lack: [] }], noBlock: [], imports: {} }), /找不到空地/);
});

test("放置命令: 给差额挑块、找空地、找过的不重复; 找不到空地或没块的跳过; 最多几条", async () => {
  const blocks = [block(5, "组装机排 内燃机 × 4 / 组装机2型 / 单排", 14, 7), block(6, "组装机排 内燃机 × 8 / 组装机2型 / 单排", 26, 7)];
  const seen: number[] = [];
  const site = async (_w: number, _h: number, taken: { x: number }[]) => { seen.push(taken.length); return { found: true, x: 10.5 + taken.length * 30, y: -4.5 }; };
  const one = await placementSteps([asm("engine-unit", 3)], blocks, zh, site);
  assert.equal(one.length, 1);
  assert.match(one[0], /^\.\/bp build 5 --at 10\.5,-4\.5 /);
  assert.match(one[0], /还差 3 台, 这块 4 台/);
  assert.equal((await placementSteps([asm("engine-unit", 3), asm("engine-unit", 8)], blocks, zh, site)).at(1)?.includes("--at 40.5,-4.5"), true, "第二块不和第一块抢地方");
  assert.deepEqual(await placementSteps([asm("engine-unit", 0)], blocks, zh, site), [], "够了不说");
  assert.deepEqual(await placementSteps([asm("engine-unit", 3)], blocks, zh, async () => ({ found: false })), [], "找不到空地跳过");
  assert.deepEqual(await placementSteps([asm("没有块的东西", 3)], [], zh, site), [], "没块跳过");
  assert.equal((await placementSteps([asm("engine-unit", 1), asm("engine-unit", 2), asm("engine-unit", 3), asm("engine-unit", 4)], blocks, zh, site)).length, 3, "最多 3 条");
});

test("找空地的 Lua: 占用过的地方写进去, 一行化后没有注释", () => {
  const l = siteLua([1, 2], 10, 20, [{ x: 5.5, y: 6.5, w: 3, h: 4 }]);
  assert.ok(l.includes("{5.5,6.5,3,4}") && l.includes("local cx, cy = 1, 2") && !l.includes("--"));
  assert.ok(siteLua(null, 1, 1, []).includes("local cx, cy = nil, nil"));
});

const dump = (() => { try { return loadGameData(); } catch { return null; } })();
test("全链方案 (真数据): 开局只有石炉和组装机1型, 红瓶绿瓶也解得出 (煤算从外面进)", { skip: !dump }, () => {
  const gd = dump!;
  const early = { automation2: false, steelFurnace: false, electricFurnace: false };
  for (const item of ["automation-science-pack", "logistic-science-pack"]) {
    const plan = chainPlan(gd, item, 30, early);
    assert.ok(plan.imports?.includes("coal"), `${item} 要把煤算进来`);
    const res = solvePlan(gd, plan);
    assert.ok(res.rows.some((r) => r.recipe === "iron-plate" && r.machine === "stone-furnace" && r.machines > 0));
    assert.ok((res.imports.coal ?? 0) > 0, "炉子烧的煤出现在外面进的里面");
  }
});

test("全链方案 (真数据): 蓝瓶展开到矿和石油气, 计算器解得出, 减掉场上已有", { skip: !dump }, () => {
  const gd = dump!;
  assert.equal(recipeFor(gd, "iron-plate")?.name, "iron-plate");
  const plan = chainPlan(gd, "chemical-science-pack", 30, tech);
  for (const r of ["chemical-science-pack", "engine-unit", "advanced-circuit", "sulfur", "plastic-bar", "steel-plate", "iron-plate", "copper-plate", "electronic-circuit", "copper-cable"]) assert.ok(plan.recipes[r], r);
  assert.equal(plan.recipes["iron-plate"].machine, "electric-furnace");
  assert.equal(plan.recipes["sulfur"].machine, "chemical-plant");
  assert.ok(plan.imports!.includes("iron-ore") && plan.imports!.includes("petroleum-gas") && !plan.recipes["petroleum-gas"]);
  const res = solvePlan(gd, plan);
  assert.ok(res.rows.find((r) => r.recipe === "chemical-science-pack")!.machines > 0);
  const ds = deltas(res, normalizeExisting({ assemblers: { "chemical-science-pack": 100 }, furnaces: 0, drillPerMin: {}, tech }));
  assert.equal(ds.find((d) => d.key === "chemical-science-pack")!.add, 0, "够了不差");
  assert.ok(ds.find((d) => d.key === "engine-unit")!.add > 0);
});
