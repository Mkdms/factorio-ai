// 一班的角色阵容 (库; run.ts 用): 哪个角色用哪个大脑、哪个模型、游戏里叫什么。
//  → 一班里几个模型一起玩 (派对的做法), 不再全班一个 --brain。
// 2026-11-04 加 relay (中转站, New API): 大脑还是 Claude Code, 模型是站里的; 模型按角色分:
// --brains 里每一项可以写 家:模型 (claude:sonnet, relay:glm-5.3, deepseek:deepseek-v4-pro), 账号页的"下一班阵容"就是这么存的 (src/play/roster.ts)。
import { botName } from "./model-name.ts";

/** claude-api = Claude 走 Console 的 API 密钥 (Agent SDK); claude = 订阅登录的 Claude Code */
export const KNOWN_BRAINS = ["claude", "claude-api", "grok", "deepseek", "relay", "codex", "gemini", "none"];
/** 一班最多几个角色: 角色 id 用一个小写字母 (a~z), 所以 26; 真正的上限是机器 (一个角色一个大脑进程) 和服务器位子 (沙盘 max_players 不限)。
 *   (派对 9 个模型一起跑) */
export const MAX_AGENTS = 26;
/** 没指定模型时各家的默认: Claude 走 opus (原默认); Grok 用派对 11 月在用的 grok-4.7; DeepSeek 用官方推荐的 deepseek-flash[1m] (要 v4-pro 就 --model deepseek-v4-pro);
 *  relay 没有固定默认 (站里选的模型由 run.ts 从 keys.json 读进 defaults, 或 --brains 里写 relay:模型名) */
/** codex = OpenAI GPT (ChatGPT 订阅, Codex 命令行): 默认用本机 ~/.codex/config.toml 里的 model (2026-11-04 本机是 gpt-6.1-sol; 账号页会读出来), 这里的只是没读到时的兜底 */
/** gemini = Google Gemini (Google AI Pro 订阅, Antigravity CLI agy): 默认不传 --model, 用账号的默认模型 (游戏名就叫 Gemini); 选了具体模型 (agy models 列的) 才按模型名 */
export const DEFAULT_MODELS: Record<string, string> = { "claude-api": "claude-opus-5-5", grok: "grok-4.7", deepseek: "deepseek-flash[1m]", codex: "gpt-6.1-sol", gemini: "" };

export type Seat = { brain: string; model: string; who: number | string; /** 思考强度 (空 = run.ts --effort 默认) */ effort?: string };

/** --brains 的一项: "relay:glm-5.3@high" → {brain: relay, model: glm-5.3, effort: high}; "grok" → {brain: grok}; 强度用 @ 接在最后 (模型名里没有 @) */
export function parseBrainEntry(s: string): { brain: string; model?: string; effort?: string } {
  const at = s.lastIndexOf("@");
  const effort = at >= 0 ? s.slice(at + 1).trim().toLowerCase() : "";
  const body = at >= 0 ? s.slice(0, at) : s;
  const i = body.indexOf(":");
  const brain = (i < 0 ? body : body.slice(0, i)).trim().toLowerCase();
  const model = i < 0 ? "" : body.slice(i + 1).trim();
  return { brain, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/**
 * --brains claude,grok,deepseek = 一个角色一个大脑 (个数就是角色数; 每项可带模型 家:模型); 不给就 --agents 个角色都用 --brain。
 * --model 只给主大脑 (--brain 那家), 其他家用各自的默认 (defaults, 默认 DEFAULT_MODELS)。第 1 个角色是连着窗口的玩家 (用户自己的账号, 名字不改),
 * 其余是服务器角色, 名字 = 模型名 (中转站按模型开头的厂商词; 同名第 2 个起 -2, 不管它是哪家接的)。
 * allBots = 第 1 个也是服务器角色 (沙盘派对配置); 联机用户的账号由 AI 操控时才要第 1 个是玩家。
 */
export function lineup(opts: { brain: string; model: string; brains?: string; agents?: string; allBots?: boolean }, defaults: Record<string, string> = DEFAULT_MODELS): Seat[] {
  const list = opts.brains ? opts.brains.split(",").map((s) => s.trim()).filter(Boolean).map(parseBrainEntry) : [];
  for (const e of list) if (!KNOWN_BRAINS.includes(e.brain)) throw new Error(`--brains 里不认识 ${e.brain} (可用: ${KNOWN_BRAINS.join(" / ")}; 带模型写 家:模型, 例 relay:glm-5.3)`);
  if (list.length > MAX_AGENTS) throw new Error(`最多 ${MAX_AGENTS} 个角色 (角色 id 一个字母)`);
  if (list.length && opts.agents && opts.agents !== "1" && Number(opts.agents) !== list.length) throw new Error("--brains 的个数就是角色数, 别再给 --agents");
  const n = Math.max(1, Math.min(MAX_AGENTS, list.length || (Number(opts.agents) || 1)));
  const primary = opts.brain.trim().toLowerCase();
  if (!KNOWN_BRAINS.includes(primary)) throw new Error(`--brain 不认识 ${primary} (可用: ${KNOWN_BRAINS.join(" / ")})`);
  const primaryModel = opts.model === "opus" && defaults[primary] ? defaults[primary] : opts.model;
  const out: Seat[] = [];
  for (let i = 0; i < n; i++) {
    const brain = list[i]?.brain ?? primary;
    const model = list[i]?.model ?? (brain === primary ? primaryModel : brain in defaults ? defaults[brain] : "opus");
    if (brain === "relay" && (!model || model === "opus")) throw new Error("中转站 (relay) 没选模型: 在界面 账号 · 设置 的下一班阵容里给这个角色选一个, 或者 --brains 里写 relay:<站里的模型名>");
    const base = botName(brain, 1, model);
    const nth = (opts.allBots ? out : out.slice(1)).filter((s) => botName(s.brain, 1, s.model) === base).length + 1;
    out.push({ brain, model, who: i === 0 && !opts.allBots ? 1 : botName(brain, nth, model), ...(list[i]?.effort ? { effort: list[i].effort } : {}) });
  }
  return out;
}
