// Source RCON 客户端 (Factorio 的 --rcon-port)。
// - 回复按包的 id 认领, 不靠先后顺序: 有玩家连着时, 涉及玩家的命令会晚一个 tick 才执行, 回复会比后发的命令晚到
//   (2.1.24 实测); Factorio 每条命令只回一个包, 20 万字的回复也是一个包 (实测), 所以不用拼包。
// - 连不上时按退避重试 (服务器启动中、存档中); 超时只作废这一条 (迟到的回复丢掉), 只读命令重连后重试一次。
// - 存活检测: heartbeat() 定时发一条便宜的命令, 连续失败就标记为断开并发 "dead" 事件。
import net from "node:net";
import { EventEmitter } from "node:events";

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;

export interface RconOptions {
  host?: string;
  port: number;
  password: string;
  /** 单条命令超时 (毫秒), 默认 60 秒 */
  timeoutMs?: number;
  /** connect() 总共最多等多久 (毫秒), 默认 120 秒 */
  connectDeadlineMs?: number;
}

interface Pending {
  resolve: (s: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf; // 最后两个字节已是 0
}

/** 从缓冲区里切出完整的包; 返回剩下的半截 */
export function decodePackets(buf: Buffer): { packets: { id: number; type: number; body: string }[]; rest: Buffer } {
  const packets: { id: number; type: number; body: string }[] = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const size = buf.readInt32LE(off);
    if (buf.length - off - 4 < size) break;
    const id = buf.readInt32LE(off + 4);
    const type = buf.readInt32LE(off + 8);
    const body = buf.toString("utf8", off + 12, off + 4 + size - 2);
    packets.push({ id, type, body });
    off += 4 + size;
  }
  return { packets, rest: buf.subarray(off) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RconError extends Error {
  code: "connect" | "auth" | "timeout" | "closed";
  constructor(code: RconError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export class RconClient extends EventEmitter {
  readonly opts: Required<RconOptions>;
  #sock: net.Socket | null = null;
  #buf: Buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #heartbeat: NodeJS.Timeout | null = null;
  #misses = 0;
  alive = false;

  constructor(opts: RconOptions) {
    super();
    this.opts = { host: "127.0.0.1", timeoutMs: 60_000, connectDeadlineMs: 120_000, ...opts };
  }

  /** 连接并认证; 服务器还没起来时按退避重试直到期限 */
  async connect(): Promise<void> {
    const deadline = Date.now() + this.opts.connectDeadlineMs;
    let wait = 250;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        await this.#connectOnce();
        this.alive = true;
        this.#misses = 0;
        return;
      } catch (e) {
        last = e;
        if (e instanceof RconError && e.code === "auth") throw e; // 密码错不重试
        await sleep(wait);
        wait = Math.min(wait * 2, 3000);
      }
    }
    throw new RconError("connect", `RCON 连不上 ${this.opts.host}:${this.opts.port}: ${String(last)}`);
  }

  #connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
      sock.setNoDelay(true);
      const authId = this.#nextId++;
      let done = false;
      const fail = (e: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      };
      const timer: NodeJS.Timeout = setTimeout(() => fail(new RconError("timeout", "RCON 认证超时")), 10_000);
      sock.once("error", fail);
      sock.once("connect", () => sock.write(encodePacket(authId, TYPE_AUTH, this.opts.password)));
      let buf = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const { packets, rest } = decodePackets(buf);
        buf = rest;
        for (const p of packets) {
          if (p.type !== TYPE_EXEC) continue; // 认证回复的类型码也是 2
          if (p.id === -1) return fail(new RconError("auth", "RCON 密码错误"));
          if (p.id === authId) {
            done = true;
            clearTimeout(timer);
            sock.off("data", onData);
            sock.off("error", fail);
            this.#attach(sock, rest);
            resolve();
            return;
          }
        }
      };
      sock.on("data", onData);
    });
  }

  #attach(sock: net.Socket, rest: Buffer) {
    this.#sock = sock;
    this.#buf = rest;
    sock.on("data", (d: Buffer) => this.#onData(d));
    const lost = (why: string) => {
      if (this.#sock !== sock) return;
      this.#sock = null;
      this.alive = false;
      const err = new RconError("closed", `RCON 连接断开: ${why}`);
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.#pending.clear();
      this.emit("close", err);
    };
    sock.on("error", (e) => lost(e.message));
    sock.on("close", () => lost("对方关闭"));
  }

  #onData(d: Buffer) {
    this.#buf = Buffer.concat([this.#buf, d]);
    const { packets, rest } = decodePackets(this.#buf);
    this.#buf = rest;
    for (const p of packets) {
      if (process.env.RCON_DEBUG) console.error(`[rcon] 收到 id=${p.id} type=${p.type} 长度=${p.body.length} ${JSON.stringify(p.body.slice(0, 60))}`);
      const pend = this.#pending.get(p.id);
      if (!pend) continue; // 已超时作废的迟到回复
      this.#pending.delete(p.id);
      clearTimeout(pend.timer);
      pend.resolve(p.body);
    }
  }

  /** 执行一条控制台命令, 返回服务器打印的文字 */
  async exec(command: string, opts: { timeoutMs?: number; retry?: boolean } = {}): Promise<string> {
    try {
      return await this.#execOnce(command, opts.timeoutMs);
    } catch (e) {
      if (!opts.retry) throw e;
      // 只读命令: 断开或超时后重连再试一次 (服务器卡住时旧连接上的回复可能永远不来)
      this.#sock?.destroy();
      this.#sock = null;
      await this.connect();
      return await this.#execOnce(command, opts.timeoutMs);
    }
  }

  async #execOnce(command: string, timeoutMs = this.opts.timeoutMs): Promise<string> {
    if (!this.#sock) await this.connect();
    const sock = this.#sock!;
    return new Promise<string>((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RconError("timeout", `RCON 命令超时 (${timeoutMs} 毫秒)`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      if (process.env.RCON_DEBUG) console.error(`[rcon] 发出 id=${id} ${JSON.stringify(command.slice(0, 80))}`);
      sock.write(encodePacket(id, TYPE_EXEC, command));
    });
  }

  /** 存活检测: 每 intervalMs 发一次便宜的命令; 连续 2 次失败发 "dead" 事件, 之后每次都尝试重连 */
  heartbeat(intervalMs = 5000, probe = "/silent-command rcon.print(game.tick)") {
    this.stopHeartbeat();
    this.#heartbeat = setInterval(async () => {
      try {
        const out = await this.exec(probe, { timeoutMs: Math.max(intervalMs * 2, 10_000) });
        if (!/^\d+/.test(out)) throw new Error(`存活检测回复不对: ${out.slice(0, 80)}`);
        if (!this.alive) this.emit("revived");
        this.alive = true;
        this.#misses = 0;
      } catch (e) {
        this.#misses++;
        if (this.#misses === 2) {
          this.alive = false;
          this.emit("dead", e);
        }
      }
    }, intervalMs);
    this.#heartbeat.unref();
  }

  stopHeartbeat() {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  close() {
    this.stopHeartbeat();
    const s = this.#sock;
    this.#sock = null;
    this.alive = false;
    s?.destroy();
  }
}
