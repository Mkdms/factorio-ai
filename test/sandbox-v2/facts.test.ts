// 知识库回归测试: 把 experiments/ 里的实验全部重跑一遍 (不开窗口、不改知识库),
// 结果必须和 knowledge/facts.json 里记的一样。游戏更新后哪条变了, 这里就会报出来。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPERIMENTS } from "../../experiments/index.ts";
import fs from "node:fs";
import path from "node:path";
import { runExperiments, loadFacts } from "../../src/verify/runner.ts";
import { labRoot } from "../../src/lab/gamedir.ts";

test("沙盘核实过的事实在本机版本上仍然成立", async () => {
  const facts = loadFacts();
  const recs = await runExperiments(EXPERIMENTS, { write: false, view: false, name: "test-facts", log: () => undefined });
  // 开测前状态不对的机器 (缺料、没燃料、冻住…) 全部写进 lab-data/regression-preflight.json, 用来定哪些是故意的 (对照组) 再改成默认拦截 (2026-11-02)
  const pre = recs.filter((r) => r.preflight?.length || r.leaks).map((r) => ({ id: r.id, preflight: r.preflight, leaks: r.leaks }));
  fs.mkdirSync(labRoot(), { recursive: true });
  fs.writeFileSync(path.join(labRoot(), "regression-preflight.json"), JSON.stringify(pre, null, 1));
  const missing = recs.filter((r) => !facts[r.id]).map((r) => r.id);
  const changed = recs
    .filter((r) => facts[r.id] && facts[r.id].verdict !== r.verdict)
    .map((r) => `${r.id}: 记录是 ${facts[r.id].verdict}, 现在是 ${r.verdict} (${r.summary})`);
  assert.deepEqual(missing, [], "有实验还没写进知识库, 先跑 npm run verify");
  assert.deepEqual(changed, [], "有事实变了, 先查更新日志再决定改知识库还是改实验");
  // 自动补杆 (power_fix) 是兜底不是常态: 触发了说明实验或供电函数有 bug, 要查 (2026-11-01: 它盖住了四角连不上线的问题好几轮)
  const fixed = recs.filter((r) => (r.autoFixes ?? 0) > 0).map((r) => `${r.id}: 自动补了 ${r.autoFixes} 根杆子`);
  assert.deepEqual(fixed, [], "有实验靠自动补杆才有电, 去查供电盖漏的原因");
});
