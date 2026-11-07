// 扩产提案 (M6 目标树的最小版): 监工按产量读数定下一档目标, 用计算器 (src/calc, 已和 Factory Planner
// 对过 18 条配方 0% 差) 算要几台什么机器, 减掉场上已有的, 把差额当具体任务派给大脑; 大脑只执行和处理阻塞。
// 机器都齐了产量还没上来 → 说"瓶颈不在机器数", 让它查原料供给 / 体检, 别再加机器。纯函数有单元测试 test/expand.test.ts。
import { solvePlan, type Plan, type Result } from "../calc/solve.ts";
import type { GameData } from "../calc/data.ts";

export type Rung = { red: number; green: number; blue: number };
export type Rates = { red: number; green: number; blue: number };
/** 目标阶梯 (每分钟): 从简报的 30 / 30 起翻倍, 蓝瓶从第 3 档开始; 全达到就最后一档再翻倍 */
export const LADDER: Rung[] = [
  { red: 30, green: 30, blue: 0 }, { red: 60, green: 60, blue: 0 }, { red: 60, green: 60, blue: 30 }, { red: 120, green: 120, blue: 60 }, { red: 180, green: 180, blue: 120 },
];
const KEYS = ["red", "green", "blue"] as const;
/** 这一档达到了 = 每一项都到档位的 90% */
export const reached = (rung: Rung, now: Rates) => KEYS.every((k) => rung[k] <= 0 || now[k] >= rung[k] * 0.9);
/** 下一档 = 第一个没达到的档 */
export function nextRung(now: Rates): Rung {
  for (const r of LADDER) if (!reached(r, now)) return r;
  const last = LADDER.at(-1)!;
  return { red: last.red * 2, green: last.green * 2, blue: last.blue * 2 };
}

export type Tech = { automation2: boolean; steelFurnace: boolean; electricFurnace: boolean; oil: boolean; electricDrill: boolean };
/** 这一档的方案: 机器按已研究的科技选 (组装机 2 / 1 型, 电炉 / 钢炉 / 石炉); 蓝瓶链把石油气当外购 (炼油另算); 矿和煤从外面进 (采矿机单独算) */
export function planFor(rung: Rung, tech: Tech): Plan {
  const am = tech.automation2 ? "assembling-machine-2" : "assembling-machine-1";
  const furnace = tech.electricFurnace ? "electric-furnace" : tech.steelFurnace ? "steel-furnace" : "stone-furnace";
  const targets: Record<string, number> = { "automation-science-pack": rung.red };
  const recipes: Plan["recipes"] = { "automation-science-pack": { machine: am }, "iron-gear-wheel": { machine: am }, "iron-plate": { machine: furnace }, "copper-plate": { machine: furnace } };
  if (rung.green > 0) {
    targets["logistic-science-pack"] = rung.green;
    Object.assign(recipes, { "logistic-science-pack": { machine: am }, inserter: { machine: am }, "transport-belt": { machine: am }, "electronic-circuit": { machine: am }, "copper-cable": { machine: am } });
  }
  if (rung.blue > 0 && tech.oil) {
    targets["chemical-science-pack"] = rung.blue;
    Object.assign(recipes, { "chemical-science-pack": { machine: am }, "advanced-circuit": { machine: am }, "engine-unit": { machine: am }, "plastic-bar": { machine: "chemical-plant" }, sulfur: { machine: "chemical-plant" }, "steel-plate": { machine: furnace }, pipe: { machine: am }, "electronic-circuit": { machine: am }, "copper-cable": { machine: am } });
  }
  return { targets, recipes, imports: ["iron-ore", "copper-ore", "coal", "stone", "petroleum-gas", "water"] };
}

