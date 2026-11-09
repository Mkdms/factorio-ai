// 连注入客户端的程序 (game/client, 搬自 factorio-mcp, 见 NOTICE): 它注入游戏客户端, 经 MCP 协议给我们 工具 (world_query 只读查询、input 键鼠时间线、
// ui_read / ui_action 界面、chat_read / chat_send、player_action 直接发玩家动作、memory_read 读内存、screenshot)。用官方 MCP TypeScript 库, 不自己写协议。
// 它的规矩 (game/client/AGENTS.md): 工具不设超时, 只许测试用的看门狗 —— 这里每次调用的 watchdogMs 只用来判"卡住", 到点先发取消、记录, 不假装成功。
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ROOT, dataRoot } from "../sandbox/paths.ts";

export const CLIENT_DIR = path.join(ROOT, "game", "client");
export const CLIENT_EXE_NAME = "factorio-ai-client.exe";
export const BRIDGE_DLL_NAME = "factorio_ai_bridge.dll";

/** 编好的程序放在数据目录 data/client/ (npm run client:setup 编并拷过去; .env 的 CLIENT_EXE 可指别处) */
export function clientExe(): string {
  return process.env.CLIENT_EXE ?? path.join(dataRoot(), "client", CLIENT_EXE_NAME);
}
/** exe 和旁边的桥 dll 都在 */
export function clientReady(exe = clientExe()): boolean {
  return fs.existsSync(exe) && fs.existsSync(path.join(path.dirname(exe), BRIDGE_DLL_NAME));
}

/**
 * 只读工具: 断线后可以重连重试一次 (结果确定, 重放无害)。动作类 (input、ui_action、chat_send、player_action、set_rendering、attach、detach) 绝不重放:
 * 不盲目重放结果不确定的修改 (上游的规矩)。
 */
export const READ_TOOLS = new Set(["status", "world_query", "world_overview", "ui_read", "input_bindings", "chat_read", "screenshot", "memory_read"]);

/**
 * 0.0.11 (2026-11-09) 起 world_query 的参数要放在一个 `query` 对象里 (selection / fields / limit / reads … 都在里面)。
 * 我们的调用方 (commands/、假接口 game/offgame 经代理转过来的 Lua 读) 原来是平铺写的: 在这里统一包一层, 已经带 query 的原样发。
 * 别的变化要在调用点改: inspect 默认 values 模式不收 limit / offset, 要表的条目写 mode: "entries" (game/client/tools.md "Query sizes")。
 */
export function toolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "world_query" && !("query" in args)) return { query: args };
  return args;
}

export interface CallResult { ok: boolean; ms: number; data?: unknown; text?: string; error?: string; bytes: number; /** 断线类错误 (不是工具自己报错) */ transport?: boolean; retried?: boolean; /** 第一张图片 (base64, 截图用) */ image?: { data: string; mimeType?: string } }

export class GameClient {
  proc: ChildProcess | null = null;
  client: Client | null = null;
  readonly url: string;
  /** 发给模型 / 记进日志的字节数 (字节要记账) */
  bytesIn = 0;
  #callTimes: number[] = [];
  /** 调用前的钩子 (例: 存档保护 —— 存档窗口里先等一等); 返回前不发请求 */
  beforeCall: ((name: string) => Promise<void>) | null = null;
  readonly port: number;
  readonly exe: string;

  constructor(port = 3100, exe = clientExe()) {
    this.port = port;
    this.exe = exe;
    this.url = `http://127.0.0.1:${port}/mcp`;
  }

  callsPerMinute(now = Date.now()) {
    this.#callTimes = this.#callTimes.filter((t) => now - t < 60_000);
    return this.#callTimes.length;
  }

  /** 起程序 (只开 HTTP), 等端口能连上 */
  async start(log: (s: string) => void = () => {}) {
    if (!clientReady(this.exe)) throw new Error(`没有 ${this.exe} 和旁边的 ${BRIDGE_DLL_NAME}: 先 npm run client:setup`);
    this.proc = spawn(this.exe, ["--no-stdio", "--http-port", String(this.port)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.proc.stderr?.on("data", (d) => log(`[client] ${String(d).trim().slice(0, 200)}`));
    for (let i = 0; i < 120; i++) {
      if (this.proc.exitCode !== null) throw new Error(`程序退出了, 退出码 ${this.proc.exitCode}`);
      try { await this.connect(); return; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    throw new Error(`程序 2 分钟内没在 ${this.url} 起来`);
  }

  /** 连一个已经起好的程序 (别的进程挂接着游戏, 不动它) */
  async connect() {
    const c = new Client({ name: "factorio-ai", version: "0.0.1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    this.client = c;
  }
  /** 只断开自己这条连接, 不 detach、不关程序 */
  async disconnect() { try { await this.client?.close(); } catch { /* 已断 */ } this.client = null; }

  async tools(): Promise<string[]> {
    const r = await this.client!.listTools();
    return r.tools.map((t) => t.name);
  }

  /** 调一个工具; 结果是文本就试着按 JSON 解析 */
  async call(name: string, args: Record<string, unknown> = {}, watchdogMs = 60_000): Promise<CallResult> {
    if (this.beforeCall) await this.beforeCall(name);
    this.#callTimes.push(Date.now());
    const first = await this.#callOnce(name, args, watchdogMs);
    if (!first.ok && first.transport && READ_TOOLS.has(name)) {
      try { await this.disconnect(); await this.connect(); } catch { return first; }
      const again = await this.#callOnce(name, args, watchdogMs);
      return { ...again, retried: true };
    }
    return first;
  }

  async #callOnce(name: string, args: Record<string, unknown>, watchdogMs: number): Promise<CallResult> {
    const t0 = Date.now();
    const ctl = new AbortController();
    const dog = setTimeout(() => ctl.abort(), watchdogMs);
    try {
      const r = (await this.client!.callTool({ name, arguments: toolArgs(name, args) }, undefined, { signal: ctl.signal, timeout: watchdogMs + 1000 })) as { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean; structuredContent?: unknown };
      const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      const imageBytes = (r.content ?? []).filter((c) => c.type === "image").reduce((n, c) => n + Math.floor(((c.data ?? "").length * 3) / 4), 0);
      this.bytesIn += text.length + imageBytes;
      let data: unknown = r.structuredContent;
      if (data === undefined) { try { data = JSON.parse(text); } catch { /* 不是 JSON 就留原文 */ } }
      const img = (r.content ?? []).find((c) => c.type === "image");
      return { ok: !r.isError, ms: Date.now() - t0, data, text: r.isError ? text.slice(0, 500) : undefined, error: r.isError ? text.slice(0, 500) : undefined, bytes: text.length + imageBytes, ...(img?.data ? { image: { data: img.data, mimeType: img.mimeType } } : {}) };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: ctl.signal.aborted ? `看门狗: ${watchdogMs}ms 没回 (已发取消)` : (e as Error).message.slice(0, 500), bytes: 0, transport: !ctl.signal.aborted };
    } finally {
      clearTimeout(dog);
    }
  }

  /** 从游戏上摘下来并关程序 */
  async stop() {
    try { await this.call("detach", {}, 15_000); } catch { /* 已断开 */ }
    try { await this.client?.close(); } catch { /* 忽略 */ }
    if (this.proc?.pid && process.platform === "win32") spawn("taskkill", ["/pid", String(this.proc.pid), "/t", "/f"], { stdio: "ignore" });
    else this.proc?.kill();
    this.proc = null;
  }
}
