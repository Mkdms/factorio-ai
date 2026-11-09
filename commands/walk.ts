// 联机时的"走到某点" (docs/brain-run.md: move_to 在沙盘里用了服务器端寻路, 联机要核实)。
// 只用客户端能做的: 注入客户端的程序 的只读查询读障碍 (实体占地框、水面), 我们自己在格子上算 A*, 再按住方向键一段段走, 每段走完读位置纠偏。
// 不调游戏的寻路请求 (那是会改状态的异步请求, 注入客户端的程序 的只读白名单不收, 客户端也不能做)。
import type { Call } from "./query.ts";
import { areaCut, readPlayer } from "./query.ts";
import { Timeline } from "./timeline.ts";
import type { Controls } from "./controls.ts";

type P = { x: number; y: number };
type Box = { left_top: P; right_bottom: P };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * 不挡路的实体类型: 2.1.24 运行时真值, 碰撞层和角色 (is_object、player、train) 没有交集的 (2026-11-06 沙盘 RCON 遍历 prototypes.entity; lab.md #101)。
 * 导出数据里这些多半是默认值, 看不出来。角色自己也算不挡 (查询会查到自己)。simple-entity 不在里面: 石头挡路。
 */
export const PASSABLE = new Set(["character", "resource", "item-entity", "corpse", "character-corpse", "rail-remnants", "fish", "entity-ghost", "tile-ghost", "item-request-proxy", "deconstructible-tile-proxy", "highlight-box", "speech-bubble", "flying-text", "smoke-with-trigger", "fire", "sticker", "projectile", "artillery-projectile", "artillery-flare", "explosion", "particle-source", "beam", "arrow", "stream", "lightning", "asteroid",
  "transport-belt", "underground-belt", "splitter", "lane-splitter", "linked-belt", "loader", "loader-1x1", "pipe-to-ground", "heat-pipe", "land-mine",
  "straight-rail", "curved-rail-a", "curved-rail-b", "half-diagonal-rail", "legacy-straight-rail", "legacy-curved-rail", "elevated-straight-rail", "elevated-curved-rail-a", "elevated-curved-rail-b", "elevated-half-diagonal-rail", "rail-signal", "rail-chain-signal",
  "logistic-robot", "construction-robot", "combat-robot", "capture-robot", "spider-vehicle", "spider-unit", "cargo-pod", "rocket-silo-rocket", "rocket-silo-rocket-shadow"]);
const SPEED = 0.15; // 角色跑速 (格/tick), 2.1.24 原型 character.running_speed
/** 走得过去但会把人运走: 路线尽量绕开, 能选的时候不停在上面 (2026-11-07 朋友存档副本: 报到了, 回复之后接着被运走, 读到时已差 5 格) */
const BELT_TYPES = new Set(["transport-belt", "underground-belt", "splitter", "lane-splitter", "linked-belt", "loader", "loader-1x1"]);
/**
 * 踩一格带子的额外代价 (一格 1)。只给一点: 带子是宽敞的通道, 窄缝才危险。试过给 1: 路线为了躲带子钻进箱子和机械臂的棋盘格, 角色被顶进 0.1 格宽的缝, 8 段路从 8 段到掉到 4 段 (2026-11-07 朋友存档副本)。
 */
const BELT_COST = 0.25;

async function readObstacles(call: Call, area: Box) {
  const r = await call("world_query", { selection: { kind: "entities", area }, fields: ["name", "type", "bounding_box"], limit: 20_000 });
  if (!r.ok) throw new Error(`读实体失败: ${r.error}`);
  const d = r.data as { objects?: { attributes?: Record<string, any> }[]; truncated?: boolean; selection_complete?: boolean };
  if (areaCut(d)) throw new Error("区域里实体太多被截断, 缩小范围");
  const rows = (d.objects ?? []).map((o) => o.attributes ?? {}).filter((a) => a.bounding_box);
  const boxes = rows.filter((a) => !PASSABLE.has(a.type)).map((a) => a.bounding_box as Box);
  const belts = rows.filter((a) => BELT_TYPES.has(a.type)).map((a) => a.bounding_box as Box);
  const t = await call("world_query", { selection: { kind: "tiles", area }, fields: ["name", "position"], limit: 40_000 });
  if (!t.ok) throw new Error(`读地块失败: ${t.error}`);
  const td = t.data as { objects?: { attributes?: Record<string, any> }[]; truncated?: boolean; selection_complete?: boolean };
  if (areaCut(td)) throw new Error("地块被截断, 缩小范围");
  const water = (td.objects ?? []).map((o) => o.attributes ?? {}).filter((a) => /water|out-of-map|lava|ammoniacal|oil-ocean/.test(String(a.name))).map((a) => a.position as P);
  return { boxes, water, belts };
}

/**
 * 在格子上算路 (格子中心; 8 方向, 斜走两边都要通); 返回格子中心点序列, 走不到返回 null。
 * within > 0: 走到离 goal 这么近的任意一格就算到 (goal 常在机器堆里, 那一格本身走不到; 2026-11-06 真服 3 次算不出路)。
 * belt: 这一格是传送带: 踩上去多算代价, within 时不停在上面 (都是带子就算不出来, 调用方不给 belt 再算一次)。
 */
export function planPath(start: P, goal: P, blocked: (cx: number, cy: number) => boolean, limit = 60_000, within = 0, belt?: (cx: number, cy: number) => boolean): P[] | null {
  const sx = Math.floor(start.x), sy = Math.floor(start.y), gx = Math.floor(goal.x), gy = Math.floor(goal.y);
  // 数字当键, 比字符串快 (细化到半格、外扩 64 格时一次要展开十几万格)
  const key = (x: number, y: number) => x * 2_000_003 + y;
  const came = new Map<number, [number, number, number]>(); // 键 → 上一格的键和这一格的坐标
  const gs = new Map<number, number>();
  const h = (x: number, y: number) => { const dx = Math.abs(x - gx), dy = Math.abs(y - gy); return Math.max(0, Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy) - within); };
  const arrived = (x: number, y: number) => (within > 0 ? Math.hypot(x + 0.5 - goal.x, y + 0.5 - goal.y) <= within && !belt?.(x, y) : x === gx && y === gy);
  // 小顶堆: 原来每步扫一遍 open, 范围大了就成平方
  const heap: { x: number; y: number; g: number; f: number }[] = [];
  const push = (n: { x: number; y: number; g: number; f: number }) => {
    let i = heap.push(n) - 1;
    while (i > 0) { const up = (i - 1) >> 1; if (heap[up].f <= heap[i].f) break; [heap[up], heap[i]] = [heap[i], heap[up]]; i = up; }
  };
  const pop = () => {
    const top = heap[0], end = heap.pop()!;
    if (heap.length) {
      heap[0] = end;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  push({ x: sx, y: sy, g: 0, f: h(sx, sy) });
  gs.set(key(sx, sy), 0);
  for (let n = 0; heap.length && n < limit; n++) {
    const cur = pop();
    const ck = key(cur.x, cur.y);
    if (cur.g > (gs.get(ck) ?? Infinity)) continue; // 后来找到更短的了, 这条是旧的
    if (arrived(cur.x, cur.y)) {
      const out: P[] = [{ x: cur.x + 0.5, y: cur.y + 0.5 }];
      for (let c = came.get(ck); c; c = came.get(c[0])) out.unshift({ x: c[1] + 0.5, y: c[2] + 0.5 });
      return out;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (blocked(nx, ny)) continue;
      if (dx && dy && (blocked(cur.x + dx, cur.y) || blocked(cur.x, cur.y + dy))) continue;
      const g = cur.g + (dx && dy ? Math.SQRT2 : 1) + (belt?.(nx, ny) ? BELT_COST : 0);
      const k = key(nx, ny);
      if (g < (gs.get(k) ?? Infinity)) { gs.set(k, g); came.set(k, [ck, cur.x, cur.y]); push({ x: nx, y: ny, g, f: g + h(nx, ny) }); }
    }
  }
  return null;
}

/** 整格: 一格算挡 = 障碍占地框和格子中间 0.6×0.6 重叠 (角色占地 0.4×0.4, 留余量)。细化: 落点在 0.5 的整数倍上, 只留角色本身的 0.4×0.4 */
const GRIDS = [{ scale: 1, half: 0.3 }, { scale: 2, half: 0.2 }] as const;
/** 找不到路才扩大: 读障碍要时间, 大多数路 12 格够了 */
const MARGINS = [12, 32, 64];
const toCell = (v: number, scale: number) => (scale === 1 ? v : v * 2 - 0.5);
const fromCell = (c: number, scale: number) => (scale === 1 ? c : (c + 0.5) / 2);

/**
 * 按障碍在一种格子上算路。细化那一档专门用来走相邻机器中间 0.6 格的缝: 缝的中线在整数坐标上 (2026-11-06 真服: 角色走进 y 198.7~199.3 的缝,
 * 整格模型算出来哪都去不了, 连 12 格外都算不出路; 真人平时就走这种缝)。要算的格子先标好, 不然每格都要扫一遍几千个框。
 */
function planOn(me: P, goal: P, within: number, obstacles: { boxes: Box[]; water: P[]; belts: Box[] }, area: Box, grid: { scale: 1 | 2; half: number }): P[] | null {
  const { blocked, belt } = cellsOf(obstacles, area, grid);
  const { scale } = grid;
  const scaled = (p: P) => ({ x: toCell(p.x, scale), y: toCell(p.y, scale) });
  const limit = scale === 1 ? 60_000 : 300_000;
  // 范围里全是带子就只好站在带子上
  const path = planPath(scaled(me), scaled(goal), blocked, limit, within * scale, belt) ?? (within ? planPath(scaled(me), scaled(goal), blocked, limit, within * scale) : null);
  return path && path.map((p) => ({ x: fromCell(p.x, scale), y: fromCell(p.y, scale) }));
}

/** 从角色脚下能走到的格子不超过这么多 (半格: 4 个 = 1 平方格), 就是自己掉进了小口袋 */
const POCKET_CELLS = 40;

/**
 * 算不出路时分清两件事: 目标到不了, 还是角色自己在小口袋里。人走得进去就走得出来, 只是规划器不认: 2026-11-07 朋友存档副本角色被顶进箱子和机械臂的棋盘格,
 * 真实的缝只有 0.1 格宽, 格子上全算挡, 之后每条命令都报"周围 64 格被围住"。
 */
function inPocket(me: P, obstacles: { boxes: Box[]; water: P[]; belts: Box[] }, area: Box): boolean {
  const grid = GRIDS[1];
  const { blocked } = cellsOf(obstacles, area, grid);
  const sx = Math.floor(toCell(me.x, grid.scale)), sy = Math.floor(toCell(me.y, grid.scale));
  const key = (x: number, y: number) => x * 2_000_003 + y;
  const seen = new Set([key(sx, sy)]);
  const todo = [[sx, sy]];
  while (todo.length && seen.size <= POCKET_CELLS) {
    const [x, y] = todo.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!blocked(nx, ny) && !seen.has(key(nx, ny))) { seen.add(key(nx, ny)); todo.push([nx, ny]); }
    }
  }
  return seen.size <= POCKET_CELLS;
}

