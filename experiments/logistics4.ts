// 物流网第四批 (已核实补到 10 条; 第三批里 2 条被推翻): 机器人指令平台的建设范围 (半边长 55, 检查器"机器人指令平台覆盖"要用);
// 物流机器人一次搬几件 (没研究 1 件, 每级"工人机器人货仓"+1; 机器人吞吐的计算要用)。范围、级数一律运行时从原型读。
import type { Experiment } from "../src/verify/types.ts";

const ROBOPORT = `
local a = ...
local s = game.surfaces[a.surface]
local rp = lab.place{surface = s, name = "roboport", position = {a.x, a.y}, force = "player"}
rp.insert{name = a.robot, count = a.robots}
local proto = prototypes.entity["roboport"]
return {x = rp.position.x, y = rp.position.y, construction = proto.construction_radius, logistics = proto.logistic_radius}`;

const CHEST = `
local a = ...
local e = lab.place{surface = game.surfaces[a.surface], name = a.name, position = {a.x + a.dx, a.y + a.dy}, force = "player"}
if a.item then e.insert{name = a.item, count = a.count} end
if a.request then e.get_logistic_sections().add_section().set_slot(1, {value = {name = a.request, quality = "normal"}, min = a.amount}) end
return {x = e.position.x, y = e.position.y}`;

// 虚影 (lab.place 查碰撞; 放的是 entity-ghost, 里面是铁箱)
const GHOST = `
local a = ...
local g = lab.place{surface = game.surfaces[a.surface], name = "entity-ghost", inner_name = "iron-chest", position = {a.px, a.py}, force = "player"}
if a.label then lab.label(g, a.label) end
return {x = g.position.x, y = g.position.y}`;

const BUILT = `
local a = ...
local s = game.surfaces[a.surface]
local out = {}
for i, p in ipairs(a.points) do
  out[i] = {chest = s.find_entity("iron-chest", {p.x, p.y}) ~= nil, ghost = #s.find_entities_filtered{name = "entity-ghost", position = {p.x, p.y}} > 0}
end
return out`;

export const constructionRange55: Experiment = {
  id: "logistics.roboport.construction-range-55",
  topic: "物流网",
  claim: "机器人指令平台的建设范围是以它为中心半边长 55 的方块 (110×110, 比物流范围 25 大得多): 离中心 54.5 格的虚影会被建设机器人建好, 56.5 格的不建",
  refs: ["logistics.md 本机速查 (建设范围半径 55)", "verify.md 下一批 3 (检查器: 机器人指令平台覆盖)", "docs/research/players/game-tips.md TT13 (范围内的虚影由机器人自动建)"],
  sources: [{ title: "本机原型: roboport construction_radius 55、logistic_radius 25 (entities.lua)", credibility: 1 }],
  gameSeconds: 120,
  async run(ctx) {
    const area: [[number, number], [number, number]] = [[ctx.x - 62, ctx.y - 10], [ctx.x + 62, ctx.y + 10]];
    ctx.watch(area);
    await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area, no_enemies: true }, { timeoutMs: 120_000 });
    await ctx.power();
    const rp = (await ctx.lua(ROBOPORT, { robot: "construction-robot", robots: 10 })) as { x: number; y: number; construction: number; logistics: number };
    await ctx.lua(CHEST, { name: "passive-provider-chest", dx: 0.5, dy: -4.5, item: "iron-chest", count: 10 });
    const r = rp.construction;
    // 东边: 范围内 (r - 0.5) 和远一点的 (r - 5.5); 西边: 刚出范围 (r + 1.5) 和更远 (r + 5.5), 头顶标字
    const points = [
      { tag: `东 ${r - 5.5} 格`, dx: r - 5.5 }, { tag: `东 ${r - 0.5} 格`, dx: r - 0.5 },
      { tag: `西 ${r + 1.5} 格`, dx: -(r + 1.5), label: `对照: ${r + 1.5} 格, 故意放在建设范围外` }, { tag: `西 ${r + 5.5} 格`, dx: -(r + 5.5), label: "对照: 范围外" },
    ];
    const placed = [] as { x: number; y: number }[];
    for (const p of points) placed.push((await ctx.lua(GHOST, { px: rp.x + p.dx, py: rp.y + 0.5, label: p.label })) as { x: number; y: number });
    await ctx.say(`建设范围应是半边长 ${r}: 东边两个虚影在范围内, 西边两个 (头顶标了字) 故意放在范围外`);
    await ctx.ticks(60);
    await ctx.powered();
    await ctx.ticks(90 * 60);
    const res = (await ctx.lua(BUILT, { points: placed })) as { chest: boolean; ghost: boolean }[];
    const desc = points.map((p, i) => `${p.tag}${res[i].chest ? "建好了" : res[i].ghost ? "仍是虚影" : "不见了"}`).join("、");
    const ok = r === 55 && res[0].chest && res[1].chest && !res[2].chest && res[2].ghost && !res[3].chest && res[3].ghost;
    return {
      verdict: ok ? "verified" : res[0].chest || res[1].chest ? "refuted" : "inconclusive",
      summary: `原型建设半径 ${r} (物流半径 ${rp.logistics}); 90 秒后: ${desc}`,
      measured: { rp, points: placed, res },
    };
  },
};

