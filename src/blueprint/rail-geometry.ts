// 铁轨几何: 每种铁轨在每个朝向下两端的"轨道位置" (位置 + 出口方向) 和信号的合法位置, 全部从本机沙盘引擎读出来,
// 不手写 (曲轨、斜轨的端点几何在原型数据里没有, 只有引擎知道)。存到 lab-data/prototypes/<版本>/rail-geometry.json, 和原型数据一起用。
// 2.1.24 实测 (2026-11-01): 两段铁轨相接 = 一段的某一端 location.position 等于另一段某一端的, 且方向相反 (差 8);
// 信号: surface.can_place_entity{build_check_type = manual} 只在铁轨旁合法的位置和朝向返回 true (远离铁轨返回 false, 不带 manual 则到处都 true)。
import fs from "node:fs";
import path from "node:path";
import type { LabInstance } from "../lab/instance.ts";
import { defaultDumpPath } from "./rules.ts";

export interface RailEnd {
  /** 相对铁轨中心 */
  dx: number;
  dy: number;
  /** 出口方向 (16 向) */
  dir: number;
}

export interface RailDirGeometry {
  /** 建出来的实体方向 (引擎可能把 8 归一成 0) */
  dir: number;
  /** 合法落点的奇偶 (x mod 2, y mod 2), 用来查"不在网格上" */
  grid: [number, number];
  ends: RailEnd[];
  /** 信号合法位置: [dx, dy, 信号方向] (dx, dy 相对铁轨中心) */
  signals: [number, number, number][];
  /** 车站合法位置 (按 connected_rail 判断, 不是碰撞): [dx, dy, 车站方向] */
  stops: [number, number, number][];
}

export interface RailGeometry {
  version: string;
  rails: Record<string, Record<number, RailDirGeometry>>;
}

/** 层: E = 高架, G = 地面 (高架轨名字带 elevated- 前缀; 信号看蓝图的 rail_layer) */
export const railLayerOf = (name: string): "E" | "G" => (name.startsWith("elevated-") ? "E" : "G");
/** 高架轨和同形的地面轨几何相同 (2026-11-02 沙盘: 高架直轨中心也在奇数格、长 2), 查表时去掉 elevated- 前缀 */
export function railDirGeometry(geom: RailGeometry, name: string, dir: number): RailDirGeometry | undefined {
  return geom.rails[name.replace(/^elevated-/, "")]?.[dir];
}
/** 带层的端点。坡道不在表里, 按沙盘实测: 朝东时西端 (-8, 0) 在地面层、出口朝西, 东端 (8, 0) 在高架层、出口朝东; 其他朝向旋转 (只认东南西北) */
export function railEndsOf(geom: RailGeometry, name: string, dir: number): { dx: number; dy: number; dir: number; layer: "E" | "G" }[] | null {
  if (name === "rail-ramp") {
    if (dir % 4 !== 0) return null;
    const rot = (x: number, y: number): [number, number] => { let [a, b] = [x, y]; for (let i = 0; i < dir / 4; i++) [a, b] = [-b, a]; return [a, b]; };
    const [ex, ey] = rot(0, -8), [gx, gy] = rot(0, 8);
    return [{ dx: ex, dy: ey, dir, layer: "E" }, { dx: gx, dy: gy, dir: (dir + 8) % 16, layer: "G" }];
  }
  const ends = railDirGeometry(geom, name, dir)?.ends;
  return Array.isArray(ends) ? ends.map((e) => ({ dx: e.dx, dy: e.dy, dir: e.dir, layer: railLayerOf(name) })) : null;
}

export const RAIL_NAMES = ["straight-rail", "curved-rail-a", "curved-rail-b", "half-diagonal-rail"];

