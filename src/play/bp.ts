#!/usr/bin/env node
// bp: 给大脑查现成蓝图 (docs/brain-run.md 第三轮)。来源: 我们的生成器 (冶炼列、组装机排, 带喂料实测) + 数据集里 CC0、沙盘实测完整建成的社区蓝图。
// 只给候选和实测数, 用不用、放哪由大脑定 (架构 2b)。放下去: ./fp blueprint_import --blueprint-file <文件> → ./fp paste '{"position":...}' → ./fp construct --wait
//   bp list [关键词]   bp show 编号   bp file 编号
import fs from "node:fs";
import path from "node:path";
import { labRoot, REPO } from "../lab/gamedir.ts";
import { decodeBlueprint, encodeBlueprint } from "../lab/blueprint.ts";
import { flatten } from "../blueprint/inspect.ts";
import { argvFromFile } from "./argv-file.ts";
import { gather, handRecipeOf, lacking } from "./bp-gather.ts";
import type { At, BpEntity, Dry, Verify, WireCheck } from "./bp-fit.ts";

/** 蓝图里的机器台数 (play:seen 比"蓝图放的 vs 手放的"; 放机器提示认的是同一批) */
const MACHINE_NAME = /^(assembling-machine-\d|stone-furnace|steel-furnace|electric-furnace|chemical-plant|oil-refinery|lab|centrifuge|foundry|electromagnetic-plant|cryogenic-plant|biochamber|recycler)$/;
export const machineCount = (counts: Record<string, number>) => Object.entries(counts).filter(([k]) => MACHINE_NAME.test(k)).reduce((a, [, n]) => a + n, 0);

