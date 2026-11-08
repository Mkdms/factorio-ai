#!/usr/bin/env node
// ./know 关键词: 一条命令查全部积累 (老玩家思路、核实过的事实、要点、教训、检索资料), 所有模型都能用; 工具回复自动附的经验也走同一套 (core/run/knowledge.ts)。
// 环境变量 (角色目录的包装脚本给): FH_PROTO 游戏导出的名单目录 (官方中文名和内部名互查), FH_TRAINING 训练集根 (没给用仓库里的)。
import fs from "node:fs";
import { argvFromFile } from "./argv-file.ts";
import { loadZhNames } from "./chattags.ts";
import { knowLine, loadKnowledge, searchKnowledge } from "../core/run/knowledge.ts";
import { KNOWN_ACTIONS } from "../core/run/lessons.ts";

/** 一屏几条 (加能跑的那行和"还有 N 条"最多 8 行; 一条最多约 280 字) */
const PAGE = 6;

/**
 * 查的词是动作或物品时, 能直接跑的命令 (第二版 src/play/know.ts nextCommands; 搬家时只留了动作那半):
 * 动作 → ./fh help 动作; 物品 → ./plan 物品 每分钟 (加 --build 直接放)、库里有块就 ./bp list 物品、./bp study 物品。依赖给函数, 测试给假的
 */
export function nextCommands(query: string, d: { isAction?: (term: string) => boolean; item?: (term: string) => string | null; hasBlock?: (name: string) => boolean } = {}): string[] {
  const isAction = d.isAction ?? ((t: string) => KNOWN_ACTIONS.includes(t));
  const out: string[] = [];
  for (const term of query.split(/[\s,，、]+/).filter(Boolean)) {
    if (isAction(term)) { out.push(`./fh help ${term}`); continue; }
    const item = d.item?.(term);
    if (!item) continue;
    // 联机没有 ./plan ./bp build
    if (!process.env.FH_ONLINE) {
      out.push(`./plan ${item} 每分钟 (加 --build 直接放)`);
      if (d.hasBlock?.(item)) out.push(`./bp list ${item}`);
    }
    out.push(`./bp study ${item}`);
    break; // 一个物品够了, 答案要短
  }
  return [...new Set(out)].slice(0, 4);
}

/** 动作名单: 教训库认的 + 角色目录 describe.json 里的 (装模组那条路有; 新动作 pole_route / belt_route 这类教训库清单里没有) */
function actionNames(): Set<string> {
  const s = new Set<string>(KNOWN_ACTIONS);
  try { for (const m of fs.readFileSync("describe.json", "utf8").matchAll(/^\s{4}"([a-z_]+)": \{"name"/gm)) s.add(m[1]); } catch { /* 没有 describe.json */ }
  return s;
}

export async function main(argv: string[]): Promise<number> {
  if (process.env.FH_TRAINING && !process.env.TRAINING_DIR) process.env.TRAINING_DIR = process.env.FH_TRAINING;
  const query = argv.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!query) {
    const all = loadKnowledge();
    const by: Record<string, number> = {};
    for (const it of all) by[it.source] = (by[it.source] ?? 0) + 1;
    console.log(`用法: ./know 关键词 [关键词…] (官方中文名或内部名都行, 例: ./know 研究中心, ./know 地下管道 方向)。现在能查 ${all.length} 条: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join("、")}。思路全文: ./fh help pattern-production 等 (./fh help 列全部主题)。`);
    return 0;
  }
  let names = new Map<string, string>();
  try { names = loadZhNames(process.env.FH_PROTO ?? ""); } catch { /* 没有名单: 只按原词查 */ }
  const page = argv.includes("--more") ? 1 : 0;
  const all = searchKnowledge(loadKnowledge(), query, names, 30);
  const hits = all.slice(page * PAGE, (page + 1) * PAGE);
  try { fs.appendFileSync(".know.log", `${Math.floor(Date.now() / 1000)} ${query}\n`); } catch { /* 不在角色目录 */ }
  const out: string[] = [];
  // 能跑的命令放最前面: 模型要的是下一步; 游戏数据、蓝图库读不了也不影响查经验
  let cmds: string[] = [];
  try {
    const [{ loadGameData }, { recipeFor, resolveItem }, { listLines }] = await Promise.all([import("../src/calc/data.ts"), import("../src/play/plan-lib.ts"), import("../src/play/bp.ts")]);
    const gd = loadGameData();
    const actions = actionNames();
    cmds = nextCommands(query, { isAction: (t) => actions.has(t), item: (t) => { const id = resolveItem(t, names, (x) => recipeFor(gd, x) !== null); return id ? names.get(id) ?? id : null; }, hasBlock: (n) => listLines(n, 1).length > 0 });
  } catch { cmds = nextCommands(query); }
  if (cmds.length) out.push(`能跑的: ${cmds.join("; ")}`);
  if (!hits.length) { console.log([...out, `没查到 "${query}"${page ? " 更多的了" : ""}。换官方中文名或内部名, 词少一点。`].join("\n")); return 0; }
  out.push(...hits.map((h) => knowLine(h)));
  const left = all.length - (page + 1) * PAGE;
  if (left > 0 && !page) out.push(`还有 ${left} 条: ./know ${query} --more`);
  console.log(out.join("\n"));
  return 0;
}

if ((import.meta as { main?: boolean }).main) process.exitCode = await main(argvFromFile(process.argv.slice(2)));
