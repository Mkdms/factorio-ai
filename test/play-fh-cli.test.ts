// 派对命令行 cli.js 的 --bot 名字校验补丁 (src/play/fh-cli.ts): 2026-11-05 真跑里 B/C/D 每条命令被 "--bot must be a bot name ([a-z][a-z0-9_-]{0,15})" 拦
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOT_NAME_RE_OURS, BOT_NAME_RE_UPSTREAM, fhCliPath, relaxBotNameCheck } from "../src/play/fh-cli.ts";

// 上游 dist/host/cli.js 里那两行的原文 (2026-11-05 查)
const UPSTREAM = [
  "    if (bot !== undefined && !/^[a-z][a-z0-9_-]{0,15}$/.test(bot))",
  "        throw new Error('--bot must be a bot name ([a-z][a-z0-9_-]{0,15})');",
  "    const brokerSocket = values.socket ?? (process.env.FH_SOCKET || undefined);",
].join("\n");

test("放开校验: 正则和报错文字都换成我们的 (大小写、点、32 个字符)", () => {
  const r = relaxBotNameCheck(UPSTREAM);
  assert.equal(r.patched, true);
  assert.ok(!r.text.includes(BOT_NAME_RE_UPSTREAM));
  assert.ok(r.text.includes(`!${BOT_NAME_RE_OURS}.test(bot)`));
  assert.match(r.text, /--bot must be a bot name \(\[A-Za-z\]\[A-Za-z0-9\._-\]\{0,31\}/);
  assert.ok(r.text.includes("brokerSocket"), "别的行不动");
  // 我们的正则真的放行模型名
  const re = new RegExp(BOT_NAME_RE_OURS.slice(1, -1));
  for (const n of ["Gpt-6.1-Terra", "Glm-5-Turbo", "Claude-Opus-5.5-2", "MiniMax-M3.1-Flash", "deepseek"]) assert.ok(re.test(n), n);
  assert.ok(!re.test("1abc") && !re.test("a b") && !re.test("x".repeat(33)));
});

test("上游改了写法找不到那一行: 不动, patched=false", () => {
  const r = relaxBotNameCheck("if (bot && !isBotName(bot)) throw new Error('bad bot');");
  assert.equal(r.patched, false);
});

test("fhCliPath: 在同目录写 cli.pilot.js, 内容一样就不重写, 源文件变了就重做", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fp-fhcli-"));
  const host = path.join(repo, "vendor", "factorio-harness", "dist", "host");
  fs.mkdirSync(host, { recursive: true });
  fs.writeFileSync(path.join(host, "cli.js"), UPSTREAM);
  const a = fhCliPath(repo);
  assert.equal(a.patched, true);
  assert.equal(path.basename(a.cli), "cli.pilot.js");
  assert.ok(fs.readFileSync(a.cli, "utf8").includes(BOT_NAME_RE_OURS));
  const m1 = fs.statSync(a.cli).mtimeMs;
  fhCliPath(repo);
  assert.equal(fs.statSync(a.cli).mtimeMs, m1, "没变就不重写");
  fs.writeFileSync(path.join(host, "cli.js"), "// v2\n" + UPSTREAM);
  const b = fhCliPath(repo);
  assert.ok(fs.readFileSync(b.cli, "utf8").startsWith("// v2"), "源文件变了副本跟着变");
  fs.writeFileSync(path.join(host, "cli.js"), "nothing to patch");
  const c = fhCliPath(repo);
  assert.equal(c.patched, false);
  assert.equal(path.basename(c.cli), "cli.js", "打不了补丁就用原文件");
  fs.rmSync(repo, { recursive: true, force: true });
});