/** 场上已有的: 组装机按配方计数, 炉子只数总数 (铁 / 铜随时可换), 采矿机按矿折成每分钟出矿 (采矿速度 × 60, 不算研究加成) */
export type Existing = { assemblers: Record<string, number>; furnaces: number; drillPerMin: Record<string, number>; tech: Tech; assemblerSpeed?: Record<string, number>; furnaceSpeed?: number };
// crafting_speed: LuaEntity 的当前制作速度 (含插件和分享塔; 本机 2.1.24 doc-html 有这个成员, 2026-11-06 查), 机器不同档时按它折算
export const EXISTING_LUA = `local s = game.surfaces[1] local f = game.forces.player
local asm, asmSpeed = {}, {} for _, m in pairs(s.find_entities_filtered{type = "assembling-machine", force = f}) do local r = m.get_recipe() if r then asm[r.name] = (asm[r.name] or 0) + 1 asmSpeed[r.name] = (asmSpeed[r.name] or 0) + m.crafting_speed end end
local furnaces, furnaceSpeed = 0, 0 for _, m in pairs(s.find_entities_filtered{type = "furnace", force = f}) do furnaces = furnaces + 1 furnaceSpeed = furnaceSpeed + m.crafting_speed end
local drills = {} for _, d in pairs(s.find_entities_filtered{type = "mining-drill", force = f}) do local t = d.mining_target if t and t.valid then drills[t.name] = (drills[t.name] or 0) + d.prototype.mining_speed * 60 end end
local t = f.technologies local function researched(n) return t[n] ~= nil and t[n].researched or false end
return {assemblers = asm, assemblerSpeed = asmSpeed, furnaces = furnaces, furnaceSpeed = furnaceSpeed, drillPerMin = drills, tech = {automation2 = researched("automation-2"), steelFurnace = researched("steel-processing"),
  electricFurnace = researched("advanced-material-processing-2"), oil = researched("oil-processing"), electricDrill = researched("electric-mining")}}`;
const rec = (v: unknown): Record<string, number> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {});
export function normalizeExisting(raw: unknown): Existing {
  const r = (raw ?? {}) as Partial<Existing>;
  const t = (r.tech ?? {}) as Partial<Tech>;
  return { assemblers: rec(r.assemblers), assemblerSpeed: rec(r.assemblerSpeed), furnaces: Number(r.furnaces ?? 0), furnaceSpeed: Number(r.furnaceSpeed ?? 0), drillPerMin: rec(r.drillPerMin), tech: { automation2: !!t.automation2, steelFurnace: !!t.steelFurnace, electricFurnace: !!t.electricFurnace, oil: !!t.oil, electricDrill: !!t.electricDrill } };
}

/** have = 场上台数; equiv = 按目标机器折算是几台 (只在场上机器和目标不同档时有; 班次 2026-11-06T05-15-13: 6 台组装机1型 + 6 台组装机2型按 12 台组装机2型算, 少算了缺口) */
export type Delta = { kind: "assembler" | "furnace" | "drill"; key: string; machine: string; need: number; have: number; add: number; note?: string; equiv?: number };
/** 差几台: 给了 gd 和场上速度就按产能折算, 否则按台数 */
function shortBy(exact: number, have: number, speed: number | undefined, machine: string, gd?: Pick<GameData, "machines">): { add: number; equiv?: number } {
  const target = gd?.machines.get(machine)?.speed;
  if (!target || !speed) return { add: Math.max(0, Math.ceil(exact - 1e-6) - have) };
  const eq = speed / target;
  const add = Math.max(0, Math.ceil(exact - eq - 1e-6));
  return Math.abs(eq - have) < 0.01 ? { add } : { add, equiv: Math.round(eq * 10) / 10 };
}
/** 计算器结果 vs 场上已有 → 每样差几台 (已够的 add = 0 也列, 给提案说"已够") */
export function deltas(result: Result, existing: Existing, gd?: Pick<GameData, "machines">): Delta[] {
  const out: Delta[] = [];
  let furnaceNeed = 0;
  const furnaceParts: string[] = [];
  for (const row of result.rows) {
    if (row.machines <= 0.001) continue;
    if (/furnace/.test(row.machine)) { furnaceNeed += row.machines; furnaceParts.push(`${row.recipe} ${Math.ceil(row.machines - 1e-6)}`); continue; }
    const need = Math.ceil(row.machines - 1e-6), have = existing.assemblers[row.recipe] ?? 0;
    out.push({ kind: "assembler", key: row.recipe, machine: row.machine, need, have, ...shortBy(row.machines, have, existing.assemblerSpeed?.[row.recipe], row.machine, gd) });
  }
  if (furnaceNeed > 0) {
    const need = Math.ceil(furnaceNeed - 1e-6);
    const machine = result.rows.find((r) => /furnace/.test(r.machine))?.machine ?? "stone-furnace";
    out.push({ kind: "furnace", key: "furnace", machine, need, have: existing.furnaces, ...shortBy(furnaceNeed, existing.furnaces, existing.furnaceSpeed, machine, gd), note: furnaceParts.join(" + ") });
  }
  const rate = existing.tech.electricDrill ? 30 : 15, drill = existing.tech.electricDrill ? "electric-mining-drill" : "burner-mining-drill";
  for (const [ore, perMin] of Object.entries(result.imports)) {
    if (!/-ore$|^coal$|^stone$/.test(ore) || perMin <= 0) continue;
    const have = existing.drillPerMin[ore] ?? 0;
    out.push({ kind: "drill", key: ore, machine: drill, need: Math.ceil(perMin / rate - 1e-6), have: Math.round(have / rate), add: Math.max(0, Math.ceil((perMin - have) / rate - 1e-6)), note: `每分钟要 ${perMin.toFixed(0)}, 现有采矿机合计出 ${have.toFixed(0)}` });
  }
  return out;
}
export const isDone = (ds: Delta[]) => ds.every((d) => d.add <= 0);

