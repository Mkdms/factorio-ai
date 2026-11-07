#!/usr/bin/env node
// 沙盘命令行。用法 (在仓库根目录):
//   node --env-file-if-exists=.env src/lab/cli.ts demo [--minutes 10] [--instances 2] [--seed N]
//   node --env-file-if-exists=.env src/lab/cli.ts dump-data
import { parseArgs } from "node:util";
import { runDemo } from "./demo.ts";
import { LabInstance } from "./instance.ts";
import { watch } from "./watch.ts";
import { runExperiments } from "../verify/runner.ts";
import { EXPERIMENTS } from "../../experiments/index.ts";
import { deriveRailGeometry, loadRailGeometry, railGeometryPath } from "../blueprint/rail-geometry.ts";
import { deriveDefines, definesFile, loadDefines } from "./defines.ts";
import path from "node:path";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    minutes: { type: "string", default: "10" },
    instances: { type: "string", default: "2" },
    seed: { type: "string" },
    speed: { type: "string", default: "1000" },
    only: { type: "string" },
    force: { type: "boolean", default: false },
    dry: { type: "boolean", default: false }, // 只干跑, 不正式跑
    nodry: { type: "boolean", default: false }, // 跳过干跑 (回归测试本身就是无窗口的, 不用)
  },
});

const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} 秒] ${s}`);

async function demo() {
  const n = Number(values.instances);
  const minutes = Number(values.minutes);
  const seed = values.seed ? Number(values.seed) : undefined;
  log(`并行启动 ${n} 个沙盘实例, 每个加速跑游戏内 ${minutes} 分钟`);
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => runDemo(`demo-${i + 1}`, { minutes, seed, speed: Number(values.speed), log })),
  );
  let ok = true;
  for (const r of results) {
    const p = r.produced, c = r.consumed;
    console.log(`\n== ${r.instance} (耗时 ${r.wallSeconds.toFixed(1)} 秒)`);
    console.log(`  建成 ${r.placed.built}/${r.placed.ghosts} 件, 失败 ${r.placed.failed_count}, 原点偏移 ${JSON.stringify(r.placed.offset)}`);
    console.log(`  建筑状态: ${JSON.stringify(r.status)}`);
    console.log(`  产出: 铁矿 ${p["iron-ore"] ?? 0}, 铁板 ${p["iron-plate"] ?? 0}, 齿轮 ${p["iron-gear-wheel"] ?? 0}`);
    console.log(`  消耗: 铁矿 ${c["iron-ore"] ?? 0}, 铁板 ${c["iron-plate"] ?? 0}`);
    console.log(`  区域内物品: ${JSON.stringify(r.items)}`);
    console.log(`  游戏自带 production-score: ${r.productionScore}; 按"产出-消耗"全算的价值: ${r.netValue}`);
    console.log(`  隔离标记只在本实例: ${r.markerIsolated ? "是" : "否"}`);
    if (!r.markerIsolated || r.placed.failed_count || r.status.no_power || !(p["iron-gear-wheel"] > 0)) ok = false;
  }
  if (results.length > 1) {
    const key = (r: (typeof results)[0]) => JSON.stringify([r.produced, r.consumed, r.productionScore]);
    const same = results.every((r) => key(r) === key(results[0]));
    console.log(`\n${n} 个实例结果${same ? "完全一致 (同种子同蓝图, 说明互不干扰)" : "不一致, 需要排查"}`);
    if (!same) ok = false;
  }
  console.log(ok ? "\n通过" : "\n未通过");
  process.exitCode = ok ? 0 : 1;
}

async function dumpData() {
  const lab = new LabInstance({ name: "dump", view: false });
  const f = await lab.dumpPrototypes();
  log(`原型数据和中英文名称: ${f}`);
  // 铁轨几何 (端点、信号合法位置) 和 defines 对照表 (状态码 → 名字, 联机接口用; src/lab/defines.ts) 原型数据里没有, 要开一次沙盘从引擎读
  const needRail = !loadRailGeometry() || values.force, needDefines = !loadDefines(f) || values.force;
  if (needRail || needDefines) {
    await lab.createMap("dump", { seed: 1 });
    await lab.start("dump");
    try {
      if (needRail) {
        const g = await deriveRailGeometry(lab, path.basename(f));
        log(`铁轨几何 (${Object.keys(g.rails).length} 种铁轨): ${railGeometryPath()}`);
      }
      if (needDefines) {
        const d = await deriveDefines(lab, f);
        log(`defines 对照表 (${Object.keys(d).length} 张, entity_status ${Object.keys(d.entity_status).length} 种): ${definesFile(f)}`);
      }
    } finally {
      await lab.stop({ save: false });
    }
  } else log(`铁轨几何、defines 对照表已有 (加 --force 重导)`);
}

const cmd = positionals[0];
if (cmd === "demo") await demo();
else if (cmd === "dump-data") await dumpData();
else if (cmd === "verify") {
  const ids = values.only?.split(",");
  const list = EXPERIMENTS.filter((e) => !ids || ids.some((id) => e.exp.id.includes(id)));
  // 第一步: 无窗口干跑 (不写知识库, 不开窗口, 不受窗口 20 倍速上限), 实验自己的错在这里暴露, 用户在窗口里只看到正式的那一遍
  if (!values.nodry) {
    log(`干跑 ${list.length} 个实验 (无窗口, 不写知识库)…`);
    const dry = await runExperiments(list, { log: () => undefined, write: false, view: false, name: "verify-dry" });
    const broken = dry.filter((r) => (r.verdict === "inconclusive" && /实验出错|布局检查|没电/.test(r.summary)) || (r.autoFixes ?? 0) > 0);
    for (const r of dry) log(`  干跑 ${r.verdict === "verified" ? "✅" : r.verdict === "refuted" ? "❌" : "❔"} ${r.id}: ${r.summary.slice(0, 160)}${(r.autoFixes ?? 0) > 0 ? ` (自动补了 ${r.autoFixes} 根杆子)` : ""}`);
    if (broken.length) {
      log(`干跑有 ${broken.length} 个实验自己出了错 (出错 / 摆错 / 靠自动补杆), 先修实验, 不开窗口正式跑: ${broken.map((r) => r.id).join(", ")}`);
      process.exitCode = 1;
      process.exit();
    }
    if (values.dry) process.exit();
  }
  const recs = await runExperiments(list, { log });
  const n = (v: string) => recs.filter((r) => r.verdict === v).length;
  log(`完成 ${recs.length} 个实验: 已核实 ${n("verified")}, 被推翻 ${n("refuted")}, 没结论 ${n("inconclusive")}; 结果在 knowledge/facts.md`);
} else if (cmd === "watch") await watch({ seed: values.seed ? Number(values.seed) : undefined, log });
else {
  console.log("用法: cli.ts demo [--minutes 10] [--instances 2] [--seed N] | watch [--seed N] | verify [--only 编号片段,...] | dump-data");
  process.exitCode = 2;
}
