// ./calc 自动和游戏里的 Factory Planner 对一遍 (库, 不直接运行)。。
// 沙盘里 run.ts 把补丁版 FP (mods/factoryplanner, tools/patch-fp.py) 和模组一起装上, 它的 remote 接口 solve_packed 走这一班的 RCON, 不用另开窗口;
// 求解要玩家 1 (窗口连着的那个)。联机服务器没有这个模组: 接口不在就返回 null, ./calc 照常出自己的结果 (两边 18 条配方对过 0% 差, docs/calc.md)。
import fs from "node:fs";
import { RconClient } from "../lab/rcon.ts";
import type { GameData } from "./data.ts";
import type { Plan, Result } from "./solve.ts";
import { compareRows, comparisonLines, packFactory, parseFpResult } from "./fp.ts";

/** 长括号包住, Lua 字符串里不用转义 */
function bracket(s: string): [string, string] {
  let eq = "=";
  while (s.includes(`]${eq}]`)) eq += "=";
  return [`[${eq}[`, `]${eq}]`];
}

/** 对照结果的几行; 这一班没装 FP、连不上、没有玩家都返回 null, 不影响 ./calc */
export async function fpLive(gd: GameData, plan: Plan, ours: Result, sessionFile: string, name = "calc"): Promise<string[] | null> {
  if (!fs.existsSync(sessionFile)) return null;
  const s = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as { rconPort?: number; password?: string };
  if (!s.rconPort || !s.password) return null;
  const r = new RconClient({ port: s.rconPort, password: s.password });
  await r.connect();
  try {
    const ask = async (lua: string) => r.exec(`/silent-command ${lua}`, { timeoutMs: 20_000 });
    if ((await ask(`rcon.print(remote.interfaces["fp-interface"] and remote.interfaces["fp-interface"].solve_packed and game.get_player(1) and game.get_player(1).connected and "yes" or "no")`)).trim() !== "yes") return null;
    const { packed, notes } = packFactory(gd, plan, { solver: "sequential", name });
    const json = JSON.stringify(packed);
    const [open, close] = bracket(json);
    const raw = await ask(`rcon.print(helpers.table_to_json(remote.call("fp-interface", "solve_packed", 1, helpers.json_to_table(${open}${json}${close}))))`);
    const fp = parseFpResult(JSON.parse(raw));
    return fp.error ? [`FP 出错: ${fp.error}`] : comparisonLines(compareRows(ours, fp, notes));
  } finally { r.close(); }
}
