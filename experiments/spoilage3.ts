// 腐坏第三批 (补到 10 条): 机械臂"腐坏优先"只在从容器取货时有效 (L21); 果泥 3 分钟、果冻 4 分钟 (本机原型); 变质物能当燃料 250kJ (本机原型);
// 变质了的原料堵住机器输入槽, 不带过滤的出料臂会顺手把它清掉 (G12)。
import type { Experiment } from "../src/verify/types.ts";

const SPOIL_PRIORITY = `
local a = ...
local s = game.surfaces[a.surface]
local d = defines.direction
local f = "player"
-- A: 箱子 (第 1 格新鲜、第 2 格腐坏 50%) → 机械臂 (腐坏优先) → 箱子
local src = lab.place{surface = s, name = "steel-chest", position = {a.x - 6.5, a.y - 4.5}, force = f}
local inv = src.get_inventory(defines.inventory.chest)
inv[1].set_stack{name = "yumako", count = 20} inv[1].spoil_percent = 0
inv[2].set_stack{name = "yumako", count = 20} inv[2].spoil_percent = 0.5
local insA = lab.place{surface = s, name = "fast-inserter", position = {a.x - 5.5, a.y - 4.5}, direction = d.west, force = f}
local dstA = lab.place{surface = s, name = "steel-chest", position = {a.x - 4.5, a.y - 4.5}, force = f}
-- B: 一段带子上交替放新鲜 / 腐坏的果 → 机械臂 (腐坏优先) → 箱子; 机械臂和箱子挨着带子尽头放, 位置用 lab.slots 算 (第一次手写坐标偏了一格, 机械臂对着空地)
local function belt_row(y, label)
  local row = {}
  for i = 0, 7 do row[#row + 1] = lab.place{surface = s, name = "transport-belt", position = {a.x - 6.5 + i, y}, direction = d.east, force = f} end
  local last = row[#row]
  local ins = lab.place{surface = s, name = "fast-inserter", position = lab.slots(last, "north")[1], direction = d.south, force = f}
  lab.place{surface = s, name = "steel-chest", position = lab.slots(last, "north", 2)[1], force = f}
  lab.label(ins, label)
  return row, ins
end
local belts, insB = belt_row(a.y + 4.5, "腐坏优先")
local belts2, insB2 = belt_row(a.y + 10.5, "对照: 不设优先")
local last, last2 = belts[#belts], belts2[#belts2]
-- 设腐坏优先 (API 文件 2.1.24: LuaEntity::inserter_spoil_priority, 取值 "fresh-first" / "none" / "spoiled-first"), 设完读回核对
insA.inserter_spoil_priority = "spoiled-first"
insB.inserter_spoil_priority = "spoiled-first"
insB2.inserter_spoil_priority = "none"
local how = tostring(insA.inserter_spoil_priority) .. "/" .. tostring(insB.inserter_spoil_priority) .. "/" .. tostring(insB2.inserter_spoil_priority)
-- 带子: 靠尽头的第 7、8 格放 8 个新鲜的 (走在前面), 第 5、6 格放 8 个腐坏 50% 的 (跟在后面); 每格一道 4 个, 用 insert_at 指定位置
-- (insert_at_back 只在队尾有空时成功, 连塞只进 1 个, 第一次跑的教训); 用带腐坏进度的物品堆塞 (表格式会丢掉 spoil_percent)
local tmp = game.create_inventory(1)
local n = 0
local function put(belt, spoil)
  local line = belt.get_transport_line(1)
  for _, pos in ipairs({0.125, 0.375, 0.625, 0.875}) do
    tmp[1].set_stack{name = "yumako", count = 1}
    tmp[1].spoil_percent = spoil
    if line.insert_at(pos, tmp[1]) then n = n + 1 end
  end
end
put(belts[7], 0) put(belts[8], 0) put(belts[5], 0.5) put(belts[6], 0.5)
put(belts2[7], 0) put(belts2[8], 0) put(belts2[5], 0.5) put(belts2[6], 0.5)
tmp.destroy()
return {how = how, placed_on_belt = n, src = {x = src.position.x, y = src.position.y}, last = {x = last.position.x, y = last.position.y}, last2 = {x = last2.position.x, y = last2.position.y}, belts = #belts, x0 = belts[1].position.x}`;

