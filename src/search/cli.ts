#!/usr/bin/env node
// 按指标搜索 (M3, docs/search.md): 组装机排生成器 + 爬山 + 沙盘喂料实测
//   npm run search -- --recipe iron-gear-wheel --target 600 [--allow machine=assembling-machine-1,assembling-machine-2] [--fix layout=single]
//                     [--start '{"inserter":"fast-inserter"}'] [--iters 12] [--warm 60] [--seconds 120] [--name 名字] [--view]
// 起点: 计算器按目标算台数 (满速), 机械臂 / 带子从最低档开始, 另从 --restarts 个随机起点各爬一次 (默认 2); 每轮把当前方案的每个参数各改一格 (加联动: 换机器档同步调台数、
// 单 / 双排同步调每排台数), 全部进沙盘实测, 换成最好的那个; 没有更好的就停 (局部最优)。实测结果缓存在 lab-data/search/<名字>.cache.json, 重跑不重测。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { LabInstance, labRoot } from "../lab/instance.ts";
import { decodeBlueprint } from "../lab/blueprint.ts";
import { zhNamesFrom } from "../lab/names.ts";
import { flatten, analyze } from "../blueprint/inspect.ts";
import { defaultDumpPath } from "../blueprint/rules.ts";
import { placeBlueprint, feedArea } from "../dataset/feed.ts";
import { loadGameData } from "../calc/data.ts";
import { recipeOnMachine } from "../calc/solve.ts";
import { ASSEMBLER_ROW_SPACE, better, coupledNeighbors, keyOf, neighbors, randomSpec, restrict, rng, score as rawScore, tierCost, type Measured, type Spec } from "./hillclimb.ts";

const { values } = parseArgs({
  options: {
    recipe: { type: "string" }, target: { type: "string" }, allow: { type: "string", multiple: true, default: [] }, fix: { type: "string", multiple: true, default: [] },
    start: { type: "string", default: "{}" }, iters: { type: "string", default: "12" }, warm: { type: "string", default: "60" }, seconds: { type: "string", default: "120" },
    name: { type: "string" }, view: { type: "boolean", default: false }, research: { type: "string", default: "none" },
    restarts: { type: "string", default: "2" }, seed: { type: "string", default: "1" },
  },
});
if (!values.recipe || !values.target) {
  console.log("用法: npm run search -- --recipe <配方> --target <每分钟> [--allow 参数=值,值] [--fix 参数=值] [--start JSON] [--iters 12] [--view]");
  process.exit(2);
}
const recipe = values.recipe, target = Number(values.target);
const name = values.name ?? `${recipe}-${target}${values.research === "late" ? "-late" : ""}`; // 按研究等级分开缓存
const dir = path.join(labRoot(), "search");
fs.mkdirSync(dir, { recursive: true });
const dump = defaultDumpPath();
const zh = zhNamesFrom(path.dirname(dump));
const gen = path.join(import.meta.dirname, "..", "..", "tools", "generators", "assembler_row.py");
const python = process.env.GEN_PYTHON ?? [path.join(labRoot(), "venv", "Scripts", "python.exe"), path.join(labRoot(), "venv", "bin", "python")].find((p) => fs.existsSync(p)) ?? "python";

const kv = (list: string[]) => Object.fromEntries(list.map((s) => s.split("=")).map(([k, v]) => [k, v.split(",").map((x) => (/^\d+$/.test(x) ? Number(x) : x))]));
const allow = kv(values.allow as string[]);
const fixedKv = kv(values.fix as string[]);
const space = restrict(ASSEMBLER_ROW_SPACE, { ...allow, ...fixedKv });
const fixed = Object.keys(fixedKv);
const first = (k: string) => { const d = space[k]; return "values" in d ? d.values[0] : d.min; };

