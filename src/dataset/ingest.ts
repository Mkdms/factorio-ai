// 蓝图数据集 (docs/blueprint-dataset.md): 把一个目录里的蓝图 (解码好的 .json 或蓝图字符串 .txt, 蓝图书展开) 收进本机数据集 lab-data/datasets/index.jsonl。
// 每张记: 出处、许可、版本、大小、建筑和配方、认不出的建筑名 (模组 / 旧版本), 再跑一遍静态检查器 (按 2.1 原型)。沙盘实测是下一步 (measure)。
// 用法: npm run dataset -- ingest <目录> --source <名字> --license <SPDX 或 unknown> [--url <地址>]
//       npm run dataset -- summary
//       npm run dataset -- measure [--limit N] [--redo]   沙盘实测 (不喂料); --redo 全部重测
//       npm run dataset -- render [--limit N] [--redo]   每张出一张图 (本机蓝图编辑器, docs/blueprint-dataset.md 出图一节)
//       npm run dataset -- find [--category 冶炼] [--product iron-plate] [--top 5]   检索: 实测最好的几张 (配图 + 预览链接)
//       npm run dataset -- migrate <1.1 字符串文件> <输出文件>   1.1 → 2.1 迁移 (游戏导入再导出)
//       npm run dataset -- feed [--limit N] [--id 片段] [--nosave] [--warm 60] [--seconds 180] [--research late]   喂料测产量 (第三层标签; late 结果存 feedLate)
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { decodeBlueprint } from "../lab/blueprint.ts";
import { flatten, analyze } from "../blueprint/inspect.ts";
import { loadRules } from "../blueprint/rules.ts";
import { checkBlueprint } from "../blueprint/check.ts";
import { loadRailGeometry } from "../blueprint/rail-geometry.ts";
import { encodeBlueprint } from "../lab/blueprint.ts";
import { LabInstance } from "../lab/instance.ts";
import { createHash } from "node:crypto";
import { BlueprintRenderer, referenceOf, writeRender, previewLink } from "../blueprint/render.ts";
import { placeBlueprint, feedArea, describeFeed, dropNulls, FEED_BLANK, type FeedResult } from "./feed.ts";

import { labPath, labRel, labRoot } from "../lab/gamedir.ts";

const root = path.join(import.meta.dirname, "..", "..");
/** 本机数据集 (数据目录可以在仓库外: labRoot) */
export const DATASET = path.join(labRoot(), "datasets", "index.jsonl");

export interface BpRecord {
  id: string; // 出处:相对路径#蓝图书里的位置
  source: string;
  license: string; // SPDX (CC0-1.0、MIT…) 或 unknown (只能本机用)
  url?: string;
  file: string;
  dir: string; // 蓝图文件所在目录 (相对仓库根)
  label: string;
  version: string | null; // 蓝图里的游戏版本 (主.次)
  entities: number;
  size: { w: number; h: number };
  counts: Record<string, number>;
  recipes: Record<string, number>;
  unknown: string[]; // 2.1 原型里没有的名字 (模组或旧版本)
  check: { errors: number; warnings: number; kinds: Record<string, number> } | null; // 有认不出的建筑就不查 (null)
  category: string[]; // 粗分类 (按建筑和配方推)
  ingested: string;
  /** 第二层标签 (沙盘, 不喂原料): 建成多少、各状态多少、引擎核对的问题数 */
  /** 第三层标签 (沙盘, 喂料): 自动给入口上料、出口收料, 预热 1 分钟后测 3 分钟; 产量 (每分钟) 和理论上限比; 机器状态占比; 耗电 (src/dataset/feed.ts) */
  feed?: FeedResult;
  /** 同上, 但全部科技研究完再测 (`feed --research late`; 后期设计在不研究时被低估) */
  feedLate?: FeedResult;
  /** 配图 (本机蓝图编辑器渲染, 带坐标网格和信息层): 文件相对仓库根; origin = 图片左上角的蓝图坐标 */
  render?: { file?: string; width?: number; height?: number; bytes?: number; pxPerTile?: number; origin?: { x: number; y: number }; error?: string; at: string };
  measure?: { built: number; ghosts: number; failed: number; status: Record<string, number>; noNetwork: number; ugOrphan: number; fluidIsolated: number; railDeadEnds: number; signalsUnconnected: number; stopsUnconnected: number; error?: string; skipped?: string; at: string };
}

