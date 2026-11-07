// 第二十一批 (2026-11-02): 第一版知识清点搬来的说法 (docs/research/players/v1-knowledge.md), 先做"会伤到自己的"和"和仓库相反的"。
import type { Experiment } from "../src/verify/types.ts";
import { SET_SCHEDULE, build, status, waitState, rec } from "./trains.ts";

const V1 = (what: string) => ({ title: `第一版知识库 ${what} (2026-10-29~30, 未核实) → docs/research/players/v1-knowledge.md`, credibility: 3 as const });
const PROTO = (what: string) => ({ title: `本机原型导出 data-raw-dump (2.1.24): ${what}`, credibility: 1 as const });

// 磁轨炮塔场地: 炮塔朝北, 靶子正北 24 格; 炮口和靶子之间: 一排墙 + 一个箱子; 靶子后面 5 格: 一个箱子; 偏开 6 格: 对照墙
async function railgunRange(ctx: Parameters<Experiment["run"]>[0]) {
  const setup = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
-- 磁轨炮塔朝北 (默认朝向), 只能左右转约 36°: 靶子放正北
local t = lab.place{surface = s, name = "railgun-turret", position = {a.x + 0.5, a.y + 12}}
lab.insert(t, {name = "railgun-ammo", count = 5})
lab.label(t, "磁轨炮塔 (朝北)")
local target = lab.place{surface = s, name = "gun-turret", position = {t.position.x, a.y - 12}, force = "enemy"}
lab.label(target, "靶子: 敌方机枪炮塔 (不装弹)")
for dx = -2, 2 do lab.place{surface = s, name = "stone-wall", position = {t.position.x + dx, a.y + 0.5}} end
lab.label(lab.place{surface = s, name = "stone-wall", position = {t.position.x + 6, a.y + 0.5}}, "对照: 不在炮弹线上")
lab.label(lab.place{surface = s, name = "steel-chest", position = {t.position.x, a.y - 5 + 0.5}}, "炮口和靶子之间的箱子")
lab.label(lab.place{surface = s, name = "steel-chest", position = {target.position.x, a.y - 17 + 0.5}}, "靶子后面的箱子")
local w = s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, name = "stone-wall"}[1]
local c = s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, name = "steel-chest"}[1]
return {wall_max = w.health, chest_max = c.health, ty = t.position.y, gy = target.position.y}`)) as { wall_max: number; chest_max: number; ty: number; gy: number };
  await ctx.power();
  await ctx.ticks(60);
  await ctx.powered();
  await ctx.ticks(15 * 60);
  const m = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}
local t = s.find_entities_filtered{area = area, name = "railgun-turret"}[1]
local out = {target_alive = #s.find_entities_filtered{area = area, name = "gun-turret", force = "enemy"} > 0, walls = {}, ammo_left = t.get_item_count("railgun-ammo"), between = 0, beyond = 0}
for _, w in pairs(s.find_entities_filtered{area = area, name = "stone-wall"}) do out.walls[#out.walls + 1] = {dx = w.position.x - t.position.x, hp = w.health} end
local c1 = s.find_entities_filtered{area = {{a.x - 1, a.y - 6}, {a.x + 2, a.y - 4}}, name = "steel-chest"}[1]
local c2 = s.find_entities_filtered{area = {{a.x - 1, a.y - 18}, {a.x + 2, a.y - 16}}, name = "steel-chest"}[1]
out.between = c1 and c1.health or 0
out.beyond = c2 and c2.health or 0
return out`)) as { target_alive: boolean; walls: { dx: number; hp: number }[]; ammo_left: number; between: number; beyond: number };
  const inLine = m.walls.filter((w) => Math.abs(w.dx) <= 2.5), ctrl = m.walls.filter((w) => Math.abs(w.dx) > 2.5);
  // 被打掉的墙不在读回的列表里 (第一次干跑只读到 5 块里的 3 块、都满血, 差点判成"推翻"): 消失的也算挨打
  const gone = 5 - inLine.length;
  const wallsHit = inLine.filter((w) => w.hp < setup.wall_max).length + gone;
  return {
    fired: !m.target_alive || m.ammo_left < 5,
    frontHit: wallsHit > 0 || m.between < setup.chest_max,
    beyondHit: m.beyond < setup.chest_max,
    ctrlHit: ctrl.some((w) => w.hp < setup.wall_max),
    summary: `磁轨炮塔打了 ${5 - m.ammo_left} 发, 靶子${m.target_alive ? "还在" : "被打掉"}; 炮口和靶子之间: 一排 5 块墙里 ${gone} 块被打掉、${wallsHit - gone} 块掉血 (满血 ${setup.wall_max})、箱子 ${m.between > 0 ? `${m.between}/${setup.chest_max}` : "被打掉"}; 靶子后面 5 格的箱子 ${m.beyond > 0 ? `${m.beyond}/${setup.chest_max}` : "被打掉"}; 偏开 6 格的对照墙${ctrl.some((w) => w.hp < setup.wall_max) ? "也掉血" : "没掉血"}`,
    measured: { ...m, ...setup },
  };
}

