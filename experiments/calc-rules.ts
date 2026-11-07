// 第十九批 (2026-11-02): 计算器 (docs/calc.md) 的"待核实"规则进沙盘 —— 待机耗电、机器品质速度、插件品质、分享塔品质。
// 说法照 wiki Quality (2026-08-27 版): 机器每级品质 +30% 速度; 插件"正面效果"每级 +30% (向下取整到 0.1%); 传说分享塔是普通的 1.66 倍; 等级 普通 0 / 精良 1 / 稀有 2 / 史诗 3 / 传说 5。
// 读引擎实际值 (crafting_speed、speed_bonus、consumption_bonus、productivity_bonus、电网统计), 不手算。
import type { Experiment } from "../src/verify/types.ts";

const WIKI_Q = { title: "官方 wiki: Quality", url: "https://wiki.factorio.com/Quality", date: "2026-08-27", credibility: 2 as const };
const QUALITIES = ["normal", "uncommon", "rare", "epic", "legendary"];
const LEVEL: Record<string, number> = { normal: 0, uncommon: 1, rare: 2, epic: 3, legendary: 5 };

export const drainIsThirtieth: Experiment = {
  id: "calc.electric-drain-one-thirtieth",
  topic: "电",
  claim: "电力机器没写待机耗电时 = 满负荷耗电的 1/30 (组装机2型 150kW → 待机 5kW); 计算器按这条算 (原型 API 没给默认值, 待核实)",
  refs: ["docs/calc.md 待核实"],
  sources: [{ title: "本机原型: assembling-machine-2 energy_usage 150kW, energy_source 没写 drain", credibility: 1 }],
  gameSeconds: 20,
  allowStatus: ["no_recipe"], // 故意没配方: 只耗待机电
  async run(ctx) {
    const m = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      local e = lab.place{surface = s, name = "assembling-machine-2", position = {a.x + 0.5, a.y + 0.5}}
      lab.label(e, "没配方: 只耗待机电")
      return {x = e.position.x, y = e.position.y, drain = e.electric_drain}`)) as { x: number; y: number; drain: number };
    await ctx.power();
    await ctx.ticks(120);
    await ctx.powered();
    const read = `local a = ... local s = game.surfaces[a.surface]
      local pole = s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, type = "electric-pole"}[1]
      return pole.electric_network_statistics.get_input_count("assembling-machine-2")`;
    const j0 = (await ctx.lua(read)) as number;
    await ctx.ticks(600);
    const j1 = (await ctx.lua(read)) as number;
    const measuredW = (j1 - j0) / 10;
    const drainW = m.drain * 60;
    const want = 150000 / 30;
    const ok = Math.abs(measuredW - want) / want < 0.02 && Math.abs(drainW - want) / want < 0.02;
    return {
      verdict: ok ? "verified" : measuredW > 0 ? "refuted" : "inconclusive",
      summary: `没配方的组装机2型: 引擎 electric_drain = ${drainW.toFixed(0)}W, 电网统计 10 秒平均 ${measuredW.toFixed(0)}W; 满负荷 150kW 的 1/30 = ${want.toFixed(0)}W`,
      measured: { drainW, measuredW },
    };
  },
};

export const machineQualitySpeed: Experiment = {
  id: "calc.quality-machine-speed",
  topic: "品质",
  claim: "机器品质每级 +30% 合成速度 (wiki Quality 原文 +30% crafting speed): 组装机2型 0.75 → 精良 0.975 / 稀有 1.2 / 史诗 1.425 / 传说 1.875 (传说是第 5 级)",
  refs: ["docs/calc.md 待核实 (计算器按 1 + 0.3 × 等级)"],
  sources: [WIKI_Q],
  gameSeconds: 1,
  allowUnpowered: true,
  allowStatus: ["no_power"], // 只读引擎的速度 / 加成, 不开工
  async run(ctx) {
    const r = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      local out = {}
      for i, q in ipairs(a.qs) do
        local e = lab.place{surface = s, name = "assembling-machine-2", position = {a.x - 10 + (i - 1) * 4 + 0.5, a.y + 0.5}, quality = q}
        out[q] = e.crafting_speed
      end
      return out`, { qs: QUALITIES })) as Record<string, number>;
    await ctx.powered();
    const ratios = Object.fromEntries(QUALITIES.map((q) => [q, r[q] / r.normal]));
    const ok = QUALITIES.every((q) => Math.abs(ratios[q] - (1 + 0.3 * LEVEL[q])) < 1e-6);
    return {
      verdict: ok ? "verified" : "refuted",
      summary: QUALITIES.map((q) => `${q === "normal" ? "普通" : q === "uncommon" ? "精良" : q === "rare" ? "稀有" : q === "epic" ? "史诗" : "传说"} ${r[q].toFixed(3)} (×${ratios[q].toFixed(2)})`).join("、"),
      measured: { speed: r, ratios },
    };
  },
};

