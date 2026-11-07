// 简报 (库, 不直接运行; online.ts 用): training/manuals/brief.md 模板 + 世界真实值那一节 (online-lib.ts onlineBrief) + 用户这一班的目标 + 手册目录 (角色目录 ref/ 里有什么)。
// 简报只留世界、规矩、工具 (和派对对齐: 打法不写进简报, 由做动作时带出的教训、./know、手册给); 要点不并进正文。
import fs from "node:fs";
import path from "node:path";
import { manualFile } from "./training.ts";

/** 派对 ref/index.md 的目录 ("- `topic`, 讲什么: 动作…") 缩成 "- `topic`: 讲什么" (命令清单 ./fh help 里有, 不占简报) */
export function topicIndex(raw: string): string[] {
  const rows: string[] = [];
  for (const item of ("\n" + raw.replace(/\r\n/g, "\n")).split(/\n- /).slice(1)) {
    const m = /^`([a-z-]+)`,\s*([\s\S]*?):\s/.exec(item.replace(/\s+/g, " ").trim() + " ");
    if (m && m[1] !== "stream-people") rows.push(`- \`${m[1]}\`: ${m[2]}`);
  }
  return rows;
}

/** 角色目录 ref/ 的目录: 派对主题 (index.md) + 我们的思路 (pattern-*.md 第一行标题) + 事实表 */
export function refIndex(refDir: string): string {
  const rows: string[] = [];
  try { rows.push(...topicIndex(fs.readFileSync(path.join(refDir, "index.md"), "utf8"))); } catch { /* 没有派对目录 */ }
  for (const f of fs.existsSync(refDir) ? fs.readdirSync(refDir).sort() : []) {
    if (!/^pattern-[a-z-]+\.md$/.test(f)) continue;
    const first = fs.readFileSync(path.join(refDir, f), "utf8").split(/\r?\n/).find((l) => l.startsWith("# ")) ?? "";
    rows.push(`- \`${f.slice(0, -3)}\`: ${first.replace(/^#\s*/, "").trim() || "老玩家思路"} (大, 先回目录: 按段看)`);
  }
  if (fs.existsSync(path.join(refDir, "facts.md"))) rows.push("- `facts`: 沙盘核实过的事实表 (./know 关键词 更快)");
  return rows.length ? rows.join("\n") : "(见 ./fh help)";
}

/** 组装简报: 模板里的 {{WORLD}} {{PLAYER}} {{GOAL}} {{REF_INDEX}} 都填上; 没填到的占位符会抛错 (不能带着空位开班) */
export function composeBrief(o: { world: string; name: string; refDir: string; goal?: string; template?: string }): string {
  const tpl = (o.template ?? fs.readFileSync(manualFile("brief.md"), "utf8")).replace(/\r\n/g, "\n");
  const goal = o.goal?.trim() ? `\n## 用户这一班给你的任务\n\n${o.goal.trim()}\n` : "";
  const text = tpl.replace("{{WORLD}}", o.world.trim()).replace(/\{\{PLAYER\}\}/g, o.name).replace("{{GOAL}}\n", goal ? `${goal}\n` : "").replace("{{REF_INDEX}}", refIndex(o.refDir));
  const left = /\{\{[A-Z_]+\}\}/.exec(text);
  if (left) throw new Error(`简报模板里还有没填的占位符 ${left[0]}`);
  return text;
}
