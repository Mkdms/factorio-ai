// 其他星球: 雷神星废料回收的共享概率、祝融星酸中和每个方解石换多少电、新地星锅炉比例。
// 电网统计 (electric_network_statistics) 和物品统计的两列含义相反: 电网里 input = 耗电、output = 发电 (2.1.24 实测)。
// 流体接法不靠猜: 建好机器后读它的流体接口连接点 (fluidbox.get_pipe_connections), 按连接点的目标位置放永续管道 / 管道 / 发电机。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

// 公共 Lua: 读实体的流体连接点; 放一台竖着的发电机 (汽轮机 / 蒸汽机 3×5) 让它的北端接到 (tx, ty) 这格的管道
const LUA_COMMON = `
-- 2.1.24: LuaEntity 没有 fluidbox 属性了, 用 get_fluid_box_pipe_connections(序号); 接口数量从原型读
-- 有配方的机器只有当前配方用到的接口有效 (化工厂原型 4 个, 酸中和只有 2 个), 所以逐个试到报错为止
local function conns(e)
  local out = {}
  for i = 1, 8 do
    local ok, list = pcall(e.get_fluid_box_pipe_connections, i)
    if not ok then break end
    for _, c in pairs(list) do
      out[#out + 1] = {i = i, dir = c.flow_direction, x = c.position.x, y = c.position.y, tx = c.target_position and c.target_position.x, ty = c.target_position and c.target_position.y}
    end
  end
  return out
end
-- 发电机竖放, 北端连接点的目标格 = (tx, ty): 先试放一台读它的端口偏移, 再按偏移放到正确的位置
local function generator_below(s, name, tx, ty, f)
  local probe = s.create_entity{name = name, position = {tx, ty + 40}, direction = defines.direction.north, force = f}
  local off = 3
  for _, c in pairs(conns(probe)) do if c.ty and c.ty < probe.position.y then off = probe.position.y - c.ty end end
  probe.destroy()
  return s.create_entity{name = name, position = {tx, ty + off}, direction = defines.direction.north, force = f}, off
end
`;

const near = (v: number, want: number, tol: number) => Math.abs(v - want) / want <= tol;

