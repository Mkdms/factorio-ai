// ./fh ↔ 游戏外的模组 (库): 接在派对命令行的 FH_SOCKET 上, 命令行、输出格式、--wait 都不用改。
// 协议 (派对 vendor/factorio-harness dist/host/broker.js, 2026-11-06 读): 一行 {"command": "<RCON 命令>"} 进, 一行 {"ok": true, "text": "<回复>"} 或 {"ok": false, "error": "...", "refused"?: true, "unavailable"?: true} 出, 一次一问。
// 读命令给 game/offgame/host.py --serve 答 (每次现读内存); 别的: 沙盘转发真 RCON (mode = sandbox), 真服上没有 RCON, 明确拒绝 (mode = server), 不假装成功。
import fs from "node:fs";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EXISTING_LUA } from "../src/play/expand.ts";
import { siteLua } from "../src/play/plan-lib.ts";

export type BrokerMode = "sandbox" | "server";
export type Dispatch = { raw: string; request: { id?: string; action?: string; args?: Record<string, unknown>; bot?: string; player?: number } };

const DISPATCH_RE = /^\/silent-command rcon\.print\(remote\.call\("agent_harness", "dispatch", \[(=*)\[\n([\s\S]*)\]\1\]\)\)$/;

/** 派对命令行发的 RCON 命令 → 里面那条请求; 不是这个形状 (装模组、看上限这些) → null */
export function parseDispatch(command: string): Dispatch | null {
  const m = DISPATCH_RE.exec(command);
  if (!m) return null;
  try { return { raw: m[2], request: JSON.parse(m[2]) as Dispatch["request"] }; } catch { return null; }
}

/** 外面答得和模组一样的读命令 (旧项目逐项核过 1936 项差 7 项; 新加要先核)。别的读命令还靠模组记的账或背景任务。
 *  派对命令行把 nearest、stock 这些视图发成 observe + args.scope (harness.js OBSERVE_SCOPES), 所以这里按视图名。
 *  scan 不在里面: 电线连接和地上物品内存还没读, 2026-11-06 核出来 854 项差 32 项 */
export const MEM_READS = new Set(["inventory", "observe", "inspect", "status", "nearest", "stock"]);

export type Route = "mem" | "rcon" | "refuse";
/** 这条请求实际是哪个读命令: observe 带 scope 的算 scope */
export function viewOf(d: Dispatch): string {
  const scope = d.request.args?.scope;
  return d.request.action === "observe" && typeof scope === "string" ? scope : d.request.action ?? "";
}
/** 这条请求走哪 (纯函数)。沙盘混着跑时动作在游戏里的模组上, status brief 和 sleep_check (看动作走到哪了) 必须问它, 不在 MEM_READS 里的也问它 */
export function routeOf(d: Dispatch | null, mode: BrokerMode): Route {
  if (!d) return mode === "sandbox" ? "rcon" : "refuse";
  if (mode === "sandbox") return MEM_READS.has(viewOf(d)) && d.request.args?.brief !== true ? "mem" : "rcon";
  return "mem"; // 真服: 全部问外面, 动作被模组的只读闸门拒掉 (下面按拒绝回)
}

/** 模组的只读闸门拒了这条: 是动作, 不是读 */
export function isReaderRefusal(text: string): boolean {
  try { const r = JSON.parse(text) as { ok?: boolean; error?: { message?: string } | string }; const m = typeof r.error === "string" ? r.error : r.error?.message; return r.ok === false && /acts as the agent/.test(m ?? ""); } catch { return false; }
}

export type WhereInfo = {
  player: { name?: string; index?: number; admin?: boolean; position?: { x: number; y: number }; unit?: number };
  hasBody: boolean;
  surfaces: { name: string; index: number; chunks: number; entities: number; mine: number; dropped: number; here: boolean }[];
};

export type BrokerStats = { mem: number; rcon: number; refused: number; acted: number; memMs: number; byAction: Record<string, { route: Route | "act" | "ledger"; n: number; ms: number }> };

/** 模组自己账本上的命令: 不碰游戏, 在外面的模组里照常跑 (M4 第 4 步; 新加要先核 test/sandbox/actions.test.ts) */
export const LEDGER = new Set(["sleep", "chat_ack", "tell"]);

/** ./fh call research 不带要改的参数是查队列, 模组自己答, 不碰游戏 (2026-11-06 真服第二班: 原来当成要改研究给拒了) */
export function isResearchRead(d: Dispatch): boolean {
  if (d.request.action !== "research") return false;
  const a = d.request.args ?? {};
  return ["technology", "research_queue", "remove", "cancel", "move", "target_level"].every((k) => a[k] === undefined);
}

