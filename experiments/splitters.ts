// 第十七批 (2026-11-02): 分流器和地下传送带 —— 覆盖清单 (docs/coverage.md) 里两类实体一直是空白, 蓝图最基础的件。
// 说法照 wiki 原文 (Belt transport system 2026-01-14 版、Splitter 2026-04-11 版), 地下带距离对照本机原型 max_distance。
// 场地: 分流器朝东放在中心, 北边那行 = 行进方向的左手边; 料源 = 永续箱 + 装卸机 (出货), 收料 = 装卸机 (进货) + 钢箱;
// "堵住一个出口" = 把那个钢箱的格子限位到 0 (set_bar(1)), 带子会慢慢堵满。
import type { Experiment } from "../src/verify/types.ts";

const WIKI_BTS = { title: "官方 wiki: Belt transport system (Splitters / Underground belts)", url: "https://wiki.factorio.com/Belt_transport_system", date: "2026-01-14", credibility: 2 as const };
const WIKI_SPLITTER = { title: "官方 wiki: Splitter", url: "https://wiki.factorio.com/Splitter", date: "2026-04-11", credibility: 2 as const };
const PROTO = { title: "本机 2.1.24 原型数据 (underground-belt.max_distance、splitter.speed)", credibility: 1 as const };

const TIERS = {
  basic: { belt: "transport-belt", splitter: "splitter", loader: "loader", ug: "underground-belt", speed: 15 },
  fast: { belt: "fast-transport-belt", splitter: "fast-splitter", loader: "fast-loader", ug: "fast-underground-belt", speed: 30 },
  express: { belt: "express-transport-belt", splitter: "express-splitter", loader: "express-loader", ug: "express-underground-belt", speed: 45 },
  turbo: { belt: "turbo-transport-belt", splitter: "turbo-splitter", loader: "turbo-loader", ug: "turbo-underground-belt", speed: 60 },
};
type Tier = (typeof TIERS)[keyof typeof TIERS];

// 一行分流器: 中心 (a.x + 0.5, y0), 朝东; inputs / outputs 按 [北, 南] 给 (物品名 / true, 没有就 false)。
// 输入带 13 格接料源, 输出带 12 格接收料箱; 返回两个收料箱的位置 (没有输出的是 nil) 和分流器位置。
const ROW = `
local a = ...
local s = game.surfaces[a.surface]
local E = defines.direction.east
local T = a.tier
local function belts(x1, x2, y)
  local first, last
  for x = x1, x2 do
    local b = lab.place{surface = s, name = T.belt, position = {x, y}, direction = E}
    first = first or b
    last = b
  end
  return first, last
end
local spl = lab.place{surface = s, name = T.splitter, position = {a.x + 0.5, a.y0}, direction = E}
local ins, outs = lab.slots(spl, "west", 1), lab.slots(spl, "east", 1)
local sinks = {}
for i = 1, 2 do
  if a.inputs[i] then
    local first = belts(ins[i].x - 12, ins[i].x, ins[i].y)
    local ld = lab.place{surface = s, name = T.loader, position = {first.position.x - 1.5, first.position.y}, direction = E, type = "output"}
    local ch = lab.place{surface = s, name = "infinity-chest", position = {ld.position.x - 1.5, first.position.y}}
    ch.set_infinity_container_filter(1, {name = a.inputs[i], count = 100, mode = "exactly"})
  end
  if a.outputs[i] then
    local _, last = belts(outs[i].x, outs[i].x + 11, outs[i].y)
    local ld = lab.place{surface = s, name = T.loader, position = {last.position.x + 1.5, last.position.y}, direction = E, type = "input"}
    local ch = lab.place{surface = s, name = "steel-chest", position = {ld.position.x + 1.5, last.position.y}}
    sinks[tostring(i)] = {x = ch.position.x, y = ch.position.y} -- 字符串键: 数组回到 JS 会从 0 数 (第一次干跑就堵错了箱子)
  end
end
if a.output_priority then spl.splitter_output_priority = a.output_priority end
if a.input_priority then spl.splitter_input_priority = a.input_priority end
if a.filter then spl.splitter_filter = {name = a.filter} end
return {spl = {x = spl.position.x, y = spl.position.y}, sinks = sinks, out_priority = spl.splitter_output_priority, in_priority = spl.splitter_input_priority, filter = spl.splitter_filter and spl.splitter_filter.name}`;

