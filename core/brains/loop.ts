// 轮次循环 (纯逻辑, 有单元测试; core/run/online.ts 用): 第 1 轮给开场提示词, 之后给"继续";
// 一轮很快就结束的话等够一段再叫 (旧项目第二轮空转 38 次的教训); 停了 (到点 / STOP / DONE / 掉线) 就不再叫, 等待中也每秒看一次。
export type LoopOpts = {
  /** 跑一轮, 回退出码 */
  turn: (n: number, prompt: string) => Promise<number>;
  stopped: () => boolean;
  first: string;
  next: string;
  log?: (s: string) => void;
  /** 两轮开始之间至少隔多久 (默认 30 秒) */
  minGapMs?: number;
  /** 这一轮是被打断的 (真人说紧急): 下一轮马上开, 不等 */
  interrupted?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export async function brainLoop(o: LoopOpts): Promise<{ rounds: number }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const gap = o.minGapMs ?? 30_000;
  const log = o.log ?? (() => undefined);
  let n = 0;
  while (!o.stopped()) {
    n++;
    const started = now();
    log(`第 ${n} 轮开始`);
    const code = await o.turn(n, n === 1 ? o.first : o.next);
    log(`第 ${n} 轮结束 (退出码 ${code}, ${Math.round((now() - started) / 1000)} 秒)`);
    if (o.interrupted?.()) continue;
    // 等到离这一轮开始够 gap, 每秒看一次停没停
    while (!o.stopped() && now() - started < gap) await sleep(Math.min(1000, gap - (now() - started)));
  }
  return { rounds: n };
}
