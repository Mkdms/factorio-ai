// 传送带的上下游连续性和侧向汇入 (静态): 每条带子往前送到哪一格, 那一格的东西接不接 (分流器只从背后接、地下带的罩子一侧不接),
// 整段带子有没有来源 (机械臂放货、采矿机出料、分流器 / 地下带的上游) 和去处 (机械臂取货)。
// 侧向汇入的规则来自沙盘核实 (knowledge/facts.md 第四批): 上游没带子就变弯道, 两侧都汇或有上游才是直带; 侧向只上靠来向的那一道。
import { DIRV, rotate } from "./rules.ts";
import { type Finding, type Layout, type Placed, Union } from "./placed.ts";

type Dir4 = 0 | 4 | 8 | 12;
const d4 = (d: number): Dir4 => (((Math.round(d / 4) % 4) + 4) % 4) * 4 as Dir4;
const opposite = (d: Dir4): Dir4 => ((d + 8) % 16) as Dir4;
const ugType = (p: Placed) => (p.e as { type?: string }).type;

/** 这件东西往哪些格子送货 (传送带 1 格; 分流器 2 格; 地下带入口不往地面送) */
function outputs(p: Placed): { x: number; y: number }[] {
  const d = d4(p.dir);
  const [dx, dy] = DIRV[d];
  switch (p.r.type) {
    case "transport-belt":
    case "lane-splitter":
    case "linked-belt":
      return [{ x: p.e.position.x + dx, y: p.e.position.y + dy }];
    case "underground-belt":
      return ugType(p) === "output" ? [{ x: p.e.position.x + dx, y: p.e.position.y + dy }] : [];
    case "splitter": {
      // 分流器横跨 2 格 (朝北时 x 方向); 两格各自往前送
      const out: { x: number; y: number }[] = [];
      for (let x = p.x1; x <= p.x2; x++) for (let y = p.y1; y <= p.y2; y++) out.push({ x: x + 0.5 + dx, y: y + 0.5 + dy });
      return out;
    }
    default:
      return [];
  }
}

/** q 接不接从方向 d 送来的货 (货从 q 的某一侧进入): "behind" 顺着走, "side" 侧向, "front" 迎头, "none" 不接 */
function accepts(q: Placed, d: Dir4): "behind" | "side" | "front" | "none" {
  const qd = d4(q.dir);
  const rel = d === qd ? "behind" : d === opposite(qd) ? "front" : "side";
  switch (q.r.type) {
    case "transport-belt":
    case "lane-splitter":
    case "linked-belt":
      return rel === "front" ? "none" : rel;
    case "underground-belt":
      // 入口: 背后进、侧面进 (侧向汇入只上一道, 常用来过滤道); 罩子那面不进。出口: 背后是隧道, 只接侧面
      if (ugType(q) === "input") return rel === "front" ? "none" : rel;
      return rel === "side" ? "side" : "none";
    case "splitter":
      return rel === "behind" ? "behind" : "none";
    case "loader":
    case "loader-1x1":
      // 装货 (input) 的从带子那头接货; 卸货 (output) 的往外出, 不接 (2026-11-02: 原来没有这一类, 吞吐实验的带子→装卸机全被误报)
      return ugType(q) === "output" ? "none" : rel === "front" ? "none" : rel;
    default:
      return "none";
  }
}

