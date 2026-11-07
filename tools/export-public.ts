#!/usr/bin/env node
// 把本机积累里能公开的导进仓库: 开发者偶尔跑一次, 看 git diff 再提交。
//   node --env-file-if-exists=.env tools/export-public.ts
// 只导: 有明确公开许可的蓝图 (CC0)、自己生成的蓝图、大脑记下的通用教训 (去掉谁、哪一班, 带本机路径和人名的不要)。
// 不导: 朋友的基地和全图 (没有许可)、游戏数据、存档、账号。
import fs from "node:fs";
import path from "node:path";
import { labRoot, REPO } from "../src/lab/gamedir.ts";
import { isGeneralLesson, readLearned, validateSeed } from "../src/play/lessons.ts";

const OUT = path.join(REPO, "knowledge", "blueprints");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "generated"), { recursive: true });
fs.mkdirSync(path.join(OUT, "community"), { recursive: true });

// 自己生成的积木和它们的实测
let gen = 0;
for (const f of fs.readdirSync(path.join(labRoot(), "generated"))) {
  if (!/\.(txt|feed\.json)$/.test(f)) continue;
  fs.copyFileSync(path.join(labRoot(), "generated", f), path.join(OUT, "generated", f));
  gen++;
}

// 数据集: 只要 CC0; 不要出图路径和收录时间这些本机的东西
const rows = fs.readFileSync(path.join(labRoot(), "datasets", "index.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const cc0 = rows.filter((r) => r.license === "CC0-1.0");
const files = new Set<string>();
const out = cc0.map((r) => {
  const src = path.join(labRoot(), String(r.dir).replace(/^lab-data[\\/]/, ""), String(r.file));
  const dst = path.join(OUT, "community", String(r.file));
  if (!files.has(String(r.file))) { fs.copyFileSync(src, dst); files.add(String(r.file)); }
  const { render: _render, ingested: _ingested, ...keep } = r;
  void _render; void _ingested;
  return JSON.stringify({ ...keep, dir: "knowledge/blueprints/community" });
});
fs.writeFileSync(path.join(OUT, "index.jsonl"), `${out.join("\n")}\n`);
fs.copyFileSync(path.join(labRoot(), "datasets", "community", "brians-blueprints", "LICENSE"), path.join(OUT, "community", "LICENSE"));
fs.writeFileSync(path.join(OUT, "README.md"), "# 蓝图库\n\n`./bp list` 用的蓝图, 本机没有积累时用这里的。由 `tools/export-public.ts` 导出, 不要手改。\n\n- `generated/`: 自己的生成器 (`tools/generators/`) 产的积木和喂料实测。\n- `community/`: [Brian's Blueprints](https://github.com/bcwhite-code/brians-blueprints) by bcwhite-code, CC0 1.0 (见 `community/LICENSE`), 迁移到 Factorio 2.1 的版本。\n- `index.jsonl`: 每张的出处、许可、大小、建筑数和沙盘实测。\n");

// 大脑记的通用教训
// 本机路径、账号相关的不导; 人名和账号名单放本机 lab-data/export-ban.txt (一行一个正则), 不写进公开仓库
const banFile = path.join(labRoot(), "export-ban.txt");
const banned = fs.existsSync(banFile) ? fs.readFileSync(banFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
const LOCAL_ONLY = new RegExp(["[A-Za-z]:[\\\\/]", "keys\\.json", "中转", "服务器地址", "密码", ...banned].join("|"), "i");
const seen = new Set<string>();
const learned: string[] = [];
let dropped = 0;
for (const x of readLearned(path.join(labRoot(), "play", "lessons-learned.jsonl"))) {
  if (seen.has(x.rule)) continue;
  seen.add(x.rule);
  if (!isGeneralLesson(x.rule) || LOCAL_ONLY.test(x.rule)) { dropped++; continue; }
  try { validateSeed({ rule: x.rule, keys: x.keys, impact: 1 }); } catch { dropped++; continue; }
  learned.push(JSON.stringify({ rule: x.rule, keys: x.keys }));
}
fs.writeFileSync(path.join(REPO, "knowledge", "lessons-learned.jsonl"), `${learned.join("\n")}\n`);

const size = (d: string): number => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`蓝图: 生成的 ${gen} 个文件; CC0 ${cc0.length} 条 / ${files.size} 个文件; 没导 ${rows.length - cc0.length} 条 (没有公开许可)`);
console.log(`教训: 去重后 ${seen.size} 条, 导 ${learned.length}, 筛掉 ${dropped}`);
console.log(`knowledge/blueprints 共 ${(size(OUT) / 1e6).toFixed(1)} MB`);
