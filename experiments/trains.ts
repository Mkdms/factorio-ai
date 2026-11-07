// 火车主题 (五大主题里最缺的): 停用车站 = 上限 0、不跳站 (L14); 中断只追加临时站、不替换主时刻表 (L15 / T19);
// 加油中断的目标站不写等待条件 → 机械臂没机会装燃料、燃料仍低、又触发 (T22 ①)。
// 场地: 一条 120 格的东西直轨 (compare-trains 的积木), 两头机车 + 1 节车厢的双头列车; 西端"甲" (西行, 北侧)、东端"乙" (东行, 南侧),
// 中间的站两面各一个同名 (北侧西行 + 南侧东行), 列车从哪边来都能停。摆放一律按建出来的实体位置, 不手敲。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

export const BUILD = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local d = defines.direction
local ry = a.ry
for x = a.x0 + 1, a.x1 - 1, 2 do s.create_entity{name = "straight-rail", position = {x, ry}, direction = d.east, force = f} end
local function stop(name, x, side)
  local st = s.create_entity{name = "train-stop", position = {x, side == "north" and (ry - 2) or (ry + 2)}, direction = side == "north" and d.west or d.east, force = f, station = name}
  if not (st and st.connected_rail) then error(name .. " 车站没接上铁轨", 0) end
  st.backer_name = name
  return st