/** 模组宿主第一次起来最多等多久 */
const HOST_READY_MS = 300_000;

/** 做完的动作结果留多久 (命令行 90 秒内会用同一个 id 重发) */
const ACT_REPLY_KEEP_MS = 120_000;

type Reply = { ok: boolean; text?: string; error?: string; refused?: boolean; unavailable?: boolean };

/** 真服上真正动手的那层 (commands/actions.ts): 回复格式照模组 */
export type ActionLayer = { has(action: string): boolean; run(request: Dispatch["request"]): Promise<unknown> };

/** luaRead: 内存读不到的问注入客户端的 Lua (注入客户端的程序 world_query); 不给就不注入, 这些字段和原来一样记缺 */
export type BrokerOpts = { onOperator?: (text: string) => void; pipe: string; python: string; probeArgs: string[]; mode: BrokerMode;rcon?: { send(command: string): Promise<string> } | null; actions?: ActionLayer | null; luaRead?: ((args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>) | null };

export class CommandBroker {
  readonly stats: BrokerStats = { mem: 0, rcon: 0, refused: 0, acted: 0, memMs: 0, byAction: {} };
  private child: ChildProcessWithoutNullStreams | null = null;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  /** 模型问管理员的话只报一次 (命令行会用同一个 id 重发) */
  private readonly operatorSeen = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly acting = new Map<string, Promise<{ ok: boolean; text?: string; error?: string }>>();
  private readonly reading = new Map<string, Promise<Reply>>();
  private actQueue: Promise<unknown> = Promise.resolve();
  private waiters: ((line: string) => void)[] = [];
  private buf = "";
  private stderr = "";
  private readonly opts: BrokerOpts;

  constructor(opts: BrokerOpts) { this.opts = opts; }

  /** 假接口问注入客户端的 Lua (world_query, 只开放被动查询): 查完写回去。只留 objects 这些, 玩家信封不要 */
  private async answerLua(line: string): Promise<void> {
    let seq = 0;
    let out: Record<string, unknown>;
    try {
      const m = JSON.parse(line) as { lua_read: Record<string, unknown>; seq: number };
      seq = m.seq;
      const r = await this.opts.luaRead!(m.lua_read);
      const d = (r.data ?? {}) as { objects?: unknown; truncated?: unknown; next_offset?: unknown };
      out = r.ok ? { lua_reply: seq, ok: true, data: { objects: d.objects ?? [], truncated: d.truncated, next_offset: d.next_offset } } : { lua_reply: seq, ok: false, error: r.error };
    } catch (e) { out = { lua_reply: seq, ok: false, error: (e as Error).message }; }
    if (this.child && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(out)}\n`);
  }

  /** 起模组宿主, 再开管道。平时加载模组 + 解析原型约 2 秒; 第一次没有布局缓存要现算 (pdb-dump 约 1 秒一项, 2026-11-06 全新目录 60 秒不够), 所以等得久, 宿主真退了立刻报 */
  async start(): Promise<void> {
    const child = spawn(this.opts.python, [...this.opts.probeArgs, ...(this.opts.luaRead ? ["--lua"] : [])], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (s: string) => {
      this.buf += s;
      for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        // 假接口要读内存读不到的: 中途回问一句, 不是这次提问的回复
        if (line.startsWith('{"lua_read"')) void this.answerLua(line);
        else this.waiters.shift()?.(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (s: string) => { this.stderr = (this.stderr + s).slice(-2000); });
    const gone = new Promise<never>((_, reject) => child.once("close", (code) => reject(new Error(`模组宿主退出了 (退出码 ${code}): ${this.stderr.slice(-400)}`))));
    const ready = JSON.parse(await Promise.race([this.nextLine(HOST_READY_MS), gone])) as { ready?: boolean; load?: { ok: boolean; error?: string } };
    if (!ready.load?.ok) throw new Error(`模组宿主加载失败: ${ready.load?.error}`);
    await new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => this.serve(socket));
      this.server.once("error", reject);
      this.server.listen(this.opts.pipe, () => resolve());
    });
  }

  private nextLine(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`模组宿主 ${timeoutMs / 1000} 秒没回: ${this.stderr.slice(-400)}`)), timeoutMs);
      timer.unref();
      this.waiters.push((line) => { clearTimeout(timer); resolve(line); });
    });
  }

  /** 一次问一个 (Lua 是单线程) */
  private ask(raw: string, act = false): Promise<{ ms?: number; text?: string; exception?: string }> {
    const run = () => this.ask2(raw, act);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  protected async ask2(raw: string, act = false): Promise<{ ms?: number; text?: string; exception?: string }> {
    this.child!.stdin.write(`${JSON.stringify(act ? { raw, act: true } : { raw })}\n`);
    return JSON.parse(await this.nextLine(120_000)) as { ms?: number; text?: string; exception?: string };
  }

  /** 问模组宿主一条不经模组的 (where、stats): 和读命令排同一个队 */
  private askProbe(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = async () => { this.child!.stdin.write(`${JSON.stringify(req)}\n`); return JSON.parse(await this.nextLine(180_000)) as Record<string, unknown>; };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** 本地玩家在哪, 世界有哪些地表、各有多少东西 (要读全部地表, 只在开班问) */
  async where(): Promise<WhereInfo> {
    const r = await this.askProbe({ where: true });
    if (typeof r.exception === "string") throw new Error(`读不到玩家和地表: ${r.exception.slice(0, 300)}`);
    return r as unknown as WhereInfo;
  }

  /** 在游戏外的假接口上跑一段只读 Lua (写法和 RCON 上的一样, 开班扫描用; 服务器上一条都不跑), 回 JSON */
  async evalLua(code: string): Promise<unknown> {
    const r = await this.askProbe({ eval: code });
    if (typeof r.exception === "string") throw new Error(r.exception.slice(0, 500));
    return JSON.parse(String(r.text));
  }

  /** 现在的 tick (读内存, 不问模组) */
  async tick(): Promise<number> { return Number((await this.askProbe({ tick: true })).tick ?? 0); }

  /** 后台任务跑得怎么样、假接口缺了什么 (真服上跑完留底, 看真实世界还差哪些) */
  probeStats(): Promise<Record<string, unknown>> { return this.askProbe({ stats: true }); }

  /** 行动层自己要问模组一句读 (放不下时找附近放得下的位置: placements): 直接问宿主, 和读命令排同一个队; 问不到 / 模组报错回 null, 不盖过动作本身的错 */
  async read(action: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      const row = await this.ask(JSON.stringify({ id: `act-${Date.now().toString(36)}`, action, args }));
      if (row.exception !== undefined || row.text === undefined) return null;
      const r = JSON.parse(row.text) as { ok?: boolean; result?: Record<string, unknown> };
      return r.ok === true && r.result && typeof r.result === "object" ? r.result : null;
    } catch { return null; }
  }

  private count(action: string, route: Route | "act" | "ledger", ms: number): void {
    const a = (this.stats.byAction[action] ??= { route, n: 0, ms: 0 });
    a.route = route; a.n++; a.ms += ms;
    if (route === "mem") { this.stats.mem++; this.stats.memMs += ms; } else if (route === "rcon") this.stats.rcon++; else if (route === "act" || route === "ledger") this.stats.acted++; else this.stats.refused++;
  }

  /**
   * 跑一个动作。派对命令行等 5 秒没回就用同一个 id 重发, 90 秒内一直重发 (dist/host/broker.js、harness.js requestRetrying; 游戏里的模组靠 id 去重), 而玩家操作常要好几秒:
   * 同一个 id 接到第一次的结果上, 不再做一遍 (2026-11-06 第一轮核对: 挖矿、批量放电线杆都被并发做了几次, 报 "Input is busy")。做完的结果留一会, 重发晚到也能答
   */
  private act(d: Dispatch, action: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    const id = d.request.id;
    const known = id ? this.acting.get(id) : undefined;
    if (known) return known;
    const p = (async () => {
      const t0 = Date.now();
      // 一个身体同一时间只做一件事: 别的命令行进程来的动作排队 (Lua 那边一次问一个, 这边同样)
      const reply = await this.opts.actions!.run(d.request);
      this.count(action, "act", Date.now() - t0);
      return { ok: true, text: JSON.stringify(reply) };
    })();
    const run = this.actQueue.then(() => p, () => p);
    if (id) {
      this.acting.set(id, p);
      void run.finally(() => { const timer = setTimeout(() => this.acting.delete(id), ACT_REPLY_KEEP_MS); timer.unref?.(); });
    }
    return p;
  }

  /** 我们自己递话给模型 (真人的话; human-chat-bridge.ts tellCommands)。operator 请求只从这里进: 模组的规矩是不走 ./fh, 管道上来的 handle 会拒 */
  async operatorCall(command: string): Promise<Reply> {
    const d = parseDispatch(command);
    if (!d) return { ok: false, error: "不是请求" };
    const r = await this.ask(d.raw, true);
    if (r.exception !== undefined || r.text === undefined) return { ok: false, error: `模组宿主出错: ${String(r.exception).slice(0, 300)}` };
    return { ok: true, text: r.text };
  }

  /** 一条 RCON 命令 → 回给命令行的那一行 */
  async handle(command: string): Promise<Reply> {
    const d = parseDispatch(command);
    const action = d ? viewOf(d) : "(不是请求)";
    if (this.opts.mode === "server" && (d?.request as { operator?: unknown } | undefined)?.operator === true) { this.count(action, "refuse", 0); return { ok: false, refused: true, error: "operator 请求不走 ./fh" }; }
    // 模型问管理员: 联机没有监工和界面在收, 不报出来就没人看见 (2026-11-06 真服第一班, 模型等答复等了 9 分钟)
    if (this.opts.mode === "server" && action === "operator" && d?.request.id && !this.operatorSeen.has(d.request.id)) {
      this.operatorSeen.add(d.request.id);
      const text = (d.request.args as { text?: unknown } | undefined)?.text;
      if (typeof text === "string") this.opts.onOperator?.(text);
    }
    // ./plan 的两段固定只读 Lua (场上已有的机器和科技、找空地) 在游戏外的假接口上跑: 模型手里仍没有自己写 Lua 的口, 只能点这两个名字
    if (this.opts.mode === "server" && d && action === "plan_read") return this.planRead(d);
    // 真服上能翻译成玩家操作的先走行动层, 不问模组: craft、say、research 这些模组的只读闸门不拦 (它们不打断队列), 在外面的假接口上跑会报怪错 (2026-11-06 核出来)
    if (this.opts.mode === "server" && d && this.opts.actions?.has(action) && !isResearchRead(d)) return this.act(d, action);
    // 读也会被重发: 世界大了一次读超过 5 秒, 命令行用同一个 id 再发, 请求越堆越慢 (注入客户端的程序 的存档 41MB, 沙盘 1.7MB)。一模一样的请求接到第一次的结果上
    if (this.opts.mode === "server" && d?.request.id) {
      const known = this.reading.get(d.raw);
      if (known) return known;
      const p = this.answer(command, d, action);
      this.reading.set(d.raw, p);
      void p.finally(() => { const timer = setTimeout(() => this.reading.delete(d.raw), ACT_REPLY_KEEP_MS); timer.unref?.(); }).catch(() => undefined);
      return p;
    }
    return this.answer(command, d, action);
  }

  /** plan_read {what: existing} / {what: site, near, w, h, taken} → src/play 里那两段 Lua 的结果 (Harness 形状的回复: {ok, result}) */
  private async planRead(d: Dispatch): Promise<Reply> {
    const a = (d.request.args ?? {}) as { what?: string; near?: [number, number] | null; w?: number; h?: number; taken?: { x: number; y: number; w: number; h: number }[] };
    const lua = a.what === "existing" ? EXISTING_LUA : a.what === "site" ? siteLua(Array.isArray(a.near) ? [Number(a.near[0]), Number(a.near[1])] : null, Number(a.w), Number(a.h), Array.isArray(a.taken) ? a.taken : []) : null;
    if (!lua) { this.count("plan_read", "refuse", 0); return { ok: false, refused: true, error: "plan_read 只认 what = existing / site" }; }
    const t0 = Date.now();
    try {
      const result = await this.evalLua(lua);
      this.count("plan_read", "mem", Date.now() - t0);
      return { ok: true, text: JSON.stringify({ ok: true, result }) };
    } catch (e) {
      this.count("plan_read", "refuse", 0);
      return { ok: true, text: JSON.stringify({ ok: false, error: { code: "plan_read", message: `游戏外的假接口跑不了: ${(e as Error).message.slice(0, 300)}` } }) };
    }
  }

  private async answer(command: string, d: Dispatch | null, action: string): Promise<Reply> {
    let route = routeOf(d, this.opts.mode);
    if (route === "mem") {
      const row = await this.ask(d!.raw);
      if (row.exception !== undefined || row.text === undefined) { this.count(action, "refuse", 0); return { ok: false, error: `模组宿主出错: ${String(row.exception).slice(0, 300)}`, unavailable: true }; }
      if (!isReaderRefusal(row.text)) { this.count(action, "mem", row.ms ?? 0); return { ok: true, text: row.text }; }
      // 是动作: 沙盘转发; 真服上账本命令在外面的模组里跑, 能翻译成玩家操作的走行动层, 别的拒绝
      if (this.opts.mode === "server" && (LEDGER.has(action) || (d && isResearchRead(d)))) {
        const ledger = await this.ask(d!.raw, true);
        if (ledger.exception !== undefined || ledger.text === undefined) { this.count(action, "refuse", 0); return { ok: false, error: `模组宿主出错: ${String(ledger.exception).slice(0, 300)}`, unavailable: true }; }
        this.count(action, "ledger", ledger.ms ?? 0);
        return { ok: true, text: ledger.text };
      }
      route = this.opts.mode === "sandbox" ? "rcon" : "refuse";
    }
    if (route === "rcon" && this.opts.rcon) {
      this.count(action, "rcon", 0);
      try { return { ok: true, text: await this.opts.rcon.send(command) }; } catch (e) { return { ok: false, error: `RCON 出错: ${(e as Error).message}`, unavailable: true }; }
    }
    this.count(action, "refuse", 0);
    return { ok: false, refused: true, error: `${action}: 这条路还不能做这个动作 (联机走玩家操作, M4 第 4 步只做了常用的), 什么都没发给游戏` };
  }

  private serve(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    serveLines(socket, (c) => this.handle(c));
  }

  async stop(): Promise<void> {
    // 还开着的连接先断: server.close 要等它们, 模型留下的 ./fh sleep 300 让收尾卡了 2 分钟 (2026-11-06 真服)
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => { if (this.server) this.server.close(() => resolve()); else resolve(); });
    if (this.child) { this.child.stdin.end(); this.child.kill(); }
    if (!process.platform.startsWith("win")) { try { fs.rmSync(this.opts.pipe); } catch { /* 没有 */ } }
  }
}

/** FH_SOCKET 的协议: 一行进一行出, 同一条连接按顺序答 */
function serveLines(socket: net.Socket, handle: (command: string) => Promise<Reply>): void {
  let buf = "";
  socket.setEncoding("utf8");
  let chain: Promise<unknown> = Promise.resolve();
  socket.on("data", (s: string) => {
    buf += s;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      chain = chain.then(async () => {
        let out;
        try { out = await handle((JSON.parse(line) as { command: string }).command); } catch (e) { out = { ok: false, error: (e as Error).message, unavailable: true }; }
        if (!socket.destroyed) socket.write(`${JSON.stringify(out)}\n`);
      });
    }
  });
  socket.on("error", () => undefined);
}

/**
 * 联机服务器走 RCON + 模组时: ./fh 经管道到这里, 这里连服务器的 RCON。不让 ./fh 直连: 那样地址写进角色目录的 ./fh 脚本, 而角色目录进备份 (地址密码只放 keys.json)。
 * 只读 (readOnly): 动作在这里就拒了; 读请求带上 reader, 模组不占角色的提醒和计时 (派对流媒体服务也这么读)。服务器角色没造, 所以身份换成 1 号玩家。
 */
export class RconPipe {
  readonly stats = { sent: 0, refused: 0 };
  private server: net.Server | null = null;
  private readonly opts: { pipe: string; send(command: string): Promise<string>; readOnly?: boolean; actions?: ActionLayer | null };

  constructor(opts: { pipe: string; send(command: string): Promise<string>; readOnly?: boolean; actions?: ActionLayer | null }) { this.opts = opts; }

  async handle(command: string): Promise<Reply> {
    let out = command;
    if (this.opts.readOnly) {
      const d = parseDispatch(command);
      if (!d) { this.stats.refused++; return { ok: false, refused: true, error: "只读: 这条不是读请求, 什么都没发给游戏" }; }
      const action = viewOf(d);
      if (this.opts.actions?.has(action)) { this.stats.refused++; return { ok: true, text: JSON.stringify(await this.opts.actions.run(d.request)) }; }
      const { bot: _bot, ...rest } = d.request; void _bot;
      const json = JSON.stringify({ ...rest, player: rest.player ?? 1, reader: "ext" });
      let eq = "";
      while (json.includes(`]${eq}]`) || json.endsWith(`]${eq}`)) eq += "=";
      out = `/silent-command rcon.print(remote.call("agent_harness", "dispatch", [${eq}[\n${json}]${eq}]))`;
    }
    this.stats.sent++;
    try { return { ok: true, text: await this.opts.send(out) }; } catch (e) { return { ok: false, error: `RCON 出错: ${(e as Error).message}`, unavailable: true }; }
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => serveLines(socket, (c) => this.handle(c)));
      this.server.once("error", reject);
      this.server.listen(this.opts.pipe, () => resolve());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => { if (this.server) this.server.close(() => resolve()); else resolve(); });
    if (!process.platform.startsWith("win")) { try { fs.rmSync(this.opts.pipe); } catch { /* 没有 */ } }
  }
}
