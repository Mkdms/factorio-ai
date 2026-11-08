// 班末总结和复盘 (core/records/summary.ts); 不开游戏
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { journalStats, reviewShift, turnStats, writeSummary } from "../core/records/summary.ts";

const req = (action: string, args: object = {}) => JSON.stringify({ at: "2026-11-08T01:00:00.000Z", event: "request", request: { id: "1", action, args } });
const res = (r: object) => JSON.stringify({ at: "2026-11-08T01:00:01.000Z", event: "response", response: r });

test("journal 统计: 按动作、失败原因 (去掉括号)、放下的建筑、带出的教训、说话、sleep 秒数、查手册", () => {
  const lines = [
    req("build"), res({ ok: true, result: { entity: { name: "stone-furnace" }, lessons: ["a", "b"] } }),
    req("build"), res({ ok: false, error: { code: "action_failed", message: "placement blocked by burner-mining-drill (-29,-1) (放不下)" } }),
    req("say"), res({ ok: true, result: {} }),
    req("sleep", { seconds: 200 }), req("sleep", { seconds: 40 }),
    JSON.stringify({ at: "x", event: "help", topic: "building" }),
    "坏行",
  ];
  const s = journalStats(lines);
  assert.equal(s.requests, 5);
  assert.deepEqual(s.byAction, { build: 2, say: 1, sleep: 2 });
  assert.deepEqual(s.failures, { count: 1, byReason: { "placement blocked by burner-mining-drill": 1 } });
  assert.deepEqual(s.built, { "stone-furnace": 1 });
  assert.equal(s.lessonsShown, 2);
  assert.deepEqual([s.says, s.sleepSeconds, s.helps], [1, 240, 1]);
});

test("轮次用量: 每轮最后一条 result; 出错的轮数", () => {
  const result = (o: object) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 10, duration_ms: 60_000, total_cost_usd: 0.05, usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 }, ...o });
  const t = turnStats([[JSON.stringify({ type: "assistant" }), result({})], [result({ num_turns: 2, subtype: "error_max_turns", is_error: true })], ["没有 result 行"]]);
  assert.deepEqual(t, { rounds: 2, turns: 12, seconds: 120, costUsd: 0.1, inputTokens: 20, cacheRead: 2000, cacheWrite: 200, outputTokens: 100, errors: 1 });
});

test("复盘: 读数几行; 先修: 没研究中心 > 产量比上一班低 > 闲着 ≥30% > 失败 ≥15%; 最多 3 条; 写出 summary.json 和 review.md", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-sum-")), dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-sumdir-"));
  const mon = (i: number, idle: boolean) => JSON.stringify({ t: i, tick: i * 3600, redTotal: i * 5, greenTotal: 0, labs: 0, labsWorking: 0, research: "", researched: 0, entities: 10 + i, machines: 2 + i, idle });
  fs.writeFileSync(path.join(runDir, "monitor.jsonl"), [mon(0, false), mon(10, true), mon(20, true)].join("\n") + "\n");
  fs.writeFileSync(path.join(runDir, "health.jsonl"), JSON.stringify({ lines: ["缺燃料 3 台: x"] }) + "\n" + JSON.stringify({ lines: ["缺燃料 2 台: x", "缺电 1 台"] }) + "\n");
  fs.writeFileSync(path.join(runDir, "turn-1.jsonl"), JSON.stringify({ type: "result", subtype: "success", num_turns: 50, duration_ms: 600_000, total_cost_usd: 0.1, usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 } }) + "\n");
  fs.writeFileSync(path.join(dir, "journal.jsonl"), [req("build"), res({ ok: false, error: { message: "placement blocked by x" } }), req("transfer"), res({ ok: true, result: {} }), req("transfer"), res({ ok: false, error: { message: "放了 4 轮还不对: 那格 1 个" } })].join("\n") + "\n");
  const r = writeSummary({ runDir, dir, runId: "r1", brain: "claude", model: "claude-haiku-5-5", minutes: 30, why: "到点", supervisor: { nudges: 2, toolRequests: 1 }, lessons: { shown: 74, distinct: 40, collected: 8 }, prevRates: { red: 9, green: null, blue: null } });
  assert.match(r.lines[0], /^大脑 claude claude-haiku-5-5: 1 轮 50 回合 10 分钟, 估价 \$0\.10/);
  assert.match(r.lines.join("\n"), /科技包每分钟 \(整班平均\): 红瓶 5\.0[\s\S]*上一班: 红瓶 9\.0/);
  assert.match(r.lines.join("\n"), /角色闲着的时间: 67% \(监工催了 2 次\)/);
  assert.match(r.lines.join("\n"), /请求 3 次 \(transfer 2、build 1\); 失败 2 次 \(67%\): 1× placement blocked by x; 1× 放了 4 轮还不对: 那格 1 个/);
  assert.match(r.lines.join("\n"), /体检各类问题出现的比例: 缺燃料 100%、缺电 50%/);
  assert.match(r.lines.join("\n"), /工具诉求 1 条/);
  assert.equal(r.fixes.length, 3);
  assert.match(r.fixes[0], /^没有研究中心/);
  assert.match(r.fixes[1], /产量比上一班低 \(红瓶\)/);
  assert.match(r.fixes[2], /^角色闲着的时间 67%/);
  const summary = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));
  assert.equal(summary.samples, 3);
  assert.equal(summary.journal.failures.count, 2);
  // 界面统计卡认的字段 (第二版总结格式) 和群公告读的 review.json
  assert.equal(summary.realMinutes, 0, "采样的真实时间 t 首尾差 (这里 0 → 20 毫秒)");
  assert.equal(summary.gameMinutes, 20);
  assert.equal(summary.idleShare, 0.67);
  assert.equal(summary.fpCalls, 3);
  assert.deepEqual(summary.perMin10Total, { red: 5, green: 0 }, "最后 10 游戏分钟; 没有蓝瓶读数就不写");
  assert.deepEqual(summary.usage, { costUsd: 0.1 });
  assert.deepEqual(summary.agents, [{ id: "a", turns: 50, brain: "claude", model: "claude-haiku-5-5", costUsd: 0.1 }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, "review.json"), "utf8")), r);
  assert.match(fs.readFileSync(path.join(runDir, "review.md"), "utf8"), /^# 复盘 r1\n[\s\S]*## 下一班先修\n1\. 没有研究中心/);
  const calm = reviewShift({ runId: "x", brain: "b", model: "m", minutes: 1, why: "w", journal: journalStats([]), turns: turnStats([]), monitor: [], health: [], supervisor: {}, lessons: null });
  assert.deepEqual(calm.fixes, []);
});
