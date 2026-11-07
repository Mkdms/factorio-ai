#!/usr/bin/env node
// 计算器命令行: npm run calc -- <方案.json>
// 方案: { "targets": { 物品: 每分钟 }, "recipes": { 配方: { "machine": 机器, "modules": [...], "beacons": {...}, "quality": 0 } }, "imports": [可以从外面进的] }
// 输出: 每个配方要几台、每分钟吃 / 出多少、电和燃料; 从外面进的、多出来的。名字一律官方中文名。
import fs from "node:fs";
import path from "node:path";
import { loadGameData } from "./data.ts";
import { solvePlan, type Plan } from "./solve.ts";
import { defaultDumpPath } from "../blueprint/rules.ts";
import { zhNamesFrom } from "../lab/names.ts";
import { chainPlans } from "../play/plan-lib.ts";
import type { Tech } from "../play/expand.ts";

const file = process.argv[2];
if (!file) {
  console.log("用法: npm run calc -- <方案.json>  (例: plans/gleba-bio-core.json)");
  process.exit(2);
}
const USAGE = `用法: ./calc '{"targets":{"automation-science-pack":30}}'
只给 targets: 自动展开全链 (默认组装机2型 + 石炉, 矿、水、石油气和燃料算从外面进)。
换机器档: 加 "tech":{"automation2":false,"steelFurnace":true,"electricFurnace":false}; 想逐个配方指定机器 / 插件: 加 "recipes":{"配方":{"machine":"机器"}}。`;
let parsed: (Plan & { note?: string; tech?: Partial<Tech> }) | null = null;
try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
if (!parsed || typeof parsed !== "object" || !parsed.targets) { console.log(USAGE); process.exit(2); } // 2026-11-05 ./calc --help 崩 SyntaxError
const dump = defaultDumpPath();
const gd = loadGameData(dump);
// 2026-11-05 新图班 Grok、Gpt、Deepseek: 简报的例子只给 targets, 崩 TypeError (plan.recipes 是 undefined), 全班 6 次, 大脑就不用了 → 没给配方就展开全链
const autoChain = !parsed.recipes;
const plan: Plan & { note?: string } = autoChain ? { ...chainPlans(gd, parsed.targets, parsed.tech), note: parsed.note } : parsed;
const zhName = zhNamesFrom(path.dirname(dump));
// CALC_IDS=1: 名字后面带内部名 (大脑用 fp 时要内部名)
const zh = (k: string) => (process.env.CALC_IDS === "1" ? `${zhName(k)} (${k})` : zhName(k));
const res = solvePlan(gd, plan);
const f = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
const items = (o: Record<string, number>) => Object.entries(o).filter(([, v]) => v > 1e-9).map(([k, v]) => `${zh(k)} ${f(v)}`).join("、") || "—";
console.log(`方案 ${path.basename(file)}${plan.note ? `: ${plan.note}` : ""}  (数据 ${gd.version})`);
console.log(`目标 (每分钟净产出): ${items(plan.targets)}\n`);
if (autoChain) console.log(`自动展开全链 (${res.rows.map((r) => r.machine).filter((m, i, a) => a.indexOf(m) === i).map(zh).join("、")}); 换机器档见 ./calc --help\n`);
console.log("| 配方 | 机器 | 台数 | 每台每分钟 | 吃 (每分钟) | 出 (每分钟) | 燃料 (每分钟) | 电 kW |\n|---|---|---|---|---|---|---|---|");
for (const r of res.rows) {
  console.log(`| ${zh(r.recipe)} | ${zh(r.machine)} | ${f(r.machines)} (${Math.ceil(r.machines - 1e-9)}) | ${f(r.perMachine)} | ${items(r.inputs)} | ${items(r.outputs)} | ${r.fuel ? `${zh(r.fuel.item)} ${f(r.fuel.perMin)}` : "—"} | ${f(r.powerW / 1000)} |`);
}
console.log(`\n从外面进: ${items(res.imports)}`);
console.log(`多出来的: ${items(res.surplus)}`);
for (const w of res.spoilWaste) console.log(`腐坏浪费: ${zh(w.item)} 一批 ${f(w.batch)} 个、保质期 ${f(w.lifeMin)} 分钟, 至少每分钟做 ${f(w.minPerMin)}, 只用 ${f(w.usedPerMin)} → 每分钟坏掉约 ${f(w.wastePerMin)} (已算进上面的用料)`);
console.log(`电: ${f(res.powerW / 1e6)} MW (电力机器满负荷 + 待机; 待机按耗电 / 30 算, 待核实)`);
// 这一班装了 Factory Planner 就自动对一遍 (src/calc/fp-live.ts); 没装或连不上就不说, 不影响上面的结果
if (process.env.FP_SESSION) {
  try {
    const { fpLive } = await import("./fp-live.ts");
    const lines = await fpLive(gd, plan, res, process.env.FP_SESSION);
    if (lines) console.log(`\nFactory Planner 对照 (游戏里同一方案算一遍):\n${lines.join("\n")}`);
  } catch { /* 对照是附带的 */ }
}
