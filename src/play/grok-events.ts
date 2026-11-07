// Grok Build 命令行 (--output-format streaming-json) 的事件 → Claude Code stream-json 的形状 (库, 不直接运行)。
// 2026-11-04 本机 grok 1.0.70 探测到的事件: available_commands、thought、text (增量)、usage、tool_call (toolName / rawInput)、
// tool_call_update (status: pending / in_progress / completed / failed, content[].content.text)、end (stopReason、sessionId、usage、num_turns、total_cost_usd)。
// 翻成 assistant (text / tool_use)、user (tool_result)、result 三种, run.ts 的 onBrainLine、界面的对话流、统计 (knowledge-use) 就都不用改。
// 工具名对照 (Grok → Claude): run_terminal_command → Bash (input.command), read_file → Read (file_path), write → Write, search_replace → Edit, grep → Grep, list_dir → Glob。

export type GrokState = { text: string; thought: string; seq: number; usage: Record<string, number> | null };
export const grokState = (): GrokState => ({ text: "", thought: "", seq: 0, usage: null });

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

/** 把攒着的文字 (如果有) 作为一条 assistant 事件吐出来 */
function flushText(s: GrokState, out: object[]) {
  if (!s.text.trim()) { s.text = ""; return; }
  out.push({ type: "assistant", message: { id: `grok-text-${++s.seq}`, role: "assistant", content: [{ type: "text", text: s.text }], usage: s.usage ?? {} } });
  s.text = "";
}

/** 一行 Grok 事件 → 0..n 条 Claude 形状的事件 */
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
      if (status !== "completed" && status !== "failed") break; // pending / in_progress / null 是中间态
      out.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: String(ev.toolCallId ?? ""), content: textOf(ev.content), is_error: status === "failed" }] } });
      break;
    }
    case "end": {
      flushText(s, out);
      const usage = (ev.usage && typeof ev.usage === "object" ? ev.usage : s.usage ?? {}) as Record<string, number>;
      const stop = String(ev.stopReason ?? "");
      out.push({
        type: "result", subtype: stop === "end_turn" ? "success" : stop || "unknown", is_error: stop !== "end_turn" && stop !== "",
        session_id: ev.sessionId ?? null, num_turns: ev.num_turns ?? null, total_cost_usd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : 0,
        usage, duration_ms: ev.duration_ms ?? null, result: stop === "end_turn" ? "" : `grok stopReason=${stop}`,
      });
      break;
    }
    default: break; // available_commands 等
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
