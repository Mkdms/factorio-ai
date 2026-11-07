// Claude Code 子进程的环境 (库, 不直接运行; 从 run.ts 搬出来给 control.ts 的中转站核实共用, 2026-11-04)。
/** 去掉开发会话继承来的 ANTHROPIC_* / CLAUDE_CODE_* (claude 走订阅登录; 别家再自己加接口地址和密钥), 关掉 claude.ai 的 MCP、CFC 等 */
export const ccEnv = (e: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = { ...e };
  for (const k of Object.keys(env)) if (k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") delete env[k];
  return { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_ENABLE_CFC: "false", CLAUDE_CODE_SILENT_TURN_REMINDER: "0", CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1" };
};
/** Claude Code 指向 Anthropic 兼容接口 (DeepSeek 官方 / New API 中转站): 所有档位都用同一个模型名 (站里没有 opus / sonnet / haiku 这种名字) */
export const ccEndpoint = (baseUrl: string, token: string, model: string, small = model, opts: { effort?: boolean } = {}): NodeJS.ProcessEnv => ({
  ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: small, CLAUDE_CODE_SUBAGENT_MODEL: small,
  // 官方 network-config "Streaming idle watchdogs" (2026-11-05 读): 经自定义 ANTHROPIC_BASE_URL 时字节级看门狗默认 300 秒, 没字节才中断重试;
  // 2026-11-05 新图班 Glm、Deepseek 各停过约 5 分钟, 角色一直站着 → 120 秒。范围 10 秒~30 分钟。思考时 token 一直在流, 正常想事情不会触发
  CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "120000",
  // 官方 env-vars (同日读): 模型 ID Claude Code 不认识时默认不发 effort, 这个变量让它照发; 于是 --effort low 对 Glm / Deepseek 才可能生效。
  // 接口收不收要看试通, 不收时 run.ts 给这个模型去掉 (effort: false)。对方照不照做要看下一班每次请求的思考 token
  ...(opts.effort === false ? {} : { CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1" }),
});
