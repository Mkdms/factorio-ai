// UDP 快速通道: 游戏用 --enable-lua-udp <端口> 启动, 模组每个 tick 调 helpers.recv_udp()。
// 请求 "<id>\n<json>", 回复 "<id> <第几段> <共几段>\n<片段>" (见 game/mod/factorio-ai/control.lua)。
// 游戏暂停时 on_tick 不跑, 这条通道不通, 调用方应退回 RCON。
// 这条通道不经过控制台命令, 不会给存档打"用过控制台"的标记 (控制台命令会); 要不要算成就的局只能走它。
import dgram from "node:dgram";

interface Pending {
  parts: string[];
  got: number;
  resolve: (s: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class UdpChannel {
  readonly gamePort: number;
  #sock: dgram.Socket;
  #nextId = 1;
  #pending = new Map<string, Pending>();
  #ready: Promise<void>;

  constructor(gamePort: number) {
    this.gamePort = gamePort;
    this.#sock = dgram.createSocket("udp4");
    this.#sock.on("message", (msg) => this.#onMessage(msg.toString("utf8")));
    this.#ready = new Promise((resolve) => this.#sock.bind(0, "127.0.0.1", () => resolve()));
    this.#sock.unref();
  }

  #onMessage(s: string) {
    const nl = s.indexOf("\n");
    if (nl < 0) return;
    const [id, iStr, nStr] = s.slice(0, nl).split(" ");
    const p = this.#pending.get(id);
    if (!p) return;
    const i = Number(iStr), n = Number(nStr);
    if (p.parts.length === 0) p.parts = new Array(n).fill(undefined);
    if (p.parts[i - 1] === undefined) {
      p.parts[i - 1] = s.slice(nl + 1);
      p.got++;
    }
    if (p.got === n) {
      clearTimeout(p.timer);
      this.#pending.delete(id);
      p.resolve(p.parts.join(""));
    }
  }

  /** 发一个请求 (JSON 文本), 返回原始回复 ("j:..." 或 "z:...") */
  async request(json: string, timeoutMs = 2000): Promise<string> {
    await this.#ready;
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`UDP 请求超时 (${timeoutMs} 毫秒; 游戏暂停时 UDP 不通)`));
      }, timeoutMs);
      this.#pending.set(id, { parts: [], got: 0, resolve, reject, timer });
      this.#sock.send(`${id}\n${json}`, this.gamePort, "127.0.0.1");
    });
  }

  close() {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("UDP 通道已关闭"));
    }
    this.#pending.clear();
    this.#sock.close();
  }
}
