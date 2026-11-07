// 蓝图要用的基本吞吐: 传送带 (四级)、熔炉、机械臂。
// 传送带测法: 永续箱 → 装卸机 (沙盘专用, 速度和同级带子一样) → 22 节带子 → 装卸机 → 钢箱; 先跑 20 秒填满, 再数 60 秒进箱多少。
// 熔炉测法: 一台石炉, 塞满铁矿和煤, 跑 64 秒 (= 20 次冶炼) 数铁板。
// 机械臂测法: 箱子 → 机械臂 → 箱子 (没研究任何加成, 手里一次 1 个), 数 60 秒搬了多少。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

const BELT = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local y = a.y + 0.5
local east = defines.direction.east
local src = s.create_entity{name = "infinity-chest", position = {a.x - 13.5, y}, force = f}
src.set_infinity_container_filter(1, {name = "iron-plate", count = 100, mode = "exactly"})
s.create_entity{name = a.loader, position = {a.x - 12, y}, direction = east, type = "output", force = f}
for i = -11, 10 do s.create_entity{name = a.belt, position = {a.x + i + 0.5, y}, direction = east, force = f} end
s.create_entity{name = a.loader, position = {a.x + 12, y}, direction = east, type = "input", force = f}
s.create_entity{name = "steel-chest", position = {a.x + 13.5, y}, force = f}
return {x = a.x + 13.5, y = y}`;

const COUNT_AT = `
local a = ...
local c = game.surfaces[a.surface].find_entity(a.name, {a.ref.x, a.ref.y})
return c.get_inventory(defines.inventory.chest).get_item_count(a.item)`;

async function rate(ctx: ExpContext, ref: unknown, name: string, item: string, warm: number, seconds: number) {
  await ctx.ticks(warm * 60);
  const c0 = (await ctx.lua(COUNT_AT, { ref, name, item })) as number;
  await ctx.ticks(seconds * 60);
  const c1 = (await ctx.lua(COUNT_AT, { ref, name, item })) as number;
  return { c0, c1, perSecond: (c1 - c0) / seconds };
}

const near = (v: number, want: number, tol: number) => Math.abs(v - want) / want <= tol;
const BELT_SOURCES: Experiment["sources"] = [
  { title: "本机原型数据: 传送带 speed (每 tick 移动的格数), 每格每道 4 个物品", credibility: 1 },
  { title: "官方 wiki: Transport belts/Physics", url: "https://wiki.factorio.com/Transport_belts/Physics", credibility: 2 },
];

function beltExp(id: string, belt: string, loader: string, zhName: string, want: number): Experiment {
  return {
    id: `belts.throughput.${id}`,
    topic: "传送带",
    claim: `${zhName}满载每秒运 ${want} 个物品 (两道合计)`,
    refs: ["production.md P1", "production.md P7"],
    sources: BELT_SOURCES,
    gameSeconds: 70,
    async run(ctx) {
      const ref = await ctx.lua(BELT, { belt, loader });
      const m = await rate(ctx, ref, "steel-chest", "iron-plate", 20, 60); // 黄带走完 22 节要 11.7 秒, 预热 20 秒
      return {
        verdict: near(m.perSecond, want, 0.03) ? "verified" : "refuted",
        summary: `60 秒进箱 ${m.c1 - m.c0} 个, 每秒 ${m.perSecond.toFixed(2)} 个`,
        measured: m,
      };
    },
  };
}

export const beltYellow = beltExp("transport-belt", "transport-belt", "loader", "基础传送带 (黄带)", 15);
export const beltRed = beltExp("fast-transport-belt", "fast-transport-belt", "fast-loader", "高速传送带 (红带)", 30);
export const beltBlue = beltExp("express-transport-belt", "express-transport-belt", "express-loader", "极速传送带 (蓝带)", 45);
export const beltGreen = beltExp("turbo-transport-belt", "turbo-transport-belt", "turbo-loader", "超速传送带 (绿带)", 60);

const FURNACE = `
local a = ...
local s = game.surfaces[a.surface]
local fur = s.create_entity{name = "stone-furnace", position = {a.x, a.y}, force = "player"}
fur.insert{name = "coal", count = 50}
fur.insert{name = "iron-ore", count = 50}
return {x = fur.position.x, y = fur.position.y}`;

const FURNACE_OUT = `
local a = ...
local fur = game.surfaces[a.surface].find_entity("stone-furnace", {a.ref.x, a.ref.y})
return {plates = fur.get_output_inventory().get_item_count("iron-plate"), finished = fur.products_finished} -- lint-ok: 石炉没有产能
`;

export const stoneFurnaceRate: Experiment = {
  id: "smelting.stone-furnace.rate",
  topic: "熔炉",
  claim: "一台石炉每 3.2 秒出 1 块铁板 (每秒 0.3125 块), 所以 48 台石炉正好喂满一条黄带 (每秒 15 块)",
  refs: ["production.md P1"],
  sources: [
    { title: "本机原型数据: 石炉 crafting_speed 1, 铁板配方 3.2 秒", credibility: 1 },
    { title: "秦大圣《异星工厂2.0+DLC》冶炼列比例 (B 站专栏)", credibility: 3 },
  ],
  gameSeconds: 70,
  async run(ctx) {
    const ref = await ctx.lua(FURNACE);
    await ctx.ticks(60); // 点火
    const a = (await ctx.lua(FURNACE_OUT, { ref })) as { plates: number; finished: number };
    await ctx.ticks(64 * 60);
    const b = (await ctx.lua(FURNACE_OUT, { ref })) as { plates: number; finished: number };
    const perSecond = (b.finished - a.finished) / 64;
    return {
      verdict: near(perSecond, 0.3125, 0.05) ? "verified" : "refuted",
      summary: `64 秒出 ${b.finished - a.finished} 块, 每秒 ${perSecond.toFixed(3)} 块; 48 台合计每秒 ${(perSecond * 48).toFixed(1)} 块`,
      measured: { ...b, before: a, perSecond },
    };
  },
};

const INSERTER = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
s.create_entity{name = "electric-energy-interface", position = {a.x + 4, a.y}, force = f}
s.create_entity{name = "medium-electric-pole", position = {a.x + 2.5, a.y + 0.5}, force = f}
local from = s.create_entity{name = "iron-chest", position = {a.x + 0.5, a.y - 0.5 - a.reach}, force = f}
from.insert{name = "iron-plate", count = 3000}
-- 机械臂方向 = 取货方向 (北): 从北边箱子取, 放到南边箱子
s.create_entity{name = a.inserter, position = {a.x + 0.5, a.y + 0.5}, direction = defines.direction.north, force = f}
s.create_entity{name = "iron-chest", position = {a.x + 0.5, a.y + 1.5 + a.reach}, force = f}
return {x = a.x + 0.5, y = a.y + 1.5 + a.reach}`;

