// ./fh 的包装 (commands/fh.ts) 不开游戏能测的部分: help 不连游戏 —— 固定参数 (--bot --journal) 接在后面也认得出"没主题"; 大主题回目录; 不开放的命令拒; 给程序读的不附不封
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const FH = path.join(import.meta.dirname, "..", "commands", "fh.ts");

test("help: 包装脚本的固定参数在后面, 没主题就列主题并附 ./know 那行; 大主题回目录; 不开放的命令拒", () => {
  const ref = fs.mkdtempSync(path.join(os.tmpdir(), "fa-fhref-"));
  fs.writeFileSync(path.join(ref, "big.md"), `# 大主题\n## 一\n${"甲".repeat(6000)}\n## 二\n${"乙".repeat(6000)}\n`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fa-fhcwd-"));
  const run = (a: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [FH, ...a, "--bot", "Test", "--timeout", "90000", "--journal", path.join(cwd, "journal.jsonl")], { cwd, env: { ...process.env, FH_REF_DIR: ref, ...env }, encoding: "utf8", timeout: 60_000, windowsHide: true });
  const h = run(["help"]);
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /Reference topics[\s\S]*big/);
  assert.match(h.stdout, /\.\/know 关键词/);
  const toc = run(["help", "big"]);
  assert.match(toc.stdout, /^big 共 \d+ 字 3 段, 整份读太占上下文/);
  const sec = run(["help", "big", "3"]);
  assert.match(sec.stdout, /^big 第 3\/3 段\n## 二\n乙/);
  assert.match(fs.readFileSync(path.join(cwd, "journal.jsonl"), "utf8"), /"event":"help","topic":"big","section":"3"/, "包装答的手册也记 journal");
  const blocked = run(["start"]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stdout, /不开放/);
  assert.doesNotMatch(run(["help"], { FH_MAX_OUTPUT: "0" }).stdout, /\.\/know 关键词/, "给程序读的不附");
  fs.rmSync(ref, { recursive: true }); fs.rmSync(cwd, { recursive: true });
});
