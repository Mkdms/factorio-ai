// 扩产提案 (src/play/expand.ts): 目标阶梯、按科技选机器、差额、给大脑的话
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRung, reached, planFor, deltas, isDone, proposalMessage, normalizeExisting, propose, LADDER } from "../src/play/expand.ts";
import { planText } from "../src/play/plan-lib.ts";
import { loadGameData } from "../src/calc/data.ts";
import type { Result } from "../src/calc/solve.ts";

const tech = { automation2: true, steelFurnace: true, electricFurnace: false, oil: false, electricDrill: true };

test("目标阶梯: 第一个没达到 (任一项 < 90%) 的档; 全达到就最后一档翻倍", () => {
  assert.deepEqual(nextRung({ red: 0, green: 0, blue: 0 }), LADDER[0]);
  assert.deepEqual(nextRung({ red: 28, green: 27, blue: 0 }), LADDER[1], "27 ≥ 30 × 90% 算达到");
  assert.deepEqual(nextRung({ red: 28, green: 20, blue: 0 }), LADDER[0]);
  assert.deepEqual(nextRung({ red: 60, green: 60, blue: 0 }), LADDER[2]);
  assert.deepEqual(nextRung({ red: 500, green: 500, blue: 500 }), { red: 360, green: 360, blue: 240 });
  assert.equal(reached(LADDER[2], { red: 60, green: 60, blue: 26 }), false);
});

test("方案按科技选机器: 组装机 2 型 / 钢炉; 没研究石油就不排蓝瓶", () => {
  const p = planFor({ red: 60, green: 60, blue: 30 }, tech);
  assert.deepEqual(p.targets, { "automation-science-pack": 60, "logistic-science-pack": 60 }, "oil 没研究, 蓝瓶不进目标");
  assert.equal(p.recipes["iron-plate"].machine, "steel-furnace");
  assert.equal(p.recipes["inserter"].machine, "assembling-machine-2");
  const p1 = planFor({ red: 30, green: 0, blue: 0 }, { ...tech, automation2: false, steelFurnace: false });
  assert.deepEqual(Object.keys(p1.recipes).sort(), ["automation-science-pack", "copper-plate", "iron-gear-wheel", "iron-plate"]);
  assert.equal(p1.recipes["iron-plate"].machine, "stone-furnace");
  assert.equal(planFor({ red: 60, green: 60, blue: 30 }, { ...tech, oil: true }).targets["chemical-science-pack"], 30);
});

test("差额: 组装机按配方, 炉子合并只看总数, 采矿机按矿折算; 都够了就 done", () => {
  const result = { rows: [
    { recipe: "automation-science-pack", machine: "assembling-machine-2", machines: 6.67 }, { recipe: "iron-gear-wheel", machine: "assembling-machine-2", machines: 1.1 },
    { recipe: "iron-plate", machine: "steel-furnace", machines: 8.4 }, { recipe: "copper-plate", machine: "steel-furnace", machines: 3.2 }, { recipe: "copper-cable", machine: "assembling-machine-2", machines: 0 },
  ], imports: { "iron-ore": 240, "copper-ore": 100, coal: 50 }, surplus: {}, powerW: 0, spoilWaste: [] } as unknown as Result;
  const ex = normalizeExisting({ assemblers: { "automation-science-pack": 4 }, furnaces: 10, drillPerMin: { "iron-ore": 180 }, tech });
  const ds = deltas(result, ex);
  assert.deepEqual(ds.map((d) => [d.kind, d.key, d.need, d.have, d.add]), [
    ["assembler", "automation-science-pack", 7, 4, 3], ["assembler", "iron-gear-wheel", 2, 0, 2], ["furnace", "furnace", 12, 10, 2],
    ["drill", "iron-ore", 8, 6, 2], ["drill", "copper-ore", 4, 0, 4], ["drill", "coal", 2, 0, 2],
  ]);
  assert.equal(isDone(ds), false);
  assert.equal(isDone(deltas(result, normalizeExisting({ assemblers: { "automation-science-pack": 7, "iron-gear-wheel": 2 }, furnaces: 12, drillPerMin: { "iron-ore": 240, "copper-ore": 120, coal: 60 }, tech }))), true);
  assert.deepEqual(normalizeExisting({ assemblers: [], furnaces: 3, drillPerMin: [], tech: {} }).assemblers, {}, "Lua 空表 [] 当空");
});

