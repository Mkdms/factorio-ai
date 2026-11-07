// 账号页 (库, 不直接运行; src/play/control.ts 的 GET /api/accounts、POST /api/login 用): 三家命令行 (Claude Code / Grok Build / Codex)
// 装没装、登没登录、订阅剩多少额度; 登录 = 开一个看得见的命令行窗口跑各家自己的登录命令 (浏览器里登, 我们不经手密码)。
// 做法照 OpenMausBot (Apache-2.0, 见 NOTICE; 提交 9649348):
//   server/drivers/claude-auth-status.ts — claude auth status --json 的 loggedIn
//   server/drivers/codex-device-auth.ts  — codex login status: 退出码 0 + "Logged in" 算登了, 非 0 + "Not logged in" 算没登
//   server/drivers/acp/grok.ts           — grok 没有查状态的命令: 有 <GROK_HOME 或 ~/.grok>/auth.json 就算登了
//   server/plan-usage.ts                 — 用量接口: Codex GET chatgpt.com/backend-api/wham/usage (令牌和账号 id 在 <CODEX_HOME 或 ~/.codex>/auth.json);
//                                          Grok GET cli-chat-proxy.grok.com/v1/billing?format=credits、/v1/billing、/v1/settings (令牌在 auth.json 各项的 key)
// Grok 官方 Windows 安装 (2026-11-03 读过 https://x.ai/cli/install.ps1 本身, 没运行): 装到 ~/.grok/bin/grok.exe 并加进用户 PATH, grok login 写 ~/.grok/auth.json。
// 这些用量接口都没公开, 随时可能变: 读不到就写原因, 不猜。令牌只放进请求头, 不打印、不写文件、不回给界面; 邮箱也不回 (界面截图会进仓库)。
//
// DeepSeek、GLM: 没有登录, 只有 API 密钥; 两家官方都给了 Anthropic 兼容接口, 大脑是 Claude Code
// 换接口地址 (还没接)。密钥存本机 <lab-data>/accounts/keys.json (不进仓库, 明文, 和各家命令行自己存登录文件一样; 用户没要凭据管理器)。
//   DeepSeek: GET https://api.deepseek.com/user/balance, Authorization: Bearer <密钥> → {is_available, balance_infos: [{currency, total_balance,
//             granted_balance, topped_up_balance}]} (官方文档 api-docs.deepseek.com/api/get-user-balance, 2026-11-03 读); 密钥在 platform.deepseek.com/api_keys
//   GLM 编程套餐: GET https://open.bigmodel.cn/api/monitor/usage/quota/limit (国际版 api.z.ai 同路径), Authorization: <密钥> (不带 Bearer) →
//             {data: {limits: [{type: "TOKENS_LIMIT" (5 小时 token), percentage}, {type: "TIME_LIMIT" (MCP 每月), percentage, currentValue, usage}]}}
//             (照智谱官方 Claude Code 插件 glm-plan-usage 0.0.1 的 query-usage.mjs; 文档没写, 没对真账号核过); 密钥在 bigmodel.cn/apikey/coding-plan-per
//
// 中转站 (relay): 大脑还是 Claude Code, 只换接口地址和令牌 ——
//   ANTHROPIC_BASE_URL = 站点根地址 (不带 /v1), ANTHROPIC_AUTH_TOKEN = 站里建的令牌 (New API 官方文档 docs.newapi.ai/en/docs/apps/claude-code 的一键脚本
//   helper/claude-cli-setup.ps1 只设这两个变量, 2026-11-04 读; Claude Code 官方 code.claude.com/docs/en/llm-gateway: 有网关凭据时请求带它、不再用订阅登录),
//   模型名用站里的 (ANTHROPIC_MODEL)。keys.json 存 relay (令牌)、relay_url (站点)、relay_model (选的模型)。
//   查: GET <站>/v1/models (Bearer 令牌 → 这个令牌能用的模型; New API README 2026-11-04 读); 余额: GET <站>/dashboard/billing/subscription → hard_limit_usd (剩余, 美元),
//   /dashboard/billing/usage → total_usage (已用, 美分): one-api 传下来的 OpenAI 风格接口, New API 文档没写, **没对真令牌核过** (朋友的站 11-04 探过: 两个路由没令牌都回 401, 存在)。
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { labRoot } from "../lab/gamedir.ts";
import { httpsGetJson, readPlanUsage, type GetJson, type Quota } from "./quota.ts";
import { parseAgyModels } from "./antigravity-events.ts";
import { formatsOf } from "./relay-route.ts";
import type { ServerConn } from "./online-lib.ts";

export type ProviderId = "claude" | "grok" | "codex" | "gemini" | "deepseek" | "glm" | "relay";
/** 一个额度窗口: used = 已用百分数 0~100 */
export type UsageWindow = { label: string; used: number; resetsAt: string | null };
/** 按量付费的余额 (DeepSeek / 中转站): 金额是接口回的原样字符串; note 有就代替"赠送 + 充值"那行小字 (中转站只有剩余和已用) */
export type Balance = { currency: string; total: string; granted: string; toppedUp: string; enough: boolean | null; note?: string };
export type Account = {
  /** short = 左下角那一行用的短名 (Claude / Grok / GPT / DeepSeek / GLM); kind: cli = 官方命令行登录, key = 填 API 密钥 */
  id: ProviderId; label: string; short: string; kind: "cli" | "key";
  installed: boolean; version: string | null;
  /** null = 说不准 (查状态超时 / 输出看不懂 / 密钥没查成); key 类: 填了且接口认 = true, 没填或接口不认 = false */
  signedIn: boolean | null;
  plan: string | null;
  usage: UsageWindow[];
  balance: Balance | null;
  /** 额度没读到的原因 (登了但读不到时有) */
  usageWhy: string | null;
  /** 登录命令 (显示用) 和没装时怎么装 (只显示, 不替你跑); key 类是空的 */
  login: string; install: string;
  /** key 类: 填的密钥末 4 位 (没填 null; 整个密钥不回给界面) 和去哪拿密钥 */
  keyTail: string | null; keyUrl: string | null;
  /** 中转站 (relay) 才有 (2026-11-04 加): 站点地址、默认模型、这个令牌能用的模型 (查过才有; 标了 anthropic 格式的排前面)、
   *  系统访问令牌末 4 位 + 用户 ID (填了才有; 读账户余额用) */
  url?: string | null; model?: string | null; models?: RelayModel[]; accessTail?: string | null; accessUser?: string | null;
  /** 中转站: 核实过的模型 (账号页"核实"按钮, src/play/relay-verify.ts; 存 keys.json relay_verified); codex: model = ~/.codex/config.toml 里的默认模型 */
  verified?: Record<string, VerifyRecord>;
  /** gemini (Antigravity): `agy models` 列出来的模型 (id + 显示名), 阵容下拉按它列 */
  modelList?: { id: string; name: string }[];
};
/** 一个中转模型核实的结果 (ok 通 / 不通, text = 回了什么或错在哪, at = 什么时候核的) */
export type VerifyRecord = { ok: boolean; ms: number; text: string; at: string };
/** 中转站的一个模型: formats = 站的公开价目表 (/api/pricing) 里写的这个模型支持的接口格式 (openai / openai-response / anthropic …; 读不到是 []),
 *  有 anthropic 的 Claude Code 能直接用, 其余靠站里转格式 */
