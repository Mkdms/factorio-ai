// 物流网第二批 (补到 10 条): 绿箱只给勾了"允许从主动存货箱取货"的蓝箱 (L4); 黄箱的存入顺序 (L5); 紫箱会被搬空进黄箱、红箱不会 (L2)。
// 场地: 标准 ±20 块, 一座机器人指令平台 + 10 个物流机器人, 供电走 ctx.power()。箱子按名字 + 位置找回。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

const CLEAR = `
local a = ...
for _, e in pairs(game.surfaces[a.surface].find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}}) do
  -- 保留电线杆和电源: 广域配电站的 type 是 electric-pole (substation 是名字); 写成 type ~= "substation" 把四根杆子全拆了, 机器人指令平台没网 (2026-11-01 探针抓到)
  if e.valid and e.type ~= "character" and e.type ~= "electric-pole" and e.type ~= "electric-energy-interface" then e.destroy() end
end`;

// chests: {key, name, dx, dy, item?, count?, filter?, request?, from_buffers?}
const SETUP = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local rp = lab.place{surface = s, name = "roboport", position = {a.x, a.y}, force = f}
rp.insert{name = "logistic-robot", count = 10}
local refs = {}
for _, c in ipairs(a.chests) do
  local e = lab.place{surface = s, name = c.name, position = {a.x + c.dx, a.y + c.dy}, force = f}
  if c.item and c.count then e.insert{name = c.item, count = c.count} end
  if c.filter then e.storage_filter = {name = c.filter} end
  if c.request then
    e.get_logistic_sections().add_section().set_slot(1, {value = {name = c.request, quality = "normal"}, min = c.amount or 30})
    if c.from_buffers ~= nil then e.request_from_buffers = c.from_buffers end
  end
  refs[c.key] = {name = e.name, x = e.position.x, y = e.position.y}
end
return refs`;

const COUNT = `
local a = ...
local r = {}
for key, ref in pairs(a.refs) do
  local e = game.surfaces[a.surface].find_entity(ref.name, {ref.x, ref.y})
  r[key] = e and e.get_inventory(defines.inventory.chest).get_item_count(a.item) or -1
