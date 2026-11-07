// 游戏里的 harness 模组的客户端: 经沙盘 RCON 调 game/mod/factorio-ai-harness (见 NOTICE)。
// 只在测试里当真值用 (游戏外的宿主答的和它逐字段比); 模型不走这条路 (模型的手脚不装模组)。
// 协议照上游 host/harness.ts: remote.call("agent_harness","dispatch", json) → {id, ok, tick, result | error};
// 等待照上游 host/cli.ts waitForAction: 轮询 status, 动作不在 active 里了就看 last.outcome 判断成败。
// 动作绝不自动重发 (断线 = 结果未知, 只能带同一个 id 重试, 模组会返回缓存的结果)。
import { randomUUID } from "node:crypto";
import type { RconClient } from "../sandbox/rcon.ts";

export type Reply = { id?: string; ok: boolean; tick?: number; result?: any; error?: { code: string; message: string; recovery?: string } };
export type LogEntry = { t: number; id: string; action: string; args: Record<string, unknown>; ok: boolean; ms: number; tick?: number; bytes: number; error?: string; wait?: boolean; /** transfer 的实际方向 (to_entity / to_player) */ dir?: string; /** 回复开头 (复盘用: 第六轮查送煤带断口时日志里没有 construct 当时回了什么) */ res?: string };

/** JSON 放进 Lua 长字符串 (照上游 luaString: 等号数量避开内容里的 ]=*]) */
export function luaString(value: string): string {
  let eq = "";
  while (value.includes(`]${eq}]`)) eq += "=";
  return `[${eq}[\n${value}]${eq}]`;
}

