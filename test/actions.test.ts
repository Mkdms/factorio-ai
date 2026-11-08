// ./fh 动作翻译成玩家操作 (commands/actions.ts, broker.ts) 的纯逻辑; 真游戏的核对是 test/sandbox/actions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksBuild, handSeconds, insertInventory, mineHold, pathTiles, PlayerActions, rotateTurns, routeTiles, takeInventories, targetArea, type ActionDeps } from "../commands/actions.ts";

test("铺线方案 → 一格格放的清单: 电线杆给位置不管方向; 带子 / 水管按 details 的 entities, 方向数字或名字都认, 水管和地下带出口端不转", () => {
  assert.deepEqual(routeTiles("pole_route", { item: "medium-electric-pole", positions: [{ x: 1.5, y: 2.5 }, "坏的", { x: 8.5, y: 2.5 }] }),
    [{ item: "medium-electric-pole", position: { x: 1.5, y: 2.5 }, direction: null }, { item: "medium-electric-pole", position: { x: 8.5, y: 2.5 }, direction: null }]);
  assert.equal(routeTiles("pole_route", { positions: [{ x: 0, y: 0 }] })[0].item, "small-electric-pole", "没写就是小电线杆");
  const belts = routeTiles("belt_route", { entities: [
    { name: "transport-belt", position: { x: 0.5, y: 0.5 }, direction: 4 },
    { name: "underground-belt", position: { x: 1.5, y: 0.5 }, direction: 4, type: "input" },
    { name: "underground-belt", position: { x: 5.5, y: 0.5 }, direction: 4, type: "output" },
    { name: "transport-belt", position: { x: 6.5, y: 0.5 }, direction: "south" },
  ] });
  assert.deepEqual(belts.map((t) => t.direction), [4, 4, null, 8]);
  const pipes = routeTiles("pipe_route", { entities: [{ name: "pipe", position: { x: 0.5, y: 0.5 }, direction: 0 }, { name: "pipe-to-ground", position: { x: 1.5, y: 0.5 }, direction: 12 }] });
  assert.deepEqual(pipes.map((t) => [t.item, t.direction]), [["pipe", null], ["pipe-to-ground", 12]]);
  assert.deepEqual(routeTiles("belt_route", {}), [], "没有清单就是空的");
});
import { CommandBroker } from "../commands/broker.ts";
import { REPRESS_TICKS } from "../commands/timeline.ts";

test("挖矿中途一直重按: 切窗口松开的键很快接上", () => {
  const t = mineHold({ device: "mouse", name: "right", modifiers: [] }, { x: 3, y: 4 }, 1226);
  assert.deepEqual(t.entries[0].tick, "0-1225", "鼠标一直指着");
  const holds = t.entries.slice(1).map((e) => e.tick!.split("-").map(Number));
  assert.ok(t.entries.slice(1).every((e) => e.button === "right"));
  assert.equal(holds[0][0], 1);
  assert.equal(holds.at(-1)!.at(-1), 1225);
  for (let i = 1; i < holds.length; i++) assert.equal(holds[i][0], holds[i - 1][1] + 1, "首尾相接, 中间没有一个 tick 是松开的");
  assert.ok(holds.every(([a, b]) => b - a < REPRESS_TICKS), "每段不超过重按间隔");
  assert.ok(t.entries.length <= 256, "工具一次最多 256 条");
});

test("放建筑时谁挡路: 走得过去不等于放得下 (2026-11-06 真服: 干跑用走路的规则, 带子和铁轨上也说放得下)", () => {
  for (const t of ["transport-belt", "underground-belt", "splitter", "straight-rail", "rail-signal", "pipe-to-ground", "assembling-machine", "container", "pipe"]) assert.equal(blocksBuild(t), true, t);
  for (const t of ["elevated-straight-rail", "logistic-robot", "construction-robot", "resource", "entity-ghost", "character", "item-entity", "corpse"]) assert.equal(blocksBuild(t), false, t);
});