// 读收料箱里各物品的数; clear = 读完清空 (超速带 1 分钟 3600 个, 钢箱 4800 装不了太久)
const COUNT = `
local a = ...
local s = game.surfaces[a.surface]
local out = {}
for i, p in pairs(a.sinks) do
  local ch = s.find_entity("steel-chest", {p.x, p.y})
  local r = {}
  for _, item in ipairs(a.items) do r[item] = ch.get_item_count(item) end
  if a.clear then ch.get_inventory(defines.inventory.chest).clear() end
  out[tostring(i)] = r
end
return out`;

// 堵住 / 放开一个收料箱 (bar = 1: 0 格可用; 不给 = 放开)
const BAR = `
local a = ...
local ch = game.surfaces[a.surface].find_entity("steel-chest", {a.p.x, a.p.y})
ch.get_inventory(defines.inventory.chest).set_bar(a.bar)
return ch.get_inventory(defines.inventory.chest).get_bar()`;

type Sinks = Record<string, { x: number; y: number }>;
type Counts = Record<string, Record<string, number>>;
const near = (v: number, want: number, tol = 0.03) => Math.abs(v - want) <= want * tol;

async function rates(ctx: Parameters<Experiment["run"]>[0], sinks: Sinks, items: string[], warmS: number, measureS: number) {
  await ctx.ticks(warmS * 60);
  await ctx.lua(COUNT, { sinks, items, clear: true });
  await ctx.ticks(measureS * 60);
  const c = (await ctx.lua(COUNT, { sinks, items, clear: true })) as Counts;
  const r: Record<string, Record<string, number>> = {};
  for (const [k, v] of Object.entries(c)) r[k === "1" ? "北" : "南"] = Object.fromEntries(Object.entries(v).map(([i, n]) => [i, n / measureS]));
  return r;
}
const fmt = (r: Record<string, Record<string, number>>, zh: (n: string) => string) =>
  Object.entries(r).map(([side, v]) => `${side} ${Object.entries(v).map(([i, n]) => `${zh(i)} ${n.toFixed(2)}`).join(" / ")}`).join("; ");

export const splitterEvenAndOverflow: Experiment = {
  id: "splitters.even-split-and-overflow",
  topic: "传送带",
  claim: "分流器把一条输入按 1:1 分到两个出口; 一个出口堵满、分不匀时全部走另一个出口 (提示与技巧 TT6)",
  refs: ["game-tips.md TT6", "coverage.md 空白: 基础分流器"],
  sources: [WIKI_BTS, { title: "游戏内提示与技巧 TT6 分流器", credibility: 1 }],
  gameSeconds: 170,
  async run(ctx) {
    const row = (await ctx.lua(ROW, { tier: TIERS.basic, y0: ctx.y, inputs: ["iron-plate", false], outputs: [true, true] })) as { sinks: Sinks };
    await ctx.power();
    await ctx.ticks(60);
    await ctx.powered();
    const even = await rates(ctx, row.sinks, ["iron-plate"], 20, 60);
    await ctx.lua(BAR, { p: row.sinks["2"], bar: 1 });
    const blocked = await rates(ctx, row.sinks, ["iron-plate"], 30, 60);
    const n1 = even["北"]["iron-plate"], s1 = even["南"]["iron-plate"], n2 = blocked["北"]["iron-plate"], s2 = blocked["南"]["iron-plate"];
    const ok = near(n1, 7.5) && near(s1, 7.5) && near(n2, 15) && s2 === 0;
    return {
      verdict: ok ? "verified" : n1 + s1 > 0 ? "refuted" : "inconclusive",
      summary: `基础传送带满载 (每秒 15) 进一个基础分流器: 两边都通时 北 ${n1.toFixed(2)} / 南 ${s1.toFixed(2)} 每秒; 把南边收料箱堵死后 北 ${n2.toFixed(2)} / 南 ${s2.toFixed(2)}`,
      measured: { even, blocked },
    };
  },
};

