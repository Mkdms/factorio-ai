// 腐坏 (句芒设计的根基; 本机原型 spoil_ticks; wiki Spoilage mechanics 2026-10-15):
//   1. 营养素 5 分钟 (18000 tick) 变成变质物, 腐坏进度按时间线性走;
//   2. 五足虫卵 15 分钟 (54000 tick) 原地孵出大型早衰蠕动五足虫 (每个卵一只);
//   3. 配方只有一种会腐坏的原料时, 产物直接继承它的新鲜度 (玉玛果泥 50% 新鲜 → 营养素也约 50%)。
import type { Experiment } from "../src/verify/types.ts";

const CHEST = `
local a = ...
local s = game.surfaces[a.surface]
local c = s.create_entity{name = "steel-chest", position = {a.x + 0.5, a.y + 0.5}, force = "player"}
c.insert{name = a.item, count = a.count}
return {x = c.position.x, y = c.position.y}`;

const CHEST_READ = `
local a = ...
local c = game.surfaces[a.surface].find_entity("steel-chest", {a.ref.x, a.ref.y})
local inv = c.get_inventory(defines.inventory.chest)
local st = inv.find_item_stack(a.item)
return {count = inv.get_item_count(a.item), spoil = st and st.spoil_percent or nil, spoilage = inv.get_item_count("spoilage"), tick = game.tick}`;

export const nutrientsSpoilLinear: Experiment = {
  id: "spoilage.nutrients.5-minutes-linear",
  topic: "腐坏",
  claim: "营养素 5 分钟 (18000 tick) 腐坏成变质物, 中途腐坏进度和时间成正比 (2.5 分钟时约 50%)",
  refs: ["gleba.md 本机速查: 腐坏时间", "knowledge-taxonomy 二: 腐坏"],
  sources: [
    { title: "本机原型数据: nutrients spoil_ticks 18000 → spoilage", credibility: 1 },
    { title: "官方 wiki: Spoilage mechanics", url: "https://wiki.factorio.com/Spoilage_mechanics", date: "2026-10-15", credibility: 2 },
  ],
  gameSeconds: 310,
  async run(ctx) {
    const ref = await ctx.lua(CHEST, { item: "nutrients", count: 10 });
    await ctx.ticks(9000);
    const half = (await ctx.lua(CHEST_READ, { ref, item: "nutrients" })) as { count: number; spoil: number | null; spoilage: number };
    await ctx.ticks(9600);
    const end = (await ctx.lua(CHEST_READ, { ref, item: "nutrients" })) as { count: number; spoil: number | null; spoilage: number };
    const ok = half.count === 10 && half.spoil !== null && Math.abs(half.spoil - 0.5) < 0.03 && end.count === 0 && end.spoilage === 10;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `2.5 分钟时 10 个营养素腐坏进度 ${half.spoil === null ? "没读到" : (half.spoil * 100).toFixed(0) + "%"}; 5 分钟 10 秒时剩 ${end.count} 个营养素、${end.spoilage} 个变质物`,
      measured: { half, end },
    };
  },
};

const COUNT_WRIGGLERS = `
local a = ...
local s = game.surfaces[a.surface]
local list = s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, type = "unit"}
local names = {}
for _, u in pairs(list) do names[u.name] = (names[u.name] or 0) + 1 end
for _, u in pairs(list) do u.destroy() end
return names`;

