// 第二版那条路 (装模组 + RCON 的主循环 src/play/run.ts, 后期全性能的备用路) 在新项目里能不能加载: 静态核它的 import 图 (不执行 run.ts: 一执行就开班), 模组名对应
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mapRepoMods } from "../src/lab/instance.ts";

const ROOT = path.join(import.meta.dirname, "..");

test("run.ts 的 import 图完整: 每个相对 import 的文件都在、要的具名导出都有 (tools/check-imports.mjs)", () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, "tools", "check-imports.mjs"), path.join(ROOT, "src", "play", "run.ts")], { cwd: ROOT, encoding: "utf8" });
  assert.match(out, /问题 0 个/, out);
});

test("第二版的模组名对到 game/mod/: io-lab 是沙盘模组本身不再给, agent-harness(-party) → factorio-ai-harness, 别的照名, 没有的丢掉, 不重复", () => {
  const have = new Set(["factorio-ai-harness", "factoryplanner"]);
  assert.deepEqual(mapRepoMods(["agent-harness-party", "factoryplanner"], (n) => have.has(n)), ["factorio-ai-harness", "factoryplanner"]);
  assert.deepEqual(mapRepoMods(["io-lab", "agent-harness", "agent-harness-party", "nope"], (n) => have.has(n)), ["factorio-ai-harness"]);
  assert.deepEqual(mapRepoMods([], (n) => have.has(n)), []);
  assert.deepEqual(mapRepoMods(["agent-harness-party"]), ["factorio-ai-harness"], "真目录 game/mod/factorio-ai-harness 在");
});
