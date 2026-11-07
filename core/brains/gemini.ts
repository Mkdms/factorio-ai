// Google Gemini 经 Antigravity 命令行 (agy) 当大脑 (库, 不直接运行): 参数、怎么起、事件 → Claude Code stream-json 的形状。
// 来历: 开源 Gemini CLI 2026-06-18 起个人账号不能 Google 登录, 官方让迁到 Antigravity。官方无界面文档 (antigravity.google/docs/cli/headless): `agy -p <提示> --output-format stream-json` 逐行 NDJSON:
//   {"event":"init","conversation_id","init":{cwd,tools,permission_mode,model?}} / {"event":"step_update","step_update":{conversation_id,step_index,state:"ACTIVE"|"DONE",step_type:"user_input"|"agent_response"|"tool"|"checkpoint",text_delta?,tool_name?,tool_info?:{name,parameters,output,error?},usage?}}
//   / {"event":"result","result":{conversation_id,status:"SUCCESS"|"ERROR"|…,response,error?,num_turns,usage}}。续会话 `--conversation <id>`; 自动批准 `--dangerously-skip-permissions`; `--model <slug>` (agy models 列); `--effort`。
// 本机 agy 1.5.0 实测: 一句探针回 "not eligible for Antigravity… not available in your location" (Google 账号的地区) → 搁置, 代码留着。
import fs from "node:fs";
import path from "node:path";
import { cleanCommand } from "./codex.ts";
import type { Translator } from "./driver.ts";

export type AgyState = { conversationId: string | null; seq: number; model: string; lastText: string; failed: string | null; texts: Map<number, string>; toolsOpen: Set<number> };
export const agyState = (model = ""): AgyState => ({ conversationId: null, seq: 0, model, lastText: "", failed: null, texts: new Map(), toolsOpen: new Set() });

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const first = (...xs: unknown[]): number => { for (const x of xs) if (typeof x === "number" && Number.isFinite(x)) return x; return 0; };

/** usage 对象 → Claude 形状 (字段名按文档和 Gemini API 的习惯兜底; 真样本只见过 input_tokens / output_tokens / thinking_tokens / cache_read_tokens / total_tokens) */
export function agyUsage(u: unknown): { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } {
  const r = (u && typeof u === "object" ? u : {}) as Record<string, unknown>;
  const output = first(r.output_tokens, r.completion_tokens, r.candidates_token_count, r.candidatesTokenCount, r.output);
  let input = first(r.input_tokens, r.prompt_tokens, r.prompt_token_count, r.promptTokenCount, r.input);
  if (!input) { const total = first(r.total_tokens, r.total_token_count, r.totalTokenCount); if (total) input = Math.max(0, total - output); }
  const cached = first(r.cache_read_input_tokens, r.cached_input_tokens, r.cached_content_token_count, r.cachedContentTokenCount, r.cache_read_tokens, r.cached_tokens);
  return { input_tokens: input, output_tokens: output, cache_read_input_tokens: cached, cache_creation_input_tokens: num(r.cache_creation_input_tokens) };
}

/** Antigravity 的工具名 → 记录认的名字 (Bash / Read / Edit / Write / Grep / Glob); 认不出照原名 */
export function agyToolName(name: unknown): string {
  const n = String(name ?? "").toLowerCase();
  if (!n) return "Tool";
  if (/command|shell|bash|terminal|exec/.test(n)) return "Bash";
  if (/edit|replace|patch/.test(n)) return "Edit";
  if (/write|create/.test(n)) return "Write";
  if (/read|view|cat/.test(n)) return "Read";
  if (/grep|search/.test(n)) return "Grep";
  if (/glob|find|list/.test(n)) return "Glob";
  return String(name);
}
export function agyToolInput(mapped: string, params: unknown): Record<string, unknown> {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => { for (const k of keys) if (typeof p[k] === "string" && (p[k] as string).trim()) return p[k] as string; return ""; };
  if (mapped === "Bash") return { command: cleanCommand(pick("command", "CommandLine", "commandLine", "cmd", "script") || JSON.stringify(p)) };
  if (mapped === "Read" || mapped === "Write" || mapped === "Edit") { const f = pick("file_path", "path", "TargetFile", "filePath", "AbsolutePath", "file"); return f ? { ...p, file_path: f } : p; }
  return p;
}