end
local out = {}
out.jia = stop("甲", a.x0 + 15, "north")
out.yi = stop("乙", a.x1 - 15, "south")
local mids = {}
for _, m in pairs(a.mid or {}) do
  local n = stop(m.name, m.x, "north")
  local st = stop(m.name, m.x, "south")
  mids[#mids + 1] = {name = m.name, north = {x = n.position.x, y = n.position.y}, south = {x = st.position.x, y = st.position.y}}
end
local mid = math.floor((a.x0 + a.x1) / 2)
mid = mid - (mid % 2) + 1
local l1 = s.create_entity{name = "locomotive", position = {mid + 7, ry}, direction = d.east, force = f}
local w = s.create_entity{name = "cargo-wagon", position = {mid, ry}, direction = d.east, force = f}
local l2 = s.create_entity{name = "locomotive", position = {mid - 7, ry}, direction = d.west, force = f}
if not (l1 and w and l2 and w.train.id == l1.train.id and l2.train.id == l1.train.id) then error("列车没拼成一列", 0) end
l1.insert{name = "coal", count = a.coal or 50}
l2.insert{name = "coal", count = a.coal or 50}
return {train_id = l1.train.id, jia = {x = out.jia.position.x, y = out.jia.position.y}, yi = {x = out.yi.position.x, y = out.yi.position.y}, mids = mids}`;

// 列车状态: 状态名、所在站、时刻表 (每条记录的站名和是否临时)、当前记录号、每台机车的煤
export const STATUS = `
local a = ...
local t = game.train_manager.get_train_by_id(a.train_id)
local names = {} for k, v in pairs(defines.train_state) do names[v] = k end
local recs = {}
local sch = t.schedule
for i, r in ipairs(sch and sch.records or {}) do recs[#recs + 1] = {station = r.station, temporary = r.temporary and true or false} end
local fuel = {}
for i, l in ipairs(t.locomotives.front_movers) do fuel[#fuel + 1] = l.get_fuel_inventory().get_item_count("coal") end
for i, l in ipairs(t.locomotives.back_movers) do fuel[#fuel + 1] = l.get_fuel_inventory().get_item_count("coal") end
local lead = t.front_stock
return {state = names[t.state], station = t.station and t.station.backer_name or nil, records = recs, current = sch and sch.current or 0, fuel = fuel, x = lead.position.x, y = lead.position.y, speed = t.speed}`;

// 2.0: 时刻表表格式只带记录, 中断要走 LuaSchedule (set_interrupts), 设完回读数量核对 (第一次用表格式设, 中断悄悄丢了, 2026-11-01)
export const SET_SCHEDULE = `
local a = ...
local t = game.train_manager.get_train_by_id(a.train_id)
t.schedule = {current = a.schedule.current, records = a.schedule.records}
local want = a.schedule.interrupts or {}
local sch = t.get_schedule()
if #want > 0 then
  local ok, err = pcall(function() sch.set_interrupts(want) end)
  if not ok then
    for _, it in ipairs(want) do sch.add_interrupt(it) end
  end
end
local n = sch.interrupt_count
if n ~= #want then error("中断没设上: 要 " .. #want .. " 个, 现在 " .. tostring(n), 0) end
t.manual_mode = false
return {interrupts = n}`;

// 车站上限 / 电路停用: mode = "limit0" | "circuit-off" | "circuit-on" | "normal"
export const STOP_MODE = `
local a = ...
local s = game.surfaces[a.surface]
local st = s.find_entity("train-stop", {a.x, a.y})
if not st then error("找不到车站", 0) end
if a.mode == "limit0" then st.trains_limit = 0; return {limit = st.trains_limit} end
if a.mode == "normal" then
  st.trains_limit = nil
  local cb = st.get_control_behavior()
  if cb then cb.circuit_enable_disable = false end
  return {limit = st.trains_limit}
end
-- 电路停用: 常量运算器用红线接到车站, 条件 A > 0; 运算器里没 A 就是停用, 放一个 A=1 就是启用
local comb = s.find_entity("constant-combinator", {a.x + 2, a.y}) or s.create_entity{name = "constant-combinator", position = {a.x + 2, a.y}, force = "player"}
st.trains_limit = nil
local cb = st.get_or_create_control_behavior()
cb.circuit_enable_disable = true
cb.circuit_condition = {comparator = ">", first_signal = {type = "virtual", name = "signal-A"}, constant = 0}
local c1 = st.get_wire_connector(defines.wire_connector_id.circuit_red, true)
local c2 = comb.get_wire_connector(defines.wire_connector_id.circuit_red, true)
if not c1.is_connected_to(c2) then c1.connect_to(c2) end
local ccb = comb.get_or_create_control_behavior()
local sec = ccb.get_section(1) or ccb.add_section()
if a.mode == "circuit-on" then sec.set_slot(1, {value = {type = "virtual", name = "signal-A", quality = "normal"}, min = 1}) else sec.clear_slot(1) end
return {limit = st.trains_limit, enabled = not cb.disabled, wired = c1.is_connected_to(c2)}`;

export interface Status { state: string; station: string | null; records: { station: string; temporary: boolean }[]; current: number; fuel: number[]; x: number; y: number; speed: number }

export async function status(ctx: ExpContext, train_id: number) { return (await ctx.lua(STATUS, { train_id })) as Status; }

export async function waitState(ctx: ExpContext, train_id: number, pred: (s: Status) => boolean, maxSeconds: number, every = 60): Promise<Status | null> {
  for (let i = 0; i < (maxSeconds * 60) / every; i++) {
    await ctx.ticks(every);
    const s = await status(ctx, train_id);
    if (pred(s)) return s;
  }
  return null;
}

// 车站名全图共享: 前面实验留下的同名站 (够不着、有空位) 会让本该"目的地已满"的车变成"无路可走" (2026-11-01 回归: 上限那条 B 成了 no_path),
// 所以搭火车场地前把全图的旧车站都拆掉 (实验是一个接一个跑的, 拆的都是做完的实验留下的)
export async function clearOldStops(ctx: ExpContext) {
  return ctx.lua(`local a = ... local n = 0 for _, st in pairs(game.surfaces[a.surface].find_entities_filtered{type = "train-stop"}) do if st.destroy() then n = n + 1 end end return n`);
}

export async function build(ctx: ExpContext, mid: { name: string; x: number }[] = [], coal = 50) {
  const ry = ctx.y + 33, x0 = ctx.x - 60, x1 = ctx.x + 60;
  const area: [[number, number], [number, number]] = [[x0 - 2, ry - 8], [x1 + 2, ry + 8]];
  ctx.watch(area);
  await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area, no_enemies: true }, { timeoutMs: 120_000 });
  await clearOldStops(ctx);
  const b = (await ctx.lua(BUILD, { ry, x0, x1, mid, coal })) as { train_id: number; jia: { x: number; y: number }; yi: { x: number; y: number }; mids: { name: string; north: { x: number; y: number }; south: { x: number; y: number } }[] | Record<string, never> };
  await ctx.lab.rpc("viewer", { position: [ctx.x, ry - 14], zoom: 0.4, surface: ctx.surface }, { retry: true }).catch(() => undefined);
  return { ...b, ry, x0, x1 };
}

export const rec = (station: string, seconds: number) => ({ station, wait_conditions: [{ type: "time", compare_type: "and", ticks: seconds * 60 }] });

export const disabledStopNoSkip: Experiment = {
  id: "trains.disabled-stop.no-skip",
  topic: "火车",
  claim: "停用车站 = 上限 0: 2.0 起列车不再跳站, 目的地没有可用的同名站就原地显示\"目的地已满\"等着, 时刻表停在那一条不往下走; 车站上限设 0 和电路停用效果一样; 重新启用后列车照常开过去",
  refs: ["logistics.md L14", "trains.md README 第二轮 #10"],
  sources: [
    { title: "官方 wiki Train stop (Train limit / 停用)", url: "https://wiki.factorio.com/Train_stop", date: "2026-03-13", credibility: 2 },
    { title: "B 站维基 车站", url: "https://wiki.biligame.com/factorio/车站", date: "2026-10-30", credibility: 3 },
  ],
  gameSeconds: 300,
  async run(ctx) {
    const b = await build(ctx);
    // 先开到乙站停好
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 2, records: [rec("甲", 3), rec("乙", 3)] } });
    const atYi = await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "乙", 120);
    if (!atYi) return { verdict: "inconclusive", summary: "列车 120 秒内没停到乙站", measured: {} };
    const phases: Record<string, unknown> = {};
    for (const mode of ["limit0", "circuit-off"] as const) {
      const set = await ctx.lua(STOP_MODE, { x: b.jia.x, y: b.jia.y, mode });
      // 让车从乙出发去甲 (当前记录指向甲)
      await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 1, records: [rec("甲", 3), rec("乙", 3)] } });
      await ctx.ticks(10 * 60);
      const s1 = await status(ctx, b.train_id);
      await ctx.ticks(30 * 60);
      const s2 = await status(ctx, b.train_id);
      phases[mode] = { set, after10s: { state: s1.state, current: s1.current, station: s1.station }, after40s: { state: s2.state, current: s2.current, station: s2.station } };
      // 恢复
      await ctx.lua(STOP_MODE, { x: b.jia.x, y: b.jia.y, mode: "normal" });
      const back = await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "甲", 90);
      (phases[mode] as Record<string, unknown>).reenabled_reached_jia = !!back;
      // 回乙站准备下一轮
      await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 2, records: [rec("甲", 3), rec("乙", 3)] } });
      const y2 = await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "乙", 120);
      if (!y2) return { verdict: "inconclusive", summary: `${mode} 之后列车没回到乙站`, measured: phases };
    }
    const ok = (m: string) => {
      const p = phases[m] as { after10s: { state: string; current: number }; after40s: { state: string; current: number }; reenabled_reached_jia: boolean };
      return p.after10s.state === "destination_full" && p.after40s.state === "destination_full" && p.after40s.current === 1 && p.reenabled_reached_jia;
    };
    const verified = ok("limit0") && ok("circuit-off");
    const desc = (m: string) => { const p = phases[m] as { after40s: { state: string; current: number }; reenabled_reached_jia: boolean }; return `${p.after40s.state}, 时刻表仍在第 ${p.after40s.current} 条, 启用后${p.reenabled_reached_jia ? "到站" : "没到站"}`; };
    return {
      verdict: verified ? "verified" : "refuted",
      summary: `甲站上限 0: 40 秒后 ${desc("limit0")}; 电路停用: ${desc("circuit-off")} (都没跳到乙)`,
      measured: phases,
    };
  },
};

// 丙站旁放机械臂: 列车停在"丙"后按车厢实际位置放一台机械臂 + 永续箱 (铁板), 给"缺铁板"中断一个一次性的补料点
const RIG_PLATES = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local d = defines.direction
local t = game.train_manager.get_train_by_id(a.train_id)
local w = t.cargo_wagons[1]
local x = math.floor(w.position.x) + 0.5
local ins = lab.place{surface = s, name = "fast-inserter", position = {x, a.ry + 1.5}, direction = d.south, force = f}
local c = lab.place{surface = s, name = "infinity-chest", position = {x, a.ry + 2.5}, force = f}
c.set_infinity_container_filter(1, {name = "iron-plate", count = 100, mode = "exactly"})
return {x = ins.position.x, y = ins.position.y}`;

const PLATES = `
local a = ...
local t = game.train_manager.get_train_by_id(a.train_id)
local w = t.cargo_wagons[1]
if a.clear then w.get_inventory(defines.inventory.cargo_wagon).clear() end
return w.get_inventory(defines.inventory.cargo_wagon).get_item_count("iron-plate")`;

export const interruptAppendsTemporary: Experiment = {
  id: "trains.interrupt.appends-temporary-stop",
  topic: "火车",
  claim: "中断触发时只把目标站作为临时站追加进时刻表 (记录标 temporary), 主时刻表的记录原样保留; 临时站到过就删掉, 列车接着去原来的下一站; 条件不再成立就不再触发",
  refs: ["logistics.md L15", "trains.md T19"],
  sources: [
    { title: "官方论坛员工答复 (中断只追加临时站)", url: "https://forums.factorio.com/viewtopic.php?p=627674", date: "2024-10-30", credibility: 2 },
    { title: "FFF-389 列车中断", url: "https://factorio.com/blog/post/fff-389", date: "2023-12-15", credibility: 2 },
  ],
  gameSeconds: 500,
  async run(ctx) {
    const b = await build(ctx, [{ name: "丙", x: ctx.x + 1 }]);
    // 先停到丙 (南侧, 东行), 按车厢实际位置放补铁板的机械臂; 供电按场地铺
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 1, records: [rec("甲", 3), rec("丙", 60)] } });
    if (!(await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "甲", 120))) return { verdict: "inconclusive", summary: "列车没停到甲站", measured: {} };
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 2, records: [rec("甲", 3), rec("丙", 60)] } });
    if (!(await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "丙", 120))) return { verdict: "inconclusive", summary: "列车没停到丙站", measured: {} };
    const rig = await ctx.lua(RIG_PLATES, { train_id: b.train_id, ry: b.ry });
    await ctx.lab.rpc("power_area", { surface: ctx.surface, area: [[b.x0, b.ry + 4], [b.x1, b.ry + 9]], inset: 6 });
    await ctx.powered();
    // 再开到乙站停好, 清空车厢, 然后挂上中断: 车上铁板 < 1 → 临时站丙 (停 5 秒, 机械臂把铁板装上, 条件就不再成立)
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 2, records: [rec("甲", 3), rec("乙", 3)] } });
    if (!(await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "乙", 120))) return { verdict: "inconclusive", summary: "列车没停到乙站", measured: {} };
    await ctx.lua(PLATES, { train_id: b.train_id, clear: true });
    const schedule = {
      current: 1,
      records: [rec("甲", 3), rec("乙", 3)],
      interrupts: [{ name: "缺铁板", inside_interrupt: false, conditions: [{ type: "item_count", compare_type: "and", condition: { comparator: "<", first_signal: { type: "item", name: "iron-plate" }, constant: 1 } }], targets: [rec("丙", 5)] }],
    };
    try {
      await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule });
    } catch (e) {
      return { verdict: "inconclusive", summary: `设时刻表 (带中断) 失败: ${(e as Error).message.slice(0, 200)}`, measured: {} };
    }
    const visits: string[] = [];
    const recordCounts: number[] = [];
    let sawTemp = false, originalsKept = true, last: string | null = null;
    for (let i = 0; i < 400; i++) {
      await ctx.ticks(20);
      const s = await status(ctx, b.train_id);
      if (s.records.some((r) => r.temporary)) sawTemp = true;
      if (s.records.filter((r) => !r.temporary).map((r) => r.station).join(",") !== "甲,乙") originalsKept = false;
      if (s.state === "wait_station" && s.station && s.station !== last) { visits.push(s.station); recordCounts.push(s.records.length); last = s.station; }
      if (s.state !== "wait_station") last = null;
      if (visits.length >= 5) break;
    }
    const plates = (await ctx.lua(PLATES, { train_id: b.train_id })) as number;
    const seq = visits.join("→");
    // 预期: 某次离站时插临时站丙 (到丙时时刻表 3 条), 到过丙之后接着去主表里原来的下一站, 装上铁板后不再触发, 时刻表回到 2 条。
    // 注意: 脚本改时刻表后的那一次出发不查中断 (2.1.24 实测: 停在乙改表, 直接去了甲, 离开甲才插丙), 所以不要求第一站就是丙
    const i = visits.indexOf("丙");
    const nextOf: Record<string, string> = { 甲: "乙", 乙: "甲" };
    const ok = sawTemp && originalsKept && plates > 0 && i >= 0 && i + 1 < visits.length
      && recordCounts[i] === 3 && recordCounts.slice(i + 1).every((n) => n === 2)
      && visits.slice(i + 1).every((v) => v !== "丙")
      && (i === 0 || visits[i + 1] === nextOf[visits[i - 1]]);
    return {
      verdict: ok ? "verified" : visits.length < 2 ? "inconclusive" : "refuted",
      summary: `到站顺序 ${seq} (每站时刻表条数 ${recordCounts.join("/")}); 主表 2 条${originalsKept ? "始终保留" : "被改过"}, 临时站${sawTemp ? "出现过" : "没出现"}; 装上铁板 ${plates} 块后不再触发`,
      measured: { visits, recordCounts, sawTemp, originalsKept, plates, rig },
    };
  },
};

