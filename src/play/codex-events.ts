// OpenAI Codex 命令行 (codex exec --json) 的事件 → Claude Code stream-json 的形状 (库, 不直接运行)。
// 2026-11-04 本机 codex-cli 0.166.0 试通 (ChatGPT 订阅登录), 抓到的事件:
//   thread.started {thread_id} → turn.started → item.completed {item: {type: agent_message, text}}
//   → item.started / item.completed {item: {type: command_execution, command, aggregated_output, exit_code, status}}
//   → turn.completed {usage: {input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}}
//   失败: turn.failed {error: {message}} / error {message}。命令在 Windows 上经 pwsh.exe -Command '…' 跑 (所以大脑目录里的 fh.ps1 / calc.ps1 / bp.ps1 能用)。
// 翻成 system/init、assistant (text / tool_use)、user (tool_result)、result, run.ts 的 onBrainLine、界面的对话流、统计 (knowledge-use) 就都不用改 (同 grok-events.ts)。
// 多轮: 第一轮的 thread_id 记在 state.threadId, run.ts 拿它当 sessionId, 下一轮 `codex exec resume <thread_id> <prompt>`。
import fs from "node:fs";
import path from "node:path";
import { compactAt } from "./context.ts";

export type CodexState = { threadId: string | null; seq: number; model: string; lastText: string; failed: string | null };
export const codexState = (model = ""): CodexState => ({ threadId: null, seq: 0, model, lastText: "", failed: null });

/** Codex 在 Windows 上把命令包成 "…pwsh.exe" -Command '…' (或 cmd.exe /c "…"): 给界面看的只留里面的命令 */
export function cleanCommand(cmd: unknown): string {
  const s = String(cmd ?? "").trim();
  const ps = /^"?[^"]*(?:pwsh|powershell)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-NonInteractive\s+)?-Command\s+'([\s\S]*)'$/i.exec(s);
  if (ps) return ps[1].replace(/''/g, "'");
  const ps2 = /^"?[^"]*(?:pwsh|powershell)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-NonInteractive\s+)?-Command\s+"([\s\S]*)"$/i.exec(s);
  if (ps2) return ps2[1].replace(/\\"/g, "\"");
  const cmdExe = /^"?[^"]*cmd(?:\.exe)?"?\s+\/[cC]\s+"?([\s\S]*?)"?$/i.exec(s);
  if (cmdExe) return cmdExe[1];
  const bash = /^(?:\/bin\/)?(?:bash|sh)\s+-lc\s+'([\s\S]*)'$/.exec(s);
  if (bash) return bash[1].replace(/'\\''/g, "'");
  return s;
}

