// 沙盘集成测试: 要本机装有 Factorio (FACTORIO_DIR)。npm run test:sandbox
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SandboxServer } from "../../game/sandbox/server.ts";
import { demoBlueprint } from "../../game/sandbox/demo.ts";

// 回归测试反复起停实例, 不开可视化窗口 (实验和演示才开)
const lab = new SandboxServer({ name: "test-sandbox", view: false });

before(async () => {
  await lab.createMap("t", { seed: 42 });
  await lab.start("t");
});
after(() => lab.stop({ save: false }));

test("RCON 和 UDP 两条通道都能调模组", async () => {
  const a = (await lab.rpc("ping")) as { mod: string; udp: boolean };
  assert.equal(a.mod, "0.1.0");
  assert.equal(a.udp, true);
  const b = (await lab.rpc("ping", {}, { via: "udp" })) as { mod: string };
  assert.equal(b.mod, "0.1.0");
});

test("出错要明说: 未知方法、Lua 运行错误", async () => {
  await assert.rejects(lab.rpc("nope"), /没有这个方法/);
  await assert.rejects(lab.exec("error('boom')"), /boom/);
  await assert.rejects(lab.exec("this is not lua"), /编译失败/);
});

test("大回复和长参数 (自动压缩)", async () => {
  const s = (await lab.exec("return string.rep('ab', 200000)")) as string;
  assert.equal(s.length, 400000);
  assert.equal(await lab.exec("local a = ... return #a", "x".repeat(60000)), 60000);
});

test("精确跑 tick: 暂停状态下跑 600 个 tick 后停住", async () => {
  const t0 = ((await lab.rpc("ping")) as { tick: number }).tick;
  const s = (await lab.runTicks(600)) as { tick: number; paused: boolean };
  assert.ok(s.tick >= t0 + 600 && s.tick <= t0 + 602, `tick ${t0} -> ${s.tick}`);
  assert.equal(s.paused, true);
});

test("放蓝图并加速跑: 小产线出铁板和齿轮, 游戏自带计分不计只产不耗的物品 (2.1.24)", async () => {
  await lab.rpc("prepare_area", { area: [[-12, -12], [12, 12]], resource: { name: "iron-ore", amount: 100000, area: [[-3, -3], [0, 0]] }, no_enemies: true });
  const poleCopper = (await lab.exec("return defines.wire_connector_id.pole_copper")) as number;
  const placed = (await lab.rpc("place_blueprint", { string: demoBlueprint("2.1.24", poleCopper), position: [0, 0] })) as { failed_count: number; offset: { x: number; y: number } };
  assert.equal(placed.failed_count, 0);
  assert.deepEqual(placed.offset, { x: 0, y: 0 });
  await lab.runTicks(3600);
  const sc = (await lab.rpc("score")) as { production_score: number; all_net_value: number; produced: Record<string, number>; consumed: Record<string, number>; prices: Record<string, number> };
  assert.ok(sc.produced["iron-gear-wheel"] > 0);
  assert.equal(sc.consumed["iron-gear-wheel"] ?? 0, 0);
  const expected = Math.floor(sc.prices["iron-ore"] * (sc.produced["iron-ore"] - sc.consumed["iron-ore"]) + sc.prices["iron-plate"] * (sc.produced["iron-plate"] - sc.consumed["iron-plate"]));
  assert.equal(sc.production_score, expected);
  assert.ok(sc.all_net_value > sc.production_score);
});

test("放蓝图时挡路的角色会被挪开, 建筑照样建成", async () => {
  await lab.rpc("prepare_area", { area: [[20, -12], [44, 12]], resource: { name: "iron-ore", amount: 100000, area: [[29, -3], [32, 0]] } });
  await lab.exec("game.surfaces.nauvis.create_entity{name='character', position={30.5, -1.5}, force='player'}");
  const poleCopper = (await lab.exec("return defines.wire_connector_id.pole_copper")) as number;
  const placed = (await lab.rpc("place_blueprint", { string: demoBlueprint("2.1.24", poleCopper), position: [32, 0] })) as { failed_count: number; moved_characters: number };
  assert.equal(placed.moved_characters, 1);
  assert.equal(placed.failed_count, 0);
  assert.equal(await lab.exec("return game.surfaces.nauvis.count_entities_filtered{name='electric-mining-drill', position={30.5, -1.5}}"), 1);
});

test("自动补杆不压东西: 给中心在 .5 上的组装机补配电站, 补的杆子和电源都不和别的实体重叠", async () => {
  await lab.rpc("prepare_area", { area: [[60, -12], [90, 12]] });
  await lab.exec("lab.place{surface = game.surfaces.nauvis, name = 'assembling-machine-2', position = {70.5, 0.5}, force = 'player'} return true");
  const fix = (await lab.rpc("power_fix", { surface: "nauvis", targets: [{ x: 70.5, y: 0.5 }] })) as { fixed: number };
  assert.equal(fix.fixed, 1);
  const overlaps = await lab.exec(`local s = game.surfaces.nauvis local n = 0
    for _, e in pairs(s.find_entities_filtered{name = {"substation", "electric-energy-interface"}, area = {{60, -12}, {90, 12}}}) do
      for _, o in pairs(s.find_entities_filtered{area = e.bounding_box}) do if o ~= e and o.type ~= "character" then n = n + 1 end end
    end
    return n`);
  assert.equal(overlaps, 0);
  assert.notEqual(await lab.exec("return game.surfaces.nauvis.find_entity('assembling-machine-2', {70.5, 0.5}).electric_network_id"), null);
});

test("存档和回档: 存一个快照, 改动后从快照重启, 改动消失", async () => {
  await lab.exec("storage.snap_mark = 'before'");
  await lab.rpc("save", { name: "snap" });
  const f = lab.savePath("snap");
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(f), "快照存档没出现");
  await new Promise((r) => setTimeout(r, 500));
  await lab.exec("storage.snap_mark = 'after'");
  await lab.stop({ save: false });
  await lab.start("snap");
  assert.equal(await lab.exec("return storage.snap_mark"), "before");
});

test("两个实例同时跑, 互不可见", async () => {
  const other = new SandboxServer({ name: "test-sandbox-2", view: false });
  try {
    await other.createMap("t", { seed: 42 });
    await other.start("t");
    await lab.exec("storage.who = 'one'");
    await other.exec("storage.who = 'two'");
    assert.equal(await lab.exec("return storage.who"), "one");
    assert.equal(await other.exec("return storage.who"), "two");
    assert.notEqual(lab.rconPort, other.rconPort);
  } finally {
    await other.stop({ save: false });
  }
});