/** 障碍标到格子上: 要算的格子先标好, 不然每格都要扫一遍几千个框 */
function cellsOf(obstacles: { boxes: Box[]; water: P[]; belts: Box[] }, area: Box, grid: { scale: 1 | 2; half: number }) {
  const { scale, half } = grid;
  const x0 = Math.floor(toCell(area.left_top.x, scale)), y0 = Math.floor(toCell(area.left_top.y, scale));
  const nx = Math.ceil(toCell(area.right_bottom.x, scale)) - x0 + 1, ny = Math.ceil(toCell(area.right_bottom.y, scale)) - y0 + 1;
  const bad = new Uint8Array(nx * ny), onBelt = new Uint8Array(nx * ny);
  const center = (c: number) => fromCell(c + 0.5, scale);
  const mark = (lx: number, ly: number, rx: number, ry: number, into = bad) => {
    const ax = Math.max(x0, Math.floor(toCell(lx - half, scale)) - 1), bx = Math.min(x0 + nx - 1, Math.ceil(toCell(rx + half, scale)) + 1);
    const ay = Math.max(y0, Math.floor(toCell(ly - half, scale)) - 1), by = Math.min(y0 + ny - 1, Math.ceil(toCell(ry + half, scale)) + 1);
    for (let j = ay; j <= by; j++) for (let i = ax; i <= bx; i++) {
      const cx = center(i), cy = center(j);
      if (lx < cx + half && rx > cx - half && ly < cy + half && ry > cy - half) into[(j - y0) * nx + (i - x0)] = 1;
    }
  };
  for (const b of obstacles.boxes) mark(b.left_top.x, b.left_top.y, b.right_bottom.x, b.right_bottom.y);
  for (const p of obstacles.water) mark(Math.floor(p.x), Math.floor(p.y), Math.floor(p.x) + 1, Math.floor(p.y) + 1);
  for (const b of obstacles.belts) mark(b.left_top.x, b.left_top.y, b.right_bottom.x, b.right_bottom.y, onBelt);
  const blocked = (cx: number, cy: number) => { const i = cx - x0, j = cy - y0; return i < 0 || j < 0 || i >= nx || j >= ny || bad[j * nx + i] === 1; };
  const belt = (cx: number, cy: number) => { const i = cx - x0, j = cy - y0; return i >= 0 && j >= 0 && i < nx && j < ny && onBelt[j * nx + i] === 1; };
  return { blocked, belt };
}

