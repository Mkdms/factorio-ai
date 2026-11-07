// 这个世界走哪条路 (纯函数):
// - 本地存档 / 新地图 (自己起的服务器): RCON + 模组, 功能最全, 没有不同步的问题
// - 联机服务器明确开了 RCON: 同样 RCON + 模组; 服务器上没装模组时 RCON 也调不到模组, 退回内存外挂
// - 联机服务器没开 RCON (联机服务器就是这样): 内存外挂 (commands/broker.ts mode = server): 游戏里不跑代码, 读内存, 动作发玩家操作
// 联机的群可以自己选: 自动 / 内存外挂 / RCON, 默认自动。
// "服务器上有没有模组"不能用 Lua 探: 在 RCON 上跑一条 Lua 这张图就不能拿成就了, 而"开了 RCON 没装模组"正是还能拿成就的情况。干净客户端进得去 = 没装 (src/play/online.ts)。
export type WorldKind = "new" | "save" | "server";
export type Backend = "rcon" | "memory";
export type BackendPref = "auto" | "memory" | "rcon";
export const BACKEND_PREFS: readonly BackendPref[] = ["auto", "memory", "rcon"];
/** problem: 这样走不通, 报给用户, 不开 */
export type BackendChoice = { backend: Backend; why: string; problem?: string };

/** 群文件和命令行来的值 → 选项; 别的都算没选 (自动) */
export const cleanBackendPref = (v: unknown): BackendPref => (v === "memory" || v === "rcon" ? v : "auto");

/** rcon: 服务器明确给了 RCON (地址 + 密码); harnessOnServer: 查到模组了吗 (没查过 = undefined); prefer: 用户选的, 只对联机服务器有用 */
export function chooseBackend(world: { kind: WorldKind; rcon?: boolean; harnessOnServer?: boolean; prefer?: BackendPref }): BackendChoice {
  if (world.kind !== "server") return { backend: "rcon", why: "本地存档, 自己起的服务器, 开 RCON + 模组" };
  if (world.prefer === "memory") {
    if (world.harnessOnServer === true) return { backend: "memory", why: "你选了内存外挂", problem: "服务器装了别的模组, 干净客户端进不去; 改选自动或 RCON" };
    return { backend: "memory", why: "你选了内存外挂: 游戏里不跑代码" };
  }
  if (world.prefer === "rcon") {
    if (!world.rcon) return { backend: "rcon", why: "你选了 RCON", problem: "选了 RCON, 但没填 RCON 的地址和密码" };
    if (world.harnessOnServer === false) return { backend: "rcon", why: "你选了 RCON", problem: "RCON 连上了, 但服务器没装我们的模组 (agent_harness), RCON 调不到; 改选自动或内存外挂" };
    return { backend: "rcon", why: "你选了 RCON + 模组" };
  }
  if (!world.rcon) return { backend: "memory", why: "联机服务器没开 RCON: 内存外挂, 游戏里不跑代码" };
  if (world.harnessOnServer === false) return { backend: "memory", why: "服务器开了 RCON 但没装模组: RCON 调不到模组, 用内存外挂" };
  return { backend: "rcon", why: "服务器明确开了 RCON: RCON + 模组" };
}
