// 换班不关游戏 (src/play/live-shift.ts, src/lab/running.ts): 每班参数、running.json 的读写和进程探活
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prevFromLast, shiftArgs, shiftLabel } from "../src/play/live-shift.ts";
import { parseRunning, pidAlive, readRunning, writeRunning, clearRunning } from "../src/lab/running.ts";

test("shiftArgs: 连跑中间的班带 --keep-game, 上一班没关游戏就 --attach, 最后一班不带; n = 0 一直带", () => {
  const base = ["--kit", "party", "--minutes", "180"];
  assert.deepEqual(shiftArgs({ base, i: 1, n: 3, live: true, prev: null }), [...base, "--keep-game"]);
  const prev = { runId: "r1", endZip: "I:/x/end.zip", brainDir: "I:/b/r1", gameKept: true };
  assert.deepEqual(shiftArgs({ base, i: 2, n: 3, live: true, prev }), [...base, "--save", "I:/x/end.zip", "--notes", "I:/b/r1", "--keep-game", "--attach"]);
  assert.deepEqual(shiftArgs({ base, i: 3, n: 3, live: true, prev }), [...base, "--save", "I:/x/end.zip", "--notes", "I:/b/r1", "--attach"], "最后一班关游戏");
  assert.deepEqual(shiftArgs({ base, i: 9, n: 0, live: true, prev: { ...prev, gameKept: false, brainDir: undefined } }), [...base, "--save", "I:/x/end.zip", "--keep-game"], "上一班关了游戏 (崩过) 就不 attach; 没笔记就不传");
  assert.deepEqual(shiftArgs({ base, i: 2, n: 3, live: false, prev: { ...prev, gameKept: false } }), [...base, "--save", "I:/x/end.zip", "--notes", "I:/b/r1"], "旧模式 (班末关游戏): 不带 keep / attach");
  assert.ok(shiftArgs({ base, i: 2, n: 3, live: false, prev }).includes("--attach"), "上一班游戏没关 (哪怕这次不连跑) 也要接上, 不然会起第二个服务器");
  assert.equal(shiftLabel(2, 0), "第 2/∞ 班");
  assert.equal(shiftLabel(2, 4), "第 2/4 班");
});

test("prevFromLast: last-run.json 缺 endZip 就 null; gameKept 只认 true", () => {
  assert.equal(prevFromLast({ runId: "a" }), null);
  assert.deepEqual(prevFromLast({ runId: "a", endZip: "e.zip", brainDir: "b", gameKept: "yes" }), { runId: "a", endZip: "e.zip", brainDir: "b", gameKept: false });
  assert.deepEqual(prevFromLast({ endZip: "e.zip", gameKept: true }), { runId: "?", endZip: "e.zip", brainDir: undefined, gameKept: true });
});

test("running.json: 字段校验; 进程不在就当没有并删文件; 本进程自己的 pid 算活", () => {
  assert.equal(parseRunning("{bad"), null);
  assert.equal(parseRunning(JSON.stringify({ pid: 1, gamePort: 2 })), null, "缺 rconPort / password");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-running-"));
  writeRunning(dir, { pid: process.pid, gamePort: 34197, udpPort: 0, rconPort: 27015, password: "pw", save: "m", startedAt: "t" });
  assert.deepEqual(readRunning(dir), { pid: process.pid, gamePort: 34197, udpPort: 0, rconPort: 27015, password: "pw", save: "m", startedAt: "t" });
  writeRunning(dir, { pid: 999_999_999, gamePort: 1, udpPort: 0, rconPort: 2, password: "pw", save: "m", startedAt: "" });
  assert.equal(readRunning(dir), null, "pid 不在 → null");
  assert.ok(!fs.existsSync(path.join(dir, "running.json")), "过期的文件删了");
  clearRunning(dir);
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
});
