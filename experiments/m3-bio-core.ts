// 进行中 (2026-11-02): 还没登记进 experiments/index.ts —— 第一次干跑 -22.8% (营养素死头带堵死), 改环形带 + 限产后 -12.8%, 差在营养素一批 60 个的浪费, 计算器没算腐坏; 达标前不登记 (回归会把没进知识库的当缺失)。
// M3 完成标准 (docs/roadmap.md): 句芒"生物核心"在沙盘里连续跑 1 小时, 实测产量和计算相差不到 10%。
// 设计 (plans/gleba-bio-core-lab.json, 计算器 src/calc 出预测, 实验里现算不写死):
//   玉玛果箱 → 组装机2型 (玉玛果加工) ⇒ 生物室 B3 (生物结晶) ⇐ 组装机2型 (果冻果加工) ← 果冻果箱
//   B3 → 收集箱 C → 生物室 B4 (生物结晶制营养素); B4 → 东边一条短带子 → B4、B3 的燃料臂; 带子尽头只挑变质物进垃圾箱
//   组装机的种子 (2% 副产物, 一格只堆 10 个, 不清 11 分钟就堵死) 和变质物用设了过滤的机械臂清走。
// 摆放全用 lab.place / lab.slots 从实体真实位置推 (不手敲坐标); 量的是收集箱 C 里生物结晶的净增 (= 生物结晶净产出)。
import type { Experiment } from "../src/verify/types.ts";
import fs from "node:fs";
import path from "node:path";
import { loadGameData } from "../src/calc/data.ts";
import { solvePlan, type Plan } from "../src/calc/solve.ts";

const PLAN = path.join(import.meta.dirname, "..", "plans", "gleba-bio-core-lab.json");