// 加油站旁放机械臂: 列车停在"加油"后读两台机车的位置, 各放一台机械臂 + 永续箱 (煤)
export const RIG_FUEL = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local d = defines.direction
local t = game.train_manager.get_train_by_id(a.train_id)
local placed = {}
for _, l in pairs(t.locomotives.front_movers) do placed[#placed + 1] = l end
for _, l in pairs(t.locomotives.back_movers) do placed[#placed + 1] = l end
local out = {}
for _, l in ipairs(placed) do
  local x = math.floor(l.position.x) + 0.5
  -- 机械臂在轨道南侧 1 格 (取货方向 = 货源方向: 箱子在南边 → 朝南), 永续箱再南 1 格
  local ins = lab.place{surface = s, name = "fast-inserter", position = {x, a.ry + 1.5}, direction = d.south, force = f}
  local c = lab.place{surface = s, name = "infinity-chest", position = {x, a.ry + 2.5}, force = f}
  c.set_infinity_container_filter(1, {name = "coal", count = 50, mode = "exactly"})
  out[#out + 1] = {x = ins.position.x, y = ins.position.y}
end
return out`;

export const refuelInterruptNeedsWait: Experiment = {
  id: "trains.refuel-interrupt.needs-wait-condition",
  topic: "火车",
  claim: "加油中断的目标站不写等待条件 → 列车到站立刻走, 机械臂没机会装燃料, 燃料仍低、中断反复触发 (死循环); 目标站加\"静止 5 秒\"后机械臂能装上, 中断就不再触发",
  refs: ["trains.md T22 ①"],
  sources: [
    { title: "官方论坛 (加油中断无限循环的原因和解法)", url: "https://forums.factorio.com/viewtopic.php?p=643367", date: "2024-11-10", credibility: 3 },
  ],
  gameSeconds: 600,
  async run(ctx) {
    // 机车各 20 块煤 (80MJ, 够跑两分多钟); 中断: 煤 < 25 → 加油站
    const b = await build(ctx, [{ name: "加油", x: ctx.x + 1 }], 20);
    // 先让车停到"加油"(南侧, 东行) 一次, 按机车实际位置放机械臂
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 1, records: [rec("甲", 3), rec("加油", 60)] } });
    const atJia = await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "甲", 120);
    if (!atJia) return { verdict: "inconclusive", summary: "列车没停到甲站", measured: {} };
    await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 2, records: [rec("甲", 3), rec("加油", 60)] } });
    const atFuel = await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "加油", 120);
    if (!atFuel) return { verdict: "inconclusive", summary: "列车没停到加油站", measured: {} };
    const rig = await ctx.lua(RIG_FUEL, { train_id: b.train_id, ry: b.ry });
    // 供电: 轨道南侧一条 (x0..x1) × (ry+4..ry+9) 的带子按间距铺广域配电站 (不手算覆盖; 上一次只放一座, 另一台机车旁的机械臂没电, 框架把结论作废了)
    await ctx.lab.rpc("power_area", { surface: ctx.surface, area: [[b.x0, b.ry + 4], [b.x1, b.ry + 9]], inset: 6 });
    await ctx.powered();
    // 把刚装进去的煤清回 20 块, 两种写法各跑 3 分钟; 主时刻表 甲 ⇄ 乙, 甲在西头, 从加油站出发先去甲
    const fuelCond = { type: "fuel_item_count_any", compare_type: "and", condition: { comparator: "<", first_signal: { type: "item", name: "coal" }, constant: 25 } };
    const results: Record<string, unknown> = {};
    for (const variant of ["no-wait", "inactivity-5s"] as const) {
      await ctx.lua(`local a = ... local t = game.train_manager.get_train_by_id(a.train_id)
        for _, l in pairs(t.locomotives.front_movers) do l.get_fuel_inventory().clear(); l.insert{name = "coal", count = 20} end
        for _, l in pairs(t.locomotives.back_movers) do l.get_fuel_inventory().clear(); l.insert{name = "coal", count = 20} end
        return true`, { train_id: b.train_id });
      const target = variant === "no-wait" ? { station: "加油", wait_conditions: [] } : { station: "加油", wait_conditions: [{ type: "inactivity", compare_type: "and", ticks: 5 * 60 }] };
      const schedule = { current: 1, records: [rec("甲", 3), rec("乙", 3)], interrupts: [{ name: "加油", inside_interrupt: false, conditions: [fuelCond], targets: [target] }] };
      try {
        await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule });
      } catch (e) {
        return { verdict: "inconclusive", summary: `设带加油中断的时刻表失败: ${(e as Error).message.slice(0, 200)}`, measured: results };
      }
      let triggers = 0, hadTemp = false, minFuel = 99, stopsAtFuel = 0, lastAtFuel = false;
      const seen: string[] = [];
      for (let i = 0; i < 180; i++) {
        await ctx.ticks(60);
        const s = await status(ctx, b.train_id);
        const temp = s.records.some((r) => r.temporary);
        if (temp && !hadTemp) triggers++;
        hadTemp = temp;
        const atFuelNow = s.state === "wait_station" && s.station === "加油";
        if (atFuelNow && !lastAtFuel) stopsAtFuel++;
        lastAtFuel = atFuelNow;
        minFuel = Math.min(minFuel, ...s.fuel);
        if (s.state === "wait_station" && s.station && seen[seen.length - 1] !== s.station) seen.push(s.station);
      }
      const end = await status(ctx, b.train_id);
      results[variant] = { triggers, stopsAtFuel, fuelEnd: end.fuel, minFuel, visits: seen.slice(0, 12).join("→"), stateEnd: end.state };
    }
    const a = results["no-wait"] as { triggers: number; fuelEnd: number[]; stateEnd: string };
    const c = results["inactivity-5s"] as { triggers: number; fuelEnd: number[] };
    const loopA = a.triggers >= 3 && Math.max(...a.fuelEnd) < 25;
    const fixedB = c.triggers <= 2 && Math.min(...c.fuelEnd) >= 25;
    return {
      verdict: loopA && fixedB ? "verified" : a.triggers === 0 && c.triggers === 0 ? "inconclusive" : "refuted",
      summary: `不写等待条件: 3 分钟触发 ${a.triggers} 次, 结束时机车煤 ${a.fuelEnd.join("/")} (${a.stateEnd}); 写"静止 5 秒": 触发 ${c.triggers} 次, 结束时煤 ${c.fuelEnd.join("/")}`,
      measured: { ...results, rig },
    };
  },
};
