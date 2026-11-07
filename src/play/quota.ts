// 订阅额度 (库, 不直接运行): 从 claude -p --output-format stream-json 的 rate_limit_event 读 5 小时 / 7 天窗口的已用比例和重置时间。
// ; 派对开班前按实测消耗推 5 小时窗口和周窗口, 不够不开班 (docs/research/factorio-harness.md 第 3 节)。
// 事件的样子 (Claude Code 2.1.314 实测, 第五轮 turn-*.jsonl):
//   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1794049200,"rateLimitType":"seven_day",
//    "unifiedWindows":{"seven_day":{"utilization":0.26,"resetsAt":1794049200,"status":"allowed"}}, ...}}
import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

export type QuotaWindow = { utilization: number; resetsAt?: number; status?: string };
export type Quota = { t: number; status: string; type?: string; resetsAt?: number; windows: Record<string, QuotaWindow> };

/** stream-json 的一行 (已解析); 不是额度事件返回 null */
export function parseRateLimit(m: any, now = Date.now()): Quota | null {
  if (m?.type !== "rate_limit_event" || !m.rate_limit_info) return null;
  const i = m.rate_limit_info;
  const windows: Record<string, QuotaWindow> = {};
  for (const [k, w] of Object.entries<any>(i.unifiedWindows ?? {})) if (typeof w?.utilization === "number") windows[k] = { utilization: w.utilization, resetsAt: w.resetsAt, status: w.status };
  return { t: now, status: String(i.status ?? "unknown"), type: i.rateLimitType, resetsAt: i.resetsAt, windows };
}

/** 最紧的窗口用了多少 (0~1); 没有窗口数据返回 null */
export function maxUtilization(q: Quota | null): number | null {
  const v = q ? Object.values(q.windows).map((w) => w.utilization) : [];
  return v.length ? Math.max(...v) : null;
}

const NAMES: Record<string, string> = { five_hour: "5 小时窗口", seven_day: "7 天窗口", seven_day_opus: "7 天 Opus 窗口", seven_day_sonnet: "7 天 Sonnet 窗口" };
export function describeQuota(q: Quota | null, now = Date.now()): string {
  if (!q) return "额度: 没读到 (输出里没有 rate_limit_event)";
  const left = (s?: number) => {
    if (!s) return "";
    const h = (s * 1000 - now) / 3_600_000;
    return h >= 24 ? `, ${(h / 24).toFixed(1)} 天后重置` : `, ${h.toFixed(1)} 小时后重置`;
  };
  const ws = Object.entries(q.windows).map(([k, w]) => `${NAMES[k] ?? k}已用 ${Math.round(w.utilization * 100)}%${left(w.resetsAt)}`);
  return `额度 (${q.status === "allowed" ? "可用" : q.status}): ${ws.length ? ws.join("; ") : `没有窗口数据${left(q.resetsAt)}`}`;
}