// 看源头剩下的: 箱子里两格各剩几个 (箱子不会把两格合并); 带子上剩下的每个物品的腐坏进度
const SPOIL_READ = `
local a = ...
local s = game.surfaces[a.surface]
local c = s.find_entity("steel-chest", {a.r.src.x, a.r.src.y})
local inv = c.get_inventory(defines.inventory.chest)
local A = {fresh = 0, spoiled = 0}
for i = 1, #inv do
  local st = inv[i]
  if st.valid_for_read and st.name == "yumako" then
    if st.spoil_percent > 0.4 then A.spoiled = A.spoiled + st.count else A.fresh = A.fresh + st.count end
  end
end
local function on_belts(y)
  local B = {fresh = 0, spoiled = 0}
  for _, b in pairs(s.find_entities_filtered{area = {{a.r.x0 - 1, y - 0.5}, {a.r.last.x + 1, y + 0.5}}, type = "transport-belt"}) do
    for lane = 1, 2 do
      local line = b.get_transport_line(lane)
      for i = 1, #line do
        local st = line[i]
        if st.valid_for_read and st.name == "yumako" then
          if st.spoil_percent > 0.4 then B.spoiled = B.spoiled + st.count else B.fresh = B.fresh + st.count end
        end
      end
    end
  end
  return B
end
return {A = A, B = on_belts(a.r.last.y), B2 = on_belts(a.r.last2.y)}`;

export const spoiledFirstOnlyFromContainers: Experiment = {
  id: "spoilage.inserter.spoiled-first-only-from-containers",
  topic: "腐坏",
  claim: "机械臂的\"腐坏优先\"只在从容器取货时生效: 从箱子取时先拿腐坏的那批 (腐坏的先被拿光, 新鲜的原样剩着); 从传送带取时拿到什么是什么 (先到跟前的新鲜果被拿走, 后面腐坏的剩在带上)",
  refs: ["logistics.md L21", "knowledge/patterns/production.md P-prod-19 (垃圾槽 / 变质物处理)"],
  sources: [{ title: "官方 wiki: Spoilage mechanics (inserter spoil priority)", url: "https://wiki.factorio.com/Spoilage_mechanics", date: "2026-10-15", credibility: 2 }],
  gameSeconds: 30,
  async run(ctx) {
    await ctx.power();
    const r = (await ctx.lua(SPOIL_PRIORITY)) as { how: string; placed_on_belt: number; dstA: { x: number; y: number }; dstB: { x: number; y: number } };
    await ctx.powered();
    if (r.how !== "spoiled-first/spoiled-first/none") return { verdict: "inconclusive", summary: `腐坏优先没设上 (读回 ${r.how})`, measured: r };
    if (r.placed_on_belt < 32) return { verdict: "inconclusive", summary: `带子上只放上 ${r.placed_on_belt}/32 个`, measured: r };
    // 搬 2.5 秒: 箱子那边约 17 个 (腐坏的 20 个还没拿完); 带子那边新鲜的已经在尽头, 约拿 8 个上下 (看拿的是不是全是新鲜的)
    await ctx.ticks(150); // 7 秒时带子上 16 个全被拿光, 看不出先后 (第三轮); 改成 2.5 秒, 两边都只拿走一部分
    type C = { fresh: number; spoiled: number };
    const s = (await ctx.lua(SPOIL_READ, { r })) as { A: C; B: C; B2: C };
    const takenA = { fresh: 20 - s.A.fresh, spoiled: 20 - s.A.spoiled }, takenB = { fresh: 8 - s.B.fresh, spoiled: 8 - s.B.spoiled }, takenB2 = { fresh: 8 - s.B2.fresh, spoiled: 8 - s.B2.spoiled };
    if (takenA.fresh + takenA.spoiled < 3 || takenB.fresh + takenB.spoiled < 3 || takenB2.fresh + takenB2.spoiled < 3) return { verdict: "inconclusive", summary: `搬得太少: 箱子 ${takenA.fresh + takenA.spoiled}, 带子 ${takenB.fresh + takenB.spoiled} / ${takenB2.fresh + takenB2.spoiled}`, measured: { r, s } };
    const aOk = takenA.spoiled > 0 && (takenA.fresh === 0 || takenA.spoiled === 20); // 箱子: 腐坏的拿完之前一个新鲜的都不拿
    // 带子: 设了腐坏优先和不设的对照拿得一样 (差不超过 1 个) → 对带子无效; 设了的明显多拿腐坏的 → 对带子也有效 (说法被推翻)
    const beltSame = Math.abs(takenB.spoiled - takenB2.spoiled) <= 1;
    return {
      verdict: aOk && beltSame ? "verified" : "refuted",
      summary: `搬 2.5 秒: 箱子 (腐坏优先) 拿了腐坏 ${takenA.spoiled} / 新鲜 ${takenA.fresh}; 带子 (新鲜的在前) 设腐坏优先的拿了新鲜 ${takenB.fresh} / 腐坏 ${takenB.spoiled}, 不设的对照拿了新鲜 ${takenB2.fresh} / 腐坏 ${takenB2.spoiled} → ${beltSame ? "对带子无效" : "对带子也有效"}`,
      measured: { r, s, takenA, takenB, takenB2 },
    };
  },
};

