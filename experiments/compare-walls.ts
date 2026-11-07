// 思路并排比: 龙牙墙 (朋友基地的做法, P-friend-16) vs 2 厚实墙 (社区主流, friend-questions FQ6-4)。
// 网上的说法 (FQ6-2): 龙牙墙的原理是"减速, 让炮塔多开几枪", 不是挡住。
//
// 场地 (在实验区外单独开, x 为负的一侧, 不和别的实验挤): 东西向走廊, 南北两侧用 3 格宽的水封死, 西头也封住,
// 虫子从东边来, 只能正面穿过防线去打西边的雷达。
//   炮塔: 两列激光炮塔 (各 10 座, 贴着放), 三座广域配电站 + 电力接口供电。
//   A 龙牙墙: 3 列错位短墙, 每段 3 格、段间 1 格孔, 列间空 1 格, 离炮塔 2 格。
//   B 实墙: 2 列连续墙, 离炮塔 2 格。
//   每轮: 同一波 60 只中型撕咬虫 + 20 只大型撕咬虫, 编成一群, 命令攻击西边的雷达。
//   两档波次 (20 中 + 5 大 / 60 中 + 20 大), 每档每种墙 2 轮, 每轮重建。量: 打完用时、墙损失 (血 + 被拆的)、炮塔损失、虫子有没有钻过去。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

const ARENA = { dx: -200 }; // 场地中心 x = -200, y 跟着实验区

const BUILD = `
local a = ...
local s = game.surfaces[a.surface]
local ox, oy = a.ox, a.oy
-- 清场
for _, e in pairs(s.find_entities_filtered{area = {{ox - 75, oy - 30}, {ox + 75, oy + 30}}}) do
  if e.valid and e.type ~= "character" then e.destroy() end
end
-- 走廊: 南北各 3 格水, 西头 3 格水
local tiles = {}
for x = ox - 70, ox + 70 do
  for _, y in ipairs({oy - 23, oy - 22, oy - 21, oy + 21, oy + 22, oy + 23}) do tiles[#tiles + 1] = {name = "water", position = {x, y}} end
end
for x = ox - 70, ox - 68 do for y = oy - 23, oy + 23 do tiles[#tiles + 1] = {name = "water", position = {x, y}} end end
s.set_tiles(tiles, true, true, true)
-- 电: 三座广域配电站 (供电半边长 9, 间距 14 < 18 连线距离) + 电力接口
local subs = {}
for i, dy in ipairs({-14, 0, 14}) do
  subs[i] = lab.place{surface = s, name = "substation", position = {ox - 36, oy + dy}}
  if i > 1 then subs[i - 1].get_wire_connector(defines.wire_connector_id.pole_copper, true).connect_to(subs[i].get_wire_connector(defines.wire_connector_id.pole_copper, true)) end
end
lab.place{surface = s, name = "electric-energy-interface", position = {ox - 40, oy}}
-- 雷达那边再一座配电站 (离中间那座 12 格 < 18), 不然雷达没电
local far = lab.place{surface = s, name = "substation", position = {ox - 48, oy}}
subs[2].get_wire_connector(defines.wire_connector_id.pole_copper, true).connect_to(far.get_wire_connector(defines.wire_connector_id.pole_copper, true))
-- 两列激光炮塔 (2×2, 中心在整数格点), 每列 10 座, y = -19, -15, ... 17
local turrets = 0
for _, x in ipairs({ox - 30, ox - 28}) do
  for y = oy - 19, oy + 17, 4 do lab.place{surface = s, name = "laser-turret", position = {x, y}} turrets = turrets + 1 end
end
-- 墙: 走廊内 y = -20 .. 20 (41 格)
local walls = 0
local function wall(tx, ty) lab.place{surface = s, name = "stone-wall", position = {tx + 0.5, ty + 0.5}} walls = walls + 1 end
if a.kind == "teeth" then
  for col = 0, 2 do
    local tx = ox - 25 + col * 2           -- 三列: 离炮塔 2 格起, 列间空 1 格
    for ty = oy - 20, oy + 20 do
      if (ty - oy + 20 + col * 2) % 4 ~= 3 then wall(tx, ty) end -- 每 4 格留 1 格孔, 列与列错开 2 格
    end
  end
else
  for _, tx in ipairs({ox - 25, ox - 24}) do for ty = oy - 20, oy + 20 do wall(tx, ty) end end
end
-- 目标: 西边两座雷达
for _, dy in ipairs({-6, 6}) do lab.place{surface = s, name = "radar", position = {ox - 50, oy + dy}} end
return {walls = walls, turrets = turrets}`;

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

