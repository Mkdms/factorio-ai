// 中转站模型核实 (库, 不直接运行): 对每个模型发 **1 条** 按站标协议写的最小请求, 通 / 不通 (带原因) 存本机 keys.json 的 relay_verified,
// 阵容下拉按它分 "核实能用" / "没通" / "没核实" (app/src/logic.ts relayModelGroups)。由用户在账号页点"核实"才跑, 控制接口里顺序跑, 界面轮询进度。
// 2026-11-04 晚改: 原来每个模型起一个 Claude Code (`claude -p`, Anthropic 协议) —— 对只认 Responses 协议的 gpt 系列和站里不可用的模型, 它 400 / 500 后还自动重试好几次,
// 46 个模型刷出几千条请求, 站长 czp: "我求求你不要再 DDOS 了" / "去模型广场看看这些模型都是什么协议的"。现在: 按 relay-route.ts 分流 —— Claude 格式发 Anthropic 最小请求,
// Responses 格式发 Responses 最小请求 (input 列表 + 流式, 11-04 实测站只收这种), 只有 Chat 格式的不发直接标"用不了"; 自己发 HTTPS, 不重试, 每个模型最多 1 条、45 秒。
import http from "node:http";
import https from "node:https";
import type { RelayRoute } from "./relay-route.ts";

export type VerifyResult = { ok: boolean; ms: number; text: string; at: string };
export const VERIFY_PROMPT = "只回复两个字: 收到";
/** 每个模型最多等这么久 (gpt 系列带推理, 首字节可能慢) */
export const VERIFY_TIMEOUT_MS = 45_000;

/** Claude Code --output-format json 的输出 → 通没通 + 回了什么 / 错在哪 (result 行; 没有 result 行 = 进程没跑完, 把输出前几百字当原因); 开班前试通 (run.ts probeBrain) 还在用 */
export function parseClaudeJson(out: string, code: number | null): { ok: boolean; text: string } {
  let result: any = null;
  for (const line of out.split(/\r?\n/)) { try { const o = JSON.parse(line); if (o?.type === "result") result = o; } catch { /* 不是 JSON 行 */ } }
  const text = String(result?.result ?? result?.error ?? out).replace(/\s+/g, " ").trim().slice(0, 300);
  return { ok: code === 0 && !!result && !result.is_error, text };
}

/** 最小请求: 路径 + 请求体 (按协议); route none → null (不发) */
export function minimalRequest(route: RelayRoute, model: string): { path: string; body: Record<string, unknown> } | null {
  // 64 个 token: 思考模型 (deepseek-v4-pro / glm-5.3 / kimi…) 16 个全花在思考上写不出字 (11-05 00:5x 实测 7 个被误判)
  if (route === "claude") return { path: "/v1/messages", body: { model, max_tokens: 64, stream: true, messages: [{ role: "user", content: VERIFY_PROMPT }] } };
  if (route === "codex") return { path: "/v1/responses", body: { model, stream: true, max_output_tokens: 64, input: [{ role: "user", content: VERIFY_PROMPT }] } };
  return null;
}

/** 错误回复 (JSON) 里的话; 不是 JSON 就截前 200 字 */
export function errorText(body: string): string {
  try { const o = JSON.parse(body); const m = o?.error?.message ?? o?.message ?? o?.error; if (typeof m === "string" && m) return m.replace(/\s+/g, " ").slice(0, 200); } catch { /* 不是 JSON */ }
  return body.replace(/\s+/g, " ").trim().slice(0, 200) || "(空回复)";
}

/** 流式回复的正文: Anthropic 的 content_block_delta.text / Responses 的 response.output_text.delta; 看到 message_stop / response.completed 算结束 */
export function judgeStream(route: RelayRoute, status: number, body: string): { ok: boolean; text: string } {
  if (status !== 200) return { ok: false, text: `HTTP ${status}: ${errorText(body)}` };
  let reply = "", ended = false, err = "";
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let e: any;
    try { e = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (route === "claude") {
      if (e.type === "content_block_delta" && typeof e.delta?.text === "string") reply += e.delta.text;
      else if (e.type === "message_stop") ended = true;
      else if (e.type === "error") err = String(e.error?.message ?? "出错");
    } else {
      if (e.type === "response.output_text.delta" && typeof e.delta === "string") reply += e.delta;
      else if (e.type === "response.completed" || e.type === "response.incomplete") ended = true;
      else if (e.type === "error" || e.type === "response.failed") err = String(e.error?.message ?? e.response?.error?.message ?? "出错");
    }
  }
  if (err) return { ok: false, text: err.slice(0, 200) };
  if (reply.trim()) return { ok: true, text: reply.replace(/\s+/g, " ").trim().slice(0, 100) };
  // 流正常走到结束但没正文 = 通 (思考模型把 token 都花在思考上; 渠道和协议都没问题); 没到结束就断了才算不通
  return ended ? { ok: true, text: "通 (回复正常结束, 几十个 token 内没写出正文: 思考模型)" } : { ok: false, text: "回复流里没有正文 (没到结束就断了)" };
}