export function checkBelts(L: Layout, zh: (n: string) => string): Finding[] {
  const out: Finding[] = [];
  const belts = L.placed.filter((p) => p.r.beltLike);
  if (!belts.length) return out;
  const chains = new Union();
  for (const p of belts) chains.add(p.e.entity_number);
  const feeds = new Map<number, { from: Placed; how: "behind" | "side" }[]>(); // 谁往这件东西送货
  let blocked = 0, intoBuilding = 0, ends = 0;
  const endSamples: string[] = [];
  const noOutput: [number, number][] = []; // 引擎 belt_neighbours.outputs 为空的那些 (给沙盘核对逐个对位置)
  for (const p of belts) {
    const d = d4(p.dir);
    const targets = outputs(p);
    // 按件数算 (和引擎 belt_neighbours.outputs 一致): 分流器两格里有一格接上就算接上
    let connected = false, building = false, blockedHere: Placed | null = null, headOn = false;
    for (const t of targets) {
      const here = L.at(t.x, t.y);
      const q = here.find((x) => x.r.beltLike && x !== p);
      if (q) {
        const how = accepts(q, d);
        if (how === "none") {
          // 迎头相对单独算 (check.ts 已报错误); 这里报"顶着不接的那一面"
          if (d4(q.dir) === opposite(d) && q.r.type === "transport-belt") headOn = true; else blockedHere = q;
          continue;
        }
        connected = true;
        chains.join(p.e.entity_number, q.e.entity_number);
        const list = feeds.get(q.e.entity_number) ?? [];
        list.push({ from: p, how: how === "front" ? "behind" : how });
        feeds.set(q.e.entity_number, list);
      } else if (here.length) building = true;
    }
    if (targets.length && !connected) {
      noOutput.push([p.e.position.x, p.e.position.y]);
      if (blockedHere) {
        blocked++;
        if (blocked <= 10) out.push({ level: "warn", kind: "belt-blocked", msg: `${zh(p.e.name)} (${p.e.position.x},${p.e.position.y}) 顶着 ${zh(blockedHere.e.name)} 不接货的那一面 (分流器只从背后接, 地下带的罩子不接), 货过不去`, at: p.e.position, entity: p.e.name });
      } else if (headOn) {
        // check.ts 已报 belt-head-on
      } else if (building) intoBuilding++;
      else {
        ends++;
        if (endSamples.length < 3) endSamples.push(`(${p.e.position.x},${p.e.position.y})`);
      }
    }
    // 地下带入口 → 出口 (check.ts 已查配对; 这里只把两头连成一段)
    if (p.r.type === "underground-belt" && ugType(p) === "input") {
      const [dx, dy] = DIRV[d];
      for (let i = 1; i <= (p.r.undergroundBeltMax ?? 0); i++) {
        const q = L.at(p.e.position.x + dx * i, p.e.position.y + dy * i).find((q) => q.e.name === p.e.name);
        if (q && ugType(q) === "output" && d4(q.dir) === d) { chains.join(p.e.entity_number, q.e.entity_number); break; }
        if (q && ugType(q) === "input" && d4(q.dir) === d) break;
      }
    }
  }
  if (blocked > 10) out.push({ level: "warn", kind: "belt-blocked", msg: `…还有 ${blocked - 10} 处传送带顶着不接货的那一面` });

  // 侧向汇入 vs 弯道: 有上游 (或两侧都汇) 的直带被侧向汇入; 只有一侧汇入、没上游的是弯道
  let sideLoads = 0;
  const curves: [number, number][] = [];
  for (const p of belts) {
    if (p.r.type !== "transport-belt") continue;
    const f = feeds.get(p.e.entity_number) ?? [];
    const behind = f.some((x) => x.how === "behind");
    const sides = f.filter((x) => x.how === "side").length;
    if (sides === 1 && !behind) curves.push([p.e.position.x, p.e.position.y]);
    else sideLoads += sides;
  }
  if (sideLoads) out.push({ level: "info", kind: "belt-side-load", msg: `侧向汇入 ${sideLoads} 处 (只上靠来向的那一道; 沙盘核实 belt.sideload)` });
  if (curves.length) out.push({ level: "info", kind: "belt-curve", msg: `弯道 ${curves.length} 处`, data: curves });
  if (intoBuilding) out.push({ level: "info", kind: "belt-into-building", msg: `${intoBuilding} 条传送带的尽头顶着建筑 (货停在那里, 靠机械臂取)` });
  if (ends) out.push({ level: "info", kind: "belt-end", msg: `${ends} 处传送带尽头前面是空地 (例 ${endSamples.join(" ")})`, data: noOutput });

  // 整段的来源和去处: 机械臂放货 / 采矿机出料 = 来源; 机械臂取货 = 去处
  const chainOf = (p: Placed) => chains.find(p.e.entity_number);
  const sources = new Set<number>(), sinks = new Set<number>();
  const beltAt = (x: number, y: number) => L.at(x, y).find((q) => q.r.beltLike);
  for (const p of L.placed) {
    if (p.r.inserter) {
      const [px, py] = rotate(p.r.inserter.pickup[0], p.r.inserter.pickup[1], p.dir);
      const [qx, qy] = rotate(p.r.inserter.drop[0], p.r.inserter.drop[1], p.dir);
      const pick = beltAt(p.e.position.x + px, p.e.position.y + py);
      const drop = beltAt(p.e.position.x + qx, p.e.position.y + qy);
      if (pick) sinks.add(chainOf(pick));
      if (drop) sources.add(chainOf(drop));
    }
    if (p.r.dropVector) {
      const [vx, vy] = rotate(p.r.dropVector[0], p.r.dropVector[1], p.dir);
      const b = beltAt(p.e.position.x + vx, p.e.position.y + vy);
      if (b) sources.add(chainOf(b));
    }
    if (p.r.type === "loader" || p.r.type === "loader-1x1") {
      // 装卸机两头都可能是来源或去处, 看不出方向意图, 两边都算
      for (const t of outputs({ ...p, r: { ...p.r, type: "transport-belt" } })) { const b = beltAt(t.x, t.y); if (b) { sources.add(chainOf(b)); sinks.add(chainOf(b)); } }
    }
  }
  const members = new Map<number, Placed[]>();
  for (const p of belts) { const c = chainOf(p); const l = members.get(c) ?? []; l.push(p); members.set(c, l); }
  const noSource: Placed[][] = [], noSink: Placed[][] = [];
  for (const [c, list] of members) {
    // 单件 (或 2 件) 的碎段多半是设计里的垫片, 不吵
    if (list.length < 3) continue;
    if (!sources.has(c)) noSource.push(list);
    if (!sinks.has(c)) noSink.push(list);
  }
  const head = (list: Placed[]) => { const p = list[0]; return `(${p.e.position.x},${p.e.position.y})`; };
  if (noSource.length) out.push({ level: "warn", kind: "belt-no-source", msg: `${noSource.length} 段传送带 (≥3 件) 没有任何来源 (没有机械臂往上放货、没有采矿机出料; 从蓝图外进货的话可以忽略), 例 ${noSource.slice(0, 3).map(head).join(" ")}` });
  if (noSink.length) out.push({ level: "info", kind: "belt-no-sink", msg: `${noSink.length} 段传送带 (≥3 件) 没有机械臂取货 (货只会堆满; 送出蓝图外的话可以忽略), 例 ${noSink.slice(0, 3).map(head).join(" ")}` });
  return out;
}

