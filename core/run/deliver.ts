// 递积累 (库, 不直接运行; online.ts 用): 开班把教训从训练集读进来 → 做对应动作时行动层带出 (lessons.ts lessonPicker) → 开班扫描附要点 (hints.ts) → 班末把笔记里的教训收进待核区。
// 放机器 / 查东西 / 报错时附的经验在 ./fh 的包装里 (commands/hints.ts), 不在这里。
import fs from "node:fs";
import path from "node:path";
import { appendLearned, inferKeys, learnedSeeds, loadSeeds, lessonPicker, mergePlan, nameIndex, parseNotesLessons, readLearned, KNOWN_ACTIONS, type Seed } from "./lessons.ts";
import { hintsForLines } from "./hints.ts";
import { learnedFile, pointsMd, trainingRoots } from "./training.ts";

/** 开班: 核实过的种子 (每个根的 lessons/verified/seed.json) + 模型各班自己记的 (lessons/pending/learned.jsonl, 最多 70 条) */
export function loadLessons(roots = trainingRoots()): { seeds: Seed[]; curated: number; learned: number } {
  const curated: Seed[] = [];
  for (const r of roots) { const f = path.join(r, "lessons", "verified", "seed.json"); if (fs.existsSync(f)) curated.push(...loadSeeds(f)); }
  const learned = learnedSeeds(roots.map((r) => path.join(r, "lessons", "pending", "learned.jsonl")).filter((f) => fs.existsSync(f)), curated);
  return { seeds: [...curated, ...learned], curated: curated.length, learned: learned.length };
}

/** 做动作时带出的挑选器 (给 commands/actions.ts 的 lessons 依赖) */
export function lessonDelivery(roots = trainingRoots()) {
  const loaded = loadLessons(roots);
  const picker = lessonPicker(loaded.seeds);
  return { ...loaded, pick: picker.pick, stats: picker.stats };
}

/** 开班扫描的句子对得上的要点, 附在 world-scan.md 末尾; 回附了几条 */
export function appendScanHints(scanMd: string, lines: string[], roots = trainingRoots()): number {
  const hints = hintsForLines(pointsMd(roots), lines);
  if (!hints.length) return 0;
  fs.appendFileSync(scanMd, `\n## 相关要点 (我们核实过的经验, 出处在括号里; ./know 关键词 查更多)\n${hints.map((h) => `- ${h}`).join("\n")}\n`);
  return hints.length;
}

/** 班末: 角色 notes.md 的 "## 教训" 以它自己的身份记进待核区 (通用的、没有的才记); 回 {candidates, added, skipped} */
export function collectNotesLessons(notesMd: string, zh: Map<string, string>, who: string, run: string, file = learnedFile()): { candidates: number; added: number; skipped: { line: string; why: string }[] } {
  const lines = parseNotesLessons(notesMd);
  if (!lines.length) return { candidates: 0, added: 0, skipped: [] };
  const idx = nameIndex(zh, KNOWN_ACTIONS);
  const plan = mergePlan(lines, readLearned(file), idx, 8);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const added = appendLearned(file, plan.add.map((c) => ({ rule: c.rule, keys: c.keys, who, run })));
  return { candidates: lines.length, added, skipped: plan.skipped };
}

export { inferKeys };
