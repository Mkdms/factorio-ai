import { test } from "node:test";
import assert from "node:assert/strict";
import { grokArgs, grokSharedAllow } from "../src/play/grok-args.ts";

const base = { n: 1, sessionId: "s", prompt: "你好", model: "grok-4.7", effort: "low", allow: ["Bash(./fh *)", "Bash(python *)", "Read", "WebSearch"], web: true };

test("Grok 不带 --add-dir (1.0.70 报 additionalDirectories is not supported)", () => {
  assert.ok(!grokArgs({ ...base, shared: "I:\\brain\\run" }).includes("--add-dir"));
});

test("多角色放行写共享目录: 相对和绝对写法, 反斜杠换成正斜杠", () => {
  const a = grokArgs({ ...base, shared: "I:\\brain\\run\\" });
  for (const r of ["Edit(../team.md)", "Write(../team-tools/**)", "Edit(I:/brain/run/team.md)", "Write(I:/brain/run/team-tools/**)"]) assert.ok(a.includes(r), r);
  assert.equal(grokSharedAllow("I:/x").length, 16);
});

test("单角色不放行共享目录", () => {
  assert.ok(!grokArgs(base).some((x) => x.includes("team.md)")));
});

test("命令放行只取 Bash 规则, 另加反斜杠写法; python 不重复变形", () => {
  const a = grokArgs(base);
  assert.ok(a.includes("Bash(./fh *)") && a.includes("Bash(.\\fh *)") && a.includes("Bash(python *)"));
  assert.ok(!a.includes("Read") && !a.includes("WebSearch"));
});

test("联网跟完整工具走; 第 2 轮起接着会话", () => {
  assert.ok(!grokArgs(base).includes("--disable-web-search"));
  assert.ok(grokArgs({ ...base, web: false }).includes("--disable-web-search"));
  assert.deepEqual(grokArgs(base).slice(2, 4), ["-s", "s"]);
  assert.deepEqual(grokArgs({ ...base, n: 2 }).slice(2, 4), ["-r", "s"]);
});
