// Claude 走 Console 的 API 密钥 = Claude Agent SDK (库, 不直接运行).
// Agent SDK (@anthropic-ai/claude-agent-sdk 0.3.318, 2026-11-05 npm 最新) 就是 Claude Code 打包成的库: 同一套工具 / 钩子 / 会话 / 设置文件, 区别只是在代码里调 query() 并用 API 密钥计费。
// run.ts 的 claude-api 驱动起 `node src/play/agent-sdk-runner.ts <参数>`, 跑器把 query() 吐出的消息一行一个 JSON 写到标准输出 —— 形状就是 Claude Code 的 stream-json
// (system/init、assistant、user、result), 所以 onBrainLine、界面、统计都不用改。参数名照官方 TypeScript 文档 (code.claude.com/docs/en/agent-sdk/typescript, 2026-11-05 读):
// model / effort / cwd / resume / sessionId / permissionMode ("dontAsk") / allowedTools / tools / systemPrompt {preset claude_code, append} / settingSources / additionalDirectories / mcpServers / strictMcpConfig。
import { parseArgs } from "node:util";

export type RunnerArgs = {
  prompt: string; cwd: string; model: string; effort: string;
  /** 第 1 轮给 sessionId (我们生成的 UUID), 之后 resume 同一个 */
  sessionId?: string; resume?: string;
  allowedTools: string[]; tools: string[]; appendSystemPrompt: string; settingSources: string[]; addDirs: string[]; maxTurns?: number; permissionMode: string;
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** run.ts 的 Claude Code 参数 → 跑器参数 (和 ccArgs 一一对应: 第 1 轮 --session-id, 之后 --resume; 工具 / 放行 / 系统提示 / 设置来源相同) */
export function runnerArgs(o: { n: number; sessionId: string; prompt: string; model: string; effort: string; allow: string[]; tools: string[]; appendSystemPrompt: string; addDir?: string; maxTurns?: number }): string[] {
  const out = ["--prompt", o.prompt, "--model", o.model, "--effort", EFFORTS.includes(o.effort) ? o.effort : "medium", "--permission-mode", "dontAsk",
    "--tools", o.tools.join(","), "--setting-sources", "project,local", "--append-system-prompt", o.appendSystemPrompt];
  out.push(o.n === 1 ? "--session-id" : "--resume", o.sessionId);
  for (const a of o.allow) out.push("--allow", a);
  if (o.addDir) out.push("--add-dir", o.addDir);
  if (o.maxTurns) out.push("--max-turns", String(o.maxTurns));
  return out;
}

/** 跑器的命令行 → 结构 (cwd 默认当前目录) */
export function parseRunnerArgs(argv: string[]): RunnerArgs {
  const { values } = parseArgs({ args: argv, allowPositionals: false, options: {
    prompt: { type: "string" }, cwd: { type: "string" }, model: { type: "string", default: "claude-opus-5-5" }, effort: { type: "string", default: "medium" },
    "session-id": { type: "string" }, resume: { type: "string" }, allow: { type: "string", multiple: true, default: [] }, tools: { type: "string", default: "Bash,Read,Edit,Write,Grep,Glob" },
    "append-system-prompt": { type: "string", default: "" }, "setting-sources": { type: "string", default: "project,local" }, "add-dir": { type: "string", multiple: true, default: [] },
    "max-turns": { type: "string" }, "permission-mode": { type: "string", default: "dontAsk" },
  } });
  if (!values.prompt) throw new Error("--prompt 不能空");
  return {
    prompt: values.prompt, cwd: values.cwd ?? process.cwd(), model: values.model!, effort: EFFORTS.includes(values.effort!) ? values.effort! : "medium",
    sessionId: values["session-id"], resume: values.resume, allowedTools: values.allow as string[], tools: values.tools!.split(",").map((s) => s.trim()).filter(Boolean),
    appendSystemPrompt: values["append-system-prompt"]!, settingSources: values["setting-sources"]!.split(",").map((s) => s.trim()).filter(Boolean), addDirs: values["add-dir"] as string[],
    maxTurns: values["max-turns"] ? Number(values["max-turns"]) || undefined : undefined, permissionMode: values["permission-mode"]!,
  };
}

/** 跑器参数 → Agent SDK query() 的 options (纯函数, 测试用; 字段名照官方文档) */
export function sdkOptions(a: RunnerArgs, env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    cwd: a.cwd, env, model: a.model, effort: a.effort,
    ...(a.resume ? { resume: a.resume } : a.sessionId ? { sessionId: a.sessionId } : {}),
    permissionMode: a.permissionMode, allowedTools: a.allowedTools, tools: a.tools,
    systemPrompt: a.appendSystemPrompt ? { type: "preset", preset: "claude_code", append: a.appendSystemPrompt } : { type: "preset", preset: "claude_code" },
    settingSources: a.settingSources, ...(a.addDirs.length ? { additionalDirectories: a.addDirs } : {}), ...(a.maxTurns ? { maxTurns: a.maxTurns } : {}),
    mcpServers: {}, strictMcpConfig: true, includePartialMessages: false,
  };
}

/** Claude Code 连 Console 时的环境: 订阅登录相关的都去掉 (ccEnv 已做), 给 API 密钥; 用户级密钥 (sk-ant-usr) 要带工作区头 (本机实测 2026-11-05: 不带回 400 "not scoped to a workspace") */
export function consoleEnv(key: string, workspace?: string): NodeJS.ProcessEnv {
  return { ANTHROPIC_API_KEY: key, ...(workspace ? { ANTHROPIC_CUSTOM_HEADERS: `anthropic-workspace-id: ${workspace}` } : {}) };
}
