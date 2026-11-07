// 真实基地画成字符图 + 结构读数 (src/play/layout-study.ts): 用一小块假蓝图核几何; 规则用假数据, 不依赖本机游戏导出
import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksOf, nearBlock, overview, placeAll, readFacts, study, studyText } from "../src/play/layout-study.ts";
import { resolveKey, surfaceFor, surfaceZh, type WorldIndex } from "../src/play/bp-study.ts";
import type { BpEntity } from "../src/blueprint/inspect.ts";
import type { Rules } from "../src/blueprint/rules.ts";

const rule = (type: string, half: number) => ({ type, box: [-half, -half, half, half] });
const table: Record<string, unknown> = {
  "assembling-machine-2": rule("assembling-machine", 1.5), "transport-belt": rule("transport-belt", 0.5), inserter: rule("inserter", 0.5),
  "long-handed-inserter": rule("inserter", 0.5), "small-electric-pole": rule("electric-pole", 0.5), "stone-furnace": rule("furnace", 1),
};
const rules = { get: (n: string) => table[n], version: "测试" } as unknown as Rules;
let n = 0;
const ent = (name: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ entity_number: ++n, name, position: { x, y }, ...extra }) as unknown as BpEntity;

// 两台铜缆机 (y=0) 用机械臂直接塞进下面两台电路机 (y=4); 电路机再从下面一条带 (y=7) 贴带取铁板, 长臂隔一格放到更下面的带 (y=8)
const base = [
  ent("assembling-machine-2", 1.5, 0.5, { recipe: "copper-cable" }), ent("assembling-machine-2", 4.5, 0.5, { recipe: "copper-cable" }),
  ent("inserter", 1.5, 2.5), ent("inserter", 4.5, 2.5),
  ent("assembling-machine-2", 1.5, 4.5, { recipe: "electronic-circuit" }), ent("assembling-machine-2", 4.5, 4.5, { recipe: "electronic-circuit" }),
  ent("inserter", 0.5, 6.5, { direction: 8 }), ent("inserter", 3.5, 6.5, { direction: 8 }),
  ent("long-handed-inserter", 1.5, 6.5), ent("long-handed-inserter", 4.5, 6.5),
  ...[0, 1, 2, 3, 4, 5].map((x) => ent("transport-belt", x + 0.5, 7.5, { direction: 4 })),
  ...[0, 1, 2, 3, 4, 5].map((x) => ent("transport-belt", x + 0.5, 8.5, { direction: 4 })),
];
const placed = placeAll(base, rules);

test("分区图: 每格写这一片最多的线, 只有带子和别的分开写, 格子放不下翻倍", () => {
  const many = placeAll([
    ...[0, 4, 8].map((x) => ent("assembling-machine-2", x + 1.5, 1.5, { recipe: "copper-cable" })), ent("assembling-machine-2", 13.5, 1.5, { recipe: "pipe" }), // 同一格: 铜缆 3 台比水管 1 台多
    ent("assembling-machine-2", 33.5, 1.5, { recipe: "pipe" }), // 隔一格
    ent("transport-belt", 50.5, 1.5, { direction: 4 }), // 只有带子
    ent("small-electric-pole", 1.5, 17.5), // 下一行只有杆
    ent("stone-wall", 900.5, 900.5), // 外圈: 不撑大范围
  ], { ...rules, get: (n: string) => (n === "stone-wall" ? rule("wall", 0.5) : table[n]) } as unknown as Rules);
  const zh = (id: string) => ({ "copper-cable": "铜缆", pipe: "水管" } as Record<string, string>)[id];
  const o = overview(many, zh);
  assert.equal(o.cell, 16);
  assert.deepEqual(o.origin, [-32, -32], "有机器的那片外面留一圈");
  const rows = o.map.split("\n");
  assert.equal(rows[2], "  a b-", "铜缆 a, 隔一格水管 b, 只有带子 -");
  assert.equal(rows[3], "  ,", "只有杆");
  assert.equal(rows.length, 5, "外圈的墙不进图");
  assert.match(o.legend, /a=铜缆 3/);
  assert.match(o.legend, /b=水管 2/);
  assert.match(o.facts.join(" "), /机器 5 台 2 种线, 带子 1 件, 机械臂 0, 电线杆 1/);
  assert.match(o.facts.join(" "), /每个字符 16×16 格/);
  assert.equal(overview(many, zh, { maxW: 2, maxH: 2 }).cell, 64, "放不下就翻倍");
  // 全世界的坐标: 负的左上角也不会串格
  const far = placeAll([ent("assembling-machine-2", -320.5, -640.5, { recipe: "pipe" }), ent("assembling-machine-2", -300.5, -640.5, { recipe: "pipe" })], rules);
  assert.ok(overview(far, zh).map.includes("a"));
});

