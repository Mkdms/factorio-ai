// 参数走文件 (src/play/argv-file.ts): Grok 的 .ps1 包装把 $args 写成 JSON 数组文件, node 侧读回并拼上固定参数
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { argvFromFile } from "../src/play/argv-file.ts";

test("没有 --argv-file 时原样返回; 有时读文件、删文件、拼上后面的固定参数 (JSON 参数完整)", () => {
  assert.deepEqual(argvFromFile(["call", "status"]), ["call", "status"]);
  const f = path.join(os.tmpdir(), `fp-argv-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify(["call", "observe", "--args", '{"radius":24}']));
  assert.deepEqual(argvFromFile(["--argv-file", f, "--player", "1", "--journal", "j.jsonl"]), ["call", "observe", "--args", '{"radius":24}', "--player", "1", "--journal", "j.jsonl"]);
  assert.ok(!fs.existsSync(f), "读完删掉");
  fs.writeFileSync(f, JSON.stringify([]));
  assert.deepEqual(argvFromFile(["--argv-file", f]), []);
  fs.writeFileSync(f, JSON.stringify({ a: 1 }));
  assert.throws(() => argvFromFile(["--argv-file", f]), /不是数组/);
  // PowerShell 按类型传: ./fh sleep 60、./plan x 30 --near -25,20 (2026-11-05 新图班撞上)
  fs.writeFileSync(f, JSON.stringify(["automation-science-pack", 30, "--near", [-25, 20]]));
  assert.deepEqual(argvFromFile(["--argv-file", f]), ["automation-science-pack", "30", "--near", "-25,20"]);
  assert.throws(() => argvFromFile(["--argv-file", path.join(os.tmpdir(), "no-such-argv.json")]), /读不了/);
});
