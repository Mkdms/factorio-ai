// 游戏内提示与技巧 (docs/research/players/game-tips.md 第 4 节) 进沙盘: 装填上限 TT2、放远端那道 TT1、快捷替换 TT21、铁路闸门 TT16、
// 岩浆销毁 TT27、品质保质期 TT35、加热例外 TT29; 外加第十二批回归里看到的"同名站够不着有空位 → 无路可走" (lab.md #44)。
// TT9 (蓝箱不勾就不从绿箱取) 已由 logistics2.ts bufferOnlyToOptedIn 核实; TT31 (着陆平台请求) 要太空平台, 下一批。
import type { Experiment, ExpContext } from "../src/verify/types.ts";
import { SET_SCHEDULE, build, status, waitState, rec } from "./trains.ts";
import { buildSignals } from "./trains3.ts";

const TIPS = (name: string) => ({ title: `游戏内提示与技巧: ${name} (本机 2.1.24)`, credibility: 1 as const });

// 料源 + 机械臂: 在 target 的 side 一侧贴一台机械臂 (取货方向 = side), 再外一格放永续箱
const FEED = `
local function feed(s, target, side, item, idx)
  local slot = lab.slots(target, side)[idx or 1]
  local src = lab.slots(target, side, 2)[idx or 1]
  local ins = lab.place{surface = s, name = "inserter", position = slot, direction = lab.pickup_dir[side], force = "player"}
  local c = lab.place{surface = s, name = "infinity-chest", position = src, force = "player"}
  c.set_infinity_container_filter(1, {name = item, count = 50, mode = "exactly"})
  return ins
end`;

