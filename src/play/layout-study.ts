// 把真实基地的一段生产线画成模型读得懂的字符图 + 算好的结构读数 (库, 不直接运行; ./bp study、放机器提示、./plan 用)。
// 要让模型看到, 参考真实基地自己学布局, 不是抄: 班次 10-16-30 第 70 分钟, ref/ 里 9 份经验 8 份读了 0 次, 朋友基地手册只有文字和数字没有图, 蓝图本身模型碰不到。
// 只给看和读数, 不给坐标、不给"这样摆"的结论 (架构 2b: 决定归模型); 蓝图原文只在本机 lab-data, 不进公开仓库。
import type { BpEntity } from "../blueprint/inspect.ts";
import { DIRV, type Rules } from "../blueprint/rules.ts";
import { footprint, type Placed } from "../blueprint/placed.ts";

const CRAFTERS = new Set(["assembling-machine", "furnace", "chemical-plant", "oil-refinery", "rocket-silo", "centrifuge", "lab"]);
const BELTS = new Set(["transport-belt", "underground-belt", "splitter"]);
/** 机械臂移动物品的方向 = direction 的反向 (direction 是取货方向; 仓库 CLAUDE.md 游戏事实) */
const ARM: Record<number, string> = { 0: "↓", 4: "←", 8: "↑", 12: "→" };
const LONG_ARM: Record<number, string> = { 0: "⇓", 4: "⇐", 8: "⇑", 12: "⇒" };
const BELT: Record<number, string> = { 0: "^", 4: ">", 8: "v", 12: "<" };
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

export type Block = { key: string; machines: Placed[]; x1: number; y1: number; x2: number; y2: number };

/** 这台机器按什么分组: 组装机 / 化工按配方, 炉子没配方按建筑名 */
export function machineKey(p: Placed): string | null {
  if (!CRAFTERS.has(p.r.type)) return null;
  return (p.e as { recipe?: string }).recipe ?? (p.r.type === "furnace" || p.r.type === "lab" ? p.e.name : null); // 研究中心没有配方, 按建筑名
}

export function placeAll(entities: BpEntity[], rules: Rules): Placed[] {
  const out: Placed[] = [];
  for (const e of entities) { const r = rules.get(e.name); if (r) out.push(footprint(e, r)); }
  return out;
}

/** 同一配方挨得近的机器聚成一段, 机器多的在前 */
export function blocksOf(placed: Placed[], key: string, gapX = 8, gapY = 10): Block[] {
  const ms = placed.filter((p) => machineKey(p) === key);
  const parent = ms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cx = (p: Placed) => (p.x1 + p.x2) / 2, cy = (p: Placed) => (p.y1 + p.y2) / 2;
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
    if (Math.abs(cx(ms[i]) - cx(ms[j])) <= gapX && Math.abs(cy(ms[i]) - cy(ms[j])) <= gapY) parent[find(i)] = find(j);
  }
  const groups = new Map<number, Placed[]>();
  ms.forEach((m, i) => { const g = groups.get(find(i)) ?? []; g.push(m); groups.set(find(i), g); });
  return [...groups.values()].map((g) => ({ key, machines: g, x1: Math.min(...g.map((m) => m.x1)), y1: Math.min(...g.map((m) => m.y1)), x2: Math.max(...g.map((m) => m.x2)), y2: Math.max(...g.map((m) => m.y2)) }))
    .sort((a, b) => b.machines.length - a.machines.length);
}

/** 块太大时只切一段: 从左上角起, 宽高不超过上限 */
function cropOf(b: Block, pad: number, maxW: number, maxH: number) {
  const x1 = b.x1 - pad, y1 = b.y1 - pad;
  return { x1, y1, x2: Math.min(b.x2 + pad, x1 + maxW - 1), y2: Math.min(b.y2 + pad, y1 + maxH - 1) };
}

