// 生物室第二批 (补到 10 条; 第一版教训 #6 "生物室自举"): 营养素当燃料的消耗速率和固有 +50% 产能; 停工的生物室里营养素照样腐坏、变质物堵燃料槽;
// 哪些营养素配方能在生物室之外 (组装机 / 手搓) 做 —— 自举靠的就是这些。
import type { Experiment } from "../src/verify/types.ts";

const RUN = `
local a = ...
local s = game.surfaces[a.surface]
local d = defines.direction
local force = game.forces.player
force.recipes["yumako-processing"].enabled = true
local b = lab.place{surface = s, name = "biochamber", position = {a.x + 0.5, a.y + 0.5}, force = "player"}
b.set_recipe("yumako-processing")
b.insert{name = "nutrients", count = a.nutrients}
b.get_inventory(defines.inventory.crafter_input).insert{name = "yumako", count = 50}
-- 出料: 东侧机械臂 → 钢箱 (不让输出槽堵住)
local slot = lab.slots(b, "east")[2]
lab.place{surface = s, name = "fast-inserter", position = slot, direction = d.west, force = "player"}
local c = lab.place{surface = s, name = "steel-chest", position = {slot.x + 1, slot.y}, force = "player"}
return {b = {x = b.position.x, y = b.position.y}, c = {x = c.position.x, y = c.position.y}}`;

const TOPUP = `
local a = ...
local b = game.surfaces[a.surface].find_entity("biochamber", {a.r.b.x, a.r.b.y})
local inv = b.get_inventory(defines.inventory.crafter_input)
local have = inv.get_item_count("yumako")
local added = 0
if have < 20 then added = inv.insert{name = "yumako", count = 50 - have} end
return added`;

const READ = `
local a = ...
local s = game.surfaces[a.surface]
local b = s.find_entity("biochamber", {a.r.b.x, a.r.b.y})
local c = s.find_entity("steel-chest", {a.r.c.x, a.r.c.y})
local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
local fuel = b.get_fuel_inventory()
local out = b.get_output_inventory()
local ci = c.get_inventory(defines.inventory.chest)
return {nutrients = fuel.get_item_count("nutrients"), spoilage_in_fuel = fuel.get_item_count("spoilage"),
        burning = b.burner and b.burner.remaining_burning_fuel or 0,
        yumako_left = b.get_inventory(defines.inventory.crafter_input).get_item_count("yumako"),
        mash = ci.get_item_count("yumako-mash") + out.get_item_count("yumako-mash"), seeds = ci.get_item_count("yumako-seed") + out.get_item_count("yumako-seed"),
        finished = b.products_finished, status = names[b.status], tick = game.tick} -- lint-ok: 只显示; 开工时间按吃掉的果算
`;

export const nutrientsFuelRateAndProductivity: Experiment = {
  id: "biochamber.nutrients-fuel-rate.base-productivity",
  topic: "生物室",
  claim: "生物室以营养素为燃料: 开工时每分钟吃 15 个 (500kW ÷ 2MJ); 固有 +50% 产能: 1 个玉玛果出 3 个玉玛果泥 (配方 2 个 × 1.5)",
  refs: ["lessons-v1 #6 (生物室自举)", "knowledge/patterns/production.md P-prod-05 (产能插件给贵的中间品)"],
  sources: [{ title: "本机原型: biochamber energy_usage 500kW、燃料类别 nutrients (2MJ)、base_effect productivity 0.5; yumako-processing 1 玉玛果 → 2 玉玛果泥", credibility: 1 }],
  surface: "gleba",
  gameSeconds: 70,
  async run(ctx) {
    await ctx.power();
    const r = (await ctx.lua(RUN, { nutrients: 50 })) as { b: { x: number; y: number }; c: { x: number; y: number } };
    await ctx.powered();
    let yumakoIn = 50;
    const start = (await ctx.lua(READ, { r })) as { nutrients: number; burning: number; yumako_left: number; mash: number; finished: number; status: string };
    for (let i = 0; i < 6; i++) {
      await ctx.ticks(600);
      yumakoIn += (await ctx.lua(TOPUP, { r })) as number;
    }
    const end = (await ctx.lua(READ, { r })) as typeof start;
    const yumakoUsed = yumakoIn - end.yumako_left;
    const nutrientsUsed = start.nutrients - end.nutrients + (start.burning - end.burning) / 2e6;
    const mashPerFruit = (end.mash - start.mash) / Math.max(1, yumakoUsed);
    if (yumakoUsed < 20) return { verdict: "inconclusive", summary: `生物室几乎没开工 (吃了 ${yumakoUsed} 个果, 状态 ${end.status})`, measured: { start, end } };
    // 机器不一定满负荷 (补料间隙会空转), 燃料按"开工时间"折算: 每次加工吃 1 个果、用 1 秒 ÷ 速度 2 = 0.5 秒
    // (不能用 products_finished: 它把产能白送的那份也算一次, lab.md #19)
    const workingMinutes = yumakoUsed * 0.5 / 60;
    const perWorkingMinute = nutrientsUsed / Math.max(0.01, workingMinutes);
    const ok = Math.abs(perWorkingMinute - 15) <= 1.5 && Math.abs(mashPerFruit - 3) <= 0.15;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `60 秒: 加工 ${end.finished - start.finished} 次 (开工 ${(workingMinutes * 60).toFixed(0)} 秒), 吃 ${yumakoUsed} 个玉玛果出 ${end.mash - start.mash} 个果泥 (每果 ${mashPerFruit.toFixed(2)}), 营养素烧掉 ${nutrientsUsed.toFixed(1)} 个 = 每开工 1 分钟 ${perWorkingMinute.toFixed(1)} 个`,
      measured: { start, end, yumakoUsed, nutrientsUsed, mashPerFruit, workingMinutes, perWorkingMinute },
    };
  },
};

