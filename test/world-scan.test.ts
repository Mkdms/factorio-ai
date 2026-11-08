// 开班扫描 (src/play/world-scan.ts): 读数 → 现状 / 判断 / 规划
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeScan, normalizeScan, stageOf, type ScanRaw } from "../src/play/world-scan.ts";
import type { Existing } from "../src/play/expand.ts";

const zh = (n: string) => ({ "automation-science-pack": "自动化科技包", "iron-ore": "铁矿", "assembling-machine-2": "组装机 2 型", "electric-mining": "电力采矿" } as Record<string, string>)[n] ?? n;
const existing: Existing = { assemblers: { "automation-science-pack": 3, "iron-gear-wheel": 4 }, furnaces: 49, drillPerMin: { "iron-ore": 390 }, tech: { automation2: true, steelFurnace: true, electricFurnace: true, oil: false, electricDrill: true } };
const raw: ScanRaw = { tick: 2813350, researched: 70, research: "", queue: [], labs: { total: 11, working: 2 }, rates: { red: 2.6, green: 8.3, blue: 0 }, rockets: 0, silos: 0, surfaces: ["nauvis"], players: 1, entities: 3000 };

test("虫子和防御: 关和平、污染到虫巢、炮塔不够才说最先解决; 和平或老读数不说", () => {
  const raw = (enemy?: unknown) => normalizeScan({ tick: 216000, rates: {}, labs: { total: 0, working: 0 }, ...(enemy ? { enemy } : {}) });
  const input = (r: ScanRaw) => ({ raw: r, existing: { assemblers: {}, furnaces: 0, drillPerMin: {}, tech: {} } as never, health: [], rung: { red: 30, green: 30, blue: 0 } as never, deltas: [], reached: false, seats: 1, zh: (x: string) => x });
  const open = composeScan(input(raw({ peaceful: false, nests: 2, nearest: 100, x: -76, y: -174, polluted: 19, turrets: 1 })));
  assert.ok(open.lines.some((l) => /和平模式关着.*虫巢 2 个.*最近 100 格.*污染已碰到它.*炮塔 1 座/.test(l)), open.lines.join("\n"));
  assert.ok(open.judgement.some((l) => /最先要解决/.test(l) && /炮塔只有 1 座/.test(l)));
  // 开班和平那段时间读到和平开着, 但世界是有虫子的: 还是要说, 带上还剩多久
  const grace = composeScan({ ...input(raw({ peaceful: true, nests: 2, nearest: 100, x: -76, y: -174, polluted: 19, turrets: 1 })), peaceMinutes: 10 });
  assert.ok(grace.lines.some((l) => /和平模式还开着, 10 分钟后自动关/.test(l)), grace.lines.join("\n"));
  assert.ok(grace.judgement.some((l) => /有虫子 \(和平还剩 10 分钟\).*最先要解决/.test(l)), grace.judgement.join("\n"));
  const safe = composeScan(input(raw({ peaceful: true, nests: 2, nearest: 100, polluted: 19, turrets: 1 })));
  assert.ok(safe.lines.some((l) => /和平模式开着/.test(l)));
  assert.ok(!safe.judgement.some((l) => /炮塔/.test(l)));
  assert.ok(composeScan(input(raw({ peaceful: false, nests: 20, nearest: 146, polluted: 0, turrets: 2 }))).judgement.some((l) => /最先要解决/.test(l)), "污染读到 0 但虫巢很近也要说 (实测第 4 分钟就被啃)");
  assert.ok(!composeScan(input(raw({ peaceful: false, nests: 2, nearest: 400, polluted: 0, turrets: 0 }))).judgement.some((l) => /炮塔/.test(l)), "又远污染又没碰到才不说");
  assert.ok(!composeScan(input(raw({ peaceful: false, nests: 2, nearest: 100, polluted: 9, turrets: 20 }))).judgement.some((l) => /炮塔/.test(l)), "炮塔够了不说");
  assert.ok(!composeScan(input(raw())).lines.some((l) => /敌人/.test(l)), "老读数没有这一行");
});

test("normalizeScan: 缺字段不崩", () => {
  const n = normalizeScan({ tick: "x", rates: { red: 1 }, queue: [1, "a"] });
  assert.deepEqual([n.tick, n.rates.red, n.rates.green, n.queue, n.labs], [0, 1, 0, ["a"], { total: 0, working: 0 }]);
});