/** 路径压成几段直线 (方向不变的连续格子合成一段) */
export function straightRuns(path: P[]): P[] {
  const out: P[] = [];
  for (let i = 1; i < path.length; i++) {
    const d = (a: P, b: P) => `${Math.sign(b.x - a.x)},${Math.sign(b.y - a.y)}`;
    if (i + 1 < path.length && d(path[i - 1], path[i]) === d(path[i], path[i + 1])) continue;
    out.push(path[i]);
  }
  return out;
}

type Leg = { sx: number; sy: number; ticks: number };

function keysFor(controls: Controls, l: Leg) {
  const k: string[] = [];
  if (l.sy < 0) k.push(controls.key("move-up")); else if (l.sy > 0) k.push(controls.key("move-down"));
  if (l.sx < 0) k.push(controls.key("move-left")); else if (l.sx > 0) k.push(controls.key("move-right"));
  return k;
}

/** from → to 拆成按键: 一段斜走 (同时按两个键) + 一段直走; 小于 0.2 格的分量不走。路上的段本来就只有一种, 只有第一段和最后一段 (不在格子中心) 两种都有: 第一段先斜走回到路线上, 最后一段走到终点那格再斜 */
function legs(from: P, to: P, diagFirst: boolean): Leg[] {
  const dx = to.x - from.x, dy = to.y - from.y, ax = Math.abs(dx), ay = Math.abs(dy);
  const diag = Math.min(ax, ay), rest = Math.max(ax, ay) - diag;
  const d: Leg = { sx: Math.sign(dx), sy: Math.sign(dy), ticks: diag >= 0.2 ? Math.round((diag * Math.SQRT2) / SPEED) : 0 };
  const s: Leg = { sx: ax > ay ? Math.sign(dx) : 0, sy: ay > ax ? Math.sign(dy) : 0, ticks: rest >= 0.2 ? Math.round(rest / SPEED) : 0 };
  return (diagFirst ? [d, s] : [s, d]).filter((l) => l.ticks >= 1);
}

