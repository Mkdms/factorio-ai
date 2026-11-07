// Claude Code 命令行当大脑 (库, 不直接运行; core/brains/driver.ts 用)。
// 订阅登录 (claude login); DeepSeek / 中转站走同一条命令行, 只换接口地址和令牌 (ccEndpoint; 第二块第 ③ 步接上)。
// 参数照 Claude Code 2.1.319 (本机 2026-11-07): -p 非交互; --output-format stream-json 一行一个 JSON 事件; 第 1 轮 --session-id, 之后 --resume 接着同一个会话;
// --setting-sources project,local 只读角色目录的 .claude/settings.json (钩子、压缩点在那里); --permission-mode dontAsk 不问人, 不在白名单的直接拒 (钩子 hooks/permit.ts 再放行循环 / 管道)。

export type CcOpts = { model: string; effort: string; allow: string[]; tools: string[]; system: string };

export const claudeBin = (env: NodeJS.ProcessEnv = process.env): string => env.CLAUDE_BIN ?? "claude";

/** 一轮的参数: n = 第几轮, sessionId = 会话号 (第 1 轮新建, 之后接着), prompt = 这一轮的提示词 */
export function ccArgs(o: CcOpts): (n: number, sessionId: string, prompt: string) => string[] {
  return (n, sessionId, prompt) => [
    "-p", prompt,
    ...(n === 1 ? ["--session-id", sessionId] : ["--resume", sessionId]),
    "--output-format", "stream-json", "--verbose",
    "--model", o.model, "--effort", o.effort,
    "--setting-sources", "project,local",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--no-chrome", "--disable-slash-commands",
    "--tools", o.tools.join(","),
    "--allowedTools", ...o.allow,
    "--permission-mode", "dontAsk",
    "--append-system-prompt", o.system,
  ];
}

/** 子进程的环境: 去掉开发会话继承来的 ANTHROPIC_* / CLAUDE_CODE_* (大脑走自己的登录; 别家再加接口地址和密钥), 关掉 claude.ai 的 MCP、CFC、git 说明 */
export const ccEnv = (e: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = { ...e };
  for (const k of Object.keys(env)) if (k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") delete env[k];
  return { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_ENABLE_CFC: "false", CLAUDE_CODE_SILENT_TURN_REMINDER: "0", CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1" };
};

/** Claude Code 指向 Anthropic 兼容接口 (DeepSeek 官方 / New API 中转站): 所有档位都用同一个模型名 (站里没有 opus / sonnet / haiku 这种名字) */
export const ccEndpoint = (baseUrl: string, token: string, model: string, small = model, opts: { effort?: boolean } = {}): NodeJS.ProcessEnv => ({
  ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: small, CLAUDE_CODE_SUBAGENT_MODEL: small,
  // 官方 network-config "Streaming idle watchdogs" (2026-11-05 读): 经自定义 ANTHROPIC_BASE_URL 时字节级看门狗默认 300 秒; 实跑里别家接口停过约 5 分钟, 角色一直站着 → 120 秒 (范围 10 秒~30 分钟; 思考时 token 一直在流, 不会误触)
  CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "120000",
  // 官方 env-vars (同日读): 模型 ID Claude Code 不认识时默认不发 effort, 这个变量让它照发; 接口不收时去掉 (effort: false)
  ...(opts.effort === false ? {} : { CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1" }),
});