function charOf(p: Placed, letter: (key: string) => string): string {
  const t = p.r.type;
  const key = machineKey(p);
  if (key) return letter(key);
  if (t === "transport-belt") return BELT[p.dir] ?? "?";
  if (t === "underground-belt") return "U";
  if (t === "splitter") return "S";
  if (t === "inserter") return (p.e.name.startsWith("long") ? LONG_ARM : ARM)[p.dir] ?? "?";
  if (t === "electric-pole") return "+";
  if (t === "pipe") return "=";
  if (t === "pipe-to-ground") return "n";
  if (t === "container") return "C";
  if (t === "logistic-container") return "Q";
  if (t === "lab") return "L";
  if (t === "roboport") return "R";
  if (t === "beacon") return "B";
  if (t === "mining-drill") return "D";
  if (t === "furnace") return "F";
  if (t === "wall") return "W";
  return "?";
}

export type Study = { map: string; legend: string; facts: string[]; machines: number; width: number; height: number; crop: [number, number, number, number] };

/** 这台机器的进出料: 机械臂从哪取、往哪放; 同一条带喂了几台 (带按走向连成线) */
export function readFacts(placed: Placed[], b: Block): string[] {
  const at = new Map<string, Placed[]>();
  for (const p of placed) for (let x = p.x1; x <= p.x2; x++) for (let y = p.y1; y <= p.y2; y++) { const k = `${x},${y}`; const l = at.get(k); if (l) l.push(p); else at.set(k, [p]); }
  const set = new Set(b.machines);
  // 带子连成线: 每格指向下一格
  const parent = new Map<Placed, Placed>();
  const find = (p: Placed): Placed => { let r = p; while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!; return r; };
  for (const p of placed) {
    if (!BELTS.has(p.r.type)) continue;
    if (!parent.has(p)) parent.set(p, p);
    const v = DIRV[p.dir];
    if (!v) continue;
    const next = (at.get(`${p.x1 + v[0]},${p.y1 + v[1]}`) ?? []).find((q) => BELTS.has(q.r.type));
    if (next) { if (!parent.has(next)) parent.set(next, next); parent.set(find(p), find(next)); }
  }
  let fromBelt = 0, fromFar = 0, fromMachine = 0, fromChest = 0, toBelt = 0, toMachine = 0, toChest = 0;
  const armsIn = new Map<Placed, number>();
  const fedBy = new Map<Placed, Set<Placed>>(); // 带线 → 它喂的机器
  const inLines = new Map<Placed, Set<Placed>>(); // 机器 → 喂它的带线
  const usedDirect = new Set<string>();
  for (const p of placed) {
    if (p.r.type !== "inserter") continue;
    const v = DIRV[p.dir];
    if (!v) continue;
    const reach = p.e.name.startsWith("long") ? 2 : 1;
    const from = at.get(`${p.x1 + v[0] * reach},${p.y1 + v[1] * reach}`) ?? [];
    const to = at.get(`${p.x1 - v[0] * reach},${p.y1 - v[1] * reach}`) ?? [];
    const dst = to.find((q) => set.has(q));
    const src = from.find((q) => set.has(q));
    if (dst) {
      armsIn.set(dst, (armsIn.get(dst) ?? 0) + 1);
      const belt = from.find((q) => BELTS.has(q.r.type));
      const machine = from.find((q) => CRAFTERS.has(q.r.type));
      if (belt) {
        if (reach === 2) fromFar++; else fromBelt++;
        const line = find(belt);
        (fedBy.get(line) ?? fedBy.set(line, new Set()).get(line)!).add(dst);
        (inLines.get(dst) ?? inLines.set(dst, new Set()).get(dst)!).add(line);
      } else if (machine) { fromMachine++; const n = machineKey(machine); if (n) usedDirect.add(n); }
      else if (from.some((q) => q.r.type === "container" || q.r.type === "logistic-container")) fromChest++;
    }
    if (src) {
      if (to.some((q) => BELTS.has(q.r.type))) toBelt++;
      else if (to.some((q) => CRAFTERS.has(q.r.type) || q.r.type === "lab")) toMachine++;
      else if (to.some((q) => q.r.type === "container" || q.r.type === "logistic-container")) toChest++;
    }
  }
  const n = b.machines.length;
  const facts: string[] = [`这种机器 ${n} 台`];
  const lines = [...fedBy.values()].map((s) => s.size).sort((a, c) => c - a);
  if (lines.length) {
    const perMachine = [...inLines.values()].map((s) => s.size);
    facts.push(`进料带 ${lines.length} 条, 分别喂 ${lines.slice(0, 8).join(" / ")} 台; 每台机器吃 ${Math.min(...perMachine)}~${Math.max(...perMachine)} 条带`);
  }
  const ins = [fromBelt && `贴带取 ${fromBelt}`, fromFar && `长臂隔一格取 ${fromFar}`, fromMachine && `上一台机器直接塞 ${fromMachine}`, fromChest && `从箱子取 ${fromChest}`].filter(Boolean);
  if (ins.length) facts.push(`进料机械臂: ${ins.join(", ")}`);
  const outs = [toBelt && `放上带 ${toBelt}`, toMachine && `直接塞进下一台 ${toMachine}`, toChest && `放进箱子 ${toChest}`].filter(Boolean);
  if (outs.length) facts.push(`出料机械臂: ${outs.join(", ")}`);
  return facts;
}

