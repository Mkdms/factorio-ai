// 换班兜底 (src/play/shift-recover.ts): run.ts 没正常结束时用实例里最新自动存档当结束存档
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverShift, writeCurrentRun } from "../src/play/shift-recover.ts";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-recover-"));
  const playDir = path.join(root, "play"), runDir = path.join(playDir, "runs", "r1"), instanceDir = path.join(root, "instances", "play-run3");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(instanceDir, "saves"), { recursive: true });
  const w = (name: string, ageS: number) => { const f = path.join(instanceDir, "saves", name); fs.writeFileSync(f, name); const t = new Date(Date.now() - ageS * 1000); fs.utimesSync(f, t, t); };
  return { root, playDir, runDir, instanceDir, w };
}

test("这一班崩了: 用它开跑之后写的最新自动存档当 end.zip, 写 recovered.json", () => {
  const { playDir, runDir, instanceDir, w } = setup();
  const started = Date.now() - 600_000;
  writeCurrentRun(playDir, { runId: "r1", runDir, brainDir: path.join(playDir, "brain", "r1"), instanceDir, startedAt: new Date(started + 1000).toISOString() });
  w("_autosave1.zip", 900); // 上一班留下的, 在 started 之前
  w("_autosave2.zip", 120);
  w("_autosave3.zip", 300);
  const rec = recoverShift(playDir, started);
  assert.ok(rec);
  assert.equal(rec!.save, "_autosave2");
  assert.equal(rec!.runId, "r1");
  assert.equal(fs.readFileSync(rec!.endZip, "utf8"), "_autosave2.zip", "end.zip 是最新那份的内容");
  assert.ok(fs.existsSync(path.join(runDir, "recovered.json")));
  assert.ok(rec!.saveAgeS >= 119 && rec!.saveAgeS <= 125);
});

test("不是这一班写的 current-run.json、或没有这一班的自动存档 → null", () => {
  const { playDir, runDir, instanceDir, w } = setup();
  const started = Date.now() - 600_000;
  assert.equal(recoverShift(playDir, started), null, "没有 current-run.json");
  writeCurrentRun(playDir, { runId: "r0", runDir, brainDir: "", instanceDir, startedAt: new Date(started - 5000).toISOString() });
  w("_autosave1.zip", 10);
  assert.equal(recoverShift(playDir, started), null, "是上一班写的");
  writeCurrentRun(playDir, { runId: "r1", runDir, brainDir: "", instanceDir, startedAt: new Date(started + 1000).toISOString() });
  fs.rmSync(path.join(instanceDir, "saves", "_autosave1.zip"));
  w("_autosave1.zip", 900);
  assert.equal(recoverShift(playDir, started), null, "自动存档都在开跑之前");
  assert.equal(fs.existsSync(path.join(runDir, "end.zip")), false);
});
