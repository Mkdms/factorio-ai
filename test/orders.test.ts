// 不装模组那条路的队列和常驻命令 (commands/orders.ts): 假依赖, 不开游戏; 真游戏上的核对在 test/sandbox/actions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { condLua, IDLE_MS, Scheduler, type Step } from "../commands/orders.ts";
import { venvPython, venvReady } from "../game/offgame/host.ts";

test("条件 Lua 在 Lua 5.2 里编译得过 (要 data/venv 的 lupa, 没有就跳过)", { skip: !venvReady() ? "data/venv 没有 lupa" : false }, () => {
  const snippets = [
    { until: "fuel_below", count: 3, position: { x: 1, y: 2 }, radius: 10 }, { until: "fuel_below", positions: [{ x: 1, y: 2 }] },
    { until: "ammo_below", area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 9, y: 9 } } }, { until: "item_count", item: "coal", at_least: 5 },
    { until: "item_count", item: "coal", below: 5, positions: [{ x: 3, y: 4 }] }, { until: "ghosts_waiting", radius: 30 }, { until: "damaged" },
    { until: "health_below", fraction: 0.3 }, { until: "health_above" }, { until: "no_enemies", position: { x: 0, y: 0 } },
  ].map((w) => condLua(w)!);
  const errs = JSON.parse(execFileSync(venvPython(), ["-I", path.join(import.meta.dirname, "fixtures", "lua_compile.py")], { input: JSON.stringify(snippets), encoding: "utf8", windowsHide: true })) as (string | null)[];
  assert.deepEqual(errs, snippets.map(() => null), JSON.stringify(errs));
});

function world(o: { holds?: Record<string, boolean>; fail?: Set<string> } = {}) {
  let now = 1_000_000, tick = 1000, lastOwn = 0;
  const ran: string[] = [];
  const s = new Scheduler({
    run: async (st: Step) => { ran.push(`${st.action}${st.label ? `:${st.label}` : ""}`); tick += 60; return o.fail?.has(st.action) ? { ok: false, error: "不行" } : { ok: true }; },
    evalLua: async (code: string) => { const u = /fuel_below|ammo_below|ghosts|no_enemies/.exec(code)?.[0] ?? (code.includes("turret_ammo") ? "ammo_below" : code.includes("entity-ghost") ? "ghosts_waiting" : "fuel_below"); return { holds: o.holds?.[u] ?? false, saw: u }; },
    tick: async () => tick,
    lastOwnAction: () => lastOwn,
    now: () => now,
  });
  return { s, ran, advance(ms: number, ticks = Math.round(ms * 0.06)) { now += ms; tick += ticks; }, act() { lastOwn = now; } };
}
const steps = (...names: string[]) => names.map((action) => ({ action, args: {} }));

test("队列: 角色空着 20 秒才跑, 一次一步按顺序; 模型一动手就让出来", async () => {
  const w = world();
  w.act();
  await w.s.call("queue_submit", { steps: steps("move_to", "build", "transfer") });
  await w.s.step();
  assert.deepEqual(w.ran, [], "刚动过手不跑");
  w.advance(IDLE_MS + 1);
  await w.s.step(); await w.s.step();
  assert.deepEqual(w.ran, ["move_to", "build"]);
  w.act();
  await w.s.step();
  assert.deepEqual(w.ran, ["move_to", "build"], "模型又动手了, 等");
  w.advance(IDLE_MS + 1);
  await w.s.step(); await w.s.step();
  assert.deepEqual(w.ran, ["move_to", "build", "transfer"]);
  const st = await w.s.call("queue_status", {});
  assert.equal(st.state, "empty");
  assert.equal((st.history as unknown[]).length, 3);
});

test("队列: on_fail 默认 abort 暂停 (queue_resume 再跑), skip 接着跑; mode replace 换掉; 参数不对报怎么写", async () => {
  const w = world({ fail: new Set(["craft"]) });
  w.advance(IDLE_MS + 1);
  await w.s.call("queue_submit", { steps: [{ action: "craft", args: {}, on_fail: "skip" }, { action: "craft", args: {} }, { action: "mine", args: {} }] });
  for (let i = 0; i < 4; i++) await w.s.step();
  assert.deepEqual(w.ran, ["craft", "craft"], "第二步失败默认暂停");
  assert.match(String((await w.s.call("queue_status", {})).state), /paused/);
  await w.s.call("queue_resume", {});
  await w.s.step();
  assert.deepEqual(w.ran, ["craft", "craft", "mine"]);
  await w.s.call("queue_submit", { steps: steps("build", "build") });
  await w.s.call("queue_submit", { mode: "replace", steps: steps("refuel") });
  assert.equal((await w.s.call("queue_status", {})).pending_count, 1);
  await assert.rejects(w.s.call("queue_submit", {}), /steps/);
  await assert.rejects(w.s.call("queue_submit", { steps: [{ action: "queue_submit" }] }), /不能再是队列命令/);
  await assert.rejects(w.s.call("queue_edit", {}), /mode: replace/);
});

