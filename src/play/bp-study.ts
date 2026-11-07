// ./bp study / view / check: 让模型自己看真实基地和自己的蓝图 (库, 不直接运行; bp.ts、plan.ts、fh-shim 用)。
//  /
// "蓝图本身模型看不到图 我们不是有一个蓝图编辑器吗？就是给他们用的啊"。
// 字符图所有模型都读得了; 真图走本机蓝图编辑器 (BlueprintRenderer), 能看图的模型用 Read 打开, 用户也能开预览链接。
// 自己的蓝图 (.txt 蓝图字符串 / .json 实体列表): study → 设计 → view 看 → check 查 → ./bp build 文件 建。朋友的蓝图原文只在本机 lab-data。
import fs from "node:fs";
import path from "node:path";
import { labRoot } from "../lab/gamedir.ts";
import { decodeBlueprint, encodeBlueprint } from "../lab/blueprint.ts";
import { flatten } from "../blueprint/inspect.ts";
import { loadRules, type Rules } from "../blueprint/rules.ts";
import type { Placed } from "../blueprint/placed.ts";
import { loadZhNames } from "./chattags.ts";
import { datasetDir } from "./bp.ts";
import { blocksOf, machineKey, nearBlock, overview, placeAll, study, studyText, type Block } from "./layout-study.ts";

const SOURCE_LABEL = "朋友的新地星基地 (2026-10-31 本人同意参考)";
const NO_DATA = "本机没有这份参考蓝图 (lab-data/blueprints/friend-demo.txt)";

type Ref = { bp: Record<string, any>; placed: Placed[]; rules: Rules; label: string; surface: string | null };
let cached: Ref | null | undefined;
function reference(): Ref | null {
  if (cached !== undefined) return cached;
  const f = path.join(labRoot(), "training-private", "blueprints", "datasets", "local", "friend-demo.txt");
  if (!fs.existsSync(f)) return (cached = null);
  const bp = flatten(decodeBlueprint(fs.readFileSync(f, "utf8").trim()) as any)[0]?.bp as Record<string, any> | undefined;
  if (!bp) return (cached = null);
  const rules = loadRules();
  return (cached = { bp, rules, placed: placeAll(bp.entities ?? [], rules), label: SOURCE_LABEL, surface: null });
}

// 全图布局 (src/play/world-export.ts 导出, 只在本机 lab-data): 全部星球和太空平台; 没导出就退回上面那一张蓝图
export type WorldIndex = { hours: number; surfaces: { name: string; entities: number; machines: number }[]; keys: Record<string, Record<string, number>> };
const PLANET_ZH: Record<string, string> = { nauvis: "新地星", vulcanus: "祝融星", gleba: "句芒星", fulgora: "雷神星", aquilo: "玄冥星" };
export const surfaceZh = (s: string) => PLANET_ZH[s] ?? (s.startsWith("platform-") ? `太空平台 ${s.slice("platform-".length)}` : s);
const worldFile = (name: string) => path.join(labRoot(), "training-private", "blueprints", "friend", "world", `${name}.json`);
let worldCached: WorldIndex | null | undefined;
function worldIndex(): WorldIndex | null {
  if (worldCached !== undefined) return worldCached;
  try { worldCached = JSON.parse(fs.readFileSync(worldFile("index"), "utf8")) as WorldIndex; } catch { worldCached = null; }
  return worldCached;
}
const worldRefs = new Map<string, Ref>();
function worldRef(surface: string): Ref | null {
  const had = worldRefs.get(surface);
  if (had) return had;
  const idx = worldIndex();
  if (!idx) return null;
  let bp: Record<string, any>;
  try { bp = JSON.parse(fs.readFileSync(worldFile(surface), "utf8")); } catch { return null; }
  const rules = loadRules();
  const ref: Ref = { bp, rules, placed: placeAll(bp.entities ?? [], rules), label: `朋友的基地${surfaceZh(surface)} (他玩了 ${idx.hours} 小时的存档; 2026-10-31 本人同意参考)`, surface };
  worldRefs.set(surface, ref);
  return ref;
}
/** 这种东西看哪个地表: 给了就用它, 没给挑机器最多的 (一样多优先新地星); 没有 null */
export function surfaceFor(idx: WorldIndex, key: string, wanted?: string): string | null {
  const row = idx.keys[key];
  if (!row) return null;
  if (wanted) {
    const hit = Object.keys(row).find((s) => s === wanted || surfaceZh(s) === wanted || surfaceZh(s).includes(wanted));
    return hit ?? null;
  }
  return Object.entries(row).sort((a, b) => b[1] - a[1] || (a[0] === "nauvis" ? -1 : b[0] === "nauvis" ? 1 : 0))[0]?.[0] ?? null;
}
/** 这种东西的参考: 全图有就用全图, 没有用那张蓝图 */
function refFor(key: string, wanted?: string): Ref | null {
  const idx = worldIndex();
  const s = idx && surfaceFor(idx, key, wanted);
  return (s ? worldRef(s) : null) ?? reference();
}
function allKeyCounts(): Map<string, number> {
  const idx = worldIndex();
  if (idx) return new Map(Object.entries(idx.keys).map(([k, row]) => [k, Object.values(row).reduce((a, b) => a + b, 0)]));
  const ref = reference();
  return ref ? keyCounts(ref.placed) : new Map();
}