/** 一行原始输出 → 0..n 条 Claude 形状的事件 */
export function normalizeAgyLine(s: AgyState, line: string): object[] {
  const t = line.trim();
  if (!t.startsWith("{")) return [];
  let e: any;
  try { e = JSON.parse(t); } catch { return []; }
  const out: object[] = [];
  const id = () => `agy-${++s.seq}`;
  const sid = () => s.conversationId ?? "";
  const assistant = (content: object[], usage?: Record<string, number>) => ({ type: "assistant", message: { id: id(), role: "assistant", model: s.model, content, usage: usage ?? {} }, session_id: sid() });
  switch (e.event) {
    case "init": {
      if (typeof e.conversation_id === "string") s.conversationId = e.conversation_id;
      if (typeof e.init?.model === "string" && e.init.model) s.model = e.init.model;
      const tools: string[] = Array.isArray(e.init?.tools) ? e.init.tools.map(String) : ["Bash", "Read", "Edit", "Write"];
      out.push({ type: "system", subtype: "init", session_id: sid(), model: s.model, tools, source: "antigravity", permission_mode: e.init?.permission_mode });
      break;
    }
    case "step_update": {
      const su = e.step_update ?? {};
      if (typeof su.conversation_id === "string" && !s.conversationId) s.conversationId = su.conversation_id;
      const idx = typeof su.step_index === "number" ? su.step_index : -1;
      const done = su.state === "DONE";
      if (su.step_type === "agent_response") {
        if (typeof su.text_delta === "string" && su.text_delta) s.texts.set(idx, (s.texts.get(idx) ?? "") + su.text_delta);
        if (done) {
          const text = s.texts.get(idx) ?? "";
          s.texts.delete(idx);
          if (text.trim()) { s.lastText = text; out.push(assistant([{ type: "text", text }], su.usage ? agyUsage(su.usage) : undefined)); }
        }
      } else if (su.step_type === "tool") {
        const info = su.tool_info ?? {};
        const mapped = agyToolName(info.name ?? su.tool_name);
        const toolId = `agy-tool-${idx}`;
        if (!s.toolsOpen.has(idx)) { s.toolsOpen.add(idx); out.push(assistant([{ type: "tool_use", id: toolId, name: mapped, input: agyToolInput(mapped, info.parameters) }])); }
        if (done) {
          s.toolsOpen.delete(idx);
          const err = info.error && typeof info.error === "object" ? String(info.error.message ?? info.error.type ?? "出错") : typeof info.error === "string" ? info.error : "";
          const output = typeof info.output === "string" ? info.output : info.output === undefined || info.output === null ? "" : JSON.stringify(info.output);
          out.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: err ? `${output}${output && !output.endsWith("\n") ? "\n" : ""}(error: ${err})` : output, is_error: !!err }] }, session_id: sid() });
        }
      }
      break;
    }
    case "result": {
      const r = e.result ?? {};
      if (typeof r.conversation_id === "string" && !s.conversationId) s.conversationId = r.conversation_id;
      const status = String(r.status ?? "");
      const usage = agyUsage(r.usage);
      const response = typeof r.response === "string" ? r.response : "";
      if (status && status !== "SUCCESS") s.failed = typeof r.error === "string" ? r.error : r.error?.message ? String(r.error.message) : `Antigravity ${status}`;
      if (response.trim() && response.trim() !== s.lastText.trim()) { s.lastText = response; out.push(assistant([{ type: "text", text: response }])); }
      out.push(assistant([], usage));
      out.push({ type: "result", subtype: s.failed ? "error" : "success", is_error: !!s.failed, session_id: sid(), num_turns: num(r.num_turns) || 1, usage, total_cost_usd: 0, result: s.failed ?? response ?? s.lastText });
      break;
    }
    case "error": {
      const msg = String(e.error?.message ?? e.message ?? "Antigravity 出错");
      s.failed = msg;
      out.push({ type: "result", subtype: "error", is_error: true, session_id: sid(), num_turns: 1, result: msg });
      break;
    }
    default: break;
  }
  return out;
}

export const agyTranslator = (model: string): Translator => { const s = agyState(model); return { line: (l) => normalizeAgyLine(s, l), sessionId: () => s.conversationId }; };

/** 怎么起 agy: 安装器默认放 %LOCALAPPDATA%\agy\bin\agy.exe; .env AGY_BIN 可指定; 都没有就靠 PATH */
export function agyLauncher(env: NodeJS.ProcessEnv = process.env): { bin: string; args: string[] } {
  const cands = [env.AGY_BIN, env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe") : ""].filter((x): x is string => !!x);
  for (const c of cands) if (fs.existsSync(c)) return { bin: c, args: [] };
  return { bin: "agy", args: [] };
}

export const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const agyEffort = (e: string): string => (AGY_EFFORTS.includes(e) ? e : "medium");

/** `agy models` 的输出 (每行 "id<TAB>显示名") → 模型表; 没登录 / 出错 → [] */
export function parseAgyModels(out: string): { id: string; name: string }[] {
  const list: { id: string; name: string }[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][\w.\-/:]*)\t+(.+?)\s*$/.exec(line);
    if (m && !list.some((x) => x.id === m[1])) list.push({ id: m[1], name: m[2] });
  }
  return list;
}

/** agy 的参数: 无界面一句、逐行 JSON、自动批准, 模型 / 强度明确传; 第 2 轮起接同一个会话 */
export function agyArgs(o: { n: number; conversationId: string; prompt: string | undefined; model: string; effort: string }): string[] {
  return ["-p", o.prompt ?? "", "--output-format", "stream-json", "--dangerously-skip-permissions", ...(o.model ? ["--model", o.model] : []), "--effort", agyEffort(o.effort),
    ...(o.n > 1 && o.conversationId ? ["--conversation", o.conversationId] : [])];
}
