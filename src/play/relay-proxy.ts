// 中转站本机代理 (库, 不直接运行;  → 不是单独装的程序:
// run.ts 开班、control.ts 核实模型时在自己进程里起一个, 界面不用另开任何东西)。
// Claude Code → http://127.0.0.1:<端口> → 中转站 (New API)。只做一件事: 把请求 JSON 顶层的 metadata 字段去掉, 其余 (路径、查询串、头、响应流 SSE、压缩) 原样透传。
// 为什么: Claude Code 每次请求带 metadata.user_id (Anthropic Messages API 的可选字段, 给 Anthropic 做滥用统计); New API 把 Claude 格式转成 GPT 渠道的
// Responses 格式时把它原样带过去, 上游回 "400 Unsupported parameter: metadata" (2026-11-04 gpt-6.1-terra 实测); 对 Claude 格式的渠道去掉它也无害。
// 站长在渠道里过滤掉这个字段是另一条路, 用户要两条都保留 (官方 Codex 和中转都能选)。
// 上游连接走系统代理: https.Agent 的 proxyEnv (Node 官方文档 http.html "new Agent": v24.5.0 加, 读 HTTP_PROXY / HTTPS_PROXY / NO_PROXY; 2026-11-04 读, 本机 Node 26.13;
// 本机实测直连站 ECONNRESET、经 HTTPS_PROXY 通); Claude Code 连本机代理则要绕过系统代理 (bypassLocalProxy 给 NO_PROXY 加 127.0.0.1)。
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

/** 从请求 JSON 顶层去掉的字段 */
export const STRIP_FIELDS = ["metadata"] as const;
/** 请求体上限 (Claude Code 一次请求连上下文一般 1~2 MB) */
export const MAX_BODY = 64 * 1024 * 1024;
/** 不往上游转的逐跳头 (host 换成站的, 长度按改过的请求体重算) */
const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "proxy-connection", "upgrade", "te", "trailer"]);

/** 请求体: 是 JSON 对象就去掉顶层的 metadata (只动顶层, 不碰 messages 里同名的键); 不是 JSON 对象 / 没有这个字段就原样 (字节不变) */
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

/** Claude Code 连本机代理用的环境变量: 本机地址不走系统代理 (HTTPS_PROXY 设了而 NO_PROXY 没写 127.0.0.1 的话, 到 127.0.0.1 的请求也会被送去系统代理) */
export function bypassLocalProxy(e: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const add = ["127.0.0.1", "localhost"];
  const merge = (v: string | undefined) => [...new Set([...(v ?? "").split(",").map((s) => s.trim()).filter(Boolean), ...add])].join(",");
  return { NO_PROXY: merge(e.NO_PROXY ?? e.no_proxy), no_proxy: merge(e.no_proxy ?? e.NO_PROXY) };
}

/** 回给 Claude Code 的错误体, 照 Anthropic 接口的形状 (它会把 message 显示出来) */
const errorBody = (message: string) => JSON.stringify({ type: "error", error: { type: "api_error", message } });

export class RelayProxy {
  readonly port: number;
  /** 本机地址 (给 ANTHROPIC_BASE_URL 用, 不带 /v1) */
  readonly url: string;
  /** 转去的站 (协议 + 主机 + 路径前缀, 不带末尾 /) */
  readonly target: string;
  requests = 0; stripped = 0; errors = 0;
  readonly #server: http.Server;
  readonly #agent: http.Agent | https.Agent;
  // (Node 只去类型不转语法: 构造参数属性 readonly x 这种写法不支持, 字段都显式声明)
  constructor(port: number, target: string, server: http.Server, agent: http.Agent | https.Agent) {
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.target = target;
    this.#server = server;
    this.#agent = agent;
  }
  /** 关掉: 断开还连着的, 不再接新的 */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.closeAllConnections();
      this.#server.close(() => { this.#agent.destroy(); resolve(); });
    });
  }
}

/**
 * 起代理: 监听 127.0.0.1 (端口不给就随机), 请求转到 target (站点根地址, 可带路径前缀, 末尾 / 和 /v1 都不用)。
 * env = 系统代理用的环境变量 (默认 process.env; 测试里给 {} 走直连); server 已 unref, 不会撑着进程不退 (2026-11-04 unref 的教训)。
 */
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
    req.on("error", () => { /* Claude Code 那边断了 */ });
    req.on("end", () => {
      if (over) return;
      proxy.requests++;
      let body = Buffer.concat(chunks);
      if (body.length && /json/i.test(String(req.headers["content-type"] ?? ""))) {
        const r = stripMetadata(body);
        if (r.stripped) proxy.stripped++;
        body = r.body;
      }
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
          res.flushHeaders(); // SSE: 头先到, 事件一条条流过去
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
      res.on("close", () => { if (!res.writableFinished) up.destroy(); }); // Claude Code 中途断了 (被监工打断): 上游也断, 不白跑
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