export type RelayModel = { id: string; formats: string[] };

type Spec = { id: ProviderId; label: string; short: string; cli: string; login: string[]; install: string; extra: (env: NodeJS.ProcessEnv) => string[] };
export const PROVIDERS: Spec[] = [
  { id: "claude", label: "Claude Code", short: "Claude", cli: "claude", login: ["auth", "login"], install: "irm https://claude.ai/install.ps1 | iex",
    extra: (env) => [path.join(home(env), ".local", "bin")] },
  { id: "grok", label: "Grok Build", short: "Grok", cli: "grok", login: ["login"], install: "irm https://x.ai/cli/install.ps1 | iex",
    extra: (env) => [env.GROK_BIN_DIR ?? "", path.join(grokHome(env), "bin")] },
  { id: "codex", label: "Codex (GPT)", short: "GPT", cli: "codex", login: ["login"], install: "npm install -g @openai/codex",
    extra: (env) => [env.APPDATA ? path.join(env.APPDATA, "npm") : ""] },
  // Google Gemini 经 Antigravity CLI: 没有单独的登录命令, 第一次交互跑 agy 就在浏览器里登 Google 账号 (官方 install 文档);
  // 安装器默认放 %LOCALAPPDATA%\agy\bin; 凭据在系统凭据管理器, 没有查登录状态 / 额度的命令 (额度在 agy 里输 /usage 看)
  { id: "gemini", label: "Gemini (Antigravity)", short: "Gemini", cli: "agy", login: [], install: "irm https://antigravity.google/cli/install.ps1 | iex",
    extra: (env) => [env.AGY_BIN_DIR ?? "", env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "agy", "bin") : ""] },
];

const home = (env: NodeJS.ProcessEnv) => env.USERPROFILE || env.HOME || os.homedir();
export const grokHome = (env: NodeJS.ProcessEnv) => env.GROK_HOME?.trim() || path.join(home(env), ".grok");
export const codexHome = (env: NodeJS.ProcessEnv) => env.CODEX_HOME?.trim() || path.join(home(env), ".codex");

/** 在 PATH (加上各家安装器默认放的目录: 控制接口比安装早起来时 PATH 还是旧的) 里找程序; 找不到 null */
export function findCli(name: string, env: NodeJS.ProcessEnv, extra: string[] = [], exists: (f: string) => boolean = isFile): string | null {
  const win = process.platform === "win32";
  const exts = win ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const dirs = [...(env.PATH ?? env.Path ?? "").split(path.delimiter), ...extra].filter(Boolean);
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, name + e.toLowerCase());
    if (exists(f)) return f;
  }
  return null;
}
const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

