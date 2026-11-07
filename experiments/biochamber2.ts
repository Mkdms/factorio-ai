// 生物室第三批 (补到 10 条): 生物结晶制营养素 1:12、铁细菌培养的产能对 4 个全算 (G17)、五足虫卵繁殖的产能只算净增的 1 个 (G8)、生物室不用电。
// 量法: 原料定量直接塞进原料槽, 每 0.5 秒把输出槽清空记数 (不靠出料机械臂: 没研究时一次只抓 1 个, 输出槽会堵); 不用 products_finished (产能白送的也算一次, lab.md #19)。
// 期望值从配方原型 (产物数、不吃产能的数) 和机器的产能加成读, 不手填。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

const SETUP = `
local a = ...
local s = game.surfaces[a.surface]
game.forces.player.recipes[a.recipe].enabled = true
local b = lab.place{surface = s, name = "biochamber", position = {a.x + a.dx + 0.5, a.y + 0.5}, force = "player"}
b.set_recipe(a.recipe)
if a.fuel > 0 then b.get_fuel_inventory().insert{name = "nutrients", count = a.fuel} end
local inv = b.get_inventory(defines.inventory.crafter_input)
for _, it in ipairs(a.inputs) do
  local n = inv.insert{name = it.name, count = it.count}
  if n ~= it.count then error(it.name .. " 只塞进 " .. n .. "/" .. it.count, 0) end
end
local water
if a.water then
  for _, c in ipairs(lab.connections(b)) do if c.dir ~= "output" and not water then water = c end end
  if not water then error("生物室没有能进水的接口", 0) end
  local ip = lab.place{surface = s, name = "infinity-pipe", position = {water.tx, water.ty}, force = "player"}
  ip.set_infinity_pipe_filter{name = "water", percentage = 1, mode = "at-least"}
end
if a.label then lab.label(b, a.label) end
-- 期望: 每次出 amount 个, 其中 ignored 个不吃产能; 机器产能加成
local r = prototypes.recipe[a.recipe]
local prod = {}
for _, p in ipairs(r.products) do prod[#prod + 1] = {name = p.name, amount = p.amount, ignored = p.ignored_by_productivity or 0} end
return {b = {x = b.position.x, y = b.position.y}, products = prod, productivity = b.productivity_bonus, energy = b.prototype.burner_prototype and "burner" or (b.prototype.electric_energy_source_prototype and "electric" or "other"), water = water}`;

// 清空输出槽并记数; 顺带读状态、剩余原料、燃料、产能进度条
const DRAIN = `
local a = ...
local b = game.surfaces[a.surface].find_entity("biochamber", {a.b.x, a.b.y})
if not b then error("找不到生物室", 0) end
local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
local out = b.get_output_inventory()
local got = {}
for _, it in pairs(out.get_contents()) do got[it.name] = (got[it.name] or 0) + it.count end
out.clear()
local left = 0
for _, it in pairs(b.get_inventory(defines.inventory.crafter_input).get_contents()) do left = left + it.count end
return {got = got, left = left, fuel = b.get_fuel_inventory().get_item_count("nutrients"), status = names[b.status],
        progress = b.crafting_progress, bonus = b.bonus_progress, net = b.electric_network_id or -1}`;

interface Setup { b: { x: number; y: number }; products: { name: string; amount: number; ignored: number }[]; productivity: number; energy: string }
interface Drain { got: Record<string, number>; left: number; fuel: number; status: string; progress: number; bonus: number; net: number }

// 跑到原料吃完、手上没有在做的为止 (或超时), 累计输出
async function runOut(ctx: ExpContext, s: Setup, maxSeconds: number) {
  const total: Record<string, number> = {};
  let last: Drain | null = null;
  for (let t = 0; t < maxSeconds * 60; t += 30) {
    await ctx.ticks(30);
    last = (await ctx.lua(DRAIN, { b: s.b })) as Drain;
    for (const [k, v] of Object.entries(last.got ?? {})) total[k] = (total[k] ?? 0) + v;
    if (last.left === 0 && last.progress === 0) break;
  }
  return { total, last: last! };
}

const expected = (s: Setup, crafts: number, name: string) => {
  const p = s.products.find((x) => x.name === name)!;
  // 产能进度条每次加 productivity, 满 1 白送一次"吃产能的那部分"; 次数取整
  const bonusCrafts = Math.floor(crafts * s.productivity + 1e-9);
  return { base: crafts * p.amount, bonus: bonusCrafts * (p.amount - p.ignored), total: crafts * p.amount + bonusCrafts * (p.amount - p.ignored), perCraft: p.amount + s.productivity * (p.amount - p.ignored) };
};