test("差额按档折算: 低档机器不能按高档算台数; 同档和台数算法一样; 带插件的按实际速度 (班次 2026-11-06T05-15-13)", () => {
  const gd = { machines: new Map([["assembling-machine-2", { speed: 0.75 }], ["steel-furnace", { speed: 2 }]]) } as never;
  const result = { rows: [{ recipe: "automation-science-pack", machine: "assembling-machine-2", machines: 16.67 }, { recipe: "iron-plate", machine: "steel-furnace", machines: 8 }], imports: {} } as unknown as Result;
  const ex = (asmN: number, asmSpeed: number, f: number, fs_: number) => normalizeExisting({ assemblers: { "automation-science-pack": asmN }, assemblerSpeed: { "automation-science-pack": asmSpeed }, furnaces: f, furnaceSpeed: fs_, drillPerMin: {}, tech });
  // 6 台 1 型 (0.5) + 6 台 2 型 (0.75) = 7.5, 折合 10 台 2 型; 按台数只差 5, 实际差 7
  const mixed = deltas(result, ex(12, 7.5, 41, 41), gd);
  assert.deepEqual([mixed[0].need, mixed[0].have, mixed[0].add, mixed[0].equiv], [17, 12, 7, 10]);
  assert.deepEqual([mixed[1].need, mixed[1].have, mixed[1].add, mixed[1].equiv], [8, 41, 0, 20.5], "41 台石炉折 20.5 台钢炉, 够");
  const same = deltas(result, ex(12, 9, 8, 16), gd);
  assert.deepEqual([same[0].add, same[0].equiv], [5, undefined], "全是 2 型: 和按台数一样, 不写折合");
  assert.equal(same[1].add, 0);
  assert.equal(deltas(result, ex(12, 7.5, 8, 16))[0].add, 5, "不给 gd 还按台数 (老调用)");
  const withModules = deltas(result, ex(12, 13.5, 8, 16), gd);
  assert.deepEqual([withModules[0].add, withModules[0].equiv], [0, 18], "带速度插件的算实际速度");
  const zh = (n: string) => n;
  assert.match(planText({ item: "automation-science-pack", perMin: 150, zh, deltas: [mixed[0]], steps: [{ pick: { delta: mixed[0], block: { no: 241, label: "", w: 20, h: 13, io: "", counts: {} }, size: 12, copies: 1 }, at: null, lack: [] }], noBlock: [], imports: {} }), /现 12 台 \(按assembling-machine-2折合 10 台\), 要 17 台/);
});

test("给大脑的话: 差额列具体台数和 ./calc 命令; 机器齐了产量没到 → 瓶颈不在机器数", () => {
  const zh = (n: string) => ({ "automation-science-pack": "机自科技包（红瓶）", "assembling-machine-2": "组装机2型", "steel-furnace": "钢炉", "iron-ore": "铁矿", "electric-mining-drill": "电力采矿机" } as Record<string, string>)[n] ?? n;
  const ds = [
    { kind: "assembler" as const, key: "automation-science-pack", machine: "assembling-machine-2", need: 7, have: 4, add: 3 },
    { kind: "furnace" as const, key: "furnace", machine: "steel-furnace", need: 12, have: 10, add: 2, note: "iron-plate 9 + copper-plate 4" },
    { kind: "drill" as const, key: "iron-ore", machine: "electric-mining-drill", need: 8, have: 6, add: 2, note: "每分钟要 240, 现有采矿机合计出 180" },
    { kind: "assembler" as const, key: "inserter", machine: "assembling-machine-2", need: 1, have: 2, add: 0 },
  ];
  const msg = proposalMessage({ rung: { red: 60, green: 60, blue: 0 }, now: { red: 31.2, green: 28, blue: 0 }, deltas: ds, health: [], zh });
  assert.match(msg, /^扩产提案 .*红瓶 60 \/ 绿瓶 60 每分钟; 现在 红 31\.2 \/ 绿 28\.0/);
  assert.match(msg, /机自科技包（红瓶） 的机器 \(组装机2型\): 现 4 台 → 要 7 台, 加 3/);
  assert.match(msg, /炉子 \(钢炉.*现 10 台 → 要 12 台 \(iron-plate 9 \+ copper-plate 4\), 加 2/);
  assert.match(msg, /铁矿 采矿机 \(电力采矿机\): 现 6 台 → 要 8 台, 加 2/);
  assert.equal(msg.includes("inserter"), false, "已够的不列");
  assert.match(msg, /\.\/calc '\{"targets":\{"automation-science-pack":60,"logistic-science-pack":60\}\}'/);
  const stuck = proposalMessage({ rung: { red: 60, green: 60, blue: 0 }, now: { red: 31, green: 28, blue: 0 }, deltas: ds.map((d) => ({ ...d, add: 0 })), health: ["缺料: 石炉 3 台"], zh });
  assert.match(stuck, /瓶颈不在机器数.*体检里的线索: 缺料: 石炉 3 台/);
  assert.match(proposalMessage({ rung: { red: 60, green: 60, blue: 0 }, now: { red: 61, green: 59, blue: 0 }, deltas: ds.map((d) => ({ ...d, add: 0 })), health: [], zh }), /机器齐了、产量也到了/);
});

test("整条链用真实游戏数据算一次 (红绿瓶 60/60, 组装机 2 型 + 钢炉): 有差额、有采矿机", () => {
  const gd = loadGameData();
  const ex = normalizeExisting({ assemblers: { "automation-science-pack": 4, "logistic-science-pack": 4 }, furnaces: 16, drillPerMin: { "iron-ore": 240, "copper-ore": 60 }, tech });
  const p = propose(gd, ex, { red: 31, green: 28, blue: 0 }, null, [], (n) => n);
  assert.deepEqual(p.rung, { red: 60, green: 60, blue: 0 });
  const by = Object.fromEntries(p.deltas.map((d) => [d.key, d]));
  assert.ok(by["automation-science-pack"].need > 4 && by["automation-science-pack"].add > 0, JSON.stringify(by["automation-science-pack"]));
  assert.ok(by["furnace"].need > 0 && by["iron-ore"].need > 0 && by["copper-ore"].need > 0, JSON.stringify(p.deltas));
  assert.equal(p.done, false);
  assert.match(p.message, /^扩产提案/);
});