export type Entry = { no: number; source: string; label: string; w: number; h: number; entities: number; counts: Record<string, number>; io: string; get: () => Record<string, unknown> };
// 本机数据走 labRoot() (LAB_DATA_DIR): 写死仓库/lab-data 时, 在共用数据的工作树里找不到蓝图库 (2026-11-03 play:check "没有编号 1")
// 本机没有就用仓库带的 (tools/export-public.ts 导的: 自己生成的、CC0 的)
// 新项目的本机数据在 data/training-private/blueprints/ (第二版是 lab-data/ 直接放), 公开区在 training/blueprints/
const BP_DATA = path.join(labRoot(), "training-private", "blueprints");
const GEN = fs.existsSync(path.join(BP_DATA, "generated")) ? path.join(BP_DATA, "generated") : path.join(REPO, "training", "blueprints", "generated");
// 数据集索引直接读 (src/dataset/ingest.ts 是脚本, import 会跑它的命令行)
const loadDataset = () => { const local = path.join(BP_DATA, "datasets", "index.jsonl"); const f = fs.existsSync(local) ? local : path.join(REPO, "training", "blueprints", "index.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []; };
// 数据集条目的 dir 是第二版相对仓库根写的 ("lab-data/datasets/..."): 换成新项目的本机数据目录
export const datasetDir = (dir: string) => (dir.startsWith("lab-data/datasets/") ? path.join(BP_DATA, "datasets", dir.slice("lab-data/datasets/".length)) : dir.startsWith("lab-data/") ? path.join(labRoot(), dir.slice("lab-data/".length)) : path.join(REPO, dir));
const readText = (f: string) => fs.readFileSync(f, "utf8").trim();
const readObj = (f: string): Record<string, unknown> => (f.endsWith(".json") ? JSON.parse(readText(f)) : decodeBlueprint(readText(f)));

function countsOf(bp: Record<string, any>) {
  const c: Record<string, number> = {};
  for (const e of bp.entities ?? []) c[e.name] = (c[e.name] ?? 0) + 1;
  return c;
}

/** 生成器: 蓝图书 + 每张的喂料实测 (同序) */
function generated(out: Entry[], file: string, feedFile: string, needFeed = false) {
  const f = path.join(GEN, file);
  if (!fs.existsSync(f) || (needFeed && !fs.existsSync(path.join(GEN, feedFile)))) return; // 没实测过的新块不进库
  const items = flatten(readObj(f) as any);
  const feed = fs.existsSync(path.join(GEN, feedFile)) ? (JSON.parse(readText(path.join(GEN, feedFile))) as Record<string, any>[]) : [];
  items.forEach((it, i) => {
    const fd = feed[i] ?? {};
    const counts = countsOf(it.bp);
    const xs = (it.bp.entities ?? []).map((e: any) => e.position);
    const w = fd.w ?? Math.ceil(Math.max(...xs.map((p: any) => p.x)) - Math.min(...xs.map((p: any) => p.x)) + 1), h = fd.h ?? Math.ceil(Math.max(...xs.map((p: any) => p.y)) - Math.min(...xs.map((p: any) => p.y)) + 1);
    const io = fd.outPerMin ? `实测出 ${fd.outPerMin}/分, 吃 ${Object.entries(fd.fed ?? {}).map(([k, v]) => `${k} ${v}`).join(" ")}/分, 电 ${fd.powerMW ?? "?"} MW` : "";
    out.push({ no: 0, source: "生成", label: it.label, w, h, entities: (it.bp.entities ?? []).length, counts, io, get: () => it.bp });
  });
}

export function entries(): Entry[] {
  const out: Entry[] = [];
  generated(out, "smelter-columns.txt", "smelter-columns.feed.json");
  generated(out, "asm-try.txt", "asm-try.feed.json");
  // 数据集: CC0、沙盘实测完整建成、不太大的
  for (const r of loadDataset() as any[]) {
    if (r.license !== "CC0-1.0" || !r.measure || r.measure.failed !== 0 || !r.measure.built || r.entities > 800) continue;
    const fd = r.feed ?? {};
    const io = fd.perMin && Object.keys(fd.perMin).length ? `实测出 ${Object.entries(fd.perMin).map(([k, v]) => `${k} ${(v as number).toFixed(1)}`).join(" ")}/分` : "";
    out.push({ no: 0, source: "CC0 " + r.source, label: `${r.label}`.slice(0, 60), w: r.size.w, h: r.size.h, entities: r.entities, counts: r.counts, io,
      get: () => { const b = flatten(readObj(path.join(datasetDir(r.dir), r.file)) as any).find((x) => (x.path || "0") === r.id.split("#").pop()); if (!b) throw new Error("蓝图书里找不到这一张"); return b.bp; } });
  }
  // 2026-11-05 补的组装机排 (tools/generators/asm_lib_spec.ts): 放在最后, 前面已有的编号不变 (班中上线, 大脑记着的编号还能用)
  generated(out, "asm-lib.txt", "asm-lib.feed.json", true);
  generated(out, "asm-early.txt", "asm-early.feed.json", true);
  generated(out, "chem-rows.txt", "chem-rows.feed.json", true);
  out.forEach((e, i) => { e.no = i + 1; });
  return out;
}

/** `bp list` 的行 (run.ts 的要点提示也用它给蓝图候选, src/play/hints.ts); 关键词按名字 / 用到的实体内部名筛 */
export function listLines(kw?: string, limit = 60): string[] {
  const k = kw?.toLowerCase();
  const rows = entries().filter((e) => !k || e.label.toLowerCase().includes(k) || Object.keys(e.counts).some((x) => x.includes(k)));
  const out = rows.slice(0, limit).map((e) => `${e.no}. [${e.source}] ${e.label} | ${e.w}x${e.h} | ${e.entities} 个实体${e.io ? " | " + e.io : ""}`);
  if (rows.length > limit) out.push(`…共 ${rows.length} 张, 加关键词缩小`);
  return out;
}

/** 模型自己的蓝图当一块用 (./bp build 文件 --at x,y); 读不了返回原因 */
async function ownEntry(file: string): Promise<Entry | string> {
  try {
    const bp = (await import("./bp-study.ts")).readOwnBlueprint(file);
    const xs = (bp.entities as any[]).map((x) => x.position);
    const w = Math.ceil(Math.max(...xs.map((p) => p.x)) - Math.min(...xs.map((p) => p.x)) + 1), h = Math.ceil(Math.max(...xs.map((p) => p.y)) - Math.min(...xs.map((p) => p.y)) + 1);
    return { no: 0, source: "自己的", label: path.basename(file), w, h, entities: bp.entities.length, counts: countsOf(bp), io: "", get: () => bp };
  } catch (err) { return (err as Error).message.slice(0, 200); }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === "study") return (await import("./bp-study.ts")).studyCmd(argv.slice(1));
  if (cmd === "check") return (await import("./bp-study.ts")).checkCmd(argv.slice(1));
  const all = entries();
  if (!cmd || cmd === "help") { console.log("bp study [物品] [第几段] [--image]   看真实基地里这条线怎么摆 (字符图 + 读数; --image 用蓝图编辑器出真图)\nbp list [关键词]   列出可用蓝图 (关键词按名字 / 用到的实体筛)\nbp show 编号       要哪些物品、多大、实测产量\nbp view 编号或文件  用蓝图编辑器出图看 (文件: .txt 蓝图字符串 / .json {entities:[{name,position:{x,y},direction,recipe}]})\nbp check 文件      静态检查自己的蓝图 (重叠、供电、带子、机械臂目标)\nbp file 编号       写出蓝图字符串文件 (blueprints/编号.txt)\nbp build 编号或文件 --at x,y [--dir 方向] [--margin 外圈格数, 默认 5] [--keep-trees]   整块建: 蓝图中心放在 x,y, 先清范围内的树和石头"); return 0; }
  if (cmd === "list") { console.log(listLines(arg).join("\n")); return 0; }
  if (cmd === "view") return (await import("./bp-study.ts")).viewCmd(argv.slice(1), (n) => { const x = all.find((y) => y.no === n); return x ? { bp: x.get() as Record<string, any>, label: x.label } : null; });
  const own = cmd === "build" && arg && !/^\d+$/.test(arg) ? await ownEntry(arg) : null;
  if (typeof own === "string") { console.log(`error: 读不了 ${arg}: ${own}`); return 1; }
  const e = own ?? all.find((x) => x.no === Number(arg));
  if (!e) { console.log(`error: 没有编号 ${arg} (bp list 看编号)`); return 1; }
  // 建自己设计的蓝图前自动查错, 不等模型想起来 ./bp check; 错的不动手, --force 才硬建
  if (own && (await (await import("./bp-study.ts")).checkCmd([arg])) !== 0 && !argv.includes("--force")) { console.log(`上面有错, 没动手: 修好再建, 或看图 ./bp view ${arg}; 确定要建加 --force`); return 1; }
  if (cmd === "show") {
    logBlueprint("show", e);
    console.log(`${e.no}. [${e.source}] ${e.label}\n大小 ${e.w}x${e.h}, ${e.entities} 个实体${e.io ? "\n" + e.io : ""}\n要的物品: ${Object.entries(e.counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}*${v}`).join(" ")}`);
    return 0;
  }
  if (cmd === "file") {
    logBlueprint("file", e);
    // 不能叫 bp: 大脑目录里有同名的 ./bp 启动脚本, mkdir 报 EEXIST (2026-11-05 Gpt 报的工具诉求)
    const dir = path.resolve("blueprints");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${e.no}.txt`);
    fs.writeFileSync(f, encodeBlueprint({ blueprint: e.get() }));
    console.log(`写好了: blueprints/${e.no}.txt (${fs.statSync(f).size} 字节)。想直接整块建: ./bp build ${e.no} --at x,y (蓝图中心放在 x,y; 要背包里有这些物品: ./bp show ${e.no})`);
    return 0;
  }
  if (cmd === "build") { logBlueprint("build", e); return build(e, argv.slice(2), arg); }
  console.log(`error: 不认识的命令 ${cmd}`);
  return 1;
}

