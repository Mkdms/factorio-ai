// 研究自动续上的选法 (src/play/research.ts pickResearch / normalizeResearch); 对真游戏读候选的在 test/sandbox/research.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickResearch, normalizeResearch, isMilitary, type TechCandidate } from "../src/play/research.ts";

const red = "automation-science-pack", green = "logistic-science-pack", gray = "military-science-pack";
const c = (name: string, units: number, time: number, packs: string[]): TechCandidate => ({ name, units, time, packs });

test("只排场上在产的瓶能研究的, 最便宜的优先", () => {
  const st = { current: "", queue: 0, peaceful: false, producing: [red, green], candidates: [
    c("advanced-material-processing", 75, 30, [red, green]), // 2250
    c("fast-inserter", 30, 30, [red]), // 900
    c("chemical-science-pack", 75, 10, [red, green]), // 750
    c("stronger-explosives-1", 50, 30, [red, green, gray]), // 要灰瓶, 没产
  ] };
  const r = pickResearch(st);
  assert.equal(r.pick?.name, "chemical-science-pack");
  assert.deepEqual(r.usable.map((x) => x.name), ["chemical-science-pack", "fast-inserter", "advanced-material-processing"]);
});

test("和平模式跳过军事类; 非和平照排", () => {
  const cands = [c("weapon-shooting-speed-1", 10, 30, [red]), c("gun-turret", 10, 10, [red]), c("logistics", 20, 15, [red])];
  assert.equal(pickResearch({ current: "", queue: 0, peaceful: true, producing: [red], candidates: cands }).pick?.name, "logistics");
  assert.equal(pickResearch({ current: "", queue: 0, peaceful: false, producing: [red], candidates: cands }).pick?.name, "gun-turret");
  assert.equal(isMilitary("military-2"), true);
  assert.equal(isMilitary("rocket-silo"), false, "火箭发射井不是军事");
  assert.equal(isMilitary("electric-energy-distribution-1"), false);
});

test("什么都没产过时按只有红瓶算; 没有能排的返回 null", () => {
  const cands = [c("automation", 10, 10, [red]), c("logistic-science-pack", 75, 5, [red, green])];
  const r = pickResearch({ current: "", queue: 0, peaceful: true, producing: [], candidates: cands });
  assert.equal(r.pick?.name, "automation");
  assert.deepEqual(r.producing, [red]);
  assert.equal(pickResearch({ current: "", queue: 0, peaceful: true, producing: [red], candidates: [c("x", 1, 1, [green])] }).pick, null);
});

test("Lua 空表 {} 当空数组", () => {
  const st = normalizeResearch({ current: "", queue: 0, peaceful: true, producing: {}, candidates: [{ name: "a", units: 1, time: 1, packs: {} }] });
  assert.deepEqual(st.producing, []);
  assert.deepEqual(st.candidates[0].packs, []);
  assert.equal(pickResearch(st).pick, null, "没写要哪种瓶的候选不排");
});
