// 火车第二批: 时刻表里有临时站时不检查中断 (T21); 同名车站按优先级派车 (L13)。车站上限计在途的车 (L14 后半) 挪到 trains3.ts (单轨没信号时第二列车 no_path, 改用带信号的场地)。
// 积木 (场地、列车、状态、时刻表) 复用 trains.ts。
import type { Experiment } from "../src/verify/types.ts";
import { SET_SCHEDULE, RIG_FUEL, build, status, waitState, rec } from "./trains.ts";

// 往时刻表里插一条临时站 (脚本派车 = 遥控)
const ADD_TEMP = `
local a = ...
local t = game.train_manager.get_train_by_id(a.train_id)
local sch = t.get_schedule()
local ok, err = pcall(function() sch.add_record{station = a.station, temporary = true, index = {schedule_index = a.index}, wait_conditions = {{type = "time", compare_type = "and", ticks = 180}}} end)
if not ok then error("加临时站失败: " .. tostring(err), 0) end
sch.go_to_station(a.index)
t.manual_mode = false
local n = 0 for _, r in ipairs(t.schedule.records) do if r.temporary then n = n + 1 end end
return {temps = n}`;

export const interruptIgnoredWithTemporaryStop: Experiment = {
  id: "trains.interrupt.ignored-while-temporary-stop",
  topic: "火车",
  claim: "时刻表里只要有临时站 (手动或脚本派的), 列车就不检查中断: 燃料已经低于加油条件, 去临时站的路上不加油; 临时站到过以后, 下一次离站才触发加油中断",
  refs: ["trains.md T21 (官方员工: 有意的)", "knowledge/patterns/logistics-choice.md P-logi-08 (遥控过的车不会自己去加油)"],
  sources: [{ title: "官方论坛员工答复 (临时站存在时不检查中断)", url: "https://forums.factorio.com/viewtopic.php?p=668817", date: "2025-04", credibility: 2 }],
  gameSeconds: 500,
  async run(ctx) {
    const b = await build(ctx, [{ name: "加油", x: ctx.x + 1 }, { name: "丙", x: ctx.x - 30 }], 20);
    // 先到加油站放机械臂 (两台机车各一台) 并供电
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 1, records: [rec("甲", 3), rec("加油", 60)] } });
    if (!(await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "甲", 120))) return { verdict: "inconclusive", summary: "列车没停到甲站", measured: {} };
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 2, records: [rec("甲", 3), rec("加油", 60)] } });
    if (!(await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "加油", 120))) return { verdict: "inconclusive", summary: "列车没停到加油站", measured: {} };
    await ctx.lua(RIG_FUEL, { train_id: b.train_id, ry: b.ry });
    await ctx.lab.rpc("power_area", { surface: ctx.surface, area: [[b.x0, b.ry + 4], [b.x1, b.ry + 9]], inset: 6 });
    await ctx.powered();
    // 回乙站, 燃料清到 10 (低于加油条件 25), 挂加油中断
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 2, records: [rec("甲", 3), rec("乙", 3)] } });
    if (!(await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "乙", 120))) return { verdict: "inconclusive", summary: "列车没回到乙站", measured: {} };
    await ctx.lua(`local a = ... local t = game.train_manager.get_train_by_id(a.train_id)
      for _, l in pairs(t.locomotives.front_movers) do l.get_fuel_inventory().clear(); l.insert{name = "coal", count = 10} end
      for _, l in pairs(t.locomotives.back_movers) do l.get_fuel_inventory().clear(); l.insert{name = "coal", count = 10} end
      return true`, { train_id: b.train_id });
    const fuelCond = { type: "fuel_item_count_any", compare_type: "and", condition: { comparator: "<", first_signal: { type: "item", name: "coal" }, constant: 25 } };
    const schedule = { current: 2, records: [rec("甲", 3), rec("乙", 3)], interrupts: [{ name: "加油", inside_interrupt: false, conditions: [fuelCond], targets: [{ station: "加油", wait_conditions: [{ type: "inactivity", compare_type: "and", ticks: 300 }] }] }] };
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule });
    // 脚本插一条临时站"丙" (西边, 要经过加油站), 从乙出发
    await ctx.lua(ADD_TEMP, { train_id: b.train_id, station: "丙", index: 1 });
    const visits: string[] = [];
    let last: string | null = null, refuelBeforeTemp = 0, reachedTemp = false, refuelAfterTemp = 0;
    for (let i = 0; i < 360; i++) {
      await ctx.ticks(30);
      const s = await status(ctx, b.train_id);
      if (s.state === "wait_station" && s.station && s.station !== last) {
        visits.push(s.station); last = s.station;
        if (s.station === "丙") reachedTemp = true;
        if (s.station === "加油") { if (reachedTemp) refuelAfterTemp++; else refuelBeforeTemp++; }
      }
      if (s.state !== "wait_station") last = null;
      if (refuelAfterTemp >= 1 || visits.length >= 6) break;
    }
    const end = await status(ctx, b.train_id);
    const ok = reachedTemp && refuelBeforeTemp === 0 && refuelAfterTemp >= 1;
    return {
      verdict: ok ? "verified" : reachedTemp ? "refuted" : "inconclusive",
      summary: `煤 10 (< 25) 时插临时站丙: 到站顺序 ${visits.join("→")}; 去丙的路上加油 ${refuelBeforeTemp} 次, 到过丙之后加油 ${refuelAfterTemp} 次 (结束时煤 ${end.fuel.join("/")})`,
      measured: { visits, refuelBeforeTemp, refuelAfterTemp, end },
    };
  },
};