const STATE = `
local a = ...
local s = game.surfaces[a.surface]
local ox, oy = a.ox, a.oy
local area = {{ox - 75, oy - 30}, {ox + 75, oy + 30}}
local alive, past = 0, 0
for _, u in pairs(s.find_entities_filtered{area = area, force = "enemy", type = "unit"}) do
  alive = alive + 1
  if u.position.x < ox - 26 then past = past + 1 end -- 钻到墙后面 (炮塔这一侧) 的
end
local function sum(name)
  local n, hp = 0, 0
  for _, e in pairs(s.find_entities_filtered{area = area, name = name}) do n = n + 1 hp = hp + e.health end
  return n, hp
end
local wn, wh = sum("stone-wall")
local tn, th = sum("laser-turret")
local rn, rh = sum("radar")
local powered = 0
for _, t in pairs(s.find_entities_filtered{area = area, name = "laser-turret"}) do if t.energy > 0 then powered = powered + 1 end end
return {alive = alive, past = past, walls = wn, wall_hp = wh, turrets = tn, turret_hp = th, radars = rn, radar_hp = rh, powered = powered, tick = game.tick}`;

interface State { alive: number; past: number; walls: number; wall_hp: number; turrets: number; turret_hp: number; radars: number; radar_hp: number; powered: number; tick: number }

