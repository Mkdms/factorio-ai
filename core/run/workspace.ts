// 角色目录 (库): 模型干活的目录, 里面只有 ./fh 和 ./know (sh 和 PowerShell 两版; fh 经管道到我们的代理)、简报 (AGENTS.md / CLAUDE.md)、笔记、手册目录 ref/、截止时间。
// 模型手里没有 RCON 密码、没有服务器地址: 包装脚本里只有管道名。
// ref/ 里: 训练集 manuals/ref 的主题 (派对手册, MIT) + 思路 pattern-*.md + 事实表 facts.md + 官方中文名 names.tsv; ./fh help 主题 读这里。
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../game/sandbox/paths.ts";
import { argvFilePs1, calcPs1 } from "./ps1-wrap.ts";
import { loadZhNames } from "../../commands/chattags.ts";
import { manualFile, manualsDir, trainingFiles, trainingRoot, trainingRoots } from "./training.ts";

const fwd = (p: string) => p.replace(/\\/g, "/");

export const NOTES_TEMPLATE = `# 笔记 (每轮结束前更新; 下一轮的你先读这里)

## 现在在做
-

## 教训 (写成"情况 → 做法 → 为什么", 不带坐标)
-

## 日志
-
`;

/** 填角色目录的 ref/: 手册主题、思路、事实表、名单; 回放了几个文件 */
export function setupRef(refDir: string, o: { protoDir?: string; roots?: string[] } = {}): number {
  fs.mkdirSync(refDir, { recursive: true });
  let n = 0;
  const man = manualsDir(trainingRoot());
  for (const f of fs.existsSync(man) ? fs.readdirSync(man) : []) { if (/\.(md|tsv)$/.test(f) || f === "LICENSE") { fs.copyFileSync(path.join(man, f), path.join(refDir, f)); n++; } }
  const roots = o.roots ?? trainingRoots();
  for (const f of trainingFiles("patterns", "verified", ".md", roots)) {
    const base = path.basename(f);
    if (base === "README.md") continue;
    fs.copyFileSync(f, path.join(refDir, `pattern-${base}`)); n++;
  }
  for (const r of roots) { const facts = path.join(r, "knowledge", "verified", "facts.md"); if (fs.existsSync(facts)) { fs.copyFileSync(facts, path.join(refDir, "facts.md")); n++; break; } }
  if (o.protoDir) {
    const zh = loadZhNames(o.protoDir);
    if (zh.size) { fs.writeFileSync(path.join(refDir, "names.tsv"), `# 内部名\t官方中文名 (命令里写内部名, 说话用中文名)\n${[...zh].map(([k, v]) => `${k}\t${v}`).join("\n")}\n`); n++; }
  }
  return n;
}