const RAIL_SOURCES = [V1("topics/source-facts.md、defense.md"), PROTO("railgun-ammo 的 ammo_type 是 line 类攻击 (长 50、宽 1); railgun-turret 射程 40、最近 3.5、左右只能转 0.2 圈")];

export const railgunFriendlyFire: Experiment = {
  id: "v1.railgun-hits-own-walls",
  topic: "防御",
  claim: "磁轨炮塔的炮弹是直线穿透攻击, 打到炮口和目标之间的己方墙壁 / 建筑 (第一版: 磁轨炮塔绝不能放在墙后)",
  refs: ["v1-knowledge.md V1K-12", "patterns/defense.md P-def-20"],
  sources: RAIL_SOURCES,
  gameSeconds: 15,
  allowStatus: ["no_ammo"], // 当靶子的敌方机枪炮塔故意不装弹 (不还手)
  async run(ctx) {
    const r = await railgunRange(ctx);
    return { verdict: !r.fired || r.ctrlHit ? "inconclusive" : r.frontHit ? "verified" : "refuted", summary: r.summary, measured: r.measured };
  },
};

export const railgunBeyondTarget: Experiment = {
  id: "v1.railgun-hits-own-beyond-target",
  topic: "防御",
  claim: "磁轨炮塔的炮弹打穿目标后继续沿直线飞, 伤到目标后面的己方建筑 (第一版: 炮弹线长 50 格, 线上己方的东西都挨打)",
  refs: ["v1-knowledge.md V1K-12", "patterns/defense.md P-def-20"],
  sources: RAIL_SOURCES,
  gameSeconds: 15,
  allowStatus: ["no_ammo"],
  async run(ctx) {
    const r = await railgunRange(ctx);
    return { verdict: !r.fired || r.ctrlHit ? "inconclusive" : r.beyondHit ? "verified" : "refuted", summary: r.summary, measured: r.measured };
  },
};

export const turretIdleDrain: Experiment = {
  id: "v1.turret-idle-drain",
  topic: "电",
  claim: "没有敌人时 (待机) 特斯拉炮塔每座耗电 1MW、激光炮塔每座 24kW (原型 drain): 防御电网要按待机算",
  refs: ["v1-knowledge.md V1K-20", "research/players/defense.md 第 1 节"],
  sources: [V1("topics/logistics-power.md"), PROTO("tesla-turret energy_source.drain 1MW、buffer 15MJ; laser-turret drain 24kW、buffer 801kJ")],
  gameSeconds: 20,
  async run(ctx) {
    await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
lab.label(lab.place{surface = s, name = "tesla-turret", position = {a.x - 8, a.y}}, "特斯拉炮塔 (没敌人)")
lab.label(lab.place{surface = s, name = "laser-turret", position = {a.x + 8, a.y}}, "激光炮塔 (没敌人)")
return true`);
    await ctx.power();
    await ctx.ticks(600); // 先充满缓存 (特斯拉 15MJ, 输入上限 7MW)
    await ctx.powered();
    const read = `local a = ... local s = game.surfaces[a.surface]
      local pole = s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, type = "electric-pole"}[1]
      local st = pole.electric_network_statistics
      return {tesla = st.get_input_count("tesla-turret"), laser = st.get_input_count("laser-turret")}`;
    const j0 = (await ctx.lua(read)) as { tesla: number; laser: number };
    await ctx.ticks(600);
    const j1 = (await ctx.lua(read)) as { tesla: number; laser: number };
    const teslaW = (j1.tesla - j0.tesla) / 10, laserW = (j1.laser - j0.laser) / 10;
    const near = (v: number, want: number) => Math.abs(v - want) / want < 0.02;
    const ok = near(teslaW, 1e6) && near(laserW, 24e3);
    return {
      verdict: ok ? "verified" : teslaW > 0 || laserW > 0 ? "refuted" : "inconclusive",
      summary: `没敌人时 10 秒平均 (电网统计): ${ctx.zh("tesla-turret")} ${(teslaW / 1e3).toFixed(1)}kW、${ctx.zh("laser-turret")} ${(laserW / 1e3).toFixed(2)}kW`,
      measured: { teslaW, laserW },
    };
  },
};

export const boompuffExplodes: Experiment = {
  id: "v1.boompuff-explodes-on-death",
  topic: "句芒",
  claim: "高爆泡泡被打死时会爆, 伤到几格内的己方建筑 (第一版: 手清时炸毁过建筑和箱子; 原型每颗种子只有 5 点爆炸伤害)",
  refs: ["v1-knowledge.md V1K-14", "patterns/planets.md P-planet-67"],
  sources: [V1("topics/new-base-build-ops.md (联机观察)"), PROTO("tree boompuff: 50 血, dying_explosion boompuff-explosion; minable 带 mining_trigger")],
  surface: "gleba",
  gameSeconds: 10,
  async run(ctx) {
    const setup = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local function puff(x, y, text)
  local p = lab.place{surface = s, name = "boompuff", position = {x, y}}
  lab.label(p, text)
  return p
end
local A = puff(a.x - 10, a.y - 8, "打死")
local B = puff(a.x + 10, a.y - 8, "挖掉 (脚本 mine)")
local C = puff(A.position.x - 3, A.position.y, "挨着被打死的那棵")
local chests = {}
for _, p in ipairs({{"die", A}, {"mine", B}}) do
  for _, d in ipairs({2, 4, 8}) do
    local c = lab.place{surface = s, name = "wooden-chest", position = {math.floor(p[2].position.x) + 0.5, math.floor(p[2].position.y) + 0.5 + d}}
    chests[#chests + 1] = {who = p[1], d = d, x = c.position.x, y = c.position.y}
  end
end
local max = s.find_entities_filtered{position = {chests[1].x, chests[1].y}, name = "wooden-chest"}[1].health
return {chests = chests, chest_max = max, c_max = C.health}`)) as { chests: { who: string; d: number; x: number; y: number }[]; chest_max: number; c_max: number };
    await ctx.powered();
    const fired = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local function at(x, y) return s.find_entities_filtered{area = {{x - 0.5, y - 0.5}, {x + 0.5, y + 0.5}}, name = "boompuff"}[1] end