export const pentapodEggHatches: Experiment = {
  id: "spoilage.pentapod-egg.hatches-15-minutes",
  topic: "腐坏",
  claim: "五足虫卵放在箱子里 15 分钟 (54000 tick) 后不是变成变质物, 而是原地孵出大型早衰蠕动五足虫, 一个卵一只 (这就是\"会孵化的东西只走传送带\"的根据)",
  refs: ["记忆 feedback-hatch-risk-logistics", "gleba.md G9、G15", "requirements 原则: 会孵化的东西"],
  sources: [
    { title: "本机原型数据: pentapod-egg spoil_ticks 54000, spoil_to_trigger_result", credibility: 1 },
    { title: "官方 wiki: Spoilage mechanics (特殊腐坏物表: Spawns a premature wriggler)", url: "https://wiki.factorio.com/Spoilage_mechanics", date: "2026-10-15", credibility: 2 },
  ],
  gameSeconds: 910,
  async run(ctx) {
    const ref = await ctx.lua(CHEST, { item: "pentapod-egg", count: 3 });
    await ctx.ticks(27000);
    const half = (await ctx.lua(CHEST_READ, { ref, item: "pentapod-egg" })) as { count: number; spoil: number | null };
    await ctx.ticks(27600);
    const end = (await ctx.lua(CHEST_READ, { ref, item: "pentapod-egg" })) as { count: number; spoilage: number };
    const units = (await ctx.lua(COUNT_WRIGGLERS)) as Record<string, number>;
    const wrigglers = units["big-wriggler-pentapod-premature"] ?? 0;
    const ok = half.count === 3 && end.count === 0 && end.spoilage === 0 && wrigglers === 3;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `3 个卵: 7.5 分钟时还在 (进度 ${half.spoil === null ? "没读到" : (half.spoil * 100).toFixed(0) + "%"}); 15 分钟后箱子里剩 ${end.count} 个卵、${end.spoilage} 个变质物, 箱子旁出现 ${Object.entries(units).map(([n, k]) => `${ctx.zh(n)}×${k}`).join("、") || "没有单位"}`,
      measured: { half, end, units },
    };
  },
};

const CRAFT = `
local a = ...
local s = game.surfaces[a.surface]
game.forces.player.recipes["nutrients-from-yumako-mash"].enabled = true -- 没研究的配方机器不开工 (第一次漏了这句, 完成 0 次)
local b = s.create_entity{name = "biochamber", position = {a.x + 6, a.y}, force = "player"}
b.set_recipe("nutrients-from-yumako-mash")
b.insert{name = "nutrients", count = 10}
local inv = b.get_inventory(defines.inventory.crafter_input)
inv.insert{name = "yumako-mash", count = 4} -- 配方: 4 玉玛果泥 → 6 营养素, 4 秒 (生物室速度 2 → 2 秒)
local st = inv.find_item_stack("yumako-mash")
st.spoil_percent = a.spoil
return {x = b.position.x, y = b.position.y, input_spoil = st.spoil_percent}`;

const CRAFT_READ = `
local a = ...
local b = game.surfaces[a.surface].find_entity("biochamber", {a.ref.x, a.ref.y})
local out = b.get_output_inventory()
local st = out.find_item_stack("nutrients")
return {count = out.get_item_count("nutrients"), spoil = st and st.spoil_percent or nil, finished = b.products_finished} -- lint-ok: 只用来判断做没做
`;

export const freshnessInherited: Experiment = {
  id: "spoilage.crafting.inherits-freshness",
  topic: "腐坏",
  claim: "配方只有一种会腐坏的原料时, 产物直接继承它的腐坏进度: 用腐坏了 50% 的玉玛果泥做营养素, 做出的营养素一出来就约 50%",
  refs: ["knowledge-taxonomy 二: 腐坏", "gleba.md 第 2 节 腐坏"],
  sources: [
    { title: "官方 wiki: Spoilage mechanics (\"If the recipe only has one spoilable input, then the freshness percentage is transferred directly to the output\")", url: "https://wiki.factorio.com/Spoilage_mechanics", date: "2026-10-15", credibility: 2 },
  ],
  surface: "gleba",
  gameSeconds: 10,
  async run(ctx) {
    const ref = (await ctx.lua(CRAFT, { spoil: 0.5 })) as { x: number; y: number; input_spoil: number };
    await ctx.ticks(300);
    const r = (await ctx.lua(CRAFT_READ, { ref })) as { count: number; spoil: number | null; finished: number };
    if (r.count === 0 || r.spoil === null) return { verdict: "inconclusive", summary: `生物室没做出营养素 (完成 ${r.finished} 次)`, measured: { ref, r } };
    // 做一次 2 秒, 出来后又放了几秒 (营养素 5 分钟全坏, 5 秒约 1.7%), 允许多腐坏一点
    const ok = r.spoil >= 0.48 && r.spoil <= 0.56;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `原料玉玛果泥腐坏 ${(ref.input_spoil * 100).toFixed(0)}%, 做出 ${r.count} 个营养素, 读到时腐坏 ${(r.spoil * 100).toFixed(1)}%`,
      measured: { input: ref.input_spoil, output: r },
    };
  },
};
