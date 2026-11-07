// 实验框架的防线本身也要有测试:
// 喂三个故意写错的假实验, 防线必须拦住 / 记下。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Experiment } from "../../src/verify/types.ts";
import { runExperiments } from "../../src/verify/runner.ts";

const fake = (id: string, run: Experiment["run"], extra: Partial<Experiment> = {}): { exp: Experiment; file: string } => ({
  exp: { id, topic: "框架", claim: "故意写错的假实验", refs: [], sources: [], run, ...extra },
  file: "test/sandbox/guards.test.ts",
});

test("防线: 前置不够 (锅炉没水) 不测量; 出结论前查布局; 场地外新建会被记下", async () => {
  const recs = await runExperiments(
    [
      fake("guard.preflight.boiler-without-water", async (ctx) => {
        await ctx.power();
        await ctx.lua(`local a = ... local b = lab.place{surface = game.surfaces[a.surface], name = "boiler", position = {a.x, a.y}, direction = defines.direction.north, force = "player"}
          lab.insert(b, {name = "coal", count = 5}) return true`);
        await ctx.ticks(60);
        await ctx.powered();
        return { verdict: "verified", summary: "不该走到这里", measured: {} };
      }),
      fake("guard.layout.inserter-at-nothing-without-powered", async (ctx) => {
        await ctx.lua(`local a = ... lab.place{surface = game.surfaces[a.surface], name = "burner-inserter", position = {a.x + 0.5, a.y + 0.5}, force = "player"} return true`);
        return { verdict: "verified", summary: "没调 ctx.powered() 也该被出结论前的布局检查拦下", measured: {} };
      }),
      fake("guard.leak.built-outside-area", async (ctx) => {
        await ctx.lua(`local a = ... lab.place{surface = game.surfaces[a.surface], name = "iron-chest", position = {a.x + 0.5, a.y + 30.5}, force = "player"} return true`);
        await ctx.powered();
        return { verdict: "verified", summary: "箱子建在登记场地外", measured: {} };
      }),
    ],
    { write: false, view: false, name: "test-guards", log: () => undefined },
  );
  const [pre, layout, leak] = recs;
  assert.equal(pre.verdict, "inconclusive");
  assert.match(pre.summary, /开测前机器状态不对/);
  assert.equal(layout.verdict, "inconclusive");
  assert.match(layout.summary, /出结论时布局检查不过/);
  assert.ok((leak.leaks?.outside ?? 0) >= 1, `场地外新建没记下: ${JSON.stringify(leak.leaks)}`);
});
