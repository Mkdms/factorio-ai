#!/usr/bin/env node
// 角色目录里 ./fh 的入口 (包装): 参数可以走文件 (--argv-file, PowerShell 版 fh.ps1 用; commands/argv-file.ts), 然后交给命令行 (commands/cli/cli.js) 子进程。
// 包装做的事: 起停服务器这类命令不给模型; 手册按段查 (ref-sections.ts); 聊天加富文本标签 (chattags.ts); 输出封顶 (output-cap.ts); 回复后面附相关积累 (hints.ts)。
// 环境变量由角色目录的包装脚本给: FH_SOCKET 管道、FH_REF_DIR 手册目录、FH_DEADLINE_FILE、FH_PROTO (游戏导出的名单目录)、FH_TRAINING (训练集根); 角色名和 --timeout --journal 也是包装脚本追加的。
// 给程序读的 (--format json、FH_MAX_OUTPUT=0) 不附东西、不封顶: 多一行就解析失败。
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { argvFromFile } from "./argv-file.ts";
import { FH_MAX_OUTPUT, capOutput } from "./output-cap.ts";

const BLOCKED = new Set(["start", "connect", "stop-session", "install", "deploy", "run", "stream"]);
const MESSAGE = new Set(["say", "tell"]);
const cli = fileURLToPath(new URL("./cli/cli.js", import.meta.url));
const args = argvFromFile(process.argv.slice(2));
const cmd = args[0] === "call" ? args[1] : args[0];
/** 第一个开关之前的位置参数 (包装脚本把 --bot --timeout --journal 接在最后, 不能当主题 / 段号) */
const positionals = (from: number): string[] => { const out: string[] = []; for (const a of args.slice(from)) { if (a.startsWith("--")) break; out.push(a); } return out; };
const helpPos = args[0] === "help" ? positionals(1) : [];
if (args[0] && BLOCKED.has(args[0])) { console.log(`error: ./fh ${args[0]} 不开放: 服务器和游戏由程序管, 只用游戏里的动作`); process.exit(2); }
const cap = process.env.FH_MAX_OUTPUT === undefined ? FH_MAX_OUTPUT : Number(process.env.FH_MAX_OUTPUT) || 0;
const forProgram = cap === 0 || args.includes("--format");
const note = (what: string, e: unknown) => { try { fs.appendFileSync(".fh-hints.err", `${new Date().toISOString()} ${what}: ${(e as Error).message}\n`); } catch { /* 写不上算了 */ } };

/** 这个角色在游戏里叫什么 */
function botName(a: string[]): string { const i = a.indexOf("--bot"); return i >= 0 ? a[i + 1] ?? "" : ""; }

// 手册按段查: ./fh help 主题 → 太大就回目录; ./fh help 主题 3 或 ./fh help 主题 P-prod-03 → 这一段
if (helpPos[0] && process.env.FH_REF_DIR) {
  try {
    const { manualAnswer } = await import("./ref-sections.ts");
    const text = manualAnswer(process.env.FH_REF_DIR, helpPos[0], helpPos[1], cap);
    if (text !== null) {
      // 和命令行自己答的一样记 journal (查手册的次数要能数)
      const j = args.indexOf("--journal");
      if (j >= 0 && args[j + 1]) { try { fs.appendFileSync(args[j + 1], `${JSON.stringify({ at: new Date().toISOString(), event: "help", topic: helpPos[0], ...(helpPos[1] ? { section: helpPos[1] } : {}) })}\n`); } catch { /* 记不上算了 */ } }
      process.stdout.write(`${text}\n`);
      process.exit(0);
    }
  } catch (e) { note("手册分段", e); }
}

// 聊天加标签: say 的文字是第一个位置参数 (tell 是第二个: 先收件人); "-" 表示从标准输入读
let input: string | undefined;
if (cmd && MESSAGE.has(cmd)) {
  try {
    const { chatTags, loadNameIndex } = await import("./chattags.ts");
    const idx = loadNameIndex(process.env.FH_PROTO ?? "");
    const at = args[0] === "call" ? 2 : 1;
    let pos = -1, seen = 0;
    for (let i = at; i < args.length; i++) {
      if (args[i].startsWith("--")) continue;
      if (seen === (cmd === "tell" ? 1 : 0)) { pos = i; break; }
      seen++;
    }
    if (idx.re && pos >= 0) {
      if (args[pos] === "-") input = chatTags(fs.readFileSync(0, "utf8"), idx);
      else args[pos] = chatTags(args[pos], idx);
    }
  } catch (e) { note("聊天标签", e); }
}

const r = spawnSync(process.execPath, [cli, ...args], { stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"], input, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const out = r.stdout ?? "";
process.stdout.write(forProgram ? out : capOutput(out, cap));
if (!forProgram && args[0] === "help" && !helpPos[0]) process.stdout.write("\n查全部积累 (思路 / 事实 / 教训 / 资料): ./know 关键词; 思路全文: ./fh help pattern-production 等\n");
// 回复后面附的: 放机器 / 查东西 / 报错接相关积累, 队友的事实; 这里出任何错都不能影响命令本身, 但要留痕 (.fh-hints.err)
if (!forProgram && !process.env.FH_NO_EXTRAS) {
  try {
    const { replyExtras } = await import("./hints.ts");
    const extra = await replyExtras(args, out, r.status ?? 1, {
      stateFile: ".fh-hints.json", now: Date.now(), me: botName(args),
      teamFile: fs.existsSync("../team.md") ? "../team-events.jsonl" : undefined,
      load: async () => {
        // sh 版 ./fh 带了 --env-file; 没带也兜住: 训练集根有默认值, 名单读不到就只按原词查
        const [{ loadZhNames }, { knowHint, loadKnowledge }] = await Promise.all([import("./chattags.ts"), import("../core/run/knowledge.ts")]);
        const zh = loadZhNames(process.env.FH_PROTO ?? "");
        const items = loadKnowledge();
        return { zh: (id) => zh.get(id), know: (q, n = 2) => { const t = knowHint(q, zh, n, 180, true, items); return t.length ? t : knowHint(q, zh, n, 180, false, items); } };
      },
      // 放机器时顺手递上: 配比 (src/play/calc-brief.ts) 和库里现成的块 (src/play/bp.ts); 算不出来 / 没库就不给, 不影响命令
      calc: async (item) => { try { const { calcBrief } = await import("../src/play/calc-brief.ts"); const { loadZhNames } = await import("./chattags.ts"); const zh = loadZhNames(process.env.FH_PROTO ?? ""); return calcBrief(item, (id) => zh.get(id)); } catch (e) { note("配比", e); return null; } },
      blocks: async (keyword) => { try { const { entries } = await import("../src/play/bp.ts"); const k = keyword.toLowerCase(); return entries().filter((e) => `${e.label} ${e.io ?? ""}`.toLowerCase().includes(k)).slice(0, 3).map((e) => `${e.no}. ${e.label}`); } catch (e) { note("蓝图候选", e); return []; } },
    });
    if (extra) process.stdout.write(`\n${extra}\n`);
  } catch (e) { note("附加", e); }
}
process.exit(r.status ?? 1);
