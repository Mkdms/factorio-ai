// xAI Grok Build 命令行当大脑 (库, 不直接运行): 参数、环境、事件 → Claude Code stream-json 的形状。
// 本机 grok 1.0.70 探测: 参数和 Claude Code 同形 (-p 单轮、-s/-r 会话、--output-format streaming-json、--permission-mode dontAsk、--allow 规则); 事件 available_commands、thought、text (增量)、usage、
// tool_call (toolName / rawInput)、tool_call_update (status: pending / in_progress / completed / failed, content[].content.text)、end (stopReason、sessionId、usage、num_turns、total_cost_usd)。
// 不带 --add-dir (1.0.70 报 "additionalDirectories is not supported"), 共享目录靠 --allow 规则。它在 Windows 上用 PowerShell 跑命令, 所以角色目录里有 fh.ps1 / know.ps1。
// 隔离开关照 factorio-ai-party profile-flags.sh (关掉 Claude / Cursor 兼容的技能、规则、钩子、MCP、子代理、工作流)。
import { withGitBash } from "../run/shell.ts";
import type { Translator } from "./driver.ts";

export function grokEnv(e: NodeJS.ProcessEnv, web: boolean): NodeJS.ProcessEnv {
  return { ...withGitBash(e), GROK_CLAUDE_SKILLS_ENABLED: "false", GROK_CLAUDE_MCPS_ENABLED: "false", GROK_CLAUDE_RULES_ENABLED: "false", GROK_CLAUDE_HOOKS_ENABLED: "false", GROK_CLAUDE_AGENTS_ENABLED: "false", GROK_CURSOR_SKILLS_ENABLED: "false", GROK_CURSOR_RULES_ENABLED: "false", GROK_CURSOR_MCPS_ENABLED: "false", GROK_CURSOR_HOOKS_ENABLED: "false", GROK_CURSOR_AGENTS_ENABLED: "false", GROK_MANAGED_MCPS_ENABLED: "false", GROK_MEMORY_ENABLED: "false", GROK_MEMORY: "0", GROK_SUBAGENTS: "0", GROK_WORKFLOWS: "0", ...(web ? { GROK_WEB_FETCH: "1" } : {}) };
}

export type GrokArgsOpts = { n: number; sessionId: string; prompt: string; model: string; effort: string; /** Claude Code 形状的放行规则; 只取 Bash(...) 的, 另加反斜杠写法 */ allow: string[]; /** 多角色时全队共享的目录: 放行写它下面的 team.md 和 team-tools/ */ shared?: string; web: boolean };

export const GROK_RULES = "语言: 你输出的每一句话 (包括一两个词的短句、做事前后的小结)、笔记、team.md、游戏聊天都用简体中文; 工具回复是英文也照样用中文说。建筑、物品、科技用游戏官方中文名。你的终端是 PowerShell: 命令写 ./fh、./know (有 .ps1 包装), 不要用 sh、bash、循环或管道; 要循环就写成 Python 脚本。";

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

/** 怎么起: .env GROK_BIN, 默认 ~/.grok/bin/grok(.exe) */
export function grokBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GROK_BIN) return env.GROK_BIN;
  const home = env.USERPROFILE ?? env.HOME ?? "";
  return `${home}/.grok/bin/${process.platform === "win32" ? "grok.exe" : "grok"}`.replace(/\//g, process.platform === "win32" ? "\\" : "/");
}

// ---- 事件翻译 ----
export type GrokState = { text: string; thought: string; seq: number; usage: Record<string, number> | null; sessionId: string | null };
export const grokState = (): GrokState => ({ text: "", thought: "", seq: 0, usage: null, sessionId: null });

/** 工具名对照 (Grok → Claude) */
const TOOL_NAMES: Record<string, string> = { run_terminal_command: "Bash", read_file: "Read", write: "Write", search_replace: "Edit", grep: "Grep", list_dir: "Glob" };

