#!/usr/bin/env node
// Claude Agent SDK 跑器 (脚本; driver.ts 的 claude-api 驱动起它): 参数见 agent-sdk.ts, 把 query() 的每条消息一行一个 JSON 写到标准输出 (= Claude Code 的 stream-json 形状);
// 退出码: result 成功 0, 出错 1。API 密钥等从环境变量来 (ANTHROPIC_API_KEY, 可带 ANTHROPIC_CUSTOM_HEADERS), 由驱动设好。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseRunnerArgs, sdkOptions } from "./agent-sdk.ts";

const a = parseRunnerArgs(process.argv.slice(2));
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
let code = 1, gotResult = false;
try {
  for await (const m of query({ prompt: a.prompt, options: sdkOptions(a, process.env) as any })) {
    out(m);
    if ((m as any).type === "result") { gotResult = true; code = (m as any).is_error ? 1 : 0; }
  }
} catch (e) {
  // SDK 在 result (is_error) 之后还会抛 "Claude Code returned an error result": 已经有 result 行就不再补一条
  if (!gotResult) out({ type: "result", subtype: "error", is_error: true, session_id: a.resume ?? a.sessionId ?? "", num_turns: 0, result: `Agent SDK 出错: ${(e as Error).message}` });
  code = 1;
}
process.exit(code);
