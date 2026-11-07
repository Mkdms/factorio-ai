// 中途加人 / 移出 (src/play/roster-live.ts):
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROSTER_FILE, appendRosterOp, isSafeBotName, nextAgentId, normalizeSalvage, nthBotName, parseRosterOp, readRosterOps, salvageText } from "../src/play/roster-live.ts";

test("收回角色: 名字校验、搬背包结果的说明", () => {
  assert.ok(isSafeBotName("Gpt-6.1-Terra") && isSafeBotName("deepseek"));
  assert.ok(!isSafeBotName('a"; game.print("x') && !isSafeBotName("") && !isSafeBotName("1a"));
  assert.equal(salvageText(normalizeSalvage(JSON.stringify({ found: true, items: 120, left: 0, chests: [{ x: 1.5, y: -2.5 }] }))), "背包 120 个物品放进了钢箱 (1.5, -2.5)");
  assert.equal(salvageText(normalizeSalvage({ found: true, items: 0, left: 0, chests: {} })), "背包是空的", "Lua 空表回来是 {}");
  assert.match(salvageText(normalizeSalvage({ found: true, items: 5, left: 3, chests: [{ x: 0.5, y: 0.5 }] })), /还有 3 个没放下/);
  assert.equal(salvageText(normalizeSalvage(null)), "附近没找到尸体, 背包没搬");
});

test("一行一个操作: join 带座位 (洗过), leave 带角色 id; 坏行 / 不认识的跳过", () => {
  assert.deepEqual(parseRosterOp(JSON.stringify({ at: "2026-11-05T03:00:00.000Z", op: "join", seat: { brain: "Relay", model: "glm-5-turbo" } })), { at: "2026-11-05T03:00:00.000Z", op: "join", seat: { brain: "relay", model: "glm-5-turbo" } });
  assert.deepEqual(parseRosterOp(JSON.stringify({ at: "2026-11-05T03:00:00.000Z", op: "leave", agent: "c" })), { at: "2026-11-05T03:00:00.000Z", op: "leave", agent: "c" });
  assert.equal(parseRosterOp(JSON.stringify({ op: "join", seat: { brain: "nobody", model: "x" } })), null, "不认识的大脑");
  assert.equal(parseRosterOp(JSON.stringify({ op: "leave", agent: "zz" })), null, "角色 id 一个字母");
  assert.equal(parseRosterOp("{not json"), null);
  assert.equal(parseRosterOp(JSON.stringify({ op: "kick" })), null);
});

test("按字节位置读新行: 没文件 → 空; 半行留到下次; 读过的不重读", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-roster-"));
  const f = path.join(dir, ROSTER_FILE);
  assert.deepEqual(readRosterOps(f, 0), { ops: [], next: 0 });
  appendRosterOp(f, { at: "2026-11-05T03:00:00.000Z", op: "join", seat: { brain: "codex", model: "gpt-6.1-sol" } });
  const a = readRosterOps(f, 0);
  assert.equal(a.ops.length, 1);
  assert.equal(a.ops[0].op, "join");
  assert.deepEqual(readRosterOps(f, a.next), { ops: [], next: a.next }, "没新行");
  fs.appendFileSync(f, JSON.stringify({ at: "2026-11-05T03:01:00.000Z", op: "leave", agent: "b" })); // 没换行 = 还在写
  assert.deepEqual(readRosterOps(f, a.next).ops, [], "半行不算");
  fs.appendFileSync(f, "\n");
  const b = readRosterOps(f, a.next);
  assert.deepEqual(b.ops.map((o) => o.op), ["leave"]);
  assert.equal(b.next, fs.statSync(f).size);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("下一个角色 id: a~z 里第一个没用过的, 满了 null", () => {
  assert.equal(nextAgentId(["a", "b", "c", "d"]), "e");
  assert.equal(nextAgentId(["a", "c"]), "b", "移出过的 b 不复用? —— 这里只看传进来的: 调用方把移出的也算用过");
  assert.equal(nextAgentId(Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i))), null);
});

test("新角色的游戏名和已有的错开 (同模型第 2 个起 -2), 和开班时的规则一样", () => {
  assert.equal(nthBotName("relay", "glm-5-turbo", ["Claude-Opus-5.5", "Gpt-6.1-Terra"]), "Glm-5-Turbo");
  assert.equal(nthBotName("relay", "glm-5-turbo", ["Glm-5-Turbo"]), "Glm-5-Turbo-2");
  assert.equal(nthBotName("claude-api", "claude-opus-5-5", ["Claude-Opus-5.5", "Claude-Opus-5.5-2"]), "Claude-Opus-5.5-3");
});
