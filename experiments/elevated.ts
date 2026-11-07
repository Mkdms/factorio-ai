// 高架铁路:
// 跨水 (新地星)、岩浆 (祝融星)、深油海 (雷神星, 要研究支架地基); 支架怎么撑; 高架上能不能建车站 / 信号。
// 搭桥积木 BRIDGE: 地面轨 → 上坡道 → 高架轨 (到尽头就在轨下放支架, 支架必须在已有高架轨下面才起作用, 2026-11-02 沙盘试探) → 下坡道 → 地面轨, 每块按玩家规则 (manual) 检查, 放不下就报错。
// 几何 (沙盘试探): 朝东的坡道中心 x 取偶数, 西端 (x-8) 是地面层、东端 (x+8) 是高架层; 直轨中心在奇数格。
import type { Experiment, ExpContext } from "../src/verify/types.ts";
import { SET_SCHEDULE, clearOldStops, status, waitState, rec } from "./trains.ts";

const BRIDGE = `
local a = ...
local s = game.surfaces[a.surface]
local d = defines.direction
local manual = defines.build_check_type.manual
local f = "player"
local y = a.ry
local function put(name, x, dir, yy)
  local pos = {x, yy or y}
  if not s.can_place_entity{name = name, position = pos, direction = dir, force = f, build_check_type = manual} then error(name .. " 按玩家规则放不下 (" .. x .. ", " .. (yy or y) .. ")", 0) end
  return s.create_entity{name = name, position = pos, direction = dir, force = f}
end
-- 水 / 岩浆 / 油海带: x 在 [a.w0, a.w1) 的格子
if a.tile then
  local tiles = {}
  for x = a.w0, a.w1 - 1 do for yy = y - 6, y + 6 do tiles[#tiles + 1] = {name = a.tile, position = {x, yy}} end end
  s.set_tiles(tiles)
end
for x = a.x0 + 1, a.r1 - 9, 2 do put("straight-rail", x, d.east) end
local up = put("rail-ramp", a.r1, d.east) -- 坡道中心 (东西向) 在奇数行上 (试探: 放 (0,0) 落到 (0,1)), 直接给奇数行 y
local down = put("rail-ramp", a.r2, d.west)
local x = a.r1 + 9
local supports = {}
while x <= a.r2 - 9 do
  if s.can_place_entity{name = "elevated-straight-rail", position = {x, y}, direction = d.east, force = f, build_check_type = manual} then
    s.create_entity{name = "elevated-straight-rail", position = {x, y}, direction = d.east, force = f}
    x = x + 2
  else
    put("rail-support", x - 1, d.east) -- 当前尽头 (x-1) 的轨下放支架
    supports[#supports + 1] = x - 1
  end
  if #supports > 40 then error("支架放了 40 个还没接到对面", 0) end
end
for xx = a.r2 + 9, a.x1 - 1, 2 do put("straight-rail", xx, d.east) end
return {up = {up.position.x, up.position.y}, down = {down.position.x, down.position.y}, supports = supports}`;

// 东西两头各一个车站 (东行的车站在轨道南侧, 朝东) + 1 机车 1 车厢的列车 (车头朝东) 停在西头
const STATIONS_AND_TRAIN = `
local a = ...
local s = game.surfaces[a.surface]
local d = defines.direction
local function stop(name, x)
  local st = lab.place{surface = s, name = "train-stop", position = {x, a.ry + 2}, direction = d.east, force = "player", station = name}
  if not st.connected_rail then error(name .. " 车站没接上轨", 0) end
  st.backer_name = name
end
stop("西", a.x0 + 16)
stop("东", a.x1 - 6)
local l = lab.place{surface = s, name = "locomotive", position = {a.x0 + 12, a.ry}, direction = d.east, force = "player"}
local w = lab.place{surface = s, name = "cargo-wagon", position = {a.x0 + 5, a.ry}, direction = d.east, force = "player"}
if l.train.id ~= w.train.id then error("列车没拼上", 0) end
l.insert{name = "coal", count = 50}
return {train_id = l.train.id}`;

