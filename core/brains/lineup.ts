// 模型名和角色名 (库, 不直接运行): 游戏里 AI 角色的名字 = 模型名规范写法 (Claude-Opus、MiniMax-M3.1-Flash、Gpt-6.1-Terra), 同模型第 2 个起加 -2; 不标"中转"。
// 角色名规则 (我们放开后的 harness 规则): 字母开头, 字母数字 . _ -, 最多 32 个。
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const versionIn = (m: string): string | null => { const v = /(?:^|[-_ ])(\d{1,2})[-.](\d{1,2})(?![\d])/.exec(m); return v ? `${v[1]}.${v[2]}` : null; };

/** 模型名规范写法: 去掉供应商前缀 (volcengine/), 每一段 (按 - 分) 首字母大写, 其余照原样 */
export function prettyModel(model: string | undefined): string {
  const m = (model ?? "").trim().split("/").pop() ?? "";
  return m.split("-").map((seg) => (seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : seg)).join("-");
}

const VENDOR_GAME_NAME: Record<string, string> = { claude: "Claude", "claude-api": "Claude", grok: "Grok", deepseek: "Deepseek", codex: "Gpt", gemini: "Gemini", glm: "Glm", none: "Test", relay: "Relay" };
export const NAME_RULE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;

/** Claude 官方模型 id (claude-opus-5-5 / claude-fable-5-1…) → 家族和版本; 别名 (opus) 和别家的 → null */
export function claudeId(model: string | undefined): { family: string; version: string | null } | null {
  const m = (model ?? "").trim().toLowerCase();
  const full = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(m);
  if (full) return { family: full[1], version: `${full[2]}.${full[3]}` };
  if (/^(opus|sonnet|haiku|fable)$/.test(m)) return { family: m, version: null };
  return null;
}

/** 游戏里 AI 角色的名字 */
export function botName(brain: string | undefined, nth: number, model?: string): string {
  const b = (brain ?? "claude").trim().toLowerCase();
  const m = (model ?? "").trim();
  const cid = b === "claude" || b === "claude-api" ? claudeId(m) : null;
  const raw = !m || b === "none" ? VENDOR_GAME_NAME[b] ?? cap(b) : cid ? `Claude-${cap(cid.family)}${cid.version ? `-${cid.version}` : ""}` : prettyModel(m);
  const base = raw.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^[^A-Za-z]+/, "").replace(/-+$/, "").slice(0, 28) || "Ai";
  return nth <= 1 ? base : `${base}-${nth}`;
}

/** 界面上的名字 */
export function modelDisplayName(brain: string | undefined, model: string | undefined): string {
  const b = (brain ?? "claude").trim().toLowerCase();
  const m = (model ?? "").trim().toLowerCase();
  if (b === "claude" || m.startsWith("claude")) {
    const fam = ["opus", "sonnet", "haiku", "fable"].find((f) => m.includes(f));
    if (!fam) return m ? `Claude ${model!.trim()}` : "Claude Opus 5.5";
    return `Claude ${cap(fam)} ${versionIn(m) ?? "5.5"}`;
  }
  if (b === "none") return "不叫大脑 (测试班)";
  if (b === "grok" && !m) return "Grok 4.7";
  if (b === "codex" && !m) return "GPT (Codex)";
  if (b === "gemini" && !m) return "Gemini (Antigravity)";
  if (b === "relay" && !m) return "中转站";
  return m ? prettyModel(model) : cap(b);
}

/** 没给 --model 时各家的默认 */
export const DEFAULT_MODELS: Record<string, string> = { claude: "opus", "claude-api": "claude-opus-5-5", grok: "grok-4.7", deepseek: "deepseek-flash[1m]", codex: "gpt-6.1-sol", gemini: "" };