export type Run = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; out: string; timedOut: boolean }>;
/** 跑一条命令拿输出。.cmd / .bat (npm 装的 codex) 要经 cmd.exe (Node 不许直接起它们); 参数都是写死的, 不带用户输入 */
export const runCli: Run = (file, args, timeoutMs) => new Promise((resolve) => {
  const viaCmd = /\.(cmd|bat)$/i.test(file);
  const [f, a] = viaCmd ? ["cmd.exe", ["/d", "/s", "/c", `"${[`"${file}"`, ...args].join(" ")}"`]] : [file, args];
  execFile(f, a, { timeout: timeoutMs, maxBuffer: 200_000, windowsHide: true, windowsVerbatimArguments: viaCmd, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
    resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${stdout ?? ""}${stderr ?? ""}`, timedOut: !!e?.killed });
  });
});

/** "2.1.314 (Claude Code)" / "codex-cli 0.50.0" / "grok 1.0.41" → 版本号 */
export const versionOf = (out: string): string | null => /\d+\.\d+\.\d+[\w.-]*/.exec(out)?.[0] ?? null;

/** claude auth status --json → 登没登、订阅档 */
export function claudeStatus(out: string): { signedIn: boolean | null; plan: string | null } {
  try {
    const o = JSON.parse(out.slice(out.indexOf("{")));
    if (o?.loggedIn !== true) return { signedIn: false, plan: null };
    const t = typeof o.subscriptionType === "string" ? o.subscriptionType : o.authMethod === "api_key" ? "API 密钥" : null;
    return { signedIn: true, plan: t ? t.charAt(0).toUpperCase() + t.slice(1) : null };
  } catch { return { signedIn: null, plan: null }; }
}

/** codex login status (OpenMausBot 的判定): 0 + "Logged in" = 登了 (using ChatGPT = 订阅; 别的 = API 密钥), 非 0 + "Not logged in" = 没登 */
export function codexStatus(code: number | null, out: string): { signedIn: boolean | null; plan: string | null } {
  if (code === 0 && /^logged in.*chatgpt\b/im.test(out)) return { signedIn: true, plan: "ChatGPT 订阅" };
  if (code === 0 && /^logged in\b/im.test(out)) return { signedIn: true, plan: "API 密钥 (不是订阅)" };
  if (code !== 0 && /^not logged in\b/im.test(out)) return { signedIn: false, plan: null };
  return { signedIn: null, plan: null };
}

// ── 额度 ──
const rec = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp = (x: number) => Math.min(100, Math.max(0, x));
/** 时间: 秒或毫秒的数 (字符串里的数也算) 或 ISO → 毫秒; 认不出 NaN */
function toMs(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null;
  if (n !== null) return Number.isFinite(n) ? (Math.abs(n) >= 1e12 ? n : n * 1000) : NaN;
  return typeof v === "string" && v.trim().length <= 80 ? Date.parse(v) : NaN;
}
const iso = (v: unknown): string | null => { const t = toMs(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
/** 窗口长度 (秒) → 中文名: 3~8 小时 = "5 小时", 5~9 天 = "7 天", 27~32 天 = "30 天", 其他按天 / 小时 / 分钟 (同 OpenMausBot 的分档) */
export function windowLabel(seconds: number | null): string {
  if (seconds === null) return "额度";
  if (seconds >= 3 * 3600 && seconds <= 8 * 3600) return "5 小时";
  if (seconds >= 5 * 86400 && seconds <= 9 * 86400) return "7 天";
  if (seconds >= 27 * 86400 && seconds <= 32 * 86400) return "30 天";
  if (seconds >= 86400) return `${Math.max(1, Math.round(seconds / 86400))} 天`;
  if (seconds >= 3600) return `${Math.max(1, Math.round(seconds / 3600))} 小时`;
  return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
}

/** wham/usage 的一组限额 {primary_window, secondary_window} (或者它自己就是一个窗口) → 窗口 */
function codexWindows(node: unknown, prefix = ""): UsageWindow[] {
  const r = rec(node);
  if (!r) return [];
  const src = rec(r.rate_limit) ?? r;
  const one = (w: unknown): UsageWindow | null => {
    const x = rec(w);
    const used = num(x?.used_percent);
    const sec = num(x?.limit_window_seconds) ?? (num(x?.window_minutes) !== null ? num(x?.window_minutes)! * 60 : null);
    if (!x || used === null || sec === null || sec <= 0) return null;
    return { label: prefix + windowLabel(sec), used: clamp(used), resetsAt: iso(x.reset_at ?? x.resetAt) };
  };
  const ws = ["primary_window", "secondary_window"].map((k) => one(src[k])).filter((w): w is UsageWindow => !!w);
  if (ws.length) return ws;
  const self = one(src);
  return self ? [self] : [];
}
/** Codex 用量回复 → 订阅档和窗口 (主限额 + 代码审查 + 按模型的附加限额, 照 OpenMausBot parseCodexUsage) */
export function parseCodexUsage(body: unknown): { plan: string | null; usage: UsageWindow[] } {
  const r = rec(body);
  if (!r) return { plan: null, usage: [] };
  const usage = codexWindows(r.rate_limit);
  if (r.code_review_rate_limit) usage.push(...codexWindows(r.code_review_rate_limit, "代码审查 "));
  const add = r.additional_rate_limits;
  const named: [string | null, unknown][] = Array.isArray(add) ? add.map((x) => [label(rec(x)?.limit_name ?? rec(x)?.metered_feature ?? rec(x)?.name), x])
    : Object.entries(rec(add) ?? {}).map(([k, v]) => [label(k), v]);
  for (const [n, x] of named) usage.push(...codexWindows(x, n ? `${n} ` : ""));
  return { plan: label(r.plan_type ?? r.plan), usage };
}
/** 接口回的名字只收短的、像名字的 (挡住误回的令牌) */
function label(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > 80 || /[\r\n]/.test(t) || /bearer\s|access_token|refresh_token|sk-ant-|eyJ[a-zA-Z0-9_-]{8,}/i.test(t)) return null;
  return t;
}

/** Grok 的一份账单回复 (?format=credits 或 /v1/billing) → 一个窗口 (照 OpenMausBot readGrokSample: creditUsagePercent, 没有就 onDemandUsed / onDemandCap)。
 *  assumedZero: 用户刚登录的 SuperGrok 账号, ?format=credits 回了这周的周期 (USAGE_PERIOD_TYPE_WEEKLY, start / end) 但没有 creditUsagePercent ——
 *  回复是 protobuf 的 JSON 写法 ({val: 0} 包装、枚举名), 值为 0 的字段会被省掉, 这周还没用过就是这样 → 有周期没用量按已用 0 算并注明 (用过后待核) */
function grokSample(body: unknown): (UsageWindow & { assumedZero?: boolean }) | null {
  const root = rec(body);
  if (!root) return null;
  const c = rec(root.config) ?? root;
  let used = num(c.creditUsagePercent);
  if (used === null) {
    const cap = num(rec(c.onDemandCap)?.val ?? c.onDemandCap), spent = num(rec(c.onDemandUsed)?.val ?? c.onDemandUsed);
    if (cap !== null && spent !== null && cap > 0) used = (spent / cap) * 100;
  }
  const p = rec(c.currentPeriod);
  let assumedZero = false;
  if (used === null && p && (p.type || p.end)) { used = 0; assumedZero = true; }
  if (used === null) return null;
  const type = String(p?.type ?? p?.period ?? c.period ?? c.interval ?? "").toUpperCase();
  const start = toMs(p?.start ?? p?.periodStart), endRaw = p?.end ?? p?.periodEnd ?? c.billingPeriodEnd ?? root.billingPeriodEnd;
  const end = toMs(endRaw);
  const sec = Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 1000 : null;
  const name = type.includes("WEEK") ? "7 天" : type.includes("MONTH") ? "30 天" : /(^|[^A-Z0-9])(5|FIVE)[^A-Z0-9]*HOUR/.test(type) ? "5 小时" : windowLabel(sec);
  return { label: name, used: clamp(used), resetsAt: iso(endRaw), ...(assumedZero ? { assumedZero } : {}) };
}
/** Grok 三个接口的回复 → 订阅档 (settings 的 subscription_tier_display) 和窗口; 按产品的用量 (productUsage) 记成 "Grok Build 7 天" 这样 */
export function parseGrokUsage(credits: unknown, billing?: unknown, settings?: unknown): { plan: string | null; usage: UsageWindow[]; note: string | null } {
  const usage: UsageWindow[] = [];
  const sample = grokSample(credits);
  const main = sample ? { label: sample.label, used: sample.used, resetsAt: sample.resetsAt } : null;
  if (main) usage.push(main);
  const c = rec(rec(credits)?.config) ?? rec(credits);
  for (const x of Array.isArray(c?.productUsage) ? c!.productUsage : []) {
    const r = rec(x);
    const n = label(String(r?.product ?? r?.name ?? "").replace(/([a-z])([A-Z])/g, "$1 $2"));
    const used = num(r?.usagePercent ?? r?.usedPercent ?? r?.utilization);
    if (n && used !== null) usage.push({ label: `${n} ${main?.label ?? ""}`.trim(), used: clamp(used), resetsAt: main?.resetsAt ?? null });
  }
  const b = billing === undefined ? null : grokSample(billing);
  if (b && !usage.some((w) => w.label === b.label)) usage.push(b);
  const s = rec(settings);
  return { plan: label(rec(s?.settings)?.subscription_tier_display ?? s?.subscription_tier_display), usage,
    note: sample?.assumedZero ? "接口回了这周的周期但没给用量数字 (值为 0 时会被省掉), 按这周已用 0% 算; 用过 Grok 后会变 (待核)" : null };
}

/** 读登录文件里的令牌 (只在内存里, 放进请求头); 没有 / 过期写原因 */
export function codexToken(env: NodeJS.ProcessEnv, now = Date.now(), read = readSmall): { token: string | null; accountId?: string; why?: string } {
  let o: any;
  try { o = JSON.parse(read(path.join(codexHome(env), "auth.json")) ?? ""); } catch { return { token: null, why: "没有登录文件" }; }
  const t = rec(o?.tokens);
  const token = secret(t?.access_token) ?? secret(o?.access_token);
  if (!token) return { token: null, why: o?.OPENAI_API_KEY ? "用的是 API 密钥, 没有订阅额度" : "登录文件里没有订阅登录" };
  const exp = toMs(t?.expires_at ?? t?.expiresAt ?? o?.expires_at ?? o?.expiresAt);
  if (Number.isFinite(exp) && exp <= now) return { token: null, why: "登录已过期 (codex 下次运行时会自己刷新, 或者重新登录)" };
  const accountId = secret(t?.account_id) ?? secret(o?.account_id) ?? undefined;
  return { token, ...(accountId ? { accountId } : {}) };
}
export function grokToken(env: NodeJS.ProcessEnv, now = Date.now(), read = readSmall): { token: string | null; why?: string } {
  let o: any;
  try { o = JSON.parse(read(path.join(grokHome(env), "auth.json")) ?? ""); } catch { return { token: null, why: "没有登录文件" }; }
  const cands = [o, ...Object.values(rec(o) ?? {})].map(rec).filter(Boolean).map((r) => ({ token: secret(r!.access_token) ?? secret(r!.key), exp: toMs(r!.expires_at ?? r!.expiresAt) })).filter((c) => c.token);
  const live = cands.filter((c) => !(Number.isFinite(c.exp) && c.exp <= now)).sort((a, b) => (Number.isFinite(b.exp) ? b.exp : -Infinity) - (Number.isFinite(a.exp) ? a.exp : -Infinity));
  if (live[0]) return { token: live[0].token! };
  return { token: null, why: cands.length ? "登录已过期 (grok 下次运行时会自己刷新, 或者重新登录)" : "登录文件里没有令牌" };
}
const secret = (v: unknown): string | null => (typeof v === "string" && v.trim() && v.length <= 16_000 && !/[\r\n]/.test(v) ? v.trim() : null);
const readSmall = (f: string): string | null => { try { return fs.statSync(f).size <= 1_000_000 ? fs.readFileSync(f, "utf8") : null; } catch { return null; } };

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_URLS = ["https://cli-chat-proxy.grok.com/v1/billing?format=credits", "https://cli-chat-proxy.grok.com/v1/billing", "https://cli-chat-proxy.grok.com/v1/settings"];
const httpWhy = (s: number) => (s === 401 || s === 403 ? `用量接口回 HTTP ${s} (登录失效? 重新登录; 也可能是直连被拦, 看 HTTPS_PROXY)` : `用量接口回 HTTP ${s}`);

export async function codexUsage(env: NodeJS.ProcessEnv, get: GetJson = httpsGetJson, timeoutMs = 8_000) {
  const { token, accountId, why } = codexToken(env);
  if (!token) return { plan: null, usage: [], why: why ?? null };
  try {
    const r = await get(CODEX_USAGE_URL, { Authorization: `Bearer ${token}`, Accept: "application/json", ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}) }, env, timeoutMs);
    if (r.status !== 200) return { plan: null, usage: [], why: httpWhy(r.status) };
    const p = parseCodexUsage(r.body);
    return { ...p, why: p.usage.length ? null : "用量接口的回复里没有窗口数据 (格式变了?)" };
  } catch (e) { return { plan: null, usage: [], why: `用量接口连不上: ${(e as Error).message.slice(0, 80)}` }; }
}
export async function grokUsage(env: NodeJS.ProcessEnv, get: GetJson = httpsGetJson, timeoutMs = 8_000) {
  const { token, why } = grokToken(env);
  if (!token) return { plan: null, usage: [], why: why ?? null };
  const h = { Authorization: `Bearer ${token}`, Accept: "application/json", "X-XAI-Token-Auth": "xai-grok-cli" };
  const [credits, billing, settings] = await Promise.all(GROK_URLS.map((u) => get(u, h, env, timeoutMs).catch((e: Error) => ({ status: 0, body: null, err: e.message }))));
  const ok = (r: { status: number; body: unknown }) => (r.status === 200 ? r.body : undefined);
  if (credits.status !== 200 && billing.status !== 200) {
    const s = credits.status || billing.status;
    return { plan: null, usage: [], why: s ? httpWhy(s) : `用量接口连不上: ${String((credits as { err?: string }).err ?? "").slice(0, 80)}` };
  }
  const p = parseGrokUsage(ok(credits) ?? null, ok(billing), ok(settings));
  return { plan: p.plan, usage: p.usage, why: p.usage.length ? p.note : "用量接口的回复里没有额度数据 (格式变了?)" };
}

/** Claude: 已有的 readPlanUsage (quota.ts) → 窗口 */
const CLAUDE_NAMES: Record<string, string> = { five_hour: "5 小时", seven_day: "7 天", seven_day_opus: "7 天 Opus", seven_day_sonnet: "7 天 Sonnet" };
/** quota.ts 的 Quota (utilization 0~1, resetsAt 秒) → 窗口 */
export const quotaWindows = (q: Quota): UsageWindow[] =>
  Object.entries(q.windows).map(([k, w]) => ({ label: CLAUDE_NAMES[k] ?? k, used: clamp(w.utilization * 100), resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null }));
/** official = 实跑时大脑 (Claude Code) 自己输出的额度事件 (和 claude-hud 从 Claude Code 拿到的是同一份官方数据): 有就用它, 不去读没公开的用量接口 */
export async function claudeUsage(env: NodeJS.ProcessEnv, get: GetJson = httpsGetJson, official: Quota | null = null) {
  if (official) return { usage: quotaWindows(official), why: null };
  const { q, why } = await readPlanUsage(env, get);
  if (!q) return { usage: [], why: why ?? null };
  return { usage: quotaWindows(q), why: null };
}

/** 一家的账号状态 (装没装 → 版本 → 登没登 → 额度) */
export async function accountOf(spec: Spec, env: NodeJS.ProcessEnv = process.env, run: Run = runCli, get: GetJson = httpsGetJson, official: Quota | null = null): Promise<Account> {
  const base: Account = { id: spec.id, label: spec.label, short: spec.short, kind: "cli", installed: false, version: null, signedIn: null, plan: null, usage: [], balance: null, usageWhy: null,
    login: `${spec.cli} ${spec.login.join(" ")}`.trim(), install: spec.install, keyTail: null, keyUrl: null };
  const cli = findCli(spec.cli, env, spec.extra(env));
  if (!cli) return base;
  const ver = run(cli, ["--version"], 8_000);
  let st: { signedIn: boolean | null; plan: string | null };
  let agyModels: { id: string; name: string }[] = [];
  if (spec.id === "claude") { const r = await run(cli, ["auth", "status", "--json"], 8_000); st = r.timedOut ? { signedIn: null, plan: null } : claudeStatus(r.out); }
  else if (spec.id === "codex") { const r = await run(cli, ["login", "status"], 8_000); st = r.timedOut ? { signedIn: null, plan: null } : codexStatus(r.code, r.out); }
  else if (spec.id === "gemini") {
    // Antigravity 没有查登录状态的命令 (凭据在系统凭据管理器); `agy models` 登了就列出模型 (1.5.0 实测 2026-11-04: 6 个, 要联网几秒), 没登就报错 → 拿它当探针, 顺便把模型给阵容下拉
    const r = await run(cli, ["models"], 20_000);
    agyModels = r.timedOut ? [] : parseAgyModels(r.out);
    st = { signedIn: r.timedOut ? null : agyModels.length ? true : /auth|login|sign.?in|credential/i.test(r.out) ? false : null, plan: null };
  }
  else st = { signedIn: fs.existsSync(path.join(grokHome(env), "auth.json")), plan: null };
  const out: Account = { ...base, installed: true, version: versionOf((await ver).out), ...st };
  if (st.signedIn === false) return out;
  // gemini: 额度只能在 agy 里输 /usage 看; 账号地区不合格 (本机 11-04 实测 "not eligible for Antigravity… not available in your location") 要跑一句才知道, 开班前试通会报
  const u = spec.id === "claude" ? { plan: null, ...(await claudeUsage(env, get, official)) } : spec.id === "codex" ? await codexUsage(env, get)
    : spec.id === "gemini" ? { plan: agyModels.length ? `${agyModels.length} 个模型` : null, usage: [], why: "额度在终端里跑 agy 输 /usage 看 (没有命令行查法)", modelList: agyModels } : await grokUsage(env, get);
  // codex: 带上 config.toml 里的默认模型 (阵容下拉 "GPT (ChatGPT 订阅)" 列它; )
  return { ...out, plan: out.plan ?? u.plan, usage: u.usage, usageWhy: u.why, ...(spec.id === "codex" ? { model: codexConfigModel(env) } : {}), ...("modelList" in u && u.modelList.length ? { modelList: u.modelList } : {}) };
}

// ── 填密钥的三家: DeepSeek、GLM 编程套餐、中转站 (New API) ──
export type KeyId = "anthropic" | "deepseek" | "glm" | "relay";
type KeySpec = { id: KeyId; label: string; short: string; keyUrl: string };
export const KEY_PROVIDERS: KeySpec[] = [
  // Claude 的第二条路 (要和订阅两个都用): 大脑走 Agent SDK (src/play/agent-sdk.ts), 密钥在 Console 建
  { id: "anthropic", label: "Claude (Console API 密钥)", short: "Claude API", keyUrl: "https://platform.claude.com/settings/keys" },
  { id: "deepseek", label: "DeepSeek", short: "DeepSeek", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "glm", label: "GLM 编程套餐", short: "GLM", keyUrl: "https://bigmodel.cn/apikey/coding-plan-per" },
  // 中转站: 令牌在站里自己建 (New API 控制台 → 令牌, 路径 /console/token), keyUrl 按填的站点算 (见 keyAccountOf)
  { id: "relay", label: "中转站 (New API)", short: "中转", keyUrl: "" },
];
export const defaultKeysFile = () => path.join(labRoot(), "accounts", "keys.json");
/** 本机存的密钥 {deepseek: "...", glm: "...", relay: 令牌, relay_url: 站点, relay_model: 模型}; 没有文件是 {} */
export function readKeys(file: string): Record<string, string> {
  try { const o = JSON.parse(fs.readFileSync(file, "utf8")); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; }
}
/** 中转站的几样 (没填的是空串): url 站点、key 令牌 (sk-)、model 默认模型 (可空)、access 站里"个人设置 → 系统访问令牌" + user 用户 ID (可选, 读账户余额用;
 *  : 令牌级账单接口对不限额的令牌固定回 1 亿, 账户余额只有用户级接口 /api/user/self 能读) */
export type RelayConfig = { url: string; key: string; model: string; access: string; user: string };
export function relayConfig(keys: Record<string, string>): RelayConfig {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { url: s(keys.relay_url), key: s(keys.relay), model: s(keys.relay_model), access: s(keys.relay_access), user: s(keys.relay_user) };
}
/** 站点地址: 没写协议补 https:// (New API 官方脚本也这么做), 去掉末尾的 / 和 /v1 (Claude Code 自己会加 /v1); 不是 http(s) 地址 → null */
export function cleanUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t || /\s/.test(t)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname) return null;
  const p = u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "").replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${p}`;
}
/** 核实过的中转模型 (keys.json 的 relay_verified 是一段 JSON 文字: {模型: {ok, ms, text, at}}); 坏了 / 没有 → {} */
export function readRelayVerified(file: string): Record<string, VerifyRecord> {
  try {
    const o = JSON.parse(readKeys(file).relay_verified ?? "{}");
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: Record<string, VerifyRecord> = {};
    for (const [k, v] of Object.entries(o as Record<string, any>)) if (v && typeof v === "object" && typeof v.ok === "boolean") out[k] = { ok: v.ok, ms: Number(v.ms) || 0, text: String(v.text ?? "").slice(0, 300), at: String(v.at ?? "") };
    return out;
  } catch { return {}; }
}
/** 站标的每个模型的接口格式 (keys.json 的 relay_formats 是一段 JSON 文字 {模型: [格式]}; 账号页读到模型表时存, 开班 / 核实按它分流, 见 src/play/relay-route.ts); 坏了 / 没有 → {} */
export function readRelayFormats(file: string): Record<string, string[]> {
  try {
    const o = JSON.parse(readKeys(file).relay_formats ?? "{}");
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).map(String)]));
  } catch { return {}; }
}
export function saveRelayFormats(file: string, formats: Record<string, string[]>): void {
  if (!Object.keys(formats).length) return;
  const keys = readKeys(file);
  keys.relay_formats = JSON.stringify(formats);
  writeKeys(file, keys);
}
/** 记一个模型的核实结果 (null = 清掉这个模型的记录; model 空 = 清全部) */
export function saveRelayVerified(file: string, model: string, r: VerifyRecord | null): void {
  const keys = readKeys(file);
  const all = readRelayVerified(file);
  if (!model) { delete keys.relay_verified; writeKeys(file, keys); return; }
  if (r) all[model] = r; else delete all[model];
  keys.relay_verified = JSON.stringify(all);
  writeKeys(file, keys);
}
/** ~/.codex/config.toml 里的默认模型 (model = "gpt-6.1-sol"); 没有 → null */
export function codexConfigModel(env: NodeJS.ProcessEnv): string | null {
  try { const m = /^\s*model\s*=\s*"([^"\n]+)"/m.exec(fs.readFileSync(path.join(codexHome(env), "config.toml"), "utf8")); return m ? m[1].trim() : null; } catch { return null; }
}
/** 存中转站的地址 / 令牌 / 模型 / 系统访问令牌 + 用户 ID: 没给 (undefined) 的不动; key 给空串 = 整个中转站配置删掉; 其余给空串 = 删那一项 */
export function saveRelay(file: string, patch: { url?: string; key?: string; model?: string; access?: string; user?: string }): void {
  const keys = readKeys(file);
  if (patch.key !== undefined) {
    if (patch.key.trim() === "") { for (const k of ["relay", "relay_url", "relay_model", "relay_access", "relay_user"]) delete keys[k]; writeKeys(file, keys); return; }
    const k = cleanKey(patch.key);
    if (!k) throw new Error("令牌格式不对: 应该是一串没有空格的字母数字符号 (8~300 个), 中转站控制台 → 令牌 里复制整串 sk-…");
    keys.relay = k;
  }
  if (patch.access !== undefined) {
    if (patch.access.trim() === "") { delete keys.relay_access; delete keys.relay_user; }
    else {
      const t = cleanKey(patch.access);
      if (!t) throw new Error("系统访问令牌格式不对: 站里 个人设置 → 系统访问令牌 生成后整串复制");
      keys.relay_access = t;
    }
  }
  if (patch.user !== undefined) {
    if (patch.user.trim() === "") delete keys.relay_user;
    else {
      const u = patch.user.trim();
      if (!/^\d{1,12}$/.test(u)) throw new Error("用户 ID 要是数字 (站里 个人设置 页面上的 ID)");
      keys.relay_user = u;
    }
  }
  if (patch.url !== undefined) {
    if (patch.url.trim() === "") delete keys.relay_url;
    else {
      const u = cleanUrl(patch.url);
      if (!u) throw new Error("中转站地址不对: 要像 https://ai.example.com 这样的网址 (不用带 /v1)");
      keys.relay_url = u;
    }
  }
  if (patch.model !== undefined) {
    if (patch.model.trim() === "") delete keys.relay_model;
    else {
      const m = patch.model.trim();
      if (!/^[\x21-\x7e]{1,120}$/.test(m)) throw new Error("模型名不对: 用站里列出来的模型名");
      keys.relay_model = m;
    }
  }
  writeKeys(file, keys);
}
function writeKeys(file: string, keys: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys, null, 1), { mode: 0o600 });
}
/** 联机群的服务器地址和密码 (可带 RCON) 存 keys.json 的 group_servers: 群文件在 play/ 下进备份, 地址和密码不能进。conn = null 删掉, 这个群就用 keys.json 默认的 server */
export function saveGroupServer(file: string, groupId: string, conn: ServerConn | null): void {
  const keys = readKeys(file) as Record<string, unknown>;
  const all = { ...((keys.group_servers ?? {}) as Record<string, ServerConn>) };
  if (conn) all[groupId] = conn; else delete all[groupId];
  keys.group_servers = all;
  writeKeys(file, keys as Record<string, string>);
}
/** 密钥只收可见的 ASCII (没有空格、换行), 8~300 个字符: 两家的密钥都是这样; 粘贴时带的首尾空白去掉 */
export function cleanKey(raw: string): string | null {
  const k = raw.trim();
  return /^[\x21-\x7e]{8,300}$/.test(k) ? k : null;
}
/** 存 / 删一个密钥 (key 为空 = 删); 不合格式抛错 */
export function saveKey(file: string, id: string, raw: string): void {
  const keys = readKeys(file);
  if (raw.trim() === "") delete keys[id];
  else {
    const k = cleanKey(raw);
    if (!k) throw new Error("密钥格式不对: 应该是一串没有空格的字母数字符号 (8~300 个)");
    keys[id] = k;
  }
  writeKeys(file, keys);
}
const tail = (k: string) => k.slice(-4);

