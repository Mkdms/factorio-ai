// 角色目录 (库): 模型干活的目录, 里面只有 ./fh (sh 和 PowerShell 两版, 都经管道到我们的代理)、简报 (AGENTS.md / CLAUDE.md)、笔记、手册目录 ref/、截止时间。
// 模型手里没有 RCON 密码、没有服务器地址: 包装脚本里只有管道名。
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../game/sandbox/paths.ts";
import { argvFilePs1 } from "./ps1-wrap.ts";

const fwd = (p: string) => p.replace(/\\/g, "/");

export const NOTES_TEMPLATE = `# 笔记 (每轮结束前更新; 下一轮的你先读这里)

## 现在在做
-

## 学到的 (写成"情况 → 做法 → 为什么", 带坐标的另写)
-

## 下一步
-
`;

/** 建角色目录; 回包装脚本的路径 */
export function setupWorkspace(o: { dir: string; name: string; pipe: string; brief: string; deadline: number; nodeBin?: string }): { fh: string; fhPs1: string } {
  const node = o.nodeBin ?? process.execPath;
  fs.mkdirSync(path.join(o.dir, "ref"), { recursive: true });
  fs.writeFileSync(path.join(o.dir, "AGENTS.md"), o.brief);
  fs.writeFileSync(path.join(o.dir, "CLAUDE.md"), o.brief); // Claude Code 读 CLAUDE.md
  if (!fs.existsSync(path.join(o.dir, "notes.md"))) fs.writeFileSync(path.join(o.dir, "notes.md"), NOTES_TEMPLATE);
  fs.writeFileSync(path.join(o.dir, "deadline.txt"), `${new Date(o.deadline).toISOString()}\n`);
  const envFile = path.join(ROOT, ".env");
  const script = path.join(ROOT, "commands", "fh.ts");
  const journal = path.join(o.dir, "journal.jsonl");
  const env = { FH_SOCKET: o.pipe, FH_ONLINE: "1", FH_REF_DIR: path.join(o.dir, "ref"), FH_DEADLINE_FILE: path.join(o.dir, "deadline.txt"), PYTHONUTF8: "1" };
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
  return { fh, fhPs1 };
}
