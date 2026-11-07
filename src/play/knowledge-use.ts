// 大脑有没有用上我们的知识和工具 (库, 不直接运行)。 ——
// 数了 18 班: ./fh 5999 次 (模组每步在用), ./calc 14 次, ./bp 36 次, 查我们的经验主题 (pilot-*) 2 次。所以:
//   ① 要点直接进简报正文 (knowledge/brief-points.md → briefPoints); ② 每班每角色数一遍用了几次 (knowledgeUse, 进统计表);
//   ③ 监工在开班 15 / 35 分钟还没算过配比时提醒 (calcReminderDue; ./calc 每次调用往 .calc.log 记一行)。
import fs from "node:fs";
import path from "node:path";

/** knowledge/brief-points.md 的正文 (去掉开头 ">" 的说明行); 文件不在就 "" */
export function briefPoints(file: string): string {
  try {
    const lines = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
    return lines.filter((l) => !l.startsWith(">")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch { return ""; }
}

/** 一个角色一班里用了几次: 计算器、蓝图库、我们的手册主题 (./fh help pilot-*)、直接读事实 / 思路文件 */
export type KnowledgeUse = { calc: number; bp: number; /** ./plan (2026-11-05 加) */ plan: number; /** python 脚本 */ python: number; pilotHelp: number; pilotReads: number; fhCalls: number; /** 回复里自动带出教训的次数 (被动推送) */ lessonsShown: number };

/** 命令里调了几次这个程序: ./x、.\x、x.ps1 都算 (Gpt / Grok 走 PowerShell, 只数 ./x 少算了) */
const countCmd = (cmd: string, name: string) => (cmd.match(new RegExp(`(?:^|[\\s;&|(])\\.[/\\\\]${name}(?:\\.ps1)?(?=\\s|$)`, "g")) ?? []).length;

export function countKnowledgeUse(turnLogs: string[]): KnowledgeUse {
  const u: KnowledgeUse = { calc: 0, bp: 0, plan: 0, python: 0, pilotHelp: 0, pilotReads: 0, fhCalls: 0, lessonsShown: 0 };
  for (const text of turnLogs) {
    for (const line of text.split(/\r?\n/)) {
      // 回复里自动带出的教训 (被动推送, 11-04 晚起经验主要走这条路)
      if (line.includes("tool_result") && line.includes("lesson #")) { u.lessonsShown += (line.match(/lesson #\d+/g) ?? []).length; continue; }
      if (!line.includes("tool_use")) continue;
      let d: { type?: string; message?: { content?: unknown } };
      try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== "assistant" || !Array.isArray(d.message?.content)) continue;
      for (const b of d.message!.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
        if (b.type !== "tool_use") continue;
        if (b.name === "Bash") {
          const cmd = String(b.input?.command ?? "");
          u.fhCalls += countCmd(cmd, "fh");
          u.calc += countCmd(cmd, "calc");
          u.bp += countCmd(cmd, "bp");
          u.plan += countCmd(cmd, "plan");
          u.python += (cmd.match(/(?:^|[\s;&|(])python3?\s/g) ?? []).length;
          u.pilotHelp += (cmd.match(/\.[/\\]fh(?:\.ps1)? help pilot-/g) ?? []).length;
        } else if (b.name === "Read" || b.name === "Grep" || b.name === "Glob") {
          // 只看文件名: 大脑目录本身叫 factorio-pilot-brain, 按整条路径匹配 "pilot-" 会把读 notes.md / team.md 全算进去 (2026-11-04 第一版的错, 真实记录 89 次里只有 7 次是真的)
          const p = String(b.input?.file_path ?? b.input?.path ?? "");
          const base = p.replace(/^.*[\\/]/, "");
          if (/^pilot-.*\.md$/.test(base) || base === "facts.md" || /[\\/]patterns[\\/]/.test(p)) u.pilotReads++;
        }
      }
    }
  }
  return u;
}

/** 从记录目录读这个角色的全部轮次日志 (turn-<角色>-N.jsonl) 再数 */
export function knowledgeUse(runDir: string, agent: string): KnowledgeUse {
  let files: string[] = [];
  try { files = fs.readdirSync(runDir).filter((f) => f.startsWith(`turn-${agent}-`) && f.endsWith(".jsonl") && !f.endsWith("-raw.jsonl")); } catch { /* 没有 */ }
  return countKnowledgeUse(files.map((f) => { try { return fs.readFileSync(path.join(runDir, f), "utf8"); } catch { return ""; } }));
}

/** 监工: 开班 15 分钟和 35 分钟还一次没算过配比就提醒一次; 返回该提醒的那个分钟数 (0 = 不用) */
export const CALC_REMINDERS = [15, 35];
export function calcReminderDue(minutesIn: number, calcCalls: number, reminded: number): number {
  if (calcCalls > 0) return 0;
  for (const m of CALC_REMINDERS) if (minutesIn >= m && reminded < m) return m;
  return 0;
}
