import test from "node:test";
import assert from "node:assert/strict";
import { ASSEMBLER_ROW_SPACE, better, coupledNeighbors, keyOf, neighbors, randomSpec, restrict, rng, score, tierCost, type Measured } from "../src/search/hillclimb.ts";

const base = { recipe: "iron-gear-wheel", machine: "assembling-machine-2", inserter: "inserter", belt: "transport-belt", per_input: 1, out: 1, layout: "single", n: 8 };
const m = (o: Partial<Measured>): Measured => ({ outPerMin: 0, tiles: 100, powerMW: 1, efficiency: 1, trend: 1, ...o });

test("邻居: 每个参数各改一格, 列表到头不越界, 台数 ±1 和 ±四分之一", () => {
  const nb = neighbors(base, ASSEMBLER_ROW_SPACE);
  const changed = nb.map((s) => Object.keys(s).filter((k) => s[k] !== (base as Record<string, unknown>)[k]));
  assert.ok(changed.every((c) => c.length === 1), "一次只改一个参数");
  assert.deepEqual(nb.filter((s) => s.inserter !== base.inserter).map((s) => s.inserter), ["fast-inserter"]); // 最低档没有更低
  assert.deepEqual(nb.filter((s) => s.machine !== base.machine).map((s) => s.machine).sort(), ["assembling-machine-1", "assembling-machine-3"]);
  assert.deepEqual(nb.filter((s) => s.n !== base.n).map((s) => s.n).sort((a, b) => Number(a) - Number(b)), [6, 7, 9, 10]);
  assert.equal(nb.filter((s) => s.per_input !== 1).length, 1);
});

test("固定的参数不动; 限定取值 (科技上限) 只留允许的", () => {
  assert.ok(neighbors(base, ASSEMBLER_ROW_SPACE, ["layout", "n"]).every((s) => s.layout === "single" && s.n === 8));
  const sp = restrict(ASSEMBLER_ROW_SPACE, { machine: ["assembling-machine-1", "assembling-machine-2"], n: [2, 12] });
  const nb = neighbors(base, sp);
  assert.ok(!nb.some((s) => s.machine === "assembling-machine-3"));
  assert.deepEqual(sp.n, { min: 2, max: 12 });
  assert.throws(() => restrict(ASSEMBLER_ROW_SPACE, { belt: ["no-such-belt"] }));
});

test("打分: 达标的比占地, 没达标的比产量, 在往堵走的当没达标, 出错最差", () => {
  const T = 600;
  const small = score(m({ outPerMin: 600, tiles: 80 }), T), big = score(m({ outPerMin: 900, tiles: 120 }), T);
  assert.ok(better(small, big), "都达标: 占地小的好");
  assert.ok(better(big, score(m({ outPerMin: 500, tiles: 10 }), T)), "达标胜过没达标");
  assert.ok(better(score(m({ outPerMin: 500 }), T), score(m({ outPerMin: 400 }), T)), "没达标: 产量高的好");
  assert.ok(better(score(m({ outPerMin: 590 }), T)[0] === 1 ? [1] : [0], [0]), "差 2% 以内算达标");
  assert.equal(score(m({ outPerMin: 700, trend: 0.8 }), T)[0], 0, "趋势 < 0.9 不算达标");
  assert.ok(better(score(m({ outPerMin: 1 }), T), score(m({ error: "放不下" }), T)));
  assert.ok(!better([1, -80, -1], [1, -80, -1]), "相等不算更好");
});

test("缓存键和参数顺序无关", () => {
  assert.equal(keyOf({ a: 1, b: "x" }), keyOf({ b: "x", a: 1 }));
});

test("联动邻居: 换机器档按速度比例调台数, 单 / 双排保持总台数", () => {
  const speeds = { "assembling-machine-1": 0.5, "assembling-machine-2": 0.75, "assembling-machine-3": 1.25 };
  const nb = coupledNeighbors({ ...base, n: 7 }, ASSEMBLER_ROW_SPACE, speeds);
  assert.deepEqual(nb.find((s) => s.machine === "assembling-machine-3")?.n, 5); // 7 × 0.75 / 1.25 = 4.2 → 5
  assert.deepEqual(nb.find((s) => s.machine === "assembling-machine-1")?.n, 11); // 7 × 0.75 / 0.5 = 10.5 → 11
  assert.deepEqual(nb.find((s) => s.layout === "double")?.n, 4);
  assert.deepEqual(coupledNeighbors({ ...base, layout: "double", n: 4 }, ASSEMBLER_ROW_SPACE, speeds).find((s) => s.layout === "single")?.n, 8);
  assert.equal(coupledNeighbors(base, ASSEMBLER_ROW_SPACE, speeds, ["n"]).length, 0, "台数固定就没有联动");
});

test("打分平局: 耗电差在 0.1MW 以内不算数, 选档位低 (便宜) 的", () => {
  const red = { ...base, belt: "fast-transport-belt" }, blue = { ...base, belt: "express-transport-belt" };
  assert.equal(tierCost(blue, ASSEMBLER_ROW_SPACE) - tierCost(red, ASSEMBLER_ROW_SPACE), 1);
  const sRed = score(m({ outPerMin: 600, tiles: 98, powerMW: 1.881 }), 600, tierCost(red, ASSEMBLER_ROW_SPACE));
  const sBlue = score(m({ outPerMin: 600, tiles: 98, powerMW: 1.880 }), 600, tierCost(blue, ASSEMBLER_ROW_SPACE));
  assert.ok(better(sRed, sBlue));
});

test("随机重启的起点: 可复现、在参数空间内、固定的不动、台数按机器速度换算", () => {
  const speeds = { "assembling-machine-1": 0.5, "assembling-machine-2": 0.75, "assembling-machine-3": 1.25 };
  const a = Array.from({ length: 20 }, (_, i) => randomSpec({ ...base, n: 10 }, ASSEMBLER_ROW_SPACE, speeds, rng(i), ["layout"]));
  const b = Array.from({ length: 20 }, (_, i) => randomSpec({ ...base, n: 10 }, ASSEMBLER_ROW_SPACE, speeds, rng(i), ["layout"]));
  assert.deepEqual(a, b, "同一个种子同样的起点");
  for (const s of a) {
    assert.equal(s.layout, "single");
    assert.ok((ASSEMBLER_ROW_SPACE.inserter as { values: string[] }).values.includes(String(s.inserter)));
    assert.ok(Number(s.per_input) >= 1 && Number(s.per_input) <= 3);
    assert.equal(s.n, Math.ceil((10 * 0.75) / speeds[s.machine as keyof typeof speeds] - 1e-9));
  }
  assert.ok(new Set(a.map((s) => s.machine)).size > 1, "起点要散开");
});