// 不花额度读用量: Claude Code 的 /usage 用的同一个接口, 不调模型。
// 做法照 OpenMausBot server/plan-usage.ts (Apache-2.0, 见 NOTICE): 凭据是 <CLAUDE_CONFIG_DIR 或 ~/.claude>/.credentials.json 的
// claudeAiOauth.accessToken, 请求头 anthropic-beta: oauth-2025-04-20; 回复 {five_hour: {utilization: 百分数, resets_at: ISO}, seven_day: …, seven_day_opus: …}。
// 接口没公开, 随时可能变: 读不到就返回原因, 调用方退回 probeQuota。凭据只放进请求头, 不打印、不写文件。
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** 用量接口的回复 → Quota (和 rate_limit_event 同一个形状: utilization 0~1, resetsAt 秒); 没有窗口返回 null */
export function parsePlanUsage(body: any, now = Date.now()): Quota | null {
  if (!body || typeof body !== "object") return null;
  const root = "five_hour" in body || "seven_day" in body ? body : body.usage ?? body.windows ?? body;
  const windows: Record<string, QuotaWindow> = {};
  for (const [k, w] of Object.entries<any>(root ?? {})) {
    if (!/^(five_hour|seven_day)(_[a-z0-9_]+)?$/.test(k) || typeof w?.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    const at = Date.parse(String(w.resets_at ?? w.resetsAt ?? ""));
    windows[k] = { utilization: w.utilization / 100, ...(Number.isFinite(at) ? { resetsAt: Math.round(at / 1000) } : {}) };
  }
  if (!Object.keys(windows).length) return null;
  return { t: now, status: Object.values(windows).some((w) => w.utilization >= 1) ? "rejected" : "allowed", windows };
}

/** 本机 Claude Code 的订阅登录凭据; 没有、或 1 分钟内过期返回 null (过期的让 claude 自己刷新: 调用方退回探针) */
export function claudeOauthToken(env: NodeJS.ProcessEnv = process.env, now = Date.now()): { token: string | null; why?: string } {
  const file = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json");
  let o: any;
  try { o = JSON.parse(fs.readFileSync(file, "utf8"))?.claudeAiOauth; } catch { return { token: null, why: "没有登录凭据文件" }; }
  if (typeof o?.accessToken !== "string" || !o.accessToken) return { token: null, why: "凭据文件里没有订阅登录" };
  if (typeof o.expiresAt === "number" && o.expiresAt <= now + 60_000) return { token: null, why: "登录凭据已过期 (claude 下次运行时会自己刷新)" };
  return { token: o.accessToken };
}

export type GetJson = (url: string, headers: Record<string, string>, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ status: number; body: unknown }>;
/** GET 一个 JSON; 走 HTTPS_PROXY (Node 自带的 fetch 不走代理: 2026-11-03 本机直连回 403 "Request not allowed" = 地区拦截, 走代理 200)。
 * 只给这一个请求走代理 (https.Agent 的 proxyEnv, Node 24), 不用全局开关 —— 那会让连本机服务器的请求也去走代理 */
export const httpsGetJson: GetJson = (url, headers, env, timeoutMs) => new Promise((resolve, reject) => {
  const req = https.get(url, { headers, agent: new https.Agent({ proxyEnv: env } as https.AgentOptions), timeout: timeoutMs }, (r) => {
    let b = "";
    r.setEncoding("utf8");
    r.on("data", (d: string) => { if (b.length < 1_000_000) b += d; });
    r.on("end", () => { let body: unknown = null; try { body = JSON.parse(b); } catch { /* 不是 JSON */ } resolve({ status: r.statusCode ?? 0, body }); });
  });
  req.on("timeout", () => req.destroy(new Error("超时")));
  req.on("error", reject);
});

/** 不花额度读订阅用量; 读不到时 q 为 null, why 写原因 */
export async function readPlanUsage(env: NodeJS.ProcessEnv = process.env, get: GetJson = httpsGetJson, timeoutMs = 8_000): Promise<{ q: Quota | null; why?: string }> {
  const { token, why } = claudeOauthToken(env);
  if (!token) return { q: null, why };
  try {
    const r = await get(CLAUDE_USAGE_URL, { Authorization: `Bearer ${token}`, Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" }, env, timeoutMs);
    if (r.status !== 200) return { q: null, why: `用量接口回 HTTP ${r.status}${r.status === 403 ? " (直连被地区拦截? 看 HTTPS_PROXY)" : ""}` };
    const q = parsePlanUsage(r.body);
    return q ? { q } : { q: null, why: "用量接口的回复里没有窗口数据 (格式变了?)" };
  } catch (e) { return { q: null, why: `用量接口连不上: ${(e as Error).message.slice(0, 80)}` }; }
}

/** 开跑前探一次: 跑一条极小的 claude -p (只回 ok, 不开工具), 读额度事件。bin / env / cwd 用和大脑一样的 (订阅登录) */
export function probeQuota(bin: string, env: NodeJS.ProcessEnv, cwd: string, model: string, timeoutMs = 90_000): Promise<Quota | null> {
  return new Promise((resolve) => {
    const args = ["-p", "只回复 ok", "--output-format", "stream-json", "--verbose", "--model", model, "--effort", "low",
      "--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome", "--disable-slash-commands", "--tools", ""];
    const c = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let buf = "", q: Quota | null = null;
    const timer = setTimeout(() => c.kill(), timeoutMs);
    c.stdout!.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { q = parseRateLimit(JSON.parse(line)) ?? q; } catch { /* 不是整行 */ }
      }
    });
    c.on("exit", () => { clearTimeout(timer); resolve(q); });
    c.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}
