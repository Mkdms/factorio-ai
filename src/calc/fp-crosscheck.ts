#!/usr/bin/env node
// 计算器对照: 同一份方案, 我们的 solvePlan 算一遍, Factory Planner (补丁版, tools/patch-fp.py) 算一遍, 并排比机器数。
// 起一个沙盘 + 游戏窗口 (FP 是游戏内模组, 求解器要有玩家), 装 mods/factoryplanner; 结果打印并写 lab-data/calc-crosscheck-<时间>.json。
//   npm run calc:crosscheck -- plans/a.json [plans/b.json …] [--solver sequential|simplex|gaussian] [--linger 秒]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { LabInstance } from "../lab/instance.ts";
import { labRoot, REPO } from "../lab/gamedir.ts";
import { loadGameData } from "./data.ts";
import { solvePlan, type Plan } from "./solve.ts";
import { packFactory, parseFpResult, compareRows, comparisonLines } from "./fp.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { solver: { type: "string", default: "sequential" }, linger: { type: "string", default: "0" } } });
if (!positionals.length) { console.log("用法: npm run calc:crosscheck -- plans/<方案>.json …"); process.exit(1); }
if (!fs.existsSync(path.join(REPO, "mods", "factoryplanner", "info.json"))) { console.log("没有 mods/factoryplanner: 先 python -I tools/patch-fp.py --src <FactoryPlanner 仓库> --dst mods/factoryplanner"); process.exit(1); }

const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} 秒] ${s}`);
const gd = loadGameData();
const lab = new LabInstance({ name: "calc-fp", view: true, label: "计算器对照 Factory Planner", repoMods: ["factoryplanner"] });
const report: { plan: string; ok: boolean; error?: string; lines: string[]; comparison: unknown; fpProducts?: Record<string, number> }[] = [];
try {
  await lab.createMap("m", { seed: 1 });
  await lab.start("m"); // view: true → 开窗口等玩家连上 (FP 在玩家加入时建它的数据)
  await lab.exec(`remote.call("freeplay", "set_skip_intro", true) remote.call("freeplay", "set_disable_crashsite", true) return true`);
  await lab.rpc("viewer", {}).catch(() => undefined);
  await lab.exec(`game.forces.player.research_all_technologies() return true`); // 配方都解锁, FP 才认
  for (let i = 0; i < 30; i++) { if (((await lab.exec(`return #game.connected_players`)) as number) >= 1) break; await new Promise((r) => setTimeout(r, 1000)); }
  const ifaces = (await lab.exec(`local out = {} for k in pairs(remote.interfaces["fp-interface"] or {}) do out[#out + 1] = k end return out`)) as string[];
  log(`fp-interface 的方法: ${JSON.stringify(ifaces)}`);
  for (const file of positionals) {
    const plan = JSON.parse(fs.readFileSync(file, "utf8")) as Plan;
    const ours = solvePlan(gd, plan);
    const { packed, notes } = packFactory(gd, plan, { solver: values.solver as "sequential", name: path.basename(file) });
    const raw = await lab.exec(`local a = ... return remote.call("fp-interface", "solve_packed", 1, a)`, packed, { timeoutMs: 120_000 });
    const fp = parseFpResult(raw);
    const cmp = compareRows(ours, fp, notes);
    const lines = fp.error ? [`❌ FP 出错: ${fp.error}`] : comparisonLines(cmp);
    log(`${file}:\n  ${lines.join("\n  ")}${fp.error ? "" : `\n  FP 产品: ${JSON.stringify(fp.products)}; 有效 ${fp.valid}`}`);
    if (fp.error || !fp.lines.length) log(`  FP 调试: ${JSON.stringify(fp.debug).slice(0, 1500)}`);
    report.push({ plan: file, ok: !fp.error && cmp.every((c) => c.fp !== null && Math.abs(c.diffPct ?? 0) <= 2), error: fp.error, lines, comparison: cmp, fpProducts: fp.products });
  }
  const linger = Number(values.linger);
  if (linger > 0) await new Promise((r) => setTimeout(r, linger * 1000));
} catch (e) {
  log(`出错: ${(e as Error).message.slice(0, 400)}`);
} finally {
  await lab.stop({ save: false });
}
const out = path.join(labRoot(), `calc-crosscheck-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n${report.filter((r) => r.ok).length} / ${report.length} 个方案两边一致 (差 ≤2%); 明细 ${out}`);
