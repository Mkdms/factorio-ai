// 派对宿主命令行 (vendor/factorio-harness/dist/host/cli.js) 的本机补丁副本 (库, 不直接运行)。
// 2026-11-05 真跑班次 2026-11-04T18-28-17: 服务器角色名按用户定的规矩是模型名 (Gpt-6.1-Terra、Glm-5-Turbo), 派对的 cli.js 校验 `--bot` 仍是
// [a-z][a-z0-9_-]{0,15}, B/C/D 每一条 ./fh 都被客户端拦 ("--bot must be a bot name"), 一班白跑; 模组 control.lua:315 还有同一条 (移植脚本 tools/port-party-harness.py 同时放开)。
// 不改他们的文件: 在同一目录写 cli.pilot.js (只替换那一处; 它只 import node 内建模块, 放同目录即可), 源文件变了就重做; 找不到那一处 (上游改了写法) 就用原文件并报 patched=false。
import fs from "node:fs";
import path from "node:path";

export const BOT_NAME_RE_UPSTREAM = "/^[a-z][a-z0-9_-]{0,15}$/";
export const BOT_NAME_RE_OURS = "/^[A-Za-z][A-Za-z0-9._-]{0,31}$/";
const MSG_UPSTREAM = "--bot must be a bot name ([a-z][a-z0-9_-]{0,15})";
const MSG_OURS = "--bot must be a bot name ([A-Za-z][A-Za-z0-9._-]{0,31}; Factorio Pilot: bot names = model names)";

/** 把 cli.js 里 --bot 的名字校验放开成和我们移植的模组一样 (大小写、点, 32 个字符) */
export function relaxBotNameCheck(text: string): { text: string; patched: boolean } {
  if (!text.includes(BOT_NAME_RE_UPSTREAM)) return { text, patched: false };
  return { text: text.split(BOT_NAME_RE_UPSTREAM).join(BOT_NAME_RE_OURS).split(MSG_UPSTREAM).join(MSG_OURS), patched: true };
}

/** 给 ./fh 用的命令行路径: 能打补丁就是同目录的 cli.pilot.js (内容和源文件对不上就重写), 不能就是原文件 */
export function fhCliPath(partyRepo: string): { cli: string; patched: boolean } {
  const src = path.join(partyRepo, "vendor", "factorio-harness", "dist", "host", "cli.js");
  const dst = path.join(path.dirname(src), "cli.pilot.js");
  try {
    const r = relaxBotNameCheck(fs.readFileSync(src, "utf8"));
    if (!r.patched) return { cli: src, patched: false };
    let cur: string | null = null;
    try { cur = fs.readFileSync(dst, "utf8"); } catch { /* 还没有 */ }
    if (cur !== r.text) fs.writeFileSync(dst, r.text);
    return { cli: dst, patched: true };
  } catch { return { cli: src, patched: false }; }
}