const TIMERS = `
local a = ...
local s = game.surfaces[a.surface]
local c = lab.place{surface = s, name = "steel-chest", position = {a.x + 0.5, a.y + 0.5}, force = "player"}
c.insert{name = "yumako-mash", count = 10}
c.insert{name = "jelly", count = 10}
return {x = c.position.x, y = c.position.y}`;

const TIMERS_READ = `
local a = ...
local c = game.surfaces[a.surface].find_entity("steel-chest", {a.ref.x, a.ref.y})
local inv = c.get_inventory(defines.inventory.chest)
local m, j = inv.find_item_stack("yumako-mash"), inv.find_item_stack("jelly")
return {mash = inv.get_item_count("yumako-mash"), mash_spoil = m and m.spoil_percent or nil, jelly = inv.get_item_count("jelly"), jelly_spoil = j and j.spoil_percent or nil, spoilage = inv.get_item_count("spoilage"), tick = game.tick}`;

export const mashJellyTimers: Experiment = {
  id: "spoilage.timers.mash-3min-jelly-4min",
  topic: "腐坏",
  claim: "玉玛果泥 3 分钟 (10800 tick)、果冻 4 分钟 (14400 tick) 腐坏成变质物, 进度线性: 1.5 分钟时果泥 50%、果冻 37.5%",
  refs: ["gleba.md 本机速查: 腐坏时间", "knowledge/patterns/logistics-choice.md P-logi-05 (运果子不运果泥)"],
  sources: [{ title: "本机原型: yumako-mash spoil_ticks 10800, jelly 14400", credibility: 1 }],
  gameSeconds: 250,
  async run(ctx) {
    const ref = await ctx.lua(TIMERS);
    await ctx.ticks(5400);
    const half = (await ctx.lua(TIMERS_READ, { ref })) as { mash: number; mash_spoil: number | null; jelly: number; jelly_spoil: number | null; spoilage: number };
    await ctx.ticks(5460);
    const m3 = (await ctx.lua(TIMERS_READ, { ref })) as typeof half;
    await ctx.ticks(3600);
    const m4 = (await ctx.lua(TIMERS_READ, { ref })) as typeof half;
    const ok = half.mash === 10 && half.mash_spoil !== null && Math.abs(half.mash_spoil - 0.5) < 0.03 && half.jelly_spoil !== null && Math.abs(half.jelly_spoil - 0.375) < 0.03
      && m3.mash === 0 && m3.jelly === 10 && m4.jelly === 0 && m4.spoilage === 20;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `1.5 分钟: 果泥 ${half.mash_spoil === null ? "?" : (half.mash_spoil * 100).toFixed(0) + "%"}、果冻 ${half.jelly_spoil === null ? "?" : (half.jelly_spoil * 100).toFixed(1) + "%"}; 3 分钟 1 秒: 果泥剩 ${m3.mash}、果冻剩 ${m3.jelly}; 4 分钟 1 秒: 果冻剩 ${m4.jelly}, 变质物 ${m4.spoilage}`,
      measured: { half, m3, m4 },
    };
  },
};