/** 中转站 /v1/models 的回复 ({object: "list", data: [{id, …}]}) + 公开价目表 /api/pricing ({data: [{model_name, supported_endpoint_types}]}, 可没有)
 *  → 模型 (去重; 标了 anthropic 格式的排前面, 组内按字母) */
export function parseRelayModels(body: unknown, pricing?: unknown): RelayModel[] {
  const r = rec(body);
  const list = Array.isArray(r?.data) ? r!.data : Array.isArray(body) ? body : [];
  const ids = list.map((x: unknown) => (typeof x === "string" ? x : rec(x)?.id)).filter((x: unknown): x is string => typeof x === "string" && !!x.trim() && x.length <= 120);
  const formats = new Map<string, string[]>();
  for (const x of Array.isArray(rec(pricing)?.data) ? rec(pricing)!.data : []) {
    const p = rec(x);
    const name = typeof p?.model_name === "string" ? p.model_name : null;
    const f = Array.isArray(p?.supported_endpoint_types) ? p!.supported_endpoint_types.filter((t: unknown): t is string => typeof t === "string") : [];
    if (name) formats.set(name, f);
  }
  const out = [...new Set(ids.map((x: string) => x.trim()))].map((id) => ({ id, formats: formats.get(id) ?? [] }));
  const native = (m: RelayModel) => (m.formats.includes("anthropic") ? 0 : 1);
  return out.sort((a, b) => native(a) - native(b) || a.id.localeCompare(b.id));
}
/** 中转站 one-api 风格的账单: subscription.hard_limit_usd = 剩余 (美元), usage.total_usage = 已用 (美分); 没对真令牌核过 */
export function parseRelayBalance(subscription: unknown, usage: unknown): Balance | null {
  const left = num(rec(subscription)?.hard_limit_usd);
  if (left === null) return null;
  const usedCents = num(rec(usage)?.total_usage);
  const used = usedCents === null ? null : usedCents / 100;
  // 令牌没设上限时站回一个巨大的数 (2026-11-04 朋友的站回 $100000000): 显示"不限额", 不当成余额
  const unlimited = left >= 1_000_000;
  return { currency: "USD", total: unlimited ? "不限额" : left.toFixed(2), granted: "", toppedUp: used === null ? "" : used.toFixed(2), enough: unlimited || left > 0,
    note: `${unlimited ? "这个令牌没设上限, 账户余额要填系统访问令牌才能读 · " : "令牌的额度 · "}${used === null ? "已用多少没读到" : `这个令牌已用 $${used.toFixed(2)}`} (待核)` };
}
/** 中转站用户级接口 /api/user/self 的回复 ({success, data: {id, username, quota, used_quota}}; 额度单位: 500000 = $1, New API / one-api 的 QuotaPerUnit 默认值; 没对真账号核过) */
export const RELAY_QUOTA_PER_USD = 500_000;
export function parseRelayUser(body: unknown): Balance | null {
  const r = rec(body);
  if (r && r.success === false) return null;
  const d = rec(r?.data) ?? r;
  const quota = num(d?.quota);
  if (quota === null) return null;
  const used = num(d?.used_quota);
  const name = label(d?.username ?? d?.display_name);
  return { currency: "USD", total: (quota / RELAY_QUOTA_PER_USD).toFixed(2), granted: "", toppedUp: used === null ? "" : (used / RELAY_QUOTA_PER_USD).toFixed(2), enough: quota > 0,
    note: `账户余额${name ? ` (${name})` : ""}${used === null ? "" : ` · 累计已用 $${(used / RELAY_QUOTA_PER_USD).toFixed(2)}`} · 按 500000 = $1 折算 (待核)` };
}

