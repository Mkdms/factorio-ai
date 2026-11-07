// 大脑会话的上下文管理 (库, 不直接运行): 压缩点、快满时提醒写笔记、压缩后把笔记贴回去。
// 搬自 factorio-ai-party (MIT) tools/context.py 的 Claude Code 部分和 agent/compact.md、agent/context.tsv (提交 1f71bdac);
// 数字和理由见他们的 docs/CONTEXT-NOTES.md (Claude Code 2.1.296 实测)。。
import fs from "node:fs";
import path from "node:path";

/**
 * 每个模型在多少 token 处压缩 (派对 agent/context.tsv 是 Opus 25 万、Sonnet 20 万、Haiku 14 万; 默认 1M 窗口要到约 96.7 万才压, 每次调用都重发整段上下文)。
 * 2026-11-05 调低 (`npm run play:tokens` 量 11-03 / 11-04 三班: Opus 每小时 220 次请求, 每次带 110~120k 上下文, 99% 缓存读 —— 阈值 25 万时平均带着一半):
 * Opus 15 万、Sonnet / 别家 13 万、Haiku 10 万 → 平均上下文约砍四成, 多出的压缩每次只是一次请求 + 摘要; 笔记 (notes.md) 和恢复简报兜住记忆。下一班用账本对比"每次请求上下文"。--compact-at 可改。
 */
export function compactAt(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("opus")) return 150_000;
  if (m.includes("haiku")) return 100_000;
  return 130_000;
}

/** Claude Code 留给摘要的 2 万; 实际在 min(E*pct/100, E-13000) 处压, E = 窗口 - 20000 (派对探针核实) */
const RESERVE = 20_000;
/** 让 Claude Code 在 at 处压缩的 autoCompactWindow 和 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (窗口最小 10 万) */
export function claudeWindow(at: number): { window: number; pct?: string } {
  if (at + 13_000 + RESERVE >= 100_000) return { window: at + 13_000 + RESERVE };
  return { window: 100_000, pct: String(Math.floor((at * 100) / (100_000 - RESERVE))) };
}

// 等待规则 (拒串联 sleep) 和放行 (派对 permit.py) 在 permit.ts; 这里转出, 老的引用不用改
export { sleepVerdict } from "./permit.ts";

/** 大脑目录的 .claude/settings.json (只在这个目录生效; run.ts 用 --setting-sources project,local) */
export function brainSettings(at: number, hook: (event: string, ...extra: string[]) => string) {
  const { window, pct } = claudeWindow(at);
  const cmd = (event: string, ...extra: string[]) => ({ type: "command", command: hook(event, ...extra), timeout: 20 });
  return {
    autoCompactWindow: window,
    // 派对 tools/clean-profile.py:63-76: Bash 默认 / 最长超时 20 分钟 (默认 2 分钟, ./fh sleep 和长 --wait 会被挪到后台); 关自动记忆和 git 说明
    autoMemoryEnabled: false,
    includeGitInstructions: false,
    env: { BASH_DEFAULT_TIMEOUT_MS: "1200000", BASH_MAX_TIMEOUT_MS: "1200000", ...(pct ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: pct } : {}) },
    hooks: {
      PreCompact: [{ hooks: [cmd("pre-compact")] }],
      PostCompact: [{ hooks: [cmd("post-compact")] }],
      SessionStart: [{ matcher: "compact", hooks: [cmd("session-compact")] }],
      PostToolUse: [{ hooks: [cmd("post-tool", "--at", String(at))] }],
      // 先拦串联 sleep (第十三轮班末: ./fh sleep 60 && ./fh sleep 60 && … 绕过"一次不超过 60 秒", 研究停 5 分钟),
      // 再放行只由白名单程序组成的循环 / 管道 (派对 tools/permit.py; dontAsk 一写循环就拒, 见 permit.ts)
      PreToolUse: [{ matcher: "Bash", hooks: [cmd("pre-tool")] },
        // 读文件的禁区 (src/play/read-guard.ts; 2026-11-05 省 token: 别读模组源码 / 宿主 / 依赖, 大文件要 offset / limit, 简报不用重读)
        { matcher: "Read|Grep|Glob", hooks: [cmd("pre-read")] }],
    },
  };
}

