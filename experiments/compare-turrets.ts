// 思路并排比: 激光炮塔 vs 机枪炮塔 (穿甲弹) 的"补给代价" (P-def-06 的 A vs C; 用户的科技上限原则第一条"弹药/燃料能持续供上")。
// 同一条走廊 (compare-walls 的场地: 南北水封, 虫子只能正面来), 同样 2 厚实墙、同样 20 座炮塔 (两列各 10), 同样两档波次;
//   A 机枪炮塔: 每座先装 50 个穿甲弹匣, 打完数剩下的 → 耗了多少弹匣 → 折成铁板 / 铜板 (本机配方: 2 穿甲 = 2 普通弹匣 (8 铁) + 1 钢 (5 铁) + 2 铜);
//   B 激光炮塔: 读电网统计里 laser-turret 的耗电 (input_counts, lab.md #14) → MJ → 折成煤 (4MJ/块, 锅炉链 100% 时的下限)。
// 量: 打完用时、墙 / 炮塔损失、钻过墙的虫、每波的补给 (弹匣数、铁铜当量 / 兆焦、煤当量)。没有伤害研究 (新图, 两边一样)。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

const ARENA = { dx: -200 };

const BUILD = `
local a = ...
local s = game.surfaces[a.surface]
local ox, oy = a.ox, a.oy
for _, e in pairs(s.find_entities_filtered{area = {{ox - 75, oy - 30}, {ox + 75, oy + 30}}}) do
  if e.valid and e.type ~= "character" then e.destroy() end
end
local tiles = {}
for x = ox - 70, ox + 70 do
  for _, y in ipairs({oy - 23, oy - 22, oy - 21, oy + 21, oy + 22, oy + 23}) do tiles[#tiles + 1] = {name = "water", position = {x, y}} end
end
for x = ox - 70, ox - 68 do for y = oy - 23, oy + 23 do tiles[#tiles + 1] = {name = "water", position = {x, y}} end end
s.set_tiles(tiles, true, true, true)
-- 炮塔 (2×2): 两列各 10 座
local turrets = {}
for _, x in ipairs({ox - 30, ox - 28}) do
  for y = oy - 19, oy + 17, 4 do
    local t = lab.place{surface = s, name = a.turret, position = {x, y}}
    if a.turret == "gun-turret" then t.insert{name = "piercing-rounds-magazine", count = a.mags} end
    turrets[#turrets + 1] = t
  end
end
-- 2 厚实墙
local walls = 0
for _, tx in ipairs({ox - 25, ox - 24}) do for ty = oy - 20, oy + 20 do lab.place{surface = s, name = "stone-wall", position = {tx + 0.5, ty + 0.5}} walls = walls + 1 end end
local radar
for _, dy in ipairs({-6, 6}) do radar = lab.place{surface = s, name = "radar", position = {ox - 50, oy + dy}} end
-- 血量上限 = 刚建出来的实体的血 (2.1 原型没有 max_health 属性, 要 get_max_health(quality); 直接读实体最稳)
local wall1 = s.find_entities_filtered{area = {{ox - 26, oy - 21}, {ox - 23, oy + 21}}, name = "stone-wall"}[1]
return {walls = walls, turrets = #turrets, turret_max = turrets[1].health, wall_max = wall1.health, radar_max = radar.health}`;

const SPAWN = `
local a = ...
local s = game.surfaces[a.surface]
local ox, oy = a.ox, a.oy
local g = s.create_unit_group{position = {ox + 55, oy}, force = "enemy"}
local n = 0
for i = 0, a.medium + a.big - 1 do
  local name = i < a.big and "big-biter" or "medium-biter"
  local pos = s.find_non_colliding_position(name, {ox + 50 + (i % 8) * 2, oy - 14 + math.floor(i / 8) * 3}, 6, 0.5)
  local u = pos and s.create_entity{name = name, position = pos, force = "enemy"}
  if u then g.add_member(u) n = n + 1 end
end
g.set_command{type = defines.command.attack_area, destination = {ox - 50, oy}, radius = 12, distraction = defines.distraction.by_enemy}
return n`;