test("放东西进哪个物品栏: 炉子的煤进燃料、矿进原料; 模型写了就听它的; 取的时候先看产物", () => {
  assert.equal(insertInventory("furnace", "coal"), "fuel");
  assert.equal(insertInventory("furnace", "iron-ore"), "crafter_input");
  assert.equal(insertInventory("assembling-machine", "iron-plate"), "crafter_input");
  assert.equal(insertInventory("lab", "automation-science-pack"), "lab_input");
  assert.equal(insertInventory("ammo-turret", "firearm-magazine"), "turret_ammo");
  assert.equal(insertInventory("mining-drill", "coal"), "fuel");
  assert.equal(insertInventory("container", "coal"), "chest");
  assert.equal(insertInventory("furnace", "coal", "input"), "crafter_input", "模型明确说进原料格");
  assert.deepEqual(takeInventories("furnace"), ["crafter_output", "crafter_input", "fuel"]);
  assert.deepEqual(takeInventories("container"), ["chest"]);
  assert.deepEqual(takeInventories("furnace", "fuel"), ["fuel"]);
});

test("旋转: 顺时针按几下; 不是正方向的回 null", () => {
  assert.equal(rotateTurns(0, 4), 1);
  assert.equal(rotateTurns(4, 0), 3);
  assert.equal(rotateTurns(8, 8), 0);
  assert.equal(rotateTurns(12, 4), 2);
  assert.equal(rotateTurns(2, 4), null);
  assert.equal(handSeconds(0.5, 6), 3);
});

test("铺带子: 按点展开, 拐点方向跟下一段, 终点用 end_direction; 斜的报错", () => {
  const t = pathTiles([{ x: 0.5, y: 0.5 }, { x: 2.5, y: 0.5 }, { x: 2.5, y: 2.5 }], "east");
  assert.deepEqual(t.map((x) => [x.position.x, x.position.y, x.direction]), [[0.5, 0.5, 4], [1.5, 0.5, 4], [2.5, 0.5, 8], [2.5, 1.5, 8], [2.5, 2.5, 4]]);
  assert.equal(pathTiles([{ x: 0.5, y: 0.5 }, { x: 0.5, y: -1.5 }]).at(-1)!.direction, 0, "没给终点方向就接着走");
  assert.throws(() => pathTiles([{ x: 0, y: 0 }, { x: 1, y: 1 }]), /横平竖直/);
  assert.throws(() => pathTiles([{ x: 0, y: 0 }]), /至少 2 个点/);
  assert.throws(() => pathTiles([{ x: 0, y: 0 }, { x: 1, y: 0 }], "up"), /end_direction/);
});

test("目标范围: positions 优先, 再 area, 否则角色周围, 半径封顶 64", () => {
  const me = { x: 10, y: 20 };
  assert.deepEqual(targetArea({ positions: [{ x: 1, y: 2 }, "坏的"] }, me), { positions: [{ x: 1, y: 2 }] });
  assert.deepEqual(targetArea({ area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 5, y: 5 } } }, me).box, { left_top: { x: 0, y: 0 }, right_bottom: { x: 5, y: 5 } });
  assert.deepEqual(targetArea({ radius: 500 }, me).box, { left_top: { x: -54, y: -44 }, right_bottom: { x: 74, y: 84 } });
  assert.deepEqual(targetArea({ position: { x: 0, y: 0 } }, me).box, { left_top: { x: -32, y: -32 }, right_bottom: { x: 32, y: 32 } });
});

const deps = (over: Partial<ActionDeps> = {}): ActionDeps => ({ call: async () => ({ ok: true, data: {} }), controls: () => { throw new Error("不该用键位"); }, defines: () => ({ inventory: { fuel: 1 } }), tick: async () => 7, holdItem: async () => null, placeHeld: async () => ({ ok: true }), clearCursor: async () => undefined, setRecipe: async () => undefined, insertExact: async () => undefined, takeExact: async () => undefined, itemCount: async () => 0, stacks: async () => [], chatSend: async () => ({ ok: true }), ...over } as ActionDeps);