/**
 * bp build 编号 --at x,y [--dir north|east|south|west] [--keep-trees] [--margin 2]: 整块建 ("开局引擎 (确定性步骤) 优先,
 * 大脑只处理被阻塞的步骤"; 第五、六轮大脑一格一格手搭, ./bp 只用了 2 次)。建什么、放哪由大脑定, 工具负责建完:
 * 查材料够不够 → 导入 → 贴到位置 → 整片清场 → 角色亲手建 (够得着就建, 砍树挖石) → 回报剩多少虚影、缺什么。
 * 每一步都是 harness 的玩家规则动作 (够得着、只用背包里的、花游戏时间), 只是串好了不用大脑一步步想。
 */
/** 大脑看过 / 用过的蓝图记进这一班的 blueprints.jsonl; 没有会话文件 (命令行直接用) 就不记 */
function logBlueprint(cmd: string, e: Entry) {
  try {
    const sf = process.env.FP_SESSION ?? path.join(labRoot(), "play", "session.json");
    const s = JSON.parse(fs.readFileSync(sf, "utf8")) as { logDir?: string; agent?: string };
    if (!s.logDir) return;
    const row = { at: new Date().toISOString(), agent: s.agent ?? "a", cmd, no: e.no, label: e.label, source: e.source, w: e.w, h: e.h, bp: encodeBlueprint({ blueprint: e.get() }) };
    fs.appendFileSync(path.join(s.logDir, "blueprints.jsonl"), JSON.stringify(row) + "\n");
  } catch { /* 没有会话或写不上: 不影响命令 */ }
}