local A, B = at(a.x - 10, a.y - 8), at(a.x + 10, a.y - 8)
A.die()
local mined = B.mine{raise_destroyed = true}
return {mined = mined}`)) as { mined: boolean };
    await ctx.ticks(5 * 60);
    const m = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local out = {}
for i, c in ipairs(a.chests) do
  local e = s.find_entities_filtered{position = {c.x, c.y}, name = "wooden-chest"}[1]
  out[tostring(i)] = e and e.health or 0
end
local C = s.find_entities_filtered{area = {{a.x - 15, a.y - 10}, {a.x - 11, a.y - 6}}, name = "boompuff"}[1]
return {hp = out, c_hp = C and C.health or -1}`, { chests: setup.chests })) as { hp: Record<string, number>; c_hp: number };
    const rows = setup.chests.map((c, i) => ({ ...c, hp: m.hp[String(i + 1)] }));
    const lost = (who: string) => rows.filter((r) => r.who === who && r.hp < setup.chest_max);
    const dieHit = lost("die"), mineHit = lost("mine");
    const fmt = (who: string) => rows.filter((r) => r.who === who).map((r) => `${r.d} 格 ${r.hp}`).join("、");
    return {
      verdict: dieHit.length > 0 ? "verified" : "refuted",
      summary: `打死: 木箱 (满血 ${setup.chest_max}) ${fmt("die")}; 挨着的另一棵 ${m.c_hp < 0 ? "也没了 (连锁)" : `${m.c_hp}/${setup.c_max}`}。脚本挖掉 (mine ${fired.mined ? "成功" : "失败"}): 木箱 ${fmt("mine")}${mineHit.length ? " → 挖也会爆" : " → 脚本挖没炸 (机器人 / 玩家挖不一定一样, 待测)"}`,
      measured: { rows, c_hp: m.c_hp, c_max: setup.c_max, mined: fired.mined },
    };
  },
};