/** 建角色目录; 回包装脚本的路径。brief 可以是字符串, 或按 ref/ 填好后的目录生成的函数 (手册目录要先放好才知道有哪些主题) */
export function setupWorkspace(o: { dir: string; name: string; pipe: string; brief: string | ((refDir: string) => string); deadline: number; nodeBin?: string; /** 游戏导出的名单目录 (ref/names.tsv、聊天标签、./know 互查) */ protoDir?: string }): { fh: string; fhPs1: string; know: string; knowPs1: string; refFiles: number } {
  const node = o.nodeBin ?? process.execPath;
  const refDir = path.join(o.dir, "ref");
  const refFiles = setupRef(refDir, { protoDir: o.protoDir });
  const brief = typeof o.brief === "string" ? o.brief : o.brief(refDir);
  fs.writeFileSync(path.join(o.dir, "AGENTS.md"), brief);
  fs.writeFileSync(path.join(o.dir, "CLAUDE.md"), brief); // Claude Code 读 CLAUDE.md
  if (!fs.existsSync(path.join(o.dir, "notes.md"))) {
    let notes = NOTES_TEMPLATE;
    try { notes = fs.readFileSync(manualFile("notes.md"), "utf8"); } catch { /* 没有模板用内置的 */ }
    fs.writeFileSync(path.join(o.dir, "notes.md"), notes);
  }
  fs.writeFileSync(path.join(o.dir, "deadline.txt"), `${new Date(o.deadline).toISOString()}\n`);
  const envFile = path.join(ROOT, ".env");
  const script = path.join(ROOT, "commands", "fh.ts");
  const journal = path.join(o.dir, "journal.jsonl");
  const env = { FH_SOCKET: o.pipe, FH_ONLINE: "1", FH_REF_DIR: refDir, FH_DEADLINE_FILE: path.join(o.dir, "deadline.txt"), FH_PROTO: o.protoDir ?? "", FH_TRAINING: trainingRoot(), PYTHONUTF8: "1" };
  // ./know 关键词: 查全部积累 (commands/know.ts); 不经管道
  const knowScript = path.join(ROOT, "commands", "know.ts");
  const knowEnv = { FH_PROTO: o.protoDir ?? "", FH_TRAINING: trainingRoot(), PYTHONUTF8: "1" };
  const know = path.join(o.dir, "know");
  fs.writeFileSync(know, ["#!/bin/sh", `export ${Object.entries(knowEnv).map(([k, v]) => `${k}='${fwd(v)}'`).join(" ")}`, `exec '${fwd(node)}' '--env-file-if-exists=${fwd(envFile)}' '${fwd(knowScript)}' "$@"`, ""].join("\n"));
  const knowPs1 = path.join(o.dir, "know.ps1");
  fs.writeFileSync(knowPs1, argvFilePs1(node, envFile, knowScript, [], knowEnv));
  // 联机: 管道代替 RCON; 动作要做几秒, --timeout 给够 (不然命令行 5 秒没回就重发, 回复里多一段"重发了几次")
  const fixed = ["--bot", o.name, "--timeout", "90000", "--journal", journal];
  const fh = path.join(o.dir, "fh");
  fs.writeFileSync(fh, [
    "#!/bin/sh",
    `export ${Object.entries(env).map(([k, v]) => `${k}='${fwd(v)}'`).join(" ")}`,
    `exec '${fwd(node)}' '--env-file-if-exists=${fwd(envFile)}' '${fwd(script)}' "$@" ${fixed.map((a) => `'${a}'`).join(" ")}`,
    "",
  ].join("\n"));
  const fhPs1 = path.join(o.dir, "fh.ps1");
  fs.writeFileSync(fhPs1, argvFilePs1(node, envFile, script, fixed, env));
  // ./calc ./bp ./plan: 第二版整目录搬来的 src/ (calc / play / blueprint), 照原来的用法; bp build 和 plan 经同一条管道走玩家操作 (FH_ONLINE), 没有 RCON
  const toolEnv = { FH_SOCKET: o.pipe, FH_ONLINE: "1", FH_PROTO: o.protoDir ?? "", PYTHONUTF8: "1" };
  const exportLine = `export ${Object.entries(toolEnv).map(([k, v]) => `${k}='${fwd(v)}'`).join(" ")}`;
  const calcCli = path.join(ROOT, "src", "calc", "cli.ts");
  // ./calc '<方案 JSON>': 方案写进 .calc-plan.json 再跑计算器 (JSON 参数经 shell 转手会拆坏), 往 .calc.log 记一行 (监工看有没有算过)
  fs.writeFileSync(path.join(o.dir, "calc"), ["#!/bin/sh", "date +%s >> .calc.log", `printf '%s' "$1" > .calc-plan.json && CALC_IDS=1 exec '${fwd(node)}' '--env-file-if-exists=${fwd(envFile)}' '${fwd(calcCli)}' .calc-plan.json`, ""].join("\n"));
  fs.writeFileSync(path.join(o.dir, "calc.ps1"), calcPs1(node, envFile, calcCli));
  for (const [name, rel] of [["bp", ["src", "play", "bp.ts"]], ["plan", ["src", "play", "plan.ts"]]] as const) {
    const s = path.join(ROOT, ...rel);
    fs.writeFileSync(path.join(o.dir, name), ["#!/bin/sh", exportLine, `exec '${fwd(node)}' '--env-file-if-exists=${fwd(envFile)}' '${fwd(s)}' "$@"`, ""].join("\n"));
    fs.writeFileSync(path.join(o.dir, `${name}.ps1`), argvFilePs1(node, envFile, s, [], toolEnv));
  }
  return { fh, fhPs1, know, knowPs1, refFiles };
}
