#!/usr/bin/env node
// 蓝图命令行 (别人的蓝图原文放本机 lab-data/blueprints/, 不进仓库):
//   npm run bp -- inspect <文件>                 解码、列建筑 (官方中文名)、按已核实的规则检查
//   npm run bp -- check <文件>                   静态检查: 重叠、供电、传送带、地下带/地下管道、流体口、机械臂目标、车站、铁轨网格
//   npm run bp -- try <文件> [--index N] [--seconds 60]   放进沙盘 (开窗口), 跑一会儿, 报每台建筑的状态
//   npm run bp -- render <文件> [--index N] [--area x1,y1,x2,y2] [--out 图片] [--max 800] [--kb 300] [--check] [--plain] [--nogrid]
//                                                 用本机蓝图编辑器出图 (坐标网格; --check 把静态检查的错和警告画圈标号; --area 只看一块)
//   npm run bp -- feed <文件> [--index N|all] [--warm 60] [--seconds 60] [--research late]   喂料实测 (自动上料收料), 出排名表和 JSON; --research late = 全部科技研究完再测
//   npm run bp -- link <文件> [--index N] [--area x1,y1,x2,y2]   本机编辑器的预览链接 (长蓝图写进编辑器目录, 链接短)
import fs from "node:fs";
import { parseArgs } from "node:util";
import { decodeBlueprint, encodeBlueprint } from "../lab/blueprint.ts";
import { LabInstance, findFactorioDir, builtinMods, labRoot } from "../lab/instance.ts";
import { zhNamesFrom } from "../lab/names.ts";
import { flatten, analyze, report } from "./inspect.ts";
import { loadRules } from "./rules.ts";
import { checkBlueprint, summarize } from "./check.ts";
import { loadRailGeometry } from "./rail-geometry.ts";
import path from "node:path";
import { placeBlueprint, feedArea, describeFeed } from "../dataset/feed.ts";
import { BlueprintRenderer, cropBlueprint, previewLink, referenceOf, writeRender, type RenderMark } from "./render.ts";

type Item = { name: string; x: number; y: number; dir?: number; status?: string; network?: boolean };
/** 模组 audit 的清单: n = 总数, items = 前 cap 条 (Lua 空表过来是 {} 不是 []) */
type L = { n: number; items: Item[] | Record<string, never> };

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    index: { type: "string", default: "1" }, seconds: { type: "string", default: "60" }, warm: { type: "string", default: "60" },
    out: { type: "string" }, area: { type: "string" }, max: { type: "string", default: "800" }, kb: { type: "string", default: "300" },
    check: { type: "boolean", default: false }, plain: { type: "boolean", default: false }, nogrid: { type: "boolean", default: false },
    research: { type: "string", default: "none" },
  },
});
const [cmd, file] = positionals;
if (!cmd || !file) {
  console.log("用法: bp inspect <文件> | bp check <文件> | bp try <文件> [--index N] [--seconds 60] | bp render <文件> [--index N] [--out 图片] [--check]");
  process.exit(2);
}
const text = fs.readFileSync(file, "utf8").trim();
const items = flatten(decodeBlueprint(text));
const protoDir = path.join(labRoot(), "prototypes", builtinMods(findFactorioDir()).map((m) => `${m.name}-${m.version}`).join("_"));
const zh = zhNamesFrom(protoDir);

