// 模型命令的本地中转: 模型的命令行只连得到这里 (127.0.0.1 + 每个角色一个令牌), 这里只把"角色的动作"转进游戏, 别的什么都不转。
// 这样模型手里没有 RCON 密码、没有 Lua、也冒充不了别的角色 (令牌和角色绑定)。
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AgentReply, AgentRequest } from "../game/sandbox/agents.ts";

export type Dispatch = (req: AgentRequest) => Promise<AgentReply>;
export type Broker = { url: string; port: number; tokens: Map<string, string>; close: () => Promise<void> };

const MAX_BODY = 1024 * 1024;

export function newToken(): string { return randomBytes(18).toString("base64url"); }

/** 令牌 → 角色; 对不上回 null */
export function whoOf(tokens: Map<string, string>, auth: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/.exec(auth ?? "");
  if (!m) return null;
  for (const [who, t] of tokens) if (t === m[1]) return who;
  return null;
}

/** 起中转: tokens 里每个角色一个令牌 (没给就现生成) */
export function startBroker(o: { dispatch: Dispatch; agents: string[]; tokens?: Map<string, string>; port?: number }): Promise<Broker> {
  const tokens = new Map(o.tokens ?? []);
  for (const a of o.agents) if (!tokens.has(a)) tokens.set(a, newToken());
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/ping") return send(200, { ok: true });
    if (req.method !== "POST" || req.url !== "/act") return send(404, { ok: false, error: { code: "not_found", message: "只有 POST /act" } });
    const who = whoOf(tokens, req.headers.authorization);
    if (!who) return send(401, { ok: false, error: { code: "unauthorized", message: "令牌不对" } });
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { req.destroy(); return; } chunks.push(c); });
    req.on("end", async () => {
      let body: AgentRequest;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { ok: false, error: { code: "bad_json", message: "请求不是 JSON" } }); }
      if (!body || typeof body.action !== "string") return send(400, { ok: false, error: { code: "bad_request", message: "缺少 action" } });
      // 角色由令牌定, 请求里写的 who 不算数 (冒充不了别人)
      try { send(200, await o.dispatch({ id: typeof body.id === "string" ? body.id : undefined, who, action: body.action, args: body.args && typeof body.args === "object" ? body.args : {} })); }
      catch (e) { send(502, { ok: false, error: { code: "game_unreachable", message: (e as Error).message.slice(0, 300) } }); }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      // 关的时候把保持着的连接也断掉 (fetch 默认复用连接, 不断的话 close 一直等)
      resolve({ url: `http://127.0.0.1:${port}`, port, tokens, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) });
    });
  });
}