/* ---------------- 雷神星: 废料回收共享概率 ---------------- */
const RECYCLER = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
s.create_entity{name = "electric-energy-interface", position = {a.x + 6, a.y}, force = f}
s.create_entity{name = "medium-electric-pole", position = {a.x + 3.5, a.y + 0.5}, force = f}
game.forces.player.recipes["scrap-recycling"].enabled = true -- 没研究的配方机器不开工 (第一次漏了, 状态 18、完成 0 次)
local r = s.create_entity{name = "recycler", position = {a.x, a.y}, direction = defines.direction.north, force = f}
local inserted = r.insert{name = "scrap", count = 1}
return {x = r.position.x, y = r.position.y, inserted = inserted}`;

const RECYCLE_ONE = `
local a = ...
local r = game.surfaces[a.surface].find_entity("recycler", {a.ref.x, a.ref.y})
local out = r.get_output_inventory()
local kinds, total = 0, 0
for _, it in pairs(out.get_contents()) do kinds = kinds + 1 total = total + it.count end
out.clear()
local inserted = r.insert{name = "scrap", count = 1}
return {kinds = kinds, total = total, finished = r.products_finished, status = r.status, inserted = inserted} -- lint-ok: 回收机 / 化工厂都没有产能
`;

export const scrapSharedProbability: Experiment = {
  id: "fulgora.scrap-recycling.shared-probability",
  topic: "雷神星",
  claim: "2.1 的废料回收是共享概率: 一个废料一次最多出一种产物 (合计 60% 出东西, 40% 什么都不出), 不再是每种产物各自掷骰",
  refs: ["fulgora.md F19", "research README 第二轮 #2", "wiki 废料页 (2026-10-06) 还写着各自掷骰"],
  sources: [
    { title: "本机原型数据: scrap-recycling 结果带 shared_probability 区间 (0~0.6)", credibility: 1 },
    { title: "本机 changelog 2.1 (模组分节: shared_probability 字段)", credibility: 1 },
  ],
  gameSeconds: 150,
  async run(ctx) {
    const ref = await ctx.lua(RECYCLER);
    const N = 250;
    let multi = 0, items = 0, crafts = 0, skipped = 0, last: { finished: number; status: number } | null = null;
    for (let i = 0; i <= N; i++) {
      const r = (await ctx.lua(RECYCLE_ONE, { ref })) as { kinds: number; total: number; finished: number; status: number };
      // 只统计"上次读之后正好完成 1 次"的样本; 两次一起读到的 (回归时出过 1 次) 跳过, 不然会把两轮产物当成一轮
      if (last && r.finished - last.finished === 1) {
        if (r.kinds >= 2) multi++;
        items += r.total;
        crafts++;
      } else if (last) skipped++;
      last = r;
      await ctx.ticks(36); // 回收机速度 0.5, 一次 0.4 秒 = 24 tick
    }
    if (crafts < N * 0.9) return { verdict: "inconclusive", summary: `回收机只完成了 ${crafts} 次 (状态 ${last!.status}, 最后一次塞进 ${(last as { inserted?: number }).inserted} 个废料), 没开工`, measured: { crafts, items, multi, last } };
    const yieldRatio = items / crafts;
    const verdict = multi === 0 && yieldRatio > 0.5 && yieldRatio < 0.7 ? "verified" : multi >= crafts * 0.06 ? "refuted" : "inconclusive";
    return {
      verdict,
      summary: `回收 ${crafts} 个废料 (跳过 ${skipped} 个没对齐的样本): 出东西 ${items} 件 (${(yieldRatio * 100).toFixed(0)}%, 预期约 60%), 一次出两种以上产物的有 ${multi} 次 (各自掷骰的话约 ${Math.round(crafts * 0.12)} 次)`,
      measured: { crafts, items, multi, skipped, yieldRatio },
    };
  },
};

/* ---------------- 祝融星: 酸中和每个方解石换多少电 ---------------- */
const ACID = LUA_COMMON + `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
game.forces.player.recipes["acid-neutralisation"].enabled = true
local plant = s.create_entity{name = "chemical-plant", position = {a.x, a.y}, direction = defines.direction.north, force = f}
plant.set_recipe("acid-neutralisation")
plant.insert{name = "calcite", count = 200}
local input, output
for _, c in pairs(conns(plant)) do
  if c.dir == "input" and not input then input = c end
  if c.dir == "output" and not output then output = c end
