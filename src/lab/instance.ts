// 转接: 第二版的 src/lab/instance.ts (LabInstance) 在新项目里是 game/sandbox/server.ts (SandboxServer); 只有开发工具 (蓝图试放、喂料实测、计算器对照) 用, 方法名对不上的用到时再改
export { SandboxServer as LabInstance } from "../../game/sandbox/server.ts";
export { builtinMods, dataRoot as labRoot, findFactorioDir } from "../../game/sandbox/paths.ts";
