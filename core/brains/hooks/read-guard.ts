// 大脑读文件的禁区 (库, 不直接运行; hooks/hook.ts 的 pre-read 用; 省 token):
// 旧项目的账本里有角色各读了一遍模组源码 (44k)、重读简报 (24k)、读命令行源码 (10k) —— 读进来就一直占着上下文, 每次请求都带。
// 规矩: 只读自己的目录 (和上一层, 多角色的 team.md 在那里); 仓库源码 / 模组 / 依赖 / 本机数据 (密钥在 data/accounts) 不给读 (大脑该用 ./fh help, 不该看实现);
// 大文件 (> 30KB) 不整读, 用 offset / limit 或 grep 找需要的段; 简报 AGENTS.md / CLAUDE.md 已在上下文里。
import fs from "node:fs";
import path from "node:path";

export const READ_MAX_BYTES = 30 * 1024;
/** 路径里带这些段就不给读 / 搜 (按 / 切开比对, 不区分大小写) */
const FORBIDDEN_SEGMENTS = new Set(["mods", "host", "vendor", "node_modules", ".git", "src", "dist", "lab-data", "game", "commands", "core", "training", "accounts", "test"]);
/** 角色目录里这些文件已经在它的系统提示 / 简报里, 不用再读 */
const IN_PROMPT = new Set(["agents.md", "claude.md"]);

export type ReadInput = { file_path?: string; path?: string; pattern?: string; offset?: number; limit?: number };

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\/([A-Za-z])(?=\/|$)/, "$1:").replace(/\/+$/, "").toLowerCase();
const isAbs = (p: string) => p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.startsWith("\\\\");

/** Read / Grep / Glob 调用该不该拦: 返回理由 (拦) 或 null (放行)。cwd = 角色目录 (给了就只许读它和上一层); sizeOf = 文件大小 (测试可换) */
export function readVerdict(tool: string, input: ReadInput | undefined, sizeOf: (p: string) => number | null = fileSize, cwd = ""): string | null {
  const target = String(input?.file_path ?? input?.path ?? "").replace(/\\/g, "/");
  if (!target) return null;
  const segs = target.toLowerCase().split("/").filter(Boolean);
  const hit = segs.find((s) => FORBIDDEN_SEGMENTS.has(s));
  if (hit) return `不读 ${hit}/ 下的东西 (模组 / 程序源码 / 本机数据不是给你看的, 读进来会占满上下文): 要查命令用 ./fh help <命令>, 要查游戏事实读 ref/ 或 ./know 关键词。`;
  if (cwd && isAbs(target)) {
    const home = norm(path.dirname(cwd));
    const t = norm(target);
    if (t !== home && !t.startsWith(home + "/")) return `只读你自己的目录 (和上一层) 里的文件, 不读 ${target}: 游戏事实用 ./know 关键词 或 ref/, 命令用 ./fh help。`;
  }
  if (tool === "Read") {
    const base = segs.at(-1) ?? "";
    if (IN_PROMPT.has(base)) return `${base} 已经在你的系统提示里, 不用再读 (读一次之后每次请求都带着)。`;
    const size = sizeOf(target);
    if (size !== null && size > READ_MAX_BYTES && input?.limit === undefined) return `这个文件 ${Math.round(size / 1024)}KB, 整读会占掉几万 token: 用 Read 的 offset / limit 只读需要的段, 或先 Grep 找行号。`;
  }
  return null;
}

function fileSize(p: string): number | null {
  try { return fs.statSync(p).size; } catch { return null; }
}
