// 物流网取货顺序 (第一版教训 #1; 检索 logistics.md L1、L6)。
// 测法: 一座机器人指令平台 + 10 个物流机器人 + 电力接口; 一个优先集货箱 (蓝箱) 要 30 块铁板;
// 几种供货的箱子放在不同距离, 各装 100 块铁板; 跑 60 秒, 看铁板从哪个箱子被取走。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

const SETUP = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local function make(name, dx, dy) return s.create_entity{name = name, position = {a.x + dx, a.y + dy}, force = f} end
local rp = make("roboport", 0, 0)
make("electric-energy-interface", 4, 0)
make("medium-electric-pole", 2.5, -2.5)
rp.insert{name = "logistic-robot", count = 10}
local chests = {}
for _, c in ipairs(a.chests) do
  local e = make(c.name, c.dx, c.dy)
  e.insert{name = "iron-plate", count = 100}
  chests[c.key] = {name = e.name, x = e.position.x, y = e.position.y}
end
local req = make("requester-chest", 0.5, 8.5)
req.request_from_buffers = true
req.get_logistic_sections().add_section().set_slot(1, {value = {name = "iron-plate", quality = "normal"}, min = 30})
chests.requester = {name = req.name, x = req.position.x, y = req.position.y}
return chests`;

const COUNT = `
local a = ...
local r = {}
for key, ref in pairs(a.refs) do
  local e = game.surfaces[a.surface].find_entity(ref.name, {ref.x, ref.y})
  r[key] = e.get_inventory(defines.inventory.chest).get_item_count("iron-plate")
end
return r`;

type Chest = { key: string; name: string; dx: number; dy: number };

// 清掉实验区里的东西 (角色除外), 同一块地接着做对照组
const CLEAR = `
local a = ...
for _, e in pairs(game.surfaces[a.surface].find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}}) do
  if e.valid and e.type ~= "character" then e.destroy() end