end
return r`;

type Chest = { key: string; name: string; dx: number; dy: number; item?: string; count?: number; filter?: string; request?: string; amount?: number; from_buffers?: boolean };

async function trial(ctx: ExpContext, chests: Chest[], item = "iron-plate", seconds = 240) { // 没研究货仓的机器人一次只搬 1 件, 10 个机器人 60 秒只搬得动 40 件 (第一次跑被当成"推翻")
  await ctx.lua(CLEAR);
  const refs = await ctx.lua(SETUP, { chests });
  await ctx.ticks(300); // 机器人指令平台刚放下要先把自己的缓冲充满, 这几秒状态是 low_power (第一次跑被供电检查当成没电拦下, 2026-11-01)
  await ctx.powered();
  await ctx.ticks(seconds * 60);
  const counts = (await ctx.lua(COUNT, { refs, item })) as Record<string, number>;
  for (const c of chests) if (typeof counts?.[c.key] !== "number" || counts[c.key] < 0) throw new Error(`没读到 ${c.key}: ${JSON.stringify(counts)}`);
  return counts;
}

const WIKI = { title: "官方 wiki: Logistic network / Storage chest / Active provider chest", url: "https://wiki.factorio.com/Logistic_network", date: "2026-01-18", credibility: 2 as const };

export const bufferOnlyToOptedIn: Experiment = {
  id: "logistics.dispatch.buffer-only-to-opted-in-requesters",
  topic: "物流网",
  claim: "主动存货箱 (绿箱) 里的货只送给勾了\"允许从主动存货箱取货\"的优先集货箱 (蓝箱); 没勾的蓝箱只从黄箱 / 红箱 / 紫箱拿, 绿箱是唯一来源时它一块也拿不到",
  refs: ["logistics.md L4", "第三批 logistics.pickup.buffer-before-storage (当时蓝箱勾了)"],
  sources: [WIKI],
  gameSeconds: 500,
  async run(ctx) {
    await ctx.power();
    // 1. 只有绿箱供货: 没勾的蓝箱 A 拿不到, 勾了的 B 拿到
    const only = await trial(ctx, [
      { key: "green", name: "buffer-chest", dx: 0.5, dy: -8.5, item: "iron-plate", count: 100 },
      { key: "A", name: "requester-chest", dx: -6.5, dy: 8.5, request: "iron-plate", amount: 30, from_buffers: false },
      { key: "B", name: "requester-chest", dx: 7.5, dy: 8.5, request: "iron-plate", amount: 30, from_buffers: true },
    ]);
    // 2. 对照: 再加一个黄箱, 没勾的 A 从黄箱拿到
    const withStorage = await trial(ctx, [
      { key: "green", name: "buffer-chest", dx: 0.5, dy: -8.5, item: "iron-plate", count: 100 },
      { key: "yellow", name: "storage-chest", dx: -6.5, dy: -8.5, item: "iron-plate", count: 100 },
      { key: "A", name: "requester-chest", dx: -6.5, dy: 8.5, request: "iron-plate", amount: 30, from_buffers: false },
      { key: "B", name: "requester-chest", dx: 7.5, dy: 8.5, request: "iron-plate", amount: 30, from_buffers: true },
    ]);
    const ok = only.A === 0 && only.B === 30 && withStorage.A === 30 && withStorage.yellow <= 70;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `只有绿箱时: 没勾的蓝箱 ${only.A} 块, 勾了的 ${only.B} 块 (绿箱剩 ${only.green}); 加黄箱后: 没勾的蓝箱 ${withStorage.A} 块 (黄箱剩 ${withStorage.yellow}, 绿箱剩 ${withStorage.green})`,
      measured: { only, withStorage },
    };
  },
};

export const storageInsertOrder: Experiment = {
  id: "logistics.storage.insert-order",
  topic: "物流网",
  claim: "机器人往黄箱存货的顺序: 过滤匹配的黄箱 > 已有同种物品的黄箱 > 空的没过滤的黄箱 > 装着别的东西的没过滤的黄箱; 远近不优先",
  refs: ["logistics.md L5"],
  sources: [{ ...WIKI, title: "官方 wiki: Storage chest (存入顺序)", url: "https://wiki.factorio.com/Storage_chest" }],
  gameSeconds: 740,
  async run(ctx) {
    await ctx.power();
    const src: Chest = { key: "purple", name: "active-provider-chest", dx: 0.5, dy: -8.5, item: "iron-plate", count: 100 };
    const filter: Chest = { key: "filter", name: "storage-chest", dx: -12.5, dy: 10.5, filter: "iron-plate" }; // 最远
    const same: Chest = { key: "same", name: "storage-chest", dx: 6.5, dy: 8.5, item: "iron-plate", count: 20 };
    const empty: Chest = { key: "empty", name: "storage-chest", dx: 0.5, dy: 6.5 }; // 近
    const other: Chest = { key: "other", name: "storage-chest", dx: 0.5, dy: 4.5, item: "copper-plate", count: 20 }; // 最近
    const t1 = await trial(ctx, [src, filter, same, empty, other]);
    const t2 = await trial(ctx, [src, same, empty, other]);
    const t3 = await trial(ctx, [src, empty, other]);
    const ok = t1.filter === 100 && t1.same === 20 && t1.empty === 0 && t1.other === 0
      && t2.same === 120 && t2.empty === 0 && t2.other === 0
      && t3.empty === 100 && t3.other === 0;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `紫箱 100 块铁板: 四种黄箱都在时, 过滤箱 (最远) 收到 ${t1.filter}, 同种 ${t1.same - 20}, 空箱 ${t1.empty}, 杂物箱 (最近) ${t1.other}; 去掉过滤箱: 同种 +${t2.same - 20}, 空箱 ${t2.empty}, 杂物 ${t2.other}; 再去掉同种: 空箱 ${t3.empty}, 杂物箱 ${t3.other}`,
      measured: { t1, t2, t3 },
    };
  },
};

export const activeProviderEmptied: Experiment = {
  id: "logistics.active-provider.emptied-to-storage",
  topic: "物流网",
  claim: "没人请求时, 空闲的物流机器人会把主动供货箱 (紫箱) 搬空进黄箱; 被动供货箱 (红箱) 里的货原地不动",
  refs: ["logistics.md L2", "knowledge/patterns/case-friend-nauvis.md (朋友的火车卸货用红箱)"],
  sources: [{ ...WIKI, title: "官方 wiki: Active provider chest", url: "https://wiki.factorio.com/Active_provider_chest" }],
  gameSeconds: 250,
  async run(ctx) {
    await ctx.power();
    const r = await trial(ctx, [
      { key: "purple", name: "active-provider-chest", dx: -6.5, dy: -8.5, item: "iron-plate", count: 100 },
      { key: "red", name: "passive-provider-chest", dx: 7.5, dy: -8.5, item: "iron-plate", count: 100 },
      { key: "yellow", name: "storage-chest", dx: 0.5, dy: 8.5 },
    ]);
    const ok = r.purple === 0 && r.yellow === 100 && r.red === 100;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `240 秒后: 紫箱剩 ${r.purple}, 红箱剩 ${r.red}, 黄箱收到 ${r.yellow}`,
      measured: r,
    };
  },
};