export const moduleQualityEffects: Experiment = {
  id: "calc.quality-module-positive-only",
  topic: "品质",
  claim: "插件品质只放大正面效果, 每级 +30% (wiki: +30% positive module effects): 传说速度插件 3 速度 +50% → +125%, 它的耗能 +70% 不变; 传说产能插件 3 产能 +10% → +25%, 它的减速和耗能不变",
  refs: ["docs/calc.md 待核实"],
  sources: [WIKI_Q],
  gameSeconds: 1,
  allowUnpowered: true,
  allowStatus: ["no_power"], // 只读引擎的速度 / 加成, 不开工
  async run(ctx) {
    const r = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      local out = {}
      for i, c in ipairs(a.cases) do
        local e = lab.place{surface = s, name = "assembling-machine-3", position = {a.x - 10 + (i - 1) * 5 + 0.5, a.y + 0.5}, recipe = "iron-gear-wheel"}
        lab.insert(e, {name = c.module, count = 1, quality = c.q}, defines.inventory.crafter_modules)
        out[i] = {speed = e.speed_bonus, consumption = e.consumption_bonus, productivity = e.productivity_bonus}
      end
      return out`, { cases: [{ module: "speed-module-3", q: "normal" }, { module: "speed-module-3", q: "legendary" }, { module: "productivity-module-3", q: "normal" }, { module: "productivity-module-3", q: "legendary" }] })) as { speed: number; consumption: number; productivity: number }[];
    await ctx.powered();
    const [sN, sL, pN, pL] = r;
    const near = (a: number, b: number) => Math.abs(a - b) < 0.0011; // 向下取整到 0.1%
    const ok = near(sN.speed, 0.5) && near(sL.speed, 1.25) && near(sL.consumption, sN.consumption) && near(pN.productivity, 0.1) && near(pL.productivity, 0.25) && near(pL.speed, pN.speed) && near(pL.consumption, pN.consumption);
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `速度插件 3: 普通 速度 ${pct(sN.speed)} 耗能 ${pct(sN.consumption)} / 传说 速度 ${pct(sL.speed)} 耗能 ${pct(sL.consumption)}; 产能插件 3: 普通 产能 ${pct(pN.productivity)} 速度 ${pct(pN.speed)} 耗能 ${pct(pN.consumption)} / 传说 产能 ${pct(pL.productivity)} 速度 ${pct(pL.speed)} 耗能 ${pct(pL.consumption)}`,
      measured: { r },
    };
  },
};

export const beaconQuality: Experiment = {
  id: "calc.quality-beacon-effectivity",
  topic: "品质",
  claim: "分享塔品质提高分享效率 (原型: 每级 +0.2, 普通 1.5 → 传说 2.5; wiki: 传说分享塔是普通的 1.66 倍): 1 座塔装 2 个普通速度插件 3 给组装机3型的加速 普通 +150%、传说 +250%",
  refs: ["beacons.sqrt-rule (分享塔递减已核实)", "docs/calc.md"],
  sources: [WIKI_Q, { title: "本机原型: beacon distribution_effectivity 1.5, distribution_effectivity_bonus_per_quality_level 0.2", credibility: 1 }],
  gameSeconds: 2,
  async run(ctx) {
    const r = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      local out = {}
      for i, q in ipairs {"normal", "legendary"} do
        local m = lab.place{surface = s, name = "assembling-machine-3", position = {a.x - 9 + (i - 1) * 16 + 0.5, a.y + 0.5}, recipe = "iron-gear-wheel"}
        local b = lab.place{surface = s, name = "beacon", position = {m.position.x + 3, m.position.y - 0.5}, quality = q}
        lab.insert(b, {name = "speed-module-3", count = 2}, defines.inventory.beacon_modules)
        out[q] = {pos = {x = m.position.x, y = m.position.y}}
      end
      return out`)) as Record<string, { pos: { x: number; y: number } }>;
    await ctx.power();
    await ctx.ticks(60);
    await ctx.powered();
    const b = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface] local out = {}
      for q, v in pairs(a.r) do out[q] = s.find_entity("assembling-machine-3", {v.pos.x, v.pos.y}).speed_bonus end return out`, { r })) as Record<string, number>;
    const ok = Math.abs(b.normal - 1.5) < 0.0011 && Math.abs(b.legendary - 2.5) < 0.0011;
    return {
      verdict: ok ? "verified" : b.normal > 0 ? "refuted" : "inconclusive",
      summary: `1 座分享塔 (2 个普通速度插件 3) 给组装机3型的加速: 普通塔 +${(b.normal * 100).toFixed(1)}%、传说塔 +${(b.legendary * 100).toFixed(1)}% (×${(b.legendary / b.normal).toFixed(2)})`,
      measured: { bonus: b },
    };
  },
};
