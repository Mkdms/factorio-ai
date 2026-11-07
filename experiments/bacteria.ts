// 铜细菌引种 (第一版教训 #5): 3 玉玛果泥 → 10% 出 1 个铜细菌 + 1 个变质物。
// 测法: 在句芒地表放一台生物室 (自带 +50% 产能), 每 10 秒把产物取走计数、补原料和营养素。
// 每次出结果 (含产能多出来的) 都必出 1 个变质物, 所以 铜细菌数 / 变质物数 = 出菌概率。
import type { Experiment } from "../src/verify/types.ts";

const PLACE = `
local a = ...
local s = game.surfaces[a.surface]
game.forces.player.recipes["copper-bacteria"].enabled = true
local b = s.create_entity{name = "biochamber", position = {a.x, a.y}, force = "player"}
b.set_recipe("copper-bacteria")
b.insert{name = "nutrients", count = 50}
b.insert{name = "yumako-mash", count = 60}
return {surface = a.surface, x = b.position.x, y = b.position.y}`;

// 取走产物计数, 补原料; 返回这 10 秒的计数
const COLLECT = `
local a = ...
local b = game.surfaces[a.ref.surface].find_entity("biochamber", {a.ref.x, a.ref.y})
local out = b.get_output_inventory()
local r = {bacteria = out.get_item_count("copper-bacteria"), spoilage = out.get_item_count("spoilage"), finished = b.products_finished} -- lint-ok: 每次完成 (含产能白送的那次) 都单独掷 10%, 正好是要的样本数
out.clear()
local inv = b.get_inventory(defines.inventory.crafter_input)
local have = inv.get_item_count("yumako-mash")
if have < 60 then b.insert{name = "yumako-mash", count = 60 - have} end
local fuel = b.get_fuel_inventory()
if fuel.get_item_count("nutrients") < 20 then b.insert{name = "nutrients", count = 30} end
r.status = b.status
return r`;

export const copperBacteriaChance: Experiment = {
  id: "gleba.copper-bacteria.inoculation-chance",
  topic: "生物室",
  claim: "铜细菌引种配方 (3 玉玛果泥) 每次只有 10% 出 1 个铜细菌, 不是 100%",
  refs: ["lessons-v1 #5", "gleba.md 本机速查: 关键配方", "research README 第一轮 #7"],
  sources: [
    { title: "本机原型数据: copper-bacteria 配方结果 independent_probability 0.1", credibility: 1 },
    { title: "官方 wiki: Copper bacteria", url: "https://wiki.factorio.com/Copper_bacteria", credibility: 2 },
  ],
  surface: "gleba",
  gameSeconds: 240,
  async run(ctx) {
    const ref = await ctx.lua(PLACE);
    let bacteria = 0, spoilage = 0, finished = 0;
    for (let i = 0; i < 24; i++) {
      await ctx.ticks(600);
      const r = (await ctx.lua(COLLECT, { ref })) as { bacteria: number; spoilage: number; finished: number };
      bacteria += r.bacteria;
      spoilage += r.spoilage;
      finished = r.finished;
    }
    if (spoilage < 100) {
      return { verdict: "inconclusive", summary: `只出了 ${spoilage} 次结果, 样本太少 (生物室可能没开工)`, measured: { bacteria, spoilage, finished } };
    }
    const p = bacteria / spoilage;
    // 二项分布: n 次、p=0.1 时标准差 sqrt(n*0.09); 放宽到 4 个标准差
    const sd = Math.sqrt(spoilage * 0.09);
    const ok = Math.abs(bacteria - spoilage * 0.1) <= 4 * sd;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `出结果 ${spoilage} 次 (生物室完成 ${finished} 次, 含 +50% 产能), 出铜细菌 ${bacteria} 个, 比例 ${(p * 100).toFixed(1)}%`,
      measured: { bacteria, spoilage, finished, ratio: p },
    };
  },
};