export const biofluxToNutrients: Experiment = {
  id: "biochamber.nutrients-from-bioflux.one-to-twelve",
  topic: "生物室",
  claim: "生物结晶制营养素: 5 个生物结晶出 40 个营养素, 加上生物室固有的 +50% 产能平均出 60 个, 也就是 1 个生物结晶换 12 个营养素",
  refs: ["gleba.md 本机速查 (生物室自带 +50% 产能)", "knowledge/patterns/planets.md 句芒 (营养素从生物结晶来)"],
  sources: [{ title: "本机原型: recipe.lua nutrients-from-bioflux 5 生物结晶 → 40 营养素; biochamber base_effect productivity 0.5", credibility: 1 }],
  surface: "gleba",
  gameSeconds: 30,
  async run(ctx) {
    const crafts = 10;
    const s = (await ctx.lua(SETUP, { dx: 0, recipe: "nutrients-from-bioflux", fuel: 20, inputs: [{ name: "bioflux", count: 5 * crafts }] })) as Setup;
    await ctx.powered();
    const { total, last } = await runOut(ctx, s, 60);
    const e = expected(s, crafts, "nutrients");
    const got = total["nutrients"] ?? 0;
    const ratio = got / (5 * crafts);
    const measured = { crafts, got, expected: e, ratio, productivity: s.productivity, last };
    if (last.left !== 0) return { verdict: "inconclusive", summary: `60 秒内原料没吃完 (还剩 ${last.left}, 状态 ${last.status})`, measured };
    return {
      verdict: got === e.total && Math.abs(ratio - 12) < 1e-9 ? "verified" : "refuted",
      summary: `${5 * crafts} 个${ctx.zh("bioflux")}做了 ${crafts} 次, 出 ${got} 个${ctx.zh("nutrients")} (配方 ${e.base} + 产能白送 ${e.bonus}; 机器产能 +${(s.productivity * 100).toFixed(0)}%), 1 个换 ${ratio.toFixed(2)} 个`,
      measured,
    };
  },
};

export const bacteriaProductivityFull: Experiment = {
  id: "biochamber.bacteria-cultivation.productivity-on-all-four",
  topic: "生物室",
  claim: "铁细菌培养 (1 铁细菌 + 1 生物结晶 → 4 铁细菌): 生物室 +50% 产能对 4 个全部生效, 平均每次出 6 个, 不是只对净增的 3 个 (那样是 5.5 个)",
  refs: ["gleba.md G17 (生物室 +50% 对 4 个全部生效)", "README 第二轮待核实 #7 (产能对培养是否全算)"],
  sources: [
    { title: "官方 wiki: Copper bacteria / Iron bacteria", url: "https://wiki.factorio.com/Copper_bacteria", credibility: 2 },
    { title: "本机原型: recipe.lua iron-bacteria-cultivation 产物 4 个, 没有 ignored_by_productivity", credibility: 1 },
  ],
  surface: "gleba",
  gameSeconds: 40,
  async run(ctx) {
    const crafts = 10;
    const s = (await ctx.lua(SETUP, { dx: 0, recipe: "iron-bacteria-cultivation", fuel: 20, inputs: [{ name: "iron-bacteria", count: crafts }, { name: "bioflux", count: crafts }] })) as Setup;
    await ctx.powered();
    const { total, last } = await runOut(ctx, s, 60);
    const e = expected(s, crafts, "iron-bacteria");
    // 铁细菌 1 分钟变回铁矿: 输出里变质的也算进产量
    const got = (total["iron-bacteria"] ?? 0) + (total["iron-ore"] ?? 0);
    const netOnly = crafts * 4 + Math.floor(crafts * s.productivity + 1e-9) * 3;
    const measured = { crafts, got, total, expected: e, netOnly, ignored: s.products[0]?.ignored, last };
    if (last.left !== 0) return { verdict: "inconclusive", summary: `60 秒内原料没吃完 (还剩 ${last.left}, 状态 ${last.status})`, measured };
    return {
      verdict: got === e.total && e.total !== netOnly ? "verified" : got === netOnly ? "refuted" : "inconclusive",
      summary: `做了 ${crafts} 次, 出 ${got} 个${ctx.zh("iron-bacteria")} (含变回${ctx.zh("iron-ore")}的 ${total["iron-ore"] ?? 0} 个), 平均每次 ${(got / crafts).toFixed(2)} 个; 产能对 4 个全算应是 ${e.total}, 只算净增 3 个应是 ${netOnly}`,
      measured,
    };
  },
};