/** DeepSeek 余额回复 → 余额 (先取人民币那一项) */
export function parseDeepseekBalance(body: unknown): Balance | null {
  const r = rec(body);
  const list = Array.isArray(r?.balance_infos) ? r!.balance_infos.map(rec).filter(Boolean) as Record<string, any>[] : [];
  const b = list.find((x) => x.currency === "CNY") ?? list[0];
  if (!b) return null;
  const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "0");
  return { currency: String(b.currency ?? ""), total: s(b.total_balance), granted: s(b.granted_balance), toppedUp: s(b.topped_up_balance), enough: typeof r!.is_available === "boolean" ? r!.is_available : null };
}
/** GLM 额度回复 → 窗口 (TOKENS_LIMIT = 5 小时 token, TIME_LIMIT = MCP 每月次数; 别的按类型名) */
export function parseGlmQuota(body: unknown): { usage: UsageWindow[]; rejected: string | null } {
  const r = rec(body);
  // 智谱的接口常常 HTTP 200 但正文里写错误 ({success: false, code, msg})
  if (r && (r.success === false || (typeof r.code === "number" && r.code !== 200 && r.code !== 0 && !r.data))) return { usage: [], rejected: label(r.msg ?? r.message) ?? `错误码 ${r.code}` };
  const d = rec(r?.data) ?? r;
  const usage: UsageWindow[] = [];
  for (const x of Array.isArray(d?.limits) ? d!.limits : []) {
    const l = rec(x);
    const used = num(l?.percentage);
    if (!l || used === null) continue;
    const name = l.type === "TOKENS_LIMIT" ? "5 小时" : l.type === "TIME_LIMIT" ? "MCP 每月" : label(l.type) ?? "额度";
    usage.push({ label: name, used: clamp(used), resetsAt: iso(l.nextResetTime ?? l.resetTime ?? l.reset_at) });
  }
  return { usage, rejected: null };
}

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const GLM_QUOTA_URLS = [["open.bigmodel.cn", "智谱 (国内)"], ["api.z.ai", "Z.ai (国际)"]].map(([h, n]) => ({ url: `https://${h}/api/monitor/usage/quota/limit`, name: n }));
const rejectedWhy = (who: string, s: number) => `${who}不认这个密钥 (HTTP ${s}): 检查有没有复制全、是不是这家的密钥`;

