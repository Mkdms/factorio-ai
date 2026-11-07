// 第十八批 (2026-11-02): 曲轨、半斜轨 (和它们的高架版) —— 覆盖清单里最后 6 个空白实体。
// 说法照官方开发周报 FFF #377 "New new rails" (2023-09-22): 新曲线半径 11 → 13 格、曲线拆成两半、半斜轨让 S 弯可以任意长; wiki Railway 2.0.7: 22.5° 轨道。
// 拼轨不手敲坐标: 用本机沙盘读出来的铁轨端点表 (rail-geometry.json) 自动找下一块 (src/blueprint/rail-path.ts), 引擎里核对每段两头都接上。
import type { Experiment, ExpContext } from "../src/verify/types.ts";
import { loadRailGeometry, railDirGeometry, type RailGeometry } from "../src/blueprint/rail-geometry.ts";
import { railPath, straightStart, type RailPiece } from "../src/blueprint/rail-path.ts";
import { SET_SCHEDULE, clearOldStops, waitState, rec } from "./trains.ts";

const FFF377 = { title: "官方开发周报 FFF #377 New new rails (新曲线半径 11 → 13 格; 曲线拆成两半; 半斜轨让 S 弯任意长)", url: "https://factorio.com/blog/post/fff-377", date: "2023-09-22", credibility: 2 as const };
const WIKI = { title: "官方 wiki: Railway (2.0.7: 新铁轨形状、22.5° 轨道; 铁轨在 2 格网格上)", url: "https://wiki.factorio.com/Railway", date: "2026-10-22", credibility: 2 as const };
const TABLE = { title: "本机 2.1.24 沙盘读出的铁轨端点表 (npm run lab:dump → rail-geometry.json)", credibility: 1 as const };

function geometry(): RailGeometry {
  const g = loadRailGeometry();
  if (!g) throw new Error("没有铁轨端点表: 先 npm run lab:dump");
  return g;
}

/** 一条链: 起点直轨 + 按步拼 (步 = 相对起点方向的目标方向) */
function chain(geom: RailGeometry, steps: number[]) {
  const s = straightStart(geom, 0, 0, 0);
  const p = railPath(geom, s.end, steps);
  return { pieces: [s.piece, ...p.pieces], start: s.end, end: p.end };
}

const even = (v: number) => Math.round(v / 2) * 2;
/** 让一组轨的外框居中到 (cx, cy) 的偶数偏移 (铁轨在 2 格网格上, 偏移必须是偶数) */
function centerOffset(pieces: RailPiece[], cx: number, cy: number) {
  const xs = pieces.map((p) => p.x), ys = pieces.map((p) => p.y);
  return { ox: even(cx - (Math.min(...xs) + Math.max(...xs)) / 2), oy: even(cy - (Math.min(...ys) + Math.max(...ys)) / 2) };
}

// 按清单放轨 (prefix = "elevated-" 放高架版), 再用引擎核对: 每段前后两头有没有接上别的轨、建出来的位置有没有被挪
const PLACE = `
local a = ...
local s = game.surfaces[a.surface]
local placed = {}
for i, p in ipairs(a.pieces) do
  placed[i] = lab.place{surface = s, name = a.prefix .. p.name, position = {a.ox + p.x, a.oy + p.y}, direction = p.dir}
end
local rd, cd = defines.rail_direction, defines.rail_connection_direction
local dead, moved, names = 0, 0, {}
for i, e in ipairs(placed) do
  for _, d in pairs {rd.front, rd.back} do
    local ok = false
    for _, c in pairs {cd.left, cd.straight, cd.right} do if e.get_connected_rail{rail_direction = d, rail_connection_direction = c} then ok = true end end
    if not ok then dead = dead + 1 end
  end
  local p = a.pieces[i]
  if e.position.x ~= a.ox + p.x or e.position.y ~= a.oy + p.y then moved = moved + 1 end
  names[e.name] = (names[e.name] or 0) + 1
end
return {n = #placed, dead = dead, moved = moved, names = names}`;

