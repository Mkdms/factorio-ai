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

/** 查的词是动作时, 能直接跑的命令 */
export function nextCommands(query: string, isAction: (term: string) => boolean = (t) => KNOWN_ACTIONS.includes(t)): string[] {
  const out: string[] = [];
  for (const term of query.split(/[\s,，、]+/).filter(Boolean)) if (isAction(term)) out.push(`./fh help ${term}`);
  return [...new Set(out)].slice(0, 4);
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
  const cmds = nextCommands(query);
  if (cmds.length) out.push(`能跑的: ${cmds.join("; ")}`);
  if (!hits.length) { console.log([...out, `没查到 "${query}"${page ? " 更多的了" : ""}。换官方中文名或内部名, 词少一点。`].join("\n")); return 0; }
  out.push(...hits.map((h) => knowLine(h)));
  const left = all.length - (page + 1) * PAGE;
  if (left > 0 && !page) out.push(`还有 ${left} 条: ./know ${query} --more`);
  console.log(out.join("\n"));
  return 0;
}

if ((import.meta as { main?: boolean }).main) process.exitCode = await main(argvFromFile(process.argv.slice(2)));
