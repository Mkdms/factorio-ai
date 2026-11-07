// 物流网第三批 (补到 10 条): 机器人取货取最右一格、不看新鲜度 (L10); 机器人指令平台物流范围 25 (本机原型); 货运着陆平台排在红箱之后 (L1/L23); 两个平台的物流范围不重叠 = 两张网 (P-logi-03)。
// 没研究货仓的机器人一次只搬 1 件, 取货用 240 秒。供电走 ctx.power(); 清场只拆非电线杆 / 电源 (lab.md #35)。
import type { Experiment, ExpContext } from "../src/verify/types.ts";

const CLEAR = `
local a = ...
for _, e in pairs(game.surfaces[a.surface].find_entities_filtered{area = {{a.x - 40, a.y - 25}, {a.x + 40, a.y + 25}}}) do
  if e.valid and e.type ~= "character" and e.type ~= "electric-pole" and e.type ~= "electric-energy-interface" then e.destroy() end
end`;

const ROBOPORT = `
local a = ...
local s = game.surfaces[a.surface]
local rp = lab.place{surface = s, name = "roboport", position = {a.x + (a.dx or 0), a.y + (a.dy or 0)}, force = "player"}
local n = a.robots or 10
if n > 0 then rp.insert{name = "logistic-robot", count = n} end -- insert 0 个会报错 (第一次跑"count must be positive")
if a.label then lab.label(rp, a.label) end
return {x = rp.position.x, y = rp.position.y}`;

const CHEST = `
local a = ...
local s = game.surfaces[a.surface]
local e = lab.place{surface = s, name = a.name, position = {a.x + a.dx, a.y + a.dy}, force = "player"}
if a.label then lab.label(e, a.label) end
if a.request then e.get_logistic_sections().add_section().set_slot(1, {value = {name = a.request, quality = "normal"}, min = a.amount or 30}) end
local inv = e.get_inventory(defines.inventory.chest) or e.get_inventory(defines.inventory.cargo_landing_pad_main)
if a.slots then
  for i, slot in ipairs(a.slots) do
    inv[i].set_stack{name = slot.item, count = slot.count}
    if slot.spoil then inv[i].spoil_percent = slot.spoil end
  end
elseif a.item then e.insert{name = a.item, count = a.count} end
return {name = e.name, x = e.position.x, y = e.position.y}`;

const READ = `
local a = ...
local s = game.surfaces[a.surface]
local e = s.find_entity(a.ref.name, {a.ref.x, a.ref.y})
if not e then return nil end
local inv = e.get_inventory(defines.inventory.chest) or e.get_inventory(defines.inventory.cargo_landing_pad_main)
local st = inv.find_item_stack(a.item)
return {count = inv.get_item_count(a.item), spoil = st and st.spoil_percent or nil}`;

async function ready(ctx: ExpContext) { await ctx.ticks(60); await ctx.powered(); }

export const pickupRightmostSlot: Experiment = {
  id: "logistics.pickup.rightmost-slot-first",
  topic: "物流网",
  claim: "物流机器人从箱子取货取最右边的那一格, 不看新鲜度: 红箱第 1 格放新鲜玉玛果、第 2 格放腐坏 50% 的, 送到蓝箱的是腐坏的那批 (旧货容易烂在缓冲箱里)",
  refs: ["logistics.md L10", "knowledge/patterns/logistics-choice.md P-logi-05 (会腐坏的东西不囤)"],
  sources: [{ title: "官方论坛 (机器人不看新鲜度, 先取最右一格)", url: "https://forums.factorio.com/viewtopic.php?p=701792", date: "2025-09 ~ 2026-08", credibility: 3 }],
  gameSeconds: 250,
  async run(ctx) {
    await ctx.power();
    await ctx.lua(CLEAR);
    await ctx.lua(ROBOPORT);
    await ctx.lua(CHEST, { name: "passive-provider-chest", dx: 0.5, dy: -8.5, slots: [{ item: "yumako", count: 10, spoil: 0 }, { item: "yumako", count: 10, spoil: 0.5 }] });
    const req = await ctx.lua(CHEST, { name: "requester-chest", dx: 0.5, dy: 8.5, request: "yumako", amount: 10 });
    await ready(ctx);
    await ctx.ticks(240 * 60);
    const r = (await ctx.lua(READ, { ref: req, item: "yumako" })) as { count: number; spoil: number | null } | null;
    if (!r || r.count < 10 || r.spoil === null) return { verdict: "inconclusive", summary: `蓝箱只收到 ${r?.count ?? "?"} 个`, measured: { r } };
    const fromSlot2 = r.spoil > 0.45;
    return {
      verdict: fromSlot2 ? "verified" : "refuted",
      summary: `蓝箱收到 ${r.count} 个玉玛果, 腐坏 ${(r.spoil * 100).toFixed(0)}% → 来自${fromSlot2 ? "第 2 格 (腐坏的那批)" : "第 1 格 (新鲜的那批)"}`,
      measured: { r },
    };
  },
};