/** 简报末尾: 压缩时摘要保留什么 (照派对 agent/compact.md, 改成我们的 ./fp、notes.md、team.md) */
export const COMPACT_INSTRUCTIONS = `
## Compact instructions (压缩时摘要保留什么)
你在写替换这段对话的摘要, 给同一个队员接着玩用。长期记忆在 notes.md, 摘要只要接上 notes.md 到现在这一段。按顺序列短清单:
1. 你是谁、在哪: 角色、世界、目录; 规则和接口在 CLAUDE.md。
2. 现在的目标和下一步 (准备跑的那条命令或计划)。
3. 最后 5 个动作和结果: 命令、发生了什么、报错; 还在执行的动作 (要不要先 --wait)。
4. notes.md 上次更新后新知道的: 新坐标、认领 (自己和队友的)、和队友的约定 (team.md)、答应过的事。坐标和编号照抄。
5. 还没写进 notes.md 的工具教训。
不要: 原样的 observe / scan / status 输出、长 JSON、等待和轮询的输出、作废的计划。notes.md 已有的不重复。
结尾写: "恢复: 先读 notes.md (和 ../team.md), 把这份摘要里的新事实补进 notes.md, 再 ./fp status 看角色。"
`;

/** 会话日志里最新一条回复时的上下文大小 (输入 + 写缓存 + 读缓存 + 输出); since = 只看这个字节之后 (压缩后旧的不算) */
export function claudeTokens(transcript: string, since = 0): number {
  try {
    const size = fs.statSync(transcript).size;
    const from = since <= size ? since : 0;
    const start = Math.max(from, size - 400_000);
    const fd = fs.openSync(transcript, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    if (start > from) lines.shift(); // 从中间截的第一行不完整
    for (const line of lines.reverse()) {
      if (!line.includes('"usage"')) continue;
      try {
        const row = JSON.parse(line);
        const u = row.message?.usage;
        if (row.type === "assistant" && u) return ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].reduce((s, k) => s + (Number(u[k]) || 0), 0);
      } catch { /* 不是整行 */ }
    }
  } catch { /* 没有日志 */ }
  return 0;
}

/**
 * 该不该提醒: 离压缩点不到 max(2 万, 压缩点 / 5), 而且已经过了本窗口起点到压缩点的一半
 * (派对: 余量 1.2 万时提醒和压缩落在同一步, 来不及写笔记; Haiku 压缩后的起点就高过提醒线)。
 */
export function shouldNudge(tokens: number, at: number, floor: number): boolean {
  return at > 0 && tokens > 0 && tokens >= Math.max(at - Math.max(20_000, Math.floor(at / 5)), floor + Math.floor((at - floor) / 2));
}

/** notes.md 的"日志"一节只留最后 n 行 (派对: 日志 39 行时每次压缩都带两遍, 压缩后起点从 2.45 万涨到 3.11 万) */
export function trimLog(notes: string, keep = 10): string {
  const m = /^## 日志[^\n]*\n/m.exec(notes);
  if (!m) return notes;
  const head = notes.slice(0, m.index + m[0].length);
  const rest = notes.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  const tail = next >= 0 ? rest.slice(next) : "";
  const lines = body.split("\n").filter((l) => l.trim());
  if (lines.length <= keep) return notes;
  return head + `(前 ${lines.length - keep} 行省略)\n` + lines.slice(-keep).join("\n") + "\n" + (tail ? "\n" + tail : "");
}

/** 压缩后贴回去的笔记 (≤ 7000 字; 多角色时提醒看 team.md) */
export function recoveryBrief(dir: string, why: string): string {
  let notes = "";
  try { notes = trimLog(fs.readFileSync(path.join(dir, "notes.md"), "utf8")); } catch { notes = "(没有 notes.md)"; }
  if (notes.length > 7000) notes = notes.slice(0, 7000) + "\n…(截断, 完整的读 notes.md)";
  const team = fs.existsSync(path.join(dir, "..", "team.md")) ? "\n队伍协调在 ../team.md, 先读再动手。" : "";
  const status = fs.existsSync(path.join(dir, "fh")) ? "./fh call status 和 ./fh call chat" : "./fp status"; // 派对配置 (--kit party) 用 ./fh
  const deadline = fs.existsSync(path.join(dir, "deadline.txt")) ? " 截止时间在 deadline.txt。" : "";
  return `${why} 下面是你的 notes.md (日志只留最后 10 行):\n\n${notes}${team}\n先把摘要里的新事实补进 notes.md, 再 ${status} 看角色和消息, 然后继续。${deadline}`;
}

export const NUDGE = (tokens: number, at: number) =>
  `上下文已有 ${tokens} token, 约 ${at} 时自动压缩, 摘要只保留最后几个动作。现在先更新 notes.md (现在在做、坐标和设施、计划、教训; 日志只留最后 10 行), 多角色时把认领和约定写进 ../team.md, 然后继续。`;