/** 定时动作: 接受后在游戏里跑, --wait 时轮询到结束 (上游 cli.ts 的同一份清单) */
const TIMED = ["walk", "move_to", "build_path", "construct", "mine", "shoot", "pickup", "repair"];
const GATHER = ["collect", "rearm", "refuel"];
const SUCCESS = ["duration_elapsed", "target_mined", "repair_completed", "arrived", "path_built", "collected", "topped_up", "nothing_to_do", "constructed"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 大脑想"等角色把手上的事做完", 写成 harness 没有的 wait_until {idle} / {queue_empty} (第八轮 14 次失败 11 次; harness 的 sleep
 *  在实时模式下立刻返回, 不真等): 返回最多等几秒, 不是这种写法返回 null */
export function idleWaitSeconds(action: string, args: Record<string, unknown>): number | null {
  if (action !== "wait_until" || args.until !== undefined || !(args.idle || args.queue_empty || args.queue_done)) return null;
  const s = typeof args.seconds === "number" ? args.seconds : typeof args.ticks === "number" ? args.ticks / 60 : 60;
  return Math.max(1, Math.min(110, s)); // 大脑的 Bash 调用默认 2 分钟超时
}

/** status 的回复 → 角色是不是空下来了 (没有正在做的动作; 身体队列没在跑、也没有排着没暂停的步骤) */
export function idleState(st: any): { idle: boolean; queue: string } {
  const q = st?.queues?.body ?? {};
  const pending = Number(q.pending) || 0;
  const busy = !!st?.active || !!q.active || (pending > 0 && !q.paused);
  const queue = q.paused && pending ? `暂停了, 还有 ${pending} 步 (${q.paused_by}); queue_resume 继续` : pending ? `还有 ${pending} 步` : "空";
  return { idle: !busy, queue };
}

export class Harness {
  private rcon: RconClient;
  /** 玩家编号, 或服务器角色 (bot) 的名字 (只有派对分支版 harness 有 bot: 请求里写 bot 不写 player) */
  who: number | string;
  private onLog?: (e: LogEntry) => void;
  /** 正在等定时动作结束 (这期间的 status 轮询在日志里标 wait, 不算大脑的回合) */
  private polling = false;
  /** 以别的进程的身份只读 (模组 dispatch 的 reader; 派对流媒体服务和分析工具也这么读): 不占角色的提醒、队伍消息、计时和聊天, 不打断它的队列; 动作类会被模组拒绝 */
  reader?: string;
  constructor(rcon: RconClient, who: number | string = 1, onLog?: (e: LogEntry) => void, opts: { reader?: string } = {}) {
    this.rcon = rcon;
    this.who = who;
    this.onLog = onLog;
    this.reader = opts.reader;
  }

  /** 发一个动作, 返回模组的回复 (不等定时动作结束) */
  async request(action: string, args: Record<string, unknown> = {}, id: string = randomUUID()): Promise<Reply> {
    const t0 = Date.now();
    const body = JSON.stringify({ ...(typeof this.who === "string" ? { id, action, bot: this.who, args } : { id, action, player: this.who, args }), ...(this.reader ? { reader: this.reader } : {}) });
    const raw = await this.rcon.exec(`/silent-command rcon.print(remote.call("agent_harness", "dispatch", ${luaString(body)}))`);
    let reply: Reply;
    try { reply = JSON.parse(raw.trim()); } catch { throw new Error(`agent-harness 回复不是 JSON (模组没加载?): ${raw.slice(0, 300)}`); }
    this.onLog?.({ t: t0, id, action, args, ok: reply.ok, ms: Date.now() - t0, tick: reply.tick, bytes: raw.length, ...(this.polling ? { wait: true } : {}), ...(action === "transfer" && reply.ok ? { dir: reply.result?.direction } : {}), ...(reply.ok ? {} : { error: `${reply.error?.code}: ${reply.error?.message}` }), ...(reply.ok && !this.polling ? { res: JSON.stringify(reply.result ?? null).slice(0, 300) } : {}) });
    return reply;
  }

  /** 等角色空下来, 最多 maxS 秒 (真实时间); 轮询 status 不算大脑的回合, 日志里记一条 wait_idle */
  async waitIdle(maxS: number, asked: Record<string, unknown>): Promise<Reply> {
    const t0 = Date.now();
    for (;;) {
      this.polling = true;
      const st = await this.request("status").finally(() => { this.polling = false; });
      if (!st.ok) return st;
      const { idle, queue } = idleState(st.result);
      if (idle || Date.now() - t0 >= maxS * 1000) {
        const result = {
          note: `harness 没有 wait_until {idle}; fp 改成等角色空下来 (以后可直接写 fp wait_until '{"idle":true,"seconds":60}')`,
          idle, waited_s: Math.round((Date.now() - t0) / 1000), active: st.result?.active || null, queue, last: st.result?.last ?? null,
        };
        this.onLog?.({ t: t0, id: randomUUID(), action: "wait_idle", args: asked, ok: true, ms: Date.now() - t0, tick: st.tick, bytes: 0, res: JSON.stringify(result).slice(0, 300) });
        return { ok: true, tick: st.tick, result };
      }
      await sleep(1000);
    }
  }

  /** 发动作; wait 时定时动作等到结束, 成败按 last.outcome 判断 (上游 waitForAction) */
  async call(action: string, args: Record<string, unknown> = {}, opts: { wait?: boolean; timeoutMs?: number; id?: string } = {}): Promise<Reply> {
    const reply = await this.request(action, args, opts.id);
    const timed = TIMED.includes(action) || (GATHER.includes(action) && args.radius !== undefined);
    if (!opts.wait || !reply.ok || !timed) return reply;
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    const kind = GATHER.includes(action) ? "gather" : action;
    while (Date.now() < deadline) {
      this.polling = true;
      const st = await this.request("status").finally(() => { this.polling = false; });
      const active = action === "shoot" ? st.result?.combat : st.result?.active;
      const running = active && (action === "shoot" || active.kind === kind);
      if (!st.ok || !running) {
        const last = action === "shoot" ? st.result?.last_combat : st.result?.last;
        if (st.ok && last?.outcome && !SUCCESS.includes(last.outcome)) return { ...reply, ok: false, result: { accepted: reply.result, completion: last }, error: { code: "action_interrupted", message: `动作结束: ${last.outcome}` } };
        return { ...reply, result: { accepted: reply.result, completion: last ?? null } };
      }
      await sleep(100);
    }
    return { ...reply, ok: false, error: { code: "wait_timeout", message: `${action} 等待超时, 游戏里还在跑: 再查 status 或再等` } };
  }
}
