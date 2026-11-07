// 换班不关游戏 (库, 不直接运行):
// 连跑时每班只换大脑 —— 到点大脑写总结, 服务器存一次档 (end.zip 照旧复制, 存档链不断), 不关服务器和窗口 (release); 下一班 run.ts --attach 接上在跑的游戏
// (src/lab/running.ts 的 running.json), 不读档、不重起; 最后一班 (或点了停班 / STOP_AFTER / 额度用完 / 看门狗放弃) 才关游戏。
// 服务器和窗口 detached 起, 所以上一班的 run.ts 退出它们也在。
export type PrevShift = { runId: string; endZip: string; brainDir?: string; /** 上一班班末没关游戏 (last-run.json gameKept) */ gameKept?: boolean };

/** 第 i 班 run.ts 的参数: 基础参数 + 接上一班 (存档 / 笔记) + 连跑且不是最后一班就 --keep-game + 上一班没关游戏就 --attach。n = 0 是一直跑到停班 */
export function shiftArgs(o: { base: string[]; i: number; n: number; live: boolean; prev: PrevShift | null }): string[] {
  const out = [...o.base];
  if (o.prev) { out.push("--save", o.prev.endZip); if (o.prev.brainDir) out.push("--notes", o.prev.brainDir); }
  if (o.live && (o.n === 0 || o.i < o.n)) out.push("--keep-game");
  if (o.prev?.gameKept) out.push("--attach");
  return out;
}
export const shiftLabel = (i: number, n: number): string => `第 ${i}/${n === 0 ? "∞" : n} 班`;

/** last-run.json 的一行 → 上一班 (字段不全就 null) */
export function prevFromLast(last: unknown): PrevShift | null {
  const o = (last ?? {}) as Record<string, unknown>;
  if (typeof o.endZip !== "string" || !o.endZip) return null;
  return { runId: typeof o.runId === "string" ? o.runId : "?", endZip: o.endZip, brainDir: typeof o.brainDir === "string" ? o.brainDir : undefined, gameKept: o.gameKept === true };
}