export const splitterOutputPriority: Experiment = {
  id: "splitters.output-priority",
  topic: "传送带",
  claim: "分流器设输出优先: 全部先送到指定那边, 那边满了才送另一边 (wiki 原文: will only output on the other output once the specified output is full)",
  refs: ["game-tips.md TT6 (可以设输入或输出优先)", "fulgora.md F9、F17 (分拣、溢出回收靠输出优先)"],
  sources: [WIKI_BTS],
  gameSeconds: 170,
  async run(ctx) {
    const row = (await ctx.lua(ROW, { tier: TIERS.basic, y0: ctx.y, inputs: ["iron-plate", false], outputs: [true, true], output_priority: "left" })) as { sinks: Sinks; out_priority: string };
    await ctx.power();
    await ctx.ticks(60);
    await ctx.powered();
    const open = await rates(ctx, row.sinks, ["iron-plate"], 20, 60);
    await ctx.lua(BAR, { p: row.sinks["1"], bar: 1 });
    const blocked = await rates(ctx, row.sinks, ["iron-plate"], 30, 60);
    const n1 = open["北"]["iron-plate"], s1 = open["南"]["iron-plate"], n2 = blocked["北"]["iron-plate"], s2 = blocked["南"]["iron-plate"];
    const ok = row.out_priority === "left" && near(n1, 15) && s1 === 0 && n2 === 0 && near(s2, 15);
    return {
      verdict: ok ? "verified" : n1 + s1 > 0 ? "refuted" : "inconclusive",
      summary: `朝东的分流器输出优先设"左" (= 行进方向左手边 = 北): 两边都通时 北 ${n1.toFixed(2)} / 南 ${s1.toFixed(2)} 每秒; 北边收料箱堵死后 北 ${n2.toFixed(2)} / 南 ${s2.toFixed(2)}`,
      measured: { open, blocked, priority: row.out_priority },
    };
  },
};

