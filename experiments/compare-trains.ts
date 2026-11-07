// 思路并排比 (设计搜索): 装货站"等满再发车" vs "停 10 秒就走" (思路库 logistics-choice / 朋友基地: 等满发车是公认做法)。
// 沙盘里第一次跑火车。一条 200 格直轨, 两头机车 + 1 节货运车厢的列车来回; 西端装货站 (西行, 车站在轨道北侧),
// 东端卸货站 (东行, 车站在南侧); 装卸各 6 台高速机械臂 (给机械臂 +3 手部容量, 模拟研究过的基地)。
// 同一套设施先跑方案 A (等满) 8 分钟, 再跑方案 B (停 10 秒) 8 分钟, 比送到卸货站的铁板数。
// 预期: 装卸速度是瓶颈时, 等满发车的运量接近装卸速度, 定时发车只有 停站/(停站+往返) 的比例。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

const BUILD = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local d = defines.direction
local force = game.forces.player
force.inserter_stack_size_bonus = 3
local ry = a.ry -- 轨道中心 y (奇数)
for x = a.x0 + 1, a.x1 - 1, 2 do s.create_entity{name = "straight-rail", position = {x, ry}, direction = d.east, force = f} end
-- 西端装货站 (西行列车, 车站在北侧), 东端卸货站 (东行, 南侧)
local load = s.create_entity{name = "train-stop", position = {a.x0 + 15, ry - 2}, direction = d.west, force = f, station = "装"}
local unload = s.create_entity{name = "train-stop", position = {a.x1 - 15, ry + 2}, direction = d.east, force = f, station = "卸"}
if not (load and load.connected_rail and unload and unload.connected_rail) then error("车站没接上铁轨", 0) end
load.backer_name = "装"
unload.backer_name = "卸"
-- 列车: 机车 - 车厢 - 机车, 放在中间
local mid = math.floor((a.x0 + a.x1) / 2)
mid = mid - (mid % 2) + 1
local l1 = s.create_entity{name = "locomotive", position = {mid + 7, ry}, direction = d.east, force = f}
local w = s.create_entity{name = "cargo-wagon", position = {mid, ry}, direction = d.east, force = f}
local l2 = s.create_entity{name = "locomotive", position = {mid - 7, ry}, direction = d.west, force = f}
if not (l1 and w and l2 and w.train.id == l1.train.id and l2.train.id == l1.train.id) then error("列车没拼成一列", 0) end
l1.insert{name = "solid-fuel", count = 50}
l2.insert{name = "solid-fuel", count = 50}
return {train_id = l1.train.id, load = {x = load.position.x, y = load.position.y}, unload = {x = unload.position.x, y = unload.position.y}}`;

// 让车先开到装货站停好, 读车厢位置, 在车厢旁边放装卸设备
const GOTO = `
local a = ...
local t = game.train_manager.get_train_by_id(a.train_id)
t.schedule = {current = 1, records = {{station = a.station, wait_conditions = {{type = "time", compare_type = "and", ticks = 60 * 60 * 10}}}}}
t.manual_mode = false
return true`;

const WAGON = `
local a = ...
local t = game.train_manager.get_train_by_id(a.train_id)
local names = {} for k, v in pairs(defines.train_state) do names[v] = k end
local w = t.cargo_wagons[1]
return {state = names[t.state], x = w.position.x, y = w.position.y, station = t.station and t.station.backer_name, speed = t.speed}`;

// 在车厢所在的 x 范围 (±3) 放 6 台机械臂: side = "north" 装 (永续箱 → 车厢), "south" 卸 (车厢 → 钢箱)
const RIG = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local d = defines.direction
local refs = {}
-- 机械臂要电: 每端一座广域配电站 (供电半边长 9) + 电力接口
local sy = a.side == "north" and (a.ry - 5) or (a.ry + 5)
s.create_entity{name = "substation", position = {a.wx + 6, sy}, force = f}
s.create_entity{name = "electric-energy-interface", position = {a.wx + 9, sy}, force = f}
for i = -3, 2 do
  local x = a.wx + i + 0.5
  if a.side == "north" then
    local c = s.create_entity{name = "infinity-chest", position = {x, a.ry - 2.5}, force = f}
    c.set_infinity_container_filter(1, {name = "iron-plate", count = 100, mode = "exactly"})
    s.create_entity{name = "fast-inserter", position = {x, a.ry - 1.5}, direction = d.north, force = f}
  else
    s.create_entity{name = "fast-inserter", position = {x, a.ry + 1.5}, direction = d.north, force = f}
    local c = s.create_entity{name = "steel-chest", position = {x, a.ry + 2.5}, force = f}
    refs[#refs + 1] = {x = c.position.x, y = c.position.y}
  end
end
return refs`;

const SCHEDULE = `
local a = ...
local t = game.train_manager.get_train_by_id(a.train_id)
local loadWait = a.mode == "full" and {{type = "full", compare_type = "and"}} or {{type = "time", compare_type = "and", ticks = a.ticks}}
t.schedule = {current = 1, records = {
  {station = "装", wait_conditions = loadWait},
  {station = "卸", wait_conditions = {{type = "empty", compare_type = "and"}}},
}}
t.manual_mode = false
return true`;