if (cmd === "inspect") {
  console.log(`共 ${items.length} 张蓝图`);
  console.log(report(items.map((b) => analyze(b.label, b.path, b.bp)), zh));
} else if (cmd === "check") {
  const rules = loadRules();
  const geom = loadRailGeometry();
  for (const b of items) {
    const info = analyze(b.label, b.path, b.bp);
    const findings = checkBlueprint(info.entities, b.bp.wires, rules, zh, geom);
    console.log(`== ${b.path.trim()}: "${b.label}" (${info.entities.length} 件) → ${summarize(findings)}  [规则来自 ${rules.version}]`);
    for (const f of findings) console.log(`  ${f.level === "error" ? "❌" : f.level === "warn" ? "⚠️" : "ℹ️"} ${f.msg}`);
    if (findings.some((f) => f.level === "error")) process.exitCode = 1;
  }
} else if (cmd === "render") {
  const whole = items[Number(values.index) - 1];
  if (!whole) throw new Error(`没有第 ${values.index} 张 (共 ${items.length} 张)`);
  const area = values.area?.split(",").map(Number);
  if (area && (area.length !== 4 || area.some((v) => !Number.isFinite(v)))) throw new Error("--area 要 4 个数: x1,y1,x2,y2");
  const pick = area ? { ...whole, bp: cropBlueprint(whole.bp, area as [number, number, number, number]) } : whole;
  const info = analyze(pick.label, pick.path, pick.bp);
  if (info.entities.length === 0) throw new Error("这块里没有实体");
  const marks: RenderMark[] = [];
  if (values.check) {
    // 对整张查 (裁出来的边上会有被切断的假错), 再只标框里的
    const all = analyze(whole.label, whole.path, whole.bp);
    const [ax1, ay1, ax2, ay2] = area ? [Math.min(area[0], area[2]), Math.min(area[1], area[3]), Math.max(area[0], area[2]), Math.max(area[1], area[3])] : [-Infinity, -Infinity, Infinity, Infinity];
    const findings = checkBlueprint(all.entities, whole.bp.wires, loadRules(), zh, loadRailGeometry())
      .filter((f) => f.level !== "info" && f.at && f.at.x >= ax1 && f.at.x <= ax2 && f.at.y >= ay1 && f.at.y <= ay2);
    findings.forEach((f, i) => {
      marks.push({ x: f.at!.x, y: f.at!.y, label: String(i + 1), level: f.level });
      console.log(`  ${i + 1}. ${f.level === "error" ? "❌" : "⚠️"} (${f.at!.x}, ${f.at!.y}) ${f.msg}`);
    });
  }
  const r = new BlueprintRenderer();
  try {
    const res = await r.render(encodeBlueprint({ blueprint: pick.bp }), {
      maxSide: Number(values.max), maxBytes: Number(values.kb) * 1000, alt: !values.plain, grid: !values.nogrid, marks, reference: referenceOf(pick.bp),
    });
    const base = values.out ?? path.join(labRoot(), "renders", `${path.basename(file).replace(/\.[^.]+$/, "")}-${values.index}${area ? `-${area.join("_")}` : ""}`);
    const out = writeRender(base, res);
    console.log(`"${pick.label}" (${info.entities.length} 件) → ${out}`);
    console.log(`  ${res.width}×${res.height}, ${(res.data.length / 1000).toFixed(0)}KB${res.quality ? ` (jpeg ${res.quality})` : ""}, 每格 ${res.pxPerTile.toFixed(2)} 像素, 左上角 = 蓝图坐标 (${res.origin.x}, ${res.origin.y}), 网格每 ${res.gridStep} 格, ${(res.ms / 1000).toFixed(1)} 秒`);
  } finally {
    await r.close();
  }
} else if (cmd === "link") {
  const whole = items[Number(values.index) - 1];
  if (!whole) throw new Error(`没有第 ${values.index} 张 (共 ${items.length} 张)`);
  const area = values.area?.split(",").map(Number) as [number, number, number, number] | undefined;
  const bp = area ? cropBlueprint(whole.bp, area) : whole.bp;
  console.log(previewLink(encodeBlueprint({ blueprint: bp })));
} else if (cmd === "feed") {
  // 喂料实测 (数据集第三层同一套: 自动上料、收料, 预热后测) 一本书里的每张 (或 --index 那张), 结果表 + JSON (搜索 / 排名用)
  const pick = values.index === "all" ? items : [items[Number(values.index) - 1]];
  if (!pick[0]) throw new Error(`没有第 ${values.index} 张`);
  const lab = new LabInstance({ name: "bp-feed", view: false });
  await lab.createMap("f", { seed: 1 });
  await lab.start("f");
  const rows: Record<string, unknown>[] = [];
  try {
    for (const b of pick) {
      const info = analyze(b.label, b.path, b.bp);
      const { area } = await placeBlueprint(lab, b.bp, b.label);
      const f = await feedArea(lab, area, b.bp, { warmS: Number(values.warm), measureS: Number(values.seconds), research: values.research, log: process.env.FEED_DEBUG ? (x) => console.log("  " + x.slice(0, 800)) : undefined });
      const out = f.final.reduce((n, k) => n + (f.perMin[k] ?? 0), 0);
      const tiles = info.size.w * info.size.h;
      rows.push({ label: b.label, entities: info.entities.length, w: info.size.w, h: info.size.h, outPerMin: out, perTile: Number((out / tiles).toFixed(3)), efficiency: f.efficiency, trend: f.trend, working: f.status.working ?? 0, powerMW: f.powerMW, powerFixed: f.powerFixed, fed: f.fedPerMin, error: f.error, skipped: f.skipped });
      console.log(`${b.label}: ${describeFeed(f)}`);
    }
  } finally {
    await lab.stop({ save: false });
  }
  const json = (values.out ?? file.replace(/\.[^.]+$/, "")) + ".feed.json";
  fs.writeFileSync(json, JSON.stringify(rows, null, 1));
  console.log(`
| 蓝图 | 每分钟产出 | 每格每分钟 | 效率 | 开工率 | 耗电 MW | 补电 |
|---|---|---|---|---|---|---|`);
  for (const r of [...rows].sort((a, b) => (b.outPerMin as number) - (a.outPerMin as number))) console.log(`| ${r.label} | ${(r.outPerMin as number).toFixed(1)} | ${r.perTile} | ${r.efficiency} | ${r.working} | ${r.powerMW} | ${r.powerFixed} |`);
  console.log(`结果 → ${json}`);
} else if (cmd === "try") {
  const pick = items[Number(values.index) - 1];
  if (!pick) throw new Error(`没有第 ${values.index} 张 (共 ${items.length} 张)`);
  const info = analyze(pick.label, pick.path, pick.bp);
  console.log(report([info], zh));
  // 第二道关: 静态检查
  const rules = loadRules();
  const findings = checkBlueprint(info.entities, pick.bp.wires, rules, zh, loadRailGeometry());
  console.log(`静态检查: ${summarize(findings)}`);
  for (const f of findings.filter((f) => f.level !== "info")) console.log(`  ${f.level === "error" ? "❌" : "⚠️"} ${f.msg}`);
  const count = (...kinds: string[]) => findings.filter((f) => kinds.includes(f.kind) && !f.msg.startsWith("…")).length + findings.filter((f) => kinds.includes(f.kind) && f.msg.startsWith("…")).reduce((n, f) => n + Number(/\d+/.exec(f.msg)?.[0] ?? 0), 0);
  const num = (kind: string) => Number(/(\d+)/.exec(findings.find((f) => f.kind === kind)?.msg ?? "")?.[1] ?? 0);
  // 第三道关: 放进沙盘, 读引擎
  const lab = new LabInstance({ name: "bp-try", label: `试放蓝图: ${pick.label}` });
  try {
    await lab.createMap("bp", { seed: 1 });
    await lab.start("bp");
    // 蓝图原点落在 (0,0), 实体坐标原样; 但游戏第一次拍下是按外框中心对位的 (整体平移 -中心), 模组靠幽灵反推偏移再重拍,
    // 所以场地要同时盖住两种落点 (朋友基地中心 (56,191): 只铺未平移的范围时, 边上的件落在场地外, 反推失败, 2026-11-01)
    const xs = info.entities.map((e) => e.position.x), ys = info.entities.map((e) => e.position.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const area = [[Math.floor(Math.min(minX, minX - cx)) - 12, Math.floor(Math.min(minY, minY - cy)) - 12], [Math.ceil(Math.max(maxX, maxX - cx)) + 12, Math.ceil(Math.max(maxY, maxY - cy)) + 12]];
    await lab.rpc("prepare_area", { area, no_enemies: true }, { timeoutMs: 600_000 });
    const first = pick.bp.entities?.[0] as { entity_number: number; position: { x: number; y: number } } | undefined;
    const placed = (await lab.rpc("place_blueprint", {
      string: encodeBlueprint({ blueprint: pick.bp }), position: [0, 0],
      reference: first ? { index: 1, name: (first as { name?: string }).name, x: first.position.x, y: first.position.y } : undefined,
    }, { timeoutMs: 600_000 })) as {
      built: number; ghosts: number; failed_count: number; failed: { name: string }[]; offset?: { x: number; y: number }; shift?: { x: number; y: number }; shift_error?: string; align_error?: string;
    };
    if (placed.shift_error) console.log(`坐标平移没算出来: ${placed.shift_error}`);
    if (placed.align_error) throw new Error(`蓝图没对齐: ${placed.align_error}`);
    const failed = placed.failed_count ? ` 没建成: ${[...new Set(placed.failed.map((f) => zh(f.name)))].join("、")}` : "";
    // 引擎里的坐标 = 我们解码的坐标 + shift (游戏导入时重新归零) + offset (落点)
    const off = { x: (placed.shift?.x ?? 0) + (placed.offset?.x ?? 0), y: (placed.shift?.y ?? 0) + (placed.offset?.y ?? 0) };
    const toWorld = (x: number, y: number): [number, number] => [x + off.x, y + off.y];
    console.log(`放进沙盘: 建成 ${placed.built}/${placed.ghosts}${failed}; 引擎坐标 = 蓝图坐标 + (${off.x},${off.y})`);
    // 沙盘没燃料: 给每张电网接一个电力接口, 剩下没电的才是覆盖 / 连线问题
    const pw = (await lab.rpc("power_networks", { area }, { timeoutMs: 600_000 })) as { networks: number; placed: number };
    console.log(`供电: ${pw.networks} 张电网各接了电力接口`);
    await lab.say(`蓝图"${pick.label}"建成 ${placed.built}/${placed.ghosts} 件。沙盘里没有原料和电源, 这一步只看布局; 报告见终端。`);
    await lab.rpc("time", { paused: false, speed: 1 });
    await new Promise((r) => setTimeout(r, Number(values.seconds) * 1000));
    const insp = (await lab.rpc("inspect", { area }, { timeoutMs: 600_000 })) as { status: Record<string, number> };
    console.log("建筑状态: " + Object.entries(insp.status).map(([s, k]) => `${s}×${k}`).join("、"));
    // 静态检查点名的流体机器, 让引擎把它的有效接口列出来 (蓝图原点放在 0,0, 坐标一致)
    const boxes = findings.filter((f) => f.kind.startsWith("fluid-") && f.at).map((f) => toWorld(f.at!.x, f.at!.y));
    for (const m of findings.filter((f) => f.kind === "fluid-mixed").flatMap((f) => [...f.msg.matchAll(/(-?[\d.]+),(-?[\d.]+)\)/g)])) boxes.push(toWorld(Number(m[1]), Number(m[2])));
    const audit = (await lab.rpc("audit", { area, boxes, cap: 400, shapes: true }, { timeoutMs: 600_000 })) as {
      belts: { total: number; dead_end: L; no_input: L; shape: Record<string, number>; ug_orphan: L; curves: [number, number][] | Record<string, never>; dead_end_all: [number, number][] | Record<string, never> };
      fluids: { entities: number; connections: number; linked: number; open: L; isolated: L; boxes: { n: number; items: { name: string; x: number; y: number; recipe?: string; conns: { box: number; flow: string; x: number; y: number; linked: boolean }[] }[] | Record<string, never> } };
      rails: { total: number; dead_end: L; ends_connected: number; ends_total: number };
      signals: { total: number; unconnected: L };
      stops: { total: number; unconnected: L };
      unpowered: L;
    };
    const n = (l: L) => l.n;
    const items = <T>(l: { items: T[] | Record<string, never> }): T[] => (Array.isArray(l.items) ? l.items : []);
    const show = (l: L, k = 5) => items(l).slice(0, k).map((i) => `${zh(i.name)}(${i.x - off.x},${i.y - off.y})${i.status ? " " + i.status : ""}`).join(" ");
    console.log("\n== 引擎核对 (第三道关)");
    const noNetwork = items(audit.unpowered).filter((u) => u.network === false);
    console.log(`没电: ${n(audit.unpowered)} (其中不在任何电网里 ${noNetwork.length}; 沙盘刚建好时炮塔充能、机器人平台充电会短暂 low_power)  ${show({ n: noNetwork.length, items: noNetwork }, 8)}`);
    console.log(`传送带 ${audit.belts.total}: 没有下游 ${n(audit.belts.dead_end)}, 没有上游 ${n(audit.belts.no_input)}, 地下带没配对 ${n(audit.belts.ug_orphan)} ${show(audit.belts.ug_orphan)}; 形状 ${JSON.stringify(audit.belts.shape)}`);
    console.log(`流体机器 ${audit.fluids.entities}: 接口 ${audit.fluids.connections}, 接上 ${audit.fluids.linked}, 空着 ${n(audit.fluids.open)}, 一个口都没接的 ${n(audit.fluids.isolated)} ${show(audit.fluids.isolated)}`);
    for (const b of items(audit.fluids.boxes)) console.log(`  ${zh(b.name)} 蓝图坐标 (${b.x - off.x},${b.y - off.y}) 配方 ${b.recipe ?? "-"}: ${b.conns.map((c) => `箱${c.box} ${c.flow} (${c.x - off.x},${c.y - off.y}) ${c.linked ? "接上" : "空"}`).join("; ")}`);
    console.log(`铁轨 ${audit.rails.total}: 端点 ${audit.rails.ends_connected}/${audit.rails.ends_total} 接上, 尽头 ${n(audit.rails.dead_end)} ${show(audit.rails.dead_end, 3)}`);
    console.log(`信号 ${audit.signals.total}: 没连到轨 ${n(audit.signals.unconnected)} ${show(audit.signals.unconnected)}; 车站 ${audit.stops.total}: 没连到轨 ${n(audit.stops.unconnected)} ${show(audit.stops.unconnected)}`);
    // 静态 vs 引擎, 能一一对上的几类
    const curves = (audit.belts.shape.left ?? 0) + (audit.belts.shape.right ?? 0);
    const rows: [string, number, number][] = [
      ["不在任何电网里的用电建筑 (引擎清单最多 cap 条)", count("no-power-coverage"), noNetwork.length],
      ["地下带入口没配对", count("underground-unpaired"), n(audit.belts.ug_orphan)],
      ["传送带弯道", num("belt-curve"), curves],
      ["传送带没有下游 (尽头+顶建筑+顶不接的面+迎头)", num("belt-end") + num("belt-into-building") + count("belt-blocked") + count("belt-head-on"), n(audit.belts.dead_end)],
      ["铁轨尽头 (端点数)", num("rail-dead-end"), n(audit.rails.dead_end)],
      ["信号位置不合法", count("signal-misplaced"), n(audit.signals.unconnected)],
      ["车站没接轨", count("train-stop-no-rail"), n(audit.stops.unconnected)],
    ];
    console.log("\n== 静态 vs 引擎");
    for (const [what, a, b] of rows) console.log(`  ${a === b ? "✅" : "❓"} ${what}: 静态 ${a}, 引擎 ${b}`);
    // 弯道逐个位置对 (引擎坐标换回蓝图坐标)
    const staticCurves = new Set(((findings.find((f) => f.kind === "belt-curve")?.data as [number, number][] | undefined) ?? []).map(([x, y]) => `${x},${y}`));
    const engineCurves = new Set((Array.isArray(audit.belts.curves) ? audit.belts.curves : []).map(([x, y]) => `${x - off.x},${y - off.y}`));
    const onlyStatic = [...staticCurves].filter((k) => !engineCurves.has(k)), onlyEngine = [...engineCurves].filter((k) => !staticCurves.has(k));
    if (onlyStatic.length || onlyEngine.length) console.log(`  弯道位置不一致: 只有静态认为是弯道 ${onlyStatic.length} 处 ${onlyStatic.slice(0, 5).join(" ")}; 只有引擎认为是弯道 ${onlyEngine.length} 处 ${onlyEngine.slice(0, 5).join(" ")}`);
    // 传送带没有下游: 逐个位置对
    const staticEnds = new Set(((findings.find((f) => f.kind === "belt-end")?.data as [number, number][] | undefined) ?? []).map(([x, y]) => `${x},${y}`));
    const engineEnds = new Set((Array.isArray(audit.belts.dead_end_all) ? audit.belts.dead_end_all : []).map(([x, y]) => `${x - off.x},${y - off.y}`));
    const endOnlyStatic = [...staticEnds].filter((k) => !engineEnds.has(k)), endOnlyEngine = [...engineEnds].filter((k) => !staticEnds.has(k));
    if (endOnlyStatic.length || endOnlyEngine.length) console.log(`  没有下游的位置不一致: 只有静态 ${endOnlyStatic.length} 处 ${endOnlyStatic.slice(0, 6).join(" ")}; 只有引擎 ${endOnlyEngine.length} 处 ${endOnlyEngine.slice(0, 6).join(" ")}`);
  } finally {
    await lab.stop({ save: false });
  }
} else {
  console.log(`不认识的命令: ${cmd}`);
  process.exitCode = 2;
}
