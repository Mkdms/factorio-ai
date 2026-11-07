// 沃土 (第一版教训 #2): 每块沃土要 10 个异虫卵, 由"沃土"科技解锁, 前置要"虫卵处理"。
// 这是数据问题, 测法是在运行中的游戏里读原型 (配方原料、解锁科技和前置), 不靠导出文件。
import type { Experiment } from "../src/verify/types.ts";

const READ = `
local r = prototypes.recipe["overgrowth-yumako-soil"]
local ing = {}
for _, i in pairs(r.ingredients) do ing[i.name] = i.amount end
local tech, prereq = nil, {}
for name, t in pairs(prototypes.technology) do
  for _, e in pairs(t.effects or {}) do
    if e.type == "unlock-recipe" and e.recipe == r.name then
      tech = name
      for p in pairs(t.prerequisites) do prereq[#prereq + 1] = p end
    end
  end
end
table.sort(prereq)
return {ingredients = ing, tech = tech, prerequisites = prereq}`;

export const overgrowthSoilNeedsEggs: Experiment = {
  id: "gleba.overgrowth-soil.needs-biter-eggs",
  topic: "生物室",
  claim: "每块玉玛果沃土要 10 个异虫卵, 解锁它的科技 (沃土) 前置包括虫卵处理 (没研究就一块都造不出)",
  refs: ["lessons-v1 #2"],
  sources: [{ title: "本机运行中的游戏原型 (prototypes.recipe / prototypes.technology)", credibility: 1 }],
  gameSeconds: 0,
  async run(ctx) {
    const d = (await ctx.lua(READ)) as { ingredients: Record<string, number>; tech: string; prerequisites: string[] };
    const eggs = d.ingredients["biter-egg"] ?? 0;
    const ok = eggs === 10 && d.prerequisites.includes("biter-egg-handling");
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `配方要${ctx.zh("biter-egg")} ${eggs} 个 (另有 ${Object.entries(d.ingredients).filter(([n]) => n !== "biter-egg").map(([n, k]) => `${ctx.zh(n)}×${k}`).join("、")}); 由科技"${ctx.zh(d.tech)}"解锁, 前置: ${d.prerequisites.map(ctx.zh).join("、")}`,
      measured: d,
    };
  },
};