const versionOf = (v: unknown) => (typeof v === "number" ? `${Math.floor(v / 2 ** 48)}.${Math.floor(v / 2 ** 32) % 65536}` : null);

const VEHICLES = /^(locomotive|cargo-wagon|fluid-wagon|artillery-wagon|car|tank|spidertron)$/;
function categories(counts: Record<string, number>, recipes: Record<string, number>): string[] {
  // 只有机车 / 车厢的是列车编组 (要先铺轨才放得下; 2026-11-02 实测 47 张"对不上位"全是这种)
  if (Object.keys(counts).length && Object.keys(counts).every((n) => VEHICLES.test(n))) return ["列车编组"];
  const has = (re: RegExp) => Object.keys(counts).some((n) => re.test(n));
  const rec = (re: RegExp) => Object.keys(recipes).some((n) => re.test(n));
  const out: string[] = [];
  if (has(/train-stop/)) out.push("火车站");
  else if (has(/rail/)) out.push("铁路");
  if (has(/furnace|foundry/)) out.push("冶炼");
  if (rec(/science-pack/)) out.push("科技包");
  if (rec(/electronic-circuit|advanced-circuit|processing-unit/)) out.push("电路");
  if (has(/turret|wall|gate/)) out.push("防御");
  if (has(/solar-panel|steam-engine|nuclear-reactor|accumulator|boiler|turbine/)) out.push("发电");
  if (has(/mining-drill|pumpjack/)) out.push("采矿");
  if (has(/oil-refinery|chemical-plant/)) out.push("石油化工");
  if (has(/biochamber|agricultural-tower/)) out.push("句芒");
  if (has(/roboport/)) out.push("机器人");
  return out.length ? out : ["其他"];
}

function readAll(file: string): Record<string, unknown> | null {
  const text = fs.readFileSync(file, "utf8").trim();
  if (file.endsWith(".json")) {
    const d = JSON.parse(text) as Record<string, unknown>;
    delete d.index; // fatul 拆书时加的序号
    return d;
  }
  return text.startsWith("0") ? decodeBlueprint(text) : null;
}

/** 写数据集: 先把旧文件备份到 lab-data/datasets/backups/ (留最近 10 份)。
 *  2026-11-02: 用同一个出处名收录 1.1 迁移的蓝图, 收录逻辑把这个出处原来的 212 张 (带实测、配图、喂料) 整批替换掉了, 只能重跑 —— 单个本机文件没有备份。 */
