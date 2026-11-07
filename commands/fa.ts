#!/usr/bin/env node
// fa: 模型玩游戏用的命令行。一条命令 = 一个动作, 发给本地中转 (core/broker.ts), 由它转进游戏。
//   fa help                       这段说明
//   fa describe                   列出全部动作和参数
//   fa ACTION [JSON | @文件] [--json]   做一个动作; 参数是一个 JSON 对象; --json 原样打印回复
// 环境变量 (开班时写在角色目录的 fa 脚本里): FA_BROKER 中转地址, FA_TOKEN 这个角色的令牌, FA_JOURNAL 记录文件
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { compact, cap } from "./format.ts";

export type Parsed = { help?: boolean; action?: string; args: Record<string, unknown>; json: boolean; error?: string };

export function parseArgv(argv: string[]): Parsed {
  const json = argv.includes("--json");
  const pos = argv.filter((a) => a !== "--json");
  if (!pos.length || pos[0] === "help" || pos[0] === "-h" || pos[0] === "--help") return { help: true, args: {}, json };
  const action = pos[0];
  let raw = pos[1];
  if (raw === undefined) return { action, args: {}, json };
  if (raw.startsWith("@")) {
    try { raw = fs.readFileSync(raw.slice(1), "utf8"); } catch { return { action, args: {}, json, error: `读不到参数文件 ${raw.slice(1)}` }; }
  }
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { action, args: {}, json, error: "参数要是一个 JSON 对象, 例: '{\"radius\": 32}'" };
    return { action, args: v, json };
  } catch { return { action, args: {}, json, error: `参数不是 JSON: ${raw.slice(0, 120)} (Windows 命令行里把 JSON 用单引号包起来)` }; }
}

export const HELP = `fa: 用玩家的方式玩 Factorio (够得着、只用背包里的东西、花真实时间)。
  fa describe                      列出全部动作和参数
  fa status                        自己的状态
  fa observe '{"radius": 32}'      周围有什么
  fa inventory                     背包
  fa say '{"text": "我去挖铁"}'     在聊天里说
  fa chat / fa inbox               最近的聊天 / 管理员的留言
  fa ACTION [JSON | @文件] [--json] 任何动作; 参数太长就写进文件用 @文件
回复是给你看的紧凑文字; 出错以 error: 开头。断线时结果未知: 先 fa status 再决定, 不要盲目重发。`;

export function formatReply(reply: { ok: boolean; result?: unknown; error?: { code: string; message: string } }, json: boolean): string {
  if (json) return JSON.stringify(reply);
  if (!reply.ok) return `error: ${reply.error?.message ?? "未知错误"} (${reply.error?.code ?? "?"})`;
  return cap(compact(reply.result));
}

async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv);
  if (p.help) { console.log(HELP); return 0; }
  if (p.error) { console.log(`error: ${p.error}`); return 1; }
  const broker = process.env.FA_BROKER, token = process.env.FA_TOKEN;
  if (!broker || !token) { console.log("error: 没有 FA_BROKER / FA_TOKEN (这条命令要在角色目录里经 ./fa 跑)"); return 2; }
  const request = { id: randomUUID(), action: p.action!, args: p.args };
  const t0 = Date.now();
  let reply: { ok: boolean; result?: unknown; error?: { code: string; message: string } };
  try {
    const r = await fetch(`${broker}/act`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(request) });
    reply = (await r.json()) as typeof reply;
  } catch (e) {
    reply = { ok: false, error: { code: "broker_unreachable", message: `连不上中转 ${broker}: ${(e as Error).message}` } };
  }
  if (process.env.FA_JOURNAL) {
    try { fs.appendFileSync(process.env.FA_JOURNAL, JSON.stringify({ at: new Date(t0).toISOString(), ms: Date.now() - t0, request, reply: { ok: reply.ok, tick: (reply as { tick?: number }).tick, error: reply.error, result: p.action === "describe" ? undefined : reply.result } }) + "\n"); } catch { /* 记录写不上不影响命令 */ }
  }
  console.log(formatReply(reply, p.json));
  return reply.ok ? 0 : 1;
}

if (process.argv[1] && /fa\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  process.exitCode = await main(process.argv.slice(2)).catch((e) => { console.log(`error: ${(e as Error).message.slice(0, 300)}`); return 2; });
}