// 状态 + 补给读数: 机枪数弹匣, 激光读电网统计 (走廊里的配电站都在一张网上, 任取一座)
const STATE = `
local a = ...
local s = game.surfaces[a.surface]
local ox, oy = a.ox, a.oy
local area = {{ox - 75, oy - 30}, {ox + 75, oy + 30}}
local alive, past = 0, 0
for _, u in pairs(s.find_entities_filtered{area = area, force = "enemy", type = "unit"}) do
  alive = alive + 1
  if u.position.x < ox - 26 then past = past + 1 end
end
local function sum(name)
  local n, hp = 0, 0
  for _, e in pairs(s.find_entities_filtered{area = area, name = name}) do n = n + 1 hp = hp + e.health end
  return n, hp
end
local wn, wh = sum("stone-wall")
local tn, th = sum(a.turret)
local rn, rh = sum("radar")
local mags, powered = 0, 0
for _, t in pairs(s.find_entities_filtered{area = area, name = a.turret}) do
  if a.turret == "gun-turret" then
    local inv = t.get_inventory(defines.inventory.turret_ammo)
    if inv then mags = mags + inv.get_item_count("piercing-rounds-magazine") end
  else
    if t.energy > 0 then powered = powered + 1 end
  end
end
local joules = 0
local sub = s.find_entities_filtered{area = area, name = "substation"}[1]
if sub and sub.valid then
  local st = sub.electric_network_statistics
  joules = st.get_input_count("laser-turret") or 0
end
return {alive = alive, past = past, walls = wn, wall_hp = wh, turrets = tn, turret_hp = th, radars = rn, radar_hp = rh, mags = mags, powered = powered, joules = joules, tick = game.tick}`;

interface State { alive: number; past: number; walls: number; wall_hp: number; turrets: number; turret_hp: number; radars: number; radar_hp: number; mags: number; powered: number; joules: number; tick: number }

const MAGS = 50;

