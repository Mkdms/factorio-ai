// 腐坏第二批 (补到 10 条): 堆叠合并时新鲜度按件数加权平均 (L21); 多种会腐坏的原料做配方时产物取平均 (wiki Spoilage mechanics); 果子长在树上不腐坏 (L22)。
import type { Experiment } from "../src/verify/types.ts";

const MERGE = `
local a = ...
local s = game.surfaces[a.surface]
local c = lab.place{surface = s, name = "steel-chest", position = {a.x + 0.5, a.y + 0.5}, force = "player"}
local inv = c.get_inventory(defines.inventory.chest)
inv[1].set_stack{name = "nutrients", count = a.n1}
inv[1].spoil_percent = a.s1
inv[2].set_stack{name = "nutrients", count = a.n2}
inv[2].spoil_percent = a.s2
local before = {inv[1].spoil_percent, inv[2].spoil_percent}
-- 把第 2 格并进第 1 格
local ok, err = pcall(function() inv[1].transfer_stack(inv[2]) end)
return {ok = ok, err = tostring(err), before = before, count = inv[1].valid_for_read and inv[1].count or 0, spoil = inv[1].valid_for_read and inv[1].spoil_percent or nil, slot2 = inv[2].valid_for_read and inv[2].count or 0}`;

export const stackMergeWeightedAverage: Experiment = {
  id: "spoilage.stack-merge.weighted-average",
  topic: "腐坏",
  claim: "两堆新鲜度不同的同种物品并成一堆时, 新鲜度按件数加权平均 (10 个 50% + 30 个 10% → 40 个 20%), 整堆以后一起腐坏",
  refs: ["logistics.md L21", "knowledge/patterns/production.md (句芒线别囤)"],
  sources: [{ title: "官方 wiki: Spoilage mechanics (stack merging)", url: "https://wiki.factorio.com/Spoilage_mechanics", date: "2026-10-15", credibility: 2 }],
  gameSeconds: 1,
  async run(ctx) {
    const r = (await ctx.lua(MERGE, { n1: 10, s1: 0.5, n2: 30, s2: 0.1 })) as { ok: boolean; err: string; before: number[]; count: number; spoil: number | null; slot2: number };
    if (!r.ok || r.count !== 40 || r.spoil === null) return { verdict: "inconclusive", summary: `没并成一堆: ${r.err}, 第 1 格 ${r.count} 个, 第 2 格剩 ${r.slot2}`, measured: r };
    const expect = (10 * 0.5 + 30 * 0.1) / 40;
    const ok = Math.abs(r.spoil - expect) < 0.02;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `10 个 ${(r.before[0] * 100).toFixed(0)}% + 30 个 ${(r.before[1] * 100).toFixed(0)}% 并成 ${r.count} 个, 腐坏进度 ${(r.spoil * 100).toFixed(1)}% (加权平均应为 ${(expect * 100).toFixed(0)}%)`,
      measured: { ...r, expect },
    };
  },
};

const CRAFT2 = `
local a = ...
local s = game.surfaces[a.surface]
local force = game.forces.player
force.recipes["bioflux"].enabled = true
local b = lab.place{surface = s, name = "biochamber", position = {a.x + 0.5, a.y + 0.5}, force = "player"}
b.set_recipe("bioflux")
b.insert{name = "nutrients", count = 10}
local inv = b.get_inventory(defines.inventory.crafter_input)
inv.insert{name = "yumako-mash", count = 15}
inv.insert{name = "jelly", count = 12}
local m = inv.find_item_stack("yumako-mash")
local j = inv.find_item_stack("jelly")
m.spoil_percent = a.mash
j.spoil_percent = a.jelly
return {x = b.position.x, y = b.position.y, mash = m.spoil_percent, jelly = j.spoil_percent}`;

const CRAFT2_READ = `
local a = ...
local b = game.surfaces[a.surface].find_entity("biochamber", {a.ref.x, a.ref.y})
local out = b.get_output_inventory()
local st = out.find_item_stack("bioflux")
return {count = out.get_item_count("bioflux"), spoil = st and st.spoil_percent or nil, finished = b.products_finished} -- lint-ok: 只用来判断做没做
`;

export const multipleSpoilableAveraged: Experiment = {
  id: "spoilage.crafting.multiple-spoilable-averaged",
  topic: "腐坏",
  claim: "配方有多种会腐坏的原料时 (生物结晶 = 15 玉玛果泥 + 12 果冻), 产物的新鲜度取原料的平均 (wiki 没说是按件数加权还是简单平均; 实测给出数值)",
  refs: ["docs/verify.md 下一批 (多种会腐坏原料的配方)", "logistics.md L21"],
  sources: [{ title: "官方 wiki: Spoilage mechanics (multiple spoilable inputs → averaged)", url: "https://wiki.factorio.com/Spoilage_mechanics", date: "2026-10-15", credibility: 2 }],
  surface: "gleba",
  gameSeconds: 10,
  async run(ctx) {
    await ctx.power();
    await ctx.powered();
    const ref = (await ctx.lua(CRAFT2, { mash: 0.0, jelly: 0.6 })) as { x: number; y: number; mash: number; jelly: number };
    await ctx.ticks(300);
    const r = (await ctx.lua(CRAFT2_READ, { ref })) as { count: number; spoil: number | null; finished: number };
    if (r.count === 0 || r.spoil === null) return { verdict: "inconclusive", summary: `生物室没做出生物结晶 (完成 ${r.finished} 次)`, measured: { ref, r } };
    const simple = (ref.mash + ref.jelly) / 2, weighted = (15 * ref.mash + 12 * ref.jelly) / 27;
    const between = r.spoil > Math.min(ref.mash, ref.jelly) + 0.05 && r.spoil < Math.max(ref.mash, ref.jelly) - 0.05;
    const closer = Math.abs(r.spoil - simple) < Math.abs(r.spoil - weighted) ? "简单平均" : "按件数加权";
    return {
      verdict: between ? "verified" : "refuted",
      summary: `玉玛果泥 ${(ref.mash * 100).toFixed(0)}% + 果冻 ${(ref.jelly * 100).toFixed(0)}% → 生物结晶 ${(r.spoil * 100).toFixed(1)}% (简单平均 ${(simple * 100).toFixed(1)}%, 按件数加权 ${(weighted * 100).toFixed(1)}%, 更接近${closer})`,
      measured: { ref, r, simple, weighted },
    };
  },
};

