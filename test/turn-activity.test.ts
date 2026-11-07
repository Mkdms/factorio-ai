// 防空转只拦空转的轮 (src/play/turn-activity.ts; 2026-11-05 Claude Haiku 每轮干 20 秒、再等 60 秒)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workSince, workSinceFile } from "../src/play/turn-activity.ts";

const row = (at: string, action: string, event = "request") => JSON.stringify({ at, event, request: { action } });
const T0 = "2026-11-05T10:30:00.000Z";
const after = "2026-11-05T10:30:10.000Z", before = "2026-11-05T10:29:50.000Z";

test("只数这一轮之后的干活动作: 查询、说话、等待不算", () => {
  const text = [row(before, "build"), row(after, "status"), row(after, "observe"), row(after, "say"), row(after, "wait"), row(after, "transfer"), row(after, "move_to"), "半行坏数据 {", row(after, "mine", "response")].join("\n");
  assert.equal(workSince(text, Date.parse(T0)), 2);
  assert.equal(workSince(row(after, "status"), Date.parse(T0)), 0, "只查询的轮 = 空转");
});

test("读文件: 只取末尾, 开头半行不出错; 文件没有算 0", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fp-activity-"));
  const f = path.join(d, "journal.jsonl");
  fs.writeFileSync(f, `${row(after, "craft")}\n${row(after, "build")}\n`);
  assert.equal(workSinceFile(f, Date.parse(T0)), 2);
  assert.equal(workSinceFile(f, Date.parse(T0), row(after, "build").length + 3), 1, "开头被截断的半行跳过");
  assert.equal(workSinceFile(path.join(d, "没有.jsonl"), 0), 0);
  fs.rmSync(d, { recursive: true });
});
