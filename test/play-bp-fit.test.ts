// ./bp build 放之前问游戏、放完比对和接线 (src/play/bp-fit.ts); 真游戏的读数在 docs/brain-run.md "怎么让他们用"
import test from "node:test";
import assert from "node:assert/strict";
import { blockedText, blockersOf, blockInputs, blockPorts, findSpot, pasteArgs, pasteDecision, realBlockers, verifyText, wireLines } from "../src/play/bp-fit.ts";

test("挡路的: 分出树石 (bp build 自己清) 和真挡着的; 不是实体的原因整行留着", () => {
  // 2.1.24 模组 paste dry_run 的原文
  const lines = ["#7 transport-belt (97.5,57.5): blocked by dead-tree-desert (98.4375,57.5)", "#29 assembling-machine-1 (102.5,60.5): blocked by tree-08-red (102.688,59.0625), lab (1,2)", "#1 transport-belt (-8.5,-38.5): blocked by lab (-7.5,-39.5)", "#2 transport-belt (0.5,0.5): blocked by rock-big (0.1,0.2)", "#9 pipe (3.5,4.5): water tile"];
  assert.deepEqual(blockersOf(lines[1]), ["tree-08-red (102.688,59.0625)", "lab (1,2)"]);
  assert.deepEqual(realBlockers(lines), ["lab (1,2)", "lab (-7.5,-39.5)", "pipe (3.5,4.5): water tile"]);
  assert.deepEqual(realBlockers(undefined), []);
  assert.deepEqual(realBlockers([lines[0], lines[3]]), [], "只有树石算放得下");
});

test("直接 paste 挡着树就拆树: 只有树石才 forced; 有建筑不 forced; 模型自己写了 mode 或 dry_run 不碰", () => {
  const call = (o: unknown, name = "paste") => ["call", name, "--args", JSON.stringify(o), "--wait", "--bot", "A"];
  assert.deepEqual(pasteArgs(call({ position: { x: 1, y: 2 } })), { index: 3, value: { position: { x: 1, y: 2 } } });
  assert.ok(pasteArgs(call({ position: { x: 1, y: 2 } }, "blueprint_place")));
  assert.equal(pasteArgs(call({ position: { x: 1, y: 2 }, mode: "normal" })), null);
  assert.equal(pasteArgs(call({ position: { x: 1, y: 2 }, dry_run: true })), null);
  assert.equal(pasteArgs(call({}, "build")), null);
  assert.equal(pasteArgs(["call", "paste", "--args", "{坏的"]), null);
  assert.equal(pasteArgs(["call", "paste"]), null);
  const tree = "#7 transport-belt (97.5,57.5): blocked by dead-tree-desert (98.4375,57.5)", lab = "#1 transport-belt (-8.5,-38.5): blocked by lab (-7.5,-39.5)";
  assert.deepEqual(pasteDecision({ blocked: [tree] }), { force: true, blockers: [] });
  assert.deepEqual(pasteDecision({ blocked: [tree, lab] }), { force: false, blockers: ["lab (-7.5,-39.5)"] }, "实测 forced 只贴上 24/66, 留半块");
  assert.deepEqual(pasteDecision({ blocked: [] }), { force: false, blockers: [] }, "没挡路就普通贴");
  assert.deepEqual(pasteDecision(null), { force: false, blockers: [] });
});

test("放不下: 只认 dry_run; 第一个猜的被挡就换下一个; 找不到回 null", async () => {
  const tried: number[] = [];
  const site = async (_n: [number, number], _w: number, _h: number, taken: unknown[]) => { tried.push(taken.length); return taken.length < 2 ? { found: true, x: taken.length * 10, y: 0 } : { found: false }; };
  assert.deepEqual(await findSpot([0, 0], 3, 3, site, async (x) => (x === 10 ? [] : ["lab"])), { x: 10, y: 0 });
  assert.equal(await findSpot([0, 0], 3, 3, site, async () => ["lab"]), null, "都被挡");
  const t = blockedText("240", [0.5, -35.5], ["lab (1,2)"], { x: 5.5, y: 6.5 }, " --keep-trees");
  for (const s of ["什么都没动", "(0.5,-35.5)", "lab (1,2)", "./bp build 240 --at 5.5,6.5 --keep-trees"]) assert.ok(t.includes(s), s);
  assert.match(blockedText("240", [0, 0], ["a"], null), /找不到放得下/);
  assert.match(blockedText("240", [0, 0], Array.from({ length: 12 }, (_, i) => `x${i}`), null), /等 12 件/);
});

// 组装机排的样子 (和 blocks 240 一样): 上面一条进料带 (机械臂从上面取)、下面一条出料带 (机械臂往上放)
const E = 4, N = 0, S = 8;
const row: { name: string; position: { x: number; y: number }; direction?: number; recipe?: string; type?: string }[] = [
  ...[0, 1, 2, 3].map((x) => ({ name: "transport-belt", position: { x: x + 0.5, y: 0.5 }, direction: E })),
  { name: "inserter", position: { x: 1.5, y: 1.5 }, direction: N }, // 取货方向朝北 = 从进料带取
  { name: "assembling-machine-1", position: { x: 1.5, y: 3.5 }, recipe: "automation-science-pack" },
  { name: "inserter", position: { x: 1.5, y: 5.5 }, direction: N }, // 从机器取, 放到南边的出料带
  ...[0, 1, 2, 3].map((x) => ({ name: "transport-belt", position: { x: x + 0.5, y: 6.5 }, direction: E })),
];

