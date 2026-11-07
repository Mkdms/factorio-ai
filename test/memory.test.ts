// 从内存字段推算机器状态的规则 (game/memory/status.ts); 和真游戏逐个比的是 test/sandbox/memory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { STATUS as S, memStatus, powerStatus, type Raw } from "../game/memory/status.ts";
import { Tally, bag, close, compareEntity } from "../game/memory/compare.ts";
import { pythonExe } from "../game/memory/read.ts";

// 游戏外的模组宿主用 Python 版 (game/memory/status.py), 规则必须和这里一样: 同一批输入两边比
test("Python 版和 TS 版给的状态一样", (t) => {
  const powers = [undefined, { src: "electric", energy: 100, capacity: 100, network: 1 }, { src: "electric", energy: 50, capacity: 100, network: 1 }, { src: "electric", energy: 0, capacity: 100, network: 1 }, { src: "burner", energy: 0, remaining: 0, burning: null, fuel: [] }, { src: "burner", energy: 5, remaining: 1, burning: "coal", fuel: [{}] }, { src: "burner", energy: 0, remaining: 0, burning: null, fuel: [{}] }];
  const cases: Raw[] = [];
  for (const power of powers) for (const usage of [0, 0x4000]) {
    for (const cls of ["AssemblingMachine", "Furnace"]) for (const recipe of [null, "x"]) for (const stored of [0, 1, 2]) for (const sleep of [0, 6, 8, 9]) for (const flags of [0, 2]) for (const outFull of [false, true]) cases.push({ cls, power, usage, recipe, stored, recipeEnergy: 2, sleep, flags, outFull } as Raw);
    for (const active of [0, 1]) for (const bufferEmpty of [0, 1]) for (const stuck of [0, 1]) for (const resources of [0, 3]) for (const dropFull of [true, false, null]) for (const dropDeconstruct of [false, true]) cases.push({ cls: "MiningDrill", power, usage, active, bufferEmpty, stuck, resources, dropFull, dropDeconstruct } as Raw);
    for (const last of [0, 1, 2, 3, 9]) cases.push({ cls: "Lab", power, usage, last } as Raw);
    for (const active of [0, 1]) for (const heldItem of [0, 7]) for (const flags of [0, 4]) for (const dropFull of [true, false, null]) for (const atPickup of [false, true]) for (const atDrop of [false, true]) cases.push({ cls: "Inserter", power, usage, active, heldItem, flags, dropFull, atPickup, atDrop } as Raw);
    for (const ammo of [[], [{}]]) cases.push({ cls: "AmmoTurret", power, usage, ammo } as Raw);
    for (const cls of ["ContainerEntity", "LogisticContainer", "Generator", "TransportBelt", "UndergroundBelt", "Splitter", "Pipe", "PipeToGround", "OffshorePump", "Radar", "Boiler", "ElectricPole", "Character", "Unknown"]) cases.push({ cls, power, usage } as Raw);
    for (const cls of ["ContainerEntity", "LogisticContainer"]) for (const defaultStatus of ["broken", "normal", "working", "nope"]) cases.push({ cls, power, usage, defaultStatus } as Raw);
  }
  let py: number[];
  try {
    py = JSON.parse(execFileSync(pythonExe(), ["-I", "game/memory/status.py", "--batch"], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true })) as number[];
  } catch (e) {
    t.skip(`没有 python: ${(e as Error).message.slice(0, 80)}`);
    return;
  }
  assert.equal(py.length, cases.length);
  const wrong = cases.filter((c, i) => memStatus(c) !== py[i]).slice(0, 3);
  assert.deepEqual(wrong, [], "两边规则不一样");
  assert.ok(cases.length > 3000);
});

const electric = { src: "electric", energy: 100, capacity: 100, network: 1 };

test("取编号最大的条件: 等拆除和没电压过别的", () => {
  assert.equal(memStatus({ cls: "AssemblingMachine", usage: 0x4000, power: { ...electric, energy: 0 }, recipe: "x", stored: 1, recipeEnergy: 2 }), S.marked_for_deconstruction);
  assert.equal(memStatus({ cls: "AssemblingMachine", power: { ...electric, energy: 0 }, recipe: "x", stored: 1, recipeEnergy: 2 }), S.no_power);
});