export const insertionLimits: Experiment = {
  id: "tips.inserter.insertion-limits",
  topic: "机械臂",
  claim: "机械臂不会把目标装满: 机枪炮塔里有 10 发弹药 (原型 automated_ammo_count) 就不再装, 锅炉里有 5 个煤就不再装, 剩下的留给带子后面的",
  refs: ["docs/research/players/game-tips.md TT2 (搬运限制)", "feedback: 弹药靠传送带自动补 (一条弹药带串多座炮塔)"],
  sources: [TIPS("搬运限制"), { title: "本机原型: turrets.lua gun-turret automated_ammo_count = 10", credibility: 1 }],
  gameSeconds: 40,
  allowStatus: ["no_input_fluid"], // 锅炉故意不接水, 不让它烧煤
  async run(ctx) {
    await ctx.power();
    const r = (await ctx.lua(FEED + `
local a = ...
local s = game.surfaces[a.surface]
local t = lab.place{surface = s, name = "gun-turret", position = {a.x - 6, a.y}, force = "player"}
local b = lab.place{surface = s, name = "boiler", position = {a.x + 6, a.y}, direction = defines.direction.north, force = "player"}
feed(s, t, "west", "firearm-magazine")
feed(s, b, "south", "coal", 2)
return {t = {x = t.position.x, y = t.position.y}, b = {x = b.position.x, y = b.position.y}, limit = prototypes.entity["gun-turret"].automated_ammo_count}`)) as { t: { x: number; y: number }; b: { x: number; y: number }; limit: number };
    await ctx.ticks(60);
    await ctx.powered();
    await ctx.ticks(30 * 60);
    const m = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      local t = s.find_entity("gun-turret", {a.r.t.x, a.r.t.y}) local b = s.find_entity("boiler", {a.r.b.x, a.r.b.y})
      return {ammo = t.get_inventory(defines.inventory.turret_ammo).get_item_count("firearm-magazine"), coal = b.get_fuel_inventory().get_item_count("coal")}`, { r })) as { ammo: number; coal: number };
    const ok = m.ammo === r.limit && r.limit === 10 && m.coal === 5;
    return {
      verdict: ok ? "verified" : m.ammo > 10 || m.coal > 5 ? "refuted" : "inconclusive",
      summary: `机械臂从永续箱一直喂 30 秒: ${ctx.zh("gun-turret")}里停在 ${m.ammo} 发 (原型 automated_ammo_count ${r.limit}), ${ctx.zh("boiler")}里停在 ${m.coal} 个${ctx.zh("coal")} (没接水, 不烧)`,
      measured: { ...m, limit: r.limit },
    };
  },
};

export const inserterFarLane: Experiment = {
  id: "tips.inserter.drops-on-far-lane",
  topic: "机械臂",
  claim: "机械臂往传送带上放货只放远端那一道: 东行带子北边的机械臂放在南道 (右道), 南边的放在北道 (左道)",
  refs: ["docs/research/players/game-tips.md TT1 (传送带运送线路)"],
  sources: [TIPS("传送带运送线路")],
  gameSeconds: 20,
  async run(ctx) {
    await ctx.power();
    await ctx.lua(FEED + `
local a = ...
local s = game.surfaces[a.surface]
local mid
for i = -2, 2 do
  local e = lab.place{surface = s, name = "transport-belt", position = {a.x + i + 0.5, a.y + 0.5}, direction = defines.direction.east, force = "player"}
  if i == 0 then mid = e end
end
lab.label(feed(s, mid, "north", "iron-plate"), "北边放铁板")
lab.label(feed(s, mid, "south", "copper-plate"), "南边放铜板")
return true`);
    await ctx.ticks(60);
    await ctx.powered();
    await ctx.ticks(10 * 60);
    const m = (await ctx.lua(`local a = ... local out = {left = {}, right = {}}
      for _, e in pairs(game.surfaces[a.surface].find_entities_filtered{name = "transport-belt", area = {{a.x - 3, a.y - 1}, {a.x + 3, a.y + 2}}}) do
        for side, idx in pairs({left = defines.transport_line.left_line, right = defines.transport_line.right_line}) do
          for _, it in pairs(e.get_transport_line(idx).get_contents()) do out[side][it.name] = (out[side][it.name] or 0) + it.count end
        end
      end
      return out`)) as { left: Record<string, number>; right: Record<string, number> };
    const L = m.left ?? {}, R = m.right ?? {};
    const ok = (R["iron-plate"] ?? 0) > 0 && !L["iron-plate"] && (L["copper-plate"] ?? 0) > 0 && !R["copper-plate"];
    return {
      verdict: ok ? "verified" : (L["iron-plate"] ?? 0) > 0 || (R["copper-plate"] ?? 0) > 0 ? "refuted" : "inconclusive",
      summary: `东行带子: 左道 (北) ${ctx.zh("iron-plate")} ${L["iron-plate"] ?? 0}、${ctx.zh("copper-plate")} ${L["copper-plate"] ?? 0}; 右道 (南) ${ctx.zh("iron-plate")} ${R["iron-plate"] ?? 0}、${ctx.zh("copper-plate")} ${R["copper-plate"] ?? 0}`,
      measured: m,
    };
  },
};

export const fastReplaceKeeps: Experiment = {
  id: "tips.fast-replace.keeps-contents-and-recipe",
  topic: "建造",
  claim: "快捷替换 (在同类同尺寸的实体上直接建) 保留里面的物品和配方: 组装机1型换成 2 型, 配方和原料、成品都还在; 木箱换成铁箱, 东西还在 (对照: 先拆再建就没了)",
  refs: ["docs/research/players/game-tips.md TT21 (快捷替换)", "M5 升级流程 (升级不用先拆)"],
  sources: [TIPS("快捷替换"), { title: "API: LuaSurface.create_entity 的 fast_replace = 模拟玩家快捷替换", credibility: 1 }],
  allowUnpowered: true, // 不接电: 接了组装机会开工, 原料和成品数就变了
  gameSeconds: 5,
  allowStatus: ["no_power"], // 故意不接电, 接了组装机会开工
  async run(ctx) {
    const m = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local asm = lab.place{surface = s, name = "assembling-machine-1", position = {a.x - 4.5, a.y + 0.5}, force = f}
asm.set_recipe("iron-gear-wheel")
asm.get_inventory(defines.inventory.crafter_input).insert{name = "iron-plate", count = 40}
asm.get_output_inventory().insert{name = "iron-gear-wheel", count = 3}
local c1 = lab.place{surface = s, name = "wooden-chest", position = {a.x + 3.5, a.y + 0.5}, force = f}
c1.insert{name = "iron-plate", count = 30}
local c2 = lab.place{surface = s, name = "wooden-chest", position = {a.x + 6.5, a.y + 0.5}, force = f}
c2.insert{name = "iron-plate", count = 30}
-- 快捷替换: 本来就要压在旧实体上, 所以不走 lab.place (它查碰撞), 用 create_entity 的 fast_replace
local p = asm.position
local asm2 = s.create_entity{name = "assembling-machine-2", position = p, force = f, fast_replace = true, spill = false}
local p1 = c1.position
local n1 = s.create_entity{name = "iron-chest", position = p1, force = f, fast_replace = true, spill = false}
-- 对照: 先拆再建
local p2 = c2.position
c2.destroy()
local n2 = lab.place{surface = s, name = "iron-chest", position = p2, force = f}
lab.label(n2, "对照: 先拆再建")
local r = asm2 and asm2.get_recipe()
return {asm2 = asm2 and asm2.name or "没建成", recipe = r and r.name or "无", plates = asm2 and asm2.get_inventory(defines.inventory.crafter_input).get_item_count("iron-plate") or -1,
        gears = asm2 and asm2.get_output_inventory().get_item_count("iron-gear-wheel") or -1, chest = n1 and n1.get_item_count("iron-plate") or -1, chestName = n1 and n1.name or "没建成",
        control = n2.get_item_count("iron-plate"), oldGone = #s.find_entities_filtered{name = {"assembling-machine-1", "wooden-chest"}, area = {{a.x - 10, a.y - 3}, {a.x + 10, a.y + 3}}}}`)) as Record<string, number | string>;
    await ctx.powered(); // allowUnpowered: 不补杆, 只查布局和状态 (2026-11-02 起框架这样处理)
    const ok = m.asm2 === "assembling-machine-2" && m.recipe === "iron-gear-wheel" && m.plates === 40 && m.gears === 3 && m.chestName === "iron-chest" && m.chest === 30 && m.control === 0 && m.oldGone === 0;
    return {
      verdict: ok ? "verified" : m.asm2 === "assembling-machine-2" && (m.plates === 0 || m.recipe === "无") ? "refuted" : "inconclusive",
      summary: `组装机1型 → ${ctx.zh(String(m.asm2))}: 配方 ${m.recipe === "无" ? "没了" : ctx.zh(String(m.recipe))}、原料 ${m.plates}/40、成品 ${m.gears}/3; 木箱 → ${ctx.zh(String(m.chestName))}: ${m.chest}/30; 对照 (先拆再建) ${m.control}; 旧实体剩 ${m.oldGone} 个`,
      measured: m,
    };
  },
};

