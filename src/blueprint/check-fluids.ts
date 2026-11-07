// 流体网连通和混管 (静态)。模型 (2.1.24 沙盘核对后改, 2026-11-01):
// - 管道 / 储液罐 / 泵 / 直通箱 (锅炉的水箱、蒸汽机) 是"管段": 接口对着接口就连成一张网;
// - 有配方的机器的进口箱 / 出口箱是"端点": 一个箱子可以有两个口 (化工厂做硫酸时 1 个水箱的两个口都"接上"), 但流体不会穿过箱子从一边流到另一边,
//   所以端点按"口"接到管段, 不把两边的管段并成一张 (第一版把箱子当节点, 把水网和轻油网并成一张, 误报了混管);
// - 一张网的流体 = 接在它上面的出口箱的流体 + 直通箱的 filter (锅炉 water/steam、蒸汽机 steam); 两种以上 = 混管 (引擎建造时就会拒绝);
// - 进口箱要的流体 (配方) 不在它接的任何一张网里, 而那张网里是别的流体 → 接错流体 (进口箱有过滤, 不会混, 但机器得不到料);
// - 没有出口箱、管子也没留口 → 没来源; 留了口 → 外部供液 (提示)。
import { DIRV, rotate, type FluidConn, type Rules } from "./rules.ts";
import { type Finding, type Layout, type Placed, Union, key } from "./placed.ts";

interface Conn extends FluidConn {
  p: Placed;
  /** 接口自己所在的格子中心 (绝对) 和对面那格 */
  ax: number; ay: number; tx: number; ty: number;
  /** 绝对朝向 */
  adir: number;
  /** 并查集节点: 管段箱按箱, 端点箱按口 */
  node: number;
  /** 这个口所属箱子的流体 (filter 或配方) */
  fluid?: string;
  /** 端点 (input / output) 还是管段 (none / input-output) */
  endpoint: boolean;
  boxKey: string;
}

