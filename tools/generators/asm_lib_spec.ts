// 蓝图库缺的组装机排规格 (./plan 按配方挑块)。
// 从游戏数据算每个配方要几个机械臂、一排放几台不会把带子吃满, 写成 assembler_row.py 的 --spec。尺寸和数量的真值由喂料实测 (npm run bp -- feed) 给, 这里只定候选。
//   node --env-file-if-exists=.env tools/generators/asm_lib_spec.ts <输出 spec.json>
// 算法的假设: 组装机2型速度 0.75; 机械臂每手 1 个 (没研究时; 实验 inserter.hand-size-no-research) 普通 0.83/秒、快速 2.31/秒;
// 带子每道: 基础 7.5/秒、高速 15/秒; 进料带每道一种料; 出料臂都放在带子同一道。
import fs from "node:fs";
import { loadGameData, type GameData } from "../../src/calc/data.ts";
import { chainPlan, machineFor } from "../../src/play/plan-lib.ts";

const SPEED = 0.75, SPEED_EARLY = 0.5, W = 3;
/** 开局 (只研究了自动化): 组装机1型 + 电力机械臂 + 基础传送带能做的红瓶绿瓶链 (2026-11-05 新图班: 库里全是 2 型, 开局放不了) */
export const EARLY = ["automation-science-pack", "logistic-science-pack", "iron-gear-wheel", "transport-belt", "inserter", "copper-cable", "electronic-circuit"];
const THR: Record<string, number> = { inserter: 0.83, "fast-inserter": 2.31 };
const LANE: Record<string, number> = { "transport-belt": 7.5, "fast-transport-belt": 15 };
const PACKS = ["automation-science-pack", "logistic-science-pack", "military-science-pack", "chemical-science-pack", "production-science-pack", "utility-science-pack"];
const HAVE = new Set(["iron-gear-wheel", "inserter", "electronic-circuit", "engine-unit"]); // asm-try.txt 里已有, 编号别动

export type Spec = { recipe: string; machine: string; inserter: string; belt: string; n: number; per_input: number; out: number; layout: "single" | "double" };

/** 一个配方的候选: 单排, 再加一个双排 (两排共用进料带, 所以进料按 2 倍算); 放不下的不出 */
export function specsFor(gd: GameData, name: string, opts: { early?: boolean } = {}): Spec[] {
  const r = gd.recipes.get(name);
  if (!r) return [];
  const machine = opts.early ? "assembling-machine-1" : "assembling-machine-2";
  const c = (opts.early ? SPEED_EARLY : SPEED) / r.time;
  const solid = r.ingredients.filter((i) => i.type !== "fluid");
  if (solid.length !== r.ingredients.length || solid.length < 1 || solid.length > 4) return [];
  const belts = solid.length <= 2 ? 1 : 2;
  const rates = solid.map((i) => i.amount * c);
  const perBelt = rates.reduce((a, b) => a + b, 0) / belts;
  const outRate = r.products.filter((p) => p.type !== "fluid").reduce((s, p) => s + p.amount, 0) * c;
  let inserter = "inserter";
  let perInput = Math.max(1, Math.ceil(perBelt / THR[inserter]));
  let out = Math.max(1, Math.ceil(outRate / THR[inserter]));
  if (opts.early) {
    // 开局只有电力机械臂和基础传送带: 放不下就少放, 机器吃不饱也比没有块强 (喂料实测的效率会写在块的说明里);
    // 每行至少留 1 格给电线杆 (3 格放满时生成器报 "盖不到", 2026-11-05)
    perInput = Math.min(perInput, Math.floor((W - 1) / belts));
    out = Math.min(out, W - 1);
  } else if (perInput * belts > W || out > W) {
    inserter = "fast-inserter";
    perInput = Math.max(1, Math.ceil(perBelt / THR[inserter]));
    out = Math.max(1, Math.ceil(outRate / THR[inserter]));
    if (perInput * belts > W || out > W) return [];
  }
  const fits = (belt: string, inMult: number) => Math.min(6, Math.floor(LANE[belt] / Math.max(Math.max(...rates) * inMult, outRate)));
  const belt = opts.early || fits("transport-belt", 1) >= 4 ? "transport-belt" : "fast-transport-belt";
  const out2: Spec[] = [];
  const base = { recipe: name, machine, inserter, belt, per_input: perInput, out };
  const single = fits(belt, 1), double = fits(belt, 2);
  if (single >= 2) out2.push({ ...base, n: single, layout: "single" });
  if (double >= 2) out2.push({ ...base, n: double, layout: "double" });
  return out2;
}

/** 六种科技包全链里, 组装机能做、库里还没有的配方 (固定顺序: 生成结果可复现) */
export function missingRecipes(gd: GameData): string[] {
  const tech = { automation2: true, steelFurnace: true, electricFurnace: false };
  const names = new Set<string>();
  for (const p of PACKS) for (const rn of Object.keys(chainPlan(gd, p, 60, tech).recipes)) {
    const r = gd.recipes.get(rn);
    if (r && /assembling/.test(machineFor(gd, r, tech) ?? "") && !HAVE.has(rn)) names.add(rn);
  }
  return [...names].sort();
}

if ((import.meta as { main?: boolean }).main) {
  const out = process.argv[2];
  if (!out) { console.log("用法: asm_lib_spec.ts <输出 spec.json>"); process.exit(1); }
  const gd = loadGameData();
  const specs: Spec[] = [], skipped: string[] = [];
  const early = process.argv.includes("--early");
  for (const rn of early ? EARLY : missingRecipes(gd)) { const s = specsFor(gd, rn, { early }); if (s.length) specs.push(...s); else skipped.push(rn); }
  fs.writeFileSync(out, JSON.stringify(specs, null, 1));
  console.log(`${specs.length} 个变体 → ${out}; 这个生成器出不了 (有流体 / 一行放不下): ${skipped.join(", ") || "无"}`);
}