const DERIVE = `
local a = ...
local s = game.surfaces[a.surface or "nauvis"]
local f = "player"
local out = {}
local anchors = {{0, 0}, {1, 1}, {0.5, 0.5}, {1, 0}, {0, 1}, {0.5, 0}, {0, 0.5}, {1, 0.5}, {0.5, 1}, {1.5, 1.5}}
local function clear(cx, cy)
  for _, e in pairs(s.find_entities_filtered{area = {{cx - 12, cy - 12}, {cx + 12, cy + 12}}}) do if e.valid and e.type ~= "character" then e.destroy() end end
end
local cx, cy = 0, 0
for _, name in pairs(a.names) do
  out[name] = {}
  for dir = 0, 15 do
    clear(cx, cy)
    local e
    for _, an in pairs(anchors) do
      local p = {cx + an[1], cy + an[2]}
      if s.can_place_entity{name = name, position = p, direction = dir, force = f, build_check_type = defines.build_check_type.manual} then
        e = s.create_entity{name = name, position = p, direction = dir, force = f}
        if e then break end
      end
    end
    if e then
      local rec = {dir = e.direction, grid = {e.position.x % 2, e.position.y % 2}, ends = {}, signals = {}, stops = {}}
      for _, rd in pairs({defines.rail_direction.front, defines.rail_direction.back}) do
        local loc = e.get_rail_end(rd).location
        rec.ends[#rec.ends + 1] = {dx = loc.position.x - e.position.x, dy = loc.position.y - e.position.y, dir = loc.direction}
      end
      for dx = -4, 4, 0.5 do for dy = -4, 4, 0.5 do
        local px, py = e.position.x + dx, e.position.y + dy
        if (px % 1 == 0.5) and (py % 1 == 0.5) then
          for sd = 0, 15 do
            if s.can_place_entity{name = "rail-signal", position = {px, py}, direction = sd, force = f, build_check_type = defines.build_check_type.manual} then
              rec.signals[#rec.signals + 1] = {dx, dy, sd}
            end
          end
        end
      end end
      -- 车站: 2×2, 中心在整数; 放一个试 connected_rail 是不是这段轨
      for dx = -4, 4 do for dy = -4, 4 do
        for sd = 0, 12, 4 do
          local px, py = e.position.x + dx, e.position.y + dy
          if (px % 1 == 0) and (py % 1 == 0) and s.can_place_entity{name = "train-stop", position = {px, py}, direction = sd, force = f, build_check_type = defines.build_check_type.manual} then
            local st = s.create_entity{name = "train-stop", position = {px, py}, direction = sd, force = f}
            if st then
              if st.connected_rail and st.connected_rail == e then rec.stops[#rec.stops + 1] = {dx, dy, sd} end
              st.destroy()
            end
          end
        end
      end end
      out[name][tostring(dir)] = rec
    end
  end
end
clear(cx, cy)
return out`;

export function railGeometryPath(dumpPath?: string): string {
  return path.join(path.dirname(dumpPath ?? defaultDumpPath()), "rail-geometry.json");
}

export function loadRailGeometry(dumpPath?: string): RailGeometry | null {
  const file = railGeometryPath(dumpPath);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as RailGeometry;
}

/** 在一个已启动的沙盘实例里读铁轨几何并写文件 (±16 格的空地就够) */
export async function deriveRailGeometry(lab: LabInstance, version: string, dumpPath?: string): Promise<RailGeometry> {
  await lab.rpc("prepare_area", { area: [[-16, -16], [16, 16]], no_enemies: true }, { timeoutMs: 120_000 });
  const raw = (await lab.exec(DERIVE, { names: RAIL_NAMES }, { timeoutMs: 600_000 })) as Record<string, Record<string, RailDirGeometry>>;
  const rails: RailGeometry["rails"] = {};
  for (const [name, dirs] of Object.entries(raw)) {
    rails[name] = {};
    for (const [d, rec] of Object.entries(dirs)) rails[name][Number(d)] = rec;
  }
  const geom: RailGeometry = { version, rails };
  const file = railGeometryPath(dumpPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(geom, null, 1));
  return geom;
}