export const railGate: Experiment = {
  id: "tips.rail-gate.train-opens-it",
  topic: "火车",
  claim: "闸门可以建在直轨上 (轨道两格各一个), 列车开过来闸门自动打开, 车不停, 开过去后闸门再关上",
  refs: ["docs/research/players/game-tips.md TT16 (铁路闸门)", "knowledge/patterns/defense.md (墙穿铁路)"],
  sources: [TIPS("铁路闸门")],
  gameSeconds: 120,
  async run(ctx) {
    const b = await build(ctx);
    const g = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local rx = a.x - 17 -- 列车停在甲站时车身在 x-45 ~ x-24, 闸门要在它东边才关得上
local out = {}
for _, y in ipairs({a.ry - 0.5, a.ry + 0.5}) do
  local dir
  for _, d in ipairs({defines.direction.north, defines.direction.east}) do
    if not dir and s.can_place_entity{name = "gate", position = {rx - 0.5, y}, direction = d, force = "player", build_check_type = defines.build_check_type.manual} then dir = d end
  end
  if not dir then error("闸门放不上直轨 (" .. (rx - 0.5) .. ", " .. y .. ")", 0) end
  local e = s.create_entity{name = "gate", position = {rx - 0.5, y}, direction = dir, force = "player"} -- 闸门本来就压在铁轨上, lab.place 的碰撞检查会拦, 上面用玩家摆放规则查过
  out[#out + 1] = {x = e.position.x, y = e.position.y, dir = dir}
end
return out`, { ry: b.ry })) as { x: number; y: number; dir: number }[];
    await ctx.powered();
    const gateState = async () => (await ctx.lua(`local a = ... local s = game.surfaces[a.surface] local n = 0
      for _, p in ipairs(a.g) do local e = s.find_entity("gate", {p.x, p.y}) if e and not e.is_closed() then n = n + 1 end end return n`, { g })) as number;
    const before = await gateState();
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 1, records: [rec("甲", 3)] } });
    let openSeen = 0, stopsMidway = 0, moving = false;
    const stopsAt: number[] = [];
    const gx = g[0].x;
    for (let t = 0; t < 60 * 60; t += 5) {
      await ctx.ticks(5);
      const s = await status(ctx, b.train_id);
      if (Math.abs(s.speed) > 0.01) moving = true;
      else if (moving && s.state !== "wait_station" && Math.abs(s.x - gx) < 15) { stopsMidway++; stopsAt.push(Math.round(s.x)); } // 进站前减速到 0 那一下不算 (第一次干跑把它当成了中途停车)
      if (Math.abs(s.x - gx) < 12) openSeen = Math.max(openSeen, await gateState());
      if (s.state === "wait_station") break;
    }
    const at = await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "甲", 30, 10);
    await ctx.ticks(10 * 60);
    const after = await gateState();
    const measured = { gates: g, before, openSeen, stopsMidway, stopsAt: [...new Set(stopsAt)], arrived: !!at, after };
    const ok = before === 0 && openSeen === 2 && stopsMidway === 0 && !!at && after === 0;
    return {
      verdict: ok ? "verified" : !at ? "inconclusive" : "refuted",
      summary: `直轨上 2 个闸门 (朝向 ${g.map((x) => x.dir).join("/")}): 车来之前开着 ${before} 个; 车经过时开着 ${openSeen} 个; 在闸门前后 15 格内停车 ${stopsMidway} 个采样点${stopsAt.length ? ` (x=${[...new Set(stopsAt)].join("/")}, 闸门 x=${gx})` : ""}; ${at ? "到了甲站" : "没到甲站"}; 过后 10 秒开着 ${after} 个`,
      measured,
    };
  },
};

export const lavaDisposal: Experiment = {
  id: "tips.vulcanus.lava-destroys-items",
  topic: "祝融星",
  claim: "祝融星上机械臂把东西放到岩浆地块上就清掉了 (一次放一整堆, 2.1.9 起): 箱子里 20 块铁板被搬空、地上什么都没留; 对照: 放到普通地面只能放下 1 件, 机械臂就停了",
  refs: ["docs/research/players/game-tips.md TT27 (岩浆加工)", "vulcanus.md (石矿出口和岩浆)"],
  sources: [TIPS("岩浆加工"), { title: "本机更新日志 2.1.9: 机械臂往岩浆里放会一次放一整堆", credibility: 1 }],
  surface: "vulcanus",
  allowLayout: ["inserter-empty-target"],
  gameSeconds: 40,
  async run(ctx) {
    await ctx.power();
    const r = (await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local out = {}
for i, lava in ipairs({true, false}) do
  local y = a.y + (i == 1 and -2.5 or 2.5)
  local c = lab.place{surface = s, name = "iron-chest", position = {a.x - 3.5, y}, force = "player"}
  c.insert{name = "iron-plate", count = 20}
  local slot = lab.slots(c, "east")[1]
  local ins = lab.place{surface = s, name = "inserter", position = slot, direction = defines.direction.west, force = "player"}
  local tx, ty = slot.x + 1, slot.y
  if lava then s.set_tiles({{name = "lava", position = {math.floor(tx), math.floor(ty)}}}) end
  lab.label(ins, lava and "往岩浆上放" or "对照: 往地上放")
  out[i] = {chest = {x = c.position.x, y = c.position.y}, tx = tx, ty = ty, tile = s.get_tile(tx, ty).name}
end
return out`)) as { chest: { x: number; y: number }; tx: number; ty: number; tile: string }[];
    await ctx.ticks(60);
    await ctx.powered();
    await ctx.ticks(40 * 60); // 普通机械臂一来一回约 1.2 秒, 20 件约 24 秒
    const m = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface] local out = {}
      for i, p in ipairs(a.r) do
        local c = s.find_entity("iron-chest", {p.chest.x, p.chest.y})
        local ground = 0
        for _, it in pairs(s.find_entities_filtered{type = "item-entity", area = {{p.tx - 1, p.ty - 1}, {p.tx + 1, p.ty + 1}}}) do ground = ground + it.stack.count end
        out[i] = {left = c.get_item_count("iron-plate"), ground = ground}
      end
      return out`, { r })) as { left: number; ground: number }[];
    const [lava, plain] = m;
    const ok = r[0].tile === "lava" && lava.left === 0 && lava.ground === 0 && plain.left >= 18 && plain.ground >= 1;
    return {
      verdict: ok ? "verified" : r[0].tile !== "lava" ? "inconclusive" : "refuted",
      summary: `岩浆 (${r[0].tile}): 箱子剩 ${lava.left}/20, 地上 ${lava.ground}; 对照 普通地面 (${r[1].tile}): 箱子剩 ${plain.left}/20, 地上 ${plain.ground}`,
      measured: { r, m },
    };
  },
};

export const qualitySpoil: Experiment = {
  id: "tips.spoil.quality-lasts-longer",
  topic: "腐坏",
  claim: "品质越高保质期越长: 保质期乘品质的 spoil_ticks_multiplier (默认 1 + 0.3×等级: 精良 1.3、稀有 1.6、史诗 1.9、传说 2.5), 同样时间里坏得按这个倍数慢",
  refs: ["docs/research/players/game-tips.md TT35 (变质)", "本机更新日志 2.1.7 (QualityPrototype::spoil_ticks_multiplier)"],
  sources: [TIPS("变质"), { title: "本机 API 文档: QualityPrototype.spoil_ticks_multiplier 默认 = default_multiplier = 1 + 0.3 × level", credibility: 1 }],
  gameSeconds: 25,
  async run(ctx) {
    const qs = ["normal", "uncommon", "rare", "epic", "legendary"];
    await ctx.lua(`local a = ... local c = lab.place{surface = game.surfaces[a.surface], name = "steel-chest", position = {a.x + 0.5, a.y + 0.5}, force = "player"}
      local inv = c.get_inventory(defines.inventory.chest)
      for i, q in ipairs(a.qs) do inv[i].set_stack{name = "nutrients", count = 10, quality = q} end return true`, { qs });
    await ctx.powered();
    await ctx.ticks(1200);
    const m = (await ctx.lua(`local a = ... local c = game.surfaces[a.surface].find_entity("steel-chest", {a.x + 0.5, a.y + 0.5})
      local inv = c.get_inventory(defines.inventory.chest) local out = {}
      for i = 1, #a.qs do local st = inv[i] out[i] = {q = st.quality.name, spoil = st.spoil_percent, mult = prototypes.quality[st.quality.name].spoil_ticks_multiplier} end
      return out`, { qs })) as { q: string; spoil: number; mult: number }[];
    const base = m[0].spoil;
    const rows = m.map((x) => ({ ...x, ratio: base / x.spoil }));
    const ok = base > 0 && rows.every((x) => Math.abs(x.ratio - x.mult) / x.mult < 0.01) && Math.abs(rows[4].mult - 2.5) < 1e-6;
    return {
      verdict: ok ? "verified" : base > 0 ? "refuted" : "inconclusive",
      summary: `${ctx.zh("nutrients")} 20 秒: ` + rows.map((x) => `${x.q} 坏了 ${(x.spoil * 100).toFixed(2)}% (慢 ${x.ratio.toFixed(3)} 倍, 倍率 ${x.mult})`).join("; "),
      measured: { rows },
    };
  },
};

export const heatingExceptions: Experiment = {
  id: "tips.aquilo.unheated-freeze-except-poles-solar-accumulators",
  topic: "玄冥星",
  claim: "玄冥星上没贴着热源的建筑会冻住, 例外是电线杆、太阳能板、蓄电器 (不冻)",
  refs: ["docs/research/players/game-tips.md TT29 (加热机械)", "aquilo.md (加热和保温)", "feedback: 玄冥星防冻"],
  sources: [TIPS("加热机械")],
  surface: "aquilo",
  allowUnpowered: true, // 测的是冻不冻, 不接电 (接了电也不影响结冰)
  allowLayout: ["inserter-empty-target"], // 机械臂是单独放着看冻不冻的
  gameSeconds: 200,
  allowStatus: ["frozen"], // 测的就是冻住
  async run(ctx) {
    const names = ["small-electric-pole", "solar-panel", "accumulator", "assembling-machine-1", "inserter", "transport-belt", "iron-chest"];
    await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      for i, n in ipairs(a.names) do
        local e = lab.place{surface = s, name = n, position = {a.x - 14 + i * 4 + 0.5, a.y + 0.5}, force = "player"} -- lint-ok: 测的就是电线杆会不会冻, 不是给实验供电
        lab.label(e, n == "small-electric-pole" and "电线杆" or "")
      end return true`, { names });
    await ctx.powered(); // 同上: 不补杆, 只查布局和状态
    const first: Record<string, number> = {};
    let ever: Record<string, string> = {};
    for (let t = 0; t <= 180 * 60; t += 300) {
      if (t) await ctx.ticks(300);
      ever = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface] local out = {}
        for i, n in ipairs(a.names) do
          local e = s.find_entities_filtered{name = n, area = {{a.x - 14 + i * 4 - 1.5, a.y - 1.5}, {a.x - 14 + i * 4 + 2.5, a.y + 2.5}}}[1]
          local ok, fr = pcall(function() return e.frozen end)
          out[n] = not e and "没找到" or (not ok and "不可冻") or (fr and "冻住" or "没冻")
        end return out`, { names })) as Record<string, string>;
      for (const n of names) if (ever[n] === "冻住" && first[n] === undefined) first[n] = t / 60;
      if (names.slice(3, 6).every((n) => first[n] !== undefined) && t >= 60 * 60) break;
    }
    const exceptions = names.slice(0, 3), others = names.slice(3, 6);
    const ok = exceptions.every((n) => first[n] === undefined) && others.every((n) => first[n] !== undefined);
    return {
      verdict: ok ? "verified" : exceptions.some((n) => first[n] !== undefined) ? "refuted" : "inconclusive",
      summary: names.map((n) => `${ctx.zh(n)} ${first[n] !== undefined ? `${first[n]} 秒冻住` : ever[n]}`).join("、"),
      measured: { first, last: ever },
    };
  },
};

export const unreachableSameNameNoPath: Experiment = {
  id: "trains.same-name-unreachable.no-path-not-full",
  topic: "火车",
  claim: "同名车站里够得着的都满了、但还有一个够不着且有空位时, 列车显示\"无路可走\"而不是\"目的地已满\"; 把那个够不着的站拆掉, 就变回\"目的地已满\"",
  refs: ["lab.md #44 (第十二批回归里看到的)", "trains.md T20、T25 (无路可走 / 目的地已满)"],
  sources: [{ title: "本项目第十二批回归的意外读数 (待核实的推断)", credibility: 1 }],
  gameSeconds: 120,
  async run(ctx) {
    const b = await buildSignals(ctx);
    // 南边 6 格另铺一小段不连通的轨, 上面也有一个"丙" (有空位, 但哪辆车都开不过去)
    const lone = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface] local d = defines.direction
      for x = a.x - 9, a.x + 9, 2 do lab.place{surface = s, name = "straight-rail", position = {x, a.ry + 6}, direction = d.east, force = "player"} end
      local st = lab.place{surface = s, name = "train-stop", position = {a.x, a.ry + 4}, direction = d.west, force = "player", station = "丙"}
      if not st.connected_rail then error("孤站没接上轨", 0) end
      st.backer_name = "丙"
      lab.label(st, "够不着的丙 (故意)")
      return {x = st.position.x, y = st.position.y}`, { ry: b.ry })) as { x: number; y: number };
    await ctx.powered();
    await ctx.lua(`local a = ... game.surfaces[a.surface].find_entity("train-stop", {a.x, a.y}).trains_limit = 1 return true`, b.bing);
    await ctx.lua(SET_SCHEDULE, { train_id: b.A, schedule: { current: 1, records: [rec("丙", 600)] } });
    await ctx.ticks(60);
    await ctx.lua(SET_SCHEDULE, { train_id: b.B, schedule: { current: 1, records: [rec("丙", 3)] } });
    await ctx.ticks(120);
    const withLone = await status(ctx, b.B), aState = await status(ctx, b.A);
    await ctx.lua(`local a = ... game.surfaces[a.surface].find_entity("train-stop", {a.x, a.y}).destroy() return true`, lone);
    await ctx.ticks(120);
    const without = await status(ctx, b.B);
    const ok = withLone.state === "no_path" && without.state === "destination_full";
    return {
      verdict: ok ? "verified" : withLone.state === "destination_full" ? "refuted" : "inconclusive",
      summary: `本场丙站上限 1 被 A 占着 (A ${aState.state}); 另有一个够不着、有空位的丙: B 是 ${withLone.state}; 拆掉那个孤站后 B 是 ${without.state}`,
      measured: { withLone, without, aState },
    };
  },
};