/** 字符图和图例; names 把内部名换成官方中文名 */
export function study(placed: Placed[], b: Block, names: (id: string) => string | undefined, opt: { pad?: number; maxW?: number; maxH?: number } = {}): Study {
  const c = cropOf(b, opt.pad ?? 5, opt.maxW ?? 72, opt.maxH ?? 34);
  const w = c.x2 - c.x1 + 1, h = c.y2 - c.y1 + 1;
  const grid = Array.from({ length: h }, () => Array<string>(w).fill("."));
  const letters = new Map<string, string>();
  const letter = (key: string) => {
    if (!letters.has(key)) letters.set(key, LETTERS[letters.size] ?? "?");
    return letters.get(key)!;
  };
  letter(b.key); // 主角永远是 a
  const seen = new Set<string>();
  for (const p of placed) {
    if (p.r.rail || p.x2 < c.x1 || p.x1 > c.x2 || p.y2 < c.y1 || p.y1 > c.y2) continue;
    const ch = charOf(p, letter);
    seen.add(ch);
    // 机器: 身子画 #, 中间一格写字母, 挨着放的几台才分得清
    const crafter = !!machineKey(p);
    const mx = Math.floor((p.x1 + p.x2) / 2), my = Math.floor((p.y1 + p.y2) / 2);
    for (let x = Math.max(p.x1, c.x1); x <= Math.min(p.x2, c.x2); x++) for (let y = Math.max(p.y1, c.y1); y <= Math.min(p.y2, c.y2); y++) grid[y - c.y1][x - c.x1] = crafter && !(x === mx && y === my) ? "#" : ch;
  }
  const inCrop = b.machines.filter((m) => m.x1 >= c.x1 && m.x2 <= c.x2 && m.y1 >= c.y1 && m.y2 <= c.y2);
  const parts = [...letters].map(([k, l]) => `${l}=${names(k) ?? k}`);
  const fixed: [string, string][] = [["^", "带子 ^>v< 带子走向"], ["U", "U=地下带"], ["S", "S=分流器"], ["+", "+=电线杆"], ["=", "= 水管"], ["n", "n=地下管"], ["C", "C=箱子"], ["Q", "Q=物流箱"], ["L", "L=研究中心"], ["R", "R=机器人指令平台"], ["B", "B=插件塔"], ["D", "D=矿机"], ["F", "F=炉子"]];
  const belts = [...seen].some((s) => "^>v<".includes(s));
  const arms = [...seen].some((s) => "↑→↓←".includes(s)), long = [...seen].some((s) => "⇑⇒⇓⇐".includes(s));
  const rest = fixed.filter(([s]) => (s === "^" ? belts : seen.has(s))).map(([, t]) => t);
  if (arms) rest.push("↑→↓← 机械臂 (箭头 = 货走的方向)");
  if (long) rest.push("⇑⇒⇓⇐ 长臂机械臂 (跨一格取放)");
  return { map: grid.map((r) => r.join("")).join("\n"), legend: [...parts, ...rest].join("  "), facts: readFacts(placed, b), machines: inCrop.length, width: w, height: h, crop: [c.x1, c.y1, c.x2 + 1, c.y2 + 1] };
}

/** 块周围的东西: 全星球几万件时只算这一片, 字符图和读数都够用 (全量算一次要半秒) */
export function nearBlock(placed: Placed[], b: Block, pad = 40): Placed[] {
  return placed.filter((p) => p.x2 >= b.x1 - pad && p.x1 <= b.x2 + pad && p.y2 >= b.y1 - pad && p.y1 <= b.y2 + pad);
}

