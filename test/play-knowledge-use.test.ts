// 大脑用没用我们的知识和工具 (src/play/knowledge-use.ts): 简报要点、按轮次日志数次数、监工的配比提醒
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { briefPoints, calcReminderDue, countKnowledgeUse, knowledgeUse } from "../src/play/knowledge-use.ts";

const tool = (name: string, input: Record<string, unknown>) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

// 第二版的 knowledge/brief-points.md 在新项目里是 training/knowledge/verified/points.md (core/run/training.ts pointsMd), 格式不同, 那条内容检查不搬
test("简报要点: 没有文件回空串", () => {
  assert.equal(briefPoints(path.join(os.tmpdir(), "no-such-file.md")), "");
});

test("数次数: ./fh / ./calc / ./bp / fh help pilot-* / 直接读 facts 或 patterns; 别的工具调用不算", () => {
  const log = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" }),
    tool("Bash", { command: "./fh call status && ./fh help building" }),
    tool("Bash", { command: "./calc '{\"targets\":{\"automation-science-pack\":30}}'" }),
    tool("Bash", { command: "./bp list 冶炼; ./fh help pilot-production" }),
    tool("Read", { file_path: "C:/brain/a/ref/pilot-facts.md" }),
    tool("Grep", { pattern: "传送带", path: "ref/pilot-production.md" }),
    tool("Read", { file_path: "notes.md" }),
    JSON.stringify({ type: "user", message: { content: "x" } }),
  ].join("\n");
  assert.deepEqual(countKnowledgeUse([log]), { calc: 1, bp: 1, plan: 0, python: 0, pilotHelp: 1, pilotReads: 2, fhCalls: 3, lessonsShown: 0 });
  // PowerShell 的写法也算; ./fh board plan 里的 plan 不算 (2026-11-05 Gpt / Grok 走 PowerShell, 只数 ./x 少算了)
  const ps = tool("Bash", { command: ".\\calc.ps1 x; ./plan automation-science-pack 30; python tools/a.py; ./fh board plan doing x" });
  const use = countKnowledgeUse([ps]);
  assert.deepEqual([use.calc, use.plan, use.python, use.fhCalls], [1, 1, 1, 1]); // PowerShell 的 .\calc.ps1 也算
  // 回复里自动带出的教训 (被动推送)
  const pushed = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok\nlessons: [\"lesson #41 (MK; verified 3m ago): 常驻命令\", \"lesson #25 (MK): 燃料\"]" }] } });
  assert.equal(countKnowledgeUse([pushed]).lessonsShown, 2);
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ku-"));
  fs.writeFileSync(path.join(run, "turn-a-1.jsonl"), log + "\n");
  fs.writeFileSync(path.join(run, "turn-a-2.jsonl"), tool("Bash", { command: "./calc x" }) + "\n");
  fs.writeFileSync(path.join(run, "turn-b-1.jsonl"), tool("Bash", { command: "./bp list" }) + "\n");
  assert.deepEqual(knowledgeUse(run, "a"), { calc: 2, bp: 1, plan: 0, python: 0, pilotHelp: 1, pilotReads: 2, fhCalls: 3, lessonsShown: 0 });
  assert.deepEqual(knowledgeUse(run, "b"), { calc: 0, bp: 1, plan: 0, python: 0, pilotHelp: 0, pilotReads: 0, fhCalls: 0, lessonsShown: 0 });
  assert.deepEqual(knowledgeUse(path.join(run, "none"), "a"), { calc: 0, bp: 0, plan: 0, python: 0, pilotHelp: 0, pilotReads: 0, fhCalls: 0, lessonsShown: 0 });
  fs.rmSync(run, { recursive: true, force: true });
});

test("监工提醒: 15 和 35 分钟各一次, 算过就不提, 提过的不重复", () => {
  assert.equal(calcReminderDue(10, 0, 0), 0);
  assert.equal(calcReminderDue(15, 0, 0), 15);
  assert.equal(calcReminderDue(20, 0, 15), 0);
  assert.equal(calcReminderDue(35, 0, 15), 35);
  assert.equal(calcReminderDue(50, 0, 35), 0);
  assert.equal(calcReminderDue(40, 1, 0), 0, "算过就不提");
  assert.equal(calcReminderDue(40, 0, 0), 15, "一直没算: 先补 15 分钟那次");
});
