// 游戏外设计、精准落格。
// 测法: 在世界坐标上设计一组大小不同的建筑 (1×1 到 5×5、铁轨、各种方向), 用 encodeAbsolute 编成绝对吸附蓝图,
// 故意把"鼠标"放在格子中心偏开几格的地方拍下, 再逐个读回位置和方向, 和设计逐格对比。
import type { Experiment } from "../src/verify/types.ts";
import { encodeAbsolute, diffPlacements, type Placement } from "../src/blueprint/design.ts";

const N = 0, E = 4, S = 8, W = 12;

export const absoluteSnapExact: Experiment = {
  id: "blueprint.absolute-snapping.exact",
  topic: "蓝图",
  claim: "游戏外按世界坐标设计、编成绝对吸附蓝图 (格子左上 = 蓝图 (0,0)), 鼠标偏开几格拍下, 每个建筑仍落在设计的那一格、方向不变",
  refs: ["第一版 knowledge/topics/blueprint-tools.md 绝对吸附 (2.1.23 试放)", "用户要求"],
  sources: [
    { title: "第一版实测: 绝对吸附下实体坐标按格子左上原样使用 (2.1.23, 366 件铁轨模块 365 件对)", credibility: 3 },
    { title: "本机 API 文件: LuaItemCommon.build_blueprint", credibility: 1 },
  ],
  gameSeconds: 0,
  allowUnpowered: true, // 只看位置和方向, 故意不接电
  async run(ctx) {
    const version = (await ctx.lua("return script.active_mods.base")) as string;
    // 故意不对齐到 64 的倍数, 并混合奇偶尺寸; 整组设计宽约 25 格, 必须落在实验区 (中心 ±20) 里:
    // 第一次把 bx 设成 ctx.x + 3, 轮到第 16 个实验时炼油厂和铁轨超出了准备区, 回归测试报"缺 3 件" (2026-11-01)
    const bx = ctx.x - 12, by = ctx.y - 7;
    const design: Placement[] = [
      { name: "iron-chest", x: bx + 0.5, y: by + 0.5 },
      { name: "inserter", x: bx + 1.5, y: by + 0.5, direction: W },
      { name: "stone-furnace", x: bx + 3, y: by + 1 },
      { name: "assembling-machine-2", x: bx + 6.5, y: by + 1.5, recipe: "iron-gear-wheel" },
      { name: "electric-mining-drill", x: bx + 10.5, y: by + 1.5, direction: S },
      { name: "oil-refinery", x: bx + 15.5, y: by + 2.5, direction: E },
      { name: "transport-belt", x: bx + 0.5, y: by + 5.5, direction: E },
      { name: "transport-belt", x: bx + 1.5, y: by + 5.5, direction: E },
      { name: "underground-belt", x: bx + 2.5, y: by + 5.5, direction: E, type: "input" },
      { name: "underground-belt", x: bx + 6.5, y: by + 5.5, direction: E, type: "output" },
      { name: "medium-electric-pole", x: bx + 8.5, y: by + 5.5 },
      { name: "pipe-to-ground", x: bx + 10.5, y: by + 5.5, direction: W },
      { name: "pipe-to-ground", x: bx + 14.5, y: by + 5.5, direction: E },
      // 2.0 铁轨 2×2 对齐, 中心在奇数格点上
      { name: "straight-rail", x: 2 * Math.floor((bx + 20) / 2) + 1, y: 2 * Math.floor((by + 1) / 2) + 1, direction: N },
      { name: "straight-rail", x: 2 * Math.floor((bx + 20) / 2) + 1, y: 2 * Math.floor((by + 1) / 2) + 3, direction: N },
    ];
    // 电力采矿机脚下要有矿, 否则幽灵复活不了 (2.1.24 实测), 先铺一小片铁矿
    await ctx.lua(
      `local a = ... local s = game.surfaces[a.surface]
       for x = a.mx - 2, a.mx + 1 do for y = a.my - 2, a.my + 1 do s.create_entity{name = "iron-ore", position = {x + 0.5, y + 0.5}, amount = 1000} end end`,
      { mx: bx + 10, my: by + 1 },
    );
    const bp = encodeAbsolute(design, { label: "精准落格测试", gameVersion: version });
    const jitter = { x: bp.cursor.x + 2.3, y: bp.cursor.y - 1.7 };
    const placed = (await ctx.lab.rpc("place_blueprint", {
      string: bp.string,
      position: [jitter.x, jitter.y],
      surface: ctx.surface,
      anchor: "center", // 不用我们自己的原点对齐, 只靠游戏的绝对吸附
    })) as { ghosts: number; built: number; failed_count: number; entities: { name: string; x: number; y: number; direction?: number }[] };
    const d = diffPlacements(design, placed.entities);
    const show = (list: { name: string; x: number; y: number }[]) => list.slice(0, 4).map((p) => `${ctx.zh(p.name)}(${p.x},${p.y})`).join("、");
    return {
      verdict: d.ok ? "verified" : "refuted",
      summary: d.ok
        ? `设计 ${design.length} 件, 鼠标偏开 (2.3, -1.7) 拍下, ${placed.built} 件全部落在设计的格子上、方向一致`
        : `设计 ${design.length} 件, 建成 ${placed.built}: 缺 ${d.missing.length} (${show(d.missing)}), 多出 ${d.extra.length} (${show(d.extra)}), 方向不对 ${d.wrongDirection.length}`,
      measured: { cell: bp.cell, origin: bp.origin, cursor: jitter, ghosts: placed.ghosts, built: placed.built, missing: d.missing, extra: d.extra, wrongDirection: d.wrongDirection },
    };
  },
};
