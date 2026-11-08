#!/usr/bin/env node
// 装模组那条路 (run.ts --kit party) 角色目录里 ./fh 的入口: 先经过这里, 再交给命令行 (FH_CLI = commands/cli/cli.js, src/play/partykit.ts 写的包装)。
// 第二版原文 (2026-11-08 恢复: 搬家时换成了不装模组那条路的 commands/fh.ts, 丢了下面带 RCON 的两样: 贴蓝图先干跑, 放机器时查空地 / 数缺几台 / "手放第 N 台"的事实):
// - 游戏聊天加富文本标签 (星球前缀、坐标 → [gps]、官方中文名前加图标);
// - 起停服务器、部署运行时这类命令不给大脑 (沙盘由监工管)。
// 去掉的只有第二版读内存那条路的 FH_BACKEND=io 分支 (src/io/fh-read-run.ts 已由 game/ 和 commands/ 取代)。
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { chatTags, loadNameIndex } from "./chattags.ts";
import { argvFromFile } from "./argv-file.ts";
import { FH_MAX_OUTPUT, capOutput } from "./output-cap.ts";

const BLOCKED = new Set(["start", "connect", "stop-session", "install", "deploy", "run", "stream"]);
const MESSAGE = new Set(["say", "tell"]);

const args = argvFromFile(process.argv.slice(2)); // .ps1 包装把参数写成文件 (argv-file.ts)
const cli = process.env.FH_CLI;
if (!cli || !fs.existsSync(cli)) { console.log(`error: 找不到命令行 (FH_CLI=${cli ?? ""})`); process.exit(2); }
const cmd = args[0] === "call" ? args[1] : args[0];
if (args[0] && BLOCKED.has(args[0])) { console.log(`error: ./fh ${args[0]} 不开放: 沙盘的服务器和模组由监工管, 只用游戏里的动作`); process.exit(2); }

/** 这个角色在游戏里叫什么 (队友事实不报自己) */
function botName(a: string[]): string { const i = a.indexOf("--bot"); return i >= 0 ? a[i + 1] ?? "" : ""; }

// 手册按段查 (ref-sections.ts): ./fh help 主题 → 太大就回目录; ./fh help 主题 3 或 ./fh help 主题 P-prod-03 → 这一段
if (args[0] === "help" && args[1] && process.env.FH_REF_DIR) {
  try {
    const { manualAnswer } = await import("./ref-sections.ts");
    const pos = args.slice(2).filter((a, i, all) => !a.startsWith("--") && !(all[i - 1] ?? "").startsWith("--"));
    const cap = process.env.FH_MAX_OUTPUT === undefined ? FH_MAX_OUTPUT : Number(process.env.FH_MAX_OUTPUT) || 0;
    const text = manualAnswer(process.env.FH_REF_DIR, args[1], pos[0], cap);
    if (text !== null) {
      // 和命令行自己答的一样记 journal (查手册的次数要能数)
      const j = args.indexOf("--journal");
      if (j >= 0 && args[j + 1]) { try { fs.appendFileSync(args[j + 1], `${JSON.stringify({ at: new Date().toISOString(), event: "help", topic: args[1], ...(pos[0] ? { section: pos[0] } : {}) })}\n`); } catch { /* 记不上算了 */ } }
      process.stdout.write(`${text}\n`);
      process.exit(0);
    }
  } catch (e) {
    try { fs.appendFileSync(".fh-hints.err", `${new Date().toISOString()} 手册分段: ${(e as Error).message}\n`); } catch { /* 写不上算了 */ }
  }
}

let input: string | undefined;
if (cmd && MESSAGE.has(cmd)) {
  const idx = (() => { try { return loadNameIndex(process.env.FH_PROTO ?? ""); } catch { return null; } })();
  const at = args[0] === "call" ? 2 : 1;
  // say 的文字是第一个位置参数 (tell 是第二个: 先收件人); "-" 表示从标准输入读
  let pos = -1, seen = 0;
  for (let i = at; i < args.length; i++) {
    if (args[i].startsWith("--")) continue; // 简报里的写法是文字在前 (./fh say "..."), 不猜哪个开关带值
    if (seen === (cmd === "tell" ? 1 : 0)) { pos = i; break; }
    seen++;
  }
  if (idx?.re && pos >= 0) {
    if (args[pos] === "-") input = chatTags(fs.readFileSync(0, "utf8"), idx);
    else args[pos] = chatTags(args[pos], idx);
  }
}