test("能量: 烧的要没热量、没在烧、燃料格也空才算没燃料; 电的空了没电, 没满低电", () => {
  assert.equal(powerStatus({ src: "burner", energy: 0, remaining: 0, burning: null, fuel: [] }), S.no_fuel);
  assert.equal(powerStatus({ src: "burner", energy: 0, remaining: 0, burning: null, fuel: [{}] }), 0, "格里有煤但没在烧 (炉子没配方)");
  assert.equal(powerStatus({ src: "burner", energy: 5, burning: "coal", fuel: [] }), 0);
  assert.equal(powerStatus({ ...electric, energy: 0 }), S.no_power);
  assert.equal(powerStatus({ ...electric, energy: 50 }), S.low_power);
  assert.equal(powerStatus(electric), 0);
  assert.equal(powerStatus(undefined), 0);
});

test("组装机和炉子: 没配方、在做、缺料、出料堵", () => {
  const base = { power: electric, recipe: "x", recipeEnergy: 2 };
  assert.equal(memStatus({ cls: "AssemblingMachine", power: electric }), S.no_recipe);
  assert.equal(memStatus({ cls: "Furnace", power: electric }), S.no_ingredients);
  assert.equal(memStatus({ cls: "AssemblingMachine", ...base, stored: 1 }), S.working);
  assert.equal(memStatus({ cls: "AssemblingMachine", ...base, stored: 0, sleep: 8 }), S.item_ingredient_shortage);
  assert.equal(memStatus({ cls: "AssemblingMachine", ...base, stored: 0, sleep: 9 }), S.fluid_ingredient_shortage);
  assert.equal(memStatus({ cls: "AssemblingMachine", ...base, stored: 0, sleep: 8, flags: 2 }), S.full_output, "不用喂又没做 = 出料堵了");
  assert.equal(memStatus({ cls: "AssemblingMachine", ...base, stored: 0, sleep: 8, flags: 4, outFull: true }), S.full_output, "标记还没置上, 产物够多也算堵料 (刚读完地图)");
  assert.equal(memStatus({ cls: "AssemblingMachine", ...base, stored: 0, sleep: 8, flags: 4, outFull: false }), S.item_ingredient_shortage, "产物不多就是缺料");
  assert.equal(memStatus({ cls: "AssemblingMachine", ...base, stored: 1, flags: 4, outFull: true }), S.working, "在做的时候产物多也算工作");
  assert.equal(memStatus({ cls: "Furnace", ...base, stored: 1, sleep: 6 }), S.full_output);
  assert.equal(memStatus({ cls: "AssemblingMachine", ...base, stored: 2 }), S.full_output, "做完了放不出去");
  assert.equal(memStatus({ cls: "AssemblingMachine", ...base, stored: 1, flags: 2 }), S.working, "在做的时候料满也算工作");
});

test("矿机: 没矿、放不下、在挖", () => {
  assert.equal(memStatus({ cls: "MiningDrill", power: electric, active: 0, bufferEmpty: 1, stuck: 0, resources: 0 }), S.no_minable_resources);
  assert.equal(memStatus({ cls: "MiningDrill", power: electric, active: 1, bufferEmpty: 0, resources: 4, dropFull: true }), S.waiting_for_space_in_destination);
  assert.equal(memStatus({ cls: "MiningDrill", power: electric, active: 0, bufferEmpty: 0, resources: 4, dropFull: false }), S.waiting_for_space_in_destination, "睡着了就是放不下");
  assert.equal(memStatus({ cls: "MiningDrill", power: electric, active: 1, bufferEmpty: 0, resources: 4, dropFull: false }), S.working, "醒着、目标没满: 下一刻就放走了");
  assert.equal(memStatus({ cls: "MiningDrill", power: electric, active: 1, bufferEmpty: 1, stuck: 3, resources: 4 }), S.waiting_for_space_in_destination);
  assert.equal(memStatus({ cls: "MiningDrill", power: electric, active: 0, bufferEmpty: 1, stuck: 0, resources: 4, dropDeconstruct: true }), S.waiting_for_space_in_destination);
  assert.equal(memStatus({ cls: "MiningDrill", power: electric, active: 1, bufferEmpty: 1, stuck: 0, resources: 4 }), S.working);
});