const CAN = `
local a = ...
local s = game.surfaces[a.surface]
local out = {}
for i, q in ipairs(a.q) do
  -- 周围 7×7 都铺成同一种地块 (支架是 3×3, 只铺 2×2 时一部分压在陆地上, 测不出能不能立在水里); tiles 按顺序铺 (先水后填海 = 填过的水面)
  for _, tile in ipairs(q.tiles or {}) do
    local ts = {}
    for dx = -3, 3 do for dy = -3, 3 do ts[#ts + 1] = {name = tile, position = {math.floor(q.x) + dx, math.floor(q.y) + dy}} end end
    s.set_tiles(ts)
  end
  out[i] = s.can_place_entity{name = q.name, position = {q.x, q.y}, direction = defines.direction.east, force = "player", build_check_type = defines.build_check_type.manual}
end
return out`;

async function site(ctx: ExpContext, half = 60) {
  const ry = ctx.y + 33, x0 = ctx.x - half, x1 = ctx.x + half;
  const area: [[number, number], [number, number]] = [[x0 - 2, ry - 10], [x1 + 2, ry + 10]];
  ctx.watch(area);
  await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area, no_enemies: true }, { timeoutMs: 120_000 });
  await clearOldStops(ctx);
  await ctx.lab.rpc("viewer", { position: [ctx.x, ry - 12], zoom: 0.4, surface: ctx.surface }, { retry: true }).catch(() => undefined);
  return { ry, x0, x1 };
}

export const bridgeOverWater: Experiment = {
  id: "elevated.water.bridge-instead-of-landfill",
  topic: "火车",
  claim: "新地星的水面上地面铁路建不了 (要先用填海材料填, 50 石头填 1 格), 但高架支架能立在水里: 坡道上去、支架撑着高架轨跨过水面、坡道下来, 列车能直接开过去, 不用填海",
  refs: ["docs/research/players/game-tips.md TT38 (高架支架把高架轨撑在地面或水面上)", "knowledge/patterns/layout-styles.md P-style-09", "用户 (什么时候该用高架, 不然要填土地)"],
  sources: [
    { title: "官方 wiki: Railway (新地星的海里只有坡道和支架能建)", url: "https://wiki.factorio.com/Railway", date: "2026-10-22", credibility: 2 },
    { title: "游戏内提示与技巧: 高架铁路 (本机 2.1.24)", credibility: 1 },
    { title: "本机原型: landfill 配方 50 石头 → 1; 水地块带 water_tile 碰撞层", credibility: 1 },
  ],
  gameSeconds: 120,
  async run(ctx) {
    const b = await site(ctx);
    // 对照 (地块级): 水上地面直轨放不下、支架放得下; 填海以后地面直轨放得下 (在桥北边 7 格单独试)
    const tests = (await ctx.lua(CAN, { q: [
      { name: "straight-rail", x: ctx.x - 11, y: b.ry - 8, tiles: ["water"] }, // 直轨中心要在奇数格 (第一次写成偶数行, 本来就放不下, 等于没测)
      { name: "rail-support", x: ctx.x - 1, y: b.ry - 8, tiles: ["water"] },
      { name: "straight-rail", x: ctx.x + 9, y: b.ry - 8, tiles: ["water", "landfill"] }, // 先铺水再填海
    ] })) as boolean[];
    // 桥: 水面 x ∈ [x-20, x+20) (40 格宽), 两个坡道在岸上
    const br = (await ctx.lua(BRIDGE, { ry: b.ry, x0: b.x0, x1: b.x1, r1: ctx.x - 30, r2: ctx.x + 30, tile: "water", w0: ctx.x - 20, w1: ctx.x + 20 })) as { supports: number[] | Record<string, never> };
    const t = (await ctx.lua(STATIONS_AND_TRAIN, { ry: b.ry, x0: b.x0, x1: b.x1 })) as { train_id: number };
    await ctx.powered();
    await ctx.say("40 格宽的水面: 坡道上桥、支架撑着高架轨, 列车从西站开到东站; 北边是对照 (水上地面轨放不下, 填海后能放)");
    await ctx.lua(SET_SCHEDULE, { train_id: t.train_id, schedule: { current: 1, records: [rec("东", 5)] } });
    const at = await waitState(ctx, t.train_id, (s) => s.state === "wait_station" && s.station === "东", 120, 30);
    const supports = Array.isArray(br.supports) ? br.supports : [];
    const ok = !tests[0] && tests[1] && tests[2] && !!at;
    return {
      verdict: ok ? "verified" : at && (tests[0] || !tests[1]) ? "refuted" : "inconclusive",
      summary: `水上: 地面直轨${tests[0] ? "放得下" : "放不下"}、支架${tests[1] ? "放得下" : "放不下"}; 填海后地面直轨${tests[2] ? "放得下" : "放不下"}; 40 格水面上搭桥用了 ${supports.length} 个支架 (x=${supports.join("/")}), 列车${at ? "开到了东站" : "120 秒没开到东站"}`,
      measured: { tests, supports, arrived: !!at },
    };
  },
};

