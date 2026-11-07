// 彻底删一班的对话记录 (src/play/purge.ts): 删对话 / 命令 / 读数 / 截图, 留复盘 / 统计 / 存档链, 删完标记收起
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPurged, purgePlan, purgeRun } from "../src/play/purge.ts";

test("purgePlan: 轮次日志 / 请求 / 采样 / 截图目录删, summary / review / world / end.zip 留, 不认识的也留", () => {
  const plan = purgePlan(["turn-a-1.jsonl", "turn-b-2-raw.jsonl", "requests.jsonl", "monitor.jsonl", "claude-stderr.txt", "tells.jsonl", "session-a.json", "rcon.pw", "crash-1.out", "world-scan.json",
    "summary.json", "review.md", "review.json", "world.json", "end.zip", "recovered.json", "hidden", "notes-of-something.txt"].map((name) => ({ name, dir: false })).concat([{ name: "base", dir: true }, { name: "keep-me", dir: true }]));
  assert.deepEqual(plan.del.sort(), ["base", "claude-stderr.txt", "crash-1.out", "monitor.jsonl", "rcon.pw", "requests.jsonl", "session-a.json", "tells.jsonl", "turn-a-1.jsonl", "turn-b-2-raw.jsonl", "world-scan.json"]);
  assert.deepEqual(plan.keep.sort(), ["end.zip", "hidden", "keep-me", "notes-of-something.txt", "recovered.json", "review.json", "review.md", "summary.json", "world.json"]);
});

test("purgeRun: 真删, 留的还在, 放 hidden 标记, 回删了几个 / 多少字节", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-purge-"));
  for (const f of ["turn-a-1.jsonl", "requests.jsonl", "summary.json", "review.md", "end.zip"]) fs.writeFileSync(path.join(dir, f), "x".repeat(10));
  fs.mkdirSync(path.join(dir, "base")); fs.writeFileSync(path.join(dir, "base", "top.png"), "y".repeat(5));
  const r = purgeRun(dir);
  assert.deepEqual([r.deleted, r.bytes], [3, 25]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["end.zip", "hidden", "purged", "review.md", "summary.json"]);
  assert.deepEqual(r.kept.sort(), ["end.zip", "review.md", "summary.json"]);
  assert.match(fs.readFileSync(path.join(dir, "hidden"), "utf8"), /删了对话记录/);
  assert.equal(isPurged(dir), true, "purged 标记: 世界菜单不再列这一班");
  assert.equal(purgeRun(dir).deleted, 0, "再删一次没东西可删, 不报错");
});