const BUILD = `
local a = ...
local s = game.surfaces[a.surface]
local d = defines.direction
local P = lab.pickup_dir
local function chest(name, pos) return lab.place{surface = s, name = name, position = pos} end
local function ins(name, pos, pick) return lab.place{surface = s, name = name, position = pos, direction = P[pick]} end
local function filt(e, items) e.use_filters = true for i, it in ipairs(items) do e.set_filter(i, {name = it}) end return e end
-- 沙盘阵营没解锁这些配方 (第一次干跑全是"配方没研究"): 临时解锁, 测完按原样还原 (lab.md #50)
local rs = game.forces.player.recipes
local was = {}
for _, n in ipairs {"bioflux", "nutrients-from-bioflux", "yumako-processing", "jellynut-processing"} do was[n] = rs[n].enabled rs[n].enabled = true end
local B3 = lab.place{surface = s, name = "biochamber", position = {a.x + 0.5, a.y + 0.5}, recipe = "bioflux"}
-- 北边: B3 → 机械臂 → 收集箱 C → 机械臂 → B4
ins("fast-inserter", lab.slots(B3, "north", 1)[2], "south")
local C = chest("steel-chest", lab.slots(B3, "north", 2)[2])
local feedB4 = ins("fast-inserter", lab.slots(B3, "north", 3)[2], "south")
-- C 只当中转 (第三次干跑: C 一直攒, 越攒越旧, 营养素继承旧结晶的新鲜度, 一出生就快坏, 营养素生物室每分钟多吃 3.6 个结晶):
-- 箱里多于 10 个就运到出货箱 OUT (接电路), 留给 B4 的总是新鲜的; 量 OUT 的增量
local cpos = C.position
local toOut = ins("fast-inserter", {cpos.x + 1, cpos.y}, "west")
local OUT = chest("steel-chest", {cpos.x + 2, cpos.y})
do
  local a1, a2 = C.get_wire_connector(defines.wire_connector_id.circuit_red, true), toOut.get_wire_connector(defines.wire_connector_id.circuit_red, true)
  if not a1.connect_to(a2) and not a1.is_connected_to(a2) then error("中转箱接不上出货机械臂", 0) end
  local cb = toOut.get_or_create_control_behavior()
  cb.circuit_enable_disable = true
  cb.circuit_condition = {first_signal = {type = "item", name = "bioflux"}, comparator = ">", constant = 10}
  lab.label(toOut, "中转箱 > 10 才运走")
end
local B4 = lab.place{surface = s, name = "biochamber", position = lab.slots(B3, "north", 5)[2], recipe = "nutrients-from-bioflux"}
-- 东边: 营养素环形带 (第一次是死头带子: 营养素一次做 60 个远多于消耗, 堆在带子上 5 分钟就坏, 尽头的没人用只能等坏,
-- 变质物卡在队伍里, 第 50 分钟两台生物室全断燃料)。现在: 西列往南经过 B4、B3 的燃料臂, 底下拐到东列往北, 顶上拐回来;
-- 东列外侧的过滤臂只挑变质物; 整条环读数, 环上营养素 < 20 才让收集箱往 B4 放生物结晶 (限产, 不囤)
local e4, e3 = lab.slots(B4, "east", 1), lab.slots(B3, "east", 1)
ins("fast-inserter", e4[1], "west")
local top, bottom = lab.slots(B4, "east", 2)[1], lab.slots(B3, "east", 2)[3]
local x0, y0, y1 = top.x, top.y, bottom.y + 1
local belt
for y = y0, y1 - 1 do belt = lab.place{surface = s, name = "transport-belt", position = {x0, y}, direction = d.south} end
lab.place{surface = s, name = "transport-belt", position = {x0, y1}, direction = d.east}
for y = y0 + 1, y1 do lab.place{surface = s, name = "transport-belt", position = {x0 + 1, y}, direction = d.north} end
lab.place{surface = s, name = "transport-belt", position = {x0 + 1, y0}, direction = d.west}
ins("fast-inserter", e4[3], "east")
ins("fast-inserter", e3[2], "east")
local mid = math.floor((y0 + y1) / 2) + 0.5
filt(ins("fast-inserter", {x0 + 2, mid}, "west"), {"spoilage"})
local S1 = chest("steel-chest", {x0 + 3, mid})
local reader = s.find_entity("transport-belt", {x0, feedB4.position.y})
local cb = reader.get_or_create_control_behavior()
cb.read_contents = true
cb.read_contents_mode = defines.control_behavior.transport_belt.content_read_mode.entire_belt_hold
local ca, cbn = reader.get_wire_connector(defines.wire_connector_id.circuit_red, true), feedB4.get_wire_connector(defines.wire_connector_id.circuit_red, true)
if not ca.connect_to(cbn) and not ca.is_connected_to(cbn) then error("环形带接不上限产的机械臂", 0) end
-- B4 自己也接进这张网读内容物 (出口里的营养素也算; 第五次干跑: 出料臂一次只搬 1 个, 60 个要搬 26 秒, 这期间带子上的数一直低,
-- 限产臂继续往 B4 放结晶, B4 接连做好几批堆在出口里变旧, 出口营养素坏 49%)
do
  local b1, b2 = B4.get_wire_connector(defines.wire_connector_id.circuit_red, true), feedB4.get_wire_connector(defines.wire_connector_id.circuit_red, true)
  if not b1.connect_to(b2) and not b1.is_connected_to(b2) then error("营养素生物室接不上限产的机械臂", 0) end
  local bcb = B4.get_or_create_control_behavior()
  bcb.circuit_read_contents = true
  bcb.include_in_crafting = false
  bcb.read_fuel = false
end
local icb = feedB4.get_or_create_control_behavior()
icb.circuit_enable_disable = true
icb.circuit_condition = {first_signal = {type = "item", name = "nutrients"}, comparator = "<", constant = 20}
lab.label(feedB4, "环上营养素 < 20 才放")
-- 西边: 玉玛果加工 A1 → B3
local A1 = lab.place{surface = s, name = "assembling-machine-2", position = lab.slots(B3, "west", 3)[2], recipe = "yumako-processing"}
ins("fast-inserter", lab.slots(B3, "west", 1)[1], "west")
ins("fast-inserter", lab.slots(B3, "west", 1)[2], "west")
ins("fast-inserter", lab.slots(A1, "west", 1)[2], "west")
local Y = chest("infinity-chest", lab.slots(A1, "west", 2)[2])
Y.set_infinity_container_filter(1, {name = "yumako", count = 50, mode = "exactly"})
filt(ins("fast-inserter", lab.slots(A1, "north", 1)[2], "south"), {"yumako-seed", "spoilage"})
local S2 = chest("steel-chest", lab.slots(A1, "north", 2)[2])
-- 南边: 果冻果加工 A2 → B3
local A2 = lab.place{surface = s, name = "assembling-machine-2", position = lab.slots(B3, "south", 3)[2], recipe = "jellynut-processing"}
ins("fast-inserter", lab.slots(B3, "south", 1)[1], "south")
ins("fast-inserter", lab.slots(B3, "south", 1)[2], "south")
ins("fast-inserter", lab.slots(A2, "south", 1)[2], "south")
local J = chest("infinity-chest", lab.slots(A2, "south", 2)[2])
J.set_infinity_container_filter(1, {name = "jellynut", count = 50, mode = "exactly"})
filt(ins("fast-inserter", lab.slots(A2, "west", 1)[2], "east"), {"jellynut-seed", "spoilage"})
local S3 = chest("steel-chest", lab.slots(A2, "west", 2)[2])
-- 起步: 两台生物室各塞 10 个营养素当燃料 (自举; 之后全靠 B4)
lab.insert(B3, {name = "nutrients", count = 10}, defines.inventory.fuel)
lab.insert(B4, {name = "nutrients", count = 10}, defines.inventory.fuel)
local function at(e) return {x = e.position.x, y = e.position.y} end
return {B3 = at(B3), B4 = at(B4), C = at(C), OUT = at(OUT), A1 = at(A1), A2 = at(A2), sinks = {at(S1), at(S2), at(S3)}, was = was}`;