test("queue_repeat: 一轮跑完隔 interval_ticks 再来, times 到了停", async () => {
  const w = world();
  w.advance(IDLE_MS + 1);
  await w.s.call("queue_repeat", { steps: steps("rearm"), interval_ticks: 600, times: 2 });
  await w.s.step();
  await w.s.step();
  assert.deepEqual(w.ran, ["rearm"], "间隔没到");
  w.advance(11_000, 700);
  await w.s.step();
  assert.deepEqual(w.ran, ["rearm", "rearm"]);
  w.advance(11_000, 700);
  await w.s.step();
  assert.deepEqual(w.ran, ["rearm", "rearm"], "两轮了, 停");
});

test("常驻命令: 条件成立才跑 (高优先级先), 跑完冷却; 默认例行到点跑; 连败 3 次关掉; 不认的条件明说", async () => {
  const w = world({ holds: { fuel_below: true, ammo_below: true }, fail: new Set(["feed"]) });
  await w.s.call("order_set", { name: "fuel", priority: 5, when: { until: "fuel_below", count: 5, radius: 20 }, steps: [{ action: "refuel", args: {}, label: "煤" }] });
  await w.s.call("order_set", { name: "ammo", priority: 8, when: { until: "ammo_below", count: 10 }, steps: [{ action: "rearm", args: {}, label: "弹" }] });
  const unknown = await w.s.call("order_set", { name: "rocket", when: { until: "rocket_ready" }, steps: steps("launch") });
  assert.match(String(unknown.warning), /rocket_ready 不会触发/);
  w.advance(IDLE_MS + 1);
  await w.s.step();
  assert.deepEqual(w.ran, ["rearm:弹"], "优先级 8 的先");
  w.advance(11_000, 100);
  await w.s.step();
  assert.deepEqual(w.ran, ["rearm:弹", "refuel:煤"], "弹药那条冷却中, 轮到燃料");
  const list = (await w.s.call("orders", {})).orders as { name: string; state: string; runs: number }[];
  assert.match(list.find((o) => o.name === "ammo")!.state, /cooling/);
  assert.match(list.find((o) => o.name === "rocket")!.state, /不认条件 rocket_ready/);
  assert.equal(list.find((o) => o.name === "fuel")!.runs, 1);
  // 默认例行 (没有 when) 只能一条; 连败 3 次关掉
  await w.s.call("order_set", { name: "routine", steps: steps("feed"), interval_ticks: 60 });
  await assert.rejects(w.s.call("order_set", { name: "routine2", steps: steps("feed") }), /默认例行只能有一条/);
  await w.s.call("order_remove", { name: "fuel" });
  await w.s.call("order_remove", { name: "ammo" });
  for (let i = 0; i < 3; i++) { w.advance(11_000, 100); await w.s.step(); }
  const r = ((await w.s.call("orders", {})).orders as { name: string; state: string }[]).find((o) => o.name === "routine")!;
  assert.match(r.state, /off/);
  await w.s.call("orders_resume", { name: "routine" });
  assert.match(((await w.s.call("orders", {})).orders as { name: string; state: string }[]).find((o) => o.name === "routine")!.state, /ready|next in/);
});

test("条件 → 只读 Lua: 认的七种都给, 参数照模组 (count、position + radius、area、positions、item、at_least / below、fraction); 不认的回 null", () => {
  assert.match(condLua({ until: "fuel_below", count: 3, position: { x: 1, y: 2 }, radius: 10 })!, /position = c, radius = 10[\s\S]*get_fuel_inventory[\s\S]*c < 3/);
  assert.match(condLua({ until: "ammo_below", count: 20, area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 9, y: 9 } } })!, /area = \{\{x=0,y=0\}, \{x=9,y=9\}\}[\s\S]*turret_ammo/);
  assert.match(condLua({ until: "item_count", item: "coal", at_least: 50 })!, /get_item_count\("coal"\)[\s\S]*c >= 50/);
  assert.match(condLua({ until: "item_count", item: "coal", below: 10, positions: [{ x: 3, y: 4 }] })!, /\{\{x=3,y=4\}\}[\s\S]*c < 10/);
  assert.match(condLua({ until: "health_below", fraction: 0.4 })!, /r < 0.4/);
  assert.match(condLua({ until: "no_enemies", radius: 40 })!, /force = "enemy", type = "unit"/);
  assert.match(condLua({ until: "ghosts_waiting" })!, /entity-ghost/);
  assert.match(condLua({ until: "damaged", fraction: 0.8 })!, /m \* 0.8/);
  assert.equal(condLua({ until: "platform_arrived" }), null);
});
