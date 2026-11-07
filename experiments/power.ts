// 电主题第二批 (补到 10 条): 蓄电器 5MJ / 300kW; 核反应堆有燃料就一直烧 (锅炉按需烧); 泵每秒 1200; 一段管道最长 320 格; 太阳能 : 蓄电器 ≈ 25 : 21。
// 这个文件的实验对象就是供电本身, 所以自己放电力接口 (test/experiments-lint.test.ts 放行清单里有它); 故意缺电的实验都声明 allowUnpowered。
import type { Experiment } from "../src/verify/types.ts";

// 电源用 10 块太阳能板 (白天 600kW): 无限电力接口不给蓄电器充电 (2026-11-01 探针: 接口 8.3GJ/tick 产能, 蓄电器 10 秒后仍 0J、no_power)
const ACC = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
s.daytime = 0
s.freeze_daytime = true
local acc = lab.place{surface = s, name = "accumulator", position = {a.x + 0.5, a.y + 0.5}, force = f}
local sub = lab.place{surface = s, name = "substation", position = {a.x + 4, a.y}, force = f}
for i = 0, 9 do lab.place{surface = s, name = "solar-panel", position = {a.x - 7.5 + (i % 5) * 3, a.y + 4.5 + math.floor(i / 5) * 3}, force = f} end
return {acc = {x = acc.position.x, y = acc.position.y}, sub = {x = sub.position.x, y = sub.position.y}}`;

const ACC_READ = `
local a = ...
local s = game.surfaces[a.surface]
local acc = s.find_entity("accumulator", {a.r.acc.x, a.r.acc.y})
return {energy = acc.energy, tick = game.tick}`;

// 改成黑夜 (太阳能停), 放 4 座雷达 (各 300kW = 1.2MW) 当负载 (电力接口当负载不从电网取电: 2026-11-01 两次实测它只吃自己的缓冲)
const ACC_SINK = `
local a = ...
local s = game.surfaces[a.surface]
s.daytime = 0.5
local out = {}
for i = 0, 3 do local r = lab.place{surface = s, name = "radar", position = {a.x + 7.5 + (i % 2) * 3, a.y - 3.5 + math.floor(i / 2) * 3}, force = "player"} out[#out + 1] = {x = r.position.x, y = r.position.y} end
return out`;

export const accumulatorCapacityAndRate: Experiment = {
  id: "power.accumulator.5MJ-300kW",
  topic: "电",
  claim: "普通蓄电器容量 5MJ, 充电和放电都最多 300kW: 白天 600kW 太阳能给空蓄电器充 10 秒到 3MJ、20 秒充满; 黑夜里对 1.2MW 的负载 (4 座雷达) 也只能放 300kW, 10 秒后剩 2MJ",
  refs: ["nauvis.md N17 (太阳能 : 蓄电器配比的根据)"],
  sources: [{ title: "本机原型: accumulator buffer_capacity 5MJ, input/output_flow_limit 300kW", credibility: 1 }],
  gameSeconds: 40,
  allowUnpowered: true,
  async run(ctx) {
    const r = (await ctx.lua(ACC)) as Record<string, { x: number; y: number }>;
    await ctx.ticks(600);
    const e10 = (await ctx.lua(ACC_READ, { r })) as { energy: number };
    await ctx.ticks(600);
    const e20 = (await ctx.lua(ACC_READ, { r })) as { energy: number };
    await ctx.lua(ACC_SINK, { r });
    await ctx.ticks(600);
    const e30 = (await ctx.lua(ACC_READ, { r })) as { energy: number };
    await ctx.lua(`local a = ... game.surfaces[a.surface].freeze_daytime = false return true`); // 放开昼夜 (冻着的话后面的太阳能实验全程黑夜, 2026-11-01)
    const mj = (j: number) => j / 1e6;
    const ok = Math.abs(mj(e10.energy) - 3) < 0.2 && Math.abs(mj(e20.energy) - 5) < 0.1 && Math.abs(mj(e30.energy) - 2) < 0.2;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `10 块太阳能板白天充 10 秒 ${mj(e10.energy).toFixed(2)}MJ, 20 秒 ${mj(e20.energy).toFixed(2)}MJ; 改成黑夜接 4 座雷达 (1.2MW) 放 10 秒后剩 ${mj(e30.energy).toFixed(2)}MJ`,
      measured: { e10: e10.energy, e20: e20.energy, e30: e30.energy },
    };
  },
};

const REACTOR = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local r = lab.place{surface = s, name = "nuclear-reactor", position = {a.x - 8.5, a.y + 0.5}, force = f}
r.insert{name = "uranium-fuel-cell", count = 1}
-- 对照: 锅炉 + 煤 + 水 (永续管道), 没人用蒸汽
local b = lab.place{surface = s, name = "boiler", position = {a.x + 8.5, a.y + 1}, force = f, direction = defines.direction.north}
b.insert{name = "coal", count = 5}
local conns = lab.connections(b)
local wp
for _, c in ipairs(conns) do if c.dir == "input-output" and wp == nil then wp = c end end
local ip = lab.place{surface = s, name = "infinity-pipe", position = {wp.tx, wp.ty}, force = f}
ip.set_infinity_pipe_filter{name = "water", percentage = 1, mode = "at-least"}
return {reactor = {x = r.position.x, y = r.position.y}, boiler = {x = b.position.x, y = b.position.y}}`;

const REACTOR_READ = `
local a = ...
local s = game.surfaces[a.surface]
local r = s.find_entity("nuclear-reactor", {a.ref.reactor.x, a.ref.reactor.y})
local b = s.find_entity("boiler", {a.ref.boiler.x, a.ref.boiler.y})
local rb, bb = r.burner, b.burner
return {reactor_fuel = r.get_fuel_inventory().get_item_count("uranium-fuel-cell"), reactor_burning = rb.remaining_burning_fuel, reactor_temp = r.temperature,
        reactor_spent = rb.burnt_result_inventory and rb.burnt_result_inventory.get_item_count("depleted-uranium-fuel-cell") or -1,
        boiler_coal = b.get_fuel_inventory().get_item_count("coal"), boiler_burning = bb.remaining_burning_fuel, boiler_temp = b.temperature, tick = game.tick}`;

export const reactorBurnsRegardless: Experiment = {
  id: "power.reactor.burns-regardless-of-load",
  topic: "电",
  claim: "核反应堆有燃料就一直按 40MW 烧, 不按需降功率: 没人用热、温度到顶也照烧, 一根燃料棒 (8GJ) 200 秒烧完; 锅炉相反, 蒸汽没人用就停烧",
  refs: ["nauvis.md N18 (用电路读温度控制送燃料棒)", "knowledge/patterns/production.md (核电电路)"],
  sources: [
    { title: "本机原型: nuclear-reactor consumption 40MW, uranium-fuel-cell 8GJ; boiler 1.8MW", credibility: 1 },
    { title: "nauvis.md N18 (社区: 反应堆不按需烧, 要电路控棒)", credibility: 3 },
  ],
  gameSeconds: 230,
  allowUnpowered: true,
  async run(ctx) {
    const ref = (await ctx.lua(REACTOR)) as { reactor: { x: number; y: number }; boiler: { x: number; y: number } };
    await ctx.ticks(60 * 100);
    const mid = (await ctx.lua(REACTOR_READ, { ref })) as Record<string, number>;
    await ctx.ticks(60 * 120);
    const end = (await ctx.lua(REACTOR_READ, { ref })) as Record<string, number>;
    const gj = (j: number) => j / 1e9;
    // 100 秒后燃料棒剩约 4GJ; 220 秒后烧完 (剩 0 根、烧尽的 1 根); 锅炉烧了一点煤把水烧热后就停
    const reactorOk = mid.reactor_fuel === 0 && Math.abs(gj(mid.reactor_burning) - 4) < 0.5 && end.reactor_burning < 0.1e9 && end.reactor_spent >= 1;
    const boilerOk = end.boiler_coal === mid.boiler_coal && end.boiler_burning === mid.boiler_burning; // 锅炉把水烧热要先烧掉 1~2 块煤, 之后没人用蒸汽就停
    return {
      verdict: reactorOk && boilerOk ? "verified" : "refuted",
      summary: `反应堆 (没人用热): 100 秒时温度 ${mid.reactor_temp.toFixed(0)} 度、燃料棒剩 ${gj(mid.reactor_burning).toFixed(2)}GJ; 220 秒时剩 ${gj(end.reactor_burning).toFixed(2)}GJ、烧尽 ${end.reactor_spent} 根。锅炉 (没人用蒸汽): 烧热水用了 ${5 - mid.boiler_coal} 块煤, 100 ~ 220 秒煤 ${mid.boiler_coal} → ${end.boiler_coal} (${boilerOk ? "停烧" : "还在烧"})`,
      measured: { mid, end },
    };
  },
};

const PUMP = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local d = defines.direction
-- 永续管道 (水) → 泵 (朝北: 从南边吸, 往北送) → 储液罐
local pump = lab.place{surface = s, name = "pump", position = {a.x + 0.5, a.y + 1}, direction = d.north, force = f}
local c = lab.connections(pump)
local inp, outp
for _, x in ipairs(c) do if x.dir == "input" then inp = x else outp = x end end
local ip = lab.place{surface = s, name = "infinity-pipe", position = {inp.tx, inp.ty}, force = f}
ip.set_infinity_pipe_filter{name = "water", percentage = 1, mode = "at-least"}
-- 储液罐的接口在角上 (原型 pipe_connections: [1,1] 朝南): 让它的南向接口格正好落在泵的出口目标格, 罐心 = 目标格 − (1,1) (第一次罐心放错一格, 泵没进水)
local tank = lab.place{surface = s, name = "storage-tank", position = {outp.tx - 1, outp.ty - 1}, force = f}
local linked = false
for _, c in ipairs(lab.connections(tank)) do if math.floor(c.tx) == math.floor(outp.x) and math.floor(c.ty) == math.floor(outp.y) then linked = true end end
if not linked then error("储液罐的接口没对上泵的出口", 0) end
return {pump = {x = pump.position.x, y = pump.position.y}, tank = {x = tank.position.x, y = tank.position.y}}`;

const PUMP_READ = `
local a = ...
local s = game.surfaces[a.surface]
local t = s.find_entity("storage-tank", {a.ref.tank.x, a.ref.tank.y})
local p = s.find_entity("pump", {a.ref.pump.x, a.ref.pump.y})
local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
return {water = t.get_fluid_count("water"), pump_status = names[p.status], tick = game.tick}`;

export const pumpThroughput: Experiment = {
  id: "power.pump.1200-per-second",
  topic: "电",
  claim: "管道泵每秒最多送 1200 单位流体 (每 tick 20): 从永续管道往空储液罐泵 10 秒得到 12000",
  refs: ["production.md P39 (流体吞吐的实际限制在泵)"],
  sources: [{ title: "本机原型: pump pumping_speed 20 / tick", credibility: 1 }],
  gameSeconds: 12,
  async run(ctx) {
    await ctx.power();
    const ref = (await ctx.lua(PUMP)) as { pump: { x: number; y: number }; tank: { x: number; y: number } };
    await ctx.powered();
    const before = (await ctx.lua(PUMP_READ, { ref })) as { water: number; pump_status: string };
    await ctx.ticks(600);
    const after = (await ctx.lua(PUMP_READ, { ref })) as { water: number; pump_status: string };
    const moved = after.water - before.water;
    if (moved === 0) return { verdict: "inconclusive", summary: `泵没动 (状态 ${after.pump_status})`, measured: { before, after } };
    const ok = Math.abs(moved - 12000) <= 200;
    return { verdict: ok ? "verified" : "refuted", summary: `10 秒泵进储液罐 ${moved} 单位水 (每秒 ${(moved / 10).toFixed(0)})`, measured: { before, after, moved } };
  },
};

const PIPE_RUN = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local n = 0
for i = 0, a.max - 1 do
  local pos = {a.x0 + 0.5 + i, a.y0}
  if not s.can_place_entity{name = "pipe", position = pos, force = f, build_check_type = defines.build_check_type.manual} then break end
  local e = s.create_entity{name = "pipe", position = pos, force = f}
  if not e then break end
  n = n + 1
end
-- 和地下管道配合能不能继续: 在尽头再放一根地下管道 (按玩家规则)
local ug = s.can_place_entity{name = "pipe-to-ground", position = {a.x0 + 0.5 + n, a.y0}, direction = defines.direction.west, force = f, build_check_type = defines.build_check_type.manual}
return {placed = n, underground_ok = ug}`;

export const pipeSegmentLimit: Experiment = {
  id: "power.pipe.segment-max-320",
  topic: "电",
  claim: "2.0 的流体系统里一段连通的管道最长 320 格, 第 321 根按玩家规则放不下 (要隔段放泵或断开)",
  refs: ["production.md P39", "docs/research/players/changes-2.1.md (流体)"],
  sources: [{ title: "production.md P39 (玩家讨论 2.0/2.1 流体: 一段管道最长 320 格)", url: "https://forums.factorio.com/", date: "2025", credibility: 3 }],
  gameSeconds: 1,
  async run(ctx) {
    // 场地: 实验区外往东 340 格的一条线
    const x0 = ctx.x + 22, y0 = ctx.y + 0.5;
    ctx.watch([[x0 - 2, y0 - 3], [x0 + 1005, y0 + 3]]);
    await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area: [[x0 - 2, y0 - 3], [x0 + 1005, y0 + 3]], no_enemies: true }, { timeoutMs: 300_000 });
    const r = (await ctx.lua(PIPE_RUN, { x0, y0, max: 1000 })) as { placed: number; underground_ok: boolean };
    const ok = r.placed === 320;
    return { verdict: ok ? "verified" : "refuted", summary: `按玩家规则连着放管道, ${r.placed >= 1000 ? "放了 1000 根都没碰到上限" : `放到第 ${r.placed} 根后下一根放不下`}; 尽头再接地下管道${r.underground_ok ? "可以" : "也不行"}`, measured: r };
  },
};

