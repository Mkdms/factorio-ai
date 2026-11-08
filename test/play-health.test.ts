// 基地体检的结果整理 (src/play/health.ts; 不开游戏)
import test from "node:test";
import assert from "node:assert/strict";
import { healthLines, normalizeHealth, type Health } from "../src/play/health.ts";

// Lua 空表经 helpers.table_to_json 出来是 {} (第八轮: 场上没虚影时监工体检崩了 "object is not iterable")
const fromLua = JSON.parse(`{"tick":1,"ghosts":{},"noFuel":{},"depleted":{},"labs":{"total":16,"working":0,"missingPacks":16},
  "full":{},"short":{},"noPower":0,"obstacles":{"count":0,"at":{},"box":""},"belt_ends":{}}`) as Health;

test("空表规整成数组, 体检照常出清单", () => {
  const h = normalizeHealth(fromLua);
  for (const k of ["ghosts", "noFuel", "depleted", "belt_ends"] as const) assert.ok(Array.isArray(h[k]), k);
  assert.ok(Array.isArray(h.obstacles.at));
  assert.doesNotThrow(() => { for (const _ of h.ghosts) { /* run.ts 就是这样遍历的 */ } });
  assert.deepEqual(healthLines(h, h.ghosts), ["研究中心 16 台只有 0 台在工作 (16 台缺瓶)"]);
});

test("非空列表原样保留", () => {
  const h = normalizeHealth({ ...fromLua, noFuel: ["stone-furnace(-13.0,-64.0)"], ghosts: [{ key: "k", name: "pipe", at: "1,2" }] });
  assert.equal(h.noFuel.length, 1);
  assert.equal(h.ghosts[0].name, "pipe");
});

test("缺字段也不崩", () => {
  const h = normalizeHealth({ tick: 1, labs: { total: 0, working: 0, missingPacks: 0 }, noPower: 0 } as unknown as Health);
  assert.deepEqual(healthLines(h, h.ghosts), []);
});

test("清单里的内部名换成官方中文名", () => {
  const names = new Map([["stone-furnace", "石炉"], ["pipe", "管道"], ["coal", "煤矿"], ["iron-ore", "铁矿"], ["iron-gear-wheel", "铁齿轮"]]);
  const zh = (n: string) => names.get(n) ?? n;
  const h = normalizeHealth({ ...fromLua, labs: { total: 0, working: 0, missingPacks: 0 }, noFuel: ["stone-furnace(-13.0,-64.0)"], short: { "iron-gear-wheel": 2 },
    belt_ends: [{ at: "1,2", items: "coal*5, iron-ore*3", mixed: true }] });
  const text = healthLines(h, [{ name: "pipe", at: "3,4" }], zh).join("\n");
  for (const s of ["管道(3,4)", "石炉(-13.0,-64.0)", "铁齿轮 2 台", "煤矿*5, 铁矿*3"]) assert.ok(text.includes(s), `${s} 不在: ${text}`);
  assert.ok(!/stone-furnace|iron-gear-wheel/.test(text));
});

test("标了红叉、没有建设机器人的树石要报", () => {
  const h = normalizeHealth({ ...fromLua, labs: { total: 0, working: 0, missingPacks: 0 }, marked: { count: 37, at: ["70.4,43.8"], bots: 0 } });
  assert.match(healthLines(h).join("\n"), /红叉的树 \/ 石头 37 个/);
  const withBots = normalizeHealth({ ...fromLua, labs: { total: 0, working: 0, missingPacks: 0 }, marked: { count: 37, at: [], bots: 5 } });
  assert.deepEqual(healthLines(withBots), []);
});

test("一直没修的问题: 同一类连报 3 次点名, 15 分钟内不重复, 修好了重新数", async () => {
  const { StuckHealth, healthCategory, healthOwner } = await import("../src/play/health.ts");
  assert.equal(healthCategory("缺燃料 4 台: 石炉(-25.0,-29.0)"), "缺燃料");
  assert.equal(healthCategory("研究中心 11 台只有 0 台在工作 (11 台缺瓶)"), "研究中心");
  assert.equal(healthCategory("缺料: 炉子 10 台; 同时出口堵满: 炉子 53 台"), "缺料");
  assert.equal(healthOwner("缺料: 炉子 10 台"), "science");
  assert.equal(healthOwner("采矿机采空 16 台: (-7.0,-53.0)"), "base");
  const s = new StuckHealth();
  const m = 60_000;
  assert.deepEqual(s.update(["缺燃料 22 台: …", "采矿机采空 18 台: …"], 0), []);
  assert.deepEqual(s.update(["缺燃料 10 台: …", "采矿机采空 16 台: …"], 5 * m), []);
  const third = s.update(["缺燃料 4 台: …", "采矿机采空 16 台: …", "缺电 8 台"], 10 * m);
  assert.deepEqual(third.map((x) => [x.line, x.times]), [["缺燃料 4 台: …", 3], ["采矿机采空 16 台: …", 3]]); // 数量变了也算同一类没修好
  assert.deepEqual(s.update(["缺燃料 4 台: …"], 15 * m), []); // 15 分钟内不重复点名; 采空这次没报 → 重新数
  assert.deepEqual(s.update(["缺燃料 4 台: …"], 25 * m).map((x) => x.times), [5]);
  assert.deepEqual(s.update(["采矿机采空 16 台: …"], 30 * m), []);
});
