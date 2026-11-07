// 蓝图静态检查器 (不开游戏): 重叠、供电覆盖和电网连通、传送带朝向和地下带配对、地下管道配对、流体口有没有接管、
// 机械臂取放目标; 再调 check-belts (传送带连续性和侧向汇入)、check-fluids (管网连通和混管)、check-rails (铁轨连通、网格、信号、车站)。
// 规则全部来自原型数据 (rules.ts) 和沙盘引擎导出的铁轨几何 (rail-geometry.ts)。这是布局 MCP (M3) 第一道关; 第三道关是沙盘引擎核对 (bp try)。
import type { BpEntity } from "./inspect.ts";
import { type Rules, rotate, DIRV } from "./rules.ts";
import { type Finding, type Placed, Layout, Union, absBox, footprint, key } from "./placed.ts";
import { checkBelts } from "./check-belts.ts";
import { checkFluids } from "./check-fluids.ts";
import { checkRails } from "./check-rails.ts";
import { checkCoverage } from "./check-coverage.ts";
import { checkBlocks } from "./check-blocks.ts";
import type { RailGeometry } from "./rail-geometry.ts";

export type { Finding, Placed };
export { absBox, footprint };

export function checkBlueprint(entities: BpEntity[], wires: number[][] | undefined, rules: Rules, zh: (n: string) => string, geom: RailGeometry | null = null): Finding[] {
  const out: Finding[] = [];
  const L = new Layout(entities, rules);
  const { placed, tile } = L;
  if (L.unknown.size) out.push({ level: "info", kind: "unknown", msg: `原型数据里没有这些名字 (模组或新版本?): ${[...L.unknown].slice(0, 8).join("、")}` });
  const at = (x: number, y: number) => L.at(x, y);

  // 1. 重叠
  const seenPair = new Set<string>();
  for (const [k, list] of tile) {
    if (list.length < 2) continue;
    const [a, b] = list;
    if ((a.r.type === "gate" && b.r.rail) || (b.r.type === "gate" && a.r.rail)) continue; // 闸门可以建在直轨上 (提示与技巧 TT16, 沙盘 tips.rail-gate)
    const pk = `${a.e.entity_number}-${b.e.entity_number}`;
    if (seenPair.has(pk)) continue;
    seenPair.add(pk);
    out.push({ level: "error", kind: "overlap", msg: `${zh(a.e.name)} 和 ${zh(b.e.name)} 占了同一格 (${k})`, at: a.e.position, entity: a.e.name });
  }

  // 2. 供电: 覆盖 + 杆子连通
  const poles = placed.filter((p) => p.r.pole);
  const consumers = placed.filter((p) => p.r.electricConsumer);
  const producers = placed.filter((p) => p.r.electricProducer);
  const covers = (pole: Placed, p: Placed) => {
    const s = pole.r.pole!.supply;
    const cx = pole.e.position.x, cy = pole.e.position.y;
    // 供电区是以杆子中心为中心、半边长 s 的方块; 用电建筑的碰撞盒碰到就算
    const [ex1, ey1, ex2, ey2] = absBox(p.e, p.r);
    return ex1 < cx + s && ex2 > cx - s && ey1 < cy + s && ey2 > cy - s;
  };
  // 杆子连通分量: 蓝图里的铜线 (接点 5/6); 蓝图里一根线都没有时, 按距离 (游戏放杆子会自动连)
  const grid = new Union();
  const find = (i: number) => grid.find(i);
  for (const p of poles) grid.add(p.e.entity_number);
  const copper = (Array.isArray(wires) ? wires : []).filter((w) => w[1] >= 5 && w[3] >= 5);
  if (copper.length) {
    for (const w of copper) if (grid.has(w[0]) && grid.has(w[2])) grid.join(w[0], w[2]);
  } else {
    for (let i = 0; i < poles.length; i++) for (let j = i + 1; j < poles.length; j++) {
      const a = poles[i], b = poles[j];
      const d = Math.hypot(a.e.position.x - b.e.position.x, a.e.position.y - b.e.position.y);
      if (d <= Math.min(a.r.pole!.wire, b.r.pole!.wire)) grid.join(a.e.entity_number, b.e.entity_number);
    }
  }
  const compHasProducer = new Set<number>();
  for (const pr of producers) for (const pole of poles) if (covers(pole, pr)) compHasProducer.add(find(pole.e.entity_number));
  let uncovered = 0, noProducer = 0;
  for (const c of consumers) {
    const myPoles = poles.filter((pole) => covers(pole, c));
    if (!myPoles.length) {
      uncovered++;
      if (uncovered <= 10) out.push({ level: "error", kind: "no-power-coverage", msg: `${zh(c.e.name)} 不在任何电线杆的供电范围内`, at: c.e.position, entity: c.e.name });
      continue;
    }
    if (producers.length && !myPoles.some((pole) => compHasProducer.has(find(pole.e.entity_number)))) noProducer++;
  }
  if (uncovered > 10) out.push({ level: "error", kind: "no-power-coverage", msg: `…还有 ${uncovered - 10} 个用电建筑没有电线杆覆盖` });
  const comps = new Set(poles.map((p) => find(p.e.entity_number))).size;
  if (poles.length && comps > 1) out.push({ level: producers.length ? "warn" : "info", kind: "power-components", msg: `电线杆分成 ${comps} 张互不相连的电网${copper.length ? " (按蓝图里的铜线算)" : " (蓝图里没有铜线, 按连线距离估)"}` });
  if (noProducer) out.push({ level: "warn", kind: "power-no-producer", msg: `${noProducer} 个用电建筑所在的电网里没有发电设备 (蓝图里有发电设备但不在同一张网)` });
  if (consumers.length && !producers.length) out.push({ level: "info", kind: "power-external", msg: `蓝图里有 ${consumers.length} 个用电建筑、没有发电设备, 要接外部电网` });

  // 3. 传送带: 迎头相撞、地下带配对
  for (const p of placed) {
    if (!p.r.beltLike) continue;
    const [dx, dy] = DIRV[p.dir as 0 | 4 | 8 | 12] ?? [0, -1];
    if (p.r.type === "transport-belt") {
      const ahead = at(p.e.position.x + dx, p.e.position.y + dy).find((q) => q.r.beltLike);
      if (ahead && ahead.r.type === "transport-belt" && (ahead.dir + 8) % 16 === p.dir) {
        out.push({ level: "error", kind: "belt-head-on", msg: `两条传送带迎头相对 (${zh(p.e.name)})`, at: p.e.position, entity: p.e.name });
      }
    }
    if (p.r.type === "underground-belt" && (p.e as { type?: string }).type === "input") {
      const max = p.r.undergroundBeltMax ?? 0;
      let found = false;
      for (let i = 1; i <= max; i++) {
        const q = at(p.e.position.x + dx * i, p.e.position.y + dy * i).find((q) => q.e.name === p.e.name);
        if (q && (q.e as { type?: string }).type === "output" && q.dir === p.dir) { found = true; break; }
        if (q && (q.e as { type?: string }).type === "input" && q.dir === p.dir) break; // 中间又一个入口, 前一个就断了
      }
      if (!found) out.push({ level: "error", kind: "underground-unpaired", msg: `${zh(p.e.name)} 入口在 ${max} 格内没有同向的出口`, at: p.e.position, entity: p.e.name });
    }
    if (p.r.type === "underground-belt" && (p.e as { type?: string }).type === "output") {
      // 出口往回找入口 (引擎的 underground_belt_neighbour 两头都查)
      const max = p.r.undergroundBeltMax ?? 0;
      let found = false;
      for (let i = 1; i <= max; i++) {
        const q = at(p.e.position.x - dx * i, p.e.position.y - dy * i).find((q) => q.e.name === p.e.name);
        if (q && (q.e as { type?: string }).type === "input" && q.dir === p.dir) { found = true; break; }
        if (q && (q.e as { type?: string }).type === "output" && q.dir === p.dir) break;
      }
      if (!found) out.push({ level: "error", kind: "underground-unpaired", msg: `${zh(p.e.name)} 出口后面 ${max} 格内没有同向的入口`, at: p.e.position, entity: p.e.name });
    }
  }

  // 4. 流体: 每个接口对面有没有能接的东西; 地下管道配对
  const fluidEnds = new Map<string, { p: Placed; c: { dir: number; tx: number; ty: number } }[]>(); // 目标格 -> 指向它的接口
  const connsAbs = (p: Placed) => p.r.fluid.map((c) => {
    const [rx, ry] = rotate((p.e as { mirror?: boolean }).mirror ? -c.x : c.x, c.y, p.dir); // 2.0 蓝图翻转: mirror 把流体口左右对调
    const dir = (c.dir + p.dir) % 16;
    const [dx, dy] = DIRV[dir as 0 | 4 | 8 | 12] ?? [0, 0];
    return { ...c, dir, ax: p.e.position.x + rx, ay: p.e.position.y + ry, tx: p.e.position.x + rx + dx, ty: p.e.position.y + ry + dy };
  });
  for (const p of placed) {
    if (!p.r.fluid.length) continue;
    for (const c of connsAbs(p)) {
      if (c.underground) continue;
      const k = key(Math.floor(c.tx), Math.floor(c.ty));
      const list = fluidEnds.get(k) ?? [];
      list.push({ p, c });
      fluidEnds.set(k, list);
    }
  }
  for (const p of placed) {
    if (!p.r.fluid.length) continue;
    // 有配方的机器: 配方不用流体就没有流体口 (这是 961 条噪音的来源)
    const recipe = (p.e as { recipe?: string }).recipe;
    const rf = recipe ? rules.recipeFluid(recipe) : undefined;
    for (const c of connsAbs(p)) {
      if (c.recipeDependent) {
        if (!recipe || !rf) continue; // 没设配方 (或不认识), 没法判断
        // 配方有 n 种流体原料就只用前 n 个进口 (化工厂 2 个进口做硫酸只用第 1 个), 出口同理
        if (c.flow === "input" && (c.boxIndex ?? 0) >= rf.in.length) continue;
        if (c.flow === "output" && (c.boxIndex ?? 0) >= rf.out.length) continue;
      }
      if (c.underground) {
        // 地下管道: 沿接口方向在最大距离内找一根朝向相反的地下管道
        const max = c.maxUnderground ?? 10;
        const [dx, dy] = DIRV[c.dir as 0 | 4 | 8 | 12] ?? [0, 0];
        let found = false;
        for (let i = 1; i <= max; i++) {
          const q = at(p.e.position.x + dx * i, p.e.position.y + dy * i).find((q) => q.e.name === p.e.name);
          if (q && (q.dir + 8) % 16 === p.dir) { found = true; break; }
        }
        // 单根地下管道常被拿来当封口用 (朋友基地有 9 处), 所以是警告不是错误
        if (!found) out.push({ level: "warn", kind: "pipe-underground-unpaired", msg: `${zh(p.e.name)} 在 ${max} 格内没有对着它的另一头 (单根当封口用是正常的)`, at: p.e.position, entity: p.e.name });
        continue;
      }
      // 对面那格有没有一个接口指回来
      const back = (fluidEnds.get(key(Math.floor(c.ax), Math.floor(c.ay))) ?? []).some((o) => o.p !== p && Math.floor(o.c.tx) === Math.floor(c.ax) && Math.floor(o.c.ty) === Math.floor(c.ay) && Math.floor(o.p.e.position.x + 0) !== undefined && at(c.tx, c.ty).includes(o.p));
      if (!back) {
        const isPipe = p.r.type === "pipe" || p.r.type === "pipe-to-ground" || p.r.type === "storage-tank";
        // 蒸汽机 / 汽轮机 / 锅炉 / 换热器这类"穿过式" (input-output) 接口, 一排的末端空着是正常的 → 提示
        const passThrough = c.flow === "input-output";
        if (!isPipe) {
          out.push({ level: passThrough ? "info" : "warn", kind: "fluid-open", msg: `${zh(p.e.name)} 的流体口 (${c.flow}) 对面 (${Math.floor(c.tx)},${Math.floor(c.ty)}) 没有接管${passThrough ? " (穿过式接口, 排尾空着正常)" : ""}`, at: p.e.position, entity: p.e.name });
        }
      }
    }
  }
  const lonePipes = placed.filter((p) => p.r.type === "pipe" && connsAbs(p).every((c) => !(fluidEnds.get(key(Math.floor(c.ax), Math.floor(c.ay))) ?? []).some((o) => o.p !== p && at(c.tx, c.ty).includes(o.p))));
  if (lonePipes.length) out.push({ level: "warn", kind: "pipe-isolated", msg: `${lonePipes.length} 根管道没和任何东西相连 (例: ${lonePipes.slice(0, 3).map((p) => `(${p.e.position.x},${p.e.position.y})`).join(" ")})` });

  // 5. 机械臂: 取货格和放货格上要有东西 (传送带、箱子、机器、铁轨上的车厢)
  let emptyTargets = 0;
  for (const p of placed) {
    if (!p.r.inserter) continue;
    const check = (vec: [number, number], what: string) => {
      const [rx, ry] = rotate(vec[0], vec[1], p.dir);
      const tx = p.e.position.x + rx, ty = p.e.position.y + ry;
      const things = at(tx, ty).filter((q) => q !== p && (q.r.holdsItems));
      const railThere = placed.some((q) => q.r.rail && Math.abs(q.e.position.x - tx) <= 1 && Math.abs(q.e.position.y - ty) <= 1);
      if (!things.length && !railThere) {
        emptyTargets++;
        if (emptyTargets <= 10) out.push({ level: "warn", kind: "inserter-empty-target", msg: `${zh(p.e.name)} 的${what}格 (${Math.floor(tx)},${Math.floor(ty)}) 是空地`, at: p.e.position, entity: p.e.name });
      }
    };
    check(p.r.inserter.pickup, "取货");
    check(p.r.inserter.drop, "放货");
  }
  if (emptyTargets > 10) out.push({ level: "warn", kind: "inserter-empty-target", msg: `…还有 ${emptyTargets - 10} 个机械臂对着空地` });

  // 6. 传送带连续性和侧向汇入、7. 管网连通和混管、8. 铁轨连通 / 网格 / 信号 / 车站
  out.push(...checkBelts(L, zh));
  out.push(...checkFluids(L, rules, zh));
  out.push(...checkRails(L, geom, zh));
  // 9. 覆盖: 物流箱在不在机器人网里、机器人网分几张、炮塔和墙在不在建设范围里、墙有没有炮塔护着、机枪炮塔有没有补弹臂
  out.push(...checkCoverage(L, zh));
  // 10. 区段长度 vs 标准列车 (普通信号后面、出口有信号的区段)
  out.push(...checkBlocks(L, geom, zh));

  return out;
}

export function summarize(findings: Finding[]): string {
  const n = (l: Finding["level"]) => findings.filter((f) => f.level === l).length;
  return `错误 ${n("error")}、警告 ${n("warn")}、提示 ${n("info")}`;
}
