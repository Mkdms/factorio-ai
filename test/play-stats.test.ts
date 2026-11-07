// 每个模型的统计和排行 (src/play/stats.ts): 用临时目录造几班记录
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY_CLAUDE, modelOfAgent, modelStats, scienceOf, shiftStats, vendorOfModel } from "../src/play/stats.ts";
import { writeWorld } from "../src/play/worlds.ts";

function run(play: string, id: string, o: { world?: string; model?: Record<string, string>; summary: object; requests?: { agent: string; action: string; ok: boolean }[] }) {
  const dir = path.join(play, "runs", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(o.summary));
  if (o.world) writeWorld(dir, { id: o.world, name: `世界 ${o.world}`, kind: "sandbox", createdAt: "", firstRun: id });
  for (const [agent, model] of Object.entries(o.model ?? {})) fs.writeFileSync(path.join(dir, `turn-${agent}-1.jsonl`), JSON.stringify({ type: "system", subtype: "init", model }) + "\n" + JSON.stringify({ type: "assistant" }) + "\n");
  if (o.requests) fs.writeFileSync(path.join(dir, "requests.jsonl"), o.requests.map((r) => JSON.stringify({ t: 1, ...r })).join("\n") + "\n");
  return dir;
}

test("花费归实际花的角色 (不按轮次分); 老班对话记录没了归到 Claude 旧记录; 不叫大脑的班不计", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "fp-stats2-"));
  // 新班: 总结里有每个角色的花费和模型
  run(play, "2026-11-05T01-00-00", { world: "w", summary: { realMinutes: 60, usage: { costUsd: 100 }, agents: [{ id: "a", turns: 2, brain: "claude", model: "opus", costUsd: 100 }, { id: "c", turns: 186, brain: "relay", model: "gpt-6.1-terra", costUsd: 0 }] } });
  // 旧一点的班: 总结没有逐角色花费, 从轮次文件的 result 行加
  const d = run(play, "2026-11-05T02-00-00", { world: "w", model: { a: "claude-opus-5-5", c: "gpt-6.1-terra" }, summary: { realMinutes: 60, usage: { costUsd: 90 }, agents: [{ id: "a", turns: 2 }, { id: "c", turns: 180 }] } });
  fs.appendFileSync(path.join(d, "turn-a-1.jsonl"), JSON.stringify({ type: "result", total_cost_usd: 90 }) + "\n");
  // 11-04 以前的老班: 对话记录删了, 总结里没模型
  run(play, "2026-11-03T01-00-00", { world: "old", summary: { realMinutes: 60, usage: { costUsd: 50 }, agents: [{ id: "a", turns: 5 }] } });
  // 不叫大脑的验证班
  run(play, "2026-11-04T04-00-00", { world: "old", summary: { realMinutes: 60, brain: "none", model: "opus", usage: { costUsd: 0 }, agents: [{ id: "a", turns: 5 }] } });
  const rows = shiftStats(play);
  const at = (run: string, agent: string) => rows.find((r) => r.run === run && r.agent === agent)!;
  assert.equal(at("2026-11-05T01-00-00", "a").costUsd, 100);
  assert.equal(at("2026-11-05T01-00-00", "c").costUsd, 0, "空转的不分钱");
  assert.equal(at("2026-11-05T01-00-00", "a").model, "claude-opus-5-5", "别名 opus 对到官方 id");
  assert.equal(at("2026-11-05T01-00-00", "c").model, "gpt-6.1-terra");
  assert.equal(at("2026-11-05T02-00-00", "a").costUsd, 90);
  assert.equal(at("2026-11-05T02-00-00", "c").costUsd, 0);
  assert.equal(at("2026-11-03T01-00-00", "a").model, LEGACY_CLAUDE);
  assert.equal(at("2026-11-03T01-00-00", "a").vendor, "Claude");
  assert.equal(at("2026-11-03T01-00-00", "a").costUsd, 50, "老班没有逐轮数字: 按轮次分");
  assert.ok(!rows.some((r) => r.run === "2026-11-04T04-00-00"), "--brain none 不计");
  assert.ok(!modelStats(rows).some((m) => m.vendor === "未知"));
  fs.rmSync(play, { recursive: true, force: true });
});