// 贴蓝图挡着树就拆树 (第二版 lab #85): 普通贴全有或全无, 先干跑; 只有树石挡路就 mode forced (树标拆除, construct 时砍掉); 挡着建筑不 forced (会留半块), 照原样贴并报挡路的
let pasteNote = "";
if (cmd === "paste" || cmd === "blueprint_place") {
  try {
    const { pasteArgs, pasteDecision } = await import("./bp-fit.ts");
    const p = pasteArgs(args);
    if (p) {
      const dryArgs = args.filter((a) => a !== "--wait").map((a, i) => (a === args[p.index] && i === args.indexOf("--args") + 1 ? JSON.stringify({ ...p.value, dry_run: true }) : a));
      const d = spawnSync(process.execPath, [cli, ...dryArgs, "--format", "json"], { stdio: ["ignore", "pipe", "ignore"], env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const parsed = JSON.parse(d.stdout) as { result?: Parameters<typeof pasteDecision>[0] };
      const { force, blockers } = pasteDecision(parsed.result ?? (parsed as Parameters<typeof pasteDecision>[0]));
      if (force) {
        args[p.index] = JSON.stringify({ ...p.value, mode: "forced" });
        pasteNote = "只有树和石头挡路: 用 mode forced 贴的, 它们已标拆除, ./fh call construct 时一起砍掉。";
      } else if (blockers.length) pasteNote = `挡路的 (干跑查的, 上面 not_placed 的坐标不准): ${blockers.slice(0, 8).join(", ")}${blockers.length > 8 ? ` 等 ${blockers.length} 件` : ""}。换个地方; 整块放用 ./bp build 编号 --at x,y, 放不下会回能放下的坐标。`;
    }
  } catch (e) {
    try { fs.appendFileSync(".fh-hints.err", `${new Date().toISOString()} paste 干跑: ${(e as Error).message}\n`); } catch { /* 写不上算了 */ }
  }
}

// 标准输出经封顶 (output-cap.ts; 省 token: 一次 28k 的 help 会一直留在上下文里); FH_MAX_OUTPUT 可改, 0 = 不封
const r = spawnSync(process.execPath, [cli, ...args], { stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"], input, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const max = process.env.FH_MAX_OUTPUT === undefined ? FH_MAX_OUTPUT : Number(process.env.FH_MAX_OUTPUT) || 0;
const out = r.stdout ?? "";
process.stdout.write(max > 0 ? capOutput(out, max) : out);
if (args[0] === "help" && !args[1]) process.stdout.write("\n按情况查 (要做 X 先跑什么): ./fh help index; 查全部积累: ./know 关键词\n");
if (pasteNote) process.stdout.write(`\n${pasteNote}\n`);
// 回复后面附的: 放机器给算好坐标的命令、查东西 / 报错接相关积累、队友用块的事实 (fh-hints.ts); 这里出任何错都不能影响命令本身
// 给程序读的不附: --format json / FH_MAX_OUTPUT=0 后面多一行就解析失败
if (!process.env.FH_NO_EXTRAS && process.env.FH_MAX_OUTPUT !== "0" && !args.includes("--format")) {
  let rcon: { close: () => void } | null = null;
  try {
    const { replyExtras } = await import("./fh-hints.ts");
    const extra = await replyExtras(args, out, r.status ?? 1, {
      stateFile: ".fh-hints.json", now: Date.now(), me: botName(args),
      teamFile: fs.existsSync("../team.md") ? "../team-events.jsonl" : undefined,
      load: async () => {
        // sh 版 ./fh 不带 --env-file: 蓝图库和游戏数据要 .env 里的 FACTORIO_DIR, 在这里加载 (命令行已经跑完, 不影响它的环境; 已有的变量不覆盖)
        try { process.loadEnvFile(new URL("../../.env", import.meta.url)); } catch { /* 没有 .env: 下面用默认路径 */ }
        const [{ listLines }, { loadZhNames }, { studyHint }, { calcBrief, machinesFor }, { knowHint, loadKnowledge }] = await Promise.all([import("./bp.ts"), import("./chattags.ts"), import("./bp-study.ts"), import("./calc-brief.ts"), import("../../core/run/knowledge.ts")]);
        const zh = loadZhNames(process.env.FH_PROTO ?? "");
        const items = loadKnowledge();
        // 查游戏 (找空地、数场上的机器): 只读; 用不到不连
        const exec = async (lua: string): Promise<any> => {
          if (!rcon) {
            const port = Number(process.env.FACTORIO_RCON_PORT), pwFile = process.env.FACTORIO_RCON_PASSWORD_FILE;
            if (!port || !pwFile) throw new Error("没有 RCON");
            const { RconClient } = await import("../lab/rcon.ts");
            const c = new RconClient({ port, password: fs.readFileSync(pwFile, "utf8").trim() });
            await c.connect();
            rcon = c;
          }
          return JSON.parse(await (rcon as unknown as { exec: (t: string, o?: { timeoutMs?: number }) => Promise<string> }).exec(`/silent-command local function main() ${lua.replace(/\r?\n\s*/g, " ")} end rcon.print(helpers.table_to_json(main()))`, { timeoutMs: 20_000 }));
        };
        const { siteLua } = await import("./plan-lib.ts");
        const { EXISTING_LUA, normalizeExisting } = await import("./expand.ts");
        return {
          // 联机没有 ./bp build (靠模组和 RCON): 蓝图块的命令不提
          list: (k: string) => (process.env.FH_ONLINE ? [] : listLines(k, 12)), zh: (id: string) => zh.get(id), stateFile: ".fh-hints.json", now: Date.now(),
          study: (k: string) => studyHint(k), calc: (k: string) => calcBrief(k, (id) => zh.get(id)),
          know: (n: string) => { const t = knowHint(n, zh, 2, 180, true, items); return t.length ? t : knowHint(n, zh, 2, 180, false, items); },
          knowQ: (q: string, n = 2) => knowHint(q, zh, n, 180, true, items),
          hasBlock: (name: string) => listLines(name, 1).length > 0,
          site: async (near: [number, number], w: number, h: number) => { const s = await exec(siteLua(near, w, h, [], 1)); return s?.found ? { x: s.x, y: s.y } : null; },
          gap: async (key: string) => { const need = machinesFor(key); if (need === null) return null; const ex = normalizeExisting(await exec(EXISTING_LUA)); return { need, have: ex.assemblers[key] ?? 0 }; },
        };
      },
    });
    if (extra) process.stdout.write(`\n${extra}\n`);
  } catch (e) {
    // 提示是附带的, 不影响命令; 但坏了要留痕, 不能闷声不发 (npm run play:seen 会数)
    try { fs.appendFileSync(".fh-hints.err", `${new Date().toISOString()} ${(e as Error).message}\n`); } catch { /* 写不上算了 */ }
  } finally { (rcon as { close: () => void } | null)?.close(); }
}
process.exit(r.status ?? 1);