type Placed = { n: number; dead: number; moved: number; names: Record<string, number> };

async function place(ctx: ExpContext, pieces: RailPiece[], ox: number, oy: number, prefix = "") {
  return (await ctx.lua(PLACE, { pieces, ox, oy, prefix })) as Placed;
}

export const turn90Radius13: Experiment = {
  id: "rails.turn-90-radius-13",
  topic: "火车",
  claim: "2.0 的 90° 弯由 4 段曲轨拼成 (曲轨 A、B、B、A, 每段转 22.5°), 弯道半径 13 格 (1.1 是 11 格): 弯进弯出两个开口横竖各差 13 格; 列车能从直道开过弯道",
  refs: ["coverage.md 空白: 曲轨 (curved-rail-a / curved-rail-b)", "lab.md #22 (铁轨端点表)"],
  sources: [FFF377, WIKI, TABLE],
  gameSeconds: 40,
  async run(ctx) {
    const geom = geometry();
    // 直道 10 格 (5 段) 朝北 → 右转 90° → 直道 12 格朝东
    const c = chain(geom, [0, 0, 0, 0, 1, 2, 3, 4, 4, 4, 4, 4, 4, 4]);
    const turnStart = railPath(geometry(), straightStart(geom, 0, 0, 0).end, [0, 0, 0, 0]).end;
    const turnEnd = railPath(geom, turnStart, [1, 2, 3, 4]).end;
    const curves = c.pieces.slice(5, 9).map((p) => p.name);
    const { ox, oy } = centerOffset(c.pieces, ctx.x, ctx.y);
    await clearOldStops(ctx);
    const pl = await place(ctx, c.pieces, ox, oy);
    // 终点站: 最后一段东行直轨旁的合法车站位置 (表里读, 朝东)
    const last = c.pieces[c.pieces.length - 1];
    const stopSpot = railDirGeometry(geom, "straight-rail", 4)!.stops.find((st) => st[2] === 4);
    if (!stopSpot) throw new Error("表里没有东行直轨的车站位置");
    const first = c.pieces[2];
    const t = (await ctx.lua(`local a = ... local s = game.surfaces[a.surface]
      local st = lab.place{surface = s, name = "train-stop", position = {a.sx, a.sy}, direction = defines.direction.east, station = "曲轨终点"}
      if not st.connected_rail then error("终点站没接上轨", 0) end
      st.backer_name = "曲轨终点"
      local l = lab.place{surface = s, name = "locomotive", position = {a.lx, a.ly}, direction = defines.direction.north}
      l.insert{name = "coal", count = 20}
      return {train_id = l.train.id}`, { sx: ox + last.x + stopSpot[0], sy: oy + last.y + stopSpot[1], lx: ox + first.x, ly: oy + first.y })) as { train_id: number };
    await ctx.powered();
    await ctx.say("90° 弯: 4 段曲轨 (A B B A), 列车从南边直道开过弯道停到东边终点站");
    await ctx.lua(SET_SCHEDULE, { train_id: t.train_id, schedule: { current: 1, records: [rec("曲轨终点", 5)] } });
    const at = await waitState(ctx, t.train_id, (s) => s.state === "wait_station" && s.station === "曲轨终点", 60, 30);
    const dx = turnEnd.x - turnStart.x, dy = turnStart.y - turnEnd.y;
    const ok = pl.dead === 2 && pl.moved === 0 && dx === 13 && dy === 13 && curves.join() === "curved-rail-a,curved-rail-b,curved-rail-b,curved-rail-a" && !!at;
    return {
      verdict: ok ? "verified" : pl.dead === 2 && at ? "refuted" : "inconclusive",
      summary: `90° 右弯 = ${curves.map((n) => (n.endsWith("-a") ? "曲轨 A" : "曲轨 B")).join(" + ")}; 弯进弯出两个开口差 东 ${dx} / 北 ${dy} 格; 整条 ${pl.n} 段引擎核对: 没接上的端头 ${pl.dead} 个 (只有首尾 2 个才对)、被挪位置 ${pl.moved}; 列车${at ? "开过弯道停到了终点站" : "60 秒没到终点站"}`,
      measured: { dx, dy, curves, placed: pl, arrived: !!at },
    };
  },
};