test("块周围的东西: 全星球几万件时只算这一片", () => {
  const b = blocksOf(placed, "copper-cable")[0];
  assert.equal(nearBlock(placed, b, 40).length, placed.length, "都在范围里");
  assert.ok(nearBlock(placed, b, 0).length < placed.length, "范围小就少");
  const s0 = study(placed, b, (id) => id), s1 = study(nearBlock(placed, b, 40), b, (id) => id);
  assert.equal(s0.map, s1.map, "字符图一样");
  assert.deepEqual(s0.facts, s1.facts, "读数一样");
});

test("看哪个地表: 机器最多的, 一样多优先新地星; 可以指定 (内部名或中文名); 没有 null", () => {
  const idx: WorldIndex = { hours: 219, surfaces: [], keys: { "iron-plate": { vulcanus: 50, nauvis: 10 }, pipe: { gleba: 4, nauvis: 4 }, "rocket-fuel": { "platform-3": 2 } } };
  assert.equal(surfaceFor(idx, "iron-plate"), "vulcanus");
  assert.equal(surfaceFor(idx, "pipe"), "nauvis");
  assert.equal(surfaceFor(idx, "iron-plate", "nauvis"), "nauvis");
  assert.equal(surfaceFor(idx, "iron-plate", "新地星"), "nauvis");
  assert.equal(surfaceFor(idx, "iron-plate", "雷神星"), null, "这个星球没有");
  assert.equal(surfaceFor(idx, "没有这个"), null);
  assert.equal(surfaceFor(idx, "rocket-fuel", "太空平台"), "platform-3");
  assert.equal(surfaceZh("platform-3"), "太空平台 3");
});

test("同一配方挨着的聚成一段, 主角永远是 a, 机器中间写字母", () => {
  const bs = blocksOf(placed, "electronic-circuit");
  assert.equal(bs.length, 1);
  assert.equal(bs[0].machines.length, 2);
  const s = study(placed, bs[0], (id) => ({ "electronic-circuit": "电路板", "copper-cable": "铜缆" })[id]);
  assert.match(s.legend, /a=电路板/);
  assert.match(s.legend, /b=铜缆/);
  assert.match(s.map, /#a##a#/);
  assert.match(s.map, />>>>>>/);
  assert.equal(s.machines, 2);
});

test("机械臂方向: 箭头 = 货走的方向 (direction 是取货方向)", () => {
  const s = study(placed, blocksOf(placed, "electronic-circuit")[0], () => undefined);
  const rows = s.map.split("\n");
  assert.ok(rows.some((r) => r.includes("↓")), "铜缆塞进电路: 往下");
  assert.ok(rows.some((r) => r.includes("↑")), "贴带取料: 往上");
  assert.ok(rows.some((r) => r.includes("⇓")), "长臂放到下面的带: 往下");
});

test("读数: 直塞、贴带、长臂、出料, 一条带喂几台都是算出来的", () => {
  const f = readFacts(placed, blocksOf(placed, "electronic-circuit")[0]).join("; ");
  assert.match(f, /这种机器 2 台/);
  assert.match(f, /进料带 1 条, 分别喂 2 台/);
  assert.match(f, /贴带取 2/);
  assert.match(f, /上一台机器直接塞 2/);
  assert.match(f, /放上带 2/);
});

test("块太大只切一段, 说得清画了几台; 整段文字带图例和读数", () => {
  const many = placeAll(Array.from({ length: 30 }, (_, i) => ent("assembling-machine-2", 1.5 + i * 3, 0.5, { recipe: "iron-gear-wheel" })), rules);
  const s = study(many, blocksOf(many, "iron-gear-wheel")[0], () => "铁齿轮", { maxW: 30, maxH: 10 });
  assert.equal(s.width, 30);
  assert.ok(s.machines < 30);
  const t = studyText("头", s, "尾");
  assert.match(t, /^头\n/);
  assert.match(t, /读数: /);
  assert.match(t, /尾$/);
});

test("名字: 内部名、官方名、官方名的一部分都认, 选机器多的", () => {
  const keys = new Map([["logistic-science-pack", 18], ["electronic-circuit", 49], ["advanced-circuit", 67]]);
  const zh = new Map([["logistic-science-pack", "物流科技包（绿瓶）"], ["electronic-circuit", "电路板"], ["advanced-circuit", "集成电路"]]);
  assert.equal(resolveKey("electronic-circuit", keys, zh), "electronic-circuit");
  assert.equal(resolveKey("电路板", keys, zh), "electronic-circuit");
  assert.equal(resolveKey("绿瓶", keys, zh), "logistic-science-pack");
  assert.equal(resolveKey("电路", keys, zh), "advanced-circuit");
  assert.equal(resolveKey("不存在", keys, zh), null);
});