const SOLAR = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
-- 太阳能板 3×3 排成 4×6, 蓄电器 2×2 排一行, 一根配电站在中间连起来, 一个只耗电的电力接口当负载
s.freeze_daytime = false
s.daytime = 0
-- 配电站放在板阵上下两侧 (原来放在正中, 压着一块板; lab.place 查碰撞后回归抓到的), 两座连线后核对同网, 每块板都要在网里
local sub = lab.place{surface = s, name = "substation", position = {a.x, a.y + 3}, force = f}
local subTop = lab.place{surface = s, name = "substation", position = {a.x, a.y - 12}, force = f}
sub.get_wire_connector(defines.wire_connector_id.pole_copper, true).connect_to(subTop.get_wire_connector(defines.wire_connector_id.pole_copper, true))
if subTop.electric_network_id ~= sub.electric_network_id then error("上下两座配电站没连成一张网", 0) end
local n = 0
for i = 0, a.panels - 1 do
  local col, row = i % 6, math.floor(i / 6)
  local pnl = lab.place{surface = s, name = "solar-panel", position = {a.x - 8.5 + col * 3, a.y - 8.5 + row * 3}, force = f}
  if pnl.electric_network_id ~= sub.electric_network_id then error("太阳能板不在电网里: " .. pnl.position.x .. "," .. pnl.position.y, 0) end
  n = n + 1