export const splitterInputPriority: Experiment = {
  id: "splitters.input-priority",
  topic: "传送带",
  claim: "分流器设输入优先: 先吃指定那边的输入, 那条带上有空当才吃另一边 (wiki 原文: will only consume the other input once there is a gap on the prioritized input belt)",
  refs: ["game-tips.md TT6"],
  sources: [WIKI_BTS],
  gameSeconds: 140,
  async run(ctx) {
    // 两条满带进 (北 铁板 / 南 铜板), 只有北出口能走 (南收料箱一开始就堵死) → 出口只够一条带的量, 才看得出谁先
    const row = (await ctx.lua(ROW, { tier: TIERS.basic, y0: ctx.y, inputs: ["iron-plate", "copper-plate"], outputs: [true, true], input_priority: "left" })) as { sinks: Sinks; in_priority: string };
    await ctx.lua(BAR, { p: row.sinks["2"], bar: 1 });
    await ctx.power();
    await ctx.ticks(60);
    await ctx.powered();
    const items = ["iron-plate", "copper-plate"];
    const both = await rates(ctx, { "1": row.sinks["1"] }, items, 20, 60);
    // 断掉北边 (铁板) 的料源: 永续箱不再补、清空, 带上剩下的走完后应该轮到铜板
    await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      for _, ch in pairs(s.find_entities_filtered{area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}, name = "infinity-chest"}) do
        local f = ch.get_infinity_container_filter(1)
        if f and f.name == "iron-plate" then ch.set_infinity_container_filter(1, nil) ch.get_inventory(defines.inventory.chest).clear() end
      end return true`);
    const cut = await rates(ctx, { "1": row.sinks["1"] }, items, 20, 60);
    const i1 = both["北"]["iron-plate"], c1 = both["北"]["copper-plate"], i2 = cut["北"]["iron-plate"], c2 = cut["北"]["copper-plate"];
    // 满带也偶有空当: 第一次干跑铜板每分钟挤进 2 个 (0.2%), 原文本来就是"有空当才吃另一边", 判定按 ≤1% 算, 结论里写实数
    const ok = row.in_priority === "left" && near(i1 + c1, 15) && c1 <= 0.01 * (i1 + c1) && i2 === 0 && near(c2, 15);
    return {
      verdict: ok ? "verified" : i1 + c1 > 0 ? "refuted" : "inconclusive",
      summary: `输入优先设"左" (北 = 铁板, 南 = 铜板, 都是满带, 出口只够一条带): 北出口 铁板 ${i1.toFixed(2)} / 铜板 ${c1.toFixed(2)} 每秒 (铜板占 ${((100 * c1) / Math.max(1e-9, i1 + c1)).toFixed(1)}%, 满带的空当里挤进去的); 断掉铁板料源后 铁板 ${i2.toFixed(2)} / 铜板 ${c2.toFixed(2)}`,
      measured: { both, cut, priority: row.in_priority },
    };
  },
};

export const splitterFilter: Experiment = {
  id: "splitters.filter-strict",
  topic: "传送带",
  claim: "过滤分流器: 设定的物品全走指定出口, 其他物品全走另一个出口 (wiki 原文: All items of the set type will be redirected to that specific output and all other items are directed to the other output); 一边堵了也不改走另一边",
  refs: ["fulgora.md F9 (雷神星分拣)", "mindset.md M34 (寿司带取料)", "game-tips.md TT6"],
  sources: [WIKI_BTS],
  gameSeconds: 270,
  async run(ctx) {
    const row = (await ctx.lua(ROW, { tier: TIERS.basic, y0: ctx.y, inputs: ["iron-plate", "copper-plate"], outputs: [true, true], filter: "copper-plate", output_priority: "left" })) as { sinks: Sinks; filter: string };
    await ctx.power();
    await ctx.ticks(60);
    await ctx.powered();
    const items = ["iron-plate", "copper-plate"];
    const open = await rates(ctx, row.sinks, items, 20, 60);
    await ctx.lua(BAR, { p: row.sinks["1"], bar: 1 }); // 堵住铜板那边
    const northBlocked = await rates(ctx, row.sinks, items, 30, 60);
    await ctx.lua(BAR, { p: row.sinks["1"] });
    await ctx.lua(BAR, { p: row.sinks["2"], bar: 1 }); // 放开北, 堵住铁板那边
    const southBlocked = await rates(ctx, row.sinks, items, 30, 60);
    const ok = row.filter === "copper-plate"
      && near(open["北"]["copper-plate"], 15) && open["北"]["iron-plate"] === 0 && near(open["南"]["iron-plate"], 15) && open["南"]["copper-plate"] === 0
      && northBlocked["南"]["copper-plate"] === 0 && near(northBlocked["南"]["iron-plate"], 15)
      && southBlocked["北"]["iron-plate"] === 0 && near(southBlocked["北"]["copper-plate"], 15);
    return {
      verdict: ok ? "verified" : open["北"]["copper-plate"] + open["南"]["iron-plate"] > 0 ? "refuted" : "inconclusive",
      summary: `过滤设铜板、走北 (输入 北铁板 / 南铜板 两条满带): 都通 → ${fmt(open, ctx.zh)}; 堵北 → ${fmt(northBlocked, ctx.zh)}; 堵南 → ${fmt(southBlocked, ctx.zh)} (每秒)`,
      measured: { open, northBlocked, southBlocked },
    };
  },
};

export const splitterKeepsLanes: Experiment = {
  id: "splitters.keeps-lanes",
  topic: "传送带",
  claim: "分流器保持车道: 只有一道有货的带子进分流器, 两个出口的货仍在同一道上 (wiki 原文: Splitters preserve the lanes of the items)",
  refs: ["belts.sideload.shape-and-lane (侧向汇入只上靠近的那一道, 已核实)"],
  sources: [WIKI_BTS, WIKI_SPLITTER],
  gameSeconds: 45,
  async run(ctx) {
    // 北行输入带没有料源; 它中段从南边接一条朝北的带子侧向汇入 → 铁板只在南道 (右道, 第 2 条线)
    const row = (await ctx.lua(ROW, { tier: TIERS.basic, y0: ctx.y, inputs: [false, false], outputs: [true, true] })) as { sinks: Sinks; spl: { x: number; y: number } };
    await ctx.lua(`local a = ... local s = game.surfaces[a.surface] local N = defines.direction.north
      local spl = s.find_entity("splitter", {a.spl.x, a.spl.y})
      local inN = lab.slots(spl, "west", 1)[1]
      local first, last
      for x = inN.x - 12, inN.x do last = lab.place{surface = s, name = "transport-belt", position = {x, inN.y}, direction = defines.direction.east} end
      local fx = inN.x - 6
      for y = inN.y + 5, inN.y + 1, -1 do local b = lab.place{surface = s, name = "transport-belt", position = {fx, y}, direction = N} first = first or b end
      local ld = lab.place{surface = s, name = "loader", position = {fx, first.position.y + 1.5}, direction = N, type = "output"}
      local ch = lab.place{surface = s, name = "infinity-chest", position = {fx, ld.position.y + 1.5}}
      ch.set_infinity_container_filter(1, {name = "iron-plate", count = 100, mode = "exactly"})
      return true`, { spl: row.spl });
    await ctx.power();
    await ctx.ticks(60);
    await ctx.powered();
    await ctx.ticks(40 * 60);
    const lanes = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      local spl = s.find_entity("splitter", {a.spl.x, a.spl.y})
      local inN = lab.slots(spl, "west", 1)[1]
      local function sum(x1, x2, y) local l1, l2 = 0, 0
        for x = x1, x2 do local b = s.find_entity("transport-belt", {x, y}) l1 = l1 + b.get_transport_line(1).get_item_count() l2 = l2 + b.get_transport_line(2).get_item_count() end
        return {left = l1, right = l2} end
      local outs = lab.slots(spl, "east", 1)
      return {input = sum(inN.x - 5, inN.x, inN.y), north = sum(outs[1].x, outs[1].x + 11, outs[1].y), south = sum(outs[2].x, outs[2].x + 11, outs[2].y)}`, { spl: row.spl })) as Record<"input" | "north" | "south", { left: number; right: number }>;
    const ok = lanes.input.left === 0 && lanes.input.right > 0 && lanes.north.left === 0 && lanes.north.right > 0 && lanes.south.left === 0 && lanes.south.right > 0;
    return {
      verdict: ok ? "verified" : lanes.north.right + lanes.south.right + lanes.north.left + lanes.south.left > 0 ? "refuted" : "inconclusive",
      summary: `输入带 左道 ${lanes.input.left} / 右道 ${lanes.input.right} 件 → 北出口 左 ${lanes.north.left} / 右 ${lanes.north.right}, 南出口 左 ${lanes.south.left} / 右 ${lanes.south.right} (带上件数快照)`,
      measured: lanes,
    };
  },
};

