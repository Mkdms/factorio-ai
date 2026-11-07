// 插件效果分享塔 2.0 公式 (检索 production.md P9~P11、P15; 本机原型 distribution_effectivity 1.5, profile 1/sqrt(n)):
//   n 座塔作用到同一台机器, 每座的传输强度 = 1.5 / sqrt(n), 总效果 = 1.5 × sqrt(n) × 单座塔里插件的效果。
// 测法: 组装机2型 (配方铁齿轮) 四周依次放 1、2、4、8 座分享塔, 每座装 2 个速度插件 3 (+50% × 2 = +100%),
//   读机器的 speed_bonus: 预期 1.5、2.12、3.0、4.24。
import type { Experiment } from "../src/verify/types.ts";

const SETUP = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
-- 两座广域配电站 (供电范围 9) 各带一个电力接口, 盖住中间 ±10 格
for _, dx in ipairs({-9, 9}) do
  s.create_entity{name = "substation", position = {a.x + dx, a.y}, force = f}
  s.create_entity{name = "electric-energy-interface", position = {a.x + dx * 1.5, a.y}, force = f}
end
local m = s.create_entity{name = "assembling-machine-2", position = {a.x, a.y}, force = f}
m.set_recipe("iron-gear-wheel")
return {x = m.position.x, y = m.position.y}`;

const ADD_BEACONS = `
local a = ...
local s = game.surfaces[a.surface]
for _, d in ipairs(a.offsets) do
  local b = s.create_entity{name = "beacon", position = {a.x + d[1], a.y + d[2]}, force = "player"}
  b.get_module_inventory().insert{name = "speed-module-3", count = 2}
end`;

const READ = `
local a = ...
local m = game.surfaces[a.surface].find_entity("assembling-machine-2", {a.ref.x, a.ref.y})
return {speed_bonus = m.speed_bonus, beacons = #m.get_beacons(), status = m.status}`;

export const beaconSqrtRule: Experiment = {
  id: "modules.beacon.sqrt-rule",
  topic: "插件",
  claim: "分享塔 2.0 递减规则: n 座塔 (各装 2 个速度插件 3) 给同一台机器的总加速 = 1.5 × √n × 100%, 即 1 / 2 / 4 / 8 座 = +150% / +212% / +300% / +424%",
  refs: ["production.md P9", "production.md P10", "production.md P15 (B 站维基的\"一半效果\"已过时)"],
  sources: [
    { title: "本机原型数据: beacon distribution_effectivity 1.5, profile[n] = 1/√n", credibility: 1 },
    { title: "官方 wiki: Beacon, Transmission strength 表", url: "https://wiki.factorio.com/Beacon", date: "2026-10-31", credibility: 2 },
  ],
  gameSeconds: 10,
  async run(ctx) {
    const ref = await ctx.lua(SETUP);
    const rounds: { add: number[][]; n: number; want: number }[] = [
      { add: [[0, -4]], n: 1, want: 1.5 },
      { add: [[0, 4]], n: 2, want: 1.5 * Math.SQRT2 },
      { add: [[-4, 0], [4, 0]], n: 4, want: 3.0 },
      { add: [[-4, -4], [4, -4], [-4, 4], [4, 4]], n: 8, want: 1.5 * Math.sqrt(8) },
    ];
    const measured: Record<string, { speed_bonus: number; beacons: number; want: number }> = {};
    let ok = true;
    for (const r of rounds) {
      await ctx.lua(ADD_BEACONS, { offsets: r.add });
      await ctx.ticks(60);
      const m = (await ctx.lua(READ, { ref })) as { speed_bonus: number; beacons: number };
      measured[`n=${r.n}`] = { ...m, want: r.want };
      if (m.beacons !== r.n || Math.abs(m.speed_bonus - r.want) > 0.01) ok = false;
    }
    const line = Object.entries(measured).map(([k, v]) => `${k}: +${(v.speed_bonus * 100).toFixed(0)}% (预期 ${(v.want * 100).toFixed(0)}%)`).join(", ");
    return { verdict: ok ? "verified" : "refuted", summary: line, measured };
  },
};
