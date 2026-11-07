// FH_SOCKET 管道的客户端 (库): 同一套 ./fh 请求经代理走 (commands/broker.ts), 代替 RCON。给 Harness 用: 联机时 ./bp 这类工具也只走玩家操作, 碰不到服务器的 RCON。
import net from "node:net";

export class PipeRcon {
  readonly pipe: string;
  constructor(pipe: string) { this.pipe = pipe; }

  /** 发一条, 回代理答的那一行的正文; 代理拒绝或答不上来就抛错 */
  exec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.pipe);
      let buf = "";
      s.setEncoding("utf8");
      s.once("error", (e) => reject(new Error(`连不上代理 (${e.message})`)));
      s.once("connect", () => s.write(`${JSON.stringify({ command })}\n`));
      s.on("data", (d: string) => {
        buf += d;
        const end = buf.indexOf("\n");
        if (end < 0) return;
        s.destroy();
        const r = JSON.parse(buf.slice(0, end)) as { ok: boolean; text?: string; error?: string };
        if (r.ok) resolve(r.text ?? ""); else reject(new Error(r.error ?? "代理没说原因"));
      });
    });
  }
}
