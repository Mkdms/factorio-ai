// 放机器时自动算一遍 (库, 不直接运行): 这个产物按 30/分 要几台、从外面进什么, 用的就是 ./calc 的求解器。
// : 18 班 ./calc 只有 14 次, 这班前 70 分钟 4 次; 放机器正是要知道配比的时候, 不等模型想起来。
import { loadGameData } from "../calc/data.ts";
import { solvePlan, type Result } from "../calc/solve.ts";
import { chainPlans } from "./plan-lib.ts";

const f = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

/** 求解结果 → 一两行; 只列台数最多的几个配方 */
export function calcLine(item: string, perMin: number, res: Result, zh: (id: string) => string | undefined, maxRows = 6): string {
  const name = (id: string) => zh(id) ?? id;
  const rows = [...res.rows].sort((a, b) => b.machines - a.machines).slice(0, maxRows).map((r) => `${name(r.recipe)} ${Math.ceil(r.machines - 1e-9)} 台 (${name(r.machine)}, 每台 ${f(r.perMachine)}/分)`);
  const imports = Object.entries(res.imports).filter(([, v]) => v > 1e-9).slice(0, 6).map(([k, v]) => `${name(k)} ${f(v)}`).join("、");
  return `算好的 (./calc, ${name(item)} ${perMin}/分, 不算场上已有的; 换目标或机器档自己跑 ./calc): ${rows.join("、")}${res.rows.length > maxRows ? " …" : ""}${imports ? `; 从外面进 ${imports}` : ""}; 电 ${f(res.powerW / 1e6)} MW`;
}

/** 这个产物按 perMin 要几台 (做它自己的那个配方); 算不出来 null */
export function machinesFor(item: string, perMin = 30): number | null {
  try {
    const gd = loadGameData();
    const res = solvePlan(gd, chainPlans(gd, { [item]: perMin }));
    const row = res.rows.find((r) => r.recipe === item) ?? res.rows.find((r) => gd.recipes.get(r.recipe)?.products.some((p) => p.name === item));
    return row ? Math.ceil(row.machines - 1e-9) : null;
  } catch { return null; }
}

/** 这个产物的配比; 算不出来 (不是产物、没配方) 返回 null, 不影响放机器 */
export function calcBrief(item: string, zh: (id: string) => string | undefined, perMin = 30): string | null {
  try {
    const gd = loadGameData();
    if (![...gd.recipes.values()].some((r) => r.products.some((p) => p.name === item))) return null;
    return calcLine(item, perMin, solvePlan(gd, chainPlans(gd, { [item]: perMin })), zh);
  } catch { return null; }
}
