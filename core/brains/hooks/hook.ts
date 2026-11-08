#!/usr/bin/env node
// 大脑会话的钩子 (Claude Code 调用, 从标准输入读钩子数据): 记压缩、快满时提醒写笔记、压缩后贴回笔记; Bash 调用前先过等待规则 (拒串联 sleep),
// 再放行只由白名单程序组成的循环 / 管道 (permit.ts); Read / Grep / Glob 前查禁区 (read-guard.ts)。
// 照 factorio-ai-party (MIT) tools/context.py 的 hook; 只在有 .context-hooks 标记的目录里起作用 (online.ts 写进每个角色目录)。
//   node core/brains/hooks/hook.ts pre-tool | pre-read | pre-compact | post-compact | session-compact | post-tool --at 150000
import fs from "node:fs";
import path from "node:path";
import { claudeTokens, shouldNudge, recoveryBrief, NUDGE } from "./context.ts";
import { denyText, permit, sleepVerdict } from "./permit.ts";
import { readVerdict } from "./read-guard.ts";

const [event, ...args] = process.argv.slice(2);
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch { /* 没有输入 */ }
let payload: Record<string, any> = {};
try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { payload = {}; }
const dir: string = payload.cwd || process.cwd();
if (fs.existsSync(path.join(dir, ".context-hooks"))) {
  const statePath = path.join(dir, ".context-state.json");
  let state: Record<string, any> = {};
  try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { state = {}; }
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
  const log = (fields: Record<string, unknown>) => fs.appendFileSync(path.join(dir, "context.log"), JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + "\n");
  const transcript: string | undefined = payload.transcript_path;
  const at = args.includes("--at") ? Number(args[args.indexOf("--at") + 1]) : 0;

  if (event === "pre-tool") {
    const command = String(payload.tool_input?.command ?? "");
    const verdict = sleepVerdict(command);
    if (verdict) { log({ blocked: verdict }); process.stderr.write(verdict + "\n"); process.exit(2); }
    // 放行: dontAsk 下没有询问, 不回答 = 照常走 --allowedTools (简单的 ./fh … 本来就放行; 循环、管道、cd 自己目录 && … 原来被拒)
    if (permit(command, dir)) {
      log({ permitted: command.slice(0, 160) });
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
        permissionDecisionReason: "游戏命令: 只有白名单程序、列表 / 管道 / for / if 和工作区里的重定向 (permit.ts)" } }));
    } else {
      // 过不了规则的直接说清为什么: 不回答的话模型只看到 "don't ask 模式拒绝", 以为 Bash 全禁了 (见 denyText)
      const deny = denyText(command, dir);
      if (deny) {
        log({ denied: command.slice(0, 160) });
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: deny } }));
      }
    }
  } else if (event === "pre-read") {
    const verdict = readVerdict(String(payload.tool_name ?? ""), payload.tool_input, undefined, dir);
    if (verdict) { log({ blocked: verdict, tool: payload.tool_name, target: String(payload.tool_input?.file_path ?? payload.tool_input?.path ?? "").slice(0, 120) }); process.stderr.write(verdict + "\n"); process.exit(2); }
  } else if (event === "pre-compact") {
    // 离截止不到 2 分钟就拦下自动压缩 (派对 tools/context.py): 压缩要一两分钟, 压完已过截止, 最后的总结写不成
    let left = Infinity;
    try { const m = fs.readFileSync(path.join(dir, "deadline.txt"), "utf8").trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})(?::\d{2})?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/); if (m) left = Date.parse(`${m[1]}T${m[2].padStart(5, "0")}:00${m[3] ?? ""}`) - Date.now(); } catch { /* 没有截止文件 */ }
    log({ trigger: payload.trigger, tokens: transcript ? claudeTokens(transcript, state.since ?? 0) : null, ...(left < 120_000 ? { blocked: "截止前 2 分钟" } : {}) });
    if (left < 120_000 && payload.trigger === "auto") { process.stderr.write("离截止不到 2 分钟, 不压缩: 先把最后的总结写进 notes.md\n"); process.exit(2); }
  } else if (event === "post-compact") {
    const summary: string = payload.compact_summary ?? "";
    state.compactions = (state.compactions ?? 0) + 1;
    state.nudged = false;
    delete state.floor;
    if (transcript && fs.existsSync(transcript)) state.since = fs.statSync(transcript).size; // 之前的用量属于旧上下文
    save();
    log({ trigger: payload.trigger, summaryChars: summary.length, n: state.compactions });
    if (summary) fs.appendFileSync(path.join(dir, "compactions.md"), `\n## 第 ${state.compactions} 次压缩 (${new Date().toISOString()})\n\n${summary}\n`);
  } else if (event === "session-compact") {
    state.nudged = false;
    save();
    log({ source: payload.source });
    // 工具附过的配比、图、经验压缩后就没了, 下次相关的时候要重新给: 清 ./fh 提示的"给过"记录 (两条路的 .fh-hints.json 键一样: pic: / q:; 手放计数留着)
    try { (await import("../../../commands/hints.ts")).forgetShown(path.join(dir, ".fh-hints.json")); } catch { /* 附带的 */ }
    process.stdout.write(recoveryBrief(dir, "你的上下文刚被压缩过。"));
  } else if (event === "post-tool") {
    if (!state.hooksSeen) { state.hooksSeen = new Date().toISOString(); save(); } // 证明钩子加载了 (复盘时看)
    // 收件箱: 监工写进 .inbox.md 的话, 在下一次工具调用后塞给大脑 (不打断这一轮)
    const inboxPath = path.join(dir, ".inbox.md");
    let inbox = "";
    try { inbox = fs.readFileSync(inboxPath, "utf8").trim(); if (inbox) fs.writeFileSync(inboxPath, ""); } catch { /* 没有收件箱 */ }
    if (inbox) log({ action: "inbox", chars: inbox.length });
    let nudge = "";
    if (at && transcript && !state.nudged) {
      const tokens = claudeTokens(transcript, state.since ?? 0);
      if (tokens && state.floor === undefined) { state.floor = tokens; save(); } // 本窗口第一次工具调用时的上下文 (压缩后的起点)
      if (shouldNudge(tokens, at, state.floor ?? 0)) {
        state.nudged = true;
        save();
        log({ action: "nudge", tokens, at });
        nudge = NUDGE(tokens, at);
      }
    }
    const context = [inbox && `监工 (只给事实): ${inbox}`, nudge].filter(Boolean).join("\n\n");
    if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }));
  }
}