export const roboportLogisticsRange: Experiment = {
  id: "logistics.roboport.logistics-range-25",
  topic: "物流网",
  claim: "机器人指令平台的物流范围是以它为中心半边长 25 的方块 (50×50): 蓝箱在 24 格处能收到货, 在 27 格处收不到 (不在网里)",
  refs: ["本机原型 roboport logistics_radius 25 / construction_radius 55", "src/blueprint/inspect.ts (检查器用 25)"],
  sources: [{ title: "本机原型: roboport logistics_radius 25", credibility: 1 }],
  gameSeconds: 250,
  async run(ctx) {
    ctx.watch([[ctx.x - 40, ctx.y - 25], [ctx.x + 40, ctx.y + 25]]);
    await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area: [[ctx.x - 40, ctx.y - 25], [ctx.x + 40, ctx.y + 25]], no_enemies: true }, { timeoutMs: 120_000 });
    await ctx.power();
    await ctx.lua(ROBOPORT);
    await ctx.lua(CHEST, { name: "passive-provider-chest", dx: 0.5, dy: -6.5, item: "iron-plate", count: 100 });
    const near = await ctx.lua(CHEST, { name: "requester-chest", dx: 24.5, dy: 0.5, request: "iron-plate", amount: 30 });
    const far = await ctx.lua(CHEST, { name: "requester-chest", dx: -27.5, dy: 0.5, request: "iron-plate", amount: 30, label: "对照: 27 格, 故意放在范围外" });
    await ctx.say("左边 27 格外的蓝箱是对照组, 故意放在物流范围外 (应该收不到货)");
    await ready(ctx);
    await ctx.ticks(240 * 60);
    const n = (await ctx.lua(READ, { ref: near, item: "iron-plate" })) as { count: number } | null;
    const f = (await ctx.lua(READ, { ref: far, item: "iron-plate" })) as { count: number } | null;
    if (!n || !f) return { verdict: "inconclusive", summary: "没读到箱子", measured: { n, f } };
    const ok = n.count === 30 && f.count === 0;
    return { verdict: ok ? "verified" : "refuted", summary: `24 格处的蓝箱收到 ${n.count}, 27 格处的收到 ${f.count}`, measured: { n, f } };
  },
};

export const landingPadAfterPassive: Experiment = {
  id: "logistics.pickup.landing-pad-after-passive",
  topic: "物流网",
  claim: "货运着陆平台作为货源排在红箱之后: 平台就在蓝箱旁边、红箱在 20 格外, 机器人仍先去红箱取 (第一轮被推翻: 先取了平台; 加对照 平台远、红箱近 分清是\"和红箱同档按远近\"还是\"平台优先\")",
  refs: ["logistics.md L1 (物流接驳站列在红箱之后)", "logistics.md L23"],
  sources: [{ title: "官方 wiki: Logistic network / Cargo landing pad", url: "https://wiki.factorio.com/Cargo_landing_pad", date: "2026", credibility: 2 }],
  gameSeconds: 250,
  async run(ctx) {
    await ctx.power();
    await ctx.lua(CLEAR);
    await ctx.lua(ROBOPORT, { dx: 0, dy: -12 });
    const pad = await ctx.lua(CHEST, { name: "cargo-landing-pad", dx: 0, dy: 8, item: "iron-plate", count: 100 });
    const red = await ctx.lua(CHEST, { name: "passive-provider-chest", dx: 18.5, dy: -12.5, item: "iron-plate", count: 100 });
    const req = await ctx.lua(CHEST, { name: "requester-chest", dx: -6.5, dy: 8.5, request: "iron-plate", amount: 30 });
    await ready(ctx);
    await ctx.ticks(240 * 60);
    const p = (await ctx.lua(READ, { ref: pad, item: "iron-plate" })) as { count: number } | null;
    const r = (await ctx.lua(READ, { ref: red, item: "iron-plate" })) as { count: number } | null;
    const q = (await ctx.lua(READ, { ref: req, item: "iron-plate" })) as { count: number } | null;
    if (!p || !r || !q || q.count < 30) return { verdict: "inconclusive", summary: `蓝箱只收到 ${q?.count ?? "?"} 个 (平台剩 ${p?.count}, 红箱剩 ${r?.count})`, measured: { p, r, q } };
    // 对照: 红箱挪到蓝箱旁边, 平台不动 (这时平台比红箱远)
    await ctx.lua(CLEAR);
    await ctx.lua(ROBOPORT, { dx: 0, dy: -12 });
    const pad2 = await ctx.lua(CHEST, { name: "cargo-landing-pad", dx: 0, dy: 8, item: "iron-plate", count: 100 });
    const red2 = await ctx.lua(CHEST, { name: "passive-provider-chest", dx: -14.5, dy: 14.5, item: "iron-plate", count: 100, label: "对照: 红箱挪到蓝箱旁边" });
    const req2 = await ctx.lua(CHEST, { name: "requester-chest", dx: -14.5, dy: 12.5, request: "iron-plate", amount: 30 });
    await ready(ctx);
    await ctx.ticks(240 * 60);
    const p2 = (await ctx.lua(READ, { ref: pad2, item: "iron-plate" })) as { count: number } | null;
    const r2 = (await ctx.lua(READ, { ref: red2, item: "iron-plate" })) as { count: number } | null;
    const after = r.count === 70 && p.count === 100; // 说法成立的样子
    const sameTier = p.count === 70 && r2 && r2.count === 70 && p2 && p2.count === 100; // 和红箱同档、按远近
    const padFirst = p.count === 70 && p2 && p2.count === 70; // 平台总是先被取
    return {
      verdict: after ? "verified" : "refuted",
      summary: `平台在蓝箱旁、红箱 20 格外: 平台被取 ${100 - p.count}、红箱 ${100 - r.count}; 对照 红箱在蓝箱旁、平台远: 平台被取 ${p2 ? 100 - p2.count : "?"}、红箱 ${r2 ? 100 - r2.count : "?"} → ${after ? "平台排在红箱之后" : sameTier ? "平台和红箱同一档, 按远近取" : padFirst ? "平台比红箱优先" : "看不出规律"}`,
      measured: { p, r, q, p2, r2 },
    };
  },
};