test("研究中心按上次结果; 炮塔看弹药; 箱子正常; 没核对过的类不瞎猜", () => {
  assert.deepEqual([0, 1, 2, 3].map((last) => memStatus({ cls: "Lab", power: electric, last })), [S.working, S.no_power, S.no_research_in_progress, S.missing_science_packs]);
  assert.equal(memStatus({ cls: "AmmoTurret", ammo: [] }), S.no_ammo);
  assert.equal(memStatus({ cls: "AmmoTurret", ammo: [{}] }), S.working);
  assert.equal(memStatus({ cls: "ContainerEntity" }), S.normal);
  assert.equal(memStatus({ cls: "ContainerEntity", defaultStatus: "broken" }), S.broken, "开局坠机残骸的容器: 原型 default_status");
  assert.equal(memStatus({ cls: "ContainerEntity", defaultStatus: "nope" }), S.normal, "没见过的名字当没有");
  assert.equal(memStatus({ cls: "Generator", power: { ...electric, energy: 1 } }), S.working, "发电机缓冲没满不算低电");
  assert.equal(memStatus({ cls: "ElectricPole" }), null);
});

test("机械臂: 睡着 / 醒着, 手上有没有东西, 目标满没满", () => {
  const p = { power: electric };
  assert.equal(memStatus({ cls: "Inserter", ...p, active: 0, heldItem: 0 }), S.waiting_for_source_items);
  assert.equal(memStatus({ cls: "Inserter", ...p, active: 0, heldItem: 5, flags: 0 }), S.waiting_for_space_in_destination);
  assert.equal(memStatus({ cls: "Inserter", ...p, active: 0, heldItem: 5, flags: 4 }), S.waiting_for_more_items);
  assert.equal(memStatus({ cls: "Inserter", ...p, active: 0, heldItem: 0, dropFull: true }), S.waiting_for_space_in_destination);
  assert.equal(memStatus({ cls: "Inserter", ...p, active: 1, heldItem: 0, atPickup: true }), S.waiting_for_source_items);
  assert.equal(memStatus({ cls: "Inserter", ...p, active: 1, heldItem: 0, atPickup: false }), S.working);
  assert.equal(memStatus({ cls: "Inserter", ...p, active: 1, heldItem: 5, atDrop: true }), S.waiting_for_space_in_destination);
  assert.equal(memStatus({ cls: "Inserter", ...p, active: 1, heldItem: 5, atDrop: false }), S.working);
});

test("核对工具: 同一批东西不管顺序; 差不多; 记账; 认错类只记一条", () => {
  assert.deepEqual(bag([{ name: "b", count: 2 }, { name: "a", quality: "rare", count: 1 }]), ["a@rare*1", "b@normal*2"]);
  assert.deepEqual(bag(undefined), []);
  assert.equal(close(1, 1.005, 0.01), true);
  assert.equal(close(1, undefined, 0.01), false);
  const t = new Tally();
  compareEntity(t, { type: "lab" }, undefined, "x");
  assert.equal(t.total, 1);
  assert.equal(t.bad, 1);
  const ok = new Tally();
  compareEntity(ok, { type: "lab", health: 150, quality: "normal", status: 1, input: [{ name: "a", count: 1 }], energy: 100 }, { cls: "Lab", health: 150, quality: "normal", last: 0, input: [{ name: "a", quality: "normal", count: 1 }], power: { src: "electric", energy: 100, capacity: 100 } }, "x");
  assert.equal(ok.bad, 0, JSON.stringify([...ok.fields.values()]));
});