export function saveDataset(records: Iterable<BpRecord>) {
  if (fs.existsSync(DATASET)) {
    const dir = path.join(path.dirname(DATASET), "backups");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(DATASET, path.join(dir, `index-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
    const old = fs.readdirSync(dir).filter((f) => f.startsWith("index-")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 10))) fs.rmSync(path.join(dir, f));
  }
  fs.writeFileSync(DATASET, [...records].map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function loadDataset(): BpRecord[] {
  if (!fs.existsSync(DATASET)) return [];
  return fs.readFileSync(DATASET, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as BpRecord);
}

function ingest(dir: string, source: string, license: string, url?: string) {
  const rules = loadRules();
  const geom = loadRailGeometry();
  const zh = (n: string) => n;
  const files: string[] = [];
  const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== ".git") walk(p); } else if (/\.(json|txt)$/.test(f) && !f.startsWith("_") && !f.startsWith(".")) files.push(p); } };
  walk(dir);
  const loaded = loadDataset();
  const loadedById = new Map(loaded.map((r) => [r.id, r]));
  // 只替换同出处、同目录的 (出处名相同但目录不同的是另一批, 例: Brian's 的 2.0 原版和 1.1 迁移版)
  const relDir = labRel(path.resolve(dir));
  const keep = new Map(loaded.filter((r) => r.source !== source || r.dir !== relDir).map((r) => [r.id, r]));
  let added = 0, skipped = 0;
  for (const file of files) {
    let obj: Record<string, unknown> | null = null;
    try { obj = readAll(file); } catch { skipped++; continue; }
    if (!obj || !("blueprint" in obj || "blueprint_book" in obj)) { skipped++; continue; }
    const rel = path.relative(dir, file).replace(/\\/g, "/");
    for (const b of flatten(obj)) {
      const info = analyze(b.label, b.path, b.bp);
      if (!info.entities.length) continue;
      const unknown = Object.keys(info.counts).filter((n) => !rules.get(n));
      const findings = unknown.length ? null : checkBlueprint(info.entities, (b.bp as { wires?: number[][] }).wires, rules, zh, geom);
      const kinds: Record<string, number> = {};
      for (const f of findings ?? []) if (f.level !== "info") kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
      const rec: BpRecord = {
        id: `${source}:${rel}#${b.path || "0"}`, source, license, url, file: rel, dir: relDir, label: info.label,
        version: versionOf((b.bp as { version?: unknown }).version), entities: info.entities.length, size: info.size, counts: info.counts, recipes: info.recipes, unknown,
        check: findings ? { errors: findings.filter((f) => f.level === "error").length, warnings: findings.filter((f) => f.level === "warn").length, kinds } : null,
        category: categories(info.counts, info.recipes), ingested: new Date().toISOString().slice(0, 10),
      };
      const old = loadedById.get(rec.id);
      if (old?.measure && !old.measure.error) rec.measure = old.measure; // 重新收录时保留已有的实测
      if (old?.render && !old.render.error) rec.render = old.render; // 和配图
      if (old?.feed && !old.feed.error) rec.feed = old.feed; // 和喂料实测
      keep.set(rec.id, rec);
      added++;
    }
  }
  fs.mkdirSync(path.dirname(DATASET), { recursive: true });
  saveDataset(keep.values());
  console.log(`${source}: 收进 ${added} 张 (跳过 ${skipped} 个不是蓝图的文件); 数据集共 ${keep.size} 张 → ${path.relative(root, DATASET)}`);
}