const IDLE = `
local a = ...
local s = game.surfaces[a.surface]
local b = lab.place{surface = s, name = "biochamber", position = {a.x + 0.5, a.y + 0.5}, force = "player"}
b.insert{name = "nutrients", count = 10}
return {b = {x = b.position.x, y = b.position.y}}`;

const IDLE_READ = `
local a = ...
local b = game.surfaces[a.surface].find_entity("biochamber", {a.r.b.x, a.r.b.y})
local fuel = b.get_fuel_inventory()
local st = fuel.find_item_stack("nutrients")
local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
-- 变质物去哪了: 燃料槽 / 烧尽物槽 / 输出槽 / 地上
local function count(inv) return inv and inv.get_item_count("spoilage") or 0 end
local burnt = b.burner and b.burner.burnt_result_inventory
local ground = 0
for _, e in pairs(game.surfaces[a.surface].find_entities_filtered{area = {{a.r.b.x - 4, a.r.b.y - 4}, {a.r.b.x + 4, a.r.b.y + 4}}, type = "item-entity"}) do
  if e.stack and e.stack.name == "spoilage" then ground = ground + e.stack.count end
end
return {nutrients = fuel.get_item_count("nutrients"), spoil = st and st.spoil_percent or nil, spoilage = count(fuel), spoilage_burnt = count(burnt), spoilage_out = count(b.get_output_inventory()), spoilage_ground = ground, status = names[b.status], tick = game.tick}`;

export const idleNutrientsSpoil: Experiment = {
  id: "biochamber.idle.nutrients-spoil-in-fuel-slot",
  topic: "生物室",
  claim: "没活干的生物室里营养素照样腐坏 (2.5 分钟 50%, 5 分钟全坏); 坏掉的变质物不留在燃料槽里 (实测记下它的去向), 生物室变成没燃料的状态",
  refs: ["lessons-v1 #6", "knowledge/patterns/production.md P-prod-19 (变质物营养素备用机)"],
  sources: [{ title: "本机原型: nutrients spoil 18000 tick → spoilage; spoilage 没有 fuel_value", credibility: 1 }],
  surface: "gleba",
  gameSeconds: 320,
  async run(ctx) {
    await ctx.power();
    const r = (await ctx.lua(IDLE)) as { b: { x: number; y: number } };
    await ctx.ticks(9000);
    const half = (await ctx.lua(IDLE_READ, { r })) as { nutrients: number; spoil: number | null; spoilage: number; spoilage_burnt: number; spoilage_out: number; spoilage_ground: number; status: string };
    await ctx.ticks(9600);
    const end = (await ctx.lua(IDLE_READ, { r })) as typeof half;
    const ok = half.nutrients === 10 && half.spoil !== null && Math.abs(half.spoil - 0.5) < 0.05 && end.nutrients === 0 && end.status === "no_fuel";
    const where = end.spoilage ? `留在燃料槽 ${end.spoilage} 个` : end.spoilage_burnt ? `进了烧尽物槽 ${end.spoilage_burnt} 个` : end.spoilage_out ? `进了输出槽 ${end.spoilage_out} 个` : end.spoilage_ground ? `掉在地上 ${end.spoilage_ground} 个` : "哪儿都没有 (直接消失)";
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `停工的生物室: 2.5 分钟营养素腐坏 ${half.spoil === null ? "没读到" : (half.spoil * 100).toFixed(0) + "%"}; 5 分钟后燃料槽里营养素 ${end.nutrients} 个, 变质物${where} (状态 ${end.status})`,
      measured: { half, end },
    };
  },
};