export const splitterSpeedTiers: Experiment = {
  id: "splitters.speed-matches-belt",
  topic: "传送带",
  claim: "分流器的速度和同级传送带一样 (基础 / 高速 / 极速 / 超速 每条每秒 15 / 30 / 45 / 60), 两条满带进两条满带出, 分流器不是瓶颈",
  refs: ["belts.throughput.* (传送带吞吐已核实)", "coverage.md 空白: 高速分流器、极速分流器; 只有检索: 超速分流器"],
  sources: [WIKI_BTS, PROTO],
  gameSeconds: 55,
  async run(ctx) {
    const tiers = [TIERS.basic, TIERS.fast, TIERS.express, TIERS.turbo];
    const sinks: Sinks = {};
    for (const [i, t] of tiers.entries()) {
      const row = (await ctx.lua(ROW, { tier: t, y0: ctx.y - 9 + 6 * i, inputs: ["iron-plate", "iron-plate"], outputs: [true, true] })) as { sinks: Sinks };
      sinks[`${i}n`] = row.sinks["1"];
      sinks[`${i}s`] = row.sinks["2"];
    }
    await ctx.power();
    await ctx.ticks(60);
    await ctx.powered();
    await ctx.ticks(15 * 60);
    await ctx.lua(COUNT, { sinks, items: ["iron-plate"], clear: true });
    await ctx.ticks(40 * 60);
    const c = (await ctx.lua(COUNT, { sinks, items: ["iron-plate"], clear: true })) as Counts;
    const got = tiers.map((t, i) => ({ splitter: t.splitter, want: 2 * t.speed, perSecond: (c[`${i}n`]["iron-plate"] + c[`${i}s`]["iron-plate"]) / 40 }));
    const ok = got.every((g) => near(g.perSecond, g.want));
    return {
      verdict: ok ? "verified" : got.some((g) => g.perSecond > 0) ? "refuted" : "inconclusive",
      summary: got.map((g) => `${ctx.zh(g.splitter)} 两出口合计每秒 ${g.perSecond.toFixed(2)} (两条满带 ${g.want})`).join("; "),
      measured: { got },
    };
  },
};