// 数卸货箱里的铁板并清空 (累计)
const COLLECT = `
local a = ...
local s = game.surfaces[a.surface]
local n = 0
for _, r in ipairs(a.chests) do
  local c = s.find_entity("steel-chest", {r.x, r.y})
  local inv = c.get_inventory(defines.inventory.chest)
  n = n + inv.get_item_count("iron-plate")
  inv.clear()
end
local t = game.train_manager.get_train_by_id(a.train_id)
local w = t.cargo_wagons[1]
w.get_inventory(defines.inventory.cargo_wagon).clear()
return n`;

async function waitAt(ctx: ExpContext, train_id: number, station: string, maxSeconds: number) {
  let w: { state: string; station: string | null; x: number; y: number } | null = null;
  for (let i = 0; i < maxSeconds / 5; i++) {
    await ctx.ticks(5 * 60);
    w = (await ctx.lua(WAGON, { train_id })) as { state: string; station: string | null; x: number; y: number };
    if (w.state === "wait_station" && w.station === station) return w;
  }
  throw new Error(`${maxSeconds} 秒内列车没停到"${station}": 最后状态 ${w?.state}, 速度 ${(w as { speed?: number } | null)?.speed}, 在站 ${w?.station}, 车厢在 (${w?.x}, ${w?.y})`);
}

async function runMode(ctx: ExpContext, train_id: number, chests: unknown[], mode: "full" | "time", minutes: number) {
  await ctx.lua(COLLECT, { chests, train_id });
  await ctx.lua(SCHEDULE, { train_id, mode, ticks: 10 * 60 });
  let delivered = 0;
  for (let i = 0; i < minutes * 6; i++) {
    await ctx.ticks(10 * 60);
    delivered += (await ctx.lua(COLLECT_ONLY, { chests })) as number;
  }
  return delivered;
}

const COLLECT_ONLY = `
local a = ...
local s = game.surfaces[a.surface]
local n = 0
for _, r in ipairs(a.chests) do
  local c = s.find_entity("steel-chest", {r.x, r.y})
  local inv = c.get_inventory(defines.inventory.chest)
  n = n + inv.get_item_count("iron-plate")
  inv.clear()
end
return n`;

export const waitUntilFullVsTimed: Experiment = {
  id: "compare.trains.wait-until-full-vs-timed",
  topic: "火车",
  claim: "装货站等满再发车 (老手公认, 朋友基地也这么做): 同一列车、同样 6+6 台装卸机械臂、200 格来回, 等满发车送到的货比\"停 10 秒就走\"多得多; 实测给出倍数和每秒运量",
  refs: ["knowledge/patterns/logistics-choice.md (车站设计)", "knowledge/patterns/case-friend-nauvis.md P-friend (装货站满载才开站)", "friend-questions.md 问题 2"],
  sources: [
    { title: "朋友的新地星基地 (装货站上限 1 + 四节车厢的箱都够才开站)", credibility: 3 },
    { title: "friend-questions.md 问题 2: \"装货等满再走\"是社区公认", credibility: 3 },
  ],
  gameSeconds: 1100,
  async run(ctx) {
    const ry = ctx.y + 33, x0 = ctx.x - 100, x1 = ctx.x + 100;
    ctx.watch([[x0 - 2, ry - 8], [x1 + 2, ry + 8]]);
    await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area: [[x0 - 2, ry - 8], [x1 + 2, ry + 8]], no_enemies: true }, { timeoutMs: 120_000 });
    const b = (await ctx.lua(BUILD, { ry, x0, x1 })) as { train_id: number };
    // 镜头 (观看用的角色, 设了不死) 要放在轨道外: 站在轨道上会挡住火车 (2026-11-01 实测: 列车 on_the_path 但不动)
    await ctx.lab.rpc("viewer", { position: [ctx.x, ry - 14], zoom: 0.35, surface: ctx.surface }, { retry: true }).catch(() => undefined);
    await ctx.lua(GOTO, { train_id: b.train_id, station: "装" });
    const atLoad = await waitAt(ctx, b.train_id, "装", 120);
    await ctx.lua(RIG, { side: "north", wx: Math.floor(atLoad.x), ry });
    await ctx.lua(GOTO, { train_id: b.train_id, station: "卸" });
    const atUnload = await waitAt(ctx, b.train_id, "卸", 120);
    const chests = await ctx.lua(RIG, { side: "south", wx: Math.floor(atUnload.x), ry });
    await ctx.powered(); // 装卸区已 watch 登记, 统一走框架的检查
    const minutes = 8;
    const full = await runMode(ctx, b.train_id, chests as unknown[], "full", minutes);
    const timed = await runMode(ctx, b.train_id, chests as unknown[], "time", minutes);
    const perSecFull = full / (minutes * 60), perSecTimed = timed / (minutes * 60);
    if (full < 100 && timed < 100) return { verdict: "inconclusive", summary: `两种方案都几乎没送到货 (等满 ${full}, 定时 ${timed}), 火车或装卸没跑起来`, measured: { full, timed, atLoad, atUnload } };
    const ratio = full / Math.max(1, timed);
    return {
      verdict: ratio >= 1.3 ? "verified" : "refuted",
      summary: `各跑 ${minutes} 分钟: 等满发车送到 ${full} 块 (每秒 ${perSecFull.toFixed(1)}), 停 10 秒就走送到 ${timed} 块 (每秒 ${perSecTimed.toFixed(1)}), 等满是定时的 ${ratio.toFixed(1)} 倍`,
      measured: { full, timed, perSecFull, perSecTimed, ratio, atLoad, atUnload },
    };
  },
};
