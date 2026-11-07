// 命令行参数走文件 (库): Grok Build 在 Windows 上用 PowerShell 跑命令, PowerShell 5.1 / cmd 把带引号的 JSON 参数 ('{"targets":…}') 传给原生程序时会拆坏
// (2026-11-04 实测: 经 .cmd 包装到脚本里变成 targets:automation-science-pack:30)。所以 .ps1 包装把 $args 原样写成 JSON 数组文件, 只把文件路径传给 node:
//   node commands/fh.ts --argv-file <文件> [固定参数…]   → 等于 node commands/fh.ts <文件里的参数…> [固定参数…]
import fs from "node:fs";

export function argvFromFile(argv: string[]): string[] {
  if (argv[0] !== "--argv-file" || !argv[1]) return argv;
  const file = argv[1];
  let fromFile: unknown;
  try { fromFile = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`--argv-file 读不了 ${file}: ${(e as Error).message}`); }
  try { fs.rmSync(file, { force: true }); } catch { /* 删不掉就留着 */ }
  if (!Array.isArray(fromFile)) throw new Error(`--argv-file ${file} 里不是数组`);
  return [...fromFile.map(argText), ...argv.slice(2)];
}

/** PowerShell 按类型传参: ./fh sleep 60 的 60 是数字, --near -25,20 的 -25,20 是数组, 写进 JSON 后不是字符串 (2026-11-05 新图班 Grok、Gpt 都撞上: "不是字符串数组", 只好给数字加引号); 还原成命令行上写的样子 */
export function argText(x: unknown): string {
  if (Array.isArray(x)) return x.map(argText).join(",");
  return typeof x === "string" ? x : String(x);
}