/** 用密钥查一次: 认不认 (signedIn)、额度 / 余额、没查成的原因; 中转站 (relay) 要给站点 url, 多回 models (这个令牌能用的模型) */
export async function checkKey(id: KeyId, key: string, env: NodeJS.ProcessEnv = process.env, get: GetJson = httpsGetJson, timeoutMs = 8_000, url?: string, acct?: { access: string; user: string }):
  Promise<{ signedIn: boolean | null; plan: string | null; usage: UsageWindow[]; balance: Balance | null; why: string | null; models?: RelayModel[] }> {
  const none = { plan: null, usage: [], balance: null };
  if (id === "relay") {
    const base = cleanUrl(url ?? "");
    if (!base) return { ...none, signedIn: false, why: "中转站地址没填 (像 https://ai.example.com, 不用带 /v1)", models: [] };
    const h = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    try {
      const r = await get(`${base}/v1/models`, h, env, timeoutMs);
      if (r.status === 401 || r.status === 403) return { ...none, signedIn: false, why: rejectedWhy("中转站", r.status), models: [] };
      if (r.status !== 200) return { ...none, signedIn: null, why: `中转站的模型接口回 HTTP ${r.status}`, models: [] };
      // 价目表 (公开, 带每个模型支持的接口格式) 和余额 (one-api 风格, 站可能没开): 读不到都不算失败
      const soft = (x: string) => get(x, h, env, timeoutMs).catch(() => ({ status: 0, body: null }));
      const [pricing, sub, use] = await Promise.all([soft(`${base}/api/pricing`), soft(`${base}/dashboard/billing/subscription`), soft(`${base}/dashboard/billing/usage`)]);
      const models = parseRelayModels(r.body, pricing.status === 200 ? pricing.body : undefined);
      let balance = sub.status === 200 ? parseRelayBalance(sub.body, use.status === 200 ? use.body : null) : null;
      let acctWhy: string | null = null;
      // 账户余额 (可选): 系统访问令牌 + 用户 ID 走用户级接口 (Authorization: Bearer 系统访问令牌, New-Api-User: 用户 ID; 照 New API 源码 middleware/auth.go 的写法, 没对真账号核过)
      if (acct?.access) {
        const me = await get(`${base}/api/user/self`, { Authorization: `Bearer ${acct.access}`, "New-Api-User": acct.user, Accept: "application/json" }, env, timeoutMs).catch(() => ({ status: 0, body: null }));
        const b = me.status === 200 ? parseRelayUser(me.body) : null;
        if (b) balance = b;
        else acctWhy = me.status === 401 || me.status === 403 ? `系统访问令牌不认 (HTTP ${me.status}): 要和站里个人设置页上的用户 ID 一起填` : me.status === 200 ? "用户接口回了, 但里面没有余额 (格式变了?)" : me.status ? `用户接口回 HTTP ${me.status}` : "用户接口连不上";
      }
      const native = models.filter((m) => m.formats.includes("anthropic")).length;
      return { ...none, signedIn: true, plan: `${models.length} 个模型${native ? `, ${native} 个标了 Claude 格式` : ""}`, models, balance,
        why: models.length ? (acctWhy ?? (balance ? null : "余额没读到 (站的账单接口没开或格式不同), 不影响用")) : "令牌能用, 但模型列表是空的 (令牌没分到模型分组?)" };
    } catch (e) { return { ...none, signedIn: null, why: `中转站连不上: ${(e as Error).message.slice(0, 80)}`, models: [] }; }
  }
  // Claude Console 密钥: 用免费的模型列表接口验 (官方 GET /v1/models); 用户级密钥 (sk-ant-usr) 没绑工作区时要带 anthropic-workspace-id 头 (keys.json anthropic_workspace), 不然 400 (2026-11-05 实测)
  if (id === "anthropic") {
    try {
      const r = await get("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01", Accept: "application/json", ...(acct?.access ? { "anthropic-workspace-id": acct.access } : {}) }, env, timeoutMs);
      if (r.status === 401 || r.status === 403) return { ...none, signedIn: false, why: rejectedWhy("Anthropic ", r.status) };
      if (r.status === 400 && /workspace/i.test(JSON.stringify(r.body ?? ""))) return { ...none, signedIn: false, why: "这把是用户级密钥 (sk-ant-usr), 没绑工作区: 在 Console 新建一把绑定工作区的密钥 (建时选 Default), 或把工作区 ID 写进 keys.json 的 anthropic_workspace" };
      if (r.status !== 200) return { ...none, signedIn: null, why: `Anthropic 模型接口回 HTTP ${r.status}` };
      return { ...none, signedIn: true, plan: "Console 计费 (赠额和余额在 Console 的 Billing 页看)", why: null };
    } catch (e) { return { ...none, signedIn: null, why: `连不上 api.anthropic.com: ${(e as Error).message.slice(0, 80)}` }; }
  }
  if (id === "deepseek") {
    try {
      const r = await get(DEEPSEEK_BALANCE_URL, { Authorization: `Bearer ${key}`, Accept: "application/json" }, env, timeoutMs);
      if (r.status === 401 || r.status === 403) return { ...none, signedIn: false, why: rejectedWhy("DeepSeek ", r.status) };
      if (r.status !== 200) return { ...none, signedIn: null, why: `余额接口回 HTTP ${r.status}` };
      const balance = parseDeepseekBalance(r.body);
      return { ...none, signedIn: true, balance, why: balance ? null : "余额接口的回复里没有余额 (格式变了?)" };
    } catch (e) { return { ...none, signedIn: null, why: `余额接口连不上: ${(e as Error).message.slice(0, 80)}` }; }
  }
  // GLM: 先国内, 不认再试国际版 (两边的密钥不通用)
  let last: string | null = null;
  for (const u of GLM_QUOTA_URLS) {
    try {
      const r = await get(u.url, { Authorization: key, Accept: "application/json", "Accept-Language": "zh-CN,zh" }, env, timeoutMs);
      if (r.status === 401 || r.status === 403) { last = rejectedWhy("GLM ", r.status); continue; }
      if (r.status !== 200) return { ...none, signedIn: null, why: `${u.name}的额度接口回 HTTP ${r.status}` };
      const q = parseGlmQuota(r.body);
      if (q.rejected) { last = `GLM 不认这个密钥: ${q.rejected}`; continue; }
      return { ...none, signedIn: true, plan: u.name, usage: q.usage, why: q.usage.length ? null : "额度接口的回复里没有额度 (格式变了? 没对真账号核过)" };
    } catch (e) { return { ...none, signedIn: null, why: `${u.name}的额度接口连不上: ${(e as Error).message.slice(0, 80)}` }; }
  }
  return { ...none, signedIn: false, why: last };
}