export function checkFluids(L: Layout, rules: Rules, zh: (n: string) => string): Finding[] {
  const out: Finding[] = [];
  const conns: Conn[] = [];
  const nodeOf = new Map<string, number>();
  const node = (k: string) => {
    let n = nodeOf.get(k);
    if (n === undefined) { n = nodeOf.size; nodeOf.set(k, n); }
    return n;
  };
  // 1. 收集有效接口 (配方不用的口不算)
  for (const p of L.placed) {
    if (!p.r.fluid.length) continue;
    const recipe = (p.e as { recipe?: string }).recipe;
    const rf = recipe ? rules.recipeFluid(recipe) : undefined;
    const mirror = !!(p.e as { mirror?: boolean }).mirror; // 2.0 蓝图翻转: mirror 把流体口左右对调
    let port = 0;
    for (const c of p.r.fluid) {
      let fluid = c.filter;
      if (c.recipeDependent) {
        if (!recipe || !rf) continue;
        if (c.flow === "input" && (c.boxIndex ?? 0) >= rf.in.length) continue;
        if (c.flow === "output" && (c.boxIndex ?? 0) >= rf.out.length) continue;
        if (c.production === "input") fluid = rf.in[c.boxIndex ?? 0];
        if (c.production === "output") fluid = rf.out[c.boxIndex ?? 0];
      }
      const [rx, ry] = rotate(mirror ? -c.x : c.x, c.y, p.dir);
      const adir = (c.dir + p.dir) % 16;
      const [dx, dy] = DIRV[adir as 0 | 4 | 8 | 12] ?? [0, 0];
      const ax = p.e.position.x + rx, ay = p.e.position.y + ry;
      // 直通口 (蒸汽机 / 汽轮机 / 锅炉水箱 / 换热器: flow input-output) 会把流体传给下一台, 按管段算; 只进或只出的口才是端点
      const endpoint = (c.production === "input" || c.production === "output") && c.flow !== "input-output";
      const boxKey = `${p.e.entity_number}:${c.box}`;
      const n = node(endpoint ? `${boxKey}#${port++}` : boxKey);
      conns.push({ ...c, p, ax, ay, tx: ax + dx, ty: ay + dy, adir, node: n, fluid, endpoint, boxKey });
    }
  }
  if (!conns.length) return out;

  // 2. 连通: 接口对着接口 (两边的格子互为对方的目标), 连接类别要相同; 地下管道配对
  const byTile = new Map<string, Conn[]>();
  for (const c of conns) {
    if (c.underground) continue;
    const k = key(Math.floor(c.ax), Math.floor(c.ay));
    const l = byTile.get(k) ?? [];
    l.push(c);
    byTile.set(k, l);
  }
  const net = new Union();
  const linked = new Set<Conn>();
  const sameCat = (a: Conn, b: Conn) => a.category.some((x) => b.category.includes(x));
  for (const c of conns) {
    net.add(c.node);
    if (c.underground) {
      const max = c.maxUnderground ?? 10;
      const [dx, dy] = DIRV[c.adir as 0 | 4 | 8 | 12] ?? [0, 0];
      for (let i = 1; i <= max; i++) {
        const q = L.at(c.ax + dx * i, c.ay + dy * i).find((q) => q.e.name === c.p.e.name);
        if (q) {
          const other = conns.find((o) => o.p === q && o.underground && o.adir === (c.adir + 8) % 16);
          if (other) { net.join(c.node, other.node); linked.add(c); linked.add(other); break; }
          // 同轴但背对的另一根会挡住; 垂直方向的地下管道可以从下面穿过 (密集油区常见), 不挡
          if (q.dir % 8 === c.p.dir % 8) break;
        }
      }
      continue;
    }
    for (const o of byTile.get(key(Math.floor(c.tx), Math.floor(c.ty))) ?? []) {
      if (o.p === c.p) continue;
      if (Math.floor(o.tx) === Math.floor(c.ax) && Math.floor(o.ty) === Math.floor(c.ay) && sameCat(c, o)) {
        net.join(c.node, o.node);
        linked.add(c); linked.add(o);
      }
    }
  }

  // 3. 每张网: 锁定的流体 (出口 + 直通箱 filter)、进口要的流体、留给外部的口、不明来源 (抽取泵: 流体看地块)
  interface Comp { locked: Map<string, Conn>; sinks: Conn[]; open: number; unknownSource: boolean; size: number }
  const comps = new Map<number, Comp>();
  for (const c of conns) {
    const root = net.find(c.node);
    let comp = comps.get(root);
    if (!comp) { comp = { locked: new Map(), sinks: [], open: 0, unknownSource: false, size: 0 }; comps.set(root, comp); }
    comp.size++;
    if (c.p.r.type === "offshore-pump") comp.unknownSource = true;
    else if (c.production === "output" && c.fluid) { if (!comp.locked.has(c.fluid)) comp.locked.set(c.fluid, c); }
    else if (!c.endpoint && c.fluid) { if (!comp.locked.has(c.fluid)) comp.locked.set(c.fluid, c); }
    else if (c.production === "input") comp.sinks.push(c);
    if (!linked.has(c) && !c.underground) comp.open++;
  }
  let mixed = 0;
  for (const comp of comps.values()) {
    if (comp.locked.size >= 2) {
      mixed++;
      const names = [...comp.locked.entries()].map(([f, c]) => `${zh(f)} (${zh(c.p.e.name)} ${c.p.e.position.x},${c.p.e.position.y})`);
      if (mixed <= 10) out.push({ level: "error", kind: "fluid-mixed", msg: `混管: 同一张管网里接了 ${names.join("、")}`, at: comp.locked.values().next().value!.p.e.position });
    }
  }
  if (mixed > 10) out.push({ level: "error", kind: "fluid-mixed", msg: `…还有 ${mixed - 10} 张混管的管网` });

  // 4. 进口箱: 任一口接到含有它要的流体 (或不明来源 / 留口) 的网就算满足; 都不满足时, 接到了别的流体 → 接错, 一个来源都没有 → 没来源
  const byBox = new Map<string, Conn[]>();
  for (const c of conns) if (c.production === "input") { const l = byBox.get(c.boxKey) ?? []; l.push(c); byBox.set(c.boxKey, l); }
  let wrong = 0, noSource = 0, external = 0;
  for (const ports of byBox.values()) {
    const want = ports[0].fluid;
    const compsOf = ports.map((c) => comps.get(net.find(c.node))!);
    const satisfied = compsOf.some((cp) => (want && cp.locked.has(want)) || cp.unknownSource);
    if (satisfied) continue;
    const other = compsOf.flatMap((cp) => [...cp.locked.keys()]).filter((f) => f !== want);
    const p = ports[0].p;
    if (other.length) {
      wrong++;
      if (wrong <= 10) out.push({ level: "warn", kind: "fluid-wrong-input", msg: `${zh(p.e.name)} (${p.e.position.x},${p.e.position.y}) 的进口要 ${want ? zh(want) : "?"}, 接到的管网里是 ${[...new Set(other)].map(zh).join("、")} (进口有过滤不会混, 但机器得不到料)`, at: p.e.position, entity: p.e.name });
    } else if (compsOf.some((cp) => cp.open > 0)) external++;
    else {
      noSource++;
      if (noSource <= 5) out.push({ level: "warn", kind: "fluid-no-source", msg: `管网没有来源也没留口: ${want ? zh(want) : "流体不明"} 进 ${zh(p.e.name)} (${p.e.position.x},${p.e.position.y}) 的管网里没有出液的机器, 管子也没留口接外部`, at: p.e.position, entity: p.e.name });
    }
  }
  if (wrong > 10) out.push({ level: "warn", kind: "fluid-wrong-input", msg: `…还有 ${wrong - 10} 个进口接错了流体` });
  if (noSource > 5) out.push({ level: "warn", kind: "fluid-no-source", msg: `…还有 ${noSource - 5} 个进口的管网没来源` });
  if (external) out.push({ level: "info", kind: "fluid-external", msg: `${external} 个进口的管网只留了口接外部供液, 蓝图里没有来源` });
  // 只有出液、没人用的网 (会憋满)
  let noSink = 0;
  for (const comp of comps.values()) if (comp.locked.size === 1 && !comp.sinks.length && !comp.open && comp.size > 1 && [...comp.locked.values()][0].production === "output") noSink++;
  if (noSink) out.push({ level: "info", kind: "fluid-no-sink", msg: `${noSink} 张管网只有出液的机器、没有用液的 (会憋满)` });
  out.push({ level: "info", kind: "fluid-networks", msg: `管网 ${comps.size} 张 (按接口对接和地下管道配对算; 端点箱按口计)` });
  return out;
}
