// 官方中文名: 来自游戏导出的 zh-CN 名称 (lab-data/prototypes/<版本>/locale/zh-CN), 不手写。
import fs from "node:fs";
import path from "node:path";
import type { LabInstance } from "./instance.ts";

/** 返回一个把内部名翻成官方中文名的函数; 找不到就原样返回 */
export function zhNames(lab: LabInstance): (name: string) => string {
  return zhNamesFrom(lab.prototypesDir());
}

/** 同上, 直接给原型数据目录 (lab-data/prototypes/<模组-版本>) */
export function zhNamesFrom(prototypesDir: string): (name: string) => string {
  const dir = path.join(prototypesDir, "locale", "zh-CN");
  const names: Record<string, string> = {};
  for (const f of ["fluid-locale.json", "technology-locale.json", "recipe-locale.json", "item-locale.json", "entity-locale.json"]) {
    try {
      Object.assign(names, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).names);
    } catch {
      /* 没导出就用内部名 */
    }
  }
  return (n) => names[n] ?? n;
}