/** 填密钥的一家: 没填 → signedIn false; 填了就查一次 */
export async function keyAccountOf(spec: KeySpec, keysFile: string, env: NodeJS.ProcessEnv = process.env, get: GetJson = httpsGetJson): Promise<Account> {
  const keys = readKeys(keysFile);
  if (spec.id === "relay") {
    const { url, key, model, access, user } = relayConfig(keys);
    const base: Account = { id: spec.id, label: spec.label, short: spec.short, kind: "key", installed: true, version: null, signedIn: false, plan: null, usage: [], balance: null, usageWhy: null,
      login: "", install: "", keyTail: key ? tail(key) : null, keyUrl: url ? `${url}/console/token` : null, url: url || null, model: model || null, models: [],
      accessTail: access ? tail(access) : null, accessUser: user || null };
    if (!key) return base;
    const c = await checkKey("relay", key, env, get, 8_000, url, access ? { access, user } : undefined);
    // 站标的格式存下来 (开班 / 核实按它分流, relay-route.ts); 核实过的模型 (账号页"核实"按钮的结果) 一起给界面: 下拉按它分组
    if (c.models?.length) { try { saveRelayFormats(keysFile, formatsOf(c.models)); } catch { /* 存不上不影响显示 */ } }
    return { ...base, signedIn: c.signedIn, plan: c.plan, usage: c.usage, balance: c.balance, usageWhy: c.why, models: c.models ?? [], verified: readRelayVerified(keysFile) };
  }
  const key = keys[spec.id];
  const base: Account = { id: spec.id, label: spec.label, short: spec.short, kind: "key", installed: true, version: null, signedIn: false, plan: null, usage: [], balance: null, usageWhy: null,
    login: "", install: "", keyTail: key ? tail(key) : null, keyUrl: spec.keyUrl };
  if (!key) return base;
  // anthropic: 用户级密钥 (sk-ant-usr) 要带工作区 ID (keys.json anthropic_workspace, 借 acct.access 传)
  const c = await checkKey(spec.id, key, env, get, 8_000, undefined, spec.id === "anthropic" && keys.anthropic_workspace ? { access: keys.anthropic_workspace, user: "" } : undefined);
  return { ...base, signedIn: c.signedIn, plan: c.plan, usage: c.usage, balance: c.balance, usageWhy: c.why };
}

