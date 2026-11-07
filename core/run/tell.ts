// 给模型递话 (库, 不直接运行): 监工的提醒、真人的话都从这里走。
// 走代理的 operator 通道进游戏外的模组账本 (tell): 进模型下一条 ./fh 回复的 team 块, 还能叫醒正在 ./fh sleep 的模型 (派对 tells.lua 的规矩, 每条 ≤ 480 字节)。
// 递不进去 (代理没起 / 只读) 就写角色目录的 .inbox.md, 钩子在它下一次工具调用后塞进上下文 (core/brains/hooks/hook.ts post-tool; 睡着时收不到)。
import fs from "node:fs";
import path from "node:path";
import { luaString } from "../../game/offgame/ingame.ts";

/** 模组的私信一条放不下太长的: 按字节切, 不切断一个字 */
export function chunks(text: string, max = 480): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) { if (Buffer.byteLength(cur + ch) > max) { out.push(cur); cur = ""; } cur += ch; }
  if (cur) out.push(cur);
  return out;
}

/** 把话递给这个角色的请求 (代理 operatorCall 认的形状: 和命令行发的一样, 多个 operator: true) */
export function tellCommands(to: string, text: string): string[] {
  return chunks(text).map((part) => {
    const body = JSON.stringify({ id: `fa-tell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, operator: true, action: "tell", args: { to, text: part } });
    return `/silent-command rcon.print(remote.call("agent_harness", "dispatch", ${luaString(body)}))`;
  });
}

export type TellPort = { operatorCall(command: string): Promise<{ ok: boolean; text?: string; error?: string }> } | null;

/** 递话; 回走了哪条路。全部记进记录目录的 tells.jsonl (谁、什么时候、哪条路) */
export async function tellModel(port: TellPort, o: { to: string; dir: string; runDir?: string; text: string; from?: string }): Promise<"tell" | "inbox"> {
  let how: "tell" | "inbox" = "inbox";
  if (port) {
    try {
      let ok = true;
      for (const c of tellCommands(o.to, o.text)) {
        const r = await port.operatorCall(c);
        if (!r.ok || !r.text || !(JSON.parse(r.text) as { ok?: boolean }).ok) { ok = false; break; }
      }
      if (ok) how = "tell";
    } catch { how = "inbox"; }
  }
  if (how === "inbox") fs.appendFileSync(path.join(o.dir, ".inbox.md"), o.text + "\n");
  if (o.runDir) { try { fs.appendFileSync(path.join(o.runDir, "tells.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), to: o.to, from: o.from ?? "监工", how, text: o.text })}\n`); } catch { /* 记不上算了 */ } }
  return how;
}