/**
 * 从 runs[start] 起连成一条按键时间线 (最多 BATCH_TICKS), 中途不读、不停: 每个拐弯都等读回的话, 真服上每拐一次多停 0.6 秒 (2026-11-06 沙盘 138 格 20 段走了 28 秒, 纯走路 15 秒)。
 * 下一段从算出来的位置接, 按 tick 取整的误差不累积。太长的一段切开, 没走完的 next 还指着它。
 */
function batch(controls: Controls, from: P, runs: P[], start: number, limit = BATCH_TICKS) {
  const spans = new Map<string, [number, number][]>();
  let t = 0, pos = from, i = start, segments = 0, full = false;
  for (; i < runs.length && !full; i++) {
    for (const l of legs(pos, runs[i], i === 0 && runs.length > 1)) {
      const ticks = Math.min(l.ticks, limit - t);
      if (ticks < 1) { full = true; break; }
      if (ticks < l.ticks) full = true;
      for (const k of keysFor(controls, l)) {
        const s = spans.get(k) ?? [];
        const prev = s.at(-1);
        if (prev && prev[1] === t - 1) prev[1] = t + ticks - 1; else s.push([t, t + ticks - 1]);
        spans.set(k, s);
      }
      t += ticks; segments++;
      const v = l.sx && l.sy ? SPEED / Math.SQRT2 : SPEED;
      pos = { x: pos.x + l.sx * v * ticks, y: pos.y + l.sy * v * ticks };
      if (full) break;
    }
    if (full) break;
  }
  const line = new Timeline();
  for (const [k, s] of spans) for (const [a, b] of s) line.holdKey(k, a, b);
  return { entries: line.entries, segments, next: i, end: pos };
}

