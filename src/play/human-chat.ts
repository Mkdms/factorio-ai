// 真人说话 (库, 不直接运行)。;
// "点名或全队提问时 不打断 让他忙完手头上的事情在做。除非真人玩家说特别紧急。" 联机队友规则: 收到指令 10 秒内回收到。
// 这班实测: 问一句 2 分半 ~ 5 分 46 秒才有人回, 因为私信只在模型下一条命令的回复里出现, 想事情时收不到。所以:
//   ① 话照常进模型的下一条回复, 手上的事做完再答; 只有真人说紧急才打断这一轮;
//   ② 工具不替模型说话。试过两种都被否决, 别再加回来:
//      罐头 "收到 (自动回复)" —— 被否决;
//      用同一个模型单独问一句替它答 (第一版 pilot/src/game/chat-responder.ts 的做法, 那时只有一个角色) —— 被否决 (替它答了, 真身没行动, 别的模型又接走)。
//      单独问的那次调用不是干活的会话, 不知道它在忙什么、也动不了手: 替 Haiku 说"这就去拆", 真 Haiku 没接; 替 Glm 说"我去看看发电", 真 Glm 在取煤。
//      同一班里模型真身 15~25 秒就自己回了。回得慢的模型靠监工催 (replies.ts), 不靠替答。
//   ③ 沙盘读服务器日志的 [CHAT] 行, 联机读客户端 chat_read (src/io/human-chat-bridge.ts)。

import fs from "node:fs";

export type HumanMsg = { from: string; text: string };
export type Seat = { id: string; name: string };

/** 服务器日志一行 → 真人说的话。形如 "2026-11-05 13:02:20 [CHAT] mkdm: 你好"; 服务器自己说的 (<server>) 和没内容的不算 */
export function parseChatLine(line: string): HumanMsg | null {
  const m = /\[CHAT\]\s+(.+?)(?:\s+\[[^\]]*\])?:\s(.*)$/.exec(line);
  if (!m) return null;
  const from = m[1].trim(), text = m[2].trim();
  if (!text || from.startsWith("<")) return null;
  return { from, text };
}

/** 真人说特别紧急才打断: 只认明确的字眼, 不靠猜语气 */
export function isUrgent(text: string): boolean {
  return /紧急|十万火急|火烧眉毛|urgent|emergency/i.test(text);
}

/** 话里 @ 了谁 (大小写不敏感, 名字里可以有 . - _); 没 @ 任何人 = 全队 */
export function mentioned(text: string, seats: Seat[]): Seat[] {
  const low = text.toLowerCase();
  return seats.filter((s) => {
    const at = `@${s.name.toLowerCase()}`;
    let i = low.indexOf(at);
    while (i >= 0) {
      const next = low[i + at.length];
      if (next === undefined || !/[a-z0-9._-]/.test(next)) return true;
      i = low.indexOf(at, i + 1);
    }
    return false;
  });
}

/** 转给模型的话: 和界面发的同一个口径 */
export function tellText(source: "界面" | "游戏聊天", from: string, text: string, scope: "team" | "direct", urgent: boolean): string {
  const head = source === "界面" ? `管理员 (用户) 在界面${scope === "team" ? "群里对全队" : "里对你"}说` : `真人玩家 ${from} (真人在打字, 不是 AI 角色; 沙盘里 AI 可能和他同名) 在游戏聊天${scope === "team" ? "对全队" : "对你"}说`;
  const reply = source === "界面" ? `./fh call operator --args '{"text":"…"}'` : `./fh say "@${from} …"`;
  if (urgent) return `${head} (紧急): ${text} —— 先放下手上的事处理它, 回一句 (${reply})。`;
  if (scope === "team") return `${head}: ${text} —— 你知道答案或跟你手上的活有关才回 (${reply}), 别每人都回; 手上的事做完再回。`;
  return `${head}: ${text} —— 手上的事做完就回他 (${reply}): 做了什么 / 打算怎么做 / 做不了的原因。`;
}

/** 模组的私信一条放不下太长的: 按字节切, 不切断一个字 */
export function chunks(text: string, max = 480): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) { if (Buffer.byteLength(cur + ch) > max) { out.push(cur); cur = ""; } cur += ch; }
  if (cur) out.push(cur);
  return out;
}

/** 新增的文本: 只到最后一个换行 (没写完的行留到下次)。
 * 切分要带上最后的换行: Windows 服务器日志是 \r\n, 原来切到 \n 之前, 这批最后一行留着 \r, 解析不了 (11-05 总验证: 一句话单独一批, 真人说话几乎全丢) */
export function completeLines(chunk: string): { lines: string[]; consumed: number } {
  const end = chunk.lastIndexOf("\n");
  if (end < 0) return { lines: [], consumed: 0 };
  const whole = chunk.slice(0, end + 1);
  return { lines: whole.split(/\r?\n/).filter(Boolean), consumed: Buffer.byteLength(whole) };
}

/** 从现在的文件尾开始算: 开班起服务器之前就调 (11-05 总验证: 原来第一次轮询才定位, 窗口连上到第一次轮询之间真人说的话整句丢了, 没有自动回) */
export function markEnd(file: string, st: { off: number }): void {
  try { st.off = fs.statSync(file).size; } catch { st.off = 0; }
}

/** 文件新增的完整行 (st.off 记读到哪): startAtEnd = 第一次从文件尾开始 (开班前的旧内容不算); 文件变短 (重写过) 就从头来 */
export function readNewLines(file: string, st: { off: number }, startAtEnd = false): string[] {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return []; }
  if (st.off < 0) { st.off = startAtEnd ? size : 0; if (startAtEnd) return []; }
  if (size < st.off) st.off = 0;
  if (size === st.off) return [];
  const b = Buffer.alloc(Math.min(size - st.off, 8_000_000));
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, b, 0, b.length, st.off); } finally { fs.closeSync(fd); }
  const { lines, consumed } = completeLines(b.toString("utf8"));
  st.off += consumed;
  return lines;
}
