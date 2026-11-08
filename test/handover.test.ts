// 交接 "上一班实测" (core/records/handover.ts, 照派对 tools/handover.py carry 改写)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { capNotes, carryNotes, journalStats, measuredLines, nowSection, stripMeasured, trimLogSection, MEASURED } from "../core/records/handover.ts";

const at = (s: number) => new Date(Date.UTC(2026, 10, 8, 1, 0, s)).toISOString();
const req = (s: number, id: string, action: string, args: object = {}) => JSON.stringify({ at: at(s), event: "request", request: { id, action, args } });
const res = (s: number, id: string, ok: boolean, result: object = {}, msg = "") => JSON.stringify({ at: at(s), event: "response", response: { id, ok, result, ...(ok ? {} : { error: { message: msg } }) } });

function journal(dir: string): string {
  const f = path.join(dir, "journal.jsonl");
  fs.writeFileSync(f, [
    req(0, "1", "status"), res(1, "1", true),
    req(10, "2", "build", { item: "stone-furnace" }), res(12, "2", true, { clock: "character idle 8s of it" }),
    req(20, "3", "transfer"), res(21, "3", true, { transferred: 0 }),
    req(30, "4", "build"), res(31, "4", false, {}, "cannot place at (12,-3)"),
    req(40, "5", "build"), res(41, "5", false, {}, "cannot place at (14,-5)"),
    req(50, "6", "sleep", { seconds: 30 }), res(80, "6", true),
    req(400, "7", "say"), res(401, "7", true),
    req(500, "8", "mine"), res(501, "8", true),
  ].join("\n") + "\n");
  return f;
}

test("journal 数出动手 / 读 / 说话 / 等、站着、没搬动、失败归并", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handover-"));
  const st = journalStats(journal(dir))!;
  assert.equal(st.actions, 5); // build ×3、transfer、mine
  assert.equal(st.reads, 1);
  assert.equal(st.talk, 1);
  assert.equal(st.waits, 1);
  assert.equal(st.waitS, 30);
  assert.equal(st.idleS, 8);
  assert.equal(st.noop.get("transfer"), 1);
  assert.deepEqual(st.errors[0], ["build: cannot place at (N,N)", 2]);
  const lines = measuredLines(st).join("\n");
  assert.match(lines, /动手 5 次, 说话和看板 1 次, 读 1 次, 等 1 次/);
  assert.match(lines, /什么都没搬动: transfer ×1/);
  assert.match(lines, /失败 ×2: build: cannot place/);
  assert.match(lines, /最长一段没动手/); // 第 40 秒到第 500 秒, 超过这一班三成
  assert.deepEqual(measuredLines(journalStats(path.join(dir, "没有.jsonl"))), ["- 上一班的 journal 里没有请求"]);
});

test("换掉上一次的实测节 (中文和派对英文标题都认), 日志只留 10 行", () => {
  const notes = `# 笔记\n\n${MEASURED} (旧)\n- 动手 1 次\n\n## Last shift, measured\n- 1 world actions\n\n## 现在在做\n铺带子\n`;
  const s = stripMeasured(notes);
  assert.doesNotMatch(s, /上一班实测|Last shift/);
  assert.match(s, /## 现在在做\n铺带子/);
  const log = `## 日志\n${Array.from({ length: 15 }, (_, i) => `- 第 ${i + 1} 行`).join("\n")}\n## 教训\n- x\n`;
  const t = trimLogSection(log);
  assert.match(t, /前 5 行日志省略/);
  assert.match(t, /第 15 行/);
  assert.doesNotMatch(t, /第 5 行\n/);
  assert.match(t, /## 教训/);
});

test("超长截断: 现在在做留整节, 别的节靠前的先截; 现在在做那节的内容认得出", () => {
  const big = (n: number) => "字".repeat(n);
  const notes = `## 现在在做\n${big(3000)}\n## 教训\n${big(9000)}\n## 坐标和设施\n${big(3000)}\n## 计划\n${big(4000)}\n`;
  const trimmed: string[] = [];
  const r = capNotes(notes, 16000, trimmed);
  assert.equal(r.cut, true);
  assert.ok(r.notes.length <= 16000);
  assert.match(r.notes, new RegExp(`## 现在在做\\n${big(3000)}`));
  assert.ok(trimmed.some((t) => t.startsWith("教训")));
  assert.equal(nowSection("## 现在在做\n  铺 带子 \n## 计划\nx"), "铺 带子");
});

test("接班: 实测放最上面、上一班笔记跟着; 截过的全文进归档; 现在在做连续两班一样会报", () => {
  const prev = fs.mkdtempSync(path.join(os.tmpdir(), "handover-prev-"));
  const next = fs.mkdtempSync(path.join(os.tmpdir(), "handover-next-"));
  const third = fs.mkdtempSync(path.join(os.tmpdir(), "handover-third-"));
  fs.writeFileSync(path.join(prev, "notes.md"), `# 笔记\n\n## 现在在做\n铺铁板带\n\n## 教训\n${"长".repeat(17000)}\n`);
  const j = journal(prev);
  assert.equal(carryNotes(path.join(prev, "notes.md"), j, path.join(next, "notes.md"), "run-1", "Claude"), true);
  const out = fs.readFileSync(path.join(next, "notes.md"), "utf8");
  assert.match(out, /^\(从上一班接过来 \(这一班 run-1\): Claude 的 notes.md/);
  assert.match(out, /## 上一班实测 \(从你的 journal 数的/);
  assert.match(out, /## 现在在做\n铺铁板带/);
  assert.ok(fs.readFileSync(path.join(next, "notes-archive.md"), "utf8").includes("长".repeat(17000)));
  // 下一班: "现在在做"没变 → 报连续 2 班; 上一次的接班说明和实测节都换掉, 不叠
  carryNotes(path.join(next, "notes.md"), j, path.join(third, "notes.md"), "run-2", "Claude");
  const out2 = fs.readFileSync(path.join(third, "notes.md"), "utf8");
  assert.match(out2, /连续 2 班结束时一字不差 \(run-1 到 run-2\)/);
  assert.equal(out2.match(/## 上一班实测/g)?.length, 1);
  assert.equal(out2.match(/从上一班接过来/g)?.length, 1);
});
