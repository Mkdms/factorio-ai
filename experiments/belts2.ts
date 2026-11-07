// 机械臂从传送带取货 (M2 收尾, verify.md 下一批 3): 基础传送带两道满载、一直在流动 (下游装卸机收走), 机械臂垂直取货进箱子。
// 三行并排: 电力机械臂、加长机械臂、高速机械臂; 摆放全用 lab.place / lab.slots, 加长的隔 2 格取放。
import type { Experiment } from "../src/verify/types.ts";

const ROWS = [
  { inserter: "inserter", reach: 1, want: 0.94 },
  { inserter: "long-handed-inserter", reach: 2, want: 1.18 },
  { inserter: "fast-inserter", reach: 1, want: 2.5 },
];

export const inserterFromMovingBelt: Experiment = {
  id: "inserters.from-moving-belt",
  topic: "机械臂",
  claim: "机械臂从流动中的基础传送带垂直取货 (没有手部容量加成): 电力机械臂每秒约 0.94 个、加长机械臂约 1.18、高速机械臂约 2.50, 和箱子到箱子 (0.86 / 1.25 / 2.5) 差不多",
  refs: ["verify.md 下一批 3 (机械臂从传送带取货的速度)", "inserters.chest-to-chest.* (箱子到箱子已核实)"],
  sources: [{ title: "官方 wiki: Inserters (Belt to chest 表, 基础传送带、物品以带速移动)", url: "https://wiki.factorio.com/Inserters", credibility: 2 }],
  gameSeconds: 90,
  async run(ctx) {
    // 先摆装置再铺电 (ctx.power 先铺的电源压在第一行装卸机上; 铺电会避开已有建筑)
    const refs = (await ctx.lua(`local a = ...
      local s = game.surfaces[a.surface]
      local f = "player"
      local east = defines.direction.east
      local out = {}
      for i, row in ipairs(a.rows) do
        local y = a.y + (i - 2) * 9 + 0.5
        local src = lab.place{surface = s, name = "infinity-chest", position = {a.x - 13.5, y}, force = f}
        src.set_infinity_container_filter(1, {name = "iron-plate", count = 100, mode = "exactly"})
        lab.place{surface = s, name = "loader", position = {a.x - 12, y}, direction = east, type = "output", force = f}
        local mid
        for x = -11, 10 do
          local b = lab.place{surface = s, name = "transport-belt", position = {a.x + x + 0.5, y}, direction = east, force = f}
          if x == 0 then mid = b end
        end
        lab.place{surface = s, name = "loader", position = {a.x + 12, y}, direction = east, type = "input", force = f}
        lab.place{surface = s, name = "steel-chest", position = {a.x + 13.5, y}, force = f}
        local ins = lab.place{surface = s, name = row.inserter, position = lab.slots(mid, "north", row.reach)[1], direction = lab.pickup_dir.south, force = f}
        local c = lab.place{surface = s, name = "iron-chest", position = lab.slots(mid, "north", 2 * row.reach)[1], force = f}
        out[i] = {x = c.position.x, y = c.position.y}
      end
      return out`, { rows: ROWS })) as { x: number; y: number }[];
    await ctx.power();
    await ctx.ticks(60);
    await ctx.powered();
    const count = async () => (await ctx.lua(`local a = ... local s = game.surfaces[a.surface] local out = {}
      for i, p in ipairs(a.refs) do out[i] = s.find_entity("iron-chest", {p.x, p.y}).get_item_count("iron-plate") end return out`, { refs })) as number[];
    await ctx.ticks(20 * 60); // 先让带子满、机械臂进入节奏
    const c0 = await count();
    await ctx.ticks(60 * 60);
    const c1 = await count();
    const rates = ROWS.map((r, i) => ({ name: r.inserter, perSecond: (c1[i] - c0[i]) / 60, want: r.want }));
    const ok = rates.every((r) => Math.abs(r.perSecond - r.want) / r.want <= 0.05);
    return {
      verdict: ok ? "verified" : rates.some((r) => r.perSecond > 0) ? "refuted" : "inconclusive",
      summary: rates.map((r) => `${ctx.zh(r.name)} 每秒 ${r.perSecond.toFixed(2)} (wiki ${r.want})`).join("; "),
      measured: { rates },
    };
  },
};
