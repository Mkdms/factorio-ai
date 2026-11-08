// 群的接力: 真班接真班, 不叫大脑的验证班不进接力 (2026-11-05 查出开班会接开虫子验证班的存档)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGroup, groupStartProblem, latestRunOfGroup, noBrainRequested, readGroup, startArgs } from "../src/play/groups.ts";

test("命令行说不叫大脑永远赢过群名单 (2026-11-06 误开过一班真模型)", () => {
  assert.equal(noBrainRequested(["node", "run.ts", "--group", "g", "--brain", "none"]), true);
  assert.equal(noBrainRequested(["node", "run.ts", "--brain=none"]), true);
  assert.equal(noBrainRequested(["node", "run.ts", "--brains", "none,none"]), true);
  assert.equal(noBrainRequested(["node", "run.ts", "--brains", "none,claude"]), false, "混着真模型的不算");
  assert.equal(noBrainRequested(["node", "run.ts", "--group", "g"]), false);
  assert.equal(noBrainRequested(["node", "run.ts", "--brain", "claude"]), false);
});

test("群里有班次又没给存档: 拒绝, 不悄悄开新图", () => {
  const g = { name: "测试", kind: "new" } as never;
  assert.match(groupStartProblem(g, undefined, { runId: "r1" }) ?? "", /开一张新图/);
  assert.equal(groupStartProblem(g, "x.zip", { runId: "r1" }), null);
  assert.equal(groupStartProblem(g, undefined, null), null, "新群第一班可以开新图");
});

test("界面开班的参数带存档, 不会被上面拦住", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "groups-start-"));
  const g = createGroup(play, { name: "x", kind: "new", seats: [{ brain: "none" }] as never });
  const run = path.join(play, "runs", "2026-11-05T01-00-00");
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, "world.json"), JSON.stringify({ id: g.id, name: "x" }));
  fs.writeFileSync(path.join(run, "end.zip"), "");
  fs.writeFileSync(path.join(run, "summary.json"), JSON.stringify({ lineup: [{ brain: "claude" }] }));
  const args = startArgs(play, g);
  const last = latestRunOfGroup(play, g.id);
  const save = args[args.indexOf("--save") + 1];
  assert.equal(groupStartProblem(g, save, last), null);
  fs.rmSync(play, { recursive: true, force: true });
});

test("接力跳过 --brain none 的验证班, 真班照接; 没有 summary 的还算", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "groups-relay-"));
  try {
    const g = createGroup(play, { name: "t", kind: "new" });
    const addRun = (id: string, summary: object | null) => {
      const dir = path.join(play, "runs", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify({ id: g.id, name: "t", kind: "sandbox", createdAt: "", firstRun: "" }));
      fs.writeFileSync(path.join(dir, "end.zip"), "x");
      if (summary) fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary));
    };
    const notes = fs.mkdtempSync(path.join(os.tmpdir(), "groups-notes-"));
    addRun("2026-11-05T10-00-00", { lineup: [{ brain: "claude" }, { brain: "none" }], brainDir: notes });
    addRun("2026-11-05T11-00-00", { lineup: [{ brain: "none" }, { brain: "none" }], brainDir: notes });
    assert.equal(latestRunOfGroup(play, g.id)?.runId, "2026-11-05T10-00-00", "混着真大脑的算真班, 全 none 的跳过");
    const args = startArgs(play, readGroup(play, g.id)!);
    assert.equal(args[args.indexOf("--save") + 1], path.join(play, "runs", "2026-11-05T10-00-00", "end.zip"));
    assert.equal(args[args.indexOf("--notes") + 1], notes);
    addRun("2026-11-05T12-00-00", null);
    assert.equal(latestRunOfGroup(play, g.id)?.runId, "2026-11-05T12-00-00", "没写完 summary 的 (硬杀) 不知道是不是验证班, 还算");
    // 不装模组那条路开班就写 run.json: summary 没写成时笔记目录从它补; run.json 说是 none 的验证班照样跳过
    addRun("2026-11-05T13-00-00", null);
    fs.writeFileSync(path.join(play, "runs", "2026-11-05T13-00-00", "run.json"), JSON.stringify({ dir: notes, brain: "claude" }));
    assert.deepEqual([latestRunOfGroup(play, g.id)?.runId, latestRunOfGroup(play, g.id)?.brainDir], ["2026-11-05T13-00-00", notes], "summary 没写成, 笔记目录从 run.json 补");
    addRun("2026-11-05T14-00-00", null);
    fs.writeFileSync(path.join(play, "runs", "2026-11-05T14-00-00", "run.json"), JSON.stringify({ dir: notes, brain: "none" }));
    assert.equal(latestRunOfGroup(play, g.id)?.runId, "2026-11-05T13-00-00", "run.json 说是验证班的跳过");
    fs.rmSync(notes, { recursive: true, force: true });
  } finally { fs.rmSync(play, { recursive: true, force: true }); }
});