end
if not (input and output and input.tx and output.tx) then error("读不到化工厂的流体接口", 0) end
local ip = s.create_entity{name = "infinity-pipe", position = {input.tx, input.ty}, force = f}
ip.set_infinity_pipe_filter{name = "sulfuric-acid", percentage = 1, mode = "at-least"}
-- 蒸汽: 出口往南铺 3 格管道, 接两台汽轮机
local tx, ty = output.tx, output.ty
for i = 0, 2 do s.create_entity{name = "pipe", position = {tx, ty + i}, force = f} end
local t1, off = generator_below(s, "steam-turbine", tx, ty + 2, f)
s.create_entity{name = "pipe", position = {tx, t1.position.y + off}, force = f}
local t2 = generator_below(s, "steam-turbine", tx, t1.position.y + off, f)
local pole = s.create_entity{name = "medium-electric-pole", position = {tx + 2.5, t1.position.y + 3.5}, force = f}
-- 化工厂自己也要电 (第一次只给汽轮机旁放了杆子, 化工厂 no_power): 再放一根盖住化工厂, 明确连线
local pole2 = s.create_entity{name = "medium-electric-pole", position = {tx + 2.5, ty + 1.5}, force = f}
pole.get_wire_connector(defines.wire_connector_id.pole_copper, true).connect_to(pole2.get_wire_connector(defines.wire_connector_id.pole_copper, true))
local eei = s.create_entity{name = "electric-energy-interface", position = {tx + 5, t1.position.y + 3}, force = f}
eei.power_production = 0 -- lint-ok: 同时把 electric_buffer_size 设成 2 tick 的量, 实测能从电网取电
eei.power_usage = a.load_mw * 1e6 / 60
eei.electric_buffer_size = a.load_mw * 1e6 / 60 * 2
eei.energy = 0
-- 酸中和的电站自己发电自己用, 冷启动要借电: 预热阶段放一个供电的电力接口, 测量前拆掉
local boot = s.create_entity{name = "electric-energy-interface", position = {tx + 5, ty + 1}, force = f}
return {plant = {x = plant.position.x, y = plant.position.y}, pole = {x = pole.position.x, y = pole.position.y}, boot = {x = boot.position.x, y = boot.position.y},
        t1 = {x = t1.position.x, y = t1.position.y}, t2 = {x = t2.position.x, y = t2.position.y}, off = off}`;

const ACID_READ = `
local a = ...
local s = game.surfaces[a.surface]
local plant = s.find_entity("chemical-plant", {a.ref.plant.x, a.ref.plant.y})
local pole = s.find_entity("medium-electric-pole", {a.ref.pole.x, a.ref.pole.y})
local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
local t1 = s.find_entity("steam-turbine", {a.ref.t1.x, a.ref.t1.y})
if a.remove_boot then local b = s.find_entity("electric-energy-interface", {a.ref.boot.x, a.ref.boot.y}) if b then b.destroy() end end
-- 电网统计: 发电机只发不耗, 取它两列里大的那个就是发电量 (哪列是"产"哪列是"耗"文档说得绕, 不赌)
local stats = pole.electric_network_statistics
local produced = math.max(stats.get_output_count("steam-turbine"), stats.get_input_count("steam-turbine"))
return {crafts = plant.products_finished, plant_status = names[plant.status], turbine_status = t1 and names[t1.status], -- lint-ok: 回收机 / 化工厂都没有产能
        joules = produced, tick = game.tick}`;

export const acidNeutralisationEnergy: Experiment = {
  id: "vulcanus.acid-neutralisation.energy-per-calcite",
  topic: "祝融星",
  claim: "2.1 的酸中和: 1 个方解石 + 100 硫酸 → 1000 单位 500 度蒸汽, 经汽轮机约 97MJ 电; 所以 100MW 的酸中和电站每秒约吃 1 个方解石 (2.0 是这个的 10 倍)",
  refs: ["vulcanus.md V11~V13", "research README 第二轮 #1", "changes-2.1.md 第 5 节 (已改正)"],
  sources: [
    { title: "本机原型数据: acid-neutralisation 配方 (2.1.24); 蒸汽热容 0.2kJ, 汽轮机 60/秒 上限 500 度", credibility: 1 },
    { title: "本机 changelog 2.1.7: 酸中和液体量和时间缩小 10 倍", credibility: 1 },
  ],
  surface: "vulcanus",
  gameSeconds: 620,
  async run(ctx) {
    const ref = await ctx.lua(ACID, { load_mw: 10 });
    await ctx.ticks(20 * 60); // 预热: 灌酸、起蒸汽、汽轮机转起来
    const a = (await ctx.lua(ACID_READ, { ref, remove_boot: true })) as { crafts: number; joules: number; tick: number; plant_status: string; turbine_status: string };
    await ctx.ticks(600 * 60);
    const b = (await ctx.lua(ACID_READ, { ref })) as { crafts: number; joules: number; tick: number; plant_status: string; turbine_status: string };
    const seconds = (b.tick - a.tick) / 60, crafts = b.crafts - a.crafts, mj = (b.joules - a.joules) / 1e6;
    if (crafts < 5 || mj < 1) return { verdict: "inconclusive", summary: `没跑起来: 化工厂 ${b.plant_status}, 汽轮机 ${b.turbine_status}, ${seconds} 秒完成 ${crafts} 次、发电 ${mj.toFixed(0)}MJ`, measured: { a, b, ref } };
    const perCalcite = mj / crafts, mw = mj / seconds, calcitePerSecAt100MW = (100 / mw) * (crafts / seconds);
    return {
      verdict: near(perCalcite, 97, 0.06) ? "verified" : "refuted",
      summary: `${seconds} 秒里 ${mw.toFixed(1)}MW 负载吃了 ${crafts} 个方解石, 每个方解石 ${perCalcite.toFixed(1)}MJ 电 (预期 97); 折算 100MW 每秒 ${calcitePerSecAt100MW.toFixed(2)} 个方解石`,
      measured: { seconds, crafts, mj, perCalcite, mw },
    };
  },
};

/* ---------------- 新地星: 1 锅炉 : 2 蒸汽机, 20 锅炉吃满 1 台抽取泵 ---------------- */
const BOILER = LUA_COMMON + `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local by = a.y + 8
local boiler = s.create_entity{name = "boiler", position = {a.x, by}, direction = defines.direction.north, force = f}
-- 燃料槽只有 1 格 (煤一组 50 = 200MJ, 1.8MW 只够 111 秒), 用固体燃料 (12MJ × 50 = 600MJ)
local inserted = boiler.insert{name = "solid-fuel", count = 50}
local water, steam
for _, c in pairs(conns(boiler)) do
  if c.dir == "output" then steam = c elseif not water then water = c end
