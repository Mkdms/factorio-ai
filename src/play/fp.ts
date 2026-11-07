#!/usr/bin/env node
// fp: 大脑玩游戏用的命令行 (docs/brain-run.md 第 3 步)。一条命令 = 一个动作; 输出是给模型看的压缩文字。
// 连哪个沙盘看会话文件 (play:run 启动时写; 环境变量 FP_SESSION 可指定), 每条请求和回复追加到会话的 requests.jsonl。
// 沙盘里由 agent-harness 模组执行; 联机时同一套命令由 io-client 实现 (brain-run.md "沙盘模组和联机服务器的关系")。
import fs from "node:fs";
import path from "node:path";
import { RconClient } from "../lab/rcon.ts";
import { labRoot } from "../lab/gamedir.ts";
import { Harness, idleWaitSeconds, type Reply } from "./harness.ts";
import { formatCompact } from "./format.ts";
import { chatTags, loadNameIndex } from "./chattags.ts";

/** bot: 服务器角色的名字 (派对分支版 harness; 多角色时第二个起用它), 有它就不用 player; agent: 写日志时标是谁 */
/** name = 这个角色在游戏里的名字 (玩家 1 是用户自己建的角色名, 服务器角色是 bot 名; 游戏里的名字一律不改);
 *  model = 大脑模型的显示名 ("Claude Opus 5.5", 只给我们的界面用; src/play/model-name.ts)。这两个 2026-11-03 加, 旧会话文件没有 */
export type Session = { rconPort: number; password: string; player: number; bot?: string; agent?: string; logDir: string; name?: string; model?: string; seat?: { brain: string; model: string }; left?: boolean; leftAt?: string };
export const sessionFile = () => process.env.FP_SESSION ?? path.join(labRoot(), "play", "session.json");
const MAX_OUT = 10_000;

const HELP = `fp: 用玩家的方式玩 Factorio (够得着、只用背包里的东西、花真实游戏时间)。
  fp describe                 列出全部动作
  fp describe ACTION          一个动作的参数说明
  fp status                   角色、正在做的动作、告警
  fp observe [JSON]           周围的东西 (例 '{"radius":24}')
  fp ACTION [JSON|@文件] [--wait] [--timeout 秒] [--json] [--blueprint-file 文件]
                              做一个动作; --wait 等定时动作 (走路、采矿、建造路线…) 结束再返回; 参数太长就写进文件用 @文件
例: fp move_to '{"position":{"x":10,"y":-4}}' --wait
    fp mine '{"position":{"x":12.5,"y":-3.5},"ticks":600}' --wait
    fp craft '{"recipe":"iron-gear-wheel","count":10}'
动作只报已接受; 定时动作要 --wait 或之后 fp status 看结果。断线时结果未知, 先 fp status 再决定, 不要盲目重发。`;

function print(text: string) {
  if (text.length <= MAX_OUT) { console.log(text); return; }
  console.log(text.slice(0, 8000) + `\n…截断: 共 ${text.length} 字符。缩小范围 (radius、limit、entity_names) 再查`);
}

async function main(argv: string[]) {
  const flags = new Set(argv.filter((a) => a === "--wait" || a === "--json"));
  const ti = argv.indexOf("--timeout");
  const timeoutMs = ti >= 0 ? Number(argv[ti + 1]) * 1000 : 60_000;
  const bi = argv.indexOf("--blueprint-file"); // 长蓝图字符串放文件里 (命令行放不下)
  const pos = argv.filter((a, i) => !a.startsWith("--") && !(ti >= 0 && i === ti + 1) && !(bi >= 0 && i === bi + 1));
  if (!pos.length || pos[0] === "help" || pos[0] === "-h") { console.log(HELP); return 0; }
  let cmd = pos[0];
  let rest = pos.slice(1);
  if (cmd === "call") { cmd = rest[0]; rest = rest.slice(1); }
  let args: Record<string, unknown> = {};
  if (rest[0] && cmd !== "describe") {
    // @文件 (第八轮: 大脑把长参数写进文件后连试 @file、--json < file 三种写法)
    if (rest[0].startsWith("@")) {
      try { rest[0] = fs.readFileSync(rest[0].slice(1), "utf8"); } catch { console.log(`error: 读不到参数文件 ${rest[0].slice(1)}`); return 1; }
    }
    try { args = JSON.parse(rest[0]); } catch { console.log(`error: 参数不是 JSON: ${rest[0].slice(0, 200)} (Windows 命令行里 JSON 用单引号包起来)`); return 1; }
  }
  if (bi >= 0) args.blueprint = fs.readFileSync(argv[bi + 1], "utf8").trim();
  const sf = sessionFile();
  if (!fs.existsSync(sf)) { console.log(`error: 没有正在运行的沙盘会话 (${sf})`); return 1; }
  const s = JSON.parse(fs.readFileSync(sf, "utf8")) as Session;
  const rcon = new RconClient({ port: s.rconPort, password: s.password });
  await rcon.connect();
  try {
    const h = new Harness(rcon, s.bot ?? s.player, (e) => fs.appendFileSync(path.join(s.logDir, "requests.jsonl"), JSON.stringify(s.agent ? { ...e, agent: s.agent } : e) + "\n"));
    if (cmd === "describe") {
      const r = await h.request("describe");
      if (!r.ok) { print(formatCompact(r)); return 1; }
      const acts = r.result.actions as Record<string, Record<string, string>>;
      if (rest[0] && !rest[0].startsWith("{")) {
        const a = acts[rest[0]];
        print(a ? formatCompact({ [rest[0]]: a }) : `error: 没有动作 ${rest[0]}; 有: ${Object.keys(acts).join(" ")}`);
        return a ? 0 : 1;
      }
      print(`动作 ${Object.keys(acts).length} 个 (fp describe 动作名 看参数):\n${Object.keys(acts).sort().join(" ")}\n\n限制: ${JSON.stringify(r.result.limitations ?? "")}`);
      return 0;
    }
    // 游戏聊天加富文本标签: 星球前缀、坐标 → [gps] (点开定位)、官方中文名前加图标 (搬自第一版 chat-responder / zh.ts)
    if ((cmd === "say" || cmd === "chat") && typeof args.text === "string") {
      try { args.text = chatTags(args.text, loadNameIndex(path.join(labRoot(), "prototypes"))); } catch { /* 名单读不到就原样发 */ }
    }
    const idleS = idleWaitSeconds(cmd, args);
    const reply: Reply = idleS !== null ? await h.waitIdle(idleS, args) : await h.call(cmd, args, { wait: flags.has("--wait"), timeoutMs });
    print(flags.has("--json") ? JSON.stringify(reply) : formatCompact(reply));
    return reply.ok ? 0 : 1;
  } finally {
    rcon.close();
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((e) => { console.log(`error: ${(e as Error).message.slice(0, 300)}`); return 2; });
