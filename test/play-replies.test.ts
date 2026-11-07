// 真人的话要回 (src/play/replies.ts): 界面发的话过了宽限没回就催一次; 游戏聊天里的点名持续没读就催
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mentionNudges, newMentionState, readTells, unansweredTells } from "../src/play/replies.ts";

const T0 = Date.parse("2026-11-04T11:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

test("readTells: 一行一条, 坏行和缺字段的跳过, 文件不在就空", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fp-tells-")), "tells.jsonl");
  fs.writeFileSync(f, `${JSON.stringify({ at: at(0), agent: "b", text: "你在做什么", scope: "team" })}\n{bad\n${JSON.stringify({ at: at(1), agent: "c" })}\n`);
  assert.deepEqual(readTells(f).map((t) => t.agent), ["b"]);
  assert.deepEqual(readTells(path.join(os.tmpdir(), "no-such-tells.jsonl")), []);
});

test("unansweredTells: 宽限内不催; 过了宽限没 operator / chat_ack 的催一次; 回过的不催; say 不算回", () => {
  const tells = [{ at: at(0), agent: "b", text: "  deepseek 你在做什么？\n" }, { at: at(0), agent: "d", text: "同一句给 d" }, { at: at(100), agent: "c", text: "刚说的" }];
  const reqs = (agent: string) => (agent === "d" ? [{ t: T0 + 30_000, action: "operator", ok: true }] : agent === "b" ? [{ t: T0 + 20_000, action: "say", ok: true }, { t: T0 - 5_000, action: "operator", ok: true }] : []);
  const nudged = new Set<string>();
  const now = T0 + 130_000;
  const u = unansweredTells(tells, reqs, now, nudged);
  assert.deepEqual(u, [{ key: `${at(0)}|b`, agent: "b", text: "deepseek 你在做什么？", ageMin: 2 }]);
  assert.ok(nudged.has(`${at(0)}|d`), "回过的记下, 以后不再查");
  nudged.add(u[0].key);
  assert.deepEqual(unansweredTells(tells, reqs, now + 60_000, nudged), [], "催过的不再催");
  assert.equal(unansweredTells(tells, reqs, now + 60_000, new Set(), 5_000).length, 2, "宽限 5 秒: b 和 c 都该催 (d 回过)");
});

test("mentionNudges: 未读持续超过宽限才催, 同一角色隔一段再催, 读完清零后重新计时", () => {
  const st = newMentionState();
  const counts = [{ name: "Glm-5.3", unread_mentions: 2 }, { name: "MK", unread_mentions: 0 }, { display_name: "Deepseek-V4-Pro", unacked_tells: 1, unacked_oldest_tick: 1000 }];
  assert.deepEqual(mentionNudges(counts, 10_000, st, 7200, 18_000), [{ name: "Deepseek-V4-Pro", mentions: 0, unacked: 1, waitedMin: 3 }], "没确认的私信从它的 tick 算, 已经 9000 tick");
  assert.deepEqual(mentionNudges(counts, 10_000 + 7_000, st, 7200, 18_000), [], "Glm 才等了 7000 tick; Deepseek 刚催过");
  assert.deepEqual(mentionNudges(counts, 10_000 + 7_300, st, 7200, 18_000).map((m) => m.name), ["Glm-5.3"]);
  assert.deepEqual(mentionNudges([{ name: "Glm-5.3", unread_mentions: 0 }], 30_000, st), [], "读完了清零");
  assert.equal(st.firstSeen.has("Glm-5.3"), false);
  assert.equal(mentionNudges([{ name: "Glm-5.3", unread_mentions: 1 }], 40_000, st).length, 0, "重新计时");
  assert.equal(mentionNudges([{ name: "Glm-5.3", unread_mentions: 1 }], 40_000 + 7_200, st, 7200, 1).length, 1);
  assert.deepEqual(mentionNudges([{}, { name: "x", unread_mentions: "bad" as unknown as number }], 0, st), [], "缺名字 / 坏数不崩");
});
