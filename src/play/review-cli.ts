#!/usr/bin/env node
// 一班的复盘 (src/play/review-shift.ts): 写 review.md / review.json 到记录目录并打印。run.ts 班末自己会跑; 这个命令用来补跑或看旧班。
//   npm run play:review [-- <记录目录> [--prev <上一班记录目录>]]   (不给就用 lab-data/play/last-run.json 指的那一班)
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { labRoot } from "../lab/gamedir.ts";
import { loadZhNames } from "./chattags.ts";
import { loadShift, reviewShift, reviewMarkdown } from "./review-shift.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { prev: { type: "string" } } });
const runDir = positionals[0] ?? JSON.parse(fs.readFileSync(path.join(labRoot(), "play", "last-run.json"), "utf8")).runDir;
const ZH = loadZhNames(path.join(labRoot(), "prototypes"));
const r = reviewShift(loadShift(runDir), values.prev ? loadShift(values.prev).monitor : null, (n) => ZH.get(n) ?? n);
const md = reviewMarkdown(r, path.basename(runDir));
fs.writeFileSync(path.join(runDir, "review.md"), md);
fs.writeFileSync(path.join(runDir, "review.json"), JSON.stringify(r, null, 2));
console.log(md);
