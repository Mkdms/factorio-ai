// 一轮里有没有真干活 (库, 不直接运行): 防空转只该拦空转的轮。
// 2026-11-05 班次 10-16-30: Claude Haiku 每轮干 20 秒活、写一段汇报就结束, 防空转每次再等 60 秒, 75% 的时间站着; 同模型的另一个角色一轮到底, 一次没停。
import fs from "node:fs";

/** 只读 / 说话 / 等待类动作, 不算干活 */
const NOT_WORK = /^(status|observe|scan|inventory|chat|chat_ack|board|board_plan|board_post|help|describe|map|recipes|technologies|nearest|inspect|find|placements|bottleneck|rates|science|labs|queue_status|orders|logistics|power|entities|research|tell|tells|say|operator|idle_report|wait|wait_until|sleep|more|lesson_list|profile)$/;

/** journal.jsonl 的文本里, 某时刻之后发出的干活动作有几条 */
export function workSince(journal: string, sinceMs: number): number {
  let n = 0;
  for (const line of journal.split(/\r?\n/)) {
    if (!line.includes('"event":"request"')) continue;
    let o: { at?: string; event?: string; request?: { action?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    if (o.event !== "request" || !(Date.parse(o.at ?? "") >= sinceMs)) continue;
    if (!NOT_WORK.test(String(o.request?.action ?? ""))) n++;
  }
  return n;
}

/** 读角色 journal.jsonl 的末尾 (一轮用不了这么多), 读不到算 0 */
export function workSinceFile(file: string, sinceMs: number, bytes = 2_000_000): number {
  try {
    const size = fs.statSync(file).size, len = Math.min(size, bytes);
    const b = Buffer.alloc(len), fd = fs.openSync(file, "r");
    try { fs.readSync(fd, b, 0, len, size - len); } finally { fs.closeSync(fd); }
    return workSince(b.toString("utf8"), sinceMs);
  } catch { return 0; }
}
