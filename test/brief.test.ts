// 简报和角色目录 (core/run/brief.ts、workspace.ts): 模板填满、手册目录齐、./know 包装在; 不开游戏
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeBrief, refIndex, topicIndex } from "../core/run/brief.ts";
import { setupRef, setupWorkspace } from "../core/run/workspace.ts";
import { onlineBrief } from "../core/run/online-lib.ts";
import { trainingRoot } from "../core/run/training.ts";
import { dataRoot } from "../game/sandbox/paths.ts";

test("派对的目录缩成 主题: 讲什么; 直播主题不要", () => {
  const rows = topicIndex("## Reference topics\n\n- `moving-items`, items by hand: `transfer`, `collect`.\n- `stream-people`, your stream: `x`.\n- `building`, placing, removing,\n  landfill: `build`.\n");
  assert.deepEqual(rows, ["- `moving-items`: items by hand", "- `building`: placing, removing, landfill"]);
});

test("ref/: 训练集的手册主题 + 思路 pattern-*.md + 事实表; 简报模板填满, 没有剩下的占位符", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ref-"));
  const n = setupRef(d, { roots: [trainingRoot()] });
  assert.ok(n >= 15, `只放了 ${n} 个`);
  for (const f of ["building.md", "moving-items.md", "index.md", "topics.tsv", "LICENSE", "pattern-production.md", "facts.md"]) assert.ok(fs.existsSync(path.join(d, f)), f);
  assert.ok(!fs.existsSync(path.join(d, "pattern-README.md")));
  assert.ok(!fs.existsSync(path.join(d, "stream-people.md")));
  const index = refIndex(d);
  assert.match(index, /- `building`:/);
  assert.match(index, /- `pattern-production`: 生产思路/);
  assert.match(index, /- `facts`:/);
  const world = onlineBrief({ name: "Claude-Opus", server: false, readOnly: false });
  const b = composeBrief({ world, name: "Claude-Opus", refDir: d, goal: "先把红瓶做到每分钟 30" });
  assert.doesNotMatch(b, /\{\{/);
  assert.match(b, /## 先读这一节/);
  assert.match(b, /`Claude-Opus`/);
  assert.match(b, /## 用户这一班给你的任务\n\n先把红瓶做到每分钟 30/);
  assert.match(b, /\.\/know 关键词/);
  assert.doesNotMatch(composeBrief({ world, name: "x", refDir: d }), /用户这一班给你的任务/);
  assert.throws(() => composeBrief({ world, name: "x", refDir: d, template: "{{WORLD}} {{NOPE}}" }), /NOPE/);
  fs.rmSync(d, { recursive: true });
});

test("角色目录: fh / know 两版包装、简报、笔记模板 (有教训一节)、截止; 包装里没有密码; 有名单就写 names.tsv", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ws-"));
  const proto = path.join(dataRoot(), "prototypes");
  const sub = fs.existsSync(proto) ? fs.readdirSync(proto).find((x) => fs.existsSync(path.join(proto, x, "locale", "zh-CN"))) : undefined;
  const r = setupWorkspace({ dir, name: "Test", pipe: "\\\\.\\pipe\\fa-test", deadline: Date.now() + 60_000, protoDir: sub ? path.join(proto, sub) : undefined, brief: (refDir) => `简报 ${fs.readdirSync(refDir).length}` });
  for (const f of ["fh", "fh.ps1", "know", "know.ps1", "AGENTS.md", "CLAUDE.md", "notes.md", "deadline.txt", "ref"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /^简报 \d+/);
  assert.match(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), /## 教训/);
  for (const f of ["fh", "fh.ps1", "know", "know.ps1"]) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), "utf8"), /rcon|password/i, f);
  assert.match(fs.readFileSync(path.join(dir, "know"), "utf8"), /commands\/know\.ts/);
  assert.match(fs.readFileSync(path.join(dir, "fh"), "utf8"), /FH_TRAINING=/);
  if (sub) {
    assert.match(fs.readFileSync(path.join(dir, "ref", "names.tsv"), "utf8"), /stone-furnace\t石炉/);
    assert.ok(r.refFiles >= 16);
  }
  fs.rmSync(dir, { recursive: true });
});