/**
 * 核实一个模型: 按 route 发 1 条最小请求 (自己发, 不重试; 上游连接走系统代理 proxyEnv), 45 秒没完算不通。
 * route none 不发请求, 直接记"用不了" (站只标了 Chat 协议)。
 */
export function verifyRelayModel(o: { url: string; key: string; model: string; route: RelayRoute; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<VerifyResult> {
  const at = () => new Date().toISOString();
  const req = minimalRequest(o.route, o.model);
  if (!req) return Promise.resolve({ ok: false, ms: 0, text: "站只标了 Chat 协议 (openai): Claude Code 和 Codex 都不走它, 没发请求", at: at() });
  return new Promise((resolve) => {
    const t0 = Date.now();
    let target: URL;
    try { target = new URL(o.url.replace(/\/+$/, "") + req.path); } catch { return resolve({ ok: false, ms: 0, text: "站点地址不对", at: at() }); }
    const secure = target.protocol === "https:";
    const env = o.env ?? process.env;
    const agent = secure
      ? new https.Agent({ keepAlive: false, proxyEnv: { HTTP_PROXY: env.HTTP_PROXY, HTTPS_PROXY: env.HTTPS_PROXY, NO_PROXY: env.NO_PROXY, http_proxy: env.http_proxy, https_proxy: env.https_proxy, no_proxy: env.no_proxy } })
      : new http.Agent({ keepAlive: false });
    const data = Buffer.from(JSON.stringify(req.body));
    const headers = { "content-type": "application/json", authorization: `Bearer ${o.key}`, "anthropic-version": "2023-06-01", "content-length": String(data.length) };
    let body = "", status = 0, done = false;
    const finish = (r: { ok: boolean; text: string }) => { if (done) return; done = true; clearTimeout(timer); agent.destroy(); resolve({ ...r, ms: Date.now() - t0, at: at() }); };
    const timer = setTimeout(() => { c.destroy(); finish({ ok: false, text: `${Math.round((o.timeoutMs ?? VERIFY_TIMEOUT_MS) / 1000)} 秒没回完 (断开)` }); }, o.timeoutMs ?? VERIFY_TIMEOUT_MS);
    const c = (secure ? https : http).request(target, { method: "POST", headers, agent }, (res) => {
      status = res.statusCode ?? 0;
      res.on("data", (d: Buffer) => { if (body.length < 200_000) body += d.toString("utf8"); });
      res.on("end", () => finish(judgeStream(o.route, status, body)));
      res.on("error", (e) => finish({ ok: false, text: `读回复出错: ${e.message}`.slice(0, 200) }));
    });
    c.on("error", (e) => finish({ ok: false, text: `连不上站: ${e.message}`.slice(0, 200) }));
    c.end(data);
  });
}

/** 一次核实任务: 顺序跑, 随时能看进度; 同时只允许一个 */
export class VerifyJob {
  running = false; total = 0; done = 0; current: string | null = null; startedAt: string | null = null; finishedAt: string | null = null;
  results: Record<string, VerifyResult> = {};
  status() { return { running: this.running, total: this.total, done: this.done, current: this.current, startedAt: this.startedAt, finishedAt: this.finishedAt, results: this.results }; }
  /** 开始 (已在跑就返回 false); runOne = 核实一个模型; onEach = 每个结果出来就存 */
  start(models: string[], runOne: (model: string) => Promise<VerifyResult>, onEach?: (model: string, r: VerifyResult) => void): boolean {
    if (this.running) return false;
    const list = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
    this.running = true; this.total = list.length; this.done = 0; this.current = null; this.results = {}; this.startedAt = new Date().toISOString(); this.finishedAt = null;
    (async () => {
      for (const m of list) {
        this.current = m;
        let r: VerifyResult;
        try { r = await runOne(m); } catch (e) { r = { ok: false, ms: 0, text: (e as Error).message.slice(0, 300), at: new Date().toISOString() }; }
        this.results[m] = r; this.done++;
        try { onEach?.(m, r); } catch { /* 存不上不影响继续 */ }
      }
      this.current = null; this.running = false; this.finishedAt = new Date().toISOString();
    })();
    return true;
  }
}
