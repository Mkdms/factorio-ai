// 常驻的 Claude Code 会话 (库, 不直接运行; play:run --stream 用): claude -p --input-format stream-json --output-format stream-json, 标准输入一直开着。
// 一轮 = 写一条用户消息, 等它的 result。一轮还在跑时写进去的消息 (插话, 监工的话) 在它下一次调用模型前并进这一轮 (Claude Code 2.1.221 起),
// 不用杀进程再 --resume (以前出错隔离、闲 10 分钟都是 kill 重开, 它想到一半的东西白费; run.ts 旧注释 "claude -p 收不了中途消息")。
// 做法照 OpenMausBot server/drivers/claude.ts (Apache-2.0, 见 NOTICE):
// - --replay-user-messages (2.1.282 起): 插话被模型收下时回显一条 {type:"user", isReplay:true, uuid}; 还没回显的插话记在 pending。
// - result 到了但还有没收下的插话 (插话写在这一轮最后一次模型调用期间): CLI 会在 result 之后把它单独跑成一轮 → 先不算结束, 等 graceMs
//   (OpenMausBot 实测约 60 毫秒就开始, 它等 2 秒) 看有没有接着跑; 接着跑了就等下一个 result。
// - 常驻会话里 result 的 total_cost_usd 是这个进程的累计数 ("read the latest result rather than summing"), 不能每轮相加。
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export type StreamResult = { ok: boolean; subtype: string; text: string; exited: boolean; code?: number | null };
export type StreamOptions = {
  bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  onLine?: (m: any, raw: string) => void; onStderr?: (d: Buffer) => void; onExit?: (code: number | null) => void;
  /** 插的话被模型收下了 */
  onSteerTaken?: (uuid: string) => void;
  graceMs?: number;
};

/** stream-json 的一条用户消息 (插话带 uuid, 回显时对得上) */
export const userMessage = (text: string, uuid?: string) => ({ type: "user", ...(uuid ? { uuid } : {}), message: { role: "user", content: text } });

/** 常驻会话要加的参数 (和 claude -p 的其余参数一起用; 提示词不放命令行, 走标准输入) */
export const STREAM_ARGS = ["--input-format", "stream-json", "--replay-user-messages"];

export class ClaudeStream {
  readonly child: ChildProcess;
  exited = false;
  /** 这个进程最后报的累计花费 (美元, 订阅下是折算价) */
  lastCost = 0;
  private buf = "";
  private pending = new Set<string>();
  private waiter: ((r: StreamResult) => void) | null = null;
  private held: StreamResult | null = null;
  private grace: NodeJS.Timeout | null = null;
  private o: StreamOptions;

  constructor(o: StreamOptions) {
    this.o = o; // Node 去类型只支持纯 JS 写法: 不用 constructor(private o)
    this.child = spawn(o.bin, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stdin!.on("error", () => { /* 进程已退出 (EPIPE): 由 exit 收尾 */ });
    this.child.stdout!.on("data", (d: Buffer) => this.onData(d));
    this.child.stderr!.on("data", (d: Buffer) => o.onStderr?.(d));
    this.child.on("error", () => this.onExit(null));
    this.child.on("exit", (code) => this.onExit(code));
  }

  /** 有一轮在跑 (含 result 后等续轮的那 2 秒) */
  get busy() { return this.waiter !== null; }
  get pendingSteers() { return this.pending.size; }

  /** 开一轮: 写消息, 等这一轮结束 (被插话续上的算同一轮); 进程退出也返回 */
  turn(text: string): Promise<StreamResult> {
    if (this.waiter) return Promise.reject(new Error("上一轮还没结束"));
    if (this.exited) return Promise.resolve({ ok: false, subtype: "exited", text: "", exited: true });
    return new Promise((resolve) => {
      this.waiter = resolve;
      if (!this.write(userMessage(text))) this.finish({ ok: false, subtype: "stdin_write_failed", text: "", exited: this.exited });
    });
  }

  /** 插话: 正在跑的一轮在下一次调用模型前收下。没有在跑的一轮返回 false (调用方留到下一轮的提示里) */
  steer(text: string): boolean {
    if (!this.waiter || this.exited) return false;
    const id = randomUUID();
    this.pending.add(id); // 先记再写: 写的过程中 result 到了也要等它
    if (!this.write(userMessage(text, id))) { this.pending.delete(id); return false; }
    if (this.held) this.armGrace(); // result 已到、在等续轮: 重新计时
    return true;
  }

  /** 结束进程 (这一轮按退出返回) */
  close() {
    try { this.child.stdin!.end(); } catch { /* 已关 */ }
    this.child.kill();
  }

  private write(m: object): boolean {
    const s = this.child.stdin;
    if (!s || !s.writable || this.exited) return false;
    s.write(JSON.stringify(m) + "\n");
    return true;
  }

  private onData(d: Buffer) {
    this.buf += d.toString("utf8");
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const raw = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let m: any;
      try { m = JSON.parse(raw); } catch { continue; }
      this.o.onLine?.(m, raw);
      // 回显: 每轮的提示也会回显 (CLI 自己给 uuid, 2.1.314 实测), 只有我们插的话对得上 pending
      if (m.type === "user" && m.isReplay === true && typeof m.uuid === "string") { if (this.pending.delete(m.uuid)) this.o.onSteerTaken?.(m.uuid); }
      else if (m.type === "system" && m.subtype === "init" && this.held) { // 插话单独跑成的一轮开始了: 不再计时, 接着等它的 result
        if (this.grace) { clearTimeout(this.grace); this.grace = null; }
        this.held = null;
      } else if (m.type === "result") {
        if (typeof m.total_cost_usd === "number") this.lastCost = m.total_cost_usd;
        const r: StreamResult = { ok: !m.is_error && m.subtype === "success", subtype: String(m.subtype ?? ""), text: String(m.result ?? ""), exited: false };
        if (!this.waiter) continue; // 没人在等 (续轮超过宽限才到): 只记录
        if (this.pending.size > 0 || (typeof m.queued_turn_count === "number" && m.queued_turn_count > 0)) { this.held = r; this.armGrace(); }
        else this.finish(r);
      }
    }
  }

  private armGrace() {
    if (this.grace) clearTimeout(this.grace);
    this.grace = setTimeout(() => { this.grace = null; if (this.held) this.finish(this.held); }, this.o.graceMs ?? 2_000);
  }

  private finish(r: StreamResult) {
    if (this.grace) { clearTimeout(this.grace); this.grace = null; }
    this.held = null;
    this.pending.clear();
    const w = this.waiter; this.waiter = null;
    w?.(r);
  }

  private onExit(code: number | null) {
    if (this.exited) return;
    this.exited = true;
    this.finish({ ok: false, subtype: "exited", text: "", exited: true, code });
    this.o.onExit?.(code);
  }
}
