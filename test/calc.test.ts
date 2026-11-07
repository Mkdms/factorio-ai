// 计算器 (src/calc) 的测试: 对照沙盘已经核实过的事实 (knowledge/facts.md), 用本机原型数据 (没有就跳过)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGameData, energy, type GameData } from "../src/calc/data.ts";
import { recipeOnMachine, solvePlan, effectsFor, qualityMultiplier } from "../src/calc/solve.ts";

let gd: GameData | null = null;
try { gd = loadGameData(); } catch { gd = null; }
const skip = !gd;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

test("能量单位", () => {
  assert.equal(energy("500kW"), 500000);
  assert.equal(energy("2MJ"), 2e6);
  assert.equal(energy("1.5GW"), 1.5e9);
});

test("石炉做铁板每分钟 18.75 块, 吃煤 1.35 个 (smelting.stone-furnace.rate ✅)", { skip }, () => {
  const x = recipeOnMachine(gd!, "iron-plate", { machine: "stone-furnace" });
  near(x.perMachine * x.out["iron-plate"], 18.75);
  near(x.fuel!.perCraft * x.perMachine, 1.35);
});

test("生物室: 1 生物结晶换 12 营养素, 开工每分钟烧 15 个营养素 (biochamber 第九、十二批 ✅)", { skip }, () => {
  const x = recipeOnMachine(gd!, "nutrients-from-bioflux", { machine: "biochamber" });
  near(x.out["nutrients"] / x.inp["bioflux"], 12);
  near(x.fuel!.perCraft * x.perMachine, 15);
  assert.equal(x.fuel!.item, "nutrients");
});

test("产能: 铁细菌培养对 4 个全算 (平均 6), 五足虫卵只算净增 (平均 2.5) (第十二批 ✅)", { skip }, () => {
  near(recipeOnMachine(gd!, "iron-bacteria-cultivation", { machine: "biochamber" }).out["iron-bacteria"], 6);
  near(recipeOnMachine(gd!, "pentapod-egg", { machine: "biochamber" }).out["pentapod-egg"], 2.5);
});

test("分享塔: n 座各 2 个速度插件 3, 总加速 = 1.5 × √n × 100% (beacons.sqrt-rule ✅)", { skip }, () => {
  const m = gd!.machines.get("assembling-machine-3")!, r = gd!.recipes.get("iron-gear-wheel")!;
  const per = gd!.modules.get("speed-module-3")!.effect.speed!;
  near(per, 0.5); // 每个 +50%
  for (const n of [1, 2, 4, 8]) {
    const e = effectsFor(gd!, m, r, { machine: m.name, beacons: { name: "beacon", count: n, modules: ["speed-module-3", "speed-module-3"] } });
    near(e.speed, 1.5 * Math.sqrt(n) * 2 * per, 0.01); // 每座 2 个插件 × 50% = 1, × 分享效率 1.5 × 递减 → 1.5√n (递减表是 4 位小数)
  }
});

test("产能夹在 [0, 配方上限]、不许产能的配方不吃产能", { skip }, () => {
  const m = gd!.machines.get("assembling-machine-3")!;
  const gears = gd!.recipes.get("iron-gear-wheel")!;
  const e = effectsFor(gd!, m, gears, { machine: m.name, researchProductivity: 10 });
  near(e.productivity, gears.maxProductivity);
  const noProd = [...gd!.recipes.values()].find((r) => !r.allowProductivity && r.categories.some((c) => m.categories.includes(c)))!;
  near(effectsFor(gd!, m, noProd, { machine: m.name, modules: ["productivity-module-3"] }).productivity, 0);
});

test("循环链: 生物结晶自给营养素 —— 只从外面进果子, 营养素不进口, 生物结晶净产出 = 目标", { skip }, () => {
  const res = solvePlan(gd!, {
    targets: { bioflux: 60 },
    recipes: {
      "yumako-processing": { machine: "biochamber" },
      "jellynut-processing": { machine: "biochamber" },
      bioflux: { machine: "biochamber" },
      "nutrients-from-bioflux": { machine: "biochamber" },
    },
    imports: ["yumako", "jellynut"],
  });
  assert.deepEqual(Object.keys(res.imports).sort(), ["jellynut", "yumako"]);
  const fuelNeed = res.rows.reduce((n, r) => n + (r.fuel?.perMin ?? 0), 0);
  const nutr = res.rows.find((r) => r.recipe === "nutrients-from-bioflux")!;
  near(nutr.outputs["nutrients"], fuelNeed, 1e-4); // 营养素做的正好够烧
  const made = res.rows.reduce((n, r) => n + (r.outputs["bioflux"] ?? 0) - (r.inputs["bioflux"] ?? 0), 0);
  near(made, 60, 1e-4);
});

test("腐坏批量: 营养素一批 60 个、保质期 5 分钟, 小核心每分钟只烧 4.6 个 → 至少每分钟做 12 个, 浪费算进用料 (M3 生物核心沙盘实测 34.6 / 分钟)", { skip }, () => {
  const res = solvePlan(gd!, {
    targets: {},
    recipes: {
      "yumako-processing": { machine: "assembling-machine-2", count: 1 },
      "jellynut-processing": { machine: "assembling-machine-2", count: 1 },
      bioflux: { machine: "biochamber", count: 1 },
      "nutrients-from-bioflux": { machine: "biochamber", count: 1 },
    },
    imports: ["yumako", "jellynut"],
    maximize: "bioflux",
  });
  const w = res.spoilWaste.find((x) => x.item === "nutrients")!;
  near(w.minPerMin, 12);
  assert.ok(!res.spoilWaste.some((x) => x.item === "bioflux"), "要的成品不算浪费");
  const net = res.surplus["bioflux"];
  assert.ok(Math.abs(net - 34.6) / 34.6 < 0.03, `净产 ${net}`); // 沙盘实测 34.6
});

test("品质 (第十九批 ✅): 机器 ×(1+0.3×等级)、插件只放大正面效果、传说分享塔 1.5 → 2.5", { skip }, () => {
  near(qualityMultiplier("legendary"), 2.5);
  near(recipeOnMachine(gd!, "iron-gear-wheel", { machine: "assembling-machine-2", quality: "legendary" }).perMachine, (60 * 0.75 * 2.5) / 0.5);
  const m = gd!.machines.get("assembling-machine-3")!, r = gd!.recipes.get("iron-gear-wheel")!;
  const sp = effectsFor(gd!, m, r, { machine: m.name, modules: ["speed-module-3@legendary"] });
  near(sp.speed, 1.25); near(sp.consumption, 0.7);
  const pr = effectsFor(gd!, m, r, { machine: m.name, modules: ["productivity-module-3@legendary"] });
  near(pr.productivity, 0.25); near(pr.speed, -0.15); near(pr.consumption, 0.8);
  near(effectsFor(gd!, m, r, { machine: m.name, beacons: { name: "beacon", count: 1, modules: ["speed-module-3", "speed-module-3"], quality: "legendary" } }).speed, 2.5);
});