export const supportReach: Experiment = {
  id: "elevated.support.reach-and-placement",
  topic: "火车",
  claim: "高架轨要靠坡道或支架撑着 (原型: 坡道 support_range 9、支架 11): 一段一段往外建时, 坡道高架端能伸出 8 格; 支架只撑它上方已经有轨之后往外 10 格 —— 提前放在轨尽头外面的支架当时不起作用, 等轨接到它上方才生效 (wiki 说的\"每 16 格一个支架\"是规划器一次摆放, 这里不测)",
  refs: ["megabase-logistics.md ML10 (每 16 格一个支架 vs 本机 support_range 11)", "verify.md 第十四批 (高架支架间距待测)"],
  sources: [
    { title: "本机原型: rail-support support_range 11、rail-ramp support_range 9", credibility: 1 },
    { title: "官方 wiki: Railway (每 16 格直轨一个支架)", url: "https://wiki.factorio.com/Railway", date: "2026-10-22", credibility: 2 },
  ],
  gameSeconds: 2,
  async run(ctx) {
    const b = await site(ctx);
    const m = (await ctx.lua(`local a = ...
      local s = game.surfaces[a.surface]
      local d = defines.direction
      local manual = defines.build_check_type.manual
      local y = a.ry
      local ramp = s.create_entity{name = "rail-ramp", position = {a.x - 40, y}, direction = d.east, force = "player"}
      local x = a.x - 40 + 9
      local function extend() while true do
        if not s.can_place_entity{name = "elevated-straight-rail", position = {x, y}, direction = d.east, force = "player", build_check_type = manual} then return x - 1 end
        s.create_entity{name = "elevated-straight-rail", position = {x, y}, direction = d.east, force = "player"} x = x + 2 end end
      local e0 = extend()
      local off = s.create_entity{name = "rail-support", position = {e0 + 6, y}, direction = d.east, force = "player"} -- 故意放在尽头外 6 格
      lab.label(off, "故意放在轨外")
      local e1 = extend()
      local on1 = s.create_entity{name = "rail-support", position = {e1, y}, direction = d.east, force = "player"}
      local e2 = extend()
      local on2 = s.create_entity{name = "rail-support", position = {e2, y}, direction = d.east, force = "player"}
      local e3 = extend()
      return {rampElevEnd = a.x - 40 + 8, e0 = e0, e1 = e1, e2 = e2, e3 = e3}`, { ry: b.ry })) as { rampElevEnd: number; e0: number; e1: number; e2: number; e3: number };
    await ctx.powered();
    const fromRamp = m.e0 - m.rampElevEnd, offEffect = m.e1 - m.e0, step1 = m.e2 - m.e1, step2 = m.e3 - m.e2;
    const ok = fromRamp === 8 && offEffect === 0 && step1 === 16 && step2 === 10; // step1: 轨接过轨外那个支架 (尽头外 6 格) 后它生效, 6 + 10
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `坡道高架端伸出 ${fromRamp} 格; 放在轨尽头外 6 格的支架当时让轨多伸 ${offEffect} 格; 在尽头下面再放一个后伸了 ${step1} 格 (轨接过轨外那个支架, 它生效: 6 + 10), 下一个支架撑 ${step2} 格`,
      measured: m,
    };
  },
};