// 起点: 计算器算满速要几台 (取最低档机械臂 / 带子, 让搜索自己往上加)
const gd = loadGameData(dump);
const startMachine = String(JSON.parse(values.start).machine ?? fixedKv.machine?.[0] ?? (("values" in space.machine) ? space.machine.values[Math.min(1, space.machine.values.length - 1)] : "assembling-machine-2"));
const per = recipeOnMachine(gd, recipe, { machine: startMachine });
// 机器速度 (联动邻居换机器档时按比例调台数)
const speeds = Object.fromEntries(("values" in ASSEMBLER_ROW_SPACE.machine ? ASSEMBLER_ROW_SPACE.machine.values : []).map((m) => [String(m), gd.machines.get(String(m))?.speed ?? 0]));
const perMin = per.perMachine * (Object.values(per.out)[0] ?? 1);
const nStart = Math.min(40, Math.max(1, Math.ceil(target / perMin)));
let cur: Spec = { recipe, machine: startMachine, inserter: first("inserter"), belt: first("belt"), per_input: 1, out: 1, layout: first("layout"), n: nStart, ...Object.fromEntries(Object.entries(fixedKv).map(([k, v]) => [k, v[0]])), ...JSON.parse(values.start) };
console.log(`搜索 ${zh(recipe)} 每分钟 ${target}: 计算器 ${zh(startMachine)} 每台满速 ${perMin.toFixed(1)} → 起点 ${nStart} 台; 固定 ${JSON.stringify(fixedKv)}; 限定 ${JSON.stringify(allow)}`);

const cacheFile = path.join(dir, `${name}.cache.json`);
const cache: Record<string, { spec: Spec; label?: string; m: Measured }> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
const saveCache = () => fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1));

/** 生成一本书 (每个变体一张) → [{spec, meta.error?, bp, label}] */
function generate(specs: Spec[], file: string) {
  const specFile = file + ".spec.json";
  fs.writeFileSync(specFile, JSON.stringify(specs));
  const r = spawnSync(python, ["-I", gen, file, "--spec", specFile], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`生成器失败: ${r.stderr || r.stdout}`);
  const meta = JSON.parse(fs.readFileSync(file + ".meta.json", "utf8")) as (Spec & { error?: string; index?: number })[];
  const items = fs.statSync(file).size ? flatten(decodeBlueprint(fs.readFileSync(file, "utf8").trim())) : [];
  return meta.map((m, i) => ({ spec: specs[i], error: m.error, item: m.index ? items[m.index - 1] : undefined }));
}

const lab = new LabInstance({ name: "search", view: values.view, label: `搜索 ${zh(recipe)}` });
let evals = 0;
async function evaluate(specs: Spec[]) {
  const todo = specs.filter((s) => !cache[keyOf(s)]);
  if (!todo.length) return;
  for (const g of generate(todo, path.join(dir, `${name}.batch.txt`))) {
    let m: Measured;
    if (g.error || !g.item) m = { outPerMin: 0, tiles: 0, powerMW: 0, efficiency: null, trend: null, error: g.error ?? "没生成" };
    else {
      const info = analyze(g.item.label, g.item.path, g.item.bp);
      const { area } = await placeBlueprint(lab, g.item.bp, g.item.label);
      const f = await feedArea(lab, area, g.item.bp, { warmS: Number(values.warm), measureS: Number(values.seconds), research: values.research });
      evals++;
      m = { outPerMin: Number(f.final.reduce((n, k) => n + (f.perMin[k] ?? 0), 0).toFixed(1)), tiles: info.size.w * info.size.h, powerMW: f.powerMW, efficiency: f.efficiency, trend: f.trend ?? null, error: f.error ?? f.skipped };
    }
    cache[keyOf(g.spec)] = { spec: g.spec, label: g.item?.label, m };
    saveCache();
  }
}

const show = (s: Spec) => `${zh(String(s.machine))} ${s.layout === "double" ? "双排" : "单排"} ${s.n}${s.layout === "double" ? "×2" : ""} 台, ${zh(String(s.inserter))}×${s.per_input} 出×${s.out}, ${zh(String(s.belt))}`;
const res = (s: Spec) => cache[keyOf(s)].m;
const score = (m: Measured, t: number, s?: Spec) => rawScore(m, t, s ? tierCost(s, ASSEMBLER_ROW_SPACE) : 0);
const desc = (m: Measured) => (m.error ? `不可行 (${m.error})` : `每分钟 ${m.outPerMin}、占地 ${m.tiles} 格、${m.powerMW}MW、效率 ${m.efficiency}、趋势 ${m.trend}`);

