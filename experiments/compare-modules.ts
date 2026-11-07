// 思路并排比 (设计搜索): 同样 4 个三级插件, 产能插件 vs 速度插件 + 分享塔。
// 思路库: production.md 里"产能插件给贵的中间品, 分享塔是拿电换吞吐" (P-prod-*), 朋友基地"产能插件 427 个、分享塔只 9 座" (P-friend-*)。
// 方案 A: 组装机3型 + 4 个产能插件 3 (+40% 产能, -60% 速度)。
// 方案 B: 组装机3型 + 4 个速度插件 3 (+200%), 南北各 1 座分享塔 (各 2 个速度插件 3, 合计 +212%)。
// 产品: 内燃机 (10 秒, 1 钢材 + 1 铁齿轮 + 2 管道), 原料由永续箱供给。两套各自独立电网, 读各自的耗电。
// 预期 (按已核实的分享塔公式): A 0.07 台/秒, B 0.64 台/秒 (9.1 倍); 每台原料 A 2.86 件、B 4 件。
import type { Experiment } from "../src/verify/types.ts";

const SETUP = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
game.forces.player.recipes["engine-unit"].enabled = true
-- 全部位置用 lab.place / lab.slots 按实体真实的碰撞盒算 (不手敲坐标)
local function cell(cx0, cy0, modules, beacons)
  local m = lab.place{surface = s, name = "assembling-machine-3", position = {cx0, cy0}}
  m.set_recipe("engine-unit")
  m.get_module_inventory().insert{name = modules, count = 4}
  -- 西侧: 贴着机器的一排放机械臂 (取货方向朝西, 货源在西), 再外一排放定量的钢箱 (每种 2000)
  local items = {"steel-plate", "iron-gear-wheel", "pipe"}
  local stock = {}
  local ins = lab.slots(m, "west", 1)
  local box = lab.slots(m, "west", 2)
  for i, item in ipairs(items) do
    lab.place{surface = s, name = "fast-inserter", position = ins[i], direction = lab.pickup_dir.west}
    local c = lab.place{surface = s, name = "steel-chest", position = box[i]}
    c.insert{name = item, count = 2000}
    stock[#stock + 1] = {x = c.position.x, y = c.position.y, item = item}
  end
  -- 东侧中间一格: 出料机械臂 (取货方向朝西, 从机器取) + 钢箱
  lab.place{surface = s, name = "fast-inserter", position = lab.slots(m, "east", 1)[2], direction = lab.pickup_dir.west}
  local out = lab.place{surface = s, name = "steel-chest", position = lab.slots(m, "east", 2)[2]}
  local cx, cy = m.position.x, m.position.y
  if beacons then
    for _, dy in ipairs({-4, 4}) do
      local b = lab.place{surface = s, name = "beacon", position = {cx, cy + dy}}
      b.get_module_inventory().insert{name = "speed-module-3", count = 2}
    end
  end
  -- 独立电网 (两套各自读耗电): 南北各一座广域配电站 (供电半边长 9) 明确连线 + 电力接口; 两套相距 20 格 > 18 格连线距离
  local p1 = lab.place{surface = s, name = "substation", position = {cx, cy - 9}}
  local p2 = lab.place{surface = s, name = "substation", position = {cx, cy + 9}}
  p1.get_wire_connector(defines.wire_connector_id.pole_copper, true).connect_to(p2.get_wire_connector(defines.wire_connector_id.pole_copper, true))
  lab.place{surface = s, name = "electric-energy-interface", position = {cx + 4, cy - 9}}
  return {machine = {x = cx, y = cy}, out = {x = out.position.x, y = out.position.y}, pole = {x = p1.position.x, y = p1.position.y}, stock = stock}
end
return {A = cell(a.x - 10, a.y, "productivity-module-3", false), B = cell(a.x + 10, a.y, "speed-module-3", true)}`;

const READ = `
local a = ...
local s = game.surfaces[a.surface]
local function read(c)
  local m = s.find_entity("assembling-machine-3", {c.machine.x, c.machine.y})
  local out = s.find_entity("steel-chest", {c.out.x, c.out.y})
  local pole = s.find_entity("substation", {c.pole.x, c.pole.y})
  local st = pole.electric_network_statistics
  local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
  -- 还没消耗的原料 = 箱子里 + 机器输入槽里 (机械臂手里的最多几件, 忽略)
  local remaining = 0
  for _, st in ipairs(c.stock) do
    local ch = s.find_entity("steel-chest", {st.x, st.y})
    remaining = remaining + ch.get_inventory(defines.inventory.chest).get_item_count(st.item)
  end
  for _, it in pairs(m.get_inventory(defines.inventory.crafter_input).get_contents()) do remaining = remaining + it.count end
  return {crafts = m.products_finished, engines = out.get_inventory(defines.inventory.chest).get_item_count("engine-unit"), remaining = remaining, -- lint-ok: 只显示; 原料消耗用定量箱子剩余算 (lab.md #19 就是这里发现的)
          joules = st.get_input_count("assembling-machine-3") + st.get_input_count("beacon") + st.get_input_count("fast-inserter"),
          speed_bonus = m.speed_bonus, productivity_bonus = m.productivity_bonus, status = names[m.status]}
end
return {A = read(a.ref.A), B = read(a.ref.B), tick = game.tick}`;

interface Cell { crafts: number; engines: number; remaining: number; joules: number; speed_bonus: number; productivity_bonus: number; status: string }

export const productivityVsBeacons: Experiment = {
  id: "compare.modules.productivity-vs-beacons",
  topic: "插件",
  claim: "同样 4 个三级插件做内燃机: 4 个产能插件的机器每台产品少用约 29% 原料 (1/1.4), 但产量只有\"4 个速度插件 + 南北 2 座分享塔\"的约 1/9; 两种方案每台产品的耗电要实测 (思路库 production/朋友基地: 产能给贵的中间品、分享塔拿电换吞吐)",
  refs: ["knowledge/patterns/production.md P-prod (产能插件 / 分享塔)", "knowledge/patterns/case-friend-nauvis.md (产能 427 vs 分享塔 9)", "facts modules.beacon.sqrt-rule"],
  sources: [
    { title: "本机原型数据: 产能插件 3 (+10% 产能, -15% 速度, +80% 耗电), 速度插件 3 (+50% 速度, +70% 耗电), 分享塔 480kW、1.5/√n, 组装机3型 1.25 速、375kW", credibility: 1 },
    { title: "沙盘已核实: 分享塔 1.5√n (modules.beacon.sqrt-rule)", credibility: 1 },
  ],
  gameSeconds: 660,
  async run(ctx) {
    const ref = await ctx.lua(SETUP);
    await ctx.powered(); // 测量前强制检查: 用电的东西都有电
    await ctx.ticks(10 * 60);
    const probe = (await ctx.lua(READ, { ref })) as { A: Cell; B: Cell };
    if (probe.A.status !== "working" && probe.B.status !== "working") {
      // 料没进机器就别往下测了, 把状态报出来
      return { verdict: "inconclusive", summary: `机器没开工: A ${probe.A.status}, B ${probe.B.status}`, measured: { probe, ref } };
    }
    await ctx.ticks(60 * 60); // 预热 1 分钟 (第一台内燃机 A 要 20 秒)
    const a = (await ctx.lua(READ, { ref })) as { A: Cell; B: Cell; tick: number };
    await ctx.ticks(600 * 60);
    const b = (await ctx.lua(READ, { ref })) as { A: Cell; B: Cell; tick: number };
    const sec = (b.tick - a.tick) / 60;
    const d = (k: "A" | "B") => ({
      crafts: b[k].crafts - a[k].crafts,
      engines: b[k].engines - a[k].engines,
      inputs: a[k].remaining - b[k].remaining,
      mj: (b[k].joules - a[k].joules) / 1e6,
    });
    const A = d("A"), B = d("B");
    if (A.engines < 5 || B.engines < 5) return { verdict: "inconclusive", summary: `没跑起来: A 产 ${A.engines} (${b.A.status}), B 产 ${B.engines} (${b.B.status})`, measured: { a, b } };
    const perMinA = (A.engines / sec) * 60, perMinB = (B.engines / sec) * 60;
    const inputsPerA = A.inputs / A.engines, inputsPerB = B.inputs / B.engines;
    const mjPerA = A.mj / A.engines, mjPerB = B.mj / B.engines;
    const ratio = perMinB / perMinA;
    const ok = Math.abs(ratio - 9.1) / 9.1 < 0.15 && Math.abs(inputsPerA - 2.86) < 0.15 && Math.abs(inputsPerB - 4) < 0.1;
    return {
      verdict: ok ? "verified" : "refuted",
      summary:
        `${sec} 秒: A (4 产能) 每分钟 ${perMinA.toFixed(1)} 台、每台原料 ${inputsPerA.toFixed(2)} 件、每台耗电 ${mjPerA.toFixed(1)}MJ; ` +
        `B (4 速度 + 2 分享塔) 每分钟 ${perMinB.toFixed(1)} 台 (A 的 ${ratio.toFixed(1)} 倍)、每台原料 ${inputsPerB.toFixed(2)} 件、每台耗电 ${mjPerB.toFixed(1)}MJ; ` +
        `速度加成 A ${(b.A.speed_bonus * 100).toFixed(0)}% / B ${(b.B.speed_bonus * 100).toFixed(0)}%`,
      measured: { seconds: sec, A: { ...A, perMin: perMinA, inputsPer: inputsPerA, mjPer: mjPerA, speed: b.A.speed_bonus, prod: b.A.productivity_bonus }, B: { ...B, perMin: perMinB, inputsPer: inputsPerB, mjPer: mjPerB, speed: b.B.speed_bonus, prod: b.B.productivity_bonus } },
    };
  },
};