end
if not (water and steam and water.tx and steam.tx) then error("读不到锅炉的流体接口", 0) end
local ip = s.create_entity{name = "infinity-pipe", position = {water.tx, water.ty}, force = f}
ip.set_infinity_pipe_filter{name = "water", percentage = 1, mode = "at-least"}
-- 蒸汽口在北边: 往北铺 2 格管道, 再往北接 3 台蒸汽机 (第 3 台用来证明 1 台锅炉只够 2 台)
local tx, ty = steam.tx, steam.ty
s.create_entity{name = "pipe", position = {tx, ty}, force = f}
s.create_entity{name = "pipe", position = {tx, ty - 1}, force = f}
-- 蒸汽机竖放, 南端接 (tx, ty - 1): 试放一台读端口偏移
local probe = s.create_entity{name = "steam-engine", position = {tx, ty + 40}, direction = defines.direction.north, force = f}
local off = 3
for _, c in pairs(conns(probe)) do if c.ty and c.ty > probe.position.y then off = c.ty - probe.position.y end end
probe.destroy()
local engines = {}
local nexty = ty - 1
for i = 1, 3 do
  local e = s.create_entity{name = "steam-engine", position = {tx, nexty - off}, direction = defines.direction.north, force = f}
  engines[i] = {x = e.position.x, y = e.position.y}
  nexty = e.position.y - off
  if i < 3 then s.create_entity{name = "pipe", position = {tx, nexty}, force = f} end
