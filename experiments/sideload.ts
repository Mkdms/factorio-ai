// 传送带侧向汇入 (CLAUDE.md 事实, 2026-10-31 审查时实测过一次, 这里做成可回归的实验):
//   朝东的带子, 南边有一条朝北的带子顶上来:
//   A. 它后面 (西边) 没有朝它送的带子 → 它变成弯道 (把南边那条当作上游);
//   B. 西边有朝东的带子 → 直带, 南边那条是侧向汇入, 物品只上靠南的那一道 (右道);
//   C. 西边没带子, 但南北两边都有带子顶上来 → 直带。
import type { Experiment } from "../src/verify/types.ts";

const BUILD = `
local a = ...
local s = game.surfaces[a.surface]
local d = defines.direction
local function belt(dx, dy, dir) return s.create_entity{name = "transport-belt", position = {a.x + dx + 0.5, a.y + dy + 0.5}, direction = dir, force = "player"} end
for _, e in pairs(s.find_entities_filtered{area = {{a.x - 5, a.y - 5}, {a.x + 5, a.y + 5}}, name = "transport-belt"}) do e.destroy() end
local target = belt(0, 0, d.east)
belt(1, 0, d.east)
if a.upstream then belt(-1, 0, d.east) end
if a.south then belt(0, 1, d.north) end
if a.north then belt(0, -1, d.south) end
return {shape = target.belt_shape}`;

// 从南边那条带子送 20 个铁板上去, 跑一会儿, 看目标带子和下游带子两道各有多少
const LANES = `
local a = ...
local s = game.surfaces[a.surface]
local feeder = s.find_entity("transport-belt", {a.x + 0.5, a.y + 1.5})
for i = 1, 20 do
  feeder.get_transport_line(1).insert_at_back({name = "iron-plate", count = 1}) -- lint-ok: 只要两道上各有货, 每道进 1 个也够 (循环其实多余)
  feeder.get_transport_line(2).insert_at_back({name = "iron-plate", count = 1}) -- lint-ok: 只要两道上各有货, 每道进 1 个也够 (循环其实多余)
end
return true`;

const COUNT = `
local a = ...
local s = game.surfaces[a.surface]
local left, right = 0, 0
for _, dx in ipairs({0, 1}) do
  local b = s.find_entity("transport-belt", {a.x + dx + 0.5, a.y + 0.5})
  left = left + b.get_transport_line(1).get_item_count()
  right = right + b.get_transport_line(2).get_item_count()
end
return {left = left, right = right}`;

export const beltSideload: Experiment = {
  id: "belts.sideload.shape-and-lane",
  topic: "传送带",
  claim: "侧向汇入: 被汇入那格的上游要有朝它送的带子 (或两侧都有汇入), 否则它变成弯道; 真正的侧向汇入只把物品放到靠近来向的那一道",
  refs: ["CLAUDE.md 游戏事实 (2026-10-31 审查改)", "rules-review 第 4 节 ②"],
  sources: [
    { title: "本机 2.1.24 沙盘实测 (2026-10-31 规则审查)", credibility: 1 },
    { title: "官方 wiki: Transport belts/Physics (Side-loading)", url: "https://wiki.factorio.com/Transport_belts/Physics", credibility: 2 },
  ],
  gameSeconds: 5,
  async run(ctx) {
    const A = (await ctx.lua(BUILD, { south: true })) as { shape: string };
    const C = (await ctx.lua(BUILD, { south: true, north: true })) as { shape: string };
    const B = (await ctx.lua(BUILD, { south: true, upstream: true })) as { shape: string };
    await ctx.lua(LANES);
    await ctx.ticks(120);
    const lanes = (await ctx.lua(COUNT)) as { left: number; right: number };
    const shapesOk = A.shape !== "straight" && B.shape === "straight" && C.shape === "straight";
    const lanesOk = lanes.right > 0 && lanes.left === 0;
    const zhShape = (s: string) => (s === "straight" ? "直" : "弯");
    return {
      verdict: shapesOk && lanesOk ? "verified" : "refuted",
      summary: `只有南边顶上来: ${zhShape(A.shape)}; 南北都顶: ${zhShape(C.shape)}; 西边有上游 + 南边顶: ${zhShape(B.shape)}, 送上来的 ${lanes.left + lanes.right} 个全在右道 (左道 ${lanes.left}、右道 ${lanes.right})`,
      measured: { only_south: A.shape, both_sides: C.shape, upstream_and_south: B.shape, lanes },
    };
  },
};
