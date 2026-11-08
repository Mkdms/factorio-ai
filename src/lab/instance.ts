// 转接: 第二版的 src/lab/instance.ts (LabInstance) 在新项目里是 game/sandbox/server.ts (SandboxServer; 方法和字段同名: exec / rpc / start / stop / createMap / prepare / attach / release / saveNow / savePath, rcon / rconPort / password / gamePort / dir / save / pid / alive)。
// 第二版 run.ts (装模组 + RCON 那条路, 后期不要成就时的全性能备用路; docs/decisions.md 2026-11-08) 用 `new LabInstance({ repoMods: ["agent-harness-party", "factoryplanner"], … })`,
// 模组名按第二版 mods/ 下的目录写; 新项目的模组在 game/mod/ 下并改了名, 这里对应过去。
import fs from "node:fs";
import path from "node:path";
import { SandboxServer, type ServerOptions } from "../../game/sandbox/server.ts";
export { freeTcpPort, freeUdpPort } from "../../game/sandbox/server.ts";
import { MOD_ROOT } from "../../game/sandbox/paths.ts";
export { builtinMods, dataRoot as labRoot, findFactorioDir } from "../../game/sandbox/paths.ts";

/** 第二版的模组目录名 → 新项目 game/mod/ 下的目录名; null = 沙盘模组本身 (SandboxServer 总是装, 不用再给) */
export const MOD_NAMES: Record<string, string | null> = { "io-lab": null, "agent-harness": "factorio-ai-harness", "agent-harness-party": "factorio-ai-harness" };

/** 第二版的 repoMods → 新项目要装的模组 (不认识的按原名; game/mod/ 下没有的丢掉, 用 exists 判) */
export function mapRepoMods(repoMods: string[] = [], exists: (name: string) => boolean = (n) => fs.existsSync(path.join(MOD_ROOT, n))): string[] {
  const out: string[] = [];
  for (const m of repoMods) {
    const t = m in MOD_NAMES ? MOD_NAMES[m] : m;
    if (t && exists(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

export type LabOptions = Omit<ServerOptions, "mods"> & { /** 第二版写法: mods/ 下的目录名 */ repoMods?: string[]; mods?: string[] };

export class LabInstance extends SandboxServer {
  constructor(o: LabOptions) {
    const { repoMods, mods, ...rest } = o;
    super({ ...rest, mods: [...mapRepoMods(repoMods), ...(mods ?? [])] });
  }
}