export const undergroundMaxDistance: Experiment = {
  id: "undergrounds.max-distance",
  topic: "传送带",
  claim: "地下传送带两头之间最多隔 4 / 6 / 8 / 10 格 (基础 / 高速 / 极速 / 超速; wiki 原文 4、6、8 是本体三种, 超速按本机原型 max_distance 11)",
  refs: ["coverage.md 空白: 基础地下传送带、高速地下传送带; 只有检索: 超速地下传送带"],
  sources: [WIKI_BTS, WIKI_SPLITTER, PROTO],
  gameSeconds: 1,
  allowLayout: ["underground-unpaired", "belt-no-source", "belt-no-sink", "belt-end"],
  async run(ctx) {
    // 每级两行: 出口放在 max_distance 处 (隔 max-1 格) 和再远一格 (对照, 头顶标字); 读引擎的 underground_belt_neighbour
    const res = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface] local E = defines.direction.east
      local out = {}
      for i, name in ipairs(a.ugs) do
        local d = prototypes.entity[name].max_underground_distance
        out[i] = {name = name, max = d}
        for k, extra in ipairs({0, 1}) do
          local y = a.y - 14 + ((i - 1) * 2 + (k - 1)) * 4 + 0.5
          local inp = lab.place{surface = s, name = name, position = {a.x - 6 + 0.5, y}, direction = E, type = "input"}
          local outp = lab.place{surface = s, name = name, position = {inp.position.x + d + extra, y}, direction = E, type = "output"}
          if extra > 0 then lab.label(outp, "对照: 远一格") end
          local nb = inp.underground_belt_neighbour
          out[i][extra == 0 and "at_max" or "beyond"] = {gap = outp.position.x - inp.position.x - 1, paired = nb ~= nil and nb.position.x == outp.position.x}
        end
      end
      return out`, { ugs: [TIERS.basic.ug, TIERS.fast.ug, TIERS.express.ug, TIERS.turbo.ug] })) as { name: string; max: number; at_max: { gap: number; paired: boolean }; beyond: { gap: number; paired: boolean } }[];
    await ctx.powered();
    const want = [4, 6, 8, 10];
    const ok = res.every((r, i) => r.at_max.paired && !r.beyond.paired && r.at_max.gap === want[i]);
    return {
      verdict: ok ? "verified" : "refuted",
      summary: res.map((r) => `${ctx.zh(r.name)}: 隔 ${r.at_max.gap} 格${r.at_max.paired ? "接上" : "没接上"}, 隔 ${r.beyond.gap} 格${r.beyond.paired ? "接上" : "接不上"}`).join("; "),
      measured: { res },
    };
  },
};

export const undergroundLaneFilter: Experiment = {
  id: "undergrounds.sideload-entrance-one-lane",
  topic: "传送带",
  claim: "传送带从侧面顶到地下传送带入口上, 只有一道进得去 (入口格里有带子的那一半收货, 有隧道口的那一半挡住), 另一道停住 —— 常用来只取一道; 顶到普通带子上 (对照) 两道都进",
  refs: ["belts.sideload.shape-and-lane", "wiki Belt transport system: lane blocking"],
  sources: [WIKI_BTS],
  gameSeconds: 85,
  async run(ctx) {
    // 两列: 甲 = 北向地下带入口 (出口在北 3 格) / 乙 = 北向普通带子 (对照, 有上游); 各有一条东行喂料带从西边顶上来,
    // 喂料带北边的机械臂放铁板 (落南道), 南边的机械臂放铜板 (落北道) (机械臂只放远端那道, 已核实 TT1)
    const cols = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      local d = defines.direction
      local out = {}
      for k, col in ipairs({{x = a.x - 6.5, ug = true}, {x = a.x + 10.5, ug = false}}) do
        local ty = a.y + 0.5
        local target, top
        if col.ug then
          target = lab.place{surface = s, name = "underground-belt", position = {col.x, ty}, direction = d.north, type = "input"}
          top = lab.place{surface = s, name = "underground-belt", position = {col.x, ty - 3}, direction = d.north, type = "output"}
        else
          lab.place{surface = s, name = "transport-belt", position = {col.x, ty + 1}, direction = d.north}
          for y = ty, ty - 3, -1 do top = lab.place{surface = s, name = "transport-belt", position = {col.x, y}, direction = d.north} end
          target = s.find_entity("transport-belt", {col.x, ty})
          lab.label(target, "对照: 普通带子")
        end
        local last
        for y = top.position.y - 1, top.position.y - 4, -1 do last = lab.place{surface = s, name = "transport-belt", position = {col.x, y}, direction = d.north} end
        local ld = lab.place{surface = s, name = "loader", position = {col.x, last.position.y - 1.5}, direction = d.north, type = "input"}
        local sink = lab.place{surface = s, name = "steel-chest", position = {col.x, ld.position.y - 1.5}}
        local feed
        for x = col.x - 8, col.x - 1 do local b = lab.place{surface = s, name = "transport-belt", position = {x, ty}, direction = d.east} if x == col.x - 6 then feed = b end end
        for _, side in ipairs({{"north", "iron-plate"}, {"south", "copper-plate"}}) do
          local ins = lab.place{surface = s, name = "fast-inserter", position = lab.slots(feed, side[1], 1)[1], direction = lab.pickup_dir[side[1]]}
          local ch = lab.place{surface = s, name = "infinity-chest", position = lab.slots(feed, side[1], 2)[1]}
          ch.set_infinity_container_filter(1, {name = side[2], count = 50, mode = "exactly"})
        end
        out[k] = {x = sink.position.x, y = sink.position.y}
      end
      return out`)) as { x: number; y: number }[];
    await ctx.power();
    await ctx.ticks(60);
    await ctx.powered();
    const sinks: Sinks = { "1": cols[0], "2": cols[1] };
    const r = await rates(ctx, sinks, ["iron-plate", "copper-plate"], 20, 60);
    const ug = r["北"], ctrl = r["南"]; // rates() 按 1 / 2 命名成 北 / 南, 这里 1 = 甲 (地下带), 2 = 乙 (对照)
    const onlyOne = (ug["iron-plate"] > 0) !== (ug["copper-plate"] > 0);
    const ok = onlyOne && ctrl["iron-plate"] > 0 && ctrl["copper-plate"] > 0;
    const passed = ug["iron-plate"] > 0 ? "铁板 (喂料带南道, 对着入口有带子的南半格)" : "铜板 (喂料带北道)";
    return {
      verdict: ok ? "verified" : ug["iron-plate"] + ug["copper-plate"] + ctrl["iron-plate"] + ctrl["copper-plate"] > 0 ? "refuted" : "inconclusive",
      summary: `顶到北向地下带入口: 铁板 ${ug["iron-plate"].toFixed(2)} / 铜板 ${ug["copper-plate"].toFixed(2)} 每秒${onlyOne ? `, 只进了${passed}` : ""}; 对照 (普通带子): 铁板 ${ctrl["iron-plate"].toFixed(2)} / 铜板 ${ctrl["copper-plate"].toFixed(2)}`,
      measured: { underground: ug, control: ctrl },
    };
  },
};