/** 一行原始输出 → 0..n 条 Claude 形状的事件 */
export function normalizeCodexLine(s: CodexState, line: string): object[] {
  const t = line.trim();
  if (!t.startsWith("{")) return [];
  let e: any;
  try { e = JSON.parse(t); } catch { return []; }
  const out: object[] = [];
  const id = () => `codex-${++s.seq}`;
  const assistant = (content: object[], usage?: Record<string, number>) => ({ type: "assistant", message: { id: id(), role: "assistant", model: s.model, content, usage: usage ?? {} }, session_id: s.threadId ?? "" });
  switch (e.type) {
    case "thread.started":
      if (typeof e.thread_id === "string") s.threadId = e.thread_id;
      out.push({ type: "system", subtype: "init", session_id: s.threadId ?? "", model: s.model, tools: ["Bash", "Read", "Edit", "Write"], source: "codex" });
      break;
    case "item.started": case "item.completed": case "item.updated": {
      const it = e.item ?? {};
      if (it.type === "agent_message" && e.type === "item.completed" && typeof it.text === "string" && it.text.trim()) {
        s.lastText = it.text;
        out.push(assistant([{ type: "text", text: it.text }]));
      } else if (it.type === "command_execution") {
        if (e.type === "item.started") out.push(assistant([{ type: "tool_use", id: String(it.id ?? id()), name: "Bash", input: { command: cleanCommand(it.command) } }]));
        else if (e.type === "item.completed") {
          const code = typeof it.exit_code === "number" ? it.exit_code : it.status === "completed" ? 0 : 1;
          const text = String(it.aggregated_output ?? "");
          out.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: String(it.id ?? ""), content: code === 0 ? text : `${text}${text && !text.endsWith("\n") ? "\n" : ""}(exit ${code})`, is_error: code !== 0 }] }, session_id: s.threadId ?? "" });
        }
      } else if (it.type === "file_change" && e.type === "item.completed") {
        const files: string[] = Array.isArray(it.changes) ? it.changes.map((c: any) => String(c.path ?? "")).filter(Boolean) : [];
        out.push(assistant([{ type: "tool_use", id: String(it.id ?? id()), name: "Write", input: { file_path: files.join(", ") } }]));
      } else if (it.type === "error" && typeof it.message === "string") s.failed = it.message;
      break;
    }
    case "turn.completed": {
      const u = e.usage ?? {};
      const usage = { input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cache_read_input_tokens: num(u.cached_input_tokens), cache_creation_input_tokens: num(u.cache_write_input_tokens) };
      // 用量挂在一条空内容的 assistant 上 (run.ts onBrainLine 按 message.id 收用量; 空内容在界面里不显示)
      out.push(assistant([], usage));
      out.push({ type: "result", subtype: s.failed ? "error" : "success", is_error: !!s.failed, session_id: s.threadId ?? "", num_turns: 1, usage, total_cost_usd: 0, result: s.failed ?? s.lastText });
      break;
    }
    case "turn.failed": case "error": {
      const msg = String(e.error?.message ?? e.message ?? "Codex 出错");
      s.failed = msg;
      out.push({ type: "result", subtype: "error", is_error: true, session_id: s.threadId ?? "", num_turns: 1, result: msg });
      break;
    }
    default: break; // turn.started、reasoning 等不翻
  }
  return out;
}

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** 怎么起 Codex: npm 装的 codex.cmd 不能直接 spawn (要经 cmd.exe), 所以找它的 JS 入口用 node 跑; .env CODEX_JS 可指定; 找不到就靠 PATH 上的 codex (Linux / Mac) */
export function codexLauncher(env: NodeJS.ProcessEnv = process.env, nodeBin = process.execPath): { bin: string; args: string[] } {
  const cands = [env.CODEX_JS, env.APPDATA ? path.join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js") : "", env.npm_config_prefix ? path.join(env.npm_config_prefix, "node_modules", "@openai", "codex", "bin", "codex.js") : ""].filter((x): x is string => !!x);
  for (const c of cands) if (fs.existsSync(c)) return { bin: nodeBin, args: [c] };
  return { bin: env.CODEX_BIN ?? "codex", args: [] };
}

export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** codex exec 的参数 (2026-11-04 读 0.166.0 的 --help): --json 事件、-m 模型、-c model_reasoning_effort、workspace-write 沙箱 + 放开本机网络 (./fh 连 RCON)、
 *  不读用户 config.toml (桌面版的 MCP / 钩子会拖慢并报错) 和 .rules、不要求 git 仓库; 第 2 轮起 resume <thread_id> */
/** 自定义服务商 (中转站的 Responses 协议模型, 2026-11-04 czp: "去模型广场看看这些模型都是什么协议的" —— gpt 系列只认 Responses + 流式, Claude Code 发不了, Codex 发的正是这种):
 *  Codex 配置参考 (learn.chatgpt.com/docs/config-file/config-reference, 2026-11-04 读): model_providers.<id> 的 base_url / env_key / wire_api (只有 responses); 用 -c 覆盖, 令牌经环境变量 (envKey) 给, 不进命令行 */
export type CodexProvider = { id: string; baseUrl: string; envKey: string };
export const codexProviderArgs = (p: CodexProvider): string[] => ["-c", `model_provider="${p.id}"`, "-c", `model_providers.${p.id}.name="${p.id}"`, "-c", `model_providers.${p.id}.base_url="${p.baseUrl}"`,
  "-c", `model_providers.${p.id}.env_key="${p.envKey}"`, "-c", `model_providers.${p.id}.wire_api="responses"`];

export function codexExecArgs(o: { n: number; threadId: string; prompt: string | undefined; model: string; effort: string; addDir?: string; provider?: CodexProvider }): string[] {
  // 沙箱 / 审批 (2026-11-05 真跑班次 18-40-18, C = gpt-6.1-terra 整班 0 条命令): Windows 无界面下 Codex 给模型的环境说明是"文件系统只读" (第 1 轮带 -s workspace-write 也一样,
  // resume 轮没有 -s 更是), 模型一条命令都没试就说"安全策略拒绝"。Codex 角色在本机沙盘里给完全访问 (sandbox_mode=danger-full-access + approval_policy=never,
  // 每轮都用 -c 显式给, resume 也认 -c), 和 Claude 角色一样信任它在大脑目录里跑命令; 区别是 Codex 没有我们给 Claude 的命令白名单钩子 (permit.ts), **联机 (M7) 前要补**。
  // 压缩点 (班次 10-16-30 量 Codex 会话记录: 窗口 47.5 万, 79 分钟 0 次压缩, 上下文涨到 41 万, 200 次请求合计 3950 万输入 token, 别的角色每次 6~8 万):
  // 给 Claude Code 的 compactAt 从来没给过 Codex。--ignore-user-config 下每轮用 -c 给; 官方配置文档 (learn.chatgpt.com/docs/config-file/config-reference, 2026-11-05 读): "Token threshold that triggers automatic history compaction", 默认 scope = total; 0.166.0 二进制里有这个键, 真压不压下一班看
  const common = ["--json", ...(o.model ? ["-m", o.model] : []), "-c", `model_auto_compact_token_limit=${compactAt(o.model)}`, "-c", `model_reasoning_effort="${CODEX_EFFORTS.includes(o.effort) ? o.effort : "medium"}"`,
    "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", ...(o.provider ? codexProviderArgs(o.provider) : [])];
  const prompt = o.prompt ?? "-";
  // resume 没有 --add-dir (可写目录跟着第一轮的线程走; 0.166.0 的 resume --help 只有 -c / -m / --json 等)
  return o.n === 1 ? ["exec", ...common, ...(o.addDir ? ["--add-dir", o.addDir] : []), prompt] : ["exec", "resume", ...common, o.threadId, prompt];
}