export const sBendHalfDiagonal: Experiment = {
  id: "rails.s-bend-any-length",
  topic: "火车",
  claim: "S 弯 = 半段曲轨 + n 段半斜轨 + 反向半段曲轨, 半斜轨走 22.5° 方向, 所以 S 弯可以任意长 (FFF #377: ANY length S-bend): 每多一段半斜轨, 横移多 2 格、前进多 4 格",
  refs: ["coverage.md 空白: 半对角铁轨 (half-diagonal-rail)"],
  sources: [FFF377, WIKI, TABLE],
  gameSeconds: 1,
  async run(ctx) {
    const geom = geometry();
    const rows = [0, 1, 2].map((n) => {
      const c = chain(geom, [0, 1, ...Array(n).fill(1), 0, 0]);
      return { n, c, shift: c.end.x - c.start.x, ahead: c.start.y - c.end.y };
    });
    const out: { n: number; shift: number; ahead: number; placed: Placed }[] = [];
    for (const [i, r] of rows.entries()) {
      const { ox, oy } = centerOffset(r.c.pieces, ctx.x - 12 + 12 * i, ctx.y);
      out.push({ n: r.n, shift: r.shift, ahead: r.ahead, placed: await place(ctx, r.c.pieces, ox, oy) });
    }
    await ctx.powered();
    const ok = out.every((r) => r.placed.dead === 2 && r.placed.moved === 0 && r.shift === 2 + 2 * r.n && (r.placed.names["half-diagonal-rail"] ?? 0) === r.n)
      && out[1].ahead - out[0].ahead === 4 && out[2].ahead - out[1].ahead === 4;
    return {
      verdict: ok ? "verified" : out.some((r) => r.placed.dead > 2) ? "refuted" : "inconclusive",
      summary: out.map((r) => `${r.n} 段半斜轨: 横移 ${r.shift} 格、前进 ${r.ahead} 格, 引擎核对没接上的端头 ${r.placed.dead} (首尾 2 个才对)`).join("; "),
      measured: { rows: out },
    };
  },
};

// 高架: 从北向坡道的高架端接出去, 按玩家规则一块块放; 放不下就在当前尽头下放支架 (方向跟着轨) 再试 (第十六批 BRIDGE 的做法)
const ELEVATED = `
local a = ...
local s = game.surfaces[a.surface]
local manual = defines.build_check_type.manual
local endp = {x = a.sx, y = a.sy, dir = a.sdir}
local placed, supports = {}, {}
for i, p in ipairs(a.pieces) do
  local name = "elevated-" .. p.name
  local function can() return s.can_place_entity{name = name, position = {p.x, p.y}, direction = p.dir, force = "player", build_check_type = manual} end
  if not can() then
    local ok = false
    for _, dd in ipairs {endp.dir, (endp.dir + 8) % 16} do
      if s.can_place_entity{name = "rail-support", position = {endp.x, endp.y}, direction = dd, force = "player", build_check_type = manual} then
        s.create_entity{name = "rail-support", position = {endp.x, endp.y}, direction = dd, force = "player"}
        supports[#supports + 1] = {x = endp.x, y = endp.y, dir = dd}
        ok = true
        break
      end
    end
    if not ok or not can() then error(name .. " 第 " .. i .. " 块按玩家规则放不下 (支架也救不了) @(" .. p.x .. ", " .. p.y .. ")", 0) end
  end
  placed[i] = s.create_entity{name = name, position = {p.x, p.y}, direction = p.dir, force = "player"}
  endp = a.ends[i]
end
local rd, cd = defines.rail_direction, defines.rail_connection_direction
local dead, names = 0, {}
for _, e in ipairs(placed) do
  for _, d in pairs {rd.front, rd.back} do
    local ok = false
    for _, c in pairs {cd.left, cd.straight, cd.right} do if e.get_connected_rail{rail_direction = d, rail_connection_direction = c} then ok = true end end
    if not ok then dead = dead + 1 end
  end
  names[e.name] = (names[e.name] or 0) + 1
end
return {n = #placed, dead = dead, names = names, supports = {n = #supports, items = supports}}`;

