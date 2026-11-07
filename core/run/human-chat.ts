// 真人说话 (库, 不直接运行): 真人的话进模型的下一条回复, 手上的事做完再答; 只有真人说紧急才打断这一轮。工具不替模型说话 (罐头回复和替答都试过, 都否决了)。
// 来源: 自己客户端保留的聊天 (注入客户端的 chat_read; 联机服务器没有模组和 RCON, 读不到服务器日志) 和管理员写的 tell.txt (界面接上前的替代)。
// chat_read (注入客户端的程序 tools.md): messages[].{player_name, text, raw}, next_offset, has_more, history_lost; offset 只在同一个玩家同一个世界里有效; 读不会标记已读; 消息可能丢。
import fs from "node:fs";

export type HumanMsg = { from: string; text: string };
export type Seat = { id: string; name: string };

/** 服务器日志一行 → 真人说的话 (沙盘有服务器日志时也能用)。"2026-11-05 13:02:20 [CHAT] mkdm: 你好"; 服务器自己说的 (<server>) 和没内容的不算 */
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

/** 转给模型的话: 管理员 (界面 / tell.txt) 和游戏聊天同一个口径 */
export function tellText(source: "界面" | "游戏聊天", from: string, text: string, scope: "team" | "direct", urgent: boolean): string {
  const head = source === "界面" ? `管理员 (用户) ${scope === "team" ? "对全队" : "对你"}说` : `真人玩家 ${from} (真人在打字, 不是 AI 角色) 在游戏聊天${scope === "team" ? "对全队" : "对你"}说`;
  const reply = source === "界面" ? `./fh call operator --args '{"text":"…"}'` : `./fh call say --args '{"text":"@${from} …"}'`;
  if (urgent) return `${head} (紧急): ${text} —— 先放下手上的事处理它, 回一句 (${reply})。`;
  if (scope === "team") return `${head}: ${text} —— 你知道答案或跟你手上的活有关才回 (${reply}), 别每人都回; 手上的事做完再回。`;
  return `${head}: ${text} —— 手上的事做完就回他 (${reply}): 做了什么 / 打算怎么做 / 做不了的原因。`;
}

/** 新增的文本: 只到最后一个换行 (没写完的行留到下次)。切分要带上最后的换行: Windows 日志是 \r\n, 切到 \n 之前会留着 \r 解析不了 */
export function completeLines(chunk: string): { lines: string[]; consumed: number } {
  const end = chunk.lastIndexOf("\n");
  if (end < 0) return { lines: [], consumed: 0 };
  const whole = chunk.slice(0, end + 1);
  return { lines: whole.split(/\r?\n/).filter(Boolean), consumed: Buffer.byteLength(whole) };
}

/** 从现在的文件尾开始算 (开班前的旧内容不算) */
export function markEnd(file: string, st: { off: number }): void {
  try { st.off = fs.statSync(file).size; } catch { st.off = 0; }
}

/** 文件新增的完整行 (st.off 记读到哪); 文件变短 (重写过) 就从头来 */
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

// ---- 客户端的聊天 ----
export interface ChatPort { chatRead(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> }
type ReadResult = { messages?: { player_name?: string | null; text?: string | null; raw?: string | null }[]; next_offset?: unknown; has_more?: boolean; history_lost?: boolean };

/** 发聊天的要求 (注入客户端的 chat_send): 一行非空、不以 / 开头 (否则是控制台命令, 而且会禁成就)、≤ 4096 UTF-8 字节 */
export function chatLine(text: string): string {
  let s = text.replace(/\s*\r?\n\s*/g, " ").trim().replace(/^\/+/, "").trim() || "(空)";
  while (Buffer.byteLength(s) > 4096) s = s.slice(0, -1);
  return s;
}

/** 消息正文: 2.1.24 真实样本 text ": @Test 帮我修下电", raw 还带一对引号; text 可能是空的 */
export function chatBody(m: { text?: string | null; raw?: string | null }): string {
  const s = (m.text || (m.raw ?? "").replace(/^"([\s\S]*)"$/, "$1")).trim();
  return s.replace(/^:\s*/, "").trim();
}

export class HumanChatBridge {
  private offset: unknown = undefined;
  private port: ChatPort;
  private self: string;
  private aiNames: () => string[];
  /** self = 这个客户端的角色名; aiNames = 全队 AI 的角色名 (它们的话不算真人) */
  constructor(port: ChatPort, opts: { self: string; aiNames: () => string[] }) { this.port = port; this.self = opts.self; this.aiNames = opts.aiNames; }

  private async read(offset: unknown): Promise<ReadResult | null> {
    const r = await this.port.chatRead({ limit: 64, ...(offset === undefined ? {} : { offset }) });
    return r.ok ? (r.data as ReadResult) : null;
  }

  /** 第一次只记位置, 不把进服务器之前的聊天当新消息 */
  async start(): Promise<void> {
    const r = await this.read(undefined);
    if (r) this.offset = r.next_offset;
  }

  /** 新的真人消息; 没有发件人的 (系统通知) 和 AI 自己的不算; 读不了返回空, 下次接着试 */
  async poll(): Promise<HumanMsg[]> {
    const out: HumanMsg[] = [];
    const skip = new Set([this.self, ...this.aiNames()]);
    for (let page = 0; page < 8; page++) {
      const r = await this.read(this.offset);
      if (!r) return out;
      if (r.history_lost) { await this.start(); return out; }
      for (const m of r.messages ?? []) {
        const from = m.player_name?.trim();
        const text = chatBody(m);
        if (from && text && !from.startsWith("<") && !skip.has(from)) out.push({ from, text });
      }
      this.offset = r.next_offset ?? this.offset;
      if (!r.has_more) break;
    }
    return out;
  }
}