async function round(ctx: ExpContext, kind: "teeth" | "solid", ox: number, oy: number, wave: { medium: number; big: number }) {
  const built = (await ctx.lua(BUILD, { kind, ox, oy })) as { walls: number; turrets: number };
  await ctx.powered(); // 开打前: 场地里 (已 watch 登记) 用电的东西都要有电
  await ctx.ticks(10 * 60); // 激光炮塔充电
  const before = (await ctx.lua(STATE, { ox, oy })) as State;
  if (before.powered < built.turrets) throw new Error(`激光炮塔只有 ${before.powered}/${built.turrets} 座有电`);
  const spawned = (await ctx.lua(SPAWN, { ox, oy, medium: wave.medium, big: wave.big })) as number;
  let st = before, maxPast = 0, seconds = 0;
  for (; seconds < 150; seconds += 2) {
    await ctx.ticks(120);
    st = (await ctx.lua(STATE, { ox, oy })) as State;
    maxPast = Math.max(maxPast, st.past);
    if (st.alive === 0) break;
  }
  const wallMax = 350, turretMax = 1000, radarMax = 250;
  return {
    kind, wave: `${wave.medium}中+${wave.big}大`, spawned, seconds: seconds + 2, survivors: st.alive, maxPast,
    walls: built.walls, wallsLost: built.walls - st.walls, wallDamage: built.walls * wallMax - st.wall_hp,
    turretsLost: built.turrets - st.turrets, turretDamage: built.turrets * turretMax - st.turret_hp,
    radarDamage: 2 * radarMax - st.radar_hp,
  };
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export const dragonTeethVsSolid: Experiment = {
  id: "compare.walls.dragon-teeth-vs-solid",
  topic: "防御",
  claim: "龙牙墙 (3 列错位短墙, 段间留孔) vs 2 厚实墙, 同样的激光炮塔: 炮塔打得过来的小波次, 龙牙墙的墙损更少 (减速、多开枪); 虫多到压过火力的大波次, 孔会把虫放到炮塔跟前, 炮塔损失远大于实墙 (网上说龙牙是减速不是挡住; 朋友基地用龙牙 + 两排激光)",
  refs: ["knowledge/patterns/case-friend-nauvis.md P-friend-16", "docs/research/players/friend-questions.md FQ6-1~FQ6-5", "knowledge/patterns/defense.md"],
  sources: [
    { title: "朋友的新地星基地 (龙牙墙 + 两排激光)", credibility: 3 },
    { title: "官方论坛 \"dragon's teeth no longer working\" (2020-11): 原理是减速不是挡住", url: "https://forums.factorio.com/viewtopic.php?p=521792", date: "2020-11", credibility: 3 },
    { title: "本机原型: 墙壁 350 血 (激光 70% 抗性), 激光炮塔 1000 血、射程 24、40 tick 一发; 中型撕咬虫 75 血, 大型 375 血", credibility: 1 },
  ],
  gameSeconds: 900,
  allowUnpowered: true, // 打完场地里的电网可能被虫子拆了, 那是结果不是接线错; 每轮开打前用 ctx.powered() 强制查
  async run(ctx) {
    const ox = ARENA.dx, oy = ctx.y;
    ctx.watch([[ox - 75, oy - 30], [ox + 75, oy + 30]]);
    await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area: [[ox - 75, oy - 30], [ox + 75, oy + 30]], no_enemies: true }, { timeoutMs: 120_000 });
    // 镜头放在走廊北边的岸上 (水外面, 虫子够不着)
    await ctx.lab.rpc("viewer", { position: [ox - 10, oy - 27], zoom: 0.45, surface: ctx.surface }, { retry: true }).catch(() => undefined);
    const results: Awaited<ReturnType<typeof round>>[] = [];
    // 两档波次: 小波 (炮塔打得过来) 和大波 (炮塔被压着打), 每档每种墙 2 轮
    const waves = [{ medium: 20, big: 5 }, { medium: 60, big: 20 }];
    for (const wave of waves) {
      for (let i = 0; i < 2; i++) {
        for (const kind of ["teeth", "solid"] as const) {
          await ctx.say(`${wave.medium} 中型 + ${wave.big} 大型, 第 ${i + 1} 轮: ${kind === "teeth" ? "龙牙墙" : "实墙"}`);
          results.push(await round(ctx, kind, ox, oy, wave));
        }
      }
    }
    const loss = (r: (typeof results)[0]) => r.wallDamage + r.turretDamage;
    const line = (rs: typeof results, name: string) =>
      `${name}: 用时 ${avg(rs.map((r) => r.seconds)).toFixed(0)} 秒, 墙损 ${avg(rs.map((r) => r.wallDamage)).toFixed(0)} 血 (拆 ${avg(rs.map((r) => r.wallsLost)).toFixed(1)} 段), 炮塔损 ${avg(rs.map((r) => r.turretDamage)).toFixed(0)} 血 (拆 ${avg(rs.map((r) => r.turretsLost)).toFixed(1)} 座), 钻过墙最多 ${Math.max(...rs.map((r) => r.maxPast))} 只`;
    const parts: string[] = [];
    let teethWins = 0, solidWins = 0;
    for (const wave of waves) {
      const tag = `${wave.medium}中+${wave.big}大`;
      const T = results.filter((r) => r.kind === "teeth" && r.wave === tag), S = results.filter((r) => r.kind === "solid" && r.wave === tag);
      const tLoss = avg(T.map(loss)), sLoss = avg(S.map(loss));
      if (tLoss < sLoss * 0.85) teethWins++; else if (tLoss > sLoss * 1.15) solidWins++;
      parts.push(`【${tag}】${line(T, "龙牙墙 " + T[0].walls + " 段")}; ${line(S, "实墙 " + S[0].walls + " 段")} → 墙+炮塔总损失 龙牙 ${tLoss.toFixed(0)} vs 实墙 ${sLoss.toFixed(0)}`);
    }
    const survived = results.some((r) => r.survivors > 0);
    const summary = parts.join(" ‖ ") + (survived ? " (有轮次 150 秒没打完)" : "");
    // 说法是有条件的: 小波龙牙更省, 大波实墙保炮塔
    const small = waves[0], big = waves[1];
    const tag = (w: { medium: number; big: number }) => `${w.medium}中+${w.big}大`;
    const turretsLost = (k: "teeth" | "solid", w: typeof small) => avg(results.filter((r) => r.kind === k && r.wave === tag(w)).map((r) => r.turretsLost));
    const smallTeethBetter = avg(results.filter((r) => r.kind === "teeth" && r.wave === tag(small)).map(loss)) < avg(results.filter((r) => r.kind === "solid" && r.wave === tag(small)).map(loss)) * 0.85;
    const bigSolidKeepsTurrets = turretsLost("solid", big) < turretsLost("teeth", big) * 0.6;
    let verdict: "verified" | "refuted" | "inconclusive";
    if (smallTeethBetter && bigSolidKeepsTurrets) verdict = "verified";
    else if (!smallTeethBetter && !bigSolidKeepsTurrets) verdict = "refuted";
    else verdict = "inconclusive";
    const tLoss = avg(results.filter((r) => r.kind === "teeth").map(loss)), sLoss = avg(results.filter((r) => r.kind === "solid").map(loss));
    return { verdict, summary, measured: { results, teethWins, solidWins, tLoss, sLoss } };
  },
};