export const lavaSupports: Experiment = {
  id: "elevated.vulcanus.lava-needs-supports",
  topic: "祝融星",
  claim: "祝融星的岩浆上地面铁路建不了 (岩浆地块带铁路碰撞层, 要到很晚才能填平), 高架支架能立在岩浆上, 所以跨岩浆河用高架 (支架能立在岩浆上是我从\"岩浆河用高架跨\"推的, 待核实)",
  refs: ["docs/research/players/game-tips.md TT26 (岩浆可以通过高架铁路穿越)", "vulcanus.md"],
  sources: [{ title: "游戏内提示与技巧: 祝融星导览; 本机原型: lava 地块 collision_mask 含 rail", credibility: 1 }],
  surface: "vulcanus",
  gameSeconds: 1,
  async run(ctx) {
    const r = (await ctx.lua(CAN, { q: [
      { name: "straight-rail", x: ctx.x - 9, y: ctx.y + 1, tiles: ["lava"] },
      { name: "rail-support", x: ctx.x + 1, y: ctx.y, tiles: ["lava"] },
      { name: "straight-rail", x: ctx.x + 13, y: ctx.y + 1 },
    ] })) as boolean[];
    // 核对: 地块真是岩浆、支架的碰撞层里有没有岩浆层
    const why = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      local layers = {} for k in pairs(prototypes.entity["rail-support"].collision_mask.layers) do layers[#layers + 1] = k end table.sort(layers)
      return {tile = s.get_tile(a.x + 1, a.y).name, mask = layers}`)) as { tile: string; mask: string[] };
    await ctx.powered();
    const ok = !r[0] && r[1] && r[2];
    return { verdict: why.tile !== "lava" ? "inconclusive" : ok ? "verified" : "refuted", summary: `岩浆 (${why.tile}) 上: 地面直轨${r[0] ? "放得下" : "放不下"}、支架${r[1] ? "放得下" : "放不下"} (支架碰撞层 ${why.mask.join(",")}); 对照 普通地面直轨${r[2] ? "放得下" : "放不下"}`, measured: { r, why } };
  },
};

export const deepOilNeedsResearch: Experiment = {
  id: "elevated.fulgora.deep-oil-needs-foundations",
  topic: "雷神星",
  claim: "雷神星的深油海上要研究\"支架地基\"才能立高架支架 (浅油海不用); 研究前放不下, 研究后放得下",
  refs: ["docs/research/players/game-tips.md TT22 (在深海建支架需要额外研究)", "fulgora.md (岛间铁路)"],
  sources: [{ title: "游戏内提示与技巧: 雷神星导览; 本机原型: oil-ocean-deep 地块 collision_mask 含 rail_support; 科技 rail-support-foundations 效果 rail-support-on-deep-oil-ocean", credibility: 1 }],
  surface: "fulgora",
  gameSeconds: 1,
  async run(ctx) {
    const q = [{ name: "rail-support", x: ctx.x - 6, y: ctx.y, tiles: ["oil-ocean-deep"] }, { name: "rail-support", x: ctx.x + 6, y: ctx.y, tiles: ["oil-ocean-shallow"] }];
    const before = (await ctx.lua(`local a = ... local t = game.forces.player.technologies["rail-support-foundations"] t.researched = false return true`)) && ((await ctx.lua(CAN, { q })) as boolean[]);
    const after = (await ctx.lua(`local a = ... game.forces.player.technologies["rail-support-foundations"].researched = true return true`)) && ((await ctx.lua(CAN, { q })) as boolean[]);
    await ctx.lua(`game.forces.player.technologies["rail-support-foundations"].researched = false return true`);
    await ctx.powered();
    const ok = before[0] === false && before[1] === true && after[0] === true;
    return {
      verdict: ok ? "verified" : before[0] ? "refuted" : "inconclusive",
      summary: `研究前: 深油海上支架${before[0] ? "放得下" : "放不下"}、浅油海${before[1] ? "放得下" : "放不下"}; 研究支架地基后: 深油海${after[0] ? "放得下" : "放不下"}`,
      measured: { before, after },
    };
  },
};

export const elevatedNoStation: Experiment = {
  id: "elevated.no-train-stop-but-signals",
  topic: "火车",
  claim: "高架轨上能放两种铁路信号, 但不能建车站 (车站必须在地面)",
  refs: ["knowledge/patterns/layout-styles.md P-style-09 (车站必须在地面)", "logistics.md L26 (高架上不能建车站)"],
  sources: [{ title: "官方 wiki: Railway (两种信号都能放在高架轨上, 车站不能)", url: "https://wiki.factorio.com/Railway", date: "2026-10-22", credibility: 2 }],
  gameSeconds: 1,
  async run(ctx) {
    const b = await site(ctx, 40);
    const m = (await ctx.lua(`local a = ...
      local s = game.surfaces[a.surface]
      local d = defines.direction
      local manual = defines.build_check_type.manual
      local y = a.ry
      s.create_entity{name = "rail-ramp", position = {a.x - 20, y}, direction = d.east, force = "player"}
      for x = a.x - 11, a.x - 5, 2 do s.create_entity{name = "elevated-straight-rail", position = {x, y}, direction = d.east, force = "player"} end -- 坡道只撑 8 格, 不越界
      s.create_entity{name = "straight-rail", position = {a.x + 15, y}, direction = d.east, force = "player"} -- 对照: 一段地面直轨
      local function can(name, x, yy, dir) return s.can_place_entity{name = name, position = {x, yy}, direction = dir, force = "player", build_check_type = manual} end
      -- 车站: 东行在南侧朝东 / 西行在北侧朝西 (和地面轨同样的偏移); 高架直轨中心 x-9
      local stop = can("train-stop", a.x - 9, y + 2, d.east) or can("train-stop", a.x - 9, y - 2, d.west)
      local groundStop = can("train-stop", a.x + 15, y + 2, d.east) or can("train-stop", a.x + 15, y - 2, d.west)
      -- 信号: can_place_entity 没有 rail_layer 参数, 永远按地面查 (第一次扫遍周围都"放不下"); 要用 create_entity 带 rail_layer = elevated 放, 再看接没接上高架轨
      local function try(name, x, yy, dir)
        local ok, e = pcall(function() return s.create_entity{name = name, position = {x, yy}, direction = dir, force = "player", rail_layer = defines.rail_layer.elevated} end)
        if not (ok and e) then return false end
        local rails = e.get_connected_rails()
        local hit = false
        for _, r in pairs(rails) do if r.name == "elevated-straight-rail" then hit = true end end
        if hit then lab.label(e, "高架上的信号") else e.destroy() end
        return hit
      end
      local sig = try("rail-signal", a.x - 8.5, y - 1.5, d.east) or try("rail-signal", a.x - 8.5, y + 1.5, d.west)
      local chain = try("rail-chain-signal", a.x - 6.5, y - 1.5, d.east) or try("rail-chain-signal", a.x - 6.5, y + 1.5, d.west)
      return {stop = stop, groundStop = groundStop, signal = sig, chain = chain}`, { ry: b.ry })) as { stop: boolean; groundStop: boolean; signal: boolean; chain: boolean };
    await ctx.powered();
    const ok = !m.stop && m.groundStop && m.signal && m.chain;
    return {
      verdict: !m.groundStop ? "inconclusive" : ok ? "verified" : m.stop ? "refuted" : "inconclusive",
      summary: `高架直轨旁: 车站${m.stop ? "放得下" : "放不下"} (对照 地面直轨旁${m.groundStop ? "放得下" : "放不下"}); 铁路信号${m.signal ? "放上了、接在高架轨上" : "放不上"}; 连锁信号${m.chain ? "放上了、接在高架轨上" : "放不上"} (信号要用 create_entity 带 rail_layer = 高架)`,
      measured: m,
    };
  },
};

export const lavaMaxGap: Experiment = {
  id: "elevated.vulcanus.lava-gap-crossable",
  topic: "祝融星",
  claim: "岩浆要很久以后才能填平, 但可以用高架铁路穿越 (提示原文); 支架立不了岩浆 (上一条), 只能近岸立支架、对岸放坡道 —— 实测能跨多宽 (只从一边接 / 两岸往中间接)",
  refs: ["docs/research/players/game-tips.md TT26", "elevated.vulcanus.lava-needs-supports (支架立不了岩浆)"],
  sources: [{ title: "游戏内提示与技巧: 祝融星导览 (岩浆可以通过高架铁路穿越)", credibility: 1 }],
  surface: "vulcanus",
  gameSeconds: 2,
  async run(ctx) {
    const widths = [6, 10, 14, 18, 20, 22, 24];
    const area: [[number, number], [number, number]] = [[ctx.x - 40, ctx.y - 30], [ctx.x + 50, ctx.y + 8 * widths.length]];
    ctx.watch(area);
    await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area, no_enemies: true }, { timeoutMs: 120_000 });
    const rows = (await ctx.lua(`local a = ...
      local s = game.surfaces[a.surface]
      local d = defines.direction
      local manual = defines.build_check_type.manual
      local out = {}
      for i, W in ipairs(a.widths) do
        local y = a.y - 25 + (i - 1) * 8
        if y % 2 == 0 then y = y + 1 end
        local r1 = a.x - 30                -- 上坡道中心 (偶数), 高架端 r1+8
        local L0 = r1 + 18                 -- 岩浆起点: 坡道撑到 r1+16, 支架立在 r1+16 (占 ±1.4 格) 还在岸上
        local ts = {}
        for x = L0, L0 + W - 1 do for yy = y - 3, y + 3 do ts[#ts + 1] = {name = "lava", position = {x, yy}} end end
        s.set_tiles(ts)
        local q = L0 + W                   -- 对岸坡道的高架端要在岸上
        if q % 2 == 1 then q = q + 1 end
        local r2 = q + 8
        s.create_entity{name = "rail-ramp", position = {r1, y}, direction = d.east, force = "player"}
        local down = s.can_place_entity{name = "rail-ramp", position = {r2, y}, direction = d.west, force = "player", build_check_type = manual}
        if down then s.create_entity{name = "rail-ramp", position = {r2, y}, direction = d.west, force = "player"} end
        local x, last_support = r1 + 9, nil
        while x <= q - 1 do
          if s.can_place_entity{name = "elevated-straight-rail", position = {x, y}, direction = d.east, force = "player", build_check_type = manual} then
            s.create_entity{name = "elevated-straight-rail", position = {x, y}, direction = d.east, force = "player"}
            x = x + 2
          elseif last_support ~= x - 1 and s.can_place_entity{name = "rail-support", position = {x - 1, y}, direction = d.east, force = "player", build_check_type = manual} then
            s.create_entity{name = "rail-support", position = {x - 1, y}, direction = d.east, force = "player"}
            last_support = x - 1
          else break end
        end
        local reached = x - 1
        -- 再从对岸坡道往回接 (坡道只撑接在它上面的轨, 所以要从它那头往中间接), 看两头能不能对上
        local xx = q - 1
        if down and reached < q then
          while xx - 1 > reached do
            if not s.can_place_entity{name = "elevated-straight-rail", position = {xx, y}, direction = d.east, force = "player", build_check_type = manual} then break end
            s.create_entity{name = "elevated-straight-rail", position = {xx, y}, direction = d.east, force = "player"}
            xx = xx - 2
          end
        end
        local met = reached >= q or (xx - 1 <= reached)
        out[i] = {W = W, rampDown = down, reached = reached, back = xx + 1, need = q, oneSide = down and reached >= q, bothSides = down and met}
      end
      return out`, { widths })) as { W: number; rampDown: boolean; reached: number; need: number; bridged: boolean }[];
    await ctx.powered();
    const one = rows.filter((r) => r.oneSide), both = rows.filter((r) => r.bothSides);
    const maxOne = one.length ? Math.max(...one.map((r) => r.W)) : 0, maxBoth = both.length ? Math.max(...both.map((r) => r.W)) : 0;
    return {
      verdict: both.length ? "verified" : "refuted",
      summary: `近岸支架 + 对岸坡道, 只从近岸往前接: 最宽跨过 ${maxOne} 格; 两岸同时往中间接: 最宽跨过 ${maxBoth} 格 (` + rows.map((r) => `${r.W} 格 ${r.oneSide ? "单边过" : r.bothSides ? "两边对接过" : "过不去"}`).join("、") + `)`,
      measured: { rows, maxOne, maxBoth },
    };
  },
};

export const aquiloAmmoniaSupports: Experiment = {
  id: "elevated.aquilo.supports-on-ammonia-ocean",
  topic: "玄冥星",
  claim: "玄冥星的氨海上能直接立高架支架, 不用填海也不用工程基座 (wiki 原文: and ammoniacal oceans on Aquilo without the need for landfill or foundation); 模组 Better Aquilo 的说明说\"深氨海不能直接建\", 两种说法冲突",
  refs: ["trains.md T8、T14 (支架能立在玄冥星氨海)", "planet-playbooks.md PB-A11 (模组说明: 深氨海不能)", "elevated.fulgora.deep-oil-needs-foundations (雷神星深油海要研究)"],
  sources: [
    { title: "官方 wiki: Rail support", url: "https://wiki.factorio.com/Rail_support", date: "2026-09-30", credibility: 2 },
    { title: "模组 Better Aquilo 说明 (经论坛摘要)", url: "https://mods.factorio.com/mod/BetterAquilo", credibility: 3 },
  ],
  surface: "aquilo",
  gameSeconds: 1,
  async run(ctx) {
    // 两种氨海 (原型 ammoniacal-ocean / ammoniacal-ocean-2) 和碎冰上立支架; 对照: 氨海上地面直轨放不下 (直轨中心在奇数格)
    const r = (await ctx.lua(CAN, { q: [
      { name: "rail-support", x: ctx.x - 12, y: ctx.y, tiles: ["ammoniacal-ocean"] },
      { name: "rail-support", x: ctx.x - 4, y: ctx.y, tiles: ["ammoniacal-ocean-2"] },
      { name: "rail-support", x: ctx.x + 4, y: ctx.y, tiles: ["brash-ice"] },
      { name: "straight-rail", x: ctx.x + 13, y: ctx.y + 1, tiles: ["ammoniacal-ocean"] },
    ] })) as boolean[];
    const tiles = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface] return {s.get_tile(a.x - 12, a.y).name, s.get_tile(a.x - 4, a.y).name, s.get_tile(a.x + 4, a.y).name}`)) as string[];
    await ctx.powered();
    const ok = r[0] && r[1] && r[2] && !r[3];
    return {
      verdict: tiles[0] !== "ammoniacal-ocean" ? "inconclusive" : ok ? "verified" : r[3] ? "inconclusive" : "refuted",
      summary: `玄冥星 (没研究支架地基): 氨海上支架${r[0] ? "放得下" : "放不下"}、另一种 (深色) 氨海${r[1] ? "放得下" : "放不下"}、碎冰${r[2] ? "放得下" : "放不下"}; 对照 氨海上地面直轨${r[3] ? "放得下" : "放不下"} → 模组说明"深氨海不能直接建"${r[1] ? "不成立 (原版)" : "成立"}`,
      measured: { r, tiles },
    };
  },
};