test("模型名 → 厂商; 班末产量: 新字段三色相加, 老字段红 + 绿, 都没有 null", () => {
  assert.equal(vendorOfModel("claude-opus-5-5"), "Claude");
  assert.equal(vendorOfModel("grok-4"), "Grok");
  assert.equal(vendorOfModel("deepseek-chat"), "DeepSeek");
  assert.equal(vendorOfModel("gpt-5-codex"), "GPT");
  assert.equal(vendorOfModel(null), "未知");
  assert.equal(vendorOfModel("mystery-9"), "mystery-9");
  assert.equal(scienceOf({ perMin10Total: { red: 2.6, green: 8.3, blue: 4.7 } }), 15.6);
  assert.equal(scienceOf({ redPerMin10: 18.1, greenPerMin10: 16.5 }), 34.6);
  assert.equal(scienceOf({}), null);
});

test("每班每角色: 模型、请求分类、花费按轮次份额分、同一世界的增量; 没 summary 的班不算", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "fp-stats-"));
  run(play, "2026-11-03T08-00-00", { world: "w1", model: { a: "claude-opus-5-5", b: "deepseek-chat" }, summary: { agents: [{ id: "a", turns: 3 }, { id: "b", turns: 1 }], usage: { costUsd: 8 }, realMinutes: 60, gameMinutes: 300, idleShare: 0.1, perMin10Total: { red: 10, green: 0, blue: 0 } },
    requests: [{ agent: "a", action: "observe", ok: true }, { agent: "a", action: "build", ok: true }, { agent: "a", action: "place", ok: false }, { agent: "b", action: "status", ok: true }] });
  run(play, "2026-11-03T09-00-00", { world: "w1", model: { a: "claude-opus-5-5", b: "deepseek-chat" }, summary: { agents: [{ id: "a", turns: 2 }, { id: "b", turns: 2 }], usage: { costUsd: 4 }, realMinutes: 30, gameMinutes: 600, idleShare: 0.3, perMin10Total: { red: 16, green: 4, blue: 0 } } });
  run(play, "2026-11-03T10-00-00", { world: "w2", model: { a: "grok-4" }, summary: { agents: [{ id: "a", turns: 5 }], realMinutes: 60, redPerMin10: 6 } });
  fs.mkdirSync(path.join(play, "runs", "2026-11-03T11-00-00"), { recursive: true }); // 中断的班: 没 summary
  const shifts = shiftStats(play);
  assert.deepEqual(shifts.map((s) => [s.run.slice(11, 13), s.agent, s.vendor]), [["08", "a", "Claude"], ["08", "b", "DeepSeek"], ["09", "a", "Claude"], ["09", "b", "DeepSeek"], ["10", "a", "Grok"]]);
  const a8 = shifts[0];
  assert.deepEqual([a8.requests, a8.reads, a8.builds, a8.fails], [3, 1, 2, 1]);
  assert.equal(a8.costUsd, 6, "8 美元按 3:1 分");
  assert.equal(shifts[1].costUsd, 2);
  assert.equal(a8.science, 10); assert.equal(a8.scienceGain, 10, "新世界第一班从 0 起");
  assert.equal(shifts[2].science, 20); assert.equal(shifts[2].scienceGain, 10, "同一世界上一班 10 → 20");
  assert.equal(shifts[4].science, 6); assert.equal(shifts[4].scienceGain, 6, "另一个世界从 0 起");
  assert.equal(shifts[4].costUsd, null);
  assert.equal(modelOfAgent(path.join(play, "runs", "2026-11-03T10-00-00"), "a"), "grok-4");
  assert.equal(modelOfAgent(path.join(play, "runs", "2026-11-03T10-00-00"), "b"), null);

  const models = modelStats(shifts);
  assert.deepEqual(models.map((m) => m.model), ["claude-opus-5-5", "deepseek-chat", "grok-4"], "增量每小时: Claude / DeepSeek 同班同数, 并列按班数; Grok 6/小时最后");
  const c = models[0];
  assert.deepEqual([c.shifts, c.agentShifts, c.realHours], [2, 2, 1.5]);
  assert.equal(c.scienceAvg, 15); // (10 + 20) / 2
  assert.equal(c.gainPerHour, round1((10 + 10) / 1.5));
  assert.deepEqual([c.builds, c.requests, c.readShare, c.fails], [2, 3, 0.33, 1]);
  assert.equal(c.costUsd, 8); // 6 + 2
  assert.equal(c.idleShare, 0.2);
  assert.equal(models[2].gainPerHour, 6);
  assert.equal(models[2].costUsd, null);
  fs.rmSync(play, { recursive: true, force: true });
});

const round1 = (x: number) => Math.round(x * 10) / 10;