const OVERVIEW_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** 整个地表的分区图: 每格是这一片数量最多的生产线; 只给事实, 怎么分区模型自己看 */
export function overview(placed: Placed[], names: (id: string) => string | undefined, opt: { maxW?: number; maxH?: number } = {}): { map: string; legend: string; facts: string[]; cell: number; origin: [number, number] } {
  const maxW = opt.maxW ?? 72, maxH = opt.maxH ?? 34;
  const used = placed.filter((p) => !p.r.rail);
  // 只画有机器的那片 + 外面一圈: 外圈的墙和炮塔能把范围撑大几倍, 核心就只剩几行 (新地星: 1370×1421 格里机器只占中间一小块)
  const machines = used.filter((p) => machineKey(p));
  const core = machines.length ? machines : used;
  const PAD = 32;
  const x1 = Math.min(...core.map((p) => p.x1)) - PAD, x2 = Math.max(...core.map((p) => p.x2)) + PAD, y1 = Math.min(...core.map((p) => p.y1)) - PAD, y2 = Math.max(...core.map((p) => p.y2)) + PAD;
  // 格子从 16 起翻倍, 一屏放得下为止
  let cell = 16;
  while ((x2 - x1 + 1) / cell > maxW || (y2 - y1 + 1) / cell > maxH) cell *= 2;
  const w = Math.floor((x2 - x1) / cell) + 1, h = Math.floor((y2 - y1) / cell) + 1;
  const cells = new Map<string, Map<string, number>>(), hasBelt = new Set<string>(), hasOther = new Set<string>();
  const total = new Map<string, number>();
  let belts = 0, arms = 0, poles = 0, roboports = 0;
  for (const p of used) {
    const inMap = p.x1 >= x1 && p.x1 <= x2 && p.y1 >= y1 && p.y1 <= y2;
    const at = `${Math.floor((p.x1 - x1) / cell)},${Math.floor((p.y1 - y1) / cell)}`;
    const key = machineKey(p);
    if (key) {
      const m = cells.get(at) ?? new Map<string, number>();
      m.set(key, (m.get(key) ?? 0) + 1);
      cells.set(at, m);
      total.set(key, (total.get(key) ?? 0) + 1);
    } else if (BELTS.has(p.r.type)) { belts++; if (inMap) hasBelt.add(at); } else if (inMap) hasOther.add(at);
    if (p.r.type === "inserter") arms++;
    if (p.r.type === "electric-pole") poles++;
    if (p.r.type === "roboport") roboports++;
  }
  const ranked = [...total].sort((a, b) => b[1] - a[1]);
  const letters = new Map(ranked.slice(0, OVERVIEW_LETTERS.length).map(([k], i) => [k, OVERVIEW_LETTERS[i]]));
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const at = `${x},${y}`;
      const m = cells.get(at);
      if (m) row += letters.get([...m].sort((a, b) => b[1] - a[1])[0][0]) ?? "*";
      else row += hasBelt.has(at) ? "-" : hasOther.has(at) ? "," : " ";
    }
    rows.push(row.trimEnd());
  }
  return {
    map: rows.join("\n"), cell, origin: [x1, y1],
    legend: [...ranked.slice(0, 26).map(([k, n]) => `${letters.get(k)}=${names(k) ?? k} ${n}`), "-=只有带子", ",=别的建筑 (杆、炮塔、箱子…)", "*=没编字母的线"].join("  "),
    facts: [`图里 ${x2 - x1 + 1}×${y2 - y1 + 1} 格 (有机器的那片, 外圈的墙和炮塔不画), 每个字符 ${cell}×${cell} 格, 左上角世界坐标 (${x1},${y1})`, `机器 ${[...total.values()].reduce((s, n) => s + n, 0)} 台 ${total.size} 种线, 带子 ${belts} 件, 机械臂 ${arms}, 电线杆 ${poles}, 机器人指令平台 ${roboports}`],
  };
}

/** 发给模型的一整段 */
export function studyText(head: string, s: Study, tail?: string): string {
  return [head, s.legend, s.map, `读数: ${s.facts.join("; ")}`, ...(tail ? [tail] : [])].join("\n");
}
