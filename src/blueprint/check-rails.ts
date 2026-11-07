// 铁轨连通、落点网格、信号位置 (静态): 几何全部来自沙盘引擎导出的 rail-geometry.json (npm run lab:dump), 不手写曲轨 / 斜轨的端点。
// 规则 (2.1.24 实测): 两段铁轨相接 = 一段的某一端 (位置, 出口方向) 等于另一段某一端的位置、方向差 8;
// 信号只能放在引擎认可的 (相对铁轨的偏移, 朝向) 上 —— 引擎只认"铁轨在信号的某一侧、信号面朝来车": 这同时就是"信号在行进方向右侧"的规则。
import { type RailGeometry, railDirGeometry, railEndsOf, railLayerOf } from "./rail-geometry.ts";
import { DIRV } from "./rules.ts";
import { type Finding, type Layout, type Placed, Union, key } from "./placed.ts";

export function checkRails(L: Layout, geom: RailGeometry | null, zh: (n: string) => string): Finding[] {
  const out: Finding[] = [];
  const rails = L.placed.filter((p) => p.r.rail && p.r.type !== "rail-support"); // 支架不是轨 (没有端点)
  const signals = L.placed.filter((p) => p.r.type === "rail-signal" || p.r.type === "rail-chain-signal");
  const stops = L.placed.filter((p) => p.r.type === "train-stop");

  // 车站: 铁轨要在车站朝向的左手边 2 格 (= 列车行进方向的右手边是车站) —— 沙盘实测 (compare-trains, connected_rail)
  for (const p of stops) {
    const [fx, fy] = DIRV[p.dir as 0 | 4 | 8 | 12] ?? [0, -1];
    const [lx, ly] = [fy, -fx];
    const rx = p.e.position.x + lx * 2, ry = p.e.position.y + ly * 2;
    const rail = rails.find((q) => Math.abs(q.e.position.x - rx) < 1 && Math.abs(q.e.position.y - ry) < 1);
    if (!rail) out.push({ level: "error", kind: "train-stop-no-rail", msg: `车站"${(p.e as { station?: string }).station ?? ""}"朝向的左手边 2 格没有铁轨 (车站要在列车行进方向的右侧)`, at: p.e.position, entity: p.e.name });
  }
  if (!rails.length) {
    if (signals.length) out.push({ level: "error", kind: "signal-no-rail", msg: `有 ${signals.length} 个信号但没有铁轨` });
    return out;
  }
  if (!geom) {
    out.push({ level: "info", kind: "rail-geometry-missing", msg: `没有铁轨几何表 (先跑 npm run lab:dump), 跳过铁轨连通和信号检查` });
    return out;
  }

  // 1. 落点网格 (每种铁轨每个朝向的奇偶来自引擎)
  const offGrid: Placed[] = [];
  const unknownDir: Placed[] = [];
  const ends = new Map<string, { p: Placed; dir: number }[]>(); // 位置 -> 端点
  const ugeom = (p: Placed) => railDirGeometry(geom, p.e.name, p.dir);
  for (const p of rails) {
    const g = ugeom(p);
    const pends = railEndsOf(geom, p.e.name, p.dir);
    if (!g && !pends) { unknownDir.push(p); continue; }
    const mod = (v: number, m: number) => ((v % m) + m) % m;
    if (g && (mod(p.e.position.x, 2) !== g.grid[0] || mod(p.e.position.y, 2) !== g.grid[1])) offGrid.push(p);
    for (const e of pends ?? []) {
      const k = `${e.layer}|${key(p.e.position.x + e.dx, p.e.position.y + e.dy)}`; // 分层: 高架轨的端点和同一位置的地面轨不相连
      const l = ends.get(k) ?? [];
      l.push({ p, dir: e.dir });
      ends.set(k, l);
    }
  }
  if (unknownDir.length) out.push({ level: "info", kind: "rail-unknown", msg: `${unknownDir.length} 段铁轨的种类 / 朝向不在几何表里 (例 ${zh(unknownDir[0].e.name)} 朝向 ${unknownDir[0].dir}), 没查` });
  if (offGrid.length) out.push({ level: "error", kind: "rail-off-grid", msg: `${offGrid.length} 段铁轨不在引擎要求的网格上 (例 ${zh(offGrid[0].e.name)} (${offGrid[0].e.position.x},${offGrid[0].e.position.y}))` });

  // 2. 连通: 同一位置、方向相反的两端相接; 同一位置但方向对不上 = 接错
  const net = new Union();
  for (const p of rails) net.add(p.e.entity_number);
  let dangling = 0, misaligned = 0;
  const dangSamples: string[] = [];
  for (const [k, list] of ends) {
    for (const a of list) {
      const mate = list.find((b) => b.p !== a.p && (b.dir + 8) % 16 === a.dir);
      if (mate) { net.join(a.p.e.entity_number, mate.p.e.entity_number); continue; }
      const other = list.find((b) => b.p !== a.p);
      if (other) {
        misaligned++;
        if (misaligned <= 5) out.push({ level: "warn", kind: "rail-misaligned", msg: `铁轨端点 (${k}) 有两段碰头但方向对不上: ${zh(a.p.e.name)} 出口朝 ${a.dir}, ${zh(other.p.e.name)} 出口朝 ${other.dir}`, at: a.p.e.position, entity: a.p.e.name });
      } else {
        dangling++;
        if (dangSamples.length < 3) dangSamples.push(`(${k})`);
      }
    }
  }
  if (misaligned > 5) out.push({ level: "warn", kind: "rail-misaligned", msg: `…还有 ${misaligned - 5} 处铁轨端点对不上` });
  const comps = new Set(rails.map((p) => net.find(p.e.entity_number))).size;
  if (comps > 1) out.push({ level: "warn", kind: "rail-components", msg: `铁路分成 ${comps} 段互不相连的网` });
  if (dangling) out.push({ level: "info", kind: "rail-dead-end", msg: `铁轨尽头 ${dangling} 处 (没有接上别的轨; 例 ${dangSamples.join(" ")})` });

  // 3. 信号: (相对某段铁轨的偏移, 朝向) 必须在引擎认可的表里
  let badSignal = 0;
  const railAt = new Map<string, Placed[]>();
  for (const p of rails) {
    for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) {
      const k = key(Math.floor(p.e.position.x + dx), Math.floor(p.e.position.y + dy));
      const l = railAt.get(k) ?? [];
      l.push(p);
      railAt.set(k, l);
    }
  }
  for (const s of signals) {
    const sLayer = (s.e as { rail_layer?: string }).rail_layer === "elevated" ? "E" : "G"; // 蓝图 / 快照里信号的 rail_layer
    const near = (railAt.get(key(Math.floor(s.e.position.x), Math.floor(s.e.position.y))) ?? []).filter((p) => railLayerOf(p.e.name) === sLayer);
    const ok = near.some((p) => {
      const g = ugeom(p);
      if (!g) return false;
      const dx = s.e.position.x - p.e.position.x, dy = s.e.position.y - p.e.position.y;
      return (Array.isArray(g.signals) ? g.signals : []).some(([x, y, d]) => Math.abs(x - dx) < 0.01 && Math.abs(y - dy) < 0.01 && d === s.dir);
    });
    if (!ok) {
      badSignal++;
      if (badSignal <= 10) out.push({ level: "error", kind: "signal-misplaced", msg: `${zh(s.e.name)} (${s.e.position.x},${s.e.position.y}) 朝向 ${s.dir} 不在任何铁轨旁的合法位置上 (信号要贴着轨、面朝来车 = 在行进方向右侧)`, at: s.e.position, entity: s.e.name });
    }
  }
  if (badSignal > 10) out.push({ level: "error", kind: "signal-misplaced", msg: `…还有 ${badSignal - 10} 个信号位置不合法` });
  return out;
}