async function round(ctx: ExpContext, turret: "gun-turret" | "laser-turret", ox: number, oy: number, wave: { medium: number; big: number }) {
  const built = (await ctx.lua(BUILD, { turret, ox, oy, mags: MAGS })) as { walls: number; turrets: number; turret_max: number; wall_max: number; radar_max: number };
  // 供电: 场地西半边 (炮塔和雷达) 按原型供电半径铺满, 不手摆
  await ctx.lab.rpc("power_area", { surface: ctx.surface, area: [[ox - 60, oy - 20], [ox - 27, oy + 20]], inset: 4 });
  await ctx.powered();
  await ctx.ticks(10 * 60);
  const before = (await ctx.lua(STATE, { ox, oy, turret })) as State;
  if (turret === "laser-turret" && before.powered < built.turrets) throw new Error(`激光炮塔只有 ${before.powered}/${built.turrets} 座有电`);
  const spawned = (await ctx.lua(SPAWN, { ox, oy, medium: wave.medium, big: wave.big })) as number;
  let st = before, maxPast = 0, seconds = 0;
  for (; seconds < 150; seconds += 2) {
    await ctx.ticks(120);
    st = (await ctx.lua(STATE, { ox, oy, turret })) as State;
    maxPast = Math.max(maxPast, st.past);
    if (st.alive === 0) break;
  }
  const wallMax = built.wall_max, turretMax = built.turret_max, radarMax = built.radar_max; // 血量上限 = 刚建出来时的血, 不手写
  const magsUsed = turret === "gun-turret" ? built.turrets * MAGS - st.mags : 0;
  const mj = turret === "laser-turret" ? (st.joules - before.joules) / 1e6 : 0;
  return {
    turret, wave: `${wave.medium}中+${wave.big}大`, spawned, seconds: seconds + 2, survivors: st.alive, maxPast,
    walls: built.walls, wallsLost: built.walls - st.walls, wallDamage: built.walls * wallMax - st.wall_hp,
    turretsLost: built.turrets - st.turrets, turretDamage: built.turrets * turretMax - st.turret_hp,
    radarDamage: 2 * radarMax - st.radar_hp,
    magsUsed, mj,
  };
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

export const laserVsGunSupply: Experiment = {
  id: "compare.turrets.laser-vs-gun-supply",
  topic: "防御",
  claim: "同一条防线、同样 20 座炮塔、没有伤害研究: 机枪炮塔 (穿甲弹) 每波要吃掉几百个弹匣 (持续供弹线, 折成几千铁板), 激光炮塔只耗一两百 MJ 电 (折成几十块煤); 而且中大型撕咬虫面前穿甲机枪火力也不够 (墙和炮塔损失更大) —— 没有伤害研究时激光在补给和火力上都占优, 机枪要靠研究和贫铀弹才追上 (科技上限原则: 弹药能不能持续供上)",
  refs: ["knowledge/patterns/defense.md P-def-06 (A 机枪 + 墙 vs C 激光 + 墙)", "knowledge/patterns/defense.md P-def-08/09 (补给链随炮塔变)", "requirements 科技上限原则"],
  sources: [
    { title: "本机原型: 机枪炮塔射程 18 / 400 血, 激光炮塔射程 24 / 1000 血 / 一发 800kJ; 穿甲弹配方 2 普通弹匣 + 1 钢 + 2 铜 → 2", credibility: 1 },
    { title: "defense.md P-def-06 的分歧 (论坛 2025-03): \"机枪已不是最好\" vs \"火焰 + 墙 + 重炮就够\"", credibility: 3 },
  ],
  gameSeconds: 900,
  allowUnpowered: true,
  async run(ctx) {
    const ox = ARENA.dx, oy = ctx.y;
    ctx.watch([[ox - 75, oy - 30], [ox + 75, oy + 30]]);
    await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area: [[ox - 75, oy - 30], [ox + 75, oy + 30]], no_enemies: true }, { timeoutMs: 120_000 });
    await ctx.lab.rpc("viewer", { position: [ox - 10, oy - 27], zoom: 0.45, surface: ctx.surface }, { retry: true }).catch(() => undefined);
    const results: Awaited<ReturnType<typeof round>>[] = [];
    const waves = [{ medium: 20, big: 5 }, { medium: 60, big: 20 }];
    for (const wave of waves) {
      for (let i = 0; i < 2; i++) {
        for (const turret of ["gun-turret", "laser-turret"] as const) {
          await ctx.say(`${wave.medium} 中型 + ${wave.big} 大型, 第 ${i + 1} 轮: ${ctx.zh(turret)}`);
          results.push(await round(ctx, turret, ox, oy, wave));
        }
      }
    }
    // 穿甲弹匣的原料: 1 个 = 普通弹匣 1 (4 铁) + 钢 0.5 (2.5 铁) + 铜 1 → 6.5 铁 + 1 铜; 煤 4MJ/块
    const iron = (m: number) => m * 6.5, copper = (m: number) => m * 1, coal = (mj: number) => mj / 4;
    const parts: string[] = [];
    const per: Record<string, { gun: typeof results; laser: typeof results }> = {};
    for (const wave of waves) {
      const tag = `${wave.medium}中+${wave.big}大`;
      const G = results.filter((r) => r.turret === "gun-turret" && r.wave === tag), L = results.filter((r) => r.turret === "laser-turret" && r.wave === tag);
      per[tag] = { gun: G, laser: L };
      const line = (rs: typeof results, name: string) => `${name}: 用时 ${avg(rs.map((r) => r.seconds)).toFixed(0)} 秒, 墙损 ${avg(rs.map((r) => r.wallDamage)).toFixed(0)} 血, 炮塔损 ${avg(rs.map((r) => r.turretDamage)).toFixed(0)} 血 (拆 ${avg(rs.map((r) => r.turretsLost)).toFixed(1)} 座), 钻过墙最多 ${Math.max(...rs.map((r) => r.maxPast))} 只${rs.some((r) => r.survivors > 0) ? ", 有轮次没打完" : ""}`;
      const mags = avg(G.map((r) => r.magsUsed)), mj = avg(L.map((r) => r.mj));
      parts.push(`【${tag}】${line(G, "机枪")}, 耗弹匣 ${mags.toFixed(0)} (≈ 铁 ${iron(mags).toFixed(0)} + 铜 ${copper(mags).toFixed(0)}); ${line(L, "激光")}, 耗电 ${mj.toFixed(0)}MJ (≈ 煤 ${coal(mj).toFixed(0)} 块)`);
    }
    const small = per[`${waves[0].medium}中+${waves[0].big}大`], big = per[`${waves[1].medium}中+${waves[1].big}大`];
    const gunMagsSmall = avg(small.gun.map((r) => r.magsUsed)), laserCoalSmall = coal(avg(small.laser.map((r) => r.mj)));
    const laserHoldsSmall = small.laser.every((r) => r.survivors === 0 && r.turretsLost === 0);
    const laserCheaper = gunMagsSmall > 0 && iron(gunMagsSmall) > laserCoalSmall * 3; // 原料数量级: 弹药的铁远多于激光的煤
    const loss = (r: (typeof results)[0]) => r.wallDamage + r.turretDamage;
    const bigLaserWorse = avg(big.laser.map(loss)) > avg(big.gun.map(loss)) * 1.15;
    const bigGunWorse = avg(big.gun.map(loss)) > avg(big.laser.map(loss)) * 1.15;
    const laserNotWeaker = avg(small.laser.map(loss)) <= avg(small.gun.map(loss)) && !bigLaserWorse;
    let verdict: "verified" | "refuted" | "inconclusive" = "inconclusive";
    if (laserHoldsSmall && laserCheaper && laserNotWeaker) verdict = "verified";
    else if (!laserCheaper || bigLaserWorse) verdict = "refuted";
    const tail = bigLaserWorse ? "大波激光损失更大 (对大型虫慢)" : bigGunWorse ? "大波机枪损失更大" : "大波两边损失相近";
    return { verdict, summary: parts.join(" ‖ ") + " → " + tail, measured: { results, gunMagsSmall, laserCoalSmall, laserHoldsSmall, laserCheaper, laserNotWeaker, bigLaserWorse, bigGunWorse } };
  },
};