const history: { climb: number; iter: number; spec: Spec; m: Measured }[] = [];
const t0 = Date.now();
/** 从 start 爬到局部最优, 返回停下的方案 */
async function climb(start: Spec, c: number): Promise<Spec> {
  let at = start;
  await evaluate([at]);
  console.log(`[第 ${c} 次] 第 0 轮: ${show(at)} → ${desc(res(at))}`);
  history.push({ climb: c, iter: 0, spec: at, m: res(at) });
  for (let it = 1; it <= Number(values.iters); it++) {
    const seen = new Set<string>();
    const nbs = [...neighbors(at, space, fixed), ...coupledNeighbors(at, space, speeds, fixed)].filter((s) => !seen.has(keyOf(s)) && !!seen.add(keyOf(s)));
    await evaluate(nbs);
    let best = at;
    for (const s of nbs) if (better(score(res(s), target, s), score(res(best), target, best))) best = s;
    if (best === at) {
      console.log(`[第 ${c} 次] 第 ${it} 轮: ${nbs.length} 个邻居都不比现在好 → 停 (局部最优)`);
      break;
    }
    at = best;
    console.log(`[第 ${c} 次] 第 ${it} 轮 (${nbs.length} 个邻居): → ${show(at)} → ${desc(res(at))}`);
    history.push({ climb: c, iter: it, spec: at, m: res(at) });
  }
  return at;
}
try {
  await lab.createMap("s", { seed: 1 });
  await lab.start("s");
  // 第 0 次从计算器起点爬; 再从 --restarts 个随机起点各爬一次 (种子 --seed, 可复现), 取最好的
  let best = await climb(cur, 0);
  const rand = rng(Number(values.seed));
  for (let c = 1; c <= Number(values.restarts); c++) {
    // 抽到不合法的起点 (例: 进料 3 + 出料 3 把格子占满, 放不下电线杆) 就重抽: 它的一步邻居也多半不合法, 爬不动 (2026-11-02 两次重启白跑)
    let start = randomSpec(cur, space, speeds, rand, fixed);
    for (let k = 0; k < 10; k++) {
      await evaluate([start]);
      if (!res(start).error) break;
      start = randomSpec(cur, space, speeds, rand, fixed);
    }
    const end = await climb(start, c);
    if (better(score(res(end), target, end), score(res(best), target, best))) best = end;
  }
  cur = best;
} finally {
  await lab.stop({ save: false });
}

// 结果: 实测过的里面排前 8 (含不在爬山路径上的), 最好的那张单独存成蓝图字符串 (进数据集 / 预览链接用)
const all = Object.values(cache).filter((c) => c.spec.recipe === recipe);
all.sort((a, b) => (better(score(a.m, target, a.spec), score(b.m, target, b.spec)) ? -1 : better(score(b.m, target, b.spec), score(a.m, target, a.spec)) ? 1 : 0));
console.log(`\n实测 ${evals} 个新变体 (缓存共 ${all.length}), ${((Date.now() - t0) / 1000).toFixed(0)} 秒。前 8:\n| 方案 | 每分钟 | 占地 | 耗电 MW | 效率 | 达标 |\n|---|---|---|---|---|---|`);
for (const c of all.slice(0, 8)) console.log(`| ${show(c.spec)} | ${c.m.outPerMin} | ${c.m.tiles} | ${c.m.powerMW} | ${c.m.efficiency} | ${score(c.m, target)[0] === 1 ? "✅" : "—"} |`);
// 最好的取所有实测过的 (含以前几次运行缓存的), 和上面的前 8 名表一致 (2026-11-02: 这次几次爬山没走到上次测到的更省电方案)
if (all.length && better(score(all[0].m, target, all[0].spec), score(res(cur), target, cur))) cur = all[0].spec;
const bestFile = path.join(dir, `${name}.best.txt`);
generate([cur], bestFile);
fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ recipe, target, fixed: fixedKv, allow, best: cur, measured: res(cur), history, at: new Date().toISOString() }, null, 1));
console.log(`\n最好: ${show(cur)} → ${desc(res(cur))}${score(res(cur), target)[0] === 1 ? "" : " (没达标: 参数空间里够不到目标, 放宽 --allow 或换布局)"}\n蓝图 → ${bestFile}\n预览: npm run bp -- link ${bestFile}`);
