// 蓝图库的本机数据在哪 (库): 新项目放 data/training-private/blueprints/ (第二版是 lab-data/ 直接放), 公开区在 training/blueprints/。
// 单独一个文件: bp.ts 动态 import bp-study.ts, bp-study.ts 再 import bp.ts 就成环 (顶层 await 卡死, 2026-11-08 验证班查出)。
import path from "node:path";
import { labRoot, REPO } from "../lab/gamedir.ts";

export const BP_DATA = path.join(labRoot(), "training-private", "blueprints");
/** 数据集条目的 dir 是第二版相对仓库根写的 ("lab-data/datasets/..."): 换成新项目的本机数据目录 */
export const datasetDir = (dir: string): string => (dir.startsWith("lab-data/datasets/") ? path.join(BP_DATA, "datasets", dir.slice("lab-data/datasets/".length)) : dir.startsWith("lab-data/") ? path.join(labRoot(), dir.slice("lab-data/".length)) : path.join(REPO, dir));
