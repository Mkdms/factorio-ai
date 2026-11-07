// 彻底删一班的对话记录 (库, 不直接运行):
// 删的只是这一班的对话 / 命令 / 读数 / 截图 (大脑轮次日志 turn-*.jsonl、请求记录、监工采样、警报、私信记录、俯视图…), 删完标记"收起";
// 留的: summary.json (统计排行用)、review.md / review.json (复盘, 下一班"先修这几条")、world.json (属于哪个世界)、end.zip / recovered.json (存档链, 接着跑要用)。
// 大脑目录 (笔记 notes.md、team.md) 在别的盘, 这里根本不碰; 仓库的 knowledge/ 和规则也不在记录目录里。
import fs from "node:fs";
import path from "node:path";

/** 删: 文件名对上任一条 */
export const PURGE_FILES: RegExp[] = [/^turn-.*\.jsonl$/, /^claude-stderr\.txt$/, /^requests\.jsonl$/, /^monitor\.jsonl$/, /^health\.jsonl$/, /^quota\.jsonl$/, /^expand\.jsonl$/, /^digest\.jsonl$/,
  /^alerts\.jsonl$/, /^tells\.jsonl$/, /^blueprints\.jsonl$/, /^deaths\.jsonl$/, /^recovery\.jsonl$/, /^crash-.*\.out$/, /^world-scan\.json$/, /^watchdog\.json$/, /^session.*\.json$/, /^rcon\.pw$/, /^STOP$/, /^.*\.png$/, /^.*\.log$/];
/** 删: 整个子目录 (俯视图、截图) */
export const PURGE_DIRS = ["base", "shots"];
/** 留 (列出来给界面看; 不在这两张表里的其他文件也留着, 宁可多留) */
export const PURGE_KEEP = ["summary.json", "review.json", "review.md", "world.json", "end.zip", "recovered.json", "hidden", "purged"];
/** 删过的标记: 世界菜单里不再列这一班 */
export const PURGED = "purged";
export const isPurged = (runDir: string) => fs.existsSync(path.join(runDir, PURGED));

export type PurgePlan = { del: string[]; keep: string[] };
/** 一班目录里的文件 / 子目录名 → 哪些删哪些留 (纯函数, 测试用) */
export function purgePlan(entries: { name: string; dir: boolean }[]): PurgePlan {
  const del: string[] = [], keep: string[] = [];
  for (const e of entries) {
    if (e.dir) { (PURGE_DIRS.includes(e.name) ? del : keep).push(e.name); continue; }
    (PURGE_FILES.some((re) => re.test(e.name)) && !PURGE_KEEP.includes(e.name) ? del : keep).push(e.name);
  }
  return { del, keep };
}

export type PurgeResult = { run: string; deleted: number; bytes: number; kept: string[] };
/** 真删 (调用方先确认这一班没在跑); 删完放 hidden 标记 (= 从列表里收起) */
export function purgeRun(runDir: string): PurgeResult {
  const entries = fs.readdirSync(runDir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
  const plan = purgePlan(entries);
  let deleted = 0, bytes = 0;
  for (const name of plan.del) {
    const p = path.join(runDir, name);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) { bytes += dirBytes(p); fs.rmSync(p, { recursive: true, force: true }); }
      else { bytes += st.size; fs.unlinkSync(p); }
      deleted++;
    } catch { /* 删不掉 (占用?) 就留着, 不算 */ }
  }
  const marker = path.join(runDir, "hidden");
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, `删了对话记录 ${new Date().toISOString()}\n`);
  fs.writeFileSync(path.join(runDir, PURGED), `删了对话记录 ${new Date().toISOString()}; 世界菜单不再列; summary / review / 存档链还在\n`);
  return { run: path.basename(runDir), deleted, bytes, kept: plan.keep.filter((k) => k !== "hidden" && k !== PURGED) };
}

function dirBytes(dir: string): number {
  let n = 0;
  try { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, d.name); n += d.isDirectory() ? dirBytes(p) : (() => { try { return fs.statSync(p).size; } catch { return 0; } })(); } } catch { /* 读不了 */ }
  return n;
}