end
local sub = s.create_entity{name = "substation", position = {a.x + 4, a.y - 2}, force = f}
local eei = s.create_entity{name = "electric-energy-interface", position = {a.x + 7, a.y + 2}, force = f}
eei.power_production = 0 -- lint-ok: 同时把 electric_buffer_size 设成 2 tick 的量, 实测能从电网取电
eei.power_usage = a.load_mw * 1e6 / 60
eei.electric_buffer_size = a.load_mw * 1e6 / 60 * 2
eei.energy = 0
return {boiler = {x = boiler.position.x, y = boiler.position.y}, sub = {x = sub.position.x, y = sub.position.y}, engines = engines, coal_inserted = inserted}`;

const BOILER_READ = `
local a = ...
local s = game.surfaces[a.surface]
local sub = s.find_entity("substation", {a.ref.sub.x, a.ref.sub.y})
local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
local st = {}
for i, e in ipairs(a.ref.engines) do
  local en = s.find_entity("steam-engine", {e.x, e.y})
  local fl = {}
  if en then for k, v in pairs(en.get_fluid_contents()) do fl[#fl + 1] = k .. "=" .. math.floor(v) end end
  st[i] = en and (names[en.status] .. "[" .. table.concat(fl, ",") .. "]") or "没找到"
end
local boiler = s.find_entity("boiler", {a.ref.boiler.x, a.ref.boiler.y})
local bf = {}
for k, v in pairs(boiler.get_fluid_contents()) do bf[#bf + 1] = k .. "=" .. math.floor(v) end
local fluids = game.forces.player.get_fluid_production_statistics(s)
local stats = sub.electric_network_statistics
local produced = math.max(stats.get_output_count("steam-engine"), stats.get_input_count("steam-engine"))
return {joules = produced,
        water = fluids.get_output_count("water"), tick = game.tick, engines = st, boiler = names[boiler.status] .. "[" .. table.concat(bf, ",") .. "]"}`;

export const boilerRatio: Experiment = {
  id: "power.boiler.1-to-2-to-200",
  topic: "电",
  claim: "2.0.7 起 1 水 = 10 蒸汽: 1 台锅炉 (1.8MW) 每秒吃 6 水、出 60 蒸汽, 正好带 2 台蒸汽机 (各 900kW, 第 3 台不多出电); 1 台抽取泵 (1200/秒) 供 200 台锅炉, 比例 1:200:400 (2.0 以前的 1:20:40 已过时; 第二轮检索把这条写反了)",
  refs: ["nauvis.md 第 3 节 (原写\"本机仍是 1:20:40\", 错)", "research README 第二轮\"已确认是错的说法\"里的抽取泵一条 (本身错了, 已改)"],
  sources: [
    { title: "本机 changelog 2.0.7: 1 Water will now produce 10 Steam in boilers/heat exchangers; 原型: 水热容 2kJ、蒸汽 0.2kJ、锅炉 1.8MW / 165 度、蒸汽机 0.5 单位/tick、抽取泵 20 单位/tick", credibility: 1 },
    { title: "官方 wiki: Boiler (6 水/秒, 60 蒸汽/秒)", url: "https://wiki.factorio.com/Boiler", date: "2026-09-30", credibility: 2 },
  ],
  gameSeconds: 130,
  async run(ctx) {
    const ref = await ctx.lua(BOILER, { load_mw: 2.7 });
    await ctx.ticks(20 * 60);
    const a = (await ctx.lua(BOILER_READ, { ref })) as { joules: number; water: number; tick: number; engines: string[] };
    await ctx.ticks(100 * 60);
    const b = (await ctx.lua(BOILER_READ, { ref })) as { joules: number; water: number; tick: number; engines: string[] };
    const seconds = (b.tick - a.tick) / 60, mw = (b.joules - a.joules) / 1e6 / seconds, waterPerSec = (b.water - a.water) / seconds;
    if (mw < 0.5) return { verdict: "inconclusive", summary: `没发出电: 锅炉 ${(b as { boiler: string }).boiler} (开始塞进固体燃料 ${(ref as { coal_inserted: number }).coal_inserted}), 蒸汽机 ${b.engines.join(" / ")}`, measured: { a, b, ref } };
    const ok = near(mw, 1.8, 0.05) && near(waterPerSec, 6, 0.05);
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `1 锅炉 + 3 蒸汽机, 负载 2.7MW: 实发 ${mw.toFixed(2)}MW (预期 1.8, 第 3 台没用), 每秒吃水 ${waterPerSec.toFixed(1)} (预期 6 → 1200/6 = 200 台锅炉一台抽取泵); 蒸汽机状态 ${b.engines.join("/")}`,
      measured: { seconds, mw, waterPerSec, engines: b.engines },
    };
  },
};
