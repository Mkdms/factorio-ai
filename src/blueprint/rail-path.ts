// 按铁轨端点表 (rail-geometry.json, 本机沙盘引擎读出来的) 自动拼一条轨: 不手敲坐标。
// 给起点 (一段轨的开口端: 位置 + 出口方向) 和每一步的目标方向, 逐段找"一端正好接上开口、另一端朝目标方向、中心落在合法网格"的那块。
// 方向 16 向, 顺时针递增 (北 0、东 4、南 8、西 12); 目标方向 = 当前 +1 就是右转 22.5°, -1 左转, 不变就是直行。
import { railDirGeometry, type RailGeometry } from "./rail-geometry.ts";

export interface RailPiece {
  name: string;
  /** 建造时给的方向 (表里的键) */
  dir: number;
  x: number;
  y: number;
}

export interface RailOpenEnd {
  x: number;
  y: number;
  /** 出口方向 (行进方向) */
  dir: number;
}

/** 找的顺序: 能直走就用直轨 / 半斜轨, 转弯才用曲轨 */
export const PATH_NAMES = ["straight-rail", "half-diagonal-rail", "curved-rail-a", "curved-rail-b"];

const mod = (v: number, m: number) => ((v % m) + m) % m;

/** 接在开口 end 上、出口朝 want 的一块; 没有就 null */
export function nextPiece(geom: RailGeometry, end: RailOpenEnd, want: number): { piece: RailPiece; end: RailOpenEnd } | null {
  const back = mod(end.dir + 8, 16);
  for (const name of PATH_NAMES) {
    for (let d = 0; d < 16; d++) {
      const g = railDirGeometry(geom, name, d);
      if (!g || g.dir !== d) continue; // 引擎会把一些方向归一 (例: 直轨 1 → 0), 只用本来就是这个方向的
      for (const [i, e] of g.ends.entries()) {
        if (e.dir !== back) continue;
        const other = g.ends[1 - i];
        if (other.dir !== mod(want, 16)) continue;
        const cx = end.x - e.dx, cy = end.y - e.dy;
        if (mod(cx, 2) !== g.grid[0] || mod(cy, 2) !== g.grid[1]) continue; // 铁轨在 2 格网格上
        return { piece: { name, dir: d, x: cx, y: cy }, end: { x: cx + other.dx, y: cy + other.dy, dir: other.dir } };
      }
    }
  }
  return null;
}

/** 从 start 开始按 steps (每步的目标方向, 相对 start.dir 的增量) 拼; 某一步拼不上就抛错 */
export function railPath(geom: RailGeometry, start: RailOpenEnd, steps: number[]): { pieces: RailPiece[]; end: RailOpenEnd; ends: RailOpenEnd[] } {
  const pieces: RailPiece[] = [];
  const ends: RailOpenEnd[] = []; // 每放一块之后的开口
  let end = start;
  for (const [k, s] of steps.entries()) {
    const n = nextPiece(geom, end, start.dir + s);
    if (!n) throw new Error(`第 ${k + 1} 步拼不上: 开口 (${end.x}, ${end.y}) 朝 ${end.dir}, 要朝 ${mod(start.dir + s, 16)}`);
    pieces.push(n.piece);
    end = n.end;
    ends.push(end);
  }
  return { pieces, end, ends };
}

/** 一段直轨的开口端 (直轨中心在奇数格, 两端在 ±1); 用来当起点 */
export function straightStart(geom: RailGeometry, x: number, y: number, dir: number): { piece: RailPiece; end: RailOpenEnd } {
  const g = railDirGeometry(geom, "straight-rail", dir);
  if (!g || g.dir !== dir) throw new Error(`直轨没有方向 ${dir}`);
  const cx = Math.floor(x / 2) * 2 + g.grid[0], cy = Math.floor(y / 2) * 2 + g.grid[1];
  const e = g.ends.find((x) => x.dir === dir)!;
  return { piece: { name: "straight-rail", dir, x: cx, y: cy }, end: { x: cx + e.dx, y: cy + e.dy, dir } };
}