/** 给大脑的话: 目标、现状、差额 (已够的不列)、怎么核、怎么汇报; 机器齐了产量没到 → 瓶颈不在机器数 */
export function proposalMessage(a: { rung: Rung; now: Rates; deltas: Delta[]; health: string[]; zh: (n: string) => string }): string {
  const { rung, now, zh } = a;
  const target = `红瓶 ${rung.red} / 绿瓶 ${rung.green}${rung.blue ? ` / 蓝瓶 ${rung.blue}` : ""} 每分钟`;
  const nowS = `红 ${now.red.toFixed(1)} / 绿 ${now.green.toFixed(1)} / 蓝 ${now.blue.toFixed(1)}`;
  const todo = a.deltas.filter((d) => d.add > 0);
  if (!todo.length) {
    if (reached(rung, now)) return `扩产复核: 这一档 (${target}) 的机器齐了、产量也到了 (${nowS})。下一档我下次复核时再算; 这期间把科技包都送进研究中心、研究别停。`;
    const h = a.health.slice(0, 4).join("; ");
    return `扩产复核: 这一档 (${target}) 的机器按计算器已经够了, 但产量只有 ${nowS} —— 瓶颈不在机器数, 别再加机器: 查原料供给 (矿、板子够不够、带子堵不堵、炉子有没有燃料)、机械臂方向、电力。${h ? `体检里的线索: ${h}。` : ""}`;
  }
  const lines = todo.map((d) => {
    const eq = d.equiv !== undefined ? ` (折合 ${d.equiv} 台)` : "";
    if (d.kind === "furnace") return `- 炉子 (${zh(d.machine)}, 任意炉都算): 现 ${d.have} 台${eq} → 要 ${d.need} 台 (${d.note}), 加 ${d.add}; 整块建用 ./bp list 冶炼 挑一块`;
    if (d.kind === "drill") return `- ${zh(d.key)} 采矿机 (${zh(d.machine)}): 现 ${d.have} 台 → 要 ${d.need} 台, 加 ${d.add} (${d.note})`;
    return `- ${zh(d.key)} 的机器 (${zh(d.machine)}): 现 ${d.have} 台${eq} → 要 ${d.need} 台, 加 ${d.add}`;
  });
  const targetsJson = JSON.stringify({ targets: Object.fromEntries([["automation-science-pack", rung.red], ...(rung.green ? [["logistic-science-pack", rung.green]] : []), ...(rung.blue ? [["chemical-science-pack", rung.blue]] : [])]) });
  return `扩产提案 (监工按读数算的; 目标 = 下一档 ${target}; 现在 ${nowS}):\n${lines.join("\n")}\n已够的没列。要整块建就跑 ./plan 物品 每分钟 (算好差额、挑蓝图、找空地、查缺料); 只想核数 ./calc '${targetsJson}'。原料走传送带; 建完说"扩产完成", 我每 15 分钟复核一次。`;
}

/** 一次提案的全部计算 (给 run.ts 用, 也方便测) */
export function propose(gd: GameData, existing: Existing, now: Rates, keepRung: Rung | null, health: string[], zh: (n: string) => string) {
  const rung = keepRung ?? nextRung(now);
  const result = solvePlan(gd, planFor(rung, existing.tech));
  const ds = deltas(result, existing, gd);
  return { rung, deltas: ds, done: isDone(ds), reached: reached(rung, now), message: proposalMessage({ rung, now, deltas: ds, health, zh }) };
}