/** official = 实跑时 Claude 的官方额度 (见 claudeUsage) */
export const accountsAll = (env: NodeJS.ProcessEnv = process.env, run: Run = runCli, get: GetJson = httpsGetJson, keysFile = defaultKeysFile(), official: Quota | null = null) =>
  Promise.all([...PROVIDERS.map((p) => accountOf(p, env, run, get, official)), ...KEY_PROVIDERS.map((p) => keyAccountOf(p, keysFile, env, get))]);

/** 登录窗口的命令行: cmd.exe /d /c start "登录 X" cmd.exe /d /c ""<程序>" <登录参数> & echo. & echo 提示 & pause"
 *  (start 的第一个带引号的参数是窗口标题; 里面那层 cmd /c 去掉首尾一对引号, 剩下 "<程序>" 参数 & … ) */
export function loginCommandLine(spec: Spec, cli: string): string {
  const inner = [`"${cli}"`, ...spec.login].join(" ");
  return `/d /c start "登录 ${spec.label}" cmd.exe /d /c "${inner} & echo. & echo 登录完了就可以关掉这个窗口, 界面里的账号页会自己更新 & pause"`;
}
/** 开登录窗口 (看得见的命令行窗口, 浏览器里登, 我们不经手密码); 没装返回 null */
export function openLogin(id: ProviderId, env: NodeJS.ProcessEnv = process.env): { command: string } | null {
  const spec = PROVIDERS.find((p) => p.id === id);
  const cli = spec && findCli(spec.cli, env, spec.extra(env));
  if (!spec || !cli) return null;
  if (process.platform !== "win32") throw new Error("登录窗口只做了 Windows");
  const c = spawn("cmd.exe", [loginCommandLine(spec, cli)], { detached: true, stdio: "ignore", windowsVerbatimArguments: true, env: { ...env } });
  c.unref();
  return { command: `${spec.cli} ${spec.login.join(" ")}` };
}