export const glebaMarshSupports: Experiment = {
  id: "elevated.gleba.supports-on-marsh",
  topic: "句芒星",
  claim: "句芒星的沼泽 (带水地块层的湿地) 上能直接立高架支架, 不用填海 (wiki 原文: Rail supports can be placed on top of ... marshes on Gleba)",
  refs: ["trains.md T8、T14 (高架是句芒星跨沼泽的主要办法)"],
  sources: [{ title: "官方 wiki: Rail support", url: "https://wiki.factorio.com/Rail_support", date: "2026-09-30", credibility: 2 }],
  surface: "gleba",
  gameSeconds: 1,
  async run(ctx) {
    const r = (await ctx.lua(CAN, { q: [
      { name: "rail-support", x: ctx.x - 8, y: ctx.y, tiles: ["wetland-yumako"] },
      { name: "rail-support", x: ctx.x, y: ctx.y, tiles: ["wetland-green-slime"] },
      { name: "straight-rail", x: ctx.x + 9, y: ctx.y + 1, tiles: ["wetland-yumako"] },
    ] })) as boolean[];
    await ctx.powered();
    const ok = r[0] && r[1] && !r[2];
    return {
      verdict: ok ? "verified" : r[2] ? "inconclusive" : "refuted",
      summary: `句芒星沼泽: 玉玛湿地上支架${r[0] ? "放得下" : "放不下"}、绿泥湿地上支架${r[1] ? "放得下" : "放不下"}; 对照 湿地上地面直轨${r[2] ? "放得下" : "放不下"}`,
      measured: { r },
    };
  },
};