end
local accs = {}
for i = 0, a.accs - 1 do
  local e = lab.place{surface = s, name = "accumulator", position = {a.x - 9 + (i % 10) * 2, a.y + 6 + math.floor(i / 10) * 2}, force = f}
  if e.electric_network_id ~= sub.electric_network_id then error("蓄电器不在电网里: " .. e.position.x .. "," .. e.position.y, 0) end
  accs[#accs + 1] = {x = e.position.x, y = e.position.y}
end
-- 负载: 3 座雷达 (各 300kW = 0.9MW), 真用电设备 (电力接口当负载不从电网取电); 放在第二根配电站的覆盖里, 两根连线后核对同网
local sub2 = lab.place{surface = s, name = "substation", position = {a.x + 16, a.y + 2}, force = f}
sub.get_wire_connector(defines.wire_connector_id.pole_copper, true).connect_to(sub2.get_wire_connector(defines.wire_connector_id.pole_copper, true))
if sub2.electric_network_id ~= sub.electric_network_id then error("两根配电站没连成一张网", 0) end
local radars = {}
for i = 0, 2 do
  local r = lab.place{surface = s, name = "radar", position = {a.x + 13.5, a.y - 3.5 + i * 3}, force = f}
  if r.electric_network_id ~= sub.electric_network_id then error("雷达不在电网里: " .. r.position.x .. "," .. r.position.y, 0) end
  radars[#radars + 1] = {x = r.position.x, y = r.position.y}
end
return {radars = radars, accs = accs, panels = n, sub = {x = sub.position.x, y = sub.position.y}}`;

const SOLAR_READ = `
local a = ...
local s = game.surfaces[a.surface]
local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
local starved = 0
for _, p in ipairs(a.ref.radars) do local r = s.find_entity("radar", {p.x, p.y}) if r.status ~= defines.entity_status.working then starved = starved + 1 end end
local stored = 0
for _, p in ipairs(a.ref.accs) do local e = s.find_entity("accumulator", {p.x, p.y}) stored = stored + e.energy end
return {starved = starved, stored = stored, daytime = s.daytime, tick = game.tick}`;

export const solarAccumulatorRatio: Experiment = {
  id: "power.solar.ratio-24-panels-20-accumulators-per-MW",
  topic: "电",
  claim: "新地星昼夜 7 分钟: 约 1MW 平均负载 (3 座雷达 0.9MW) 要约 24 块太阳能板 (60kW 峰值, 平均约 70%) 配约 20 个蓄电器 (100MJ) 才能整夜不断电; 蓄电器减到 8 个夜里就会断",
  refs: ["nauvis.md N17 (25 : 21, 每 MW 23.8 块板 + 100MJ)"],
  sources: [
    { title: "官方 wiki: Solar panel (ratio 0.84 accumulators per panel, 23.8 panels per MW)", url: "https://wiki.factorio.com/Solar_panel", date: "2026", credibility: 2 },
    { title: "本机原型: solar-panel 60kW, accumulator 5MJ, nauvis day-night-cycle 25200 tick", credibility: 1 },
  ],
  gameSeconds: 3 * 25200 / 60 * 2 + 60,
  allowUnpowered: true,
  async run(ctx) {
    const out: Record<string, unknown> = {};
    let okFull = false, okStarved = false;
    for (const accs of [20, 8]) {
      await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area: [[ctx.x - 20, ctx.y - 20], [ctx.x + 20, ctx.y + 20]], no_enemies: true }, { timeoutMs: 120_000 });
      const ref = (await ctx.lua(SOLAR, { panels: 24, accs })) as { radars: { x: number; y: number }[]; accs: { x: number; y: number }[]; panels: number; sub: { x: number; y: number } };
      // 跑 3 个昼夜, 每 30 秒看一次雷达有没有电; 第 1 个昼夜是热身 (蓄电器从空开始, 半个白天充不满就入夜), 只统计第 2~3 个
      let starved = 0, samples = 0, minStored = Infinity;
      const cycle = 25200, total = 3 * cycle;
      for (let t = 0; t < total; t += 1800) {
        await ctx.ticks(1800);
        const r = (await ctx.lua(SOLAR_READ, { ref })) as { starved: number; stored: number; daytime: number };
        if (t + 1800 <= cycle) continue;
        samples++;
        if (r.starved > 0) starved++; // 有雷达不在 working (low_power / no_power) 就算这次采样断电
        minStored = Math.min(minStored, r.stored);
      }
      out[`accs${accs}`] = { starved, samples, minStoredMJ: minStored / 1e6 };
      if (accs === 20) okFull = starved === 0; else okStarved = starved > 0;
    }
    const a20 = out.accs20 as { starved: number; samples: number; minStoredMJ: number }, a8 = out.accs8 as typeof a20;
    return {
      verdict: okFull && okStarved ? "verified" : "refuted",
      summary: `24 块板 + 3 座雷达 (0.9MW) 跑 3 个昼夜 (第 1 个热身不计): 20 个蓄电器时断电 ${a20.starved}/${a20.samples} 次采样 (储能最低 ${a20.minStoredMJ.toFixed(0)}MJ); 8 个蓄电器时断电 ${a8.starved}/${a8.samples} 次 (最低 ${a8.minStoredMJ.toFixed(0)}MJ)`,
      measured: out,
    };
  },
};