export const eggProductivityNetOnly: Experiment = {
  id: "biochamber.pentapod-egg.productivity-net-only",
  topic: "生物室",
  claim: "五足虫卵繁殖是催化配方 (1 五足虫卵 + 30 营养素 + 60 水 → 2 五足虫卵, 其中 1 个不吃产能): 生物室 +50% 产能只加在净增的那 1 个上, 平均每次出 2.5 个",
  refs: ["gleba.md G8 (产能只加在净增的 1 个上, 平均 2.5 个)"],
  sources: [
    { title: "官方论坛: 五足虫卵产能", url: "https://forums.factorio.com/viewtopic.php?p=656615", date: "2024-12", credibility: 3 },
    { title: "本机原型: recipe.lua pentapod-egg 产物 2 个, ignored_by_productivity = 1", credibility: 1 },
  ],
  surface: "gleba",
  gameSeconds: 60,
  async run(ctx) {
    const crafts = 4;
    const s = (await ctx.lua(SETUP, { dx: 0, recipe: "pentapod-egg", fuel: 20, water: true, inputs: [{ name: "pentapod-egg", count: crafts }, { name: "nutrients", count: 30 * crafts }] })) as Setup;
    await ctx.powered();
    const { total, last } = await runOut(ctx, s, 90);
    const e = expected(s, crafts, "pentapod-egg");
    const got = total["pentapod-egg"] ?? 0;
    const allCount = crafts * 2 + Math.floor(crafts * s.productivity + 1e-9) * 2;
    const measured = { crafts, got, total, expected: e, allCount, ignored: s.products[0]?.ignored, last };
    if (last.left !== 0) return { verdict: "inconclusive", summary: `90 秒内原料没吃完 (还剩 ${last.left}, 状态 ${last.status}; 水接上了吗)`, measured };
    return {
      verdict: got === e.total && e.total !== allCount ? "verified" : got === allCount ? "refuted" : "inconclusive",
      summary: `做了 ${crafts} 次 (吃掉 ${crafts} 个卵), 出 ${got} 个${ctx.zh("pentapod-egg")}, 平均每次 ${(got / crafts).toFixed(2)} 个; 只算净增 1 个应是 ${e.total}, 2 个全算应是 ${allCount}`,
      measured,
    };
  },
};

export const biochamberNoElectricity: Experiment = {
  id: "biochamber.no-electricity.burns-nutrients",
  topic: "生物室",
  claim: "生物室不用电, 只烧营养素: 不接任何电网也照常开工; 燃料槽里没有营养素就停 (状态\"没燃料\")",
  refs: ["gleba.md 本机速查 (生物室烧营养素 500kW)", "lessons-v1 #6 (生物室自举)"],
  sources: [{ title: "本机原型: biochamber energy_source type = burner, fuel_categories = nutrients", credibility: 1 }],
  surface: "gleba",
  gameSeconds: 30,
  allowStatus: ["no_fuel"], // 对照组故意不给营养素
  async run(ctx) {
    // 两台, 场地里不放任何电线杆和电源: 西边的有营养素, 东边的故意不给 (对照)
    const fed = (await ctx.lua(SETUP, { dx: -4, recipe: "yumako-processing", fuel: 10, inputs: [{ name: "yumako", count: 20 }], label: "有营养素, 不接电" })) as Setup;
    const dry = (await ctx.lua(SETUP, { dx: 4, recipe: "yumako-processing", fuel: 0, inputs: [{ name: "yumako", count: 20 }], label: "故意不给营养素 (对照)" })) as Setup;
    await ctx.say("两台生物室都不接电: 左边给了营养素, 右边故意不给 (对照); 10 秒后看谁在干活");
    await ctx.powered();
    const poles = (await ctx.lua(`local a = ... return #game.surfaces[a.surface].find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, type = {"electric-pole", "electric-energy-interface"}}`)) as number;
    const mash = { fed: 0, dry: 0 };
    let fedEnd: Drain | null = null, dryEnd: Drain | null = null;
    for (let t = 0; t < 10 * 60; t += 30) {
      await ctx.ticks(30);
      fedEnd = (await ctx.lua(DRAIN, { b: fed.b })) as Drain;
      dryEnd = (await ctx.lua(DRAIN, { b: dry.b })) as Drain;
      mash.fed += fedEnd.got["yumako-mash"] ?? 0;
      mash.dry += dryEnd.got["yumako-mash"] ?? 0;
    }
    const measured = { energy: fed.energy, poles, mash, fedEnd, dryEnd };
    const ok = fed.energy === "burner" && poles === 0 && fedEnd!.net === -1 && mash.fed > 0 && fedEnd!.fuel < 10 && mash.dry === 0 && dryEnd!.status === "no_fuel";
    return {
      verdict: ok ? "verified" : mash.fed === 0 && poles === 0 ? "refuted" : "inconclusive",
      summary: `能源类型 ${fed.energy}, 场地里电线杆和电源 ${poles} 个; 有营养素的那台 10 秒出 ${mash.fed} 个${ctx.zh("yumako-mash")} (营养素 10 → ${fedEnd!.fuel}, 不在任何电网: ${fedEnd!.net === -1}); 不给营养素的那台出 ${mash.dry} 个, 状态 ${dryEnd!.status}`,
      measured,
    };
  },
};
