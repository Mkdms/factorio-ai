// 思路并排比 (句芒星): 农业塔"一直收" vs "按需收" (P-prod-19: 用电路按库存开关农业塔, 不用机械臂限流)。
// 场地: 句芒星 ±20 格铺成天然玉玛果土, 中间一座农业塔 (种子由脚本每分钟补到 ≥ 20), 塔 → 机械臂 → 钢箱 (缓冲) → 燃烧机械臂 (慢, 模拟下游需求) → 钢箱 (计数桶, 每分钟数完清空)。
//   A 一直收: 塔不接电路; B 按需收: 缓冲箱红线接塔, 塔只在 "玉玛果 < 100" 时启用。
// 量 (各 20 游戏分钟): 孢子 (surface.pollution_statistics 里 yumako-tree 的排放, 每次收获 15; 2.1.24 实测)、收获次数、送到下游的果数、结束时积压在塔和缓冲箱里的果数。
// 预期: 下游吃不完时, B 的孢子 ≈ 下游消耗 / 50 × 15, A 的孢子按树长熟的速度算, 多出数倍, 且多收的果积压 (会腐坏)。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

const BUILD = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local d = defines.direction
local tiles = {}
for x = a.x - 20, a.x + 19 do for y = a.y - 20, a.y + 19 do tiles[#tiles + 1] = {name = "natural-yumako-soil", position = {x, y}} end end
s.set_tiles(tiles, true, true, true)
-- 塔 (3×3) 放在区中偏东, 西边留给塔种树 (塔半径 3 格 = 3×3 的种植格, 四面都种)
local tower = lab.place{surface = s, name = "agricultural-tower", position = {a.x + 0.5, a.y + 0.5}, force = f}
tower.insert{name = "yumako-seed", count = 50}
-- 出料: 塔东侧紧挨着的格子放机械臂 (取货方向 = 货源方向 = 朝西), 再东一格缓冲钢箱
local slot = lab.slots(tower, "east")[2]
local ins1 = lab.place{surface = s, name = "fast-inserter", position = slot, direction = d.west, force = f}
local buf = lab.place{surface = s, name = "steel-chest", position = {slot.x + 1, slot.y}, force = f}
-- 下游需求: 燃烧机械臂 (慢) 从缓冲箱搬到计数桶
local ins2 = lab.place{surface = s, name = "burner-inserter", position = {slot.x + 2, slot.y}, direction = d.west, force = f}
ins2.insert{name = "coal", count = 50}
local sink = lab.place{surface = s, name = "steel-chest", position = {slot.x + 3, slot.y}, force = f}
if a.on_demand then
  local cb = tower.get_or_create_control_behavior()
  cb.circuit_enable_disable = true
  cb.circuit_condition = {comparator = "<", first_signal = {type = "item", name = "yumako"}, constant = a.threshold}
  local c1 = buf.get_wire_connector(defines.wire_connector_id.circuit_red, true)
  local c2 = tower.get_wire_connector(defines.wire_connector_id.circuit_red, true)
  c1.connect_to(c2)
end
return {tower = {x = tower.position.x, y = tower.position.y}, buf = {x = buf.position.x, y = buf.position.y}, sink = {x = sink.position.x, y = sink.position.y}, ins2 = {x = ins2.position.x, y = ins2.position.y}}`;

// 每分钟: 补种子和煤, 数计数桶并清空, 读孢子统计
const TICK = `
local a = ...
local s = game.surfaces[a.surface]
local tower = s.find_entity("agricultural-tower", {a.r.tower.x, a.r.tower.y})
local buf = s.find_entity("steel-chest", {a.r.buf.x, a.r.buf.y})
local sink = s.find_entity("steel-chest", {a.r.sink.x, a.r.sink.y})
local ins2 = s.find_entity("burner-inserter", {a.r.ins2.x, a.r.ins2.y})
local seedInv = tower.get_inventory(defines.inventory.crafter_input)
local seeds = seedInv and seedInv.get_item_count("yumako-seed") or 0
if seeds < 20 then tower.insert{name = "yumako-seed", count = 50 - seeds} end
if ins2 and ins2.get_fuel_inventory().get_item_count("coal") < 10 then ins2.insert{name = "coal", count = 20} end
local delivered = sink.get_inventory(defines.inventory.chest).get_item_count("yumako")
sink.get_inventory(defines.inventory.chest).clear()
local ps = s.pollution_statistics
local plants = 0
for _, p in pairs(s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, type = "plant"}) do plants = plants + 1 end
local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
return {delivered = delivered, spores_tree = ps.get_input_count("yumako-tree") or 0, spores_tower = ps.get_input_count("agricultural-tower") or 0,
        in_tower = tower.get_output_inventory().get_item_count("yumako"), in_buf = buf.get_inventory(defines.inventory.chest).get_item_count("yumako"),
        plants = plants, status = names[tower.status], tick = game.tick}`;

interface Tick { delivered: number; spores_tree: number; spores_tower: number; in_tower: number; in_buf: number; plants: number; status: string; tick: number }

async function runVariant(ctx: ExpContext, onDemand: boolean, minutes: number) {
  await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area: [[ctx.x - 20, ctx.y - 20], [ctx.x + 20, ctx.y + 20]], no_enemies: true, tile: "natural-yumako-soil" }, { timeoutMs: 120_000 });
  const r = (await ctx.lua(BUILD, { on_demand: onDemand, threshold: 100 })) as Record<string, { x: number; y: number }>;
  await ctx.power();
  await ctx.powered();
  const first = (await ctx.lua(TICK, { r })) as Tick;
  let delivered = 0, last = first;
  const statuses: Record<string, number> = {};
  for (let m = 0; m < minutes; m++) {
    await ctx.ticks(60 * 60);
    last = (await ctx.lua(TICK, { r })) as Tick;
    delivered += last.delivered;
    statuses[last.status] = (statuses[last.status] ?? 0) + 1;
  }
  const spores = last.spores_tree - first.spores_tree;
  return { onDemand, minutes, delivered, spores, harvests: spores / 15, towerSpores: last.spores_tower - first.spores_tower, leftover: last.in_tower + last.in_buf, plants: last.plants, statuses };
}

export const harvestOnDemand: Experiment = {
  id: "compare.gleba.harvest-on-demand",
  topic: "生物室",
  surface: "gleba",
  claim: "句芒星农业塔用电路按库存开关 (\"按需收\") 比一直收少排很多孢子: 下游吃不完时, 孢子只随消耗走 (每 50 个果 15 孢子), 一直收的塔把长熟的全收下来, 孢子多出数倍、多收的果积压腐坏",
  refs: ["knowledge/patterns/production.md P-prod-19", "knowledge/patterns/planets.md 句芒 (G4)", "docs/research/players gleba"],
  sources: [
    { title: "本机原型: 玉玛果树 18000 tick 成熟, 收一次 50 个果、15 孢子; 农业塔半径 3", credibility: 1 },
    { title: "production.md P-prod-19 (论坛 / 视频: 用电路禁收获按库存开关, 不用机械臂限流)", credibility: 3 },
  ],
  gameSeconds: 2600,
  async run(ctx) {
    await ctx.lab.rpc("viewer", { position: [ctx.x, ctx.y], zoom: 0.5, surface: ctx.surface }, { retry: true }).catch(() => undefined);
    const minutes = 20;
    await ctx.say("A: 农业塔一直收");
    const A = await runVariant(ctx, false, minutes);
    await ctx.say("B: 农业塔只在缓冲箱里玉玛果 < 100 时启用");
    const B = await runVariant(ctx, true, minutes);
    if (A.harvests < 2 || B.delivered < 10) return { verdict: "inconclusive", summary: `没跑起来: A 收获 ${A.harvests} 次, B 送到下游 ${B.delivered} 个`, measured: { A, B } };
    const ratio = A.spores / Math.max(1, B.spores);
    const perFruitA = A.spores / Math.max(1, A.delivered), perFruitB = B.spores / Math.max(1, B.delivered);
    const verified = ratio >= 1.5 && B.leftover < A.leftover;
    return {
      verdict: verified ? "verified" : "refuted",
      summary: `各 ${minutes} 分钟: 一直收 孢子 ${A.spores.toFixed(0)} (收 ${A.harvests.toFixed(0)} 次), 送到下游 ${A.delivered} 个, 积压 ${A.leftover} 个; 按需收 孢子 ${B.spores.toFixed(0)} (收 ${B.harvests.toFixed(0)} 次), 送到 ${B.delivered} 个, 积压 ${B.leftover} 个 → 孢子 ${ratio.toFixed(1)} 倍, 每个送到下游的果 ${perFruitA.toFixed(2)} vs ${perFruitB.toFixed(2)} 孢子`,
      measured: { A, B, ratio, perFruitA, perFruitB },
    };
  },
};