/** 一条按键时间线最多走多久 (7.5 秒约 67 格), 走完读一次位置纠偏; 也是能让它停下的最小单位 */
const BATCH_TICKS = 450;
/** 重算过就是实际和算的对不上了 (传送带在推、被挡了): 走短一点勤读位置, 不然后面的键把角色顶进夹角 (2026-11-07 朋友存档副本) */
const CAREFUL_TICKS = 90;
/** 键松开之后还比这快, 才算还在靠按键走 (格/tick); 最快的传送带 0.125 */
const BELT_MAX = 0.13;
/** 还在靠近目标时重算不算失败, 这是总次数的上限; 没进展的次数看 maxReplans */
const MAX_ATTEMPTS = 30;
/** 楔住了斜着推多久 */
const WIGGLE_TICKS = 15;
/** 键松开之后还这么快 (格/tick) 就是站在带子上被运着; 最慢的带子 0.03125 */
const CARRIED_SPEED = 0.02;
/**
 * 站在带子上停不住, 容差放宽这么多: 逆着黄带走时, 延迟里往回漂约 1.4 格, 下一轮距离 = 0.2×上一轮 + 1.4, 收敛在 1.75 格, 再怎么重算也进不了 1 格的容差。
 * 真要站得准得先离开带子; 够得着东西的距离 (10 格) 也不差这点。
 */
const CARRIED_TOLERANCE = 1.5;
/** 按键落到游戏状态最多要多久: 客户端日志 latency 32 tick, 留几帧余量 (真服网络再慢, 角色一动起来就不靠这个数了) */
const LATENCY_TICKS = 45;
/** 连续这么多 tick 位置不变, 算停下了 (跑速下早该走出 0.9 格) */
const STILL_TICKS = 6;

/**
 * 等这一段真走完再读位置。按键过了网络延迟才落到游戏状态, hold 回来时角色可能才走了一半, 固定等一小会儿读到的是半路:
 * 2026-11-06 注入客户端的程序 存档副本 8 格走了 6 段还重算 1 次, 读到 88.46 报到了, 其实还在往回走, 停在 84.75 (RCON 真值)。
 * 动过的: 停够 STILL_TICKS 才算到; 一直没动的: 等够 LATENCY_TICKS 才算挡住。
 * 不能一直等到停: 站在传送带上永远在动。2026-11-07 朋友存档副本逐 tick 看到: 按键走到 y 210, 再被黄带一路运回 y 217.6, 读到"只动了 0.06 格"当成卡住, 重算 5 次全这样。
 * input 回来时键已经放完, 只剩网络延迟, 过了 LATENCY_TICKS 还慢慢在动的就是带子, 这时就读。
 */
