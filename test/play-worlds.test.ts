// 按世界分对话 (src/play/worlds.ts + control-lib 的 worldsOf / reviewFor / runDirOf): 用临时目录造几班记录
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY, applyWorldName, isHidden, readWorld, runLabelZh, setHidden, setWorldName, worldForNewRun, worldNames, writeWorld } from "../src/play/worlds.ts";
import { reviewFor, runDirOf, worldsOf } from "../src/play/control-lib.ts";

test("世界标题自己改: 存覆盖表不动 world.json, 旧记录也能改, 空名恢复, 太长拒绝, 列表和 worldOfRun 都套上", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "fp-world-names-"));
  const runs = path.join(play, "runs");
  fs.mkdirSync(path.join(runs, "2026-11-01T00-00-00"), { recursive: true });
  fs.mkdirSync(path.join(runs, "2026-11-02T00-00-00"), { recursive: true });
  writeWorld(path.join(runs, "2026-11-02T00-00-00"), { id: "sandbox-x", name: "沙盘 · 原名", kind: "sandbox", createdAt: "", firstRun: "2026-11-02T00-00-00" });
  assert.deepEqual(worldNames(play), {});
  assert.equal(setWorldName(play, "sandbox-x", "  我的  第一张图 ", "沙盘 · 原名"), "我的 第一张图");
  assert.equal(setWorldName(play, "legacy", "以前乱跑的", LEGACY.name), "以前乱跑的");
  assert.deepEqual(worldNames(play), { "sandbox-x": "我的 第一张图", legacy: "以前乱跑的" });
  assert.equal(readWorld(path.join(runs, "2026-11-02T00-00-00"))?.name, "沙盘 · 原名", "world.json 不动");
  const list = worldsOf(play);
  assert.deepEqual(list.map((w) => [w.id, w.name, w.renamed]), [["sandbox-x", "我的 第一张图", true], ["legacy", "以前乱跑的", true]]);
  assert.equal(applyWorldName(play, { id: "other", name: "x" }).renamed, false);
  assert.equal(setWorldName(play, "sandbox-x", "", "沙盘 · 原名"), "沙盘 · 原名");
  assert.equal(worldsOf(play)[0].name, "沙盘 · 原名");
  assert.throws(() => setWorldName(play, "sandbox-x", "长".repeat(41), "沙盘 · 原名"), /最多 40/);
  fs.rmSync(play, { recursive: true, force: true });
});

test("班次名 → 本机时间 (北京 +8)", () => {
  assert.equal(runLabelZh("2026-11-03T11-17-28", 480), "11月3日 19:17");
  assert.equal(runLabelZh("2026-11-03T16-30-00", 480), "11月4日 00:30");
  assert.equal(runLabelZh("乱写", 480), "乱写");
});

test("新开一班的世界: 新地图新世界; 接着存档继承; 接着旧记录就以它为起点新建并补写给它", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "worlds-test-"));
  const dir = (id: string) => { const d = path.join(play, "runs", id); fs.mkdirSync(d, { recursive: true }); return d; };
  const fresh = worldForNewRun("2026-11-04T01-00-00", undefined);
  assert.equal(fresh.world.id, "sandbox-2026-11-04T01-00-00");
  assert.match(fresh.world.name, /^沙盘 · 11月4日 \d\d:00 开的新图$/);
  assert.equal(fresh.backfill, null);
  const a = dir("2026-11-04T01-00-00"); writeWorld(a, fresh.world);
  const next = worldForNewRun("2026-11-04T02-00-00", path.join(a, "end.zip"));
  assert.deepEqual([next.world.id, next.backfill], [fresh.world.id, null], "接着存档 = 同一个世界");
  const old = dir("2026-11-03T10-13-47"); // 旧记录: 没有 world.json
  const cont = worldForNewRun("2026-11-04T03-00-00", path.join(old, "end.zip"));
  assert.equal(cont.world.id, "sandbox-2026-11-03T10-13-47");
  assert.match(cont.world.name, /从 11月3日 \d\d:13 那班的存档接着跑/);
  assert.equal(cont.backfill, old);
  fs.rmSync(play, { recursive: true, force: true });
});

test("世界列表、按世界找复盘、收起只放标记、班次名防穿越", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "worlds-test-"));
  const mk = (id: string, world: { id: string; name: string } | null, files: Record<string, string> = {}) => {
    const d = path.join(play, "runs", id); fs.mkdirSync(d, { recursive: true });
    if (world) writeWorld(d, { ...world, kind: "sandbox", createdAt: "", firstRun: id });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
    return d;
  };
  const W1 = { id: "w1", name: "沙盘 · 甲" }, W2 = { id: "w2", name: "沙盘 · 乙" };
  mk("2026-11-01T00-00-00", null, { "summary.json": "{}", "review.json": JSON.stringify({ lines: [], fixes: ["旧的"] }) });
  mk("2026-11-02T00-00-00", W1, { "summary.json": "{}", "review.json": JSON.stringify({ lines: [], fixes: ["甲的"] }) });
  const b = mk("2026-11-03T00-00-00", W2, { "summary.json": "{}" });
  mk("2026-11-04T00-00-00", W1, { "summary.json": "{}" });
  const ws = worldsOf(play);
  assert.deepEqual(ws.map((w) => [w.id, w.runs.map((r) => r.id.slice(5, 10))]), [["w1", ["11-04", "11-02"]], ["w2", ["11-03"]], ["legacy", ["11-01"]]]);
  assert.equal(ws.at(-1)!.name, LEGACY.name);
  assert.deepEqual(ws[0].runs[0], { ...ws[0].runs[0], running: false, ended: true, interrupted: false, hidden: false });
  // 复盘只在同一个世界里往前找: 11-04 (甲) 找到 11-02 甲的; 11-03 (乙) 找不到 (11-01 是旧记录, 不算)
  assert.deepEqual(reviewFor(play, "2026-11-04T00-00-00")?.fixes, ["甲的"]);
  assert.equal(reviewFor(play, "2026-11-03T00-00-00"), null);
  setHidden(b, true);
  assert.ok(isHidden(b) && worldsOf(play)[1].runs[0].hidden && fs.existsSync(path.join(b, "summary.json")), "收起不删记录");
  setHidden(b, false);
  assert.ok(!isHidden(b));
  assert.equal(runDirOf(play, "../../etc"), null);
  assert.equal(runDirOf(play, "2026-11-09T00-00-00"), null, "没有这一班");
  assert.equal(readWorld(runDirOf(play, "2026-11-02T00-00-00")!)?.name, "沙盘 · 甲");
  fs.rmSync(play, { recursive: true, force: true });
});