const zhNames = () => { try { return loadZhNames(process.env.FH_PROTO ?? path.join(labRoot(), "prototypes")); } catch { return new Map<string, string>(); } };

/** 名字 → 分组键: 内部名、官方中文名、中文名的一部分 (绿瓶、电路板); 选机器最多的; 认不出 null */
export function resolveKey(query: string, keys: Map<string, number>, zh: Map<string, string>): string | null {
  if (keys.has(query)) return query;
  const q = query.toLowerCase();
  const hits = [...keys.keys()].filter((k) => zh.get(k) === query);
  const loose = hits.length ? hits : [...keys.keys()].filter((k) => (zh.get(k) ?? "").includes(query) || k.toLowerCase().includes(q));
  return loose.sort((a, b) => (keys.get(b) ?? 0) - (keys.get(a) ?? 0) || a.length - b.length)[0] ?? null;
}

function keyCounts(placed: Placed[]): Map<string, number> {
  const c = new Map<string, number>();
  for (const p of placed) { const k = machineKey(p); if (k) c.set(k, (c.get(k) ?? 0) + 1); }
  return c;
}

/** 数据集里 CC0 的社区蓝图 (不太大的), 同一本书只解码一次; 给 --from 社区: 同一条线看另一种做法 */
function communityBlocks(key: string): { label: string; source: string; placed: Placed[]; block: Block }[] {
  const f = path.join(labRoot(), "training-private", "blueprints", "datasets", "index.jsonl");
  if (!fs.existsSync(f)) return [];
  const rows = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>).filter((r) => r.license === "CC0-1.0" && r.entities <= 3000);
  const rules = loadRules();
  const books = new Map<string, ReturnType<typeof flatten>>();
  const out: { label: string; source: string; placed: Placed[]; block: Block }[] = [];
  const seen = new Set<string>(); // 同一块在书的后面几张里重复: 只留第一张
  for (const r of rows) {
    const file = path.join(datasetDir(String(r.dir)), r.file);
    if (!fs.existsSync(file)) continue;
    if (!books.has(file)) books.set(file, flatten(decodeBlueprint(fs.readFileSync(file, "utf8").trim()) as any));
    const it = books.get(file)!.find((x) => (x.path || "0") === String(r.id).split("#").pop());
    if (!it || !(it.bp.entities ?? []).some((e: any) => e.recipe === key || e.name === key)) continue;
    const placed = placeAll(it.bp.entities ?? [], rules);
    const b = pick(placed, key)[0];
    if (!b) continue;
    const sig = `${r.source}:${b.machines.length}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ label: String(r.label), source: String(r.source), placed, block: b });
  }
  return out.sort((a, c) => c.block.machines.length - a.block.machines.length);
}

/** 这个组里挑一段: 默认要有 3 台以上的, 机器多的在前 */
function pick(placed: Placed[], key: string): Block[] {
  const all = blocksOf(placed, key);
  const big = all.filter((b) => b.machines.length >= 3);
  return big.length ? big : all;
}

/** 放机器提示 / ./plan 用: 一小段参考图; 没有就 null */
export function studyHint(key: string, maxW = 60, maxH = 18): string | null {
  const ref = refFor(key);
  if (!ref) return null;
  const blocks = pick(ref.placed, key);
  if (!blocks.length) return null;
  const zh = zhNames();
  const s = study(nearBlock(ref.placed, blocks[0]), blocks[0], (id) => zh.get(id), { maxW, maxH });
  const name = zh.get(key) ?? key;
  return studyText(`参考 (${ref.label}真实的一段, 不是让你抄, 看别人怎么摆 ${name}; 全部 ${blocks.length} 段、真图: ./bp study ${key} --image):`, s);
}

/** 蓝图自己的字符图 (./bp build 放完回: 字符图给模型, 真图给人在界面看); 画不了 null */
export function blockPicture(bp: Record<string, any>, origin: { x: number; y: number } | null, maxW = 60, maxH = 20): string | null {
  const placed = placeAll(bp.entities ?? [], loadRules());
  const key = placed.map(machineKey).find((k): k is string => !!k);
  if (!key) return null;
  const blocks = blocksOf(placed, key);
  if (!blocks.length) return null;
  const zh = zhNames();
  const s = study(placed, blocks[0], (id) => zh.get(id), { maxW, maxH, pad: 0 });
  return studyText(`这块的样子${origin ? ` (蓝图原点在 ${origin.x},${origin.y})` : ""}:`, s);
}

const argOf = (args: string[], k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

async function renderFile(bp: Record<string, any>, base: string): Promise<{ file: string; note: string }> {
  const { BlueprintRenderer, referenceOf, writeRender } = await import("../blueprint/render.ts");
  const r = new BlueprintRenderer({ keepEditor: true });
  try {
    const res = await r.render(encodeBlueprint({ blueprint: bp }), { maxSide: 800, maxBytes: 300_000, alt: true, grid: true, reference: referenceOf(bp as any), timeoutMs: 90_000 });
    return { file: writeRender(path.resolve(base), res), note: `${res.width}×${res.height}, ${(res.data.length / 1000).toFixed(0)}KB, ${(res.ms / 1000).toFixed(1)} 秒` };
  } finally { await r.close(); }
}

function logView(cmd: string, label: string, source: string, bp: Record<string, any>, w: number, h: number) {
  try {
    const sf = process.env.FP_SESSION ?? path.join(labRoot(), "play", "session.json");
    const s = JSON.parse(fs.readFileSync(sf, "utf8")) as { logDir?: string; agent?: string };
    if (s.logDir) fs.appendFileSync(path.join(s.logDir, "blueprints.jsonl"), JSON.stringify({ at: new Date().toISOString(), agent: s.agent ?? "a", cmd, no: 0, label, source, w, h, bp: encodeBlueprint({ blueprint: bp }) }) + "\n");
  } catch { /* 没有会话或写不上: 不影响命令 */ }
}

/** ./bp study --map [星球]: 整个地表的分区图 */
function mapCmd(wanted: string | undefined, zh: Map<string, string>): number {
  const idx = worldIndex();
  if (!idx) { console.log("error: 本机没有全图布局 (lab-data/friend-world, npm run play:world-export 导出)"); return 1; }
  const big = [...idx.surfaces].sort((a, b) => b.machines - a.machines);
  const s = wanted ? big.find((x) => x.name === wanted || surfaceZh(x.name) === wanted || surfaceZh(x.name).includes(wanted))?.name : "nauvis";
  if (!s) { console.log(`error: 没有 "${wanted}"; 有: ${big.map((x) => surfaceZh(x.name)).join("、")}`); return 1; }
  const ref = worldRef(s);
  if (!ref) { console.log(`error: 读不了 ${surfaceZh(s)} 的布局`); return 1; }
  const o = overview(ref.placed, (id) => zh.get(id));
  console.log(`${ref.label}的分区图 (每个字符是这一片数量最多的生产线; 看它怎么分区、原料从哪进、哪些线挨着, 自己想明白):`);
  console.log(o.legend);
  console.log(o.map);
  console.log(`读数: ${o.facts.join("; ")}`);
  console.log(`看某条线的细节: ./bp study 物品 --planet ${surfaceZh(s)}; 别的星球: ${big.filter((x) => x.name !== s && x.machines >= 10).slice(0, 8).map((x) => `./bp study --map ${surfaceZh(x.name)}`).join("、")}`);
  return 0;
}

/** ./bp study [物品] [第几段] [--planet 星球] [--image]; ./bp study --map [星球] */
export async function studyCmd(args: string[]): Promise<number> {
  const planet = argOf(args, "--planet");
  const pos = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out" && args[i - 1] !== "--planet");
  const zh = zhNames();
  if (args.includes("--map")) return mapCmd(pos[0], zh);
  const keys = allKeyCounts();
  if (!keys.size) { console.log(`error: ${NO_DATA}`); return 1; }
  if (!pos.length) {
    const idx = worldIndex();
    if (idx) {
      console.log(`朋友的基地 (他玩了 ${idx.hours} 小时的存档; 2026-10-31 本人同意参考): ${idx.surfaces.filter((s) => s.machines > 0).sort((a, b) => b.machines - a.machines).slice(0, 8).map((s) => `${surfaceZh(s.name)} ${s.machines} 台`).join("、")}。整片怎么分区: ./bp study --map 星球`);
      console.log("能看的生产线 (./bp study 名字 [第几段] [--planet 星球] [--image]):");
      console.log([...keys].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([k, n]) => `${zh.get(k) ?? k} ${n} 台`).join(" | "));
      return 0;
    }
    const demo = reference()!;
    console.log(`${SOURCE_LABEL}: 真实基地里能看的生产线 (./bp study 名字 [第几段] [--image]):`);
    const rows = [...keys].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, n]) => `${zh.get(k) ?? k} ${n} 台 ${pick(demo.placed, k).length} 段`);
    console.log(rows.join(" | "));
    return 0;
  }
  const key = resolveKey(pos[0], keys, zh);
  if (!key) { console.log(`error: 这个基地里没有 "${pos[0]}" (./bp study 看全部)`); return 1; }
  const idx = worldIndex();
  if (planet && idx && !surfaceFor(idx, key, planet)) { console.log(`error: ${surfaceZh(planet)} 没有 ${zh.get(key) ?? key}; 有的: ${Object.entries(idx.keys[key] ?? {}).map(([s, n]) => `${surfaceZh(s)} ${n} 台`).join("、")}`); return 1; }
  const ref = refFor(key, planet);
  if (!ref) { console.log(`error: ${NO_DATA}`); return 1; }
  if (args.includes("--community")) {
    const list = communityBlocks(key);
    if (!list.length) { console.log(`社区蓝图里没有 ${zh.get(key) ?? key}。`); return 0; }
    const i = Math.min(Math.max(Number(pos[1] ?? 1) || 1, 1), list.length);
    const c = list[i - 1];
    console.log(studyText(`社区蓝图 ${c.source} "${c.label}" (CC0; 第 ${i}/${list.length} 张${list.length > 1 ? `; 下一张: ./bp study ${key} ${i % list.length + 1} --community` : ""})。不是让你抄, 和别的做法比一比。`, study(c.placed, c.block, (id) => zh.get(id), { maxW: 60, maxH: 26, pad: 3 })));
    return 0;
  }
  const blocks = pick(ref.placed, key);
  const n = Math.min(Math.max(Number(pos[1] ?? 1) || 1, 1), blocks.length);
  const s = study(nearBlock(ref.placed, blocks[n - 1]), blocks[n - 1], (id) => zh.get(id));
  const name = zh.get(key) ?? key;
  const planetArg = ref.surface && planet ? ` --planet ${surfaceZh(ref.surface)}` : "";
  const elsewhere = ref.surface && idx ? Object.entries(idx.keys[key] ?? {}).filter(([x]) => x !== ref.surface).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([x, c]) => `./bp study ${key} --planet ${surfaceZh(x)} (${c} 台)`) : [];
  const more = `${blocks.length > 1 ? `; 下一段: ./bp study ${key} ${n % blocks.length + 1}${planetArg}` : ""}${elsewhere.length ? `; 别的星球: ${elsewhere.join("、")}` : ""}; 另一种做法: ./bp study ${key} --community`;
  console.log(studyText(`${ref.label}真实的一段 (第 ${n}/${blocks.length} 段${more})。不是让你抄: 看它的机器怎么排、带子几条怎么共用、机器之间怎么直接传, 自己想明白再设计。${s.machines < blocks[n - 1].machines.length ? ` 这段太大, 图里只画了一部分 (${s.machines} 台)。` : ""}`, s,
    "想明白的写进 notes.md 的 ## Lessons (不带坐标), 全队和下一班都能用。自己设计: 写 .json {entities:[{name,position:{x,y},direction,recipe}]} → ./bp view 文件 看图 → ./bp check 文件 查错 → ./bp build 文件 --at x,y 建。"));
  if (args.includes("--image")) {
    const { cropBlueprint } = await import("../blueprint/render.ts");
    const crop = cropBlueprint(ref.bp as any, s.crop);
    logView("study", `参考: ${name} 第 ${n} 段`, "朋友基地", crop, s.width, s.height);
    try {
      const out = await renderFile(crop, argOf(args, "--out") ?? `study-${key}-${n}`);
      console.log(`真图: ${path.basename(out.file)} (${out.note}), 用 Read 打开看。`);
    } catch (e) { console.log(`真图没出来 (字符图不受影响): ${(e as Error).message.slice(0, 200)}`); }
  }
  return 0;
}

/** 模型自己写的蓝图: .txt = 蓝图字符串 (./bp file 或 blueprint_export 给的), .json = {entities:[...]} 或完整 {blueprint:{...}} */
export function readOwnBlueprint(file: string): Record<string, any> {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text.startsWith("{")) return flatten(decodeBlueprint(text) as any)[0].bp as Record<string, any>;
  const o = JSON.parse(text);
  const bp = (o.blueprint ?? o) as Record<string, any>;
  if (!Array.isArray(bp.entities)) throw new Error("JSON 里要有 entities 列表");
  return { item: "blueprint", label: path.basename(file), version: 562949958402048, ...bp, entities: bp.entities.map((e: any, i: number) => ({ entity_number: i + 1, ...e })) };
}

/** ./bp view 编号或文件 */
export async function viewCmd(args: string[], byNumber: (n: number) => { bp: Record<string, any>; label: string } | null): Promise<number> {
  const what = args.find((a) => !a.startsWith("--"));
  if (!what) { console.log("用法: ./bp view 编号或文件 (.txt 蓝图字符串 / .json {entities:[...]}): 用本机蓝图编辑器出图"); return 1; }
  let bp: Record<string, any>, label: string;
  try {
    const hit = /^\d+$/.test(what) ? byNumber(Number(what)) : null;
    if (/^\d+$/.test(what) && !hit) { console.log(`error: 没有编号 ${what} (./bp list 看编号)`); return 1; }
    if (hit) { bp = hit.bp; label = hit.label; } else { bp = readOwnBlueprint(what); label = path.basename(what); }
  } catch (e) { console.log(`error: 读不了 ${what}: ${(e as Error).message.slice(0, 200)}`); return 1; }
  const xs = (bp.entities ?? []).map((e: any) => e.position);
  if (!xs.length) { console.log("error: 这张蓝图是空的"); return 1; }
  const w = Math.ceil(Math.max(...xs.map((p: any) => p.x)) - Math.min(...xs.map((p: any) => p.x)) + 1), h = Math.ceil(Math.max(...xs.map((p: any) => p.y)) - Math.min(...xs.map((p: any) => p.y)) + 1);
  logView("view", label, /^\d+$/.test(what) ? "蓝图库" : "自己的", bp, w, h);
  try {
    const out = await renderFile(bp, argOf(args, "--out") ?? `view-${path.basename(what).replace(/\.\w+$/, "")}`);
    const { previewLink } = await import("../blueprint/render.ts");
    console.log(`图: ${path.basename(out.file)} (${w}×${h} 格, ${out.note}), 用 Read 打开看。编辑器里打开: ${previewLink(encodeBlueprint({ blueprint: bp })).slice(0, 200)}`);
    return 0;
  } catch (e) { console.log(`error: 出图失败: ${(e as Error).message.slice(0, 300)}`); return 1; }
}

/** ./bp check 文件: 静态检查 (重叠、供电、传送带、地下带、流体口、机械臂目标), 不碰游戏 */
export async function checkCmd(args: string[]): Promise<number> {
  const what = args.find((a) => !a.startsWith("--"));
  if (!what) { console.log("用法: ./bp check 文件 (.txt / .json)"); return 1; }
  try {
    const bp = readOwnBlueprint(what);
    const { analyze } = await import("../blueprint/inspect.ts");
    const { checkBlueprint, summarize } = await import("../blueprint/check.ts");
    const { loadRailGeometry } = await import("../blueprint/rail-geometry.ts");
    const info = analyze(path.basename(what), "", bp as any);
    const zh = zhNames();
    const findings = checkBlueprint(info.entities, bp.wires, loadRules(), (n: string) => zh.get(n) ?? n, loadRailGeometry());
    console.log(`${path.basename(what)} (${info.entities.length} 件) → ${summarize(findings)}`);
    for (const f of findings.slice(0, 30)) console.log(`  ${f.level === "error" ? "错" : f.level === "warn" ? "警告" : "提示"} ${f.msg}`);
    if (findings.length > 30) console.log(`  …还有 ${findings.length - 30} 条`);
    return findings.some((f) => f.level === "error") ? 1 : 0;
  } catch (e) { console.log(`error: 查不了 ${what}: ${(e as Error).message.slice(0, 300)}`); return 1; }
}