// 正在飞的物流机器人身上带了几件 (取所有机器人的最大值)
const CARGO = `
local a = ...
local mx, flying = 0, 0
for _, r in pairs(game.surfaces[a.surface].find_entities_filtered{name = "logistic-robot", area = {{a.x - 30, a.y - 30}, {a.x + 30, a.y + 30}}}) do
  local n = r.get_inventory(defines.inventory.robot_cargo).get_item_count()
  if n > 0 then flying = flying + 1 end
  if n > mx then mx = n end
end
return {max = mx, flying = flying}`;

const STORAGE_TECH = `
local levels, per = 0, {}
for name, t in pairs(prototypes.technology) do
  if name:find("^worker%-robots%-storage%-") then
    levels = levels + 1
    for _, e in pairs(t.effects) do if e.type == "worker-robot-storage" then per[#per + 1] = e.modifier end end
  end
end
return {levels = levels, per = per}`;

export const robotCargoSize: Experiment = {
  id: "logistics.robot.cargo-1-plus-research",
  topic: "物流网",
  claim: "物流机器人没研究时一次只搬 1 件; 每级\"工人机器人货仓\"研究 +1 件 (3 级, 满级一次 4 件): 加成设成 2 后一次搬 3 件",
  refs: ["lab.md #35 (没研究货仓的物流机器人一次只搬 1 件)", "knowledge/patterns/logistics-choice.md (机器人吞吐)"],
  sources: [{ title: "本机原型: technology.lua worker-robots-storage-1~3, 效果 worker-robot-storage modifier 1", credibility: 1 }],
  gameSeconds: 90,
  async run(ctx) {
    await ctx.power();
    const tech = (await ctx.lua(STORAGE_TECH)) as { levels: number; per: number[] };
    await ctx.lua(ROBOPORT, { robot: "logistic-robot", robots: 20 });
    await ctx.lua(CHEST, { name: "passive-provider-chest", dx: -10.5, dy: 0.5, item: "iron-plate", count: 2000 });
    await ctx.lua(CHEST, { name: "requester-chest", dx: 10.5, dy: 0.5, request: "iron-plate", amount: 1500 });
    await ctx.ticks(60);
    await ctx.powered();
    const sample = async (seconds: number) => {
      let mx = 0, seen = 0;
      for (let t = 0; t < seconds * 60; t += 15) {
        await ctx.ticks(15);
        const c = (await ctx.lua(CARGO)) as { max: number; flying: number };
        mx = Math.max(mx, c.max); seen = Math.max(seen, c.flying);
      }
      return { max: mx, flying: seen };
    };
    const base = await sample(25);
    await ctx.say("把阵营的工人机器人货仓加成设成 2 (相当于研究了 2 级)");
    await ctx.lua(`game.forces.player.worker_robots_storage_bonus = 2 return true`);
    await ctx.ticks(10 * 60); // 已经在飞的那批还是 1 件, 等它们送完
    const plus2 = await sample(25);
    await ctx.lua(`game.forces.player.worker_robots_storage_bonus = 0 return true`);
    const total = tech.per.reduce((a, b) => a + b, 0);
    const measured = { tech, base, plus2 };
    if (base.flying === 0 || plus2.flying === 0) return { verdict: "inconclusive", summary: `没看到在飞的机器人带货 (没加成时 ${base.flying} 个, 加成 2 时 ${plus2.flying} 个)`, measured };
    const ok = base.max === 1 && plus2.max === 3 && tech.levels === 3 && total === 3;
    return {
      verdict: ok ? "verified" : base.max !== 1 || plus2.max !== 3 ? "refuted" : "inconclusive",
      summary: `没加成: 在飞的机器人最多带 ${base.max} 件; 加成 2: 最多带 ${plus2.max} 件; 原型里货仓研究 ${tech.levels} 级、每级 +${tech.per.join("/")}, 满级一次 ${1 + total} 件`,
      measured,
    };
  },
};

