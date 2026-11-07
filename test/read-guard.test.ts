// 大脑读文件的禁区 (core/brains/hooks/read-guard.ts、hook.ts pre-read); 不开游戏
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readVerdict } from "../core/brains/hooks/read-guard.ts";

const size = (p: string) => (p.endsWith("big.md") ? 50 * 1024 : p.endsWith("notes.md") ? 5 * 1024 : null);

test("readVerdict: 源码 / 模组 / 依赖 / 本机数据目录拦; 简报不重读; 大文件没带 limit 拦; 别的放行", () => {
  assert.match(readVerdict("Read", { file_path: "I:/fn/factorio-ai/game/mod/factorio-ai-harness/control.lua" }, size)!, /不读 game\//);
  assert.match(readVerdict("Grep", { path: "I:\\fn\\factorio-ai\\commands\\cli", pattern: "x" }, size)!, /不读 commands\//);
  assert.match(readVerdict("Glob", { path: "I:/fn/factorio-ai/node_modules", pattern: "**/*.js" }, size)!, /node_modules/);
  assert.match(readVerdict("Read", { file_path: "I:/fn/factorio-ai/data/accounts/keys.json" }, size)!, /不读 accounts\//);
  assert.match(readVerdict("Read", { file_path: "I:/brain/2026/b/AGENTS.md" }, size)!, /已经在你的系统提示里/);
  assert.match(readVerdict("Read", { file_path: "I:/brain/2026/b/ref/big.md" }, size)!, /50KB.*offset \/ limit/);
  assert.equal(readVerdict("Read", { file_path: "I:/brain/2026/b/ref/big.md", offset: 100, limit: 80 }, size), null, "带 limit 的大文件放行");
  assert.equal(readVerdict("Read", { file_path: "I:/brain/2026/b/notes.md" }, size), null);
  assert.equal(readVerdict("Read", { file_path: "I:/brain/2026/b/ref/moving-items.md" }, size), null, "不存在 / 读不到大小的放行");
  assert.equal(readVerdict("Grep", { pattern: "x" }, size), null, "没路径 (当前目录) 放行");
  assert.equal(readVerdict("Read", { file_path: "I:/brain/2026/b/world-scan.md" }, size), null);
});

test("给了角色目录: 绝对路径只许自己目录和上一层 (team.md), 别处 (用户的文件、仓库) 不给读; 相对路径照旧", () => {
  const cwd = "I:\\brain\\online-1\\a";
  assert.equal(readVerdict("Read", { file_path: "I:/brain/online-1/a/notes.md" }, size, cwd), null);
  assert.equal(readVerdict("Read", { file_path: "I:/brain/online-1/team.md" }, size, cwd), null);
  assert.equal(readVerdict("Read", { file_path: "/i/brain/online-1/a/ref/x.md" }, size, cwd), null, "Git Bash 写法的自己目录");
  assert.equal(readVerdict("Read", { file_path: "notes.md" }, size, cwd), null);
  assert.match(readVerdict("Read", { file_path: "C:/Users/x/.ssh/id_rsa" }, size, cwd)!, /只读你自己的目录/);
  assert.match(readVerdict("Grep", { path: "I:/brain/online-2/a", pattern: "x" }, size, cwd)!, /只读你自己的目录/);
  assert.match(readVerdict("Read", { file_path: "I:/fn/factorio-ai/.env" }, size, cwd)!, /只读你自己的目录/);
});

test("钩子 pre-read: 有标记才拦, 拦的退出码 2 并写原因", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fa-read-"));
  const hook = path.join(import.meta.dirname, "..", "core", "brains", "hooks", "hook.ts");
  const run = (tool: string, input: object) => spawnSync(process.execPath, [hook, "pre-read"], { input: JSON.stringify({ cwd: d, tool_name: tool, tool_input: input }), encoding: "utf8" });
  assert.equal(run("Read", { file_path: "C:/Windows/x.txt" }).status, 0); // 没标记
  fs.writeFileSync(path.join(d, ".context-hooks"), "");
  const r = run("Read", { file_path: "C:/Windows/x.txt" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /只读你自己的目录/);
  assert.equal(run("Read", { file_path: path.join(d, "notes.md") }).status, 0);
  assert.match(fs.readFileSync(path.join(d, "context.log"), "utf8"), /"blocked"/);
});