const SET_PRIORITY = `
local a = ...
local s = game.surfaces[a.surface]
for _, p in ipairs(a.stops) do
  local st = s.find_entity("train-stop", {p.x, p.y})
  if not st then error("找不到车站", 0) end
  st.train_stop_priority = p.priority
end
return true`;

export const stopPriorityHighestFirst: Experiment = {
  id: "trains.stop-priority.highest-first",
  topic: "火车",
  claim: "同名车站按优先级 (0~255, 默认 50) 派车: 列车去优先级最高的那个, 哪怕它更远; 优先级相同才挑最近的",
  refs: ["logistics.md L13", "knowledge/patterns/logistics-choice.md P-logi-09 (通用车网靠优先级 + 上限)"],
  sources: [{ title: "官方 wiki: Train stop (Priority)", url: "https://wiki.factorio.com/Train_stop", date: "2026-03-13", credibility: 2 }],
  gameSeconds: 300,
  async run(ctx) {
    // 两个都叫"甲"的站: 近的在中间偏东 (南侧东行), 远的在西头 (北侧西行); 列车从乙 (东头) 出发
    const b = await build(ctx, [{ name: "甲", x: ctx.x + 20 }]);
    const mids = Array.isArray(b.mids) ? b.mids : [];
    const near = mids[0].south, far = { x: b.jia.x, y: b.jia.y }; // 位置一律用建出来的 (第一次手算的坐标找不到车站)
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 2, records: [rec("甲", 3), rec("乙", 3)] } });
    if (!(await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "乙", 120))) return { verdict: "inconclusive", summary: "列车没停到乙站", measured: {} };
    const results: Record<string, string> = {};
    for (const [tag, pf, pn] of [["远站 100 / 近站 50", 100, 50], ["都是 50", 50, 50], ["远站 50 / 近站 100", 50, 100]] as const) {
      await ctx.lua(SET_PRIORITY, { stops: [{ ...far, priority: pf }, { ...near, priority: pn }] });
      await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 1, records: [rec("甲", 3), rec("乙", 3)] } });
      const at = await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "甲", 120);
      results[tag] = !at ? "没到" : Math.abs(at.x - far.x) < 8 ? "远站" : "近站";
      await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 2, records: [rec("甲", 3), rec("乙", 3)] } });
      if (!(await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "乙", 120))) return { verdict: "inconclusive", summary: "列车没回到乙站", measured: results };
    }
    const ok = results["远站 100 / 近站 50"] === "远站" && results["都是 50"] === "近站" && results["远站 50 / 近站 100"] === "近站";
    return { verdict: ok ? "verified" : "refuted", summary: Object.entries(results).map(([k, v]) => `${k} → 去了${v}`).join("; "), measured: results };
  },
};
