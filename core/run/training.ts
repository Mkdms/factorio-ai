// 训练集在哪 (库, 不直接运行): 公开的 training/ (仓库里; 界面以后可换目录, 环境变量 TRAINING_DIR) + 只本机的 data/training-private/ (结构一样, 程序合并读)。
// 规范见 training/README.md; 条目的程序不先写, 各类文件照旧项目的格式原样读 (knowledge.ts、lessons.ts)。
import fs from "node:fs";
import path from "node:path";
import { ROOT, dataRoot } from "../../game/sandbox/paths.ts";

/** 公开训练集根目录 */
export const trainingRoot = (env: NodeJS.ProcessEnv = process.env): string => env.TRAINING_DIR?.trim() || path.join(ROOT, "training");
/** 只本机的那份 (朋友的基地、没查许可的社区蓝图、第一版知识) */
export const privateRoot = (): string => path.join(dataRoot(), "training-private");
/** 所有要读的根 (存在的才算): 公开的在前 */
export const trainingRoots = (env: NodeJS.ProcessEnv = process.env): string[] => [trainingRoot(env), privateRoot()].filter((d) => fs.existsSync(d));

/** 某一类下 verified 或 pending 里的文件 (按名字排序); 根不存在就空 */
export function trainingFiles(kind: "knowledge" | "patterns" | "lessons" | "blueprints" | "tools", area: "verified" | "pending", ext: string, roots = trainingRoots()): string[] {
  const out: string[] = [];
  for (const r of roots) {
    const d = path.join(r, kind, area);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) if (f.endsWith(ext)) out.push(path.join(d, f));
  }
  return out;
}

/** 给模型的手册目录 (派对的 ref 主题 + topics.tsv + index.md) */
export const manualsDir = (root = trainingRoot()): string => path.join(root, "manuals", "ref");
/** 简报模板和笔记模板 */
export const manualFile = (name: "brief.md" | "notes.md", root = trainingRoot()): string => path.join(root, "manuals", name);
/** 要点 (每条带出处标签; 开班扫描和监工按情况挑) */
export function pointsMd(roots = trainingRoots()): string {
  return roots.map((r) => { try { return fs.readFileSync(path.join(r, "knowledge", "verified", "points.md"), "utf8"); } catch { return ""; } }).filter(Boolean).join("\n");
}
/** 模型各班自己记的教训 (待核区), 公开那份 */
export const learnedFile = (root = trainingRoot()): string => path.join(root, "lessons", "pending", "learned.jsonl");
