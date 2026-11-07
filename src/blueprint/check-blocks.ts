// 区段长度 vs 最长列车 (trains.md T2: 出口普通信号后面那段要放得下全网最长的一列车, 不然车停下等时车尾压住后面的路口)。
// 做法: 铁轨按端点连成图 (几何来自 rail-geometry.json); 每个信号落在它所贴铁轨离它最近的那个端点 = 区段分界; 没被分界切开的铁轨并成一个区段,
// 长度按每段铁轨两端点的直线距离累加 (弯道略算短, 宁可多报)。只查"普通信号保护的、出口也有信号"的区段 (列车可能在里面停下等); 联锁信号后面的路口区段本来就短, 不查。
// 标准列车长度是设计参数, 还没定: 默认 1-2-1 (4 节 × 7 格), 用 trainCars 改。
import { type RailGeometry, railDirGeometry, railEndsOf, railLayerOf } from "./rail-geometry.ts";
import { type Finding, type Layout, type Placed, Union, key } from "./placed.ts";

export const CAR_LENGTH = 7; // 机车 / 车厢中心距 (沙盘里拼车用 7 格, trains.ts)
export const DEFAULT_TRAIN_CARS = 4; // 临时: 1-2-1, 等定标准列车

export function checkBlocks(L: Layout, geom: RailGeometry | null, zh: (n: string) => string, trainCars = DEFAULT_TRAIN_CARS): Finding[] {
  const out: Finding[] = [];
  if (!geom) return out;
  const rails = L.placed.filter((p) => p.r.rail && p.r.type !== "rail-support");
  const signals = L.placed.filter((p) => p.r.type === "rail-signal" || p.r.type === "rail-chain-signal");
  if (!rails.length || !signals.length) return out;
  const g = (p: Placed) => railDirGeometry(geom, p.e.name, p.dir);

  // 端点: 位置 -> [{铁轨, 出口方向}]; 每段铁轨的长度 (两端直线距离)
  const joints = new Map<string, { p: Placed; dir: number }[]>();
  const len = new Map<number, number>();
  for (const p of rails) {
    const ends = railEndsOf(geom, p.e.name, p.dir);
    if (!ends || ends.length < 2) continue;
    for (const e of ends) {
      const k = `${e.layer}|${key(p.e.position.x + e.dx, p.e.position.y + e.dy)}`;
      joints.set(k, [...(joints.get(k) ?? []), { p, dir: e.dir }]);
    }
    len.set(p.e.entity_number, Math.hypot(ends[0].dx - ends[1].dx, ends[0].dy - ends[1].dy));
  }

  // 信号 -> 它贴的铁轨 (偏移和朝向在引擎的合法表里) -> 离它最近的端点 = 分界接头
  const cut = new Map<string, { s: Placed; dir: number }[]>(); // 接头 -> 信号 (dir = 信号朝向)
  for (const s of signals) {
    let best: { k: string; d: number } | null = null;
    for (const p of rails) {
      const gg = g(p);
      if (!gg) continue;
      const dx = s.e.position.x - p.e.position.x, dy = s.e.position.y - p.e.position.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) continue;
      const legal = (Array.isArray(gg.signals) ? gg.signals : []).some(([x, y, d]) => Math.abs(x - dx) < 0.01 && Math.abs(y - dy) < 0.01 && d === s.dir);
      if (!legal) continue;
      if (railLayerOf(p.e.name) !== ((s.e as { rail_layer?: string }).rail_layer === "elevated" ? "E" : "G")) continue;
      for (const e of railEndsOf(geom, p.e.name, p.dir) ?? []) {
        const d = Math.hypot(p.e.position.x + e.dx - s.e.position.x, p.e.position.y + e.dy - s.e.position.y);
        if (!best || d < best.d) best = { k: `${e.layer}|${key(p.e.position.x + e.dx, p.e.position.y + e.dy)}`, d };
      }
    }
    if (best) cut.set(best.k, [...(cut.get(best.k) ?? []), { s, dir: s.dir }]);
  }

  // 区段 = 不经过分界接头连起来的铁轨
  const u = new Union();
  for (const p of rails) u.add(p.e.entity_number);
  for (const [k, list] of joints) {
    if (cut.has(k)) continue;
    for (let i = 1; i < list.length; i++) u.join(list[0].p.e.entity_number, list[i].p.e.entity_number); // 没被信号切开的接头 (含道岔) 上的铁轨同属一个区段
  }
  const blockLen = new Map<number, number>();
  for (const p of rails) { const b = u.find(p.e.entity_number); blockLen.set(b, (blockLen.get(b) ?? 0) + (len.get(p.e.entity_number) ?? 0)); }

  // 每个信号保护的区段: 列车行进方向 = 信号朝向 + 8; 接头上出口方向等于行进方向的那段是"来的", 另一段所在的区段是被保护的
  const entered = new Map<number, Placed[]>(); // 区段 -> 进它的普通信号
  const bounded = new Map<number, number>(); // 区段 -> 边界上的信号数
  for (const [k, sigs] of cut) {
    const list = joints.get(k) ?? [];
    for (const it of list) { const b = u.find(it.p.e.entity_number); bounded.set(b, (bounded.get(b) ?? 0) + sigs.length); }
    for (const { s, dir } of sigs) {
      const travel = (dir + 8) % 16;
      const into = list.find((it) => it.dir !== travel);
      if (!into || s.r.type !== "rail-signal") continue;
      const b = u.find(into.p.e.entity_number);
      entered.set(b, [...(entered.get(b) ?? []), s]);
    }
  }
  const need = trainCars * CAR_LENGTH;
  let short = 0, checked = 0, minLen = Infinity;
  for (const [b, sigs] of entered) {
    const l = blockLen.get(b) ?? 0;
    if ((bounded.get(b) ?? 0) < 2) continue; // 出口没有信号 (通往尽头 / 车站) 的不查
    checked++;
    minLen = Math.min(minLen, l);
    if (l >= need) continue;
    short++;
    if (short <= 10) out.push({ level: "warn", kind: "block-too-short", msg: `${zh(sigs[0].e.name)} (${sigs[0].e.position.x},${sigs[0].e.position.y}) 后面的区段只有约 ${l.toFixed(0)} 格, 放不下 ${trainCars} 节的列车 (约 ${need} 格): 车停下等时车尾压住后面的区段`, at: sigs[0].e.position, entity: sigs[0].e.name });
  }
  if (short > 10) out.push({ level: "warn", kind: "block-too-short", msg: `…还有 ${short - 10} 个区段放不下 ${trainCars} 节的列车` });
  // 统计 (看检查有没有真的在查: 信号找没找到接头、查了几个区段)
  const mapped = [...cut.values()].reduce((n, l) => n + l.length, 0);
  out.push({ level: "info", kind: "blocks", msg: `区段 ${new Set(rails.map((p) => u.find(p.e.entity_number))).size} 个; 信号 ${mapped}/${signals.length} 个找到接头; 普通信号后面、出口有信号的区段查了 ${checked} 个${checked ? `, 最短约 ${minLen.toFixed(0)} 格` : ""} (标准列车 ${trainCars} 节约 ${need} 格, 临时值)`, data: { mapped, signals: signals.length, checked, minLen } });
  return out;
}
