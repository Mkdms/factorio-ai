// Grok Build 命令行的参数 (从 run.ts 提出来好测; 库, 不直接运行)。
// 2026-11-05 第一次多角色实跑: 本机 grok 1.0.70 对 --add-dir 报 "Couldn't create session: additionalDirectories is not supported: a session works only in its cwd",
// 第 1 轮 3 秒就退出 (之前只做过单角色的连通测试, 所以没撞上)。派对的 Grok 也不带 --add-dir: 共享目录靠 --allow 规则 (refs/factorio-ai-party tools/full_tools.py grok_args),
// 所以这里同样用规则放行上一层的 team.md / team-tools/; 只读共享目录不用规则。
import { withGitBash } from "./shell.ts";

/** 隔离开关照派对 profile-flags.sh: 关掉 Claude / Cursor 兼容的技能、规则、钩子、MCP、子代理、工作流 */
export function grokEnv(e: NodeJS.ProcessEnv, web: boolean): NodeJS.ProcessEnv {
  return { ...withGitBash(e), GROK_CLAUDE_SKILLS_ENABLED: "false", GROK_CLAUDE_MCPS_ENABLED: "false", GROK_CLAUDE_RULES_ENABLED: "false", GROK_CLAUDE_HOOKS_ENABLED: "false", GROK_CLAUDE_AGENTS_ENABLED: "false", GROK_CURSOR_SKILLS_ENABLED: "false", GROK_CURSOR_RULES_ENABLED: "false", GROK_CURSOR_MCPS_ENABLED: "false", GROK_CURSOR_HOOKS_ENABLED: "false", GROK_CURSOR_AGENTS_ENABLED: "false", GROK_MANAGED_MCPS_ENABLED: "false", GROK_MEMORY_ENABLED: "false", GROK_MEMORY: "0", GROK_SUBAGENTS: "0", GROK_WORKFLOWS: "0", ...(web ? { GROK_WEB_FETCH: "1" } : {}) };
}

export type GrokArgsOpts = {
  n: number;
  sessionId: string;
  prompt: string;
  model: string;
  effort: string;
  /** Claude Code 形状的放行规则; 只取 Bash(...) 的, 另加反斜杠写法 (Grok 在 Windows 上用 PowerShell) */
  allow: string[];
  /** 多角色时全队共享的目录 (大脑目录): 放行写它下面的 team.md 和 team-tools/ */
  shared?: string;
  /** 完整工具 (派对 POG_FULL_TOOLS): 开联网, 不开就 --disable-web-search */
  web: boolean;
};

export const GROK_RULES = "语言: 你输出的每一句话 (包括一两个词的短句、做事前后的小结)、笔记、team.md、游戏聊天都用简体中文; 工具回复是英文也照样用中文说。建筑、物品、科技用游戏官方中文名。你的终端是 PowerShell: 命令写 ./fh、./calc、./bp、./plan、./know、python (有 .ps1 包装), 不要用 sh、bash、循环或管道; 要循环就写成 Python 脚本。";

/** Windows 路径 → 规则里用的正斜杠写法 */
const fwd = (p: string) => p.replace(/\\/g, "/");

/** 放行写共享目录的规则: 相对写法 (../team.md) 和绝对写法都给 */
export function grokSharedAllow(shared: string): string[] {
  const abs = fwd(shared).replace(/\/+$/, "");
  const out: string[] = [];
  for (const tool of ["Edit", "Write"]) for (const p of ["../team.md", "../team-tools/**", `${abs}/team.md`, `${abs}/team-tools/**`]) out.push("--allow", `${tool}(${p})`);
  return out;
}

export function grokArgs(o: GrokArgsOpts): string[] {
  return ["-p", o.prompt, ...(o.n === 1 ? ["-s", o.sessionId] : ["-r", o.sessionId]),
    "--output-format", "streaming-json", "-m", o.model, "--reasoning-effort", o.effort,
    "--permission-mode", "dontAsk", "--no-subagents", ...(o.web ? [] : ["--disable-web-search"]),
    ...o.allow.filter((r) => r.startsWith("Bash(")).flatMap((r) => ["--allow", r, "--allow", r.replace("Bash(./", "Bash(.\\")]),
    "--allow", "Edit(./**)", "--allow", "Write(./**)",
    ...(o.shared ? grokSharedAllow(o.shared) : []),
    "--rules", GROK_RULES];
}