const READ = `
local a = ...
local s = game.surfaces[a.surface]
local function f(name, p) return s.find_entity(name, {p.x, p.y}) end
local C = f("steel-chest", a.C)
local OUT = f("steel-chest", a.OUT)
local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
local st = {}
for _, k in ipairs {"B3", "B4"} do st[k] = names[f("biochamber", a[k]).status] end
for _, k in ipairs {"A1", "A2"} do st[k] = names[f("assembling-machine-2", a[k]).status] end
local spoil, seeds = 0, 0
for _, p in ipairs(a.sinks) do local c = f("steel-chest", p) spoil = spoil + c.get_item_count("spoilage") seeds = seeds + c.get_item_count("yumako-seed") + c.get_item_count("jellynut-seed") end
-- 诊断: 各环节物品的腐坏百分比 (新鲜度会从原料继承)
local sp = {}
local function pct(inv, name) if not inv then return nil end for i = 1, #inv do local st = inv[i] if st.valid_for_read and st.name == name then return math.floor(st.spoil_percent * 1000) / 10 end end return nil end
sp.C_bioflux = pct(C.get_inventory(defines.inventory.chest), "bioflux")
local b3, b4 = f("biochamber", a.B3), f("biochamber", a.B4)
sp.B3_in_mash = pct(b3.get_inventory(defines.inventory.crafter_input), "yumako-mash")
sp.B3_in_jelly = pct(b3.get_inventory(defines.inventory.crafter_input), "jelly")
sp.B4_in_bioflux = pct(b4.get_inventory(defines.inventory.crafter_input), "bioflux")
sp.B4_out_nutrients = pct(b4.get_inventory(defines.inventory.crafter_output), "nutrients")
sp.B3_fuel = pct(b3.get_inventory(defines.inventory.fuel), "nutrients")
-- 诊断: 限产机械臂收到的信号 / 环上实际有多少营养素
do
  local fins = s.find_entities_filtered{position = {a.C.x, a.C.y - 1}, radius = 0.6, name = "fast-inserter"}[1]
  local net = fins and fins.get_circuit_network(defines.wire_connector_id.circuit_red)
  sp.signal_nutrients = net and net.get_signal({type = "item", name = "nutrients"}) or "无网"
  sp.feed_disabled = fins and fins.status and names[fins.status]
  local n = 0
  for _, b in pairs(s.find_entities_filtered{area = {{a.C.x + 2, a.B4.y - 3}, {a.C.x + 5, a.B3.y + 4}}, name = "transport-belt"}) do
    for i = 1, 2 do n = n + b.get_transport_line(i).get_item_count("nutrients") end
  end
  sp.loop_nutrients = n
end
-- 诊断: 全阵营生产统计 (只在单独跑这条时干净; 回归时别的实验区可能也在产)
local ps = game.forces.player.get_item_production_statistics(s)
local stats = {}
for _, n in ipairs {"bioflux", "yumako-mash", "jelly", "nutrients", "spoilage", "yumako", "jellynut"} do stats[n] = {made = ps.get_input_count(n), used = ps.get_output_count(n)} end
return {bioflux = C.get_item_count("bioflux") + OUT.get_item_count("bioflux"), spoilageInC = C.get_item_count("spoilage"), status = st, removedSpoilage = spoil, removedSeeds = seeds, stats = stats, spoil = sp}`;