const FUEL = `
local a = ...
local s = game.surfaces[a.surface]
local t = lab.place{surface = s, name = "heating-tower", position = {a.x + 0.5, a.y + 0.5}, force = "player"}
local n = t.insert{name = "spoilage", count = 1}
local b = t.burner
return {inserted = n, remaining = b.remaining_burning_fuel, in_slot = t.get_fuel_inventory().get_item_count("spoilage"), x = t.position.x, y = t.position.y}`;

const FUEL_READ = `
local a = ...
local t = game.surfaces[a.surface].find_entity("heating-tower", {a.ref.x, a.ref.y})
return {remaining = t.burner.remaining_burning_fuel, in_slot = t.get_fuel_inventory().get_item_count("spoilage"), heat = t.temperature, tick = game.tick}`;

export const spoilageAsFuel: Experiment = {
  id: "spoilage.spoilage-as-fuel-250kJ",
  topic: "腐坏",
  claim: "变质物能当燃料 (250kJ 一个, 煤的 1/16): 供热塔吃下一个, 燃烧槽里就是 250kJ",
  refs: ["knowledge/patterns/production.md P-prod-19 (卵线末端烧 / 多余的烧进供热塔)", "logistics.md L22"],
  sources: [{ title: "本机原型: spoilage fuel_value 250kJ", credibility: 1 }],
  surface: "gleba",
  gameSeconds: 5,
  allowUnpowered: true,
  async run(ctx) {
    const r = (await ctx.lua(FUEL)) as { inserted: number; remaining: number; in_slot: number; x: number; y: number };
    await ctx.ticks(30);
    const q = (await ctx.lua(FUEL_READ, { ref: r })) as { remaining: number; in_slot: number; heat: number };
    const burning = Math.max(r.remaining, q.remaining + 16e6 * 0.5); // 半秒烧掉 8MJ, 250kJ 早烧完了; 看插入那一刻的读数
    const ok = r.inserted === 1 && (Math.abs(r.remaining - 250e3) < 1e3 || (r.in_slot === 1 && q.in_slot === 0));
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `供热塔收下 ${r.inserted} 个变质物, 插入时燃烧槽 ${(r.remaining / 1e3).toFixed(0)}kJ、燃料槽 ${r.in_slot} 个; 半秒后燃料槽 ${q.in_slot} 个 (烧掉了)`,
      measured: { r, q, burning },
    };
  },
};

const BLOCK = `
local a = ...
local s = game.surfaces[a.surface]
local d = defines.direction
local f = "player"
game.forces.player.recipes["nutrients-from-yumako-mash"].enabled = true
local b = lab.place{surface = s, name = "biochamber", position = {a.x + 0.5, a.y + 0.5}, force = f}
b.set_recipe("nutrients-from-yumako-mash")
-- 只放原料不放燃料: 做不了, 果泥在输入槽里等着坏
b.get_inventory(defines.inventory.crafter_input).insert{name = "yumako-mash", count = 4}
lab.label(b, a.with_inserter and "故意不给燃料 (有出料臂)" or "故意不给燃料 (没出料臂)")
local refs = {b = {x = b.position.x, y = b.position.y}}
if a.with_inserter then
  local slot = lab.slots(b, "east")[2]
  lab.place{surface = s, name = "fast-inserter", position = slot, direction = d.west, force = f}
  local c = lab.place{surface = s, name = "steel-chest", position = {slot.x + 1, slot.y}, force = f}
  refs.c = {x = c.position.x, y = c.position.y}
end
return refs`;