export const qualityWithProductivity: Experiment = {
  id: "v1.quality-and-productivity-same-machine",
  topic: "品质",
  claim: "品质插件和产能插件可以装在同一台机器上, 两种加成同时生效 (第一版说不能同机兼得; 仓库检索 QA15 说按比例混配)",
  refs: ["v1-knowledge.md V1K-X4", "research/players/quality-advanced.md QA15"],
  sources: [V1("topics/quality.md"), { title: "本机 API 文件 (2.1.24): LuaEntity.effects = 作用在这个实体上的效果", credibility: 1 }],
  gameSeconds: 1,
  allowUnpowered: true,
  allowStatus: ["no_power"], // 只读引擎算出的效果, 不开工
  async run(ctx) {
    const r = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      local out = {}
      for i, c in ipairs(a.cases) do
        local e = lab.place{surface = s, name = "assembling-machine-3", position = {a.x - 8 + (i - 1) * 6 + 0.5, a.y + 0.5}, recipe = "iron-gear-wheel"}
        lab.label(e, c.label)
        for name, n in pairs(c.modules) do lab.insert(e, {name = name, count = n}, defines.inventory.crafter_modules) end
        local ef = e.effects or {}
        out[c.key] = {productivity = ef.productivity or 0, quality = ef.quality or 0, speed = ef.speed or 0}
      end
      return out`, {
      cases: [
        { key: "mixed", label: "产能 ×2 + 品质 ×2", modules: { "productivity-module-3": 2, "quality-module-3": 2 } },
        { key: "prod", label: "只有产能 ×2", modules: { "productivity-module-3": 2 } },
        { key: "qual", label: "只有品质 ×2", modules: { "quality-module-3": 2 } },
      ],
    })) as Record<"mixed" | "prod" | "qual", { productivity: number; quality: number; speed: number }>;
    await ctx.powered();
    const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
    const ok = r.mixed.productivity > 0 && r.mixed.quality > 0 && near(r.mixed.productivity, r.prod.productivity) && near(r.mixed.quality, r.qual.quality);
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    return {
      verdict: ok ? "verified" : r.mixed.productivity > 0 || r.mixed.quality > 0 ? "refuted" : "inconclusive",
      summary: `组装机3型 (铁齿轮): 产能 ×2 + 品质 ×2 → 产能 ${pct(r.mixed.productivity)}、品质 ${pct(r.mixed.quality)}、速度 ${pct(r.mixed.speed)}; 对照 只有产能 ×2 → 产能 ${pct(r.prod.productivity)}, 只有品质 ×2 → 品质 ${pct(r.qual.quality)} (LuaEntity.effects 原值, 品质一栏的单位按 API 原样)`,
      measured: r,
    };
  },
};

export const teslaChainOwn: Experiment = {
  id: "v1.tesla-chain-skips-own",
  topic: "防御",
  claim: "特斯拉炮塔的电弧从被打的敌人往外跳 (最多 10 跳、每跳 12 格) 只跳敌人, 不伤到敌人旁边的己方建筑 (第一版没查会不会跳到己方)",
  refs: ["v1-knowledge.md V1K-13", "patterns/defense.md P-def-11"],
  sources: [V1("topics/source-facts.md"), PROTO("chain-active-trigger chain-tesla-turret-chain: max_jumps 10、max_range_per_jump 12、fork_chance 0.05; tesla-turret 射程 30")],
  gameSeconds: 15,
  allowStatus: ["no_ammo"], // 当靶子的敌方机枪炮塔故意不装弹 (不还手)
  async run(ctx) {
    const setup = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
lab.label(lab.place{surface = s, name = "tesla-turret", position = {a.x, a.y + 14}}, "特斯拉炮塔")
-- 第一个靶子在射程内 (24 格); 第二个靶子离第一个 8 格、在特斯拉射程外 (32 格): 它掉血只能是电弧跳过去的 (对照: 证明电弧在跳)
local t1 = lab.place{surface = s, name = "gun-turret", position = {a.x, a.y - 10}, force = "enemy"}
lab.label(t1, "靶子 1 (射程内)")
local t2 = lab.place{surface = s, name = "gun-turret", position = {a.x + 8, a.y - 18}, force = "enemy"}
lab.label(t2, "靶子 2 (射程外, 只能被电弧跳到)")
-- 靶子 1 旁边 2~4 格一圈己方木箱 (比靶子 2 近)
local n = 0
for _, d in ipairs({{-3, 0}, {3, 0}, {0, 3}, {-3, 3}, {3, 3}}) do
  lab.place{surface = s, name = "wooden-chest", position = {t1.position.x + d[1] + 0.5, t1.position.y + d[2] + 0.5}}
  n = n + 1
end
local c = s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, name = "wooden-chest"}[1]
return {chests = n, chest_max = c.health, t_max = t1.health}`)) as { chests: number; chest_max: number; t_max: number };
    await ctx.power();
    await ctx.ticks(60);
    await ctx.powered();
    await ctx.ticks(15 * 60);
    const m = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}
