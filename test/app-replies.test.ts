// 界面: 你说的话谁回了、成员多久没动静、等待被打断不算失败、工具问题的弹窗
import test from "node:test";
import assert from "node:assert/strict";
import { alertLine, foldLines, isWaitInterrupted, quietLabel, replyLine, stepsMeta, type Line, type ReplyStatus } from "../app/src/logic.ts";

const at = "2026-11-05T05:02:20.000Z";
const base: ReplyStatus = { at, text: "是谁丢的?", scope: "team", total: 5, replied: [], waiting: ["A", "B", "C", "D", "E"] };

test("你说的话下面: 没人回时说还在忙, 有人回了列名字和还在忙的; 对不上不显示", () => {
  assert.equal(replyLine("是谁丢的?", at, [base]), "已送达 5 个 · 还在忙, 手上的事做完就回");
  assert.equal(replyLine("是谁丢的?", at, [{ ...base, replied: ["C"], waiting: ["A", "B", "D", "E"] }]), "已送达 5 个 · 已回: C · 还在忙: A、B、D、E");
  assert.equal(replyLine("是谁丢的?", at, [{ ...base, replied: ["A", "B", "C", "D", "E"], waiting: [] }]), "已送达 5 个 · 已回: A、B、C、D、E");
  assert.equal(replyLine("别的话", at, [base]), null);
  assert.equal(replyLine("是谁丢的?", "2026-11-05T06:00:00.000Z", [base]), null, "同样的话隔很久是另一句");
  assert.equal(replyLine("是谁丢的?", at, undefined), null);
  assert.equal(replyLine("x", at, [{ ...base, text: "x", total: 1, scope: "direct", waiting: ["A"] }]), "已送达 · 还在忙, 手上的事做完就回");
});

test("成员行: 不到 1 分钟不显示", () => {
  assert.equal(quietLabel(undefined), null);
  assert.equal(quietLabel(59), null);
  assert.equal(quietLabel(185), "3 分钟没动静");
});

test("等待被消息打断 (退出码 3) 不算失败, 真失败还算", () => {
  assert.ok(isWaitInterrupted("Exit code 3\nnote: \"a tell from operator ended this wait\""));
  assert.ok(!isWaitInterrupted("Exit code 1\nerror: action_failed"));
  const lines: Line[] = [
    { kind: "命令", text: "./fh wait" }, { kind: "结果", text: "Exit code 3\nended this wait", error: true },
    { kind: "命令", text: "./fh call mine" }, { kind: "结果", text: "Exit code 1\nerror: action_failed", error: true },
  ] as Line[];
  const item = foldLines(lines, "a")[0] as { type: "steps"; steps: Parameters<typeof stepsMeta>[0] };
  assert.equal(stepsMeta(item.steps), "干了 2 步 · 1 步失败");
});

test("工具问题的弹窗写清是谁说的", () => {
  const l = alertLine({ at, agent: "b", name: "Gpt-6.1-Sol", brain: "codex", model: "gpt-6.1-sol", kind: "tool", text: "工具诉求: ./calc 崩" });
  assert.match(l.title, /说工具有问题/);
  assert.equal(l.detail, "工具诉求: ./calc 崩");
});