type Elevated = { n: number; dead: number; names: Record<string, number>; supports: { n: number; items: { x: number; y: number; dir: number }[] | Record<string, never> } };

async function elevatedChain(ctx: ExpContext, geom: RailGeometry, rx: number, ry: number, steps: number[]) {
  const ramp = (await ctx.lua(`local a = ... local r = lab.place{surface = game.surfaces[a.surface], name = "rail-ramp", position = {a.rx, a.ry}, direction = defines.direction.north} return {x = r.position.x, y = r.position.y}`, { rx, ry })) as { x: number; y: number };
  const start = { x: ramp.x, y: ramp.y - 8, dir: 0 }; // 北向坡道的高架端 (第十六批实测: 坡道两端在 ±8)
  const p = railPath(geom, start, steps);
  return (await ctx.lua(ELEVATED, { pieces: p.pieces, ends: p.ends, sx: start.x, sy: start.y, sdir: 0 })) as Elevated;
}

export const elevatedSameShapes: Experiment = {
  id: "rails.elevated-curves-same-shapes",
  topic: "火车",
  claim: "高架曲轨、高架半斜轨和地面同形: 同一套端点表拼出的 90° 弯和 S 弯换成高架版, 从坡道接出去按玩家规则一块块建 (够不着就在尽头下放支架), 每段两头照样接上",
  refs: ["coverage.md 空白: 高架曲轨、高架半斜轨", "src/blueprint/rail-geometry.ts (高架轨按同形地面轨查表)", "elevated.support.reach-and-placement (支架撑法, 第十六批)"],
  sources: [TABLE, FFF377],
  gameSeconds: 1,
  async run(ctx) {
    const geom = geometry();
    // 左边: 90° 左弯 (往西); 右边: 1 段半斜轨的 S 弯 (往东横移 4 格); 坡道都在南边朝北
    const a = await elevatedChain(ctx, geom, even(ctx.x + 4) + 1, even(ctx.y + 12), [0, 0, -1, -2, -3, -4, -4, -4]);
    const b = await elevatedChain(ctx, geom, even(ctx.x + 12) + 1, even(ctx.y + 12), [0, 0, 1, 1, 0, 0]);
    await ctx.powered();
    const names = { ...a.names, ...b.names };
    const sup = (e: Elevated) => (Array.isArray(e.supports.items) ? e.supports.items : []);
    const ok = a.dead === 1 && b.dead === 1 && (names["elevated-curved-rail-a"] ?? 0) > 0 && (names["elevated-curved-rail-b"] ?? 0) > 0 && (names["elevated-half-diagonal-rail"] ?? 0) > 0;
    return {
      verdict: ok ? "verified" : a.dead > 1 || b.dead > 1 ? "refuted" : "inconclusive",
      summary: `高架 90° 弯 ${a.n} 段 (支架 ${a.supports.n} 个, 方向 ${sup(a).map((x) => x.dir).join("/")}): 没接上的端头 ${a.dead} (只有末端 1 个才对, 起点接坡道); 高架 S 弯 ${b.n} 段 (支架 ${b.supports.n} 个): 没接上的端头 ${b.dead}; 用到 ${Object.entries(names).map(([k, v]) => `${ctx.zh(k)}${k.endsWith("-a") ? " A" : k.endsWith("-b") ? " B" : ""} ${v}`).join("、")}`,
      measured: { turn: a, s: b },
    };
  },
};
