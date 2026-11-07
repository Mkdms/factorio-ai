// 中转站 (New API 这类聚合站) 当大脑的入口 (库, 不直接运行): 按站标的协议分流、本机小代理、一条最小请求核实。
// 分流 (旧项目 2026-11-04 晚的教训: 拿 Claude Code 去打只认 Responses 协议的 gpt 系列, 400 / 500 后它自动重试, 一晚几千条请求): 站的价目表给每个模型标了格式 (anthropic / openai-response / openai)。
//   anthropic → Claude Code (经本机代理去 metadata); 没有 anthropic 但有 openai-response → Codex 命令行 (自定义 model_provider 指向站, 发的正是 Responses + 流式); 只有 openai (Chat) → 仍走 Claude Code, 站转格式;
//   图片 / 视频之类 → 用不了; 站没标 → 按模型名猜 (gpt-* / o* / codex* 当 Responses)。
// 代理: Claude Code → http://127.0.0.1:<端口> → 站。只把请求 JSON 顶层的 metadata 去掉 (站把 Claude 格式转 Responses 时上游不认它), 其余原样透传 (路径、查询串、头、SSE 流)。上游走系统代理 (https.Agent proxyEnv, Node 24.5+)。
// 核实: 每个模型最多 1 条按它协议写的最小请求, 不重试, 45 秒; 排查别人的站最多发 1~2 条, 先问用户。
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

// ---- 分流 ----
export type RelayRoute = "claude" | "codex" | "none";
export type RelayFormats = Record<string, string[]>;
export const looksOpenAi = (model: string): boolean => /^(gpt-|o\d|codex|chatgpt)/i.test(model.trim());

/** 这个模型该由谁发请求: formats = 站标的格式 (没有 / 空 = 没读到) */
export function relayRoute(model: string, formats?: string[]): { route: RelayRoute; why: string } {
  const f = (formats ?? []).map((x) => x.toLowerCase());
  if (!f.length) return looksOpenAi(model) ? { route: "codex", why: "站没标格式, 按名字当 Responses 协议 (走 Codex)" } : { route: "claude", why: "站没标格式, 按名字当 Claude 格式" };
  if (f.includes("anthropic")) return { route: "claude", why: "站标了 Claude 格式" };
  if (f.some((x) => /response/.test(x))) return { route: "codex", why: "站标的是 Responses 协议 (没有 Claude 格式), 走 Codex" };
  if (f.includes("openai")) return { route: "claude", why: "站只标了 Chat 协议, 走 Claude Code 由站转格式" };
  return { route: "none", why: `站只标了 ${f.join(" / ")}, 不是对话模型, 用不了` };
}
export type RelayKind = "anthropic" | "responses" | "chat" | "unusable";
export function relayKind(formats: string[]): RelayKind {
  const f = formats.map((x) => x.toLowerCase());
  if (!f.length || f.includes("anthropic")) return "anthropic";
  if (f.some((x) => /response/.test(x))) return "responses";
  if (f.includes("openai")) return "chat";
  return "unusable";
}
export const formatsOf = (models: { id: string; formats: string[] }[]): RelayFormats => Object.fromEntries(models.map((m) => [m.id, m.formats]));

// ---- 本机代理 ----
export const STRIP_FIELDS = ["metadata"] as const;
export const MAX_BODY = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "proxy-connection", "upgrade", "te", "trailer"]);