function inserterExp(id: string, inserter: string, zhName: string, reach: number, want: number, note: string): Experiment {
  return {
    id: `inserters.chest-to-chest.${id}`,
    topic: "机械臂",
    claim: `${zhName}从箱子搬到箱子 (没有手部容量研究) 每秒 ${want} 个 (${note}; 旧版 wiki 和第一版记忆里的 0.83 / 2.31 / 1.15 已过时)`,
    refs: ["CLAUDE.md 机械臂方向 = 取货方向"],
    sources: [
      { title: "本机原型数据: 机械臂 rotation_speed / extension_speed", credibility: 1 },
      { title: "官方 wiki: Inserters, 箱子到箱子速度表 (wiki 注明是 2.0.26 实测数据)", url: "https://wiki.factorio.com/Inserters", credibility: 2 },
    ],
    gameSeconds: 65,
    async run(ctx) {
      const ref = await ctx.lua(INSERTER, { inserter, reach });
      const m = await rate(ctx, ref, "iron-chest", "iron-plate", 5, 60);
      return {
        verdict: near(m.perSecond, want, 0.03) ? "verified" : "refuted",
        summary: `60 秒搬了 ${m.c1 - m.c0} 个, 每秒 ${m.perSecond.toFixed(2)} 个`,
        measured: m,
      };
    },
  };
}

// 预期值: 原型转速算一圈的时间 (取放各半圈), 再参照 wiki 表
export const inserterBasic = inserterExp("inserter", "inserter", "电力机械臂", 0, 0.86, "一来一回 70 tick");
export const inserterFast = inserterExp("fast-inserter", "fast-inserter", "高速机械臂", 0, 2.5, "一来一回 24 tick");
export const inserterLong = inserterExp("long-handed-inserter", "long-handed-inserter", "加长机械臂", 1, 1.25, "一来一回 48 tick, 取放隔一格");