const CRAFTERS = `
local a = ...
local s = game.surfaces[a.surface]
local force = game.forces.player
local names = {"nutrients-from-spoilage", "nutrients-from-yumako-mash", "nutrients-from-bioflux", "nutrients-from-biter-egg", "yumako-processing", "jellynut-processing", "bioflux"}
for _, n in ipairs(names) do if force.recipes[n] then force.recipes[n].enabled = true end end
local asm = lab.place{surface = s, name = "assembling-machine-2", position = {a.x - 5.5, a.y + 0.5}, force = "player"}
local bio = lab.place{surface = s, name = "biochamber", position = {a.x + 5.5, a.y + 0.5}, force = "player"}
local out = {}
for _, n in ipairs(names) do
  local proto = prototypes.recipe[n]
  local okA = pcall(function() local r = asm.set_recipe(n) if asm.get_recipe() == nil or asm.get_recipe().name ~= n then error("没设上") end end)
  local okB = pcall(function() local r = bio.set_recipe(n) if bio.get_recipe() == nil or bio.get_recipe().name ~= n then error("没设上") end end)
  -- 2.1: 配方可以属于多个类别 (categories), 没有单数的 category
  local cats = {}
  local okc, c = pcall(function() return proto.categories end)
  if okc and type(c) == "table" then for k, v in pairs(c) do cats[#cats + 1] = type(k) == "string" and k or tostring(v) end end
  local hand = false
  local charCats = prototypes.entity["character"].crafting_categories or {}
  for _, cat in ipairs(cats) do if charCats[cat] then hand = true end end
  out[n] = {category = table.concat(cats, ","), assembler = okA, biochamber = okB, hand = hand}
end
return out`;

export const bootstrapRecipes: Experiment = {
  id: "biochamber.bootstrap.nutrient-recipes-outside-biochamber",
  topic: "生物室",
  claim: "生物室自举靠的是能在生物室之外做的配方: 变质物→营养素 和 玉玛果/果冻果加工 可以在组装机里 (或手搓) 做, 果泥→营养素、生物结晶→营养素、生物结晶 只能在生物室里做 (没有营养素就先用组装机把变质物或果子变成营养素)",
  refs: ["lessons-v1 #6 (第一版生物室没营养素起不来)", "knowledge/patterns/planets.md 句芒 落地 5 件事"],
  sources: [{ title: "本机原型: 各配方的 category 和 组装机 / 角色 / 生物室 的 crafting_categories", credibility: 1 }],
  surface: "gleba",
  gameSeconds: 1,
  allowUnpowered: true, // 只看配方能不能设上, 机器不用开工
  async run(ctx) {
    const r = (await ctx.lua(CRAFTERS)) as Record<string, { category: string; assembler: boolean; biochamber: boolean; hand: boolean }>;
    const a = (n: string) => r[n]?.assembler, b = (n: string) => r[n]?.biochamber;
    const ok = a("nutrients-from-spoilage") && a("yumako-processing") && a("jellynut-processing") && !a("nutrients-from-yumako-mash") && !a("nutrients-from-bioflux") && !a("bioflux") && b("nutrients-from-yumako-mash") && b("bioflux");
    const list = Object.entries(r).map(([n, v]) => `${ctx.zh(n)}: ${[v.assembler ? "组装机" : "", v.hand ? "手搓" : "", v.biochamber ? "生物室" : ""].filter(Boolean).join("/") || "都不行"} (${v.category})`).join("; ");
    return { verdict: ok ? "verified" : "refuted", summary: list, measured: r };
  },
};