type Read = { bioflux: number; spoilageInC: number; status: Record<string, string>; removedSpoilage: number; removedSeeds: number; stats: Record<string, { made: number; used: number }> };

export const bioCoreHour: Experiment = {
  id: "m3.gleba-bio-core.hour-vs-calc",
  topic: "生物室",
  claim: "M3 完成标准: 句芒最小生物核心 (果子加工 → 生物结晶 → 营养素自给) 在沙盘里连续跑 1 小时, 生物结晶净产出和计算器 (src/calc) 算的相差不到 10%",
  refs: ["docs/roadmap.md M3", "docs/calc.md", "plans/gleba-bio-core-lab.json", "biochamber.* (生物室燃料和产能已核实)", "spoilage.* (腐坏已核实)"],
  sources: [{ title: "本机计算器 (原型数据 + yalps 线性规划) 对沙盘实测", credibility: 1 }],
  surface: "gleba",
  gameSeconds: 3600,
  async run(ctx) {
    const plan = JSON.parse(fs.readFileSync(PLAN, "utf8")) as Plan;
    const calc = solvePlan(loadGameData(), plan);
    const predicted = calc.surplus["bioflux"] ?? 0;
    const pos = (await ctx.lua(BUILD)) as Record<string, unknown>;
    await ctx.power();
    await ctx.ticks(60);
    await ctx.powered();
    await ctx.say(`生物核心跑 1 小时: 计算器预测生物结晶净产出每分钟 ${predicted.toFixed(1)}`);
    await ctx.ticks(10 * 3600); // 预热 10 分钟
    const r0 = (await ctx.lua(READ, pos)) as Read;
    const halves: number[] = [];
    let prev = r0;
    for (let i = 0; i < 5; i++) { // 后 50 分钟分 5 段, 看稳不稳
      await ctx.ticks(10 * 3600);
      const r = (await ctx.lua(READ, pos)) as Read;
      halves.push((r.bioflux - prev.bioflux) / 10);
      prev = r;
    }
    await ctx.lua(`local a = ... for name, v in pairs(a.was) do game.forces.player.recipes[name].enabled = v end return true`, { was: pos.was });
    const measured = (prev.bioflux - r0.bioflux) / 50;
    const flow = Object.fromEntries(Object.keys(prev.stats).map((k) => [k, { made: Number(((prev.stats[k].made - r0.stats[k].made) / 50).toFixed(2)), used: Number(((prev.stats[k].used - r0.stats[k].used) / 50).toFixed(2)) }]));
    if (process.env.M3_DEBUG) console.log("腐坏%:", JSON.stringify((prev as unknown as { spoil: unknown }).spoil), "清走变质物", prev.removedSpoilage - r0.removedSpoilage);
    if (process.env.M3_DEBUG) console.log("每分钟 做/用:", JSON.stringify(flow), "计算:", JSON.stringify(calc.rows.map((r) => [r.recipe, r.craftsPerMin.toFixed(2), r.outputs, r.inputs, r.fuel])));
    const diff = predicted > 0 ? (measured - predicted) / predicted : 1;
    const ok = Math.abs(diff) <= 0.1 && Math.min(...halves) > 0;
    return {
      verdict: ok ? "verified" : measured > 0 ? "refuted" : "inconclusive",
      summary: `计算器预测每分钟净产生物结晶 ${predicted.toFixed(2)}; 沙盘 (预热 10 分钟后 50 分钟) 实测 ${measured.toFixed(2)}, 相差 ${(diff * 100).toFixed(1)}%; 每 10 分钟 ${halves.map((h) => h.toFixed(1)).join(" / ")}; 结束时状态 ${JSON.stringify(prev.status)}; 清走变质物 ${prev.removedSpoilage}、种子 ${prev.removedSeeds}`,
      measured: { predicted, measured, diff, halves, flow, end: prev, calcRows: calc.rows.map((r) => ({ recipe: r.recipe, machines: r.machines, craftsPerMin: r.craftsPerMin })) },
    };
  },
};