/** 请求体: 是 JSON 对象就去掉顶层的 metadata (只动顶层); 不是 JSON 对象 / 没有这个字段就原样 (字节不变) */
export function stripMetadata(body: Buffer): { body: Buffer; stripped: boolean } {
  if (!body.length) return { body, stripped: false };
  let o: unknown;
  try { o = JSON.parse(body.toString("utf8")); } catch { return { body, stripped: false }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { body, stripped: false };
  const rec = o as Record<string, unknown>;
  let stripped = false;
  for (const k of STRIP_FIELDS) if (k in rec) { delete rec[k]; stripped = true; }
  return stripped ? { body: Buffer.from(JSON.stringify(rec), "utf8"), stripped: true } : { body, stripped: false };
}

/** Claude Code 连本机代理用的环境变量: 本机地址不走系统代理 */
export function bypassLocalProxy(e: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const add = ["127.0.0.1", "localhost"];
  const merge = (v: string | undefined) => [...new Set([...(v ?? "").split(",").map((s) => s.trim()).filter(Boolean), ...add])].join(",");
  return { NO_PROXY: merge(e.NO_PROXY ?? e.no_proxy), no_proxy: merge(e.no_proxy ?? e.NO_PROXY) };
}

const errorBody = (message: string) => JSON.stringify({ type: "error", error: { type: "api_error", message } });

export class RelayProxy {
  readonly port: number;
  readonly url: string;
  readonly target: string;
  requests = 0; stripped = 0; errors = 0;
  readonly #server: http.Server;
  readonly #agent: http.Agent | https.Agent;
  constructor(port: number, target: string, server: http.Server, agent: http.Agent | https.Agent) {
    this.port = port; this.url = `http://127.0.0.1:${port}`; this.target = target; this.#server = server; this.#agent = agent;
  }
  close(): Promise<void> {
    return new Promise((resolve) => { this.#server.closeAllConnections(); this.#server.close(() => { this.#agent.destroy(); resolve(); }); });
  }
}

/** 起代理: 监听 127.0.0.1 (端口不给就随机), 请求转到 target (站点根地址, 可带路径前缀)。env = 系统代理用的环境变量 (测试里给 {} 走直连); server 已 unref */
export function startRelayProxy(target: string, opts: { port?: number; env?: NodeJS.ProcessEnv; log?: (s: string) => void } = {}): Promise<RelayProxy> {
  const t = new URL(target.replace(/\/+$/, "") + "/");
  const secure = t.protocol === "https:";
  if (!secure && t.protocol !== "http:") throw new Error(`中转站地址要是 http(s): ${target}`);
  const prefix = t.pathname.replace(/\/$/, "");
  const cleanTarget = `${t.protocol}//${t.host}${prefix}`;
  const env = opts.env ?? process.env;
  const agentOpts = { keepAlive: true, proxyEnv: { HTTP_PROXY: env.HTTP_PROXY, HTTPS_PROXY: env.HTTPS_PROXY, NO_PROXY: env.NO_PROXY, http_proxy: env.http_proxy, https_proxy: env.https_proxy, no_proxy: env.no_proxy } };
  const agent = secure ? new https.Agent(agentOpts) : new http.Agent(agentOpts);
  let proxy: RelayProxy;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) { over = true; res.writeHead(413, { "content-type": "application/json" }); res.end(errorBody(`本机代理: 请求体超过 ${MAX_BODY / 1048576} MB`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("error", () => { /* 那边断了 */ });
    req.on("end", () => {
      if (over) return;
      proxy.requests++;
      let body = Buffer.concat(chunks);
      if (body.length && /json/i.test(String(req.headers["content-type"] ?? ""))) { const r = stripMetadata(body); if (r.stripped) proxy.stripped++; body = r.body; }
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = v;
      headers.host = t.host;
      if (body.length || (req.method !== "GET" && req.method !== "HEAD")) headers["content-length"] = String(body.length);
      const up = (secure ? https : http).request(
        { protocol: t.protocol, hostname: t.hostname, port: t.port || undefined, path: prefix + (req.url ?? "/"), method: req.method, headers, agent },
        (ur) => {
          const h: http.OutgoingHttpHeaders = {};
          for (const [k, v] of Object.entries(ur.headers)) if (k !== "connection" && k !== "transfer-encoding" && k !== "keep-alive" && v !== undefined) h[k] = v;
          res.writeHead(ur.statusCode ?? 502, h);
          res.flushHeaders();
          ur.pipe(res);
          ur.on("error", () => res.destroy());
        },
      );
      up.on("error", (e) => {
        proxy.errors++;
        opts.log?.(`中转站本机代理: 连不上 ${cleanTarget} (${e.message.slice(0, 120)})`);
        if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(errorBody(`本机代理连不上中转站 ${cleanTarget}: ${e.message}`)); }
        else res.destroy();
      });
      res.on("close", () => { if (!res.writableFinished) up.destroy(); });
      up.end(body);
    });
  });
  server.on("connection", (s) => s.setNoDelay(true));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.unref();
      proxy = new RelayProxy((server.address() as AddressInfo).port, cleanTarget, server, agent);
      resolve(proxy);
    });
  });
}

// ---- 核实 ----
export type VerifyResult = { ok: boolean; ms: number; text: string; at: string };
export const VERIFY_PROMPT = "只回复两个字: 收到";
export const VERIFY_TIMEOUT_MS = 45_000;

/** 最小请求: 路径 + 请求体 (按协议); route none → null (不发)。64 个 token: 思考模型 16 个全花在思考上写不出字 */
export function minimalRequest(route: RelayRoute, model: string): { path: string; body: Record<string, unknown> } | null {
  if (route === "claude") return { path: "/v1/messages", body: { model, max_tokens: 64, stream: true, messages: [{ role: "user", content: VERIFY_PROMPT }] } };
  if (route === "codex") return { path: "/v1/responses", body: { model, stream: true, max_output_tokens: 64, input: [{ role: "user", content: VERIFY_PROMPT }] } };
  return null;
}

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
  return ended ? { ok: true, text: "通 (回复正常结束, 几十个 token 内没写出正文: 思考模型)" } : { ok: false, text: "回复流里没有正文 (没到结束就断了)" };
}

/** 核实一个模型: 按 route 发 1 条最小请求 (自己发, 不重试; 上游连接走系统代理), 45 秒没完算不通 */
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
