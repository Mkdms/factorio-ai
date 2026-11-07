// 下一班阵容 (src/play/roster.ts): 账号页给每个角色选模型, 存 lineup.json, run.ts 没给 --brains 时按它
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanSeat, readRoster, rosterToBrains, saveRoster } from "../src/play/roster.ts";
import { lineup } from "../src/play/brains.ts";

test("阵容: 清理、存、读、删; 转成 --brains 写法后 lineup 认 (两个中转模型同时用)", () => {
  assert.deepEqual(cleanSeat({ brain: " Relay ", model: " glm-5.3 " }), { brain: "relay", model: "glm-5.3" });
  assert.deepEqual(cleanSeat({ brain: "claude" }), { brain: "claude", model: "" });
  assert.equal(cleanSeat({ brain: "gpt5", model: "x" }), null, "家不认识");
  assert.equal(cleanSeat({ brain: "relay", model: "有 空格" }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-test-"));
  const file = path.join(dir, "accounts", "lineup.json");
  assert.deepEqual(readRoster(file), [], "没文件 = 不用阵容");
  assert.throws(() => saveRoster(file, [{ brain: "claude", model: "opus" }, { brain: "nope", model: "" }]), /第 2 个角色不合格/);
  assert.throws(() => saveRoster(file, Array(27).fill({ brain: "claude", model: "" })), /最多 26/);
  assert.ok(!fs.existsSync(file), "不合格时文件不动");
  assert.equal(saveRoster(file, Array(9).fill({ brain: "relay", model: "glm-5.3" })).length, 9, "9 个角色 (派对那样) 可以");
  assert.equal(lineup({ brain: "claude", model: "opus", brains: rosterToBrains(readRoster(file)) }).at(-1)?.who, "Glm-5.3-8", "9 个同模型: 第 1 个是玩家, 8 个服务器角色叫 Glm-5.3, Glm-5.3-2 … Glm-5.3-8");
  const seats = saveRoster(file, [{ brain: "claude", model: "opus" }, { brain: "relay", model: "glm-5.3" }, { brain: "relay", model: "deepseek-v4-pro" }]);
  assert.deepEqual(readRoster(file), seats);
  assert.equal(rosterToBrains(seats), "claude:opus,relay:glm-5.3,relay:deepseek-v4-pro");
  const s = lineup({ brain: "claude", model: "opus", brains: rosterToBrains(seats) });
  assert.deepEqual(s.map((x) => [x.brain, x.model, x.who]), [["claude", "opus", 1], ["relay", "glm-5.3", "Glm-5.3"], ["relay", "deepseek-v4-pro", "Deepseek-V4-Pro"]], "两个中转模型各一个角色, 游戏名 = 模型名");
  assert.deepEqual(saveRoster(file, []), []);
  assert.ok(!fs.existsSync(file), "空阵容 = 删文件");
  fs.rmSync(dir, { recursive: true, force: true });
});