export const undergroundBraiding: Experiment = {
  id: "undergrounds.braiding-by-tier",
  topic: "传送带",
  claim: "不同等级的地下传送带在同一条线上可以交织, 各配各的 (wiki 原文: Different types of underground belts can be braided together along the same line of tiles); 不同等级的两头不配对",
  refs: ["wiki Belt transport system: braiding"],
  sources: [WIKI_BTS],
  gameSeconds: 1,
  allowLayout: ["underground-unpaired", "belt-no-source", "belt-no-sink", "belt-end"],
  async run(ctx) {
    const r = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface] local E = defines.direction.east
      local function ug(name, x, y, t) return lab.place{surface = s, name = name, position = {x, y}, direction = E, type = t} end
      local y1, y2 = a.y - 2 + 0.5, a.y + 2 + 0.5
      local x0 = a.x - 3 + 0.5
      local bi = ug("underground-belt", x0, y1, "input")
      local fi = ug("fast-underground-belt", x0 + 1, y1, "input")
      local fo = ug("fast-underground-belt", x0 + 3, y1, "output")
      local bo = ug("underground-belt", x0 + 5, y1, "output")
      local ci = ug("underground-belt", x0, y2, "input")
      local co = ug("fast-underground-belt", x0 + 3, y2, "output")
      lab.label(ci, "对照: 不同等级")
      local function pair(e, other) local n = e.underground_belt_neighbour return n ~= nil and n.position.x == other.position.x and n.name == other.name end
      return {basic = pair(bi, bo), fast = pair(fi, fo), mixed = ci.underground_belt_neighbour ~= nil or co.underground_belt_neighbour ~= nil}`)) as { basic: boolean; fast: boolean; mixed: boolean };
    await ctx.powered();
    const ok = r.basic && r.fast && !r.mixed;
    return {
      verdict: ok ? "verified" : "refuted",
      summary: `一行里 基础入口 0、高速入口 1、高速出口 3、基础出口 5 (基础要越过两个高速件): 基础${r.basic ? "接上基础" : "没接上"}、高速${r.fast ? "接上高速" : "没接上"}; 对照 基础入口 + 高速出口 (隔 2 格): ${r.mixed ? "配上了" : "不配对"}`,
      measured: r,
    };
  },
};
