// 供热塔: 功率 (第一版教训 #3) 和满温照烧 (教训 #4)。
// 测法: 放一座普通品质供热塔, 装固体燃料 (12MJ/个), 跑 30 秒,
//   燃料功率 = (烧掉的燃料个数 × 12MJ + 正在烧那个的剩余能量变化) / 30 秒;
//   热功率 = 温度升高 × 热容 (5MJ/度, 本机原型) / 30 秒 (温度没到 1000 度上限时)。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

const SOURCES: Experiment["sources"] = [
  { title: "本机原型数据: 供热塔 consumption 40MW、effectivity 2.5、specific_heat 5MJ、最高 1000 度", credibility: 1 },
  { title: "游戏内科技说明: 即使达到最高温度也不会停止燃烧", credibility: 1 },
  { title: "官方 wiki: Heating tower", url: "https://wiki.factorio.com/Heating_tower", credibility: 2 },
];

const PLACE = `
local a = ...
local s = game.surfaces[a.surface]
local t = s.create_entity{name = "heating-tower", position = {a.x, a.y}, force = "player"}
if not t then
  local here = {}
  for _, e in pairs(s.find_entities_filtered{area = {{a.x - 3, a.y - 3}, {a.x + 3, a.y + 3}}}) do here[#here + 1] = e.name end
  error("供热塔建不出来: 位置 " .. a.x .. "," .. a.y .. " 能否放置=" .. tostring(s.can_place_entity{name = "heating-tower", position = {a.x, a.y}}) .. " 附近: " .. table.concat(here, ","), 0)
end
t.insert{name = "solid-fuel", count = 100}
if a.temperature then t.temperature = a.temperature end
return {surface = a.surface, name = t.name, x = t.position.x, y = t.position.y}`;

const SNAP = `
local a = ...
local t = game.surfaces[a.ref.surface].find_entity(a.ref.name, {a.ref.x, a.ref.y})
return {
  temperature = t.temperature,
  fuel = t.get_fuel_inventory().get_item_count("solid-fuel"),
  burning = t.burner.remaining_burning_fuel,
  tick = game.tick,
}`;

const REFILL = `
local a = ...
local t = game.surfaces[a.ref.surface].find_entity(a.ref.name, {a.ref.x, a.ref.y})
local inv = t.get_fuel_inventory()
inv.insert{name = "solid-fuel", count = 100 - inv.get_item_count("solid-fuel")}`;

interface Snap { temperature: number; fuel: number; burning: number; tick: number }

/** 测一段时间里的燃料功率和热功率 (MW) */
type Ref = { surface: string; name: string; x: number; y: number };

async function measure(ctx: ExpContext, ref: Ref, seconds: number) {
  const s0 = (await ctx.lua(SNAP, { ref })) as Snap;
  await ctx.ticks(seconds * 60);
  const s1 = (await ctx.lua(SNAP, { ref })) as Snap;
  const dt = (s1.tick - s0.tick) / 60;
  const fuelJ = (s0.fuel - s1.fuel) * 12e6 + (s0.burning - s1.burning);
  return {
    seconds: dt,
    fuelMW: fuelJ / dt / 1e6,
    heatMW: ((s1.temperature - s0.temperature) * 5e6) / dt / 1e6,
    t0: s0.temperature,
    t1: s1.temperature,
  };
}

const near = (v: number, want: number, tol = 0.05) => Math.abs(v - want) / want <= tol;
const r1 = (v: number) => Math.round(v * 10) / 10;

export const heatingTowerPower: Experiment = {
  id: "power.heating-tower.output",
  topic: "电",
  claim: "普通品质供热塔每秒烧 16MW 燃料, 产 40MW 热 (不是 100MW)",
  refs: ["lessons-v1 #3", "gleba.md 本机速查: 供热塔"],
  sources: SOURCES,
  gameSeconds: 32,
  async run(ctx) {
    const ref = (await ctx.lua(PLACE)) as Ref;
    await ctx.ticks(60); // 先点着
    const m = await measure(ctx, ref, 30);
    const ok = near(m.fuelMW, 16) && near(m.heatMW, 40) && m.t1 < 1000;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `实测燃料 ${r1(m.fuelMW)}MW、产热 ${r1(m.heatMW)}MW (30 秒内从 ${Math.round(m.t0)} 度升到 ${Math.round(m.t1)} 度)`,
      measured: m,
    };
  },
};

export const heatingTowerBurnsAtMax: Experiment = {
  id: "power.heating-tower.burns-at-max",
  topic: "电",
  claim: "供热塔到了最高温度 1000 度、没有地方用热时, 照样按 16MW 烧燃料 (白烧)",
  refs: ["lessons-v1 #4", "gleba.md 本机速查: 供热塔", "research README 第一轮 #5"],
  sources: SOURCES,
  gameSeconds: 32,
  async run(ctx) {
    const ref = (await ctx.lua(PLACE, { temperature: 1000 })) as Ref;
    await ctx.ticks(60);
    await ctx.lua(REFILL, { ref });
    const m = await measure(ctx, ref, 30);
    const burning = m.fuelMW > 1;
    return {
      verdict: burning && near(m.fuelMW, 16) ? "verified" : "refuted",
      summary: `满温 ${Math.round(m.t0)}→${Math.round(m.t1)} 度、没有用热的建筑时, 30 秒里仍烧掉 ${r1(m.fuelMW)}MW 燃料`,
      measured: m,
    };
  },
};