const PLANT = `
local a = ...
local s = game.surfaces[a.surface]
local tiles = {}
for x = a.x - 8, a.x + 7 do for y = a.y - 8, a.y + 7 do tiles[#tiles + 1] = {name = "natural-yumako-soil", position = {x, y}} end end
s.set_tiles(tiles, true, true, true)
local t = lab.place{surface = s, name = "yumako-tree", position = {a.x - 3.5, a.y + 0.5}, force = "neutral"}
-- 对照: 箱子里放 10 个新鲜的玉玛果, 和树一起等
local c = lab.place{surface = s, name = "steel-chest", position = {a.x + 6.5, a.y - 6.5}, force = "player"}
c.insert{name = "yumako", count = 10}
return {tree = {x = t.position.x, y = t.position.y}, chest = {x = c.position.x, y = c.position.y}}`;

const HARVEST = `
local a = ...
local s = game.surfaces[a.surface]
local tower = lab.place{surface = s, name = "agricultural-tower", position = {a.x + 0.5, a.y + 0.5}, force = "player"}
return {x = tower.position.x, y = tower.position.y}`;

const READ_FRUIT = `
local a = ...
local s = game.surfaces[a.surface]
local tower = s.find_entity("agricultural-tower", {a.tower.x, a.tower.y})
local out = tower.get_output_inventory()
local st = out.find_item_stack("yumako")
local c = s.find_entity("steel-chest", {a.chest.x, a.chest.y})
local cs = c.get_inventory(defines.inventory.chest).find_item_stack("yumako")
local tree = s.find_entity("yumako-tree", {a.tree.x, a.tree.y})
return {harvested = out.get_item_count("yumako"), spoil = st and st.spoil_percent or nil, chest_spoil = cs and cs.spoil_percent or nil, tree_alive = tree ~= nil, tick = game.tick}`;

export const fruitNoSpoilBeforeHarvest: Experiment = {
  id: "spoilage.fruit.no-spoil-before-harvest",
  topic: "腐坏",
  claim: "果子长在树上不腐坏: 玉玛果树熟了放 35 分钟不收, 收下来的果仍是新鲜的; 同一时间箱子里的玉玛果已腐坏过半 (60 分钟全坏)",
  refs: ["logistics.md L22", "knowledge/patterns/production.md P-prod-19 (按需收)"],
  sources: [
    { title: "官方论坛 (句芒做法: 果子采摘前不会腐坏)", url: "https://forums.factorio.com/viewtopic.php?p=701792", date: "2025-09", credibility: 3 },
    { title: "本机原型: 玉玛果树 18000 tick 成熟; 玉玛果 216000 tick 腐坏", credibility: 1 },
  ],
  surface: "gleba",
  gameSeconds: 2500,
  async run(ctx) {
    await ctx.power();
    const p = (await ctx.lua(PLANT)) as { tree: { x: number; y: number }; chest: { x: number; y: number } };
    await ctx.ticks(18000 + 35 * 3600); // 5 分钟长熟 + 35 分钟挂在树上
    const tower = (await ctx.lua(HARVEST)) as { x: number; y: number };
    await ctx.powered();
    let r = (await ctx.lua(READ_FRUIT, { tower, ...p })) as { harvested: number; spoil: number | null; chest_spoil: number | null; tree_alive: boolean; tick: number };
    for (let i = 0; i < 12 && r.harvested === 0; i++) { await ctx.ticks(300); r = (await ctx.lua(READ_FRUIT, { tower, ...p })) as typeof r; }
    if (r.harvested === 0 || r.spoil === null) return { verdict: "inconclusive", summary: `农业塔没收到果 (树${r.tree_alive ? "还在" : "没了"})`, measured: { p, r } };
    const ok = r.spoil < 0.05 && r.chest_spoil !== null && r.chest_spoil > 0.5;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `树上挂了 35 分钟才收: ${r.harvested} 个玉玛果腐坏 ${(r.spoil * 100).toFixed(1)}%; 同期箱子里的玉玛果腐坏 ${r.chest_spoil === null ? "没读到" : (r.chest_spoil * 100).toFixed(0) + "%"}`,
      measured: { p, r },
    };
  },
};
