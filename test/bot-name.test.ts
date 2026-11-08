// 游戏里 AI 角色的名字 = 模型名 (src/play/model-name.ts botName): 首字母大写的规范写法, 不标"中转"; 派对 harness 的角色名规则放开成 [A-Za-z][A-Za-z0-9._-]{0,31}
import { test } from "node:test";
import assert from "node:assert/strict";
import { botName, HARNESS_NAME_RULE, modelDisplayName, prettyModel } from "../src/play/model-name.ts";

test("模型名规范写法: 每段首字母大写, 去掉供应商前缀, 原来的大写保留", () => {
  assert.equal(prettyModel("gpt-6.1-terra"), "Gpt-6.1-Terra");
  assert.equal(prettyModel("MiniMax-M3.1-Flash"), "MiniMax-M3.1-Flash");
  assert.equal(prettyModel("deepseek-v4-pro"), "Deepseek-V4-Pro");
  assert.equal(prettyModel("volcengine/doubao-seed-2.1-pro"), "Doubao-Seed-2.1-Pro");
  assert.equal(prettyModel("glm-5.3"), "Glm-5.3");
  assert.equal(prettyModel(""), "");
});

test("服务器角色按模型命名, 同模型第 2 个起加 -2; Claude 别名写 Claude-Opus; 方括号去掉", () => {
  assert.equal(botName("claude", 1, "opus"), "Claude-Opus");
  assert.equal(botName("claude", 2, "opus"), "Claude-Opus-2");
  assert.equal(botName("claude", 1), "Claude", "没给模型按家");
  assert.equal(botName("grok", 1, "grok-4.7"), "Grok-4.7");
  assert.equal(botName("deepseek", 1, "deepseek-flash[1m]"), "Deepseek-Flash");
  assert.equal(botName("relay", 1, "MiniMax-M3.1-Flash"), "MiniMax-M3.1-Flash");
  assert.equal(botName("relay", 1, "gpt-6.1-terra"), "Gpt-6.1-Terra");
  assert.equal(botName("relay", 3, "glm-5.3"), "Glm-5.3-3");
  assert.equal(botName("relay", 1, "volcengine/doubao-seed-2.1-pro"), "Doubao-Seed-2.1-Pro");
  assert.equal(botName("codex", 3), "Gpt-3");
  assert.deepEqual([botName("gemini", 1), botName("gemini", 2), botName("gemini", 1, "gemini-3.5-pro")], ["Gemini", "Gemini-2", "Gemini-3.5-Pro"], "Antigravity 默认不指定模型就叫 Gemini");
  assert.deepEqual([botName("claude-api", 1, "claude-opus-5-5"), botName("claude-api", 2, "opus"), botName("claude-api", 1)], ["Claude-Opus-5.5", "Claude-Opus-2", "Claude"], "Console 密钥那条路游戏里也叫 Claude-…");
  assert.equal(botName("none", 1, "opus"), "Test", "测试班不按模型");
  assert.equal(botName(undefined, 1), "Claude", "没指定大脑按 Claude");
  assert.equal(botName("relay", 2, "GPT 5!"), "GPT-5-2", "空格换 -, harness 不许的字符去掉");
  for (const [b, m] of [["claude", "opus"], ["grok", "grok-4.7"], ["deepseek", "deepseek-flash[1m]"], ["relay", "MiniMax-M3.1-Flash"], ["relay", "volcengine/doubao-seed-2.1-pro"], ["codex", "gpt-6.1-terra"], ["none", ""], ["Mistral", ""]])
    for (const n of [1, 2, 12]) assert.match(botName(b, n, m), HARNESS_NAME_RULE, `${b} ${m} ${n}`);
  assert.equal(modelDisplayName("relay", "glm-5.3"), "Glm-5.3", "界面上也不标中转");
  assert.equal(modelDisplayName("relay", "claude-sonnet-4-5"), "Claude Sonnet 4.5");
  assert.equal(modelDisplayName("deepseek", "deepseek-v4-pro"), "Deepseek-V4-Pro");
  assert.equal(modelDisplayName("relay", ""), "中转站");
});