/** 全队的事实: 谁用块放了什么 (派对的模型会互相学, 效果要真班看); 单角色的班没有 ../team.md 就不写 */
function teamEvent(who: string, text: string) {
  try { if (fs.existsSync(path.join("..", "team.md"))) fs.appendFileSync(path.join("..", "team-events.jsonl"), JSON.stringify({ at: Date.now(), who, text }) + "\n"); } catch { /* 附带的 */ }
}

/** 下一块往哪贴: 紧挨着留 1 格走人, 先横向再纵向 */
export const nextBlockOffsets = (w: number, h: number): [number, number][] => [[Math.ceil(w) + 1, 0], [0, Math.ceil(h) + 1], [-Math.ceil(w) - 1, 0], [0, -Math.ceil(h) - 1]];

/** ./bp build 和 ./plan --build 共用; spec = 回复里给模型的"编号或文件" */
export async function build(e: Entry, rest: string[], spec = String(e.no), out?: { missing?: Record<string, number> }): Promise<number> {
  if (process.env.FH_ONLINE) return (await import("./bp-online.ts")).buildOnline(e, rest, spec);
  const opt = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const at = (opt("--at") ?? "").split(",").map(Number);
  if (at.length !== 2 || at.some((v) => !Number.isFinite(v))) { console.log("error: 要 --at x,y (蓝图中心放在哪)"); return 1; }
  // 清场外圈默认 5 格 (原来 2 格)
  const dir = opt("--dir"), margin = Number(opt("--margin") ?? 5), clear = !rest.includes("--keep-trees");
  const { RconClient } = await import("../lab/rcon.ts");
  const { Harness } = await import("./harness.ts");
  const { formatCompact } = await import("./format.ts");
  const sf = process.env.FP_SESSION ?? path.join(labRoot(), "play", "session.json");
  if (!fs.existsSync(sf)) { console.log(`error: 没有正在运行的沙盘会话 (${sf})`); return 1; }
  const s = JSON.parse(fs.readFileSync(sf, "utf8"));
  const rcon = new RconClient({ port: s.rconPort, password: s.password });
  await rcon.connect();
  const h = new Harness(rcon, s.bot ?? s.player, (x) => fs.appendFileSync(path.join(s.logDir, "requests.jsonl"), JSON.stringify(s.agent ? { ...x, agent: s.agent, via: "bp build" } : { ...x, via: "bp build" }) + "\n"));
  const say = (t: string) => console.log(t);
  // 只读的查背包不占大脑的提醒; 真动手的回复里带着队友消息和提醒, 要打印出来, 不然这些消息就被 ./bp 吃了 (2026-11-05: 模组只给一次)
  const news: string[] = [];
  // 一条 ./bp build 要问游戏好几次, 同一条教训每次回复都带: 只打印一次 (按教训编号去重)
  const seenNews = new Set<string>();
  const note = (r: { result?: Record<string, unknown> }) => {
    for (const k of ["team", "operator", "lessons", "alerts"]) {
      const v = r.result?.[k];
      if (!v) continue;
      const rows = k === "lessons" && Array.isArray(v) ? v.filter((l) => { const id = /lesson #\d+/.exec(String(l))?.[0] ?? String(l); if (seenNews.has(id)) return false; seenNews.add(id); return true; }) : v;
      if (Array.isArray(rows) && !rows.length) continue;
      const t = `${k}: ${JSON.stringify(rows).slice(0, 900)}`;
      if (!news.includes(t)) news.push(t);
    }
    return r;
  };
  const turned = dir === "east" || dir === "west";
  const rot = dir ? { direction: dir } : {};
  const footW = turned ? e.h : e.w, footH = turned ? e.w : e.h;
  const execJson = async (lua: string): Promise<any> => JSON.parse(await rcon.exec(`/silent-command local function main() ${lua.replace(/\r?\n\s*/g, " ")} end rcon.print(helpers.table_to_json(main()))`, { timeoutMs: 30_000 }));
  const blueprintText = encodeBlueprint({ blueprint: e.get() });
  const { blockedText, blockPorts, blockInputs, findSpot, realBlockers, sourceLua, verifyLua, verifyText, wireLines } = await import("./bp-fit.ts");
  const { siteLua } = await import("./plan-lib.ts");
  // 问游戏这里放不放得下 (模组 paste dry_run, 40~60 毫秒, 什么都不放): 贴蓝图全有或全无, 一件挡着就一个也贴不上; 备料、清场之前就要知道 (2026-11-06 核实, src/play/bp-fit.ts)
  const dryAt = async (x: number, y: number): Promise<Dry | null> => { const r = await h.call("paste", { position: { x, y }, ...rot, dry_run: true }); note(r); return r.ok ? (r.result as Dry) : null; };
  const nextSpot = () => findSpot([at[0], at[1]], footW, footH, (near, w, h2, taken) => execJson(siteLua(near, w, h2, taken, 1)), async (x, y) => { const d = await dryAt(x, y); return d ? realBlockers(d.blocked) : ["查不了"]; });
  const restArgs = rest.filter((a, i) => a !== "--at" && rest[i - 1] !== "--at").join(" ");
  try {
    const imp0 = await h.call("blueprint_import", { blueprint: blueprintText });
    note(imp0);
    if (!imp0.ok) { say(`error: 导入失败: ${imp0.error?.message}`); return 1; }
    const firstDry = await dryAt(at[0], at[1]);
    const firstStop = realBlockers(firstDry?.blocked);
    if (firstStop.length) { say(blockedText(spec, at, firstStop, await nextSpot(), restArgs ? ` ${restArgs}` : "")); return 1; }
    // 1. 材料: 蓝图要的 vs 背包里有的 (缺了先说, 不动手; 大脑去手搓 / 从超市拿)
    const reader = new Harness(rcon, s.bot ?? s.player, undefined, { reader: "bp" });
    const heldNow = async () => {
      const inv = await reader.call("inventory", {});
      const held: Record<string, number> = {};
      for (const m of String(inv.result?.inventory ?? "").matchAll(/([\w-]+)\*(\d+)/g)) held[m[1]] = (held[m[1]] ?? 0) + Number(m[2]);
      return held;
    };
    // 缺的先自己备 (从箱子和机器出口拿, 再手搓; src/play/bp-gather.ts); --no-gather 不备, 缺就报
    let missing = lacking(e.counts, await heldNow());
    if (Object.keys(missing).length && !rest.includes("--no-gather")) {
      const { loadGameData } = await import("../calc/data.ts");
      const hand = handRecipeOf(loadGameData());
      const g = await gather(e.counts, {
        held: heldNow,
        collect: async (item, count) => { note(await h.call("collect", { radius: 128, item, count, chests: true }, { wait: true, timeoutMs: 120_000 })); },
        craft: async (recipe, count) => { const c = await h.call("craft", { recipe, count }); note(c); return { ok: !!c.ok && !c.result?.nothing_queued, why: c.error?.message ?? (c.result?.nothing_queued ? JSON.stringify(c.result.nothing_queued) : undefined) }; },
        // 只等一小会: 大块要搓几分钟, 一直等模型就干瞪眼 (2026-11-05 Gpt 一条命令 336 秒没动静); 没搓完角色接着搓
        recipe: hand, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), craftWaitMs: 20_000,
        // 模组没有只读的手搓队列: 按 status 的位置找到这个角色的身体, 读 crafting_queue_size (只读)
        queued: async () => {
          const pos = (await reader.call("status", {})).result?.position as { x?: number; y?: number } | undefined;
          if (typeof pos?.x !== "number" || typeof pos?.y !== "number") return 0;
          return Number(await rcon.exec(`/silent-command local c = game.surfaces[1].find_entities_filtered{type = "character", position = {${pos.x}, ${pos.y}}, radius = 1}[1] rcon.print(c and c.crafting_queue_size or 0)`).catch(() => "0")) || 0;
        },
      });
      for (const t of g.notes) say(`备料: ${t}`);
      missing = g.still;
      if (g.crafting) { say(`还差 ${Object.entries(missing).map(([k, v]) => `${k}*${v}`).join(" ")}; 手搓队列还没空。这条命令先结束, 没有放任何东西。`); return 2; }
    }
    if (Object.keys(missing).length) { say(`error: 材料不够 (蓝图 ${e.no} 要 ${Object.entries(e.counts).map(([k, v]) => `${k}*${v}`).join(" ")}): 拿和搓之后还缺 ${Object.entries(missing).map(([k, v]) => `${k}*${v}`).join(" ")}`);
      if (out) out.missing = missing; // ./plan --build 接着按低一档重算, 它自己说下一步
      else {
        const { blocksWithout } = await import("./plan-lib.ts");
        const alt = blocksWithout(e.label, missing, entries());
        if (alt.length) say(`同样的产物不用 ${alt[0].item} 的块: ${alt.map((a) => `./bp build ${a.block.no} --at ${at[0]},${at[1]} (${a.size} 台 ${a.block.w}x${a.block.h})`).join("、")}; 放不下会回能放下的坐标`);
      }
      return 1;
    }
    // 2. 导入 + 贴: 放虚影 (引擎按玩家放蓝图的规矩, 会把虚影下面的树石标成拆除)
    // 2. 整片清场在先 (第一次实测: 先贴后清, 贴的那一刻有树挡着, 114 个一个都没放): 范围 = 蓝图占地 (横放时宽高对调) 外加 margin 格,
    //    里面的树和石头标拆除、亲手砍掉 (悬崖不在内, 要炸药)
    const hw = footW / 2 + margin, hh = footH / 2 + margin;
    const box = { left_top: { x: at[0] - hw, y: at[1] - hh }, right_bottom: { x: at[0] + hw, y: at[1] + hh } };
    let cleared = 0, mined = 0;
    if (clear) {
      const d = await h.call("deconstruct", { area: box, entity_types: ["tree", "simple-entity"] });
      note(d);
      cleared = d.ok ? Number(d.result?.changed ?? 0) : 0;
      if (cleared > 0) {
        const m = await h.call("construct", { area: box }, { wait: true, timeoutMs: 15 * 60_000 });
        note(m);
        mined = Number((m.result?.completion ?? m.result ?? {}).mined ?? 0);
        if (!m.ok) { say(`error: 清场没清完: ${m.error?.message}`); return 1; }
      }
    }
    // 3. 导入 + 贴虚影
    const imp = await h.call("blueprint_import", { blueprint: blueprintText });
    note(imp);
    if (!imp.ok) { say(`error: 导入失败: ${imp.error?.message}`); return 1; }
    const paste = await h.call("paste", { position: { x: at[0], y: at[1] }, ...rot });
    note(paste);
    if (!paste.ok) { say(`error: 贴不下: ${paste.error?.message}`); return 1; }
    const placed = Number(paste.result?.count ?? 0), expected = Number(paste.result?.expected ?? e.entities);
    const already = Number(paste.result?.existing_entities ?? 0) + Number(paste.result?.existing_ghosts ?? 0);
    if (placed === 0 && !already) {
      // 开头查过还贴不上 = 这段时间有东西放进来了 (备料、清场要时间, 队友在动)。模组 not_placed 的坐标不准 (locate 拿场上同名实体投票定位, 2026-11-05: 贴在 y=-24.5, 报 y=-36.5, Gpt 以为蓝图贴偏了), 只认 dry_run
      const d = await dryAt(at[0], at[1]);
      say(blockedText(spec, at, realBlockers(d?.blocked).length ? realBlockers(d?.blocked) : (d?.blocked ?? [`没有说原因: ${d?.summary ?? "dry_run 没回"}`]), await nextSpot(), restArgs ? ` ${restArgs}` : ""));
      return 1;
    }
    // 4. 建: 角色亲手按虚影建 (够不着就走过去)
    const c = await h.call("construct", { area: box }, { wait: true, timeoutMs: 15 * 60_000 });
    note(c);
    const done = c.result?.completion ?? c.result ?? {};
    say(`蓝图 ${e.no} (${e.label}) 贴在 (${at.join(",")})${dir ? " 朝 " + dir : ""}; 范围 (${box.left_top.x},${box.left_top.y})~(${box.right_bottom.x},${box.right_bottom.y})`);
    say(`清场: 标了 ${cleared} 个树 / 石头, 砍 / 挖了 ${mined}; 贴上虚影 ${placed}/${expected}${placed < expected ? ` (没贴上的: ${JSON.stringify(paste.result?.not_placed ?? []).slice(0, 300)})` : ""}; 建造: ${c.ok ? `${done.outcome ?? "?"}, 建了 ${done.built ?? "?"}, 剩 ${done.remaining ?? "?"} 个虚影` : `失败: ${c.error?.message}`}`);
    if (!c.ok || (done.remaining ?? 0) > 0) { say(formatCompact(c).slice(0, 800)); say("没建完: 看上面缺什么 / 挡着什么, 补上后 construct 同一个 area 再建 (./fh call construct, 旧配置 ./fp construct)"); return 1; }
    say("建好了。");
    // 加产能 = 再贴一块: 把下一块的位置查好递上 (不靠模型去读这条经验)
    try {
      for (const [dx, dy] of nextBlockOffsets(footW, footH)) {
        const nx = at[0] + dx, ny = at[1] + dy;
        const d = await dryAt(nx, ny);
        if (d && !realBlockers(d.blocked).length) { say(`再贴一块放得下 (查过): ./bp build ${spec} --at ${nx},${ny}${dir ? ` --dir ${dir}` : ""}`); break; }
      }
    } catch { /* 附带的, 不影响已经建好 */ }
    // 建后比对 + 接线的下一条命令: 都是附带的, 出错不影响已经建好; 但坏了要留痕 (npm run play:seen 会数)
    try {
      const bp = e.get() as { entities: BpEntity[] };
      const b = paste.result?.bounds as { left: number; top: number; right: number; bottom: number } | undefined;
      const area = b ? { left_top: { x: b.left, y: b.top }, right_bottom: { x: b.right, y: b.bottom } } : { left_top: { x: at[0] - footW / 2, y: at[1] - footH / 2 }, right_bottom: { x: at[0] + footW / 2, y: at[1] + footH / 2 } };
      const v = await execJson(verifyLua(area, Object.keys(e.counts))) as Verify;
      say(verifyText(v, e.counts));
      if (e.io) say(`这块 ${e.io}`);
      const origin = firstDry?.paste?.origin_at;
      if (origin) {
        const ports = blockPorts(bp.entities, origin, dir);
        const portText = (a: { x: number; y: number; dir: string }[]) => a.map((p) => `(${p.x},${p.y}) 往${p.dir}`).join("、") || "没有带子口";
        say(`入口 ${portText(ports.inputs)}; 出口 ${portText(ports.outputs)}。`);
        const { loadGameData } = await import("../calc/data.ts");
        const gd = loadGameData();
        const eat = blockInputs(bp.entities, (r) => gd.recipes.get(r)?.ingredients.map((g) => ({ name: g.name, fluid: g.type === "fluid" })) ?? []);
        if (eat.length > ports.inputs.length && ports.inputs.length) say(`吃 ${eat.length} 种料、入口 ${ports.inputs.length} 条带: 两种料可以各走一道 (belt_route 的 lane: left | right)。`);
        const found = eat.length && ports.inputs[0] ? await execJson(sourceLua(eat, ports.inputs[0])) as Record<string, At> : {};
        // 下一条命令先问游戏走不走得通 (dry_run), 能走才写成命令
        const checks: WireCheck[] = [];
        for (const [i, item] of eat.slice(0, 2).entries()) {
          const p = ports.inputs[Math.min(i, ports.inputs.length - 1)];
          if (!p) continue;
          const to = { x: p.x, y: p.y }, from = found[item];
          if (!from) { checks.push({ item, at: null }); continue; }
          const r = await h.call("belt_route", { from, to, item, dry_run: true });
          note(r);
          checks.push({ item, at: from, to, ok: !!r.ok, tiles: Number(r.result?.tiles ?? 0) || undefined, why: r.error?.message });
        }
        let pole: Parameters<typeof wireLines>[1];
        if (v.powered < v.needPower && v.pole && v.inner) {
          const r = await h.call("pole_route", { from: v.pole, to: v.inner, dry_run: true });
          note(r);
          pole = { from: v.pole, to: v.inner, ok: !!r.ok, why: r.error?.message, count: Number(r.result?.poles ?? 0) || undefined };
        }
        const cmds = wireLines(checks, pole);
        if (cmds.length) say(`下一步 (用不用你定):\n${cmds.join("\n")}`);
      }
      // 第一次放这块才画 (占上下文); 真图给人: 界面右栏"蓝图"卡读 blueprints.jsonl
      if (!fs.existsSync(`.bp-pic-${spec.replace(/\W/g, "_")}`)) {
        const pic = (await import("./bp-study.ts")).blockPicture(bp as Record<string, any>, origin ?? null);
        if (pic) say(pic);
        try { if (fs.existsSync("fh")) fs.writeFileSync(`.bp-pic-${spec.replace(/\W/g, "_")}`, ""); } catch { /* 下次多画一次 */ } // 只在角色目录记 (play:check 在仓库里跑, 不留文件)
      }
      say("都接上后 ./fh call belt_gaps 查断口、./fh call bottleneck 看缺料; 跑通了 blueprint_save 存成队伍蓝图, 以后整块复制。");
      const made = (bp.entities.find((x) => x.recipe)?.recipe) ?? "";
      teamEvent(String(s.bot ?? s.name ?? "队友"), `${s.bot ?? s.name ?? "队友"} 用 ./bp build ${spec} 一条命令放了 ${machineCount(e.counts)} 台${made ? ` ${made}` : ""} (${e.w}x${e.h})`);
    } catch (err) {
      try { fs.appendFileSync(".fh-hints.err", `${new Date().toISOString()} bp build 比对: ${(err as Error).message}\n`); } catch { /* 写不上算了 */ }
    }
    return 0;
  } finally {
    for (const n of news) console.log(n);
    rcon.close();
  }
}

// 直接运行才跑命令行 (run.ts import 它的 listLines 给要点提示; 仓库 CLAUDE.md 工具坑: src/ 下的脚本 import 会直接运行)
if ((import.meta as { main?: boolean }).main) process.exitCode = await main(argvFromFile(process.argv.slice(2))); // Grok 的 .ps1 包装把参数写成文件 (src/play/argv-file.ts)
