// OpenAI Codex 命令行 (codex exec --json) 当大脑 (库, 不直接运行): 参数、怎么起、事件 → Claude Code stream-json 的形状。
// 本机 codex-cli 0.166.0 试通 (ChatGPT 订阅登录) 抓到的事件: thread.started {thread_id} → turn.started → item.completed {item: {type: agent_message, text}}
//   → item.started / item.completed {item: {type: command_execution, command, aggregated_output, exit_code, status}} → turn.completed {usage: {…}}; 失败: turn.failed {error: {message}} / error {message}。
// 命令在 Windows 上经 pwsh.exe -Command '…' 跑 (角色目录里的 fh.ps1 / know.ps1 能用)。多轮: 第一轮的 thread_id 当会话号, 之后 `codex exec resume <thread_id> <prompt>`。
// 旧项目真跑 (2026-11-05): Windows 无界面下 Codex 给模型的环境说明是"文件系统只读", 模型一条命令都没试 → 沙盘里给完全访问 (sandbox_mode=danger-full-access + approval_policy=never, 每轮显式给);
// Codex 没有我们给 Claude 的命令白名单钩子 (permit.ts), 所以只能用在本机的图上 (driver.ts noAllowList)。
import fs from "node:fs";
import path from "node:path";
import { compactAt } from "./hooks/context.ts";
import type { Translator } from "./driver.ts";

export type CodexState = { threadId: string | null; seq: number; model: string; lastText: string; failed: string | null };
export const codexState = (model = ""): CodexState => ({ threadId: null, seq: 0, model, lastText: "", failed: null });

/** Codex 在 Windows 上把命令包成 "…pwsh.exe" -Command '…' (或 cmd.exe /c "…"): 给人看的只留里面的命令 */
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

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

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
      out.push(assistant([], usage)); // 用量挂在一条空内容的 assistant 上
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

/** driver.ts 登记用的翻译器 */
export const codexTranslator = (model: string): Translator => { const s = codexState(model); return { line: (l) => normalizeCodexLine(s, l), sessionId: () => s.threadId }; };

/** 怎么起 Codex: npm 装的 codex.cmd 不能直接 spawn (要经 cmd.exe), 所以找它的 JS 入口用 node 跑; .env CODEX_JS 可指定; 找不到就靠 PATH 上的 codex */
export function codexLauncher(env: NodeJS.ProcessEnv = process.env, nodeBin = process.execPath): { bin: string; args: string[] } {
  const cands = [env.CODEX_JS, env.APPDATA ? path.join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js") : "", env.npm_config_prefix ? path.join(env.npm_config_prefix, "node_modules", "@openai", "codex", "bin", "codex.js") : ""].filter((x): x is string => !!x);
  for (const c of cands) if (fs.existsSync(c)) return { bin: nodeBin, args: [c] };
  return { bin: env.CODEX_BIN ?? "codex", args: [] };
}

export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** 自定义服务商 (中转站的 Responses 协议模型): Codex 配置 model_providers.<id> 的 base_url / env_key / wire_api (只有 responses); 用 -c 覆盖, 令牌经环境变量给, 不进命令行 */
export type CodexProvider = { id: string; baseUrl: string; envKey: string };
export const codexProviderArgs = (p: CodexProvider): string[] => ["-c", `model_provider="${p.id}"`, "-c", `model_providers.${p.id}.name="${p.id}"`, "-c", `model_providers.${p.id}.base_url="${p.baseUrl}"`,
  "-c", `model_providers.${p.id}.env_key="${p.envKey}"`, "-c", `model_providers.${p.id}.wire_api="responses"`];

/** codex exec 的参数: --json 事件、-m 模型、-c model_reasoning_effort、完全访问 + 不审批 (沙盘里)、不读用户 config.toml 和 .rules、不要求 git 仓库、压缩点 (model_auto_compact_token_limit); 第 2 轮起 resume <thread_id> */
export function codexExecArgs(o: { n: number; threadId: string; prompt: string | undefined; model: string; effort: string; addDir?: string; provider?: CodexProvider }): string[] {
  const common = ["--json", ...(o.model ? ["-m", o.model] : []), "-c", `model_auto_compact_token_limit=${compactAt(o.model)}`, "-c", `model_reasoning_effort="${CODEX_EFFORTS.includes(o.effort) ? o.effort : "medium"}"`,
    "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", ...(o.provider ? codexProviderArgs(o.provider) : [])];
  const prompt = o.prompt ?? "-";
  // resume 没有 --add-dir (可写目录跟着第一轮的线程走)
  return o.n === 1 ? ["exec", ...common, ...(o.addDir ? ["--add-dir", o.addDir] : []), prompt] : ["exec", "resume", ...common, o.threadId, prompt];
}
