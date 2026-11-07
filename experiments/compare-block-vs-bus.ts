// 思路并排比: 直连块 (朋友的做法, P-friend-04: 炉出的板子直接被旁边的组装机取走, 不建板材主线) vs 过带 (板子上带, 下游从带上取)。
// 同样 8 台电炉吃矿 (永续箱供铁矿), 做齿轮:
//   A 直连块: 每台炉南侧一台机械臂直塞一台组装机2型 (1:1 配对), 组装机再出到箱子; 0 条带子, 8 台组装机。
//   B 过带: 8 台炉的板子由机械臂放到一条东行的带子上, 带尾按比例放 2 台组装机 (电炉 0.625 板/秒 × 8 = 5 板/秒, 组装机2型做齿轮吃 3 板/秒) 从带上取, 出到箱子。
// 量 (各 10 游戏分钟): 齿轮产量、板子产量、组装机台数和平均开工率、带子格数、机械臂数、占地; 直连的代价 = 比例锁死 (1:1 时组装机闲一半), 好处 = 不要带子和平衡器。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

const BUILD = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local d = defines.direction
local N = 8
local ry = a.y - 6
local x0 = a.x - 12
local furnaces, asms, outs, belts, inserters = {}, {}, {}, 0, 0
local function ins(pos, dir) inserters = inserters + 1 return lab.place{surface = s, name = "fast-inserter", position = pos, direction = dir, force = f} end
for i = 0, N - 1 do
  local fx = x0 + 1.5 + i * 3
  local fur = lab.place{surface = s, name = "electric-furnace", position = {fx, ry}, force = f}
  furnaces[#furnaces + 1] = fur
  -- 矿: 炉北侧 永续箱 → 机械臂 (取货方向 = 货源方向 = 北) → 炉
  local n = lab.slots(fur, "north")[2]
  ins(n, d.north)
  local ore = lab.place{surface = s, name = "infinity-chest", position = {n.x, n.y - 1}, force = f}
  ore.set_infinity_container_filter(1, {name = "iron-ore", count = 100, mode = "exactly"})
  local sth = lab.slots(fur, "south")[2]
  if a.kind == "block" then
    -- 直塞: 炉 → 机械臂 (朝北取炉) → 组装机 → 机械臂 → 箱子
    ins(sth, d.north)
    local asm = lab.place{surface = s, name = "assembling-machine-2", position = {fx, sth.y + 2}, recipe = "iron-gear-wheel", force = f}
    asms[#asms + 1] = asm
    local o = lab.slots(asm, "south")[2]
    ins(o, d.north)
    outs[#outs + 1] = lab.place{surface = s, name = "steel-chest", position = {o.x, o.y + 1}, force = f}
  else
    -- 过带: 炉 → 机械臂 → 东行的带子 (在炉南侧第 2 排)
    ins(sth, d.north)
  end
end
if a.kind == "bus" then
  -- 带子在炉南侧第 2 排 (炉的实际位置可能被引擎挪过半格, 行号一律从建出来的炉算)
  local by = lab.slots(furnaces[1], "south", 2)[1].y
  local bx0, bx1 = x0 + 0.5, x0 + N * 3 + 6.5
  for bx = bx0, bx1 do lab.place{surface = s, name = "transport-belt", position = {bx, by}, direction = d.east, force = f} belts = belts + 1 end
  -- 带尾两台组装机 (带子南侧: 带 → 机械臂 → 组装机), 机械臂朝北从带上取
  for j = 0, 1 do
    local ax = x0 + N * 3 + 2.5 + j * 3
    local asm = lab.place{surface = s, name = "assembling-machine-2", position = {ax, by + 3}, recipe = "iron-gear-wheel", force = f}
    asms[#asms + 1] = asm
    local n = lab.slots(asm, "north")[2]
    ins(n, d.north)
    local o = lab.slots(asm, "south")[2]
    ins(o, d.north)
    outs[#outs + 1] = lab.place{surface = s, name = "steel-chest", position = {o.x, o.y + 1}, force = f}
  end
end
-- 占地: 所有建筑的外框
local minx, miny, maxx, maxy = math.huge, math.huge, -math.huge, -math.huge
for _, e in pairs(s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, force = f}) do
  if e.type ~= "electric-pole" and e.type ~= "electric-energy-interface" and e.type ~= "character" then
    local b = e.bounding_box
    minx, miny, maxx, maxy = math.min(minx, b.left_top.x), math.min(miny, b.left_top.y), math.max(maxx, b.right_bottom.x), math.max(maxy, b.right_bottom.y)
  end
end
local refs = {furnaces = {}, asms = {}, outs = {}}
for _, e in ipairs(furnaces) do refs.furnaces[#refs.furnaces + 1] = {x = e.position.x, y = e.position.y} end
for _, e in ipairs(asms) do refs.asms[#refs.asms + 1] = {x = e.position.x, y = e.position.y} end
for _, e in ipairs(outs) do refs.outs[#refs.outs + 1] = {x = e.position.x, y = e.position.y} end
return {refs = refs, belts = belts, inserters = inserters, assemblers = #asms, area = {w = math.ceil(maxx - minx), h = math.ceil(maxy - miny)}}`;

const READ = `
local a = ...
local s = game.surfaces[a.surface]
local plates, gears, working = 0, 0, 0
for _, r in ipairs(a.refs.furnaces) do local e = s.find_entity("electric-furnace", {r.x, r.y}) plates = plates + e.products_finished end -- lint-ok: 电炉没装产能插件
for _, r in ipairs(a.refs.asms) do
  local e = s.find_entity("assembling-machine-2", {r.x, r.y})
  if e.status == defines.entity_status.working then working = working + 1 end
end
for _, r in ipairs(a.refs.outs) do local c = s.find_entity("steel-chest", {r.x, r.y}) gears = gears + c.get_inventory(defines.inventory.chest).get_item_count("iron-gear-wheel") end
return {plates = plates, gears = gears, working = working}`;

async function runVariant(ctx: ExpContext, kind: "block" | "bus", minutes: number) {
  await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area: [[ctx.x - 20, ctx.y - 20], [ctx.x + 20, ctx.y + 20]], no_enemies: true }, { timeoutMs: 120_000 });
  const b = (await ctx.lua(BUILD, { kind })) as { refs: unknown; belts: number; inserters: number; assemblers: number; area: { w: number; h: number } };
  await ctx.power();
  await ctx.powered();
  await ctx.ticks(60 * 60); // 预热 1 分钟 (带子走满、机器开工)
  const start = (await ctx.lua(READ, { refs: b.refs })) as { plates: number; gears: number; working: number };
  let workingSum = 0, samples = 0;
  for (let m = 0; m < minutes * 6; m++) {
    await ctx.ticks(10 * 60);
    const r = (await ctx.lua(READ, { refs: b.refs })) as { working: number };
    workingSum += r.working; samples++;
  }
  const end = (await ctx.lua(READ, { refs: b.refs })) as { plates: number; gears: number; working: number };
  return {
    kind, minutes, gears: end.gears - start.gears, plates: end.plates - start.plates,
    assemblers: b.assemblers, utilization: workingSum / samples / b.assemblers, belts: b.belts, inserters: b.inserters, area: b.area,
  };
}

export const blockVsBus: Experiment = {
  id: "compare.layout.direct-block-vs-belt",
  topic: "布局",
  claim: "直连块 (炉出板直接塞进旁边的组装机, 朋友的做法) 和过带 (板子上带、下游从带上取) 在板子够的前提下产量一样; 直连省掉全部带子, 代价是比例锁死 —— 1:1 配对时组装机闲一半 (电炉 0.625 板/秒, 组装机2型做齿轮吃 3 板/秒), 过带只要 1/4 的组装机",
  refs: ["knowledge/patterns/case-friend-nauvis.md P-friend-04", "knowledge/patterns/layout-styles.md (主线 vs 直塞)"],
  sources: [
    { title: "朋友的新地星基地 (炉区板子直接被两排组装机取走, 没有板材主线; 2026-10-31 导出, 本人同意参考)", credibility: 3 },
    { title: "本机原型: 电炉速度 2 (铁板 1.6 秒), 组装机2型速度 0.75 (齿轮 0.667 秒吃 2 板)", credibility: 1 },
  ],
  gameSeconds: 1400,
  async run(ctx) {
    await ctx.lab.rpc("viewer", { position: [ctx.x, ctx.y - 2], zoom: 0.5, surface: ctx.surface }, { retry: true }).catch(() => undefined);
    const minutes = 10;
    await ctx.say("A: 直连块 (8 炉 → 8 组装机直塞)");
    const A = await runVariant(ctx, "block", minutes);
    await ctx.say("B: 过带 (8 炉 → 带子 → 2 组装机)");
    const B = await runVariant(ctx, "bus", minutes);
    if (A.gears < 50 || B.gears < 50) return { verdict: "inconclusive", summary: `没跑起来: 齿轮 A ${A.gears} / B ${B.gears}`, measured: { A, B } };
    const sameOutput = Math.abs(A.gears - B.gears) / Math.max(A.gears, B.gears) < 0.15;
    const verified = sameOutput && A.belts === 0 && B.belts > 0 && A.assemblers >= B.assemblers * 3 && A.utilization < 0.7;
    const line = (r: typeof A) => `${r.kind === "block" ? "直连" : "过带"}: 齿轮 ${r.gears} (每分钟 ${(r.gears / r.minutes).toFixed(1)}), 板 ${r.plates}, 组装机 ${r.assemblers} 台开工率 ${(r.utilization * 100).toFixed(0)}%, 带子 ${r.belts} 格, 机械臂 ${r.inserters}, 占地 ${r.area.w}×${r.area.h}`;
    return {
      verdict: verified ? "verified" : sameOutput ? "inconclusive" : "refuted",
      summary: `各 ${minutes} 分钟: ${line(A)}; ${line(B)}`,
      measured: { A, B, sameOutput },
    };
  },
};