/** 开枪用的假游戏: 记下每次按键; 弹药和血量读这里 */
function shootGame(o: { hp?: number[]; rounds?: number[]; around?: { name: string; type: string; position: { x: number; y: number }; force: { name: string } }[] } = {}) {
  const inputs: { device: string; key?: string; button?: string; position?: { x: number; y: number }; tick: string }[][] = [];
  const hp = [...(o.hp ?? [250])], rounds = [...(o.rounds ?? [55, 40])];
  const over: Partial<ActionDeps> = {
    defines: () => ({ inventory: { character_ammo: 4 } }) as never,
    controls: () => ({ resolve: (id: string) => (id === "shoot-enemy" ? { device: "keyboard", name: "SPACE", modifiers: [] } : { device: "keyboard", name: "C", modifiers: [] }) }) as never,
    call: async (name, args) => {
      if (name === "input") { inputs.push((args as { timeline: never[] }).timeline); return { ok: true, data: {} }; }
      const sel = (args as { selection: { kind?: string; path?: { index?: number }[] } }).selection;
      if (sel.kind === "player") return { ok: true, data: { player: { position: { x: 0, y: 0 } }, objects: [{ attributes: {} }] } };
      if (sel.kind === "entities") return { ok: true, data: { objects: (o.around ?? []).map((attributes) => ({ attributes })) } };
      if (sel.path) {
        const k = sel.path[1]?.index;
        if (k !== 1) return { ok: true, data: { objects: [{ attributes: { valid_for_read: false } }] } };
        const left = rounds.length > 1 ? rounds.shift()! : rounds[0];
        return { ok: true, data: { objects: [{ attributes: { valid_for_read: true, count: Math.ceil(left / 10), ammo: left % 10 || 10 } }] } };
      }
      const h = hp.length > 1 ? hp.shift()! : hp[0];
      return h <= 0 ? { ok: false, error: "no character" } : { ok: true, data: { objects: [{ attributes: { health: h, max_health: 250 } }] } };
    },
  };
  return { inputs, over };
}

const enemy = (name: string, type: string, x: number, force = "enemy") => ({ name, type, position: { x, y: 0 }, force: { name: force } });