async function settled(call: Call, from: P) {
  const first = await readPlayer(call);
  const t0 = first.tick ?? Date.now() / 16.7;
  let last = first.position!, lastT = t0, reads = 1, stillSince = t0, carried = false;
  for (let i = 0; i < 60; i++) {
    await sleep(40);
    const now = await readPlayer(call); reads++;
    const p = now.position!, t = now.tick ?? Date.now() / 16.7;
    const step = Math.hypot(p.x - last.x, p.y - last.y), speed = step / Math.max(t - lastT, 1);
    if (step >= 0.01) stillSince = t;
    last = p; lastT = t;
    const moved = Math.hypot(p.x - from.x, p.y - from.y) >= 0.05;
    if (moved && t - stillSince >= STILL_TICKS) break;
    if (t - t0 >= LATENCY_TICKS && speed < BELT_MAX) { carried = speed >= CARRIED_SPEED; break; }
  }
  return { at: last, reads, carried };
}

/**
 * 楔住了: 夹在两个东西的角里, 单按哪个方向都不动 (2026-11-07 朋友存档副本: 卡在两根管道的夹角, 东南西北各推几十 tick 都是 0)。先四个斜向 (夹角要斜着才出得来), 再四个正向; 同类里朝目标的优先。动了回新位置, 都不动回 null。
 */
async function wiggle(call: Call, controls: Controls, me: P, goal: P): Promise<{ at: P; reads: number } | null> {
  const towards = (d: number[]) => d[0] * (goal.x - me.x) + d[1] * (goal.y - me.y);
  const dirs = [...[[1, 1], [1, -1], [-1, 1], [-1, -1]].sort((a, b) => towards(b) - towards(a)), ...[[1, 0], [-1, 0], [0, 1], [0, -1]].sort((a, b) => towards(b) - towards(a))];
  let reads = 0;
  for (const [sx, sy] of dirs) {
    const line = new Timeline();
    for (const k of keysFor(controls, { sx, sy, ticks: WIGGLE_TICKS })) line.key(k, 0, WIGGLE_TICKS - 1);
    const r = await call("input", { timeline: line.entries });
    if (!r.ok) throw new Error(`按键失败: ${r.error}`);
    const s = await settled(call, me);
    reads += s.reads;
    if (Math.hypot(s.at.x - me.x, s.at.y - me.y) >= 0.05) return { at: s.at, reads };
  }
  return null;
}

/**
 * 走到 goal 附近 (tolerance 格内)。只用客户端能做的: 读障碍 → 自己算路 → 按方向键一段段走 → 读位置纠偏; 偏离或卡住就从当前位置重算。
 * 动作只报已发出 (注入客户端的程序 规矩), 位置靠每段走完后读回。
 */