test("阶段判断按产量和里程碑", () => {
  assert.equal(stageOf(raw, existing), "绿瓶阶段");
  assert.equal(stageOf({ ...raw, rates: { red: 5, green: 5, blue: 3 } }, existing), "蓝瓶已自动化");
  assert.match(stageOf(raw, { ...existing, tech: { ...existing.tech, oil: true } }), /蓝瓶在起步/);
  assert.equal(stageOf({ ...raw, rockets: 2 }, existing), "已发射火箭, 准备太空");
  assert.match(stageOf({ ...raw, surfaces: ["nauvis", "platform-1"] }, existing), /太空时代/);
  assert.equal(stageOf({ ...raw, researched: 2, entities: 50, rates: { red: 0, green: 0, blue: 0 } }, existing), "刚开局");
});

test("composeScan: 现状 5 行、判断里点出研究中心停着和燃料、规划里先修 + 下一档 + 分工; markdown 三节", () => {
  const sc = composeScan({ raw, existing, health: ["缺燃料: 锅炉 2 台", "出口堵满: 炉子 23 台"], rung: { red: 30, green: 30, blue: 0 }, deltas: [{ kind: "assembler", key: "automation-science-pack", machine: "assembling-machine-2", need: 4, have: 3, add: 1 }], reached: false, seats: 4, zh }, "2026-11-04T09:36:00.000Z");
  assert.equal(sc.lines.length, 5);
  assert.match(sc.lines[0], /^游戏时间 13 小时 1 分; 已研究 70 项, 正在研究 无, 队列空; 研究中心 2\/11 在工作$/);
  assert.match(sc.lines[1], /红 2\.6 \/ 绿 8\.3 \/ 蓝 0\.0/);
  assert.match(sc.lines[2], /组装机 7 台 \(铁矿|自动化科技包 3/);
  assert.equal(sc.stage, "绿瓶阶段");
  assert.ok(sc.judgement.some((l) => l.includes("研究中心一半以上停着 (2/11)")));
  assert.ok(sc.judgement.some((l) => l.includes("没有在研究的科技")));
  assert.ok(sc.judgement.some((l) => l.startsWith("燃料问题")));
  assert.deepEqual(sc.plan.slice(0, 2), ["先修 1: 缺燃料: 锅炉 2 台", "先修 2: 出口堵满: 炉子 23 台"]);
  assert.ok(sc.plan.includes("目标 (下一档): 红瓶 30 / 绿瓶 30 每分钟"));
  assert.ok(sc.plan.includes("加 自动化科技包 的机器 (组装机 2 型): 3 → 4 台"));
  assert.match(sc.plan.at(-1)!, /^分工建议 \(4 人\): 角色 1: 先修.*角色 4\+/);
  assert.match(sc.summary, /^绿瓶阶段; 红 2\.6/);
  assert.match(sc.md, /^# 开班扫描 \(2026-11-04 09:36 读的/);
  for (const h of ["## 现状", "## 判断", "## 规划"]) assert.ok(sc.md.includes(h), h);
  const one = composeScan({ raw, existing, health: [], rung: { red: 30, green: 30, blue: 0 }, deltas: [], reached: true, seats: 1, zh });
  assert.ok(!one.plan.some((l) => l.startsWith("分工建议")), "一个人不写分工");
  assert.ok(one.judgement.some((l) => l.includes("已达到")));
  assert.deepEqual(one.hints, []);
  assert.ok(!one.md.includes("## 相关要点"), "没给 hintsFor 就没有这一节");
});

test("composeScan: 相关要点按判断 / 规划 / 体检的句子挑 (hintsFor), 写进 markdown 的'相关要点'一节", () => {
  const seen: string[][] = [];
  const sc = composeScan({ raw, existing, health: ["缺燃料: 锅炉 2 台"], rung: { red: 30, green: 30, blue: 0 }, deltas: [{ kind: "furnace", key: "stone-furnace", machine: "stone-furnace", have: 12, need: 20, add: 8, note: "铁板" }], reached: false, seats: 2, zh,
    hintsFor: (ls) => { seen.push(ls); return ls.some((l) => /燃料/.test(l)) ? ["燃料不手补 (P-ops-fuel)", "蓝图库里有实测过的块: 1. 冶炼列"] : []; } });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].some((l) => l.startsWith("加炉子: 12 → 20 台")) && seen[0].includes("缺燃料: 锅炉 2 台"), "判断 + 规划 + 体检都给了");
  assert.deepEqual(sc.hints, ["燃料不手补 (P-ops-fuel)", "蓝图库里有实测过的块: 1. 冶炼列"]);
  assert.match(sc.md, /## 相关要点 \(我们核实过的经验.*\n- 燃料不手补 \(P-ops-fuel\)\n- 蓝图库里有实测过的块: 1\. 冶炼列\n/);
});