local out = {chests = {}, t1 = -1, t2 = -1}
for _, c in pairs(s.find_entities_filtered{area = area, name = "wooden-chest"}) do out.chests[#out.chests + 1] = c.health end
local t1 = s.find_entities_filtered{area = {{a.x - 2, a.y - 12}, {a.x + 2, a.y - 8}}, name = "gun-turret"}[1]
local t2 = s.find_entities_filtered{area = {{a.x + 6, a.y - 20}, {a.x + 10, a.y - 16}}, name = "gun-turret"}[1]
out.t1 = t1 and t1.health or 0
out.t2 = t2 and t2.health or 0
return out`)) as { chests: number[]; t1: number; t2: number };
    // 被打掉的箱子读不回来 (lab.md #59): 少了的算挨打
    const hit = m.chests.filter((h) => h < setup.chest_max).length + (setup.chests - m.chests.length);
    const shot = m.t1 < setup.t_max, chained = m.t2 < setup.t_max;
    return {
      verdict: !shot || !chained ? "inconclusive" : hit === 0 ? "verified" : "refuted",
      summary: `靶子 1 (射程内) 血 ${m.t1}/${setup.t_max}; 靶子 2 (射程外, 离靶子 1 约 11 格) 血 ${m.t2}/${setup.t_max} → 电弧${chained ? "跳过去了" : "没跳过去"}; 靶子 1 旁边 3~4 格的 ${setup.chests} 个己方木箱 ${hit} 个挨打 (满血 ${setup.chest_max})`,
      measured: { ...m, ...setup, hit },
    };
  },
};

export const platformWeightCargo: Experiment = {
  id: "v1.platform-weight-includes-cargo",
  topic: "太空平台",
  claim: "太空平台的重量包括枢纽里的货物: 往枢纽装货, 平台重量按 物品重量 × 数量 增加 (第一版运行时读到一艘船 608 吨里约 524 吨是货; 仓库检索 changes-2.1 / P-style-17 说只算基座和枢纽)",
  refs: ["v1-knowledge.md V1K-X1", "research/players/changes-2.1.md 第 4 节", "patterns/layout-styles.md P-style-17"],
  sources: [V1("topics/space-platform.md"), { title: "本机 API 文件 (2.1.24): LuaSpacePlatform.weight = The total weight of the platform; LuaItemPrototype.weight", credibility: 1 }],
  gameSeconds: 2,
  allowUnpowered: true,
  async run(ctx) {
    // 重量要过 tick 才重算 (第一次干跑同一个 tick 里装货前后读数一样); 每步之间跑 10 tick
    const NAME = "实验: 重量算不算货物";
    const find = `local a = ... local p for _, x in pairs(game.forces.player.platforms) do if x.name == a.name then p = x end end`;
    await ctx.lua(`local a = ...
local p = game.forces.player.create_space_platform{name = a.name, planet = "nauvis", starter_pack = "space-platform-starter-pack"}
p.apply_starter_pack()
p.paused = false
return true`, { name: NAME });
    await ctx.ticks(10);
    const w0 = (await ctx.lua(`${find} return {w = p.weight, item = prototypes.item["iron-plate"].weight}`, { name: NAME })) as { w: number; item: number };
    const add = `${find} lab.insert(p.hub, {name = "iron-plate", count = 1000}) return true`;
    await ctx.lua(add, { name: NAME });
    await ctx.ticks(10);
    const w1 = (await ctx.lua(`${find} return p.weight`, { name: NAME })) as number;
    await ctx.lua(add, { name: NAME });
    await ctx.ticks(10);
    const w2 = (await ctx.lua(`${find} return p.weight`, { name: NAME })) as number;
    // 正面对照: 在已有地基旁边再铺 10 格地基, 重量要跟着变 (证明重量会刷新); 铺在枢纽所在那排地基的正下方
    const tiles = (await ctx.lua(`${find}
local s = p.surface
local hub = p.hub
local found = s.find_tiles_filtered{name = "space-platform-foundation"}
local maxy = -1e9
for _, t in pairs(found) do if t.position.y > maxy then maxy = t.position.y end end
local new = {}
for _, t in pairs(found) do
  if t.position.y == maxy and #new < 10 then new[#new + 1] = {name = "space-platform-foundation", position = {t.position.x, maxy + 1}} end
end
s.set_tiles(new)
return {n = #new, had = #found}`, { name: NAME })) as { n: number; had: number };
    await ctx.ticks(10);
    const w3 = (await ctx.lua(`${find} local w = p.weight p.destroy(1) return w`, { name: NAME })) as number; // 测完删掉平台
    await ctx.ticks(5);
    const m = { w0: w0.w, w1, w2, w3, item: w0.item, tilesAdded: tiles.n, tilesHad: tiles.had };
    const d1 = m.w1 - m.w0, d2 = m.w2 - m.w1, want = 1000 * m.item;
    const ok = Math.abs(d1 - want) <= want * 0.01 && Math.abs(d2 - want) <= want * 0.01;
    const t = (g: number) => `${g}`; // 原始重量值 (API 没写单位; 本机更新日志整理: 基座每格 200、枢纽 40000)
    return {
      // 货物不改重量、但铺地基改了 (重量确实会刷新) 才算推翻; 两样都不变 = 重量没刷新, 没结论
      verdict: ok ? "verified" : d1 === 0 && d2 === 0 && m.w3 > m.w2 ? "refuted" : "inconclusive",
      summary: `空平台 ${t(m.w0)}; 枢纽装 1000 块 ${ctx.zh("iron-plate")} 后 ${t(m.w1)} (+${t(d1)}), 再装 1000 块 ${t(m.w2)} (+${t(d2)}); 物品原型里铁板每块重 ${m.item} → 1000 块应 +${t(want)}。对照: 再铺 ${m.tilesAdded} 格地基 (原有 ${m.tilesHad} 格) → ${t(m.w3)} (+${t(m.w3 - m.w2)})`,
      measured: m,
    };
  },
};