export const separateNetworks: Experiment = {
  id: "logistics.network.separate-when-ranges-dont-overlap",
  topic: "物流网",
  claim: "两个机器人指令平台的物流范围不重叠就是两张独立的网 (相距 60 格, 各自半边长 25): 红箱在甲网、蓝箱在乙网, 一块也送不过去; 挪到范围重叠 (相距 40 格) 就是一张网, 照常送",
  refs: ["knowledge/patterns/logistics-choice.md P-logi-03 (机器人网怎么分区)", "logistics.md L3"],
  sources: [{ title: "官方 wiki: Logistic network (networks merge when roboport areas overlap)", url: "https://wiki.factorio.com/Logistic_network", date: "2026-01-18", credibility: 2 }],
  gameSeconds: 500,
  async run(ctx) {
    const area: [[number, number], [number, number]] = [[ctx.x - 45, ctx.y - 25], [ctx.x + 45, ctx.y + 25]];
    ctx.watch(area);
    const results: Record<string, number> = {};
    for (const gap of [60, 40]) {
      await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area, no_enemies: true }, { timeoutMs: 120_000 });
      await ctx.power();
      await ctx.lab.rpc("power_area", { surface: ctx.surface, area: [[ctx.x - 45, ctx.y - 6], [ctx.x + 45, ctx.y + 6]], inset: 6 });
      await ctx.lua(ROBOPORT, { dx: -gap / 2, dy: 0 });
      await ctx.lua(ROBOPORT, { dx: gap / 2, dy: 0, robots: 0, label: gap === 60 ? "对照: 和左边的平台范围不重叠" : "范围和左边重叠 10 格" });
      await ctx.lua(CHEST, { name: "passive-provider-chest", dx: -gap / 2 + 0.5, dy: -4.5, item: "iron-plate", count: 100 });
      const req = await ctx.lua(CHEST, { name: "requester-chest", dx: gap / 2 + 0.5, dy: -4.5, request: "iron-plate", amount: 30 });
      await ready(ctx);
      await ctx.ticks(240 * 60);
      const q = (await ctx.lua(READ, { ref: req, item: "iron-plate" })) as { count: number } | null;
      if (!q) return { verdict: "inconclusive", summary: "没读到蓝箱", measured: results };
      results[`gap${gap}`] = q.count;
    }
    const ok = results.gap60 === 0 && results.gap40 === 30;
    return { verdict: ok ? "verified" : "refuted", summary: `相距 60 格 (范围不重叠): 蓝箱收到 ${results.gap60}; 相距 40 格 (重叠 10 格): 收到 ${results.gap40}`, measured: results };
  },
};
