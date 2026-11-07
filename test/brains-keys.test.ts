// 本机密钥文件 (core/brains/keys.ts): 站点地址清理、中转站配置、站标的协议格式; 没有文件 / 坏文件都当空
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanUrl, readKeys, readRelayFormats, relayConfig } from "../core/brains/keys.ts";

test("cleanUrl: 补 https、去末尾 / 和 /v1 (Claude Code 自己加 /v1); 不是网址 → null", () => {
  assert.equal(cleanUrl("ai.example.com"), "https://ai.example.com");
  assert.equal(cleanUrl(" https://ai.example.com/v1/ "), "https://ai.example.com");
  assert.equal(cleanUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.equal(cleanUrl("https://x.y/sub/v1"), "https://x.y/sub");
  assert.deepEqual([cleanUrl(""), cleanUrl("ftp://a.b"), cleanUrl("有 空格.com"), cleanUrl("https://")], [null, null, null, null]);
});

test("readKeys / relayConfig / readRelayFormats: 读本机文件; 没有文件、坏 JSON、坏 relay_formats 都当空", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keys-test-"));
  const file = path.join(dir, "keys.json");
  assert.deepEqual(readKeys(file), {});
  assert.deepEqual(relayConfig(readKeys(file)), { url: "", key: "", model: "" });
  assert.deepEqual(readRelayFormats(file), {});
  fs.writeFileSync(file, JSON.stringify({ relay_url: "a.b/v1", relay: " tok ", relay_model: "glm-5.3", relay_formats: JSON.stringify({ "glm-5.3": ["anthropic", "openai"], bad: "x" }), deepseek: "k" }));
  assert.deepEqual(relayConfig(readKeys(file)), { url: "https://a.b", key: "tok", model: "glm-5.3" });
  assert.deepEqual(readRelayFormats(file), { "glm-5.3": ["anthropic", "openai"] }, "不是数组的条目丢掉");
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(readKeys(file), {});
  fs.writeFileSync(file, JSON.stringify({ relay_formats: "{bad" }));
  assert.deepEqual(readRelayFormats(file), {});
  fs.rmSync(dir, { recursive: true, force: true });
});