export const explosiveRocketOwnWalls: Experiment = {
  id: "v1.explosive-rocket-hits-own-walls",
  topic: "防御",
  claim: "火箭炮塔打爆破火箭弹时, 范围伤害会炸到目标旁边自己的墙 (普通火箭弹只打目标本身, 不伤墙) (第一版: 敌人贴墙时爆破火箭弹会炸自己的墙)",
  refs: ["v1-knowledge.md V1K-X2", "research/players/defense.md D22", "patterns/defense.md 分歧 10"],
  sources: [V1("topics/source-facts.md、defense.md"), PROTO("projectile explosive-rocket: 直接 50 爆炸 + 半径 6.5 范围 100 爆炸 (范围伤害没写阵营过滤); rocket: 直接 200 爆炸; 石墙 350 血, 爆炸抗性 -10 / 30%")],
  gameSeconds: 30,
  allowStatus: ["no_ammo"], // 当靶子的敌方机枪炮塔故意不装弹 (不还手)
  async run(ctx) {
    // 两段: 先装普通火箭弹 (对照), 打掉靶子后读墙; 再在同一位置放新靶子, 换爆破火箭弹, 再读墙
    const setup = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local t = lab.place{surface = s, name = "rocket-turret", position = {a.x, a.y + 12}}
lab.label(t, "火箭炮塔")
for dx = -3, 3 do lab.place{surface = s, name = "stone-wall", position = {a.x + dx + 0.5, a.y - 8 + 0.5}} end
local w = s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, name = "stone-wall"}[1]
return {wall_max = w.health, walls = 7}`)) as { wall_max: number; walls: number };
    const phase = async (ammo: string) => {
      await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local tgt = lab.place{surface = s, name = "gun-turret", position = {a.x, a.y - 10}, force = "enemy"}
lab.label(tgt, "靶子 (紧贴墙北边)")
local t = s.find_entities_filtered{area = {{a.x - 3, a.y + 9}, {a.x + 3, a.y + 15}}, name = "rocket-turret"}[1]
local inv = t.get_inventory(defines.inventory.turret_ammo)
inv.clear()
lab.insert(t, {name = a.ammo, count = 10})
return true`, { ammo });
      await ctx.ticks(20 * 60);
      return (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local hp = {}
for _, w in pairs(s.find_entities_filtered{area = {{a.x - 5, a.y - 9}, {a.x + 5, a.y - 7}}, name = "stone-wall"}) do hp[#hp + 1] = w.health end
local tgt = s.find_entities_filtered{area = {{a.x - 2, a.y - 12}, {a.x + 2, a.y - 8}}, name = "gun-turret", force = "enemy"}[1]
local t = s.find_entities_filtered{area = {{a.x - 3, a.y + 9}, {a.x + 3, a.y + 15}}, name = "rocket-turret"}[1]
return {walls = hp, target_alive = tgt ~= nil, ammo_left = t.get_item_count(a.ammo)}`, { ammo })) as { walls: number[]; target_alive: boolean; ammo_left: number };
    };
    await ctx.powered();
    const normal = await phase("rocket");
    const explosive = await phase("explosive-rocket");
    // 被炸掉的墙读不回来 (lab.md #59): 少了的算挨打
    const lost = (r: { walls: number[] }) => r.walls.reduce((n, h) => n + (setup.wall_max - h), 0) + (setup.walls - r.walls.length) * setup.wall_max;
    const normalLoss = lost(normal);
    const expLoss = lost(explosive) - normalLoss;
    const fired = !normal.target_alive && !explosive.target_alive;
    return {
      verdict: !fired ? "inconclusive" : normalLoss === 0 && expLoss > 0 ? "verified" : expLoss === 0 ? "refuted" : "inconclusive",
      summary: `一排 7 块石墙 (每块 ${setup.wall_max} 血), 靶子紧贴墙北边: 普通火箭弹打掉靶子用 ${10 - normal.ammo_left} 发, 墙掉血 ${normalLoss}; 换爆破火箭弹打掉同样的靶子用 ${10 - explosive.ammo_left} 发, 墙又掉血 ${expLoss}${explosive.walls.length < setup.walls ? ` (炸没 ${setup.walls - explosive.walls.length} 块)` : ""}`,
      measured: { normal, explosive, normalLoss, expLoss, ...setup },
    };
  },
};

export const biterEggHatch: Experiment = {
  id: "v1.biter-egg-25-per-big-biter",
  topic: "腐坏",
  claim: "异虫卵放 30 分钟 (108000 tick) 后孵出大型撕咬虫, 每 25 个卵孵 1 只 (不是一个卵一只), 不留变质物 (第一版 gleba-production 的说法; 仓库检索 D14 没写数量)",
  refs: ["v1-knowledge.md V1K-X6", "research/players/defense.md D14", "facts spoilage.pentapod-egg.hatches-15-minutes (五足虫卵是一个一只)"],
  sources: [V1("topics/gleba-production.md、source-facts.md"), PROTO("item biter-egg: spoil_ticks 108000, spoil_to_trigger_result items_per_trigger 25 → create-entity big-biter")],
  gameSeconds: 1810,
  async run(ctx) {
    const ref = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local c = lab.place{surface = s, name = "steel-chest", position = {a.x + 0.5, a.y + 0.5}}
lab.insert(c, {name = "biter-egg", count = 50})
lab.label(c, "50 个异虫卵")
return {x = c.position.x, y = c.position.y}`)) as { x: number; y: number };
    const READ = `
local a = ...
local s = game.surfaces[a.surface]
local c = s.find_entity("steel-chest", {a.ref.x, a.ref.y})
local units = {}
for _, u in pairs(s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, type = "unit"}) do units[u.name] = (units[u.name] or 0) + 1 end
if a.kill then for _, u in pairs(s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, type = "unit"}) do u.destroy() end end
return {eggs = c and c.get_item_count("biter-egg") or -1, spoilage = c and c.get_item_count("spoilage") or -1, units = units}`;
    await ctx.powered();
    await ctx.ticks(108000 - 600);
    const before = (await ctx.lua(READ, { ref })) as { eggs: number; spoilage: number; units: Record<string, number> };
    await ctx.ticks(600 + 60); // 过孵化点 1 秒就读, 免得大型撕咬虫把箱子拆了
    const after = (await ctx.lua(READ, { ref, kill: true })) as { eggs: number; spoilage: number; units: Record<string, number> };
    const big = after.units["big-biter"] ?? 0;
    const ok = before.eggs === 50 && after.eggs === 0 && after.spoilage === 0 && big === 2;
    return {
      verdict: ok ? "verified" : after.eggs === 0 && big > 0 ? "refuted" : "inconclusive",
      summary: `50 个异虫卵: 第 29 分 50 秒还剩 ${before.eggs} 个; 30 分 1 秒后箱子里剩 ${after.eggs} 个卵、${after.spoilage} 个变质物, 箱子旁出现 ${Object.entries(after.units).map(([n, k]) => `${ctx.zh(n)}×${k}`).join("、") || "没有单位"}`,
      measured: { before, after },
    };
  },
};

