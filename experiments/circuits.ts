// 电路 (M2 收尾; 第一版教训 #7 "建材工厂没有上限"): 2.1.7 取消自减后, 同一台组装机按电路设配方又读原料、走同一根线会来回跳, 分线后稳定 (circuits.md C1~C3);
// 限产: 出料机械臂接箱子、条件 "铁齿轮 < 50" 才干活, 箱子停在 50 (logistics.md L9 限产公式的最简形式)。接线用 2.x 的 wire connector。
import type { Experiment } from "../src/verify/types.ts";

const WIRE = `
local function wire(a, b, color)
  local id = color == "green" and defines.wire_connector_id.circuit_green or defines.wire_connector_id.circuit_red
  local ca, cb = a.get_wire_connector(id, true), b.get_wire_connector(id, true)
  if not ca.connect_to(cb) and not ca.is_connected_to(cb) then error("接不上线: " .. a.name .. " → " .. b.name, 0) end
end`;

export const splitWiresStopFlicker: Experiment = {
  id: "circuits.split-wires.no-self-feedback",
  topic: "电路",
  claim: "2.1.7 取消了自减: 同一台组装机既按电路设配方、又把原料读到同一根线上, 会读回自己的输出, 配方来回跳; 把输入和输出分到不同颜色的线 (红进、绿出) 就稳定",
  refs: ["circuits.md C1、C2 (官方员工: 配方会疯狂闪烁, 是有意的)", "lessons-v1 #7 (限产电路)"],
  sources: [
    { title: "本机更新日志 2.1.7: 电路输入 / 输出可分红绿线, 取消自减", credibility: 1 },
    { title: "官方论坛员工 boskid: 设配方 + 读原料同线会闪烁 (不是 bug)", url: "https://forums.factorio.com/", credibility: 2 },
  ],
  gameSeconds: 10,
  allowStatus: ["no_ingredients"], // 只看配方跳不跳, 不放原料
  async run(ctx) {
    await ctx.power();
    const setup = (await ctx.lua(WIRE + `
local a = ...
local s = game.surfaces[a.surface]
-- 2.1 太空时代新图上电路板 / 铜缆配方一开始没解锁, 电路设不了没解锁的配方 (第一次干跑两台都是"无"): 临时解锁, 测完还原
local rs = game.forces.player.recipes
local was = {["electronic-circuit"] = rs["electronic-circuit"].enabled, ["copper-cable"] = rs["copper-cable"].enabled}
for name in pairs(was) do rs[name].enabled = true end
local out = {was = was, m = {}}
for i, split in ipairs({false, true}) do
  local asm = lab.place{surface = s, name = "assembling-machine-2", position = {a.x - 6.5 + (i - 1) * 10, a.y + 0.5}, force = "player"}
  local c = lab.place{surface = s, name = "constant-combinator", position = lab.slots(asm, "north")[2], force = "player"}
  c.get_or_create_control_behavior().add_section().set_slot(1, {value = {type = "item", name = "electronic-circuit", quality = "normal"}, min = 1})
  wire(c, asm, "red")
  local cb = asm.get_or_create_control_behavior()
  cb.circuit_set_recipe = true
  cb.circuit_read_ingredients = true
  if split then
    cb.input_networks = {red = true, green = false}
    cb.output_networks = {red = false, green = true}
    -- 绿线接到一个空的常量运算器上, 让输出确实有地方去
    local sink = lab.place{surface = s, name = "constant-combinator", position = lab.slots(asm, "south")[2], force = "player"}
    wire(asm, sink, "green")
  end
  lab.label(asm, split and "分线: 红进绿出" or "同一根线 (故意)")
  out.m[i] = {x = asm.position.x, y = asm.position.y}
end
return out`)) as { was: Record<string, boolean>; m: { x: number; y: number }[] };
    const r = setup.m;
    await ctx.ticks(30);
    await ctx.powered();
    const seen: string[][] = [[], []];
    const changes = [0, 0];
    for (let t = 0; t < 180; t++) {
      await ctx.ticks(1);
      const rec = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface] local out = {}
        for i, p in ipairs(a.r) do local e = s.find_entity("assembling-machine-2", {p.x, p.y}) local rc = e.get_recipe() out[i] = rc and rc.name or "无" end
        return out`, { r })) as string[];
      for (let i = 0; i < 2; i++) {
        if (seen[i].length && seen[i][seen[i].length - 1] !== rec[i]) changes[i]++;
        seen[i].push(rec[i]);
      }
    }
    await ctx.lua(`local a = ... for name, v in pairs(a.was) do game.forces.player.recipes[name].enabled = v end return true`, { was: setup.was });
    const kinds = seen.map((x) => [...new Set(x)]);
    // 对照: 电路确实把配方设上了 (两台都出现过电路板), 否则是实验没搭成, 不能判推翻
    const setWorked = kinds.every((k) => k.includes("electronic-circuit"));
    const ok = setWorked && changes[0] >= 10 && changes[1] === 0 && kinds[1].length === 1;
    return {
      verdict: !setWorked ? "inconclusive" : ok ? "verified" : changes[0] === 0 ? "refuted" : "inconclusive",
      summary: `180 tick: 同一根线的那台配方变了 ${changes[0]} 次 (出现过 ${kinds[0].map((k) => (k === "无" ? "无" : ctx.zh(k))).join("、")}); 分线 (红进绿出) 的变了 ${changes[1]} 次, 一直是 ${kinds[1].map((k) => (k === "无" ? "无" : ctx.zh(k))).join("、")}`,
      measured: { changes, kinds },
    };
  },
};

export const inserterLimitByChest: Experiment = {
  id: "circuits.limit.inserter-stops-at-threshold",
  topic: "电路",
  claim: "限产: 出料机械臂用线接到箱子 (读内容), 条件\"铁齿轮 < 50\"才工作, 箱子停在 50 个 (机械臂一次 1 个, 最多多 1); 不接电路的对照组一直往里放",
  refs: ["lessons-v1 #7 (建材工厂没有上限)", "logistics.md L9 (建材工厂限产)", "docs/research/players/game-tips.md TT3 (箱子红叉限格是另一种办法)"],
  sources: [{ title: "官方 wiki: Circuit network (机械臂按条件启用)", url: "https://wiki.factorio.com/Circuit_network", credibility: 2 }],
  gameSeconds: 90,
  async run(ctx) {
    await ctx.power();
    const r = (await ctx.lua(WIRE + `
local a = ...
local s = game.surfaces[a.surface]
local out = {}
for i, limited in ipairs({true, false}) do
  local asm = lab.place{surface = s, name = "assembling-machine-2", position = {a.x - 6.5 + (i - 1) * 10, a.y + 0.5}, force = "player"}
  asm.set_recipe("iron-gear-wheel")
  lab.insert(asm, {name = "iron-plate", count = 100}, defines.inventory.crafter_input)
  local slot = lab.slots(asm, "south")[2]
  local ins = lab.place{surface = s, name = "fast-inserter", position = slot, direction = defines.direction.north, force = "player"}
  local chest = lab.place{surface = s, name = "steel-chest", position = lab.slots(asm, "south", 2)[2], force = "player"}
  if limited then
    wire(chest, ins, "red")
    local cb = ins.get_or_create_control_behavior()
    cb.circuit_enable_disable = true
    cb.circuit_condition = {first_signal = {type = "item", name = "iron-gear-wheel"}, comparator = "<", constant = 50}
  end
  lab.label(ins, limited and "齿轮 < 50 才工作" or "对照: 不接电路")
  out[i] = {asm = {x = asm.position.x, y = asm.position.y}, chest = {x = chest.position.x, y = chest.position.y}}
end
return out`)) as { asm: { x: number; y: number }; chest: { x: number; y: number } }[];
    await ctx.ticks(30);
    await ctx.powered();
    // 两台都每秒补料, 跑 60 秒
    for (let t = 0; t < 60; t++) {
      await ctx.ticks(60);
      await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
        for _, p in ipairs(a.r) do local e = s.find_entity("assembling-machine-2", {p.asm.x, p.asm.y}) local inv = e.get_inventory(defines.inventory.crafter_input)
          local have = inv.get_item_count("iron-plate") if have < 60 then inv.insert{name = "iron-plate", count = 100 - have} end end return true`, { r });
    }
    const n = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface] local out = {}
      for i, p in ipairs(a.r) do out[i] = s.find_entity("steel-chest", {p.chest.x, p.chest.y}).get_item_count("iron-gear-wheel") end return out`, { r })) as number[];
    const ok = n[0] >= 50 && n[0] <= 51 && n[1] > 60;
    return {
      verdict: ok ? "verified" : n[0] > 55 ? "refuted" : "inconclusive",
      summary: `60 秒后: 接了电路 (齿轮 < 50) 的箱子 ${n[0]} 个; 对照 (不接电路) ${n[1]} 个`,
      measured: { n },
    };
  },
};
