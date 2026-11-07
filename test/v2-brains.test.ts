// 一班的角色阵容 (src/play/brains.ts): --brains 一个角色一个大脑 (每项可带模型 家:模型), 模型默认, 服务器角色按模型命名 (首字母大写)
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineup, parseBrainEntry, DEFAULT_MODELS, MAX_AGENTS } from "../src/play/brains.ts";

test("不给 --brains: --agents 个角色都用 --brain, 模型按主大脑的默认", () => {
  assert.deepEqual(lineup({ brain: "claude", model: "opus", agents: "2" }), [{ brain: "claude", model: "opus", who: 1 }, { brain: "claude", model: "opus", who: "Claude-Opus" }]);
  assert.deepEqual(lineup({ brain: "grok", model: "opus", agents: "1" }), [{ brain: "grok", model: "grok-4.7", who: 1 }]);
  // 沙盘派对配置: 全是服务器角色, 窗口只看; 第 1 个也按模型名, 同名照样 -2
  assert.deepEqual(lineup({ brain: "claude", model: "opus", agents: "2", allBots: true }), [{ brain: "claude", model: "opus", who: "Claude-Opus" }, { brain: "claude", model: "opus", who: "Claude-Opus-2" }]);
  assert.equal(lineup({ brain: "deepseek", model: "deepseek-v4-pro" })[0].model, "deepseek-v4-pro", "明确给的 --model 不被默认覆盖");
});

test("--brains claude,grok,deepseek: 一人一个大脑, 第 1 个是玩家, 其余按模型命名, 同模型第 2 个起 -2", () => {
  const s = lineup({ brain: "claude", model: "opus", brains: "claude,grok,deepseek,grok" });
  assert.deepEqual(s.map((x) => [x.brain, x.model, x.who]), [["claude", "opus", 1], ["grok", "grok-4.7", "Grok-4.7"], ["deepseek", "deepseek-flash[1m]", "Deepseek-Flash"], ["grok", "grok-4.7", "Grok-4.7-2"]]);
  assert.equal(lineup({ brain: "claude", model: "opus", brains: "grok,claude" })[1].who, "Claude-Opus", "玩家是 Grok 时服务器角色叫 Claude-Opus");
});

test("参数错误要明说", () => {
  assert.throws(() => lineup({ brain: "claude", model: "opus", brains: "claude,gpt5" }), /不认识 gpt5/);
  assert.throws(() => lineup({ brain: "gpt5", model: "opus" }), /--brain 不认识 gpt5/);
  assert.throws(() => lineup({ brain: "claude", model: "opus", brains: "claude,grok", agents: "3" }), /别再给 --agents/);
  assert.equal(lineup({ brain: "claude", model: "opus", brains: Array(9).fill("claude").join(",") }).length, 9, "9 个一起跑 (派对那样) 可以");
  assert.throws(() => lineup({ brain: "claude", model: "opus", brains: Array(MAX_AGENTS + 1).fill("claude").join(",") }), /最多 26/);
});

test("中转站 (relay, 2026-11-04): 模型是站里选的 (defaults.relay), 没选又没 --model 就明说; 角色名 = 模型名, 同名跨家也排 -2", () => {
  const d = { ...DEFAULT_MODELS, relay: "glm-5.3" };
  assert.deepEqual(lineup({ brain: "relay", model: "opus" }, d), [{ brain: "relay", model: "glm-5.3", who: 1 }]);
  assert.equal(lineup({ brain: "relay", model: "kimi-k3" }, d)[0].model, "kimi-k3", "--model 临时换站里别的模型");
  assert.throws(() => lineup({ brain: "relay", model: "opus" }), /中转站 \(relay\) 没选模型/);
  assert.throws(() => lineup({ brain: "claude", model: "opus", brains: "claude,relay" }), /没选模型/);
  const s = lineup({ brain: "claude", model: "opus", brains: "claude,relay,deepseek,relay" }, { ...DEFAULT_MODELS, relay: "deepseek-v4-pro" });
  assert.deepEqual(s.map((x) => [x.brain, x.model, x.who]), [["claude", "opus", 1], ["relay", "deepseek-v4-pro", "Deepseek-V4-Pro"], ["deepseek", "deepseek-flash[1m]", "Deepseek-Flash"], ["relay", "deepseek-v4-pro", "Deepseek-V4-Pro-2"]],
    "同一个模型名第 2 个才 -2, 不管哪家接的");
  assert.equal(lineup({ brain: "claude", model: "opus", brains: "claude,relay" }, { ...DEFAULT_MODELS, relay: "volcengine/doubao-seed-2.1-pro" })[1].who, "Doubao-Seed-2.1-Pro");
  // --brains 每项可带模型 家:模型 (阵容文件就是这么转的): 两个中转模型同时用
  assert.deepEqual(parseBrainEntry(" relay:glm-5.3 "), { brain: "relay", model: "glm-5.3" });
  assert.deepEqual(parseBrainEntry("Grok"), { brain: "grok" });
  const t = lineup({ brain: "claude", model: "opus", brains: "claude:sonnet,relay:glm-5.3,relay:deepseek-v4-pro,grok" });
  assert.deepEqual(t.map((x) => [x.brain, x.model, x.who]), [["claude", "sonnet", 1], ["relay", "glm-5.3", "Glm-5.3"], ["relay", "deepseek-v4-pro", "Deepseek-V4-Pro"], ["grok", "grok-4.7", "Grok-4.7"]]);
  assert.throws(() => lineup({ brain: "claude", model: "opus", brains: "claude,gpt5:x" }), /不认识 gpt5/);
});