export const refuelDryStation: Experiment = {
  id: "v1.refuel-interrupt-dry-station",
  topic: "火车",
  claim: "加油站断油时: 加油中断只写\"燃料 < 25\" → 列车在加油站等完又触发, 一直停在加油站不走; 中断再加\"不在加油站\"条件 → 列车等完就离开、回主线, 到下一站又被叫回来 (第一版: 要加这个条件, 否则缺油时反复触发)",
  refs: ["v1-knowledge.md V1K-X8", "facts trains.refuel-interrupt.needs-wait-condition", "research/players/trains.md T22"],
  sources: [V1("topics/trains-advanced-wiki.md (来自 wiki 列车中断的排错说明)")],
  gameSeconds: 300,
  async run(ctx) {
    // 场地: trains.ts 的 甲 ⇄ 乙 直线, 中间加一个"加油"站, 不放机械臂 = 断油
    const b = await build(ctx, [{ name: "加油", x: ctx.x + 1 }], 20);
    await ctx.powered();
    const fuelCond = { type: "fuel_item_count_any", compare_type: "and", condition: { comparator: "<", first_signal: { type: "item", name: "coal" }, constant: 25 } };
    const notAtFuel = { type: "not_at_station", compare_type: "and", station: "加油" };
    const target = { station: "加油", wait_conditions: [{ type: "inactivity", compare_type: "and", ticks: 5 * 60 }] };
    const out: Record<string, { leftFuel: number; secondsAtFuel: number; visits: string; fuelStart: number; fuelEnd: number; stateEnd: string }> = {};
    for (const variant of ["fuel-only", "fuel-and-not-at-station"] as const) {
      await ctx.lua(`local a = ... local t = game.train_manager.get_train_by_id(a.train_id)
        for _, l in pairs(t.locomotives.front_movers) do l.get_fuel_inventory().clear(); l.insert{name = "coal", count = 20} end
        for _, l in pairs(t.locomotives.back_movers) do l.get_fuel_inventory().clear(); l.insert{name = "coal", count = 20} end
        return true`, { train_id: b.train_id });
      // 先回西头的甲站 (加油站是东行侧的单向站, 从别处出发可能够不着: 第一次干跑开局就 no_path), 到了再换带中断的时刻表
      await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 1, records: [rec("甲", 600)] } });
      const atJia = await waitState(ctx, b.train_id, (st) => st.state === "wait_station" && st.station === "甲", 120);
      if (!atJia) return { verdict: "inconclusive", summary: `${variant}: 列车没回到甲站`, measured: out };
      const conditions = variant === "fuel-only" ? [fuelCond] : [fuelCond, notAtFuel];
      try {
        await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 1, records: [rec("甲", 3), rec("乙", 3)], interrupts: [{ name: "加油", inside_interrupt: false, conditions, targets: [target] }] } });
      } catch (e) {
        return { verdict: "inconclusive", summary: `设时刻表失败 (${variant}): ${(e as Error).message.slice(0, 200)}`, measured: out };
      }
      const arrived = await waitState(ctx, b.train_id, (st) => st.state === "wait_station" && st.station === "加油", 120);
      if (!arrived) {
        const st = await status(ctx, b.train_id);
        return { verdict: "inconclusive", summary: `${variant}: 列车 2 分钟内没到加油站; 当时 ${JSON.stringify(st).slice(0, 400)}`, measured: out };
      }
      const s0 = await status(ctx, b.train_id);
      let at = true, left = 0, secs = 0;
      const seen: string[] = ["加油"];
      for (let i = 0; i < 120; i++) {
        await ctx.ticks(60);
        const st = await status(ctx, b.train_id);
        const atNow = st.station === "加油" && (st.state === "wait_station" || st.state === "arrive_station");
        if (at && !atNow) left++;
        at = atNow;
        if (atNow) secs++;
        if (st.state === "wait_station" && st.station && seen[seen.length - 1] !== st.station) seen.push(st.station);
      }
      const end = await status(ctx, b.train_id);
      out[variant] = { leftFuel: left, secondsAtFuel: secs, visits: seen.slice(0, 10).join("→"), fuelStart: Math.min(...s0.fuel), fuelEnd: Math.min(...end.fuel), stateEnd: end.state };
    }
    const A = out["fuel-only"], B = out["fuel-and-not-at-station"];
    // "离开"按有没有停靠别的站算: 只写燃料条件时, 中断在站上重新触发那一下状态会闪一次 (第一次干跑记成"离开 1 次", 其实 119/120 秒都在站上、一站没去)
    const aStays = A.visits === "加油" && A.secondsAtFuel >= 110;
    const bLeaves = B.visits.split("→").some((v) => v !== "加油");
    return {
      verdict: aStays && bLeaves ? "verified" : !aStays ? "refuted" : "inconclusive",
      summary: `加油站断油, 各看 2 分钟: 只写\"燃料 < 25\" → 状态闪了 ${A.leftFuel} 次 (中断在站上重新触发), 停在加油站 ${A.secondsAtFuel} 秒, 停靠 ${A.visits}, 煤 ${A.fuelStart} → ${A.fuelEnd}; 加\"不在加油站\" → 离开 ${B.leftFuel} 次, 停在加油站 ${B.secondsAtFuel} 秒, 停靠 ${B.visits}, 煤 ${B.fuelStart} → ${B.fuelEnd} (结束时 ${B.stateEnd})`,
      measured: out,
    };
  },
};
