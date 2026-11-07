// 读内存的世界数据和真值怎么比 (game/memory/world-compare.ts); 真游戏上跑的是 test/sandbox/memory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRelations, compareSelfCheck, compareWorld, type SelfCheck, type WorldMem, type WorldTruth } from "../game/memory/world-compare.ts";

const truth = (over: Partial<WorldTruth> = {}): WorldTruth => ({
  tick: 100, ticks_played: 120,
  research: { current: "automation", progress: 0.5, queue: ["automation", "logistics"] },
  techs: { automation: { researched: false, enabled: true, level: 1 } },
  modifiers: { laboratory_speed_modifier: 0.2 },
  evolution: 0.1, pollution: 50,
  stats: { items: { input: { coal: 5 }, output: {}, flows: { one_minute: { "input:coal": { avg: 5, count: 5 } } } } },
  ...over,
});
const mem = (): WorldMem => ({
  tick: 100, update_tick: 125, ticks_played: 125,
  forces: {
    player: { research: { current: "automation", progress: 0.5, queue: ["automation", "logistics"] }, technologies: { automation: { enabled: true, count: 0 } }, modifiers: { laboratory_speed_modifier: 0.2 }, items: { input: { coal: 5 }, output: {}, storage: {}, precisions: [] } },
    enemy: { evolution: { factor: 0.1 } },
  },
  pollution: { total: 50 },
});

test("世界数据: 全对时没有差异; ticks_played 暂停时也走, 不比", () => {
  const w = compareWorld(truth(), mem());
  assert.deepEqual(w.diffs, []);
  assert.ok(w.total >= 8);
});

test("世界数据: 研究、队列、统计累计对不上要报出来", () => {
  const m = mem();
  m.forces.player.research = { current: "logistics", progress: 0.5, queue: ["logistics"] };
  m.forces.player.items = { input: { coal: 6 }, output: {}, storage: {}, precisions: [] };
  const w = compareWorld(truth(), m);
  const names = w.diffs.map((d) => d[0]);
  assert.ok(names.includes("research.current"));
  assert.ok(names.includes("research.queue"));
  assert.ok(names.includes("items.input.coal"));
});

test("世界数据: 可见 = 探图时间在迷雾时间内", () => {
  const m = mem();
  m.forces.player.chart = { charted: [[0, 0, 95], [1, 0, 10]], fog_timeout: 50 };
  assert.deepEqual(compareWorld(truth({ charted: ["0,0", "1,0"], visible: ["0,0"] }), m).diffs, []);
  assert.equal(compareWorld(truth({ charted: ["0,0", "1,0"], visible: ["1,0"] }), m).diffs.length, 1);
});

test("世界数据: 电网取接着东西最多的那个, 只有一根杆的小网不算", () => {
  const m = mem();
  const flow = (input: Record<string, number>) => ({ input, output: {}, storage: {}, precisions: [] });
  m.networks = { "25": { flow: flow({}) }, "4": { flow: flow({ lab: 7 }) } };
  assert.deepEqual(compareWorld(truth({ stats: { electric: { input: { lab: 7 }, output: {}, flows: {} } } }), m).diffs, []);
});

test("假接口自查: 统计按千分之二容差, 科技逐项", () => {
  const got = (avg: number, researched = false): SelfCheck => ({ techs: { automation: { researched, enabled: true, level: 1 } }, flows: { items: { one_minute: { "input:coal": { avg, count: 5 } } } } });
  assert.deepEqual(compareSelfCheck(truth(), got(5.005)).diffs, []);
  assert.deepEqual(compareSelfCheck(truth(), got(5.2)).diffs.map((d) => d[0]), ["items.one_minute.input:coal.avg"]);
  assert.deepEqual(compareSelfCheck(truth(), got(5, true)).diffs.map((d) => d[0]), ["tech.automation.researched"]);
});

test("带子关系: 空表、false、nil 都算没有; 邻居列表逐个比", () => {
  const t = truth({ relations: { "1,1": { ins: {}, outs: ["2,1"], shape: "straight" }, "3,1": { pick: false, drop: "4,1", px: 3 } } });
  const same: SelfCheck = { techs: {}, flows: {}, relations: { "1,1": { ins: [], outs: ["2,1"], shape: "straight" }, "3,1": { drop: "4,1", px: 3 } } };
  assert.deepEqual(compareRelations(t, same).diffs, []);
  const wrong: SelfCheck = { techs: {}, flows: {}, relations: { "1,1": { ins: ["0,1"], outs: ["2,1"], shape: "left" }, "3,1": { drop: "4,1", px: 3.5 } } };
  assert.deepEqual(compareRelations(t, wrong).diffs.map((d) => d[0]).sort(), ["1,1.ins", "1,1.shape", "3,1.px"]);
});
