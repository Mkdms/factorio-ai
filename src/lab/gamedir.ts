// 转接 (第二版的 src/lab/gamedir.ts 在新项目里对应 game/sandbox/paths.ts): 第二版整目录搬来的 src/ 代码照原来的 import 路径用
import { ROOT, builtinMods, dataRoot, findFactorioDir } from "../../game/sandbox/paths.ts";
export { builtinMods, findFactorioDir };
export const REPO = ROOT;
export const labRoot = dataRoot;