test("shoot: position 鼠标指着按开火键, 一直重按, 报用了几发", async () => {
  const g = shootGame();
  const r = await new PlayerActions(deps(g.over)).run({ id: "a", action: "shoot", args: { position: { x: 3, y: 4 }, ticks: 130 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result!.fired_ticks, 130);
  assert.equal(r.result!.rounds_used, 15);
  assert.equal(r.result!.ammo_start, 6);
  assert.ok(g.inputs.length >= 3, "分几段按, 中间看血量");
  assert.deepEqual(g.inputs[0][0].position, { space: "world", x: 3, y: 4 }, "先把鼠标指过去");
  const holds = g.inputs.flat().filter((e) => e.key);
  assert.ok(holds.every((e) => e.key === "C"));
  assert.ok(holds.every((e) => { const [a, b = a] = e.tick.split("-").map(Number); return b - a < 10; }), "每段都在重按");
});

test("shoot auto: 自己找最近的敌人指着打; 先打虫子再打巢; 自己人的不算; 周围没敌人不按键", async () => {
  const nest = shootGame({ around: [enemy("biter-spawner", "unit-spawner", 12), enemy("small-worm-turret", "turret", 6), enemy("gun-turret", "turret", 2, "player")] });
  const r = await new PlayerActions(deps(nest.over)).run({ id: "a", action: "shoot", args: { auto: true, ticks: 30 } });
  assert.equal(r.result!.aimed_at, "small-worm-turret", "最近的敌方建筑, 自己的炮塔不算");
  assert.deepEqual(nest.inputs[0][0].position, { space: "world", x: 6, y: 0 });
  const bugs = shootGame({ around: [enemy("small-worm-turret", "turret", 3), enemy("small-biter", "unit", 8)] });
  const b = await new PlayerActions(deps(bugs.over)).run({ id: "b", action: "shoot", args: { auto: true, ticks: 30 } });
  assert.equal(b.result!.aimed_at, "small-biter", "虫子在咬人, 比更近的虫子塔优先");
  assert.deepEqual(bugs.inputs[0][0].position, { space: "world", x: 8, y: 0 });
  assert.ok(bugs.inputs.length >= 2, "虫子会跑, 一小段就重新瞄一次");
  const empty = shootGame({ rounds: [50, 50] });
  const e = await new PlayerActions(deps({ ...empty.over, sleep: async () => undefined })).run({ id: "c", action: "shoot", args: { auto: true, ticks: 30 } });
  assert.equal(empty.inputs.length, 0, "没敌人按了也打不出去");
  assert.match(String(e.result!.why), /射程内没有敌人/);
});

test("shoot 拒绝的情况: 没说打哪、车上的枪、没弹药; 都不按键", async () => {
  const g = shootGame({ rounds: [0] });
  const a = new PlayerActions(deps(g.over));
  assert.match((await a.run({ id: "a", action: "shoot", args: {} })).error!.message, /auto: true 或 position/);
  assert.match((await a.run({ id: "b", action: "shoot", args: { auto: true, gun_slot: 2 } })).error!.message, /gun_slot 这条路还没翻译/);
  assert.match((await a.run({ id: "c", action: "shoot", args: { auto: true } })).error!.message, /弹药格是空的/);
  assert.equal(g.inputs.length, 0);
});

test("shoot: 一发没打要说为什么; 打到一半死了如实报, 不当成功打完", async () => {
  const none = await new PlayerActions(deps(shootGame({ rounds: [50, 50] }).over)).run({ id: "a", action: "shoot", args: { position: { x: 90, y: 0 }, ticks: 30 } });
  assert.equal(none.result!.rounds_used, 0);
  assert.match(String(none.result!.why), /超出射程/);
  const g = shootGame({ hp: [100, 0] });
  const dead = await new PlayerActions(deps(g.over)).run({ id: "b", action: "shoot", args: { position: { x: 3, y: 0 }, ticks: 600 } });
  assert.equal(dead.ok, true);
  assert.match(String(dead.result!.died), /角色死了/);
  assert.ok(Number(dead.result!.fired_ticks) < 600);
});

test("回复格式照模组: 有 id、tick, 成功 result, 失败 error.code = action_failed; 参数缺了说怎么写", async () => {
  const a = new PlayerActions(deps());
  const ok = await a.run({ id: "x1", action: "say", args: { text: "你好" } });
  assert.deepEqual(ok, { id: "x1", ok: true, tick: 7, result: { said: true } });
  const bad = await a.run({ id: "x2", action: "move_to", args: {} });
  assert.equal(bad.id, "x2");
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.code, "action_failed");
  assert.match(bad.error!.message, /fh call move_to --args/);
  // construct 2026-11-08 接上了 (按虚影放实物); 还没翻译成玩家操作的拿 wire 当例子
  assert.match((await a.run({ id: "x3", action: "wire", args: {} })).error!.message, /还没翻译/);
  assert.equal(a.has("build"), true);
  assert.equal(a.has("construct"), true);
  assert.equal(a.has("wire"), false);
  assert.match((await a.run({ id: "x4", action: "research", args: { front: true } })).error!.message, /research 要 technology/);
});

test("say 发不出去要报", async () => {
  const r = await new PlayerActions(deps({ chatSend: async () => ({ ok: false, error: "没挂上" }) })).run({ id: "s", action: "say", args: { text: "x" } });
  assert.match(r.error!.message, /没挂上/);
});

// 派对命令行的写法
const dispatch = (req: unknown) => `/silent-command rcon.print(remote.call("agent_harness", "dispatch", [[\n${JSON.stringify(req)}]]))`;

test("代理: 命令行等 5 秒重发同一个 id, 不能再做一遍 (2026-11-06 第一轮核对挖矿被并发做了几次); 不同 id 各做各的", async () => {
  let runs = 0;
  const actions = { has: (x: string) => x === "mine", run: async (r: { id?: string }) => { runs++; await new Promise((f) => setTimeout(f, 30)); return { id: r.id, ok: true, tick: 1, result: { n: runs } }; } };
  const b = new CommandBroker({ pipe: "x", python: "x", probeArgs: [], mode: "server", rcon: null, actions });
  const [first, resend] = await Promise.all([b.handle(dispatch({ id: "a", action: "mine", args: {} })), b.handle(dispatch({ id: "a", action: "mine", args: {} }))]);
  assert.equal(runs, 1);
  assert.equal(first.text, resend.text);
  assert.equal((await b.handle(dispatch({ id: "a", action: "mine", args: {} }))).text, first.text, "做完之后才到的重发也答得上");
  assert.equal(runs, 1);
  await b.handle(dispatch({ id: "b", action: "mine", args: {} }));
  assert.equal(runs, 2);
  assert.equal(b.stats.acted, 2);
  assert.deepEqual(JSON.parse(first.text!).id, "a");
});

test("代理: 沙盘模式不走行动层 (动作在游戏里的模组上)", async () => {
  const actions = { has: () => true, run: async () => { throw new Error("不该调"); } };
  const sent: string[] = [];
  const b = new CommandBroker({ pipe: "x", python: "x", probeArgs: [], mode: "sandbox", rcon: { send: async (c) => { sent.push(c); return "ok"; } }, actions });
  const r = await b.handle(dispatch({ id: "a", action: "build", args: {} }));
  assert.equal(r.text, "ok");
  assert.equal(sent.length, 1);
});

/** 放建筑的假游戏: 角色在原点, 手上拿着 item, 背包里也有; 放下一律失败; 周围的实体和那格地块由参数给 */
function buildGame(o: { item: string; tile?: string | null; around?: Record<string, unknown>[]; placements?: Record<string, unknown> | null; me?: { x: number; y: number } }) {
  const reads: { action: string; args: Record<string, unknown> }[] = [];
  const over: Partial<ActionDeps> = {
    me: "Claude-Sonnet",
    call: async (name, args) => {
      const sel = (args as { selection: { kind?: string } }).selection;
      if (sel.kind === "player") return { ok: true, data: { player: { position: o.me ?? { x: 0, y: 0 } }, objects: [{ attributes: { character: true, cursor_stack: { valid_for_read: true, name: o.item, count: 1 } } }] } };
      if (sel.kind === "inventory") return { ok: true, data: { objects: [{ valid_for_read: true, attributes: { name: o.item, count: 2 } }] } };
      if (sel.kind === "tiles") return o.tile === null ? { ok: false, error: "没注入" } : { ok: true, data: { objects: [{ attributes: { name: o.tile ?? "grass-1" } }] } };
      if (sel.kind === "entities") return { ok: true, data: { objects: (o.around ?? []).map((attributes) => ({ attributes })) } };
      return { ok: true, data: { objects: [] } };
    },
    placeHeld: async () => ({ ok: false, error: `放不下: ${o.item} 没放上 (手上还是 1 个), 那格是 空的 (可能够不着或被挡)` }),
    read: o.placements === undefined ? undefined : async (action, args) => { reads.push({ action, args }); return o.placements; },
  };
  return { reads, over };
}

test("放不下时多说几句: 那格地块、抽水机的岸边规则、附近放得下的位置 (问模组 placements, 12 格); 没有空位就指去 nearest_water", async () => {
  const g = buildGame({ item: "offshore-pump", tile: "grass-1", placements: { placements: [{ position: { x: -32.5, y: -34.5 }, direction: "east" }, { position: { x: -31.5, y: -36.5 }, direction: "north" }] } });
  const r = await new PlayerActions(deps(g.over)).run({ id: "a", action: "build", args: { item: "offshore-pump", position: { x: 3.5, y: 3.5 }, direction: "north" } });
  assert.equal(r.ok, false);
  const msg = (r.error as { message: string }).message;
  assert.match(msg, /^placement blocked by 看不到挡着的东西; 那格地块 grass-1; 抽水机只能放在岸上/);
  assert.match(msg, /附近放得下的位置 \(按游戏规则算的, 12 格内\): \(-32\.5,-34\.5\) 朝 east、\(-31\.5,-36\.5\) 朝 north/);
  assert.doesNotMatch(msg, /离你/, "够得着就不说距离");
  assert.deepEqual(g.reads, [{ action: "placements", args: { name: "offshore-pump", near: { x: 3.5, y: 3.5 }, radius: 12, limit: 3 } }]);

  const none = buildGame({ item: "offshore-pump", tile: "water", placements: { placements: [], in_the_way: "water everywhere" } });
  const n = await new PlayerActions(deps(none.over)).run({ id: "b", action: "build", args: { item: "offshore-pump", position: { x: 3.5, y: 3.5 } } });
  assert.match((n.error as { message: string }).message, /那格地块 water; .*12 格内没有放得下的位置 \(water everywhere\); 换一片水: \.\/fh call nearest_water/);
});

test("放不下 (别的建筑): 够不着就说离多远; 问不到模组就给 placements 命令; 地块读不到不编", async () => {
  const far = buildGame({ item: "stone-furnace", tile: null, placements: null, me: { x: 0, y: 0 } });
  // 离 (9,0) 9 格: 够得着 (走路那步不触发), 放不下
  const r = await new PlayerActions(deps(far.over)).run({ id: "a", action: "build", args: { item: "stone-furnace", position: { x: 9, y: 0 } } });
  const msg = (r.error as { message: string }).message;
  assert.match(msg, /^placement blocked by 看不到挡着的东西; 找附近放得下的位置: \.\/fh call placements --args '\{"name":"stone-furnace","near":\{"x":9,"y":0\}\}'/);
  assert.doesNotMatch(msg, /那格地块/, "地块读不到就不说");
  assert.doesNotMatch(msg, /抽水机/);
  // 没给 read (旧接线): 也只是少一句, 不报错
  const plain = buildGame({ item: "stone-furnace" });
  const p = await new PlayerActions(deps(plain.over)).run({ id: "b", action: "build", args: { item: "stone-furnace", position: { x: 6, y: 2 } } });
  assert.match((p.error as { message: string }).message, /那格地块 grass-1; 找附近放得下的位置: \.\/fh call placements/);
});

test("dry_run 单件被挡: blocked 之外一起给附近放得下的位置 (spots)", async () => {
  const g = buildGame({ item: "stone-furnace", around: [{ name: "stone-furnace", type: "furnace", unit_number: 7, position: { x: 11, y: 10 }, bounding_box: { left_top: { x: 10.3, y: 9.3 }, right_bottom: { x: 11.7, y: 10.7 } } }],
    placements: { placements: [{ position: { x: 13, y: 10 }, direction: "north" }] } });
  const r = await new PlayerActions(deps(g.over)).run({ id: "a", action: "build", args: { item: "stone-furnace", position: { x: 10, y: 10 }, box: { left: 9, top: 9, right: 11, bottom: 11 }, dry_run: true } });
  assert.equal(r.ok, true);
  const res = r.result as { blocked: string[]; spots?: { position: { x: number; y: number }; direction?: string }[] };
  assert.deepEqual(res.blocked, ["stone-furnace (11,10)"]);
  assert.deepEqual(res.spots, [{ position: { x: 13, y: 10 }, direction: "north" }]);
  assert.deepEqual(g.reads[0], { action: "placements", args: { name: "stone-furnace", near: { x: 10, y: 10 }, radius: 6, limit: 3 } });
  // 没被挡就不问
  const free = buildGame({ item: "stone-furnace", placements: { placements: [] } });
  const f = await new PlayerActions(deps(free.over)).run({ id: "b", action: "build", args: { item: "stone-furnace", position: { x: 10, y: 10 }, box: { left: 9, top: 9, right: 11, bottom: 11 }, dry_run: true } });
  assert.equal((f.result as { spots?: unknown }).spots, undefined);
  assert.equal(free.reads.length, 0);
});