end`;

const SECONDS = 60;

async function trial(ctx: ExpContext, chests: Chest[]) {
  await ctx.lua(CLEAR);
  const refs = await ctx.lua(SETUP, { chests });
  await ctx.ticks(SECONDS * 60);
  const counts = (await ctx.lua(COUNT, { refs })) as Record<string, number>;
  // 没读到数就不能下结论 (不能把"没读到"当成 0)
  for (const k of [...chests.map((c) => c.key), "requester"]) {
    if (typeof counts?.[k] !== "number") throw new Error(`没读到 ${k} 的数量: ${JSON.stringify(counts)} / refs ${JSON.stringify(refs)}`);
  }
  return counts;
}

const SOURCES: Experiment["sources"] = [
  { title: "官方 wiki: Logistic network (取货顺序)", url: "https://wiki.factorio.com/Logistic_network", date: "2026-01-18", credibility: 2 },
  { title: "游戏内提示与技巧 (本机中文语言文件): 紫箱 → 绿箱 → 黄箱 → 红箱", credibility: 1 },
];

export const activeProviderFirst: Experiment = {
  id: "logistics.pickup.active-provider-first",
  topic: "物流网",
  claim: "机器人取货先找主动供货箱 (紫箱), 不看远近: 30 格外的紫箱先于 1 格内的被动供货箱 (红箱) 被取",
  refs: ["lessons-v1 #1", "logistics.md L1", "logistics.md L2"],
  sources: SOURCES,
  gameSeconds: 60,
  async run(ctx) {
    const c = await trial(ctx, [
      { key: "active_far", name: "active-provider-chest", dx: -15.5, dy: -15.5 },
      { key: "passive_near", name: "passive-provider-chest", dx: 1.5, dy: 8.5 },
    ]);
    const tookActive = 100 - c.active_far, tookPassive = 100 - c.passive_near;
    const ok = c.requester >= 30 && tookActive >= 30 && tookPassive === 0;
    return {
      verdict: c.requester < 30 ? "inconclusive" : ok ? "verified" : "refuted",
      summary: `蓝箱收到 ${c.requester} 块: 远处紫箱 (约 30 格) 被取 ${tookActive} 块, 旁边红箱 (1 格) 被取 ${tookPassive} 块`,
      measured: c,
    };
  },
};

export const robotsIgnorePlainChests: Experiment = {
  id: "logistics.pickup.ignores-plain-chests",
  topic: "物流网",
  claim: "物流机器人不从普通箱 (钢箱) 取货: 蓝箱旁边 1 格的钢箱装满铁板, 机器人宁可去 15 格外的红箱拿; 只有钢箱时一块也不送",
  refs: ["requirements.md 物流网和火车 (2026-10-31 放宽)", "朋友的新地星基地: 车站两头用普通箱"],
  sources: [{ title: "官方 wiki: Logistic network (只有物流箱参与物流网)", url: "https://wiki.factorio.com/Logistic_network", credibility: 2 }],
  gameSeconds: 120,
  async run(ctx) {
    const c = await trial(ctx, [
      { key: "steel_near", name: "steel-chest", dx: 1.5, dy: 8.5 },
      { key: "passive_far", name: "passive-provider-chest", dx: -14.5, dy: 8.5 },
    ]);
    // 对照: 只有钢箱
    const k = await trial(ctx, [{ key: "steel_only", name: "steel-chest", dx: 1.5, dy: 8.5 }]);
    const summary = `钢箱 (1 格) 被取 ${100 - c.steel_near}, 红箱 (15 格) 被取 ${100 - c.passive_far}; 只有钢箱时蓝箱收到 ${k.requester}`;
    const ok = c.steel_near === 100 && c.requester >= 30 && k.requester === 0 && k.steel_only === 100;
    return { verdict: ok ? "verified" : "refuted", summary, measured: { main: c, control: k } };
  },
};

export const bufferBeforeStorage: Experiment = {
  id: "logistics.pickup.buffer-before-storage",
  topic: "物流网",
  claim: "取货时主动存货箱 (绿箱) 先于被动存货箱 (黄箱), 跨档不看远近 (游戏内提示的说法; 官方 wiki 写两者同档、按远近)",
  refs: ["logistics.md L1", "logistics.md L6", "research README 需要核实的分歧"],
  sources: SOURCES,
  gameSeconds: 120,
  async run(ctx) {
    // 主试: 绿箱放远 (15 格), 黄箱放近 (5 格); 蓝箱勾选了"从缓存箱请求"
    const c = await trial(ctx, [
      { key: "buffer_far", name: "buffer-chest", dx: -14.5, dy: 8.5 },
      { key: "storage_near", name: "storage-chest", dx: 5.5, dy: 8.5 },
      { key: "passive_nearest", name: "passive-provider-chest", dx: 1.5, dy: 8.5 },
    ]);
    // 对照: 绿箱放近、黄箱放远, 确认绿箱确实能给蓝箱供货 (不然主试没意义)
    const k = await trial(ctx, [
      { key: "buffer_near", name: "buffer-chest", dx: 5.5, dy: 8.5 },
      { key: "storage_far", name: "storage-chest", dx: -14.5, dy: 8.5 },
    ]);
    const b = 100 - c.buffer_far, s = 100 - c.storage_near, p = 100 - c.passive_nearest;
    const kb = 100 - k.buffer_near, ks = 100 - k.storage_far;
    const summary =
      `主试: 远处绿箱 (15 格) 被取 ${b}, 近处黄箱 (5 格) 被取 ${s}, 最近红箱 (1 格) 被取 ${p}; ` +
      `对照: 近处绿箱被取 ${kb}, 远处黄箱被取 ${ks}`;
    const measured = { main: c, control: k };
    if (kb < 30) return { verdict: "inconclusive", summary: summary + " → 对照组里绿箱没供货, 主试不能说明问题", measured };
    if (b >= 30 && s === 0) return { verdict: "verified", summary: summary + " → 游戏内提示对: 绿箱跨档优先", measured };
    if (s >= 30 && b === 0) return { verdict: "refuted", summary: summary + " → 黄箱和绿箱按远近取, 绿箱不跨档优先; 官方 wiki 的同档说法成立", measured };
    return { verdict: "inconclusive", summary, measured };
  },
};
