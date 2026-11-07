// 电线杆: 连线距离和供电范围 (蓝图布局要用; 本机原型 maximum_wire_distance / supply_area_distance)。
//   小型电线杆 7.5 / 2.5, 中型电线杆 9 / 3.5, 远程输电塔 32 / 2, 广域配电站 18 / 9。
// 连线测法: 两根杆子放在正好最大距离和再远 1 格, 用铜线接点的 can_wire_reach 判断。
// 供电测法: 杆子旁放电力接口; 一个电力机械臂放在供电范围最外一格 (有电) 和再外一格 (没电), 看状态。
import type { Experiment } from "../src/verify/types.ts";

interface Pole { name: string; zh: string; wire: number; supply: number; size: number }
const POLES: Pole[] = [
  { name: "small-electric-pole", zh: "小型电线杆", wire: 7.5, supply: 2.5, size: 1 },
  { name: "medium-electric-pole", zh: "中型电线杆", wire: 9, supply: 3.5, size: 1 },
  { name: "big-electric-pole", zh: "远程输电塔", wire: 32, supply: 2, size: 2 },
  { name: "substation", zh: "广域配电站", wire: 18, supply: 9, size: 2 },
];

// 1×1 的杆子中心在 .5 上, 2×2 的在整数上
const center = (p: Pole, v: number) => (p.size === 1 ? Math.floor(v) + 0.5 : Math.round(v));

const REACH = `
local a = ...
local s = game.surfaces[a.surface]
local p1 = s.create_entity{name = a.name, position = {a.x1, a.y1}, force = "player"}
local p2 = s.create_entity{name = a.name, position = {a.x1 + a.dx, a.y1 + a.dy}, force = "player"}
local c1 = p1.get_wire_connector(defines.wire_connector_id.pole_copper, true)
local c2 = p2.get_wire_connector(defines.wire_connector_id.pole_copper, true)
local ddx, ddy = p2.position.x - p1.position.x, p2.position.y - p1.position.y
local r = {reach = c1.can_wire_reach(c2), dist = math.sqrt(ddx * ddx + ddy * ddy)}
p1.destroy() p2.destroy()
return r`;

// 1×1 的杆子中心都在 .5 上, 横向距离只能是整数, 7.5 这种要斜着放: 这里给每种杆子一对"刚够到"和"刚够不到"的偏移
const PAIRS: Record<string, { ok: [number, number]; no: [number, number] }> = {
  "small-electric-pole": { ok: [7, 2], no: [7, 3] }, // 7.28 / 7.62 夹 7.5
  "medium-electric-pole": { ok: [9, 0], no: [10, 0] },
  "big-electric-pole": { ok: [32, 0], no: [33, 0] },
  substation: { ok: [18, 0], no: [19, 0] },
};

const SUPPLY = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local pole = s.create_entity{name = a.name, position = {a.px, a.py}, force = f}
local eei = s.create_entity{name = "electric-energy-interface", position = {a.px, a.py + a.half + 1}, force = f}
local ins = s.create_entity{name = "inserter", position = {a.ix, a.py}, force = f, direction = defines.direction.north}
return {ix = ins.position.x, px = pole.position.x}`;

const STATUS = `
local a = ...
local names = {}
for k, v in pairs(defines.entity_status) do names[v] = k end
local r = {}
for _, e in pairs(game.surfaces[a.surface].find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}}) do
  if e.name == "inserter" then r[#r + 1] = names[e.status] or tostring(e.status) end
  if e.valid and e.type ~= "character" then e.destroy() end
end
return r`;

export const poleWireReach: Experiment = {
  id: "power.poles.wire-reach",
  topic: "电",
  claim: "电线杆最大连线距离 (中心到中心): 小型电线杆 7.5、中型电线杆 9、远程输电塔 32、广域配电站 18; 再远 1 格就连不上",
  refs: ["蓝图布局 (电线杆间距)"],
  sources: [
    { title: "本机原型数据: electric-pole maximum_wire_distance", credibility: 1 },
    { title: "官方 wiki: Electric pole", url: "https://wiki.factorio.com/Electric_pole", credibility: 2 },
  ],
  gameSeconds: 0,
  async run(ctx) {
    const measured: Record<string, unknown> = {};
    let ok = true;
    for (const p of POLES) {
      const x1 = center(p, ctx.x - 18), y1 = center(p, ctx.y - 6);
      const pair = PAIRS[p.name];
      const at = (await ctx.lua(REACH, { name: p.name, x1, y1, dx: pair.ok[0], dy: pair.ok[1] })) as { reach: boolean; dist: number };
      const beyond = (await ctx.lua(REACH, { name: p.name, x1, y1, dx: pair.no[0], dy: pair.no[1] })) as { reach: boolean; dist: number };
      measured[p.name] = { at, beyond, limit: p.wire };
      if (!at.reach || beyond.reach || at.dist > p.wire || beyond.dist <= p.wire) ok = false;
    }
    const line = POLES.map((p) => {
      const m = measured[p.name] as { at: { reach: boolean; dist: number }; beyond: { reach: boolean; dist: number } };
      return `${p.zh} (上限 ${p.wire}) ${m.at.dist.toFixed(2)} 格${m.at.reach ? "通" : "不通"}、${m.beyond.dist.toFixed(2)} 格${m.beyond.reach ? "通" : "不通"}`;
    }).join("; ");
    return { verdict: ok ? "verified" : "refuted", summary: line, measured };
  },
};

export const poleSupplyArea: Experiment = {
  id: "power.poles.supply-area",
  topic: "电",
  claim: "供电范围 (从杆子中心算的半边长): 小型电线杆 2.5 (5×5)、中型电线杆 3.5 (7×7)、远程输电塔 2 (4×4)、广域配电站 9 (18×18); 建筑只要有一格碰到范围就有电",
  refs: ["蓝图布局 (电线杆覆盖)"],
  sources: [
    { title: "本机原型数据: electric-pole supply_area_distance", credibility: 1 },
    { title: "官方 wiki: Electric pole", url: "https://wiki.factorio.com/Electric_pole", credibility: 2 },
  ],
  gameSeconds: 8,
  allowUnpowered: true, // 这个实验故意把机械臂放在供电范围外
  async run(ctx) {
    const measured: Record<string, unknown> = {};
    let ok = true;
    for (const p of POLES) {
      const px = center(p, ctx.x), py = center(p, ctx.y);
      const half = p.size / 2;
      const results: string[] = [];
      // 机械臂 1×1, 中心在 .5: 范围内最外一格的中心 = px + supply - 0.5 (取 .5 格点); 再外一格 +1
      const edge = Math.floor(px + p.supply - 0.5) + 0.5;
      for (const ix of [edge, edge + 1]) {
        await ctx.lua(SUPPLY, { name: p.name, px, py, half, ix });
        await ctx.ticks(60);
        const st = (await ctx.lua(STATUS)) as string[];
        results.push(st[0] ?? "没读到");
      }
      measured[p.name] = { edge, inside: results[0], outside: results[1] };
      if (results[0] === "no_power" || results[0] === "没读到" || results[1] !== "no_power") ok = false;
    }
    const line = POLES.map((p) => {
      const m = measured[p.name] as { inside: string; outside: string };
      return `${p.zh}: 范围内${m.inside === "no_power" ? "没电" : "有电"}、范围外${m.outside === "no_power" ? "没电" : "有电"}`;
    }).join("; ");
    return { verdict: ok ? "verified" : "refuted", summary: line, measured };
  },
};