function toolInput(name: string, raw: unknown): Record<string, unknown> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (name === "run_terminal_command") return { command: String(r.command ?? ""), ...(r.description ? { description: r.description } : {}) };
  if (name === "read_file") return { file_path: String(r.path ?? r.file_path ?? r.target_file ?? "") };
  if (name === "write") return { file_path: String(r.path ?? r.file_path ?? ""), content: r.content ?? r.contents ?? "" };
  if (name === "search_replace") return { file_path: String(r.path ?? r.file_path ?? ""), old_string: r.old_string ?? r.old ?? "", new_string: r.new_string ?? r.new ?? "" };
  if (name === "grep") return { pattern: String(r.pattern ?? r.query ?? ""), path: String(r.path ?? "") };
  if (name === "list_dir") return { path: String(r.path ?? "") };
  return r;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((c) => { const x = (c as { content?: { text?: unknown } }).content; return typeof x?.text === "string" ? x.text : ""; }).join("");
}

function flushText(s: GrokState, out: object[]) {
  if (!s.text.trim()) { s.text = ""; return; }
  out.push({ type: "assistant", message: { id: `grok-text-${++s.seq}`, role: "assistant", content: [{ type: "text", text: s.text }], usage: s.usage ?? {} } });
  s.text = "";
}

/** 一条 Grok 事件 → 0..n 条 Claude 形状的事件 */
export function normalizeGrokEvent(s: GrokState, ev: Record<string, unknown>): object[] {
  const out: object[] = [];
  switch (ev.type) {
    case "text": s.text += String(ev.data ?? ""); break;
    case "thought": s.thought += String(ev.data ?? ""); break;
    case "usage": if (ev.usage && typeof ev.usage === "object") s.usage = ev.usage as Record<string, number>; break;
    case "tool_call": {
      flushText(s, out);
      const name = String(ev.toolName ?? ev.title ?? "");
      out.push({ type: "assistant", message: { id: `grok-tool-${++s.seq}`, role: "assistant", content: [{ type: "tool_use", id: String(ev.toolCallId ?? `call-${s.seq}`), name: TOOL_NAMES[name] ?? name, input: toolInput(name, ev.rawInput) }], usage: s.usage ?? {} } });
      break;
    }
    case "tool_call_update": {
      const status = ev.status;
      if (status !== "completed" && status !== "failed") break;
      out.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: String(ev.toolCallId ?? ""), content: textOf(ev.content), is_error: status === "failed" }] } });
      break;
    }
    case "end": {
      flushText(s, out);
      const usage = (ev.usage && typeof ev.usage === "object" ? ev.usage : s.usage ?? {}) as Record<string, number>;
      const stop = String(ev.stopReason ?? "");
      if (typeof ev.sessionId === "string") s.sessionId = ev.sessionId;
      out.push({
        type: "result", subtype: stop === "end_turn" ? "success" : stop || "unknown", is_error: stop !== "end_turn" && stop !== "",
        session_id: ev.sessionId ?? null, num_turns: ev.num_turns ?? null, total_cost_usd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : 0,
        usage, duration_ms: ev.duration_ms ?? null, result: stop === "end_turn" ? "" : `grok stopReason=${stop}`,
      });
      break;
    }
    default: break;
  }
  return out;
}

/** 一行文本 (可能不是 JSON) → 事件; 非 JSON 行 (例 "permission required: …") 作为 system 事件留痕 */
export function normalizeGrokLine(s: GrokState, line: string): object[] {
  const t = line.trim();
  if (!t) return [];
  if (!t.startsWith("{")) return [{ type: "system", subtype: "grok_stderr", text: t }];
  try { return normalizeGrokEvent(s, JSON.parse(t)); } catch { return [{ type: "system", subtype: "grok_unparsed", text: t.slice(0, 400) }]; }
}

/** driver.ts 登记用的翻译器 (Grok 认我们给的会话号, 所以不换) */
export const grokTranslator = (): Translator => { const s = grokState(); return { line: (l) => normalizeGrokLine(s, l), sessionId: () => null }; };