const BLOCK_READ = `
local a = ...
local s = game.surfaces[a.surface]
local b = s.find_entity("biochamber", {a.r.b.x, a.r.b.y})
local inp = b.get_inventory(defines.inventory.crafter_input)
local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
local chest = a.r.c and s.find_entity("steel-chest", {a.r.c.x, a.r.c.y})
local outInv = b.get_output_inventory()
local out = {mash = inp.get_item_count("yumako-mash"), spoilage_in_input = inp.get_item_count("spoilage"), spoilage_in_output = outInv.get_item_count("spoilage"),
  status = names[b.status], finished = b.products_finished, chest_spoilage = chest and chest.get_inventory(defines.inventory.chest).get_item_count("spoilage") or -1} -- lint-ok: 只看做没做 (前后差是不是 0)
if a.feed then
  b.insert{name = "nutrients", count = 10}
  out.mash_inserted = inp.insert{name = "yumako-mash", count = 4}
end
return out`;

export const spoiledInputBlocksMachine: Experiment = {
  id: "spoilage.spoiled-input.blocks-machine-until-cleared",
  topic: "腐坏",
  claim: "机器里的原料坏了会被挪进输出槽当垃圾 (不留在输入槽); 没有出料臂时输出槽被变质物占着, 机器停在\"输出已满\"; 旁边不带过滤的出料臂会把变质物顺手清走, 机器照常开工 (G12 原话: 垃圾槽满了机器就停, 不带过滤的出料臂顺手清垃圾)",
  refs: ["knowledge/patterns/planets.md P-planet-14 (G12: 变质原料堵住槽位, 不带过滤的出料臂顺手清垃圾)"],
  sources: [{ title: "planets.md 句芒 G12 (论坛 / 视频: 垃圾槽和出料臂清垃圾)", credibility: 3 }],
  surface: "gleba",
  gameSeconds: 400,
  allowStatus: ["no_fuel"], // 对照组故意不给燃料
  async run(ctx) {
    await ctx.power();
    const out: Record<string, unknown> = {};
    for (const withIns of [false, true]) {
      await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area: [[ctx.x - 20, ctx.y - 20], [ctx.x + 20, ctx.y + 20]], no_enemies: true, clear: true }, { timeoutMs: 120_000 });
      await ctx.power();
      const r = (await ctx.lua(BLOCK, { with_inserter: withIns })) as { b: { x: number; y: number }; c?: { x: number; y: number } };
      await ctx.powered();
      await ctx.ticks(10800 + 120); // 果泥 3 分钟坏完
      const spoiled = (await ctx.lua(BLOCK_READ, { r, feed: true })) as { mash: number; spoilage_in_input: number; status: string; chest_spoilage: number; mash_inserted: number };
      await ctx.ticks(600);
      const after = (await ctx.lua(BLOCK_READ, { r })) as { mash: number; spoilage_in_input: number; status: string; chest_spoilage: number };
      out[withIns ? "withInserter" : "noInserter"] = { spoiled, after };
    }
    type R = { spoilage_in_input: number; spoilage_in_output: number; status: string; finished: number; chest_spoilage: number };
    const a = out.noInserter as { spoiled: R; after: R }, b = out.withInserter as { spoiled: R; after: R };
    // 第一轮我把 G12 转述成"堵住输入槽", 被实测推翻 (变质物在输出槽); 这里按 G12 原话测
    const blocked = a.spoiled.spoilage_in_input === 0 && a.spoiled.spoilage_in_output === 4 && a.after.status === "full_output" && a.after.finished === a.spoiled.finished;
    const cleared = b.after.chest_spoilage === 4 && b.after.spoilage_in_output === 0 && b.after.finished > b.spoiled.finished;
    return {
      verdict: blocked && cleared ? "verified" : "refuted",
      summary: `没出料臂: 果泥坏完后输入槽变质物 ${a.spoiled.spoilage_in_input}、输出槽 ${a.spoiled.spoilage_in_output}; 再给料 10 秒后状态 ${a.after.status}, 做了 ${a.after.finished - a.spoiled.finished} 次; 有出料臂: 变质物被搬进箱子 ${b.after.chest_spoilage} 个, 再给料 10 秒做了 ${b.after.finished - b.spoiled.finished} 次 (状态 ${b.after.status})`,
      measured: out,
    };
  },
};