test("入口出口: 有机械臂取的带子串头是入口, 有机械臂放、没人取的串尾是出口; 换成世界坐标", () => {
  const p = blockPorts(row, { x: 100, y: 200 });
  assert.deepEqual(p.inputs, [{ x: 100.5, y: 200.5, dir: "东" }]);
  assert.deepEqual(p.outputs, [{ x: 103.5, y: 206.5, dir: "东" }]);
});

test("入口出口: 朝东放 (--dir east) 转 90 度, 方向跟着转", () => {
  const p = blockPorts(row, { x: 0, y: 0 }, "east");
  assert.deepEqual(p.inputs, [{ x: -0.5, y: 0.5, dir: "南" }]);
  assert.deepEqual(p.outputs, [{ x: -6.5, y: 3.5, dir: "南" }]);
});

test("入口出口: 地下带接成一串; 没有带子就都空", () => {
  const ug = [
    { name: "transport-belt", position: { x: 0.5, y: 0.5 }, direction: E },
    { name: "underground-belt", position: { x: 1.5, y: 0.5 }, direction: E, type: "input" },
    { name: "underground-belt", position: { x: 4.5, y: 0.5 }, direction: E, type: "output" },
    { name: "transport-belt", position: { x: 5.5, y: 0.5 }, direction: E },
    { name: "inserter", position: { x: 5.5, y: 1.5 }, direction: S }, // 取货方向朝南 = 从南边的机器取, 放到北边的带子
  ];
  const p = blockPorts(ug, { x: 0, y: 0 });
  assert.deepEqual(p.outputs, [{ x: 5.5, y: 0.5, dir: "东" }], "串尾在地下带另一头");
  assert.deepEqual(blockPorts([{ name: "lab", position: { x: 0, y: 0 } }], { x: 0, y: 0 }), { inputs: [], outputs: [] });
});

test("吃什么: 配方的固体原料, 去掉本块自己做的", () => {
  const ing: Record<string, { name: string; fluid?: boolean }[]> = { a: [{ name: "b" }, { name: "iron" }, { name: "water", fluid: true }], b: [{ name: "iron" }, { name: "copper" }] };
  assert.deepEqual(blockInputs([{ name: "m", position: { x: 0, y: 0 }, recipe: "a" }, { name: "m", position: { x: 0, y: 0 }, recipe: "b" }], (r) => ing[r] ?? []), ["iron", "copper"]);
});

test("比对: 只报事实; 少了、虚影、配方、电都说", () => {
  const ok = verifyText({ counts: { a: 2, b: 1 }, ghosts: 0, machines: 1, recipes: 1, powered: 1, needPower: 1 }, { a: 2, b: 1 });
  assert.match(ok, /3 件都在/);
  assert.match(ok, /配方 1\/1/);
  assert.match(ok, /电 1\/1 台接上了/);
  const bad = verifyText({ counts: { a: 1 }, ghosts: 3, machines: 2, recipes: 1, powered: 0, needPower: 2, pole: { x: 1, y: 2 }, poleDist: 7.6 }, { a: 2, b: 1 });
  for (const s of ["少了 a 1/2、b 0/1", "还剩 3 个虚影", "配方 1/2", "最近的杆 (1,2) 离这块 8 格"]) assert.ok(bad.includes(s), s);
  assert.match(verifyText({ counts: {}, ghosts: 0, machines: 0, recipes: 0, powered: 0, needPower: 1 }, {}), /80 格内没有杆/);
});

test("接线命令: 游戏查过能走才写成命令; 走不通只报事实; 2026-11-06 真跑 from 带 dir 字段会报错, to 只有 x y", () => {
  const rows = wireLines([
    { item: "copper-plate", at: { x: 1, y: 2 }, to: { x: 3, y: 4 }, ok: true, tiles: 12 },
    { item: "iron-plate", at: { x: 5, y: 6 }, to: { x: 3, y: 4 }, ok: false, why: "the start tile (5,6) is fed by another belt" },
    { item: "coal", at: null },
  ], { from: { x: 7, y: 8 }, to: { x: 9, y: 0 }, ok: true, count: 2 });
  assert.equal(rows[0], `./fh call belt_route --args '{"from":{"x":1,"y":2},"to":{"x":3,"y":4},"item":"copper-plate"}'  (copper-plate, 游戏查过能走, 12 格)`);
  assert.doesNotMatch(rows[1], /belt_route --args/);
  assert.match(rows[1], /fed by another belt/);
  assert.match(rows[1], /分流器/);
  assert.match(rows[2], /没有 coal/);
  assert.match(rows[3], /pole_route --args '\{"from":\{"x":7,"y":8\},"to":\{"x":9,"y":0\}\}'/);
  assert.match(rows[3], /要放 2 根杆/);
  assert.match(wireLines([], { from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, ok: false, why: "no" })[0], /走不通/);
});