export async function walkTo(call: Call, controls: Controls, goal: P, opts: { tolerance?: number; margin?: number; maxReplans?: number; /** 过了这个时刻 (Date.now()) 不再发新的按键, 回 timedOut */ deadline?: number; /** 走到离 goal 这么近的任意空位就算到 (goal 本身可以在机器里) */ within?: number } = {}): Promise<{ arrived: boolean; at: P; reason?: string; timedOut?: boolean; /** 停下时脚下的带子还在运人: 报的位置马上就不准了 */ carried?: boolean; replans: number; segments: number; reads: number; path: number }> {
  const within = opts.within ?? 0, tol = (opts.tolerance ?? 0.8) + within;
  const stats = { replans: 0, segments: 0, reads: 0, path: 0 };
  const t0 = Date.now();
  // 走得久的留一行, 看得出慢在哪 (段数多 = 路绕; 重算多 = 读到的和走的对不上)
  const done = <T extends { arrived: boolean }>(r: T): T => { const s = (Date.now() - t0) / 1000; if (s > 5) console.error(`  [走路] 到 (${goal.x},${goal.y}) ${r.arrived ? "到了" : "没到"}, ${s.toFixed(1)} 秒, ${stats.segments} 段, 重算 ${stats.replans} 次, 路 ${stats.path} 格`); return r; };
  const toGoal = (p: P) => Math.hypot(p.x - goal.x, p.y - goal.y);
  // 只有没进展才算失败: 一路靠近目标、只是被带子推偏了也算次数的话, 走得再对也会放弃
  let best = Infinity, noProgress = 0, careful = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let me = (await readPlayer(call)).position!; stats.reads++;
    if (toGoal(me) <= tol) return done({ arrived: true, at: me, ...stats });
    if (opts.deadline && Date.now() > opts.deadline) return done({ arrived: false, timedOut: true, at: me, reason: "时间到了, 还在路上", ...stats });
    best = Math.min(best, toGoal(me));
    // 先整格, 走不通细化到半格走缝, 还不通扩大范围 (绕得远的路)
    let path: P[] | null = null, searched = 0, seen: { obstacles: { boxes: Box[]; water: P[]; belts: Box[] }; area: Box } | null = null;
    for (const margin of opts.margin ? [opts.margin] : MARGINS) {
      const area = { left_top: { x: Math.min(me.x, goal.x) - margin, y: Math.min(me.y, goal.y) - margin }, right_bottom: { x: Math.max(me.x, goal.x) + margin, y: Math.max(me.y, goal.y) + margin } };
      let obstacles: { boxes: Box[]; water: P[]; belts: Box[] };
      try { obstacles = await readObstacles(call, area); } catch (e) { if (!searched) throw e; break; } // 范围太大读不全: 就按已经找过的报
      searched = margin;
      seen = { obstacles, area };
      for (const grid of GRIDS) { path = planOn(me, goal, within, obstacles, area, grid); if (path) break; }
      if (path) break;
    }
    // 自己在小口袋里: 推出来再算; 不是口袋才是目标真的到不了
    if (!path && seen && inPocket(me, seen.obstacles, seen.area) && noProgress <= (opts.maxReplans ?? 4)) {
      noProgress++; stats.replans++; careful = true;
      const out = await wiggle(call, controls, me, goal);
      if (out) { stats.reads += out.reads; continue; }
    }
    if (!path) return done({ arrived: false, at: me, reason: within ? `够得着的范围内没有走得到的空位 (周围 ${searched} 格内被围住)` : `算不出路 (周围 ${searched} 格内, 终点被围住或在水里)`, ...stats });
    stats.path = path.length;
    const runs = straightRuns(path);
    // 最后一段直接朝真正的终点 (起点终点同一格时路压出来是空的); within 时终点是路的最后一格, goal 本身可能在机器里
    if (!within) { if (runs.length) runs[runs.length - 1] = goal; else runs.push(goal); }
    // 读障碍要时间, 站在带子上这会儿已经被运走了: 从现在的位置起算
    me = (await readPlayer(call)).position!; stats.reads++;
    const started = me;
    let carried = false;
    for (let i = 0; i < runs.length;) {
      if (opts.deadline && Date.now() > opts.deadline) return done({ arrived: false, timedOut: true, at: me, reason: "时间到了, 还在路上", ...stats });
      const b = batch(controls, me, runs, i, careful ? CAREFUL_TICKS : BATCH_TICKS);
      i = b.next;
      if (!b.entries.length) continue; // 这段已经在脚下
      const r = await call("input", { timeline: b.entries });
      if (!r.ok) throw new Error(`按键失败: ${r.error}`);
      stats.segments += b.segments;
      const before = me;
      const s = await settled(call, before);
      me = s.at; stats.reads += s.reads; carried = s.carried;
      // 没动 (被挡住了) 或走偏了: 从当前位置重算
      if (Math.hypot(me.x - before.x, me.y - before.y) < 0.05 || Math.hypot(b.end.x - me.x, b.end.y - me.y) > 1.5) break;
    }
    if (toGoal(me) <= tol + (carried ? CARRIED_TOLERANCE : 0)) return done({ arrived: true, at: me, carried, ...stats });
    stats.replans++;
    careful = true;
    if (toGoal(me) < best - 1) best = toGoal(me);
    else if (++noProgress > (opts.maxReplans ?? 4)) break;
    // 这一轮按了那么多键一点没动: 楔住了, 重算出来还是同一条路, 先推出来
    if (Math.hypot(me.x - started.x, me.y - started.y) < 0.05) {
      const out = await wiggle(call, controls, me, goal);
      if (out) { stats.reads += out.reads; me = out.at; }
    }
  }
  const me = (await readPlayer(call)).position!;
  return done({ arrived: toGoal(me) <= tol, at: me, reason: "重算次数用完", ...stats });
}