// 一对机器人指令平台, 相距 2×half 格 (同一行); 只有西边那台放机器人
const PAIR = `
local a = ...
local s = game.surfaces[a.surface]
local out = {}
for i, dx in ipairs({-a.half, a.half}) do
  local rp = lab.place{surface = s, name = "roboport", position = {a.x + dx, a.y + a.dy}, force = "player"}
  if i == 1 then rp.insert{name = "logistic-robot", count = 10} end
  lab.label(rp, a.label)
  out[i] = {x = rp.position.x, y = rp.position.y}
end
return out`;

const SAME_NET = `
local a = ...
local s = game.surfaces[a.surface]
local n1 = s.find_entity("roboport", {a.p[1].x, a.p[1].y}).logistic_network
local n2 = s.find_entity("roboport", {a.p[2].x, a.p[2].y}).logistic_network
return {id1 = n1 and n1.network_id or -1, id2 = n2 and n2.network_id or -1}`;

export const touchingRangesConnect: Experiment = {
  id: "logistics.network.touching-ranges-connect",
  topic: "物流网",
  claim: "两个机器人指令平台的物流范围边界刚好相接 (相距 50 格, 不重叠) 就连成一张网: 西边平台旁红箱里的货, 东边平台旁的蓝箱收得到; 相距 52 格 (中间空 2 格) 就是两张网",
  refs: ["logistics.md P-logi-03 (范围不重叠 = 两张网, 已核实 60 格)", "src/blueprint/check-coverage.ts (刚好相接原先按两张网算)"],
  sources: [{ title: "官方 wiki: Roboport (物流范围橙色边界相接即可连成一张网)", url: "https://wiki.factorio.com/Roboport", date: "2026-03-16", credibility: 2 }],
  gameSeconds: 200,
  async run(ctx) {
    const area: [[number, number], [number, number]] = [[ctx.x - 40, ctx.y - 12], [ctx.x + 40, ctx.y + 72]];
    ctx.watch(area);
    await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area, no_enemies: true }, { timeoutMs: 120_000 });
    const touch = (await ctx.lua(PAIR, { half: 25, dy: 0, label: "相距 50: 范围刚好相接" })) as { x: number; y: number }[];
    const gap = (await ctx.lua(PAIR, { half: 26, dy: 60, label: "对照: 相距 52, 中间空 2 格" })) as { x: number; y: number }[];
    await ctx.lab.rpc("power_area", { surface: ctx.surface, area, inset: 6 });
    const chests = [];
    for (const [pair, tag] of [[touch, "touch"], [gap, "gap"]] as const) {
      const red = await ctx.lua(CHEST, { name: "passive-provider-chest", dx: pair[0].x - 5.5 - ctx.x, dy: pair[0].y + 0.5 - ctx.y, item: "iron-plate", count: 100 });
      const blue = await ctx.lua(CHEST, { name: "requester-chest", dx: pair[1].x + 5.5 - ctx.x, dy: pair[1].y + 0.5 - ctx.y, request: "iron-plate", amount: 20 });
      chests.push({ tag, red, blue });
    }
    await ctx.say("上面一对平台相距 50 (范围刚好相接), 下面一对相距 52 (对照); 机器人只放在西边那台, 看东边蓝箱收不收得到");
    await ctx.ticks(60);
    await ctx.powered();
    await ctx.ticks(150 * 60);
    const net = { touch: (await ctx.lua(SAME_NET, { p: touch })) as { id1: number; id2: number }, gap: (await ctx.lua(SAME_NET, { p: gap })) as { id1: number; id2: number } };
    const got = async (p: unknown) => (await ctx.lua(`local a = ... local e = game.surfaces[a.surface].find_entity("requester-chest", {a.p.x, a.p.y}) return e and e.get_inventory(defines.inventory.chest).get_item_count("iron-plate") or -1`, { p })) as number;
    const recv = { touch: await got(chests[0].blue), gap: await got(chests[1].blue) };
    const sameTouch = net.touch.id1 >= 0 && net.touch.id1 === net.touch.id2, sameGap = net.gap.id1 >= 0 && net.gap.id1 === net.gap.id2;
    const measured = { touch, gap, net, recv };
    const ok = sameTouch && recv.touch === 20 && !sameGap && recv.gap === 0;
    return {
      verdict: ok ? "verified" : !sameTouch && recv.touch === 0 && !sameGap ? "refuted" : "inconclusive",
      summary: `相距 50: 两台${sameTouch ? "同一张网" : "不同网"} (编号 ${net.touch.id1}/${net.touch.id2}), 东边蓝箱收到 ${recv.touch}; 相距 52 (对照): ${sameGap ? "同一张网" : "不同网"}, 收到 ${recv.gap}`,
      measured,
    };
  },
};
