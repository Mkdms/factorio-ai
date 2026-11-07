// 机械臂: 没研究时每手抓几个、箱子到箱子每分钟搬多少 (喂料实测和搜索的测量条件是"不做研究", 2026-11-02)
import type { Experiment } from "../src/verify/types.ts";

const API = (what: string) => ({ title: `本机 API 文件 runtime-api.json (2.1.24): ${what}`, credibility: 1 as const });
const KINDS = ["inserter", "fast-inserter", "long-handed-inserter", "bulk-inserter"];

export const handSizeNoResearch: Experiment = {
  id: "inserter.hand-size-no-research",
  topic: "机械臂",
  claim: "没研究时 (阵营的抓取数加成都是 0), 电力机械臂、高速机械臂、加长机械臂、集装机械臂每手都只抓 1 个 (原型都没写 stack_size_bonus; 集装机械臂的大手只来自研究)",
  refs: ["docs/search.md 测量条件", "docs/blueprint-dataset.md 喂料实测 (后期设计被低估)"],
  sources: [
    API("LuaForce.inserter_stack_size_bonus = 非集装机械臂的抓取数加成; bulk_inserter_capacity_bonus = 集装机械臂一次能搬几个; LuaEntity.inserter_target_pickup_count = 当前每手目标数 (含科技)"),
    { title: "本机原型导出 data-raw-dump (2.1.24): 四种机械臂都没有 stack_size_bonus 字段 (集装机械臂只有 bulk = true)", credibility: 1 },
  ],
  gameSeconds: 70,
  async run(ctx) {
    await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
local kinds = a.kinds
for i, name in ipairs(kinds) do
  local reach = (name == "long-handed-inserter") and 2 or 1
  local src = lab.place{surface = s, name = "steel-chest", position = {a.x - 8 + 4 * i + 0.5, a.y - 6 + 0.5}, force = "player"}
  lab.insert(src, {name = "iron-plate", count = 2000})
  local p = lab.slots(src, "south", reach)[1]
  local ins = lab.place{surface = s, name = name, position = p, direction = lab.pickup_dir.north, force = "player"}
  local q = lab.slots(ins, "south", reach)[1]
  lab.place{surface = s, name = "steel-chest", position = q, force = "player"}
  lab.label(ins, a.zh[i])
end
return true`, { kinds: KINDS, zh: KINDS.map((k) => ctx.zh(k)) });
    await ctx.power();
    await ctx.ticks(120);
    await ctx.powered();
    // 测量: 窗口开始时各终点箱的数, 跑 60 秒, 期间每 7 tick 抽一次手里拿着几个
    const READ = `local a = ...
local s = game.surfaces[a.surface]
local out = {}
for _, ins in pairs(s.find_entities_filtered{type = "inserter", area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}}) do
  local d = ins.drop_target
  out[ins.name] = {held = ins.held_stack.valid_for_read and ins.held_stack.count or 0, target = ins.inserter_target_pickup_count, dest = d and d.get_item_count("iron-plate") or -1}
end
local f = game.forces.player
out.bonus = {inserter = f.inserter_stack_size_bonus, bulk = f.bulk_inserter_capacity_bonus}
return out`;
    type R = Record<string, { held: number; target: number; dest: number }> & { bonus: { inserter: number; bulk: number } };
    const start = (await ctx.lua(READ)) as R;
    const maxHeld: Record<string, number> = Object.fromEntries(KINDS.map((k) => [k, 0]));
    let end = start;
    for (let t = 0; t < 3600; t += 7) {
      await ctx.ticks(7);
      end = (await ctx.lua(READ)) as R;
      for (const k of KINDS) maxHeld[k] = Math.max(maxHeld[k], end[k]?.held ?? 0);
    }
    const perMin = Object.fromEntries(KINDS.map((k) => [k, (end[k]?.dest ?? 0) - (start[k]?.dest ?? 0)]));
    const target = Object.fromEntries(KINDS.map((k) => [k, end[k]?.target]));
    const read = KINDS.every((k) => end[k] && perMin[k] > 0);
    const ones = KINDS.every((k) => maxHeld[k] === 1 && target[k] === 1);
    const bonusZero = end.bonus.inserter === 0 && end.bonus.bulk === 0;
    return {
      verdict: !read || !bonusZero ? "inconclusive" : ones ? "verified" : "refuted",
      summary: `阵营加成 非集装 ${end.bonus.inserter}、集装 ${end.bonus.bulk}; 每手最多 / 目标: ${KINDS.map((k) => `${ctx.zh(k)} ${maxHeld[k]}/${target[k]}`).join("、")}; 箱子到箱子每分钟搬: ${KINDS.map((k) => `${ctx.zh(k)} ${perMin[k]}`).join("、")}`,
      measured: { maxHeld, target, perMin, bonus: end.bonus },
    };
  },
};

const TECHS = ["bulk-inserter", "inserter-capacity-bonus-1", "inserter-capacity-bonus-2", "inserter-capacity-bonus-3", "inserter-capacity-bonus-4", "inserter-capacity-bonus-5", "inserter-capacity-bonus-6", "inserter-capacity-bonus-7", "stack-inserter", "transport-belt-capacity-1", "transport-belt-capacity-2"];
const KINDS_ALL = [...KINDS, "stack-inserter"];

export const handSizeFullResearch: Experiment = {
  id: "inserter.hand-size-full-research",
  topic: "机械臂",
  claim: "研究完全部机械臂运力科技 (集装机械臂、机械臂运力加成 1~7 级、堆叠机械臂、传送带容量 1、2) 后: 电力 / 高速 / 加长机械臂每手 4 个, 集装机械臂每手 12 个, 堆叠机械臂每手 16 个",
  refs: ["research/players/v1-knowledge.md V1K-49", "facts inserter.hand-size-no-research", "docs/search.md 测量条件 (按研究等级测)"],
  sources: [
    { title: "本机原型导出 (2.1.24): 科技效果 非集装加成 2 级 +1、7 级 +1、传送带容量 2 +1 (合计 +3); 集装加成 集装机械臂 +1、1~4 级各 +1、5~7 级各 +2 (合计 +11); stack-inserter 原型 stack_size_bonus 4", credibility: 1 },
    { title: "第一版知识库 topics/source-facts.md (2026-10-30, 未核实) → v1-knowledge.md V1K-49", credibility: 3 },
  ],
  gameSeconds: 70,
  async run(ctx) {
    // 研究 (直接设 researched); 测完还原 (框架每个实验开始时也会把阵营加成清 0)
    const before = (await ctx.lua(`local a = ... local f = game.forces.player local was = {}
      local bonus = {inserter = f.inserter_stack_size_bonus, bulk = f.bulk_inserter_capacity_bonus}
      for _, n in ipairs(a.techs) do was[n] = f.technologies[n].researched; f.technologies[n].researched = true end
      return {was = was, bonus = bonus}`, { techs: TECHS })) as { was: Record<string, boolean>; bonus: { inserter: number; bulk: number } };
    try {
      await ctx.lua(`
local a = ...
local s = game.surfaces[a.surface]
for i, name in ipairs(a.kinds) do
  local reach = (name == "long-handed-inserter") and 2 or 1
  local src = lab.place{surface = s, name = "steel-chest", position = {a.x - 12 + 5 * i + 0.5, a.y - 6 + 0.5}, force = "player"}
  lab.insert(src, {name = "iron-plate", count = 4800})
  local ins = lab.place{surface = s, name = name, position = lab.slots(src, "south", reach)[1], direction = lab.pickup_dir.north, force = "player"}
  lab.place{surface = s, name = "steel-chest", position = lab.slots(ins, "south", reach)[1], force = "player"}
  lab.label(ins, a.zh[i])
end
return true`, { kinds: KINDS_ALL, zh: KINDS_ALL.map((k) => ctx.zh(k)) });
      await ctx.power();
      await ctx.ticks(120);
      await ctx.powered();
      const READ = `local a = ...
local s = game.surfaces[a.surface]
local out = {}
for _, ins in pairs(s.find_entities_filtered{type = "inserter", area = {{a.x - 20, a.y - 20}, {a.x + 20, a.y + 20}}}) do
  local d = ins.drop_target
  out[ins.name] = {held = ins.held_stack.valid_for_read and ins.held_stack.count or 0, target = ins.inserter_target_pickup_count, dest = d and d.get_item_count("iron-plate") or -1}
end
local f = game.forces.player
out.bonus = {inserter = f.inserter_stack_size_bonus, bulk = f.bulk_inserter_capacity_bonus}
return out`;
      type R = Record<string, { held: number; target: number; dest: number }> & { bonus: { inserter: number; bulk: number } };
      const start = (await ctx.lua(READ)) as R;
      const maxHeld: Record<string, number> = Object.fromEntries(KINDS_ALL.map((k) => [k, 0]));
      let end = start;
      for (let t = 0; t < 3600; t += 7) {
        await ctx.ticks(7);
        end = (await ctx.lua(READ)) as R;
        for (const k of KINDS_ALL) maxHeld[k] = Math.max(maxHeld[k], end[k]?.held ?? 0);
      }
      const perMin = Object.fromEntries(KINDS_ALL.map((k) => [k, (end[k]?.dest ?? 0) - (start[k]?.dest ?? 0)]));
      const target = Object.fromEntries(KINDS_ALL.map((k) => [k, end[k]?.target]));
      const want: Record<string, number> = { inserter: 4, "fast-inserter": 4, "long-handed-inserter": 4, "bulk-inserter": 12, "stack-inserter": 16 };
      const ok = KINDS_ALL.every((k) => target[k] === want[k] && maxHeld[k] === want[k]);
      const read = KINDS_ALL.every((k) => end[k] && perMin[k] > 0);
      return {
        verdict: !read ? "inconclusive" : ok ? "verified" : "refuted",
        summary: `研究后阵营加成 非集装 ${end.bonus.inserter}、集装 ${end.bonus.bulk} (研究前 ${before.bonus.inserter} / ${before.bonus.bulk}); 每手最多 / 目标: ${KINDS_ALL.map((k) => `${ctx.zh(k)} ${maxHeld[k]}/${target[k]}`).join("、")}; 箱子到箱子每分钟搬: ${KINDS_ALL.map((k) => `${ctx.zh(k)} ${perMin[k]}`).join("、")}`,
        measured: { maxHeld, target, perMin, bonus: end.bonus },
      };
    } finally {
      await ctx.lua(`local a = ... local f = game.forces.player
        for i = #a.techs, 1, -1 do local n = a.techs[i] f.technologies[n].researched = a.was[n] or false end
        f.inserter_stack_size_bonus = 0 f.bulk_inserter_capacity_bonus = 0 f.belt_stack_size_bonus = 0
        return true`, { techs: TECHS, was: before.was });
    }
  },
};