function summary() {
  const all = loadDataset();
  const by = (f: (r: BpRecord) => string) => { const m: Record<string, number> = {}; for (const r of all) m[f(r)] = (m[f(r)] ?? 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  console.log(`共 ${all.length} 张`);
  console.log("出处 / 许可:", by((r) => `${r.source} (${r.license})`).map(([k, n]) => `${k} ${n}`).join("; "));
  console.log("版本:", by((r) => r.version ?? "无").map(([k, n]) => `${k} ${n}`).join("; "));
  console.log("检查器 (只算全认得的):", `0 错误 ${all.filter((r) => r.check && r.check.errors === 0).length}、有错误 ${all.filter((r) => r.check && r.check.errors > 0).length}、有认不出的建筑 ${all.filter((r) => !r.check).length}`);
  const cats: Record<string, number> = {};
  for (const r of all) for (const c of r.category) cats[c] = (cats[c] ?? 0) + 1;
  console.log("类别:", Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("; "));
  const errKinds: Record<string, number> = {};
  for (const r of all) for (const [k, n] of Object.entries(r.check?.kinds ?? {})) errKinds[k] = (errKinds[k] ?? 0) + n;
  console.log("检查器报得最多的:", Object.entries(errKinds).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join("; "));
}


type L = { n: number } | Record<string, never>;
const nOf = (l: L | undefined) => (l && "n" in l ? (l.n as number) : 0);

/** 把一张记录的蓝图放进沙盘 */
async function placeRecord(lab: LabInstance, r: BpRecord) {
  const obj = readAll(path.join(labPath(r.dir), r.file));
  const b = flatten(obj!).find((x) => (x.path || "0") === r.id.split("#").pop());
  if (!b) throw new Error("蓝图书里找不到这一张");
  return { b, ...(await placeBlueprint(lab, b.bp, b.label)) };
}

const CRAFTER_NAMES = /^(assembling-machine-[123]|stone-furnace|steel-furnace|electric-furnace|foundry|electromagnetic-plant|chemical-plant|cryogenic-plant|biochamber|recycler|centrifuge|oil-refinery)$/;

/** 第三层标签: 喂料测产量 (模组 feed_setup / feed_stats). 只测第二层完整建成、有机器的布局 */
async function feedMeasure(opts: { limit: number; id?: string; save: boolean; redo: boolean; warmS: number; measureS: number; research?: string }) {
  const all = loadDataset();
  const key = opts.research === "late" ? "feedLate" : "feed"; // 后期结果另存一栏, 不覆盖不研究的
  const todo = all.filter((r) => (opts.id ? r.id.includes(opts.id) : opts.redo || !r[key] || r[key]!.error)
    && r.measure && !r.measure.error && !r.measure.skipped && r.measure.ghosts > 0 && r.measure.built === r.measure.ghosts
    && Object.keys(r.counts).some((k) => CRAFTER_NAMES.test(k))).slice(0, opts.limit);
  console.log(`要喂料实测 ${todo.length} 张 (第二层完整建成、有机器的)`);
  const lab = new LabInstance({ name: "dataset-feed", view: false });
  await lab.createMap("ds", { seed: 1 });
  await lab.start("ds");
  const byId = new Map(all.map((r) => [r.id, r]));
  const save = () => { if (opts.save) saveDataset(byId.values()); };
  const at = () => new Date().toISOString().slice(0, 10);
  let done = 0;
  try {
    for (const r of todo) {
      const t0 = Date.now();
      try {
        const { b, area } = await placeRecord(lab, r);
        r[key] = await feedArea(lab, area, b.bp, { warmS: opts.warmS, measureS: opts.measureS, research: opts.research, log: opts.id || process.env.FEED_DEBUG ? (x) => console.log("  " + x.slice(0, 600)) : undefined });
      } catch (e) {
        r[key] = { feeds: 0, sinks: 0, inChests: 0, outChests: 0, crafters: 0, unsupported: {}, ...FEED_BLANK, research: opts.research ?? "none", error: (e as Error).message.slice(0, 200), at: at() };
      }
      byId.set(r.id, r);
      done++;
      const f = r[key]!;
      if (opts.id || !opts.save) console.log(`  ${r.id}: ${describeFeed(f)}`);
      if (done % 10 === 0 || done === todo.length) {
        save();
        console.log(`  ${done}/${todo.length} (最近一张 ${((Date.now() - t0) / 1000).toFixed(1)} 秒)`);
      }
    }
  } finally {
    save();
    await lab.stop({ save: false });
  }
  const fs2 = todo.map((r) => r[key]!);
  const ok = fs2.filter((x) => !x.error && !x.skipped);
  console.log(`喂料实测 ${fs2.length} 张: 测成 ${ok.length}、跳过 ${fs2.filter((x) => x.skipped).length}、出错 ${fs2.filter((x) => x.error).length}; 有效率的 ${ok.filter((x) => x.efficiency !== null).length} 张, 效率中位数 ${median(ok.map((x) => x.efficiency).filter((x): x is number => x !== null))}`);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** 第二层标签: 2.x、建筑全认得、还没测过的, 逐张进沙盘 (不喂原料): 建成多少、接上电没有、引擎核对清单 */
async function measure(limit: number, redo = false) {
  const all = loadDataset();
  const todo = all.filter((r) => (redo || !r.measure || r.measure.error) && r.version && !r.version.startsWith("1.") && r.unknown.length === 0).slice(0, limit);
  console.log(`要测 ${todo.length} 张 (只测 2.x、建筑全认得、没测过的)`);
  const lab = new LabInstance({ name: "dataset-measure", view: false });
  await lab.createMap("ds", { seed: 1 });
  await lab.start("ds");
  const byId = new Map(all.map((r) => [r.id, r]));
  let done = 0;
  try {
    for (const r of todo) {
      const t0 = Date.now();
      if (r.category.includes("列车编组")) {
        r.measure = { built: 0, ghosts: 0, failed: 0, status: {}, noNetwork: 0, ugOrphan: 0, fluidIsolated: 0, railDeadEnds: 0, signalsUnconnected: 0, stopsUnconnected: 0, skipped: "列车编组: 只有车辆, 要先铺轨才放得下, 不测布局", at: new Date().toISOString().slice(0, 10) };
        byId.set(r.id, r); done++; continue;
      }
      try {
        const { area, placed } = await placeRecord(lab, r);
        await lab.runTicks(300);
        const insp = (await lab.rpc("inspect", { area }, { timeoutMs: 600_000 })) as { status: Record<string, number> };
        const audit = (await lab.rpc("audit", { area, boxes: [], cap: 5 }, { timeoutMs: 600_000 })) as {
          unpowered: { n: number; items: { network?: boolean }[] | Record<string, never> } | Record<string, never>;
          belts: { ug_orphan: L }; fluids: { isolated: L }; rails: { dead_end: L }; signals: { unconnected: L }; stops: { unconnected: L };
        };
        const unp = audit.unpowered && "items" in audit.unpowered && Array.isArray(audit.unpowered.items) ? audit.unpowered.items : [];
        r.measure = { built: placed.built, ghosts: placed.ghosts, failed: placed.failed_count, status: insp.status, noNetwork: unp.filter((u) => u.network === false).length,
          ugOrphan: nOf(audit.belts.ug_orphan), fluidIsolated: nOf(audit.fluids.isolated), railDeadEnds: nOf(audit.rails.dead_end), signalsUnconnected: nOf(audit.signals.unconnected), stopsUnconnected: nOf(audit.stops.unconnected), at: new Date().toISOString().slice(0, 10) };
      } catch (e) {
        r.measure = { built: 0, ghosts: 0, failed: 0, status: {}, noNetwork: 0, ugOrphan: 0, fluidIsolated: 0, railDeadEnds: 0, signalsUnconnected: 0, stopsUnconnected: 0, error: (e as Error).message.slice(0, 200), at: new Date().toISOString().slice(0, 10) };
      }
      byId.set(r.id, r);
      done++;
      if (done % 20 === 0 || done === todo.length) {
        saveDataset(byId.values());
        console.log(`  ${done}/${todo.length} (最近一张 ${((Date.now() - t0) / 1000).toFixed(1)} 秒)`);
      }
    }
  } finally {
    await lab.stop({ save: false });
  }
  const m = todo.map((r) => r.measure!);
  console.log(`测完 ${m.length} 张: 全部建成 ${m.filter((x) => !x.error && !x.skipped && x.built === x.ghosts && x.ghosts > 0).length}、有没建成的 ${m.filter((x) => !x.error && !x.skipped && x.built < x.ghosts).length}、跳过 (列车编组) ${m.filter((x) => x.skipped).length}、出错 ${m.filter((x) => x.error).length}; 有不在电网里的用电建筑 ${m.filter((x) => x.noNetwork > 0).length}`);
}

/** 每张出一张图 (lab-data/datasets/renders/), 一个浏览器连着出; 每 10 张存一次 */
async function render(limit: number, redo: boolean) {
  const all = loadDataset();
  const todo = all.filter((r) => redo || !r.render || r.render.error).slice(0, limit);
  console.log(`要出图 ${todo.length} 张`);
  const byId = new Map(all.map((r) => [r.id, r]));
  const outDir = path.join(labRoot(), "datasets", "renders");
  const files = new Map<string, Record<string, unknown> | null>();
  const r0 = new BlueprintRenderer();
  let done = 0, failed = 0;
  const save = () => saveDataset(byId.values());
  try {
    for (const r of todo) {
      const t0 = Date.now();
      const at = new Date().toISOString().slice(0, 10);
      try {
        const f = path.join(labPath(r.dir), r.file);
        if (!files.has(f)) files.set(f, readAll(f));
        const name = `${r.source}-${createHash("sha1").update(r.id).digest("hex").slice(0, 10)}`;
        // 配图旁边有元数据就直接接回 (记录丢了也不用重出; 2026-11-02 那次整批替换后重出了 212 张)
        const meta = path.join(outDir, name + ".json");
        if (!redo && fs.existsSync(meta)) { r.render = { ...JSON.parse(fs.readFileSync(meta, "utf8")), at }; byId.set(r.id, r); done++; continue; }
        const b = flatten(files.get(f)!).find((x) => (x.path || "0") === r.id.split("#").pop());
        if (!b) throw new Error("蓝图书里找不到这一张");
        const res = await r0.render(encodeBlueprint({ blueprint: dropNulls(b.bp) as Record<string, unknown> }), { reference: referenceOf(b.bp) });
        const out = writeRender(path.join(outDir, name), res);
        r.render = { file: labRel(out), width: res.width, height: res.height, bytes: res.data.length, pxPerTile: Number(res.pxPerTile.toFixed(3)), origin: res.origin, at };
        fs.writeFileSync(meta, JSON.stringify({ ...r.render, id: r.id }));
      } catch (e) {
        r.render = { error: (e as Error).message.slice(0, 200), at };
        failed++;
      }
      byId.set(r.id, r);
      done++;
      if (done % 10 === 0 || done === todo.length) {
        save();
        console.log(`  ${done}/${todo.length} (最近一张 ${((Date.now() - t0) / 1000).toFixed(1)} 秒, 失败 ${failed})`);
      }
    }
  } finally {
    save();
    await r0.close();
  }
  const ok = todo.filter((r) => r.render && !r.render.error);
  const kb = ok.map((r) => r.render!.bytes! / 1000);
  console.log(`出完 ${ok.length}/${todo.length} 张, 失败 ${failed}; 平均 ${(kb.reduce((a, b) => a + b, 0) / Math.max(1, kb.length)).toFixed(0)}KB, 最大 ${Math.max(0, ...kb).toFixed(0)}KB`);
  for (const r of todo.filter((x) => x.render?.error)) console.log(`  ✗ ${r.id}: ${r.render!.error}`);
}

/** 1.1 → 2.1 迁移: 不手写名字对照表, 让游戏导入 (按蓝图版本自己迁移旧名字) 再导出。字符串分块送进沙盘 (RCON 单条参数实测约 5 万字可靠, lab.md #10) */
async function migrate(inFile: string, outFile: string) {
  const text = fs.readFileSync(inFile, "utf8").trim();
  const lab = new LabInstance({ name: "dataset-migrate", view: false });
  await lab.createMap("mig", { seed: 1 });
  await lab.start("mig");
  try {
    const CHUNK = 40_000;
    await lab.rpc("exec", { code: "storage.mig = {} return true", args: {} });
    for (let i = 0; i < text.length; i += CHUNK) {
      await lab.rpc("exec", { code: "local a = ... storage.mig[#storage.mig + 1] = a.part return #storage.mig", args: { part: text.slice(i, i + CHUNK) } });
    }
    const r = (await lab.rpc("exec", { code: `local inv = game.create_inventory(1)
      local res = inv[1].import_stack(table.concat(storage.mig))
      storage.mig = nil
      if res == -1 then inv.destroy() error("游戏导入失败 (import_stack = -1)", 0) end
      local out = inv[1].export_stack()
      inv.destroy()
      return {result = res, out = out}`, args: {} }, { timeoutMs: 600_000 })) as { result: number; out: string };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, r.out);
    const before = flatten(decodeBlueprint(text)), after = flatten(decodeBlueprint(r.out));
    const ver = (v: unknown) => versionOf(v) ?? "?";
    console.log(`${path.basename(inFile)}: ${before.length} 张 (${[...new Set(before.map((b) => ver(b.bp.version)))].join("/")}) → ${after.length} 张 (${[...new Set(after.map((b) => ver(b.bp.version)))].join("/")}); 导入结果 ${r.result === 0 ? "无错" : "有错误 (有认不出的东西被丢掉)"}; ${text.length} → ${r.out.length} 字 → ${outFile}`);
  } finally {
    await lab.stop({ save: false });
  }
}

/** 检索 (设计时取示例给模型看): 按类别 / 产物筛, 喂料实测过的按成品产量排前, 带配图路径和预览链接 */
function find(opts: { category?: string; product?: string; top: number }) {
  const all = loadDataset();
  const hit = all.filter((r) => (!opts.category || r.category.includes(opts.category))
    && (!opts.product || (r.feed?.final ?? []).includes(opts.product) || Object.keys(r.recipes).includes(opts.product)));
  const score = (r: BpRecord) => (r.feed && !r.feed.error && !r.feed.skipped ? (r.feed.final.reduce((n, k) => n + (r.feed!.perMin[k] ?? 0), 0)) : -1);
  const ranked = hit.sort((a, b) => score(b) - score(a) || (b.measure?.built ?? 0) - (a.measure?.built ?? 0)).slice(0, opts.top);
  const files = new Map<string, Record<string, unknown> | null>();
  console.log(`共 ${hit.length} 张符合, 列前 ${ranked.length} 张 (喂料实测过的按成品每分钟产量排)\n`);
  console.log("| 蓝图 | 出处 | 大小 | 建筑 | 成品每分钟 | 效率 | 开工率 | 图 | 预览 |\n|---|---|---|---|---|---|---|---|---|");
  for (const r of ranked) {
    const f = path.join(labPath(r.dir), r.file);
    if (!files.has(f)) files.set(f, readAll(f));
    const b = flatten(files.get(f)!).find((x) => (x.path || "0") === r.id.split("#").pop());
    let link = "";
    try { link = b ? previewLink(encodeBlueprint({ blueprint: dropNulls(b.bp) as Record<string, unknown> })) : ""; } catch { link = "(没设 FBE_DIR)"; }
    const fd = r.feed && !r.feed.error && !r.feed.skipped ? r.feed : null;
    console.log(`| ${r.label} | ${r.source} | ${r.size.w}×${r.size.h} | ${r.entities} | ${fd ? fd.final.map((k) => [k, fd.perMin[k] ?? 0] as const).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(", ") + (fd.final.length > 3 ? ` 等 ${fd.final.length} 种` : "") : "—"} | ${fd?.efficiency ?? "—"} | ${fd ? (fd.status.working ?? 0) : "—"} | ${r.render?.file ?? "—"} | ${link.length > 120 ? link.slice(0, 117) + "..." : link} |`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { source: { type: "string" }, license: { type: "string" }, url: { type: "string" }, limit: { type: "string" }, redo: { type: "boolean", default: false }, id: { type: "string" }, nosave: { type: "boolean", default: false }, category: { type: "string" }, product: { type: "string" }, top: { type: "string" }, warm: { type: "string", default: "60" }, seconds: { type: "string", default: "180" }, research: { type: "string", default: "none" } } });
if (cmd === "ingest" && positionals[0] && values.source && values.license) ingest(positionals[0], values.source, values.license, values.url);
else if (cmd === "summary") summary();
else if (cmd === "measure") await measure(Number(values.limit ?? 1e9), values.redo);
else if (cmd === "migrate" && positionals[0] && positionals[1]) await migrate(positionals[0], positionals[1]);
else if (cmd === "find") find({ category: values.category, product: values.product, top: Number(values.top ?? 5) });
else if (cmd === "render") await render(Number(values.limit ?? 1e9), values.redo);
else if (cmd === "feed") await feedMeasure({ limit: Number(values.limit ?? 1e9), id: values.id, save: !values.nosave, redo: values.redo, warmS: Number(values.warm), measureS: Number(values.seconds), research: values.research });
else console.log("用法: dataset ingest <目录> --source <名字> --license <SPDX|unknown> [--url <地址>] | dataset summary | dataset measure [--limit N] | dataset render [--limit N] [--redo]");
