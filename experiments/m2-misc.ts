// M2 收尾: 第三轮检索里"待沙盘"的说法。科技包品质放大研究量 (production.md 本机速查); 每个表面只能建 1 个货运着陆平台 (space-age.md 本机速查)。
import type { Experiment } from "../src/verify/types.ts";

export const qualitySciencePack: Experiment = {
  id: "quality.science-pack.research-per-pack",
  topic: "品质",
  claim: "科技包品质按 1 + 等级放大研究量: 一瓶传说品质的自动化科技包顶 6 瓶普通的 (检索原文; 注意本机更新日志 2.1.7 把科技包从工具类改成了普通物品, 耐久机制可能已经没了)",
  refs: ["production.md 本机速查 (科技包属于工具类物品, 品质按 1 + 等级放大耐久, 待沙盘确认)", "endgame-research.md (每包研究量)"],
  sources: [{ title: "检索 production.md 本机速查 (科技包是工具类、品质放大耐久); 本机更新日志 2.1.7: Changed all science packs to be plain items", credibility: 1 }],
  gameSeconds: 100,
  async run(ctx) {
    await ctx.power();
    const setup = (await ctx.lua(`local a = ...
      local s = game.surfaces[a.surface]
      local f = game.forces.player
      local t = f.technologies["automation"]
      if t.researched then error("自动化已研究, 换一个科技", 0) end
      -- 2.x 里自动化有前置科技 (做出东西才解锁的那种), 没完成就加不进队列: 临时标成已研究, 测完还原
      local pre = {}
      for name, p in pairs(t.prerequisites) do if not p.researched then p.researched = true pre[#pre + 1] = name end end
      f.cancel_current_research()
      if not f.add_research(t) then error("自动化没加进研究队列 (前置: " .. table.concat(pre, "、") .. ")", 0) end
      if not f.current_research then error("加进队列了但没在研究", 0) end
      f.research_progress = 0
      local lb = lab.place{surface = s, name = "lab", position = {a.x + 0.5, a.y + 0.5}, force = "player"}
      local ptype = prototypes.item["automation-science-pack"].type
      return {lab = {x = lb.position.x, y = lb.position.y}, units = t.research_unit_count, unit_ticks = t.research_unit_energy, ptype = ptype, pre = pre}`)) as { lab: { x: number; y: number }; units: number; unit_ticks: number; ptype: string; pre: string[] | Record<string, never> };
    await ctx.ticks(60);
    await ctx.powered();
    const feed = (q: string) => ctx.lua(`local a = ... local lb = game.surfaces[a.surface].find_entity("lab", {a.p.x, a.p.y})
      lab.insert(lb, {name = "automation-science-pack", count = 1, quality = a.q}, defines.inventory.lab_input) return true`, { p: setup.lab, q });
    const progress = async () => (await ctx.lua(`return game.forces.player.research_progress`)) as number;
    await feed("normal");
    await ctx.ticks(Math.ceil(setup.unit_ticks * 2));
    const p1 = await progress();
    await feed("legendary");
    await ctx.ticks(Math.ceil(setup.unit_ticks * 7));
    const p2 = await progress();
    await ctx.lua(`local a = ... local f = game.forces.player f.cancel_current_research()
      for _, name in ipairs(a.pre) do f.technologies[name].researched = false end return true`, { pre: Array.isArray(setup.pre) ? setup.pre : [] });
    const normal = p1 * setup.units, legendary = (p2 - p1) * setup.units;
    const ok = Math.abs(normal - 1) < 0.05 && Math.abs(legendary - 6) < 0.05;
    return {
      verdict: ok ? "verified" : normal > 0.9 && Math.abs(legendary - 1) < 0.05 ? "refuted" : "inconclusive",
      summary: `自动化 (${setup.units} 份, 每份 ${setup.unit_ticks / 60} 秒): 1 瓶普通推进 ${normal.toFixed(2)} 份, 1 瓶传说推进 ${legendary.toFixed(2)} 份; 科技包原型类型 ${setup.ptype}`,
      measured: { setup, p1, p2, normal, legendary },
    };
  },
};

export const oneLandingPadPerSurface: Experiment = {
  id: "space.landing-pad.one-per-surface",
  topic: "太空",
  claim: "每个表面只能建 1 个货运着陆平台: 已经有一个时, 按玩家摆放规则第二个放不下",
  refs: ["space-age.md 本机速查 (报错文字\"每个表面只能建造 N 个\", 原版 N 应为 1, 待沙盘确认)"],
  sources: [{ title: "本机中文语言文件: 每个表面只能建造 __1__ 个物流接驳站 / 货运着陆平台的报错", credibility: 1 }],
  gameSeconds: 2,
  async run(ctx) {
    const m = (await ctx.lua(`local a = ...
      local s = game.surfaces[a.surface]
      local old = 0
      for _, e in pairs(s.find_entities_filtered{name = "cargo-landing-pad"}) do e.destroy() old = old + 1 end -- 前面实验留下的 (实验一个接一个跑, 都做完了)
      local manual = defines.build_check_type.manual
      local can1 = s.can_place_entity{name = "cargo-landing-pad", position = {a.x - 6, a.y}, force = "player", build_check_type = manual}
      local p1 = lab.place{surface = s, name = "cargo-landing-pad", position = {a.x - 6, a.y}, force = "player"}
      local can2 = s.can_place_entity{name = "cargo-landing-pad", position = {a.x + 6, a.y}, force = "player", build_check_type = manual}
      local ok, e2 = pcall(function() return s.create_entity{name = "cargo-landing-pad", position = {a.x + 6, a.y}, force = "player"} end)
      local created = ok and e2 ~= nil
      if created then lab.label(e2, "第二个 (脚本硬建)") end
      return {old = old, can1 = can1, can2 = can2, created = created, err = (not ok) and tostring(e2) or nil, count = s.count_entities_filtered{name = "cargo-landing-pad"}}`)) as { old: number; can1: boolean; can2: boolean; created: boolean; err?: string; count: number };
    await ctx.powered();
    const ok = m.can1 && !m.can2;
    return {
      verdict: ok ? "verified" : m.can1 && m.can2 ? "refuted" : "inconclusive",
      summary: `先拆掉旧的 ${m.old} 个; 第一个按玩家规则${m.can1 ? "放得下" : "放不下"}; 有一个以后第二个${m.can2 ? "放得下" : "放不下"}; 脚本硬建第二个${m.created ? "建成了" : "没建成"}${m.err ? ` (${m.err.slice(0, 80)})` : ""}, 现在 ${m.count} 个`,
      measured: m,
    };
  },
};
