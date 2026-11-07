// 沙盘命令不给 --save 时用哪份存档。参考存档是本机一班的记录, 不进仓库, 全新目录里没有 (2026-11-06 全新目录第一次跑 play:online --lab 在这里崩)。
import fs from "node:fs";
import path from "node:path";
import { labRoot } from "./gamedir.ts";

/** 本机有参考存档就回它的路径, 没有回 undefined: 调用方自己决定开新图还是要求 --save */
export function defaultLabSave(root: string = labRoot()): string | undefined {
  const save = path.join(root, "play", "runs", "2026-11-05T10-16-30", "end.zip");
  return fs.existsSync(save) ? save : undefined;
}
