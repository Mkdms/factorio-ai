// 转接 (第二版的 src/lab/gamedir.ts 在新项目里对应 game/sandbox/paths.ts): 第二版整目录搬来的 src/ 代码照原来的 import 路径用
import path from "node:path";
import { ROOT, builtinMods, dataPath, dataRel, dataRoot, envFileVar, factorioExe, findFactorioDir } from "../../game/sandbox/paths.ts";
export { builtinMods, envFileVar, factorioExe, findFactorioDir };
export const labPath = dataPath;
export const labRel = dataRel;

/** 第二版 `<仓库>/knowledge/<名字>` 在新项目里的位置 (都在 training/ 下; 第二版 run.ts / online-lib.ts 搬来后照这个找) */
export function knowledgeFile(name: string): string {
  const map: Record<string, string[]> = {
    "facts.md": ["knowledge", "verified", "facts.md"],
    "brief-points.md": ["knowledge", "verified", "points.md"],
    "ref-index.md": ["manuals", "ref", "index.md"],
    "lessons-seed.json": ["lessons", "verified", "seed.json"],
    "lessons-learned.jsonl": ["lessons", "pending", "learned.jsonl"],
    patterns: ["patterns", "verified"],
  };
  return path.join(ROOT, "training", ...(map[name] ?? [name]));
}
export const REPO = ROOT;
export const labRoot = dataRoot;
