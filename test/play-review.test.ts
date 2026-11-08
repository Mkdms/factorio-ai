// 每班自动复盘 (src/play/review-shift.ts): 读数和"下一班先修"的排序 (数字取自 2026-11-03 第十三轮接续第 2 班的复盘)
import test from "node:test";
import assert from "node:assert/strict";
import { reviewShift, reviewNotes, reviewMarkdown, type ShiftData } from "../src/play/review-shift.ts";

const mon = (n: number, labsWorking: number, red: number, green: number, busyA = true) => ({ tick: n * 3600, researched: 45 + n, labs: 11, labsWorking, busyBy: { a: busyA, b: true }, redTotal: red, greenTotal: green });
const data: ShiftData = {
  monitor: [mon(0, 11, 0, 0), mon(5, 2, 50, 70, false), mon(10, 1, 120, 160)],
  health: [{ lines: ["缺料: 炉子 7 台", "采矿机采空 5 台: (1,2)"] }, { lines: ["缺料: 炉子 9 台"] }],
  requests: [
    { t: 1, action: "observe", ok: true, agent: "a" }, { t: 2, action: "status", ok: true, agent: "a" }, { t: 3, action: "build", ok: false, agent: "a" },
    { t: 4, action: "sleep", ok: true, agent: "a", args: { seconds: 120 } }, { t: 5, action: "observe", ok: true, agent: "a" },
  ],
  digest: [{ hauls: [{ name: "MK", items: 2000, top: { item: "coal", times: 676, to_name: "burner-mining-drill" } }] }],
  friction: ["12 秒 / 1 次: observe: …"],
  english: { a: "10/23 句英文" },
};
const prev = [mon(0, 11, 0, 0), mon(10, 11, 181, 165)];
const zh = (n: string) => ({ coal: "煤矿", "burner-mining-drill": "热能采矿机" })[n] ?? n;

test("读数: 产量和上一班比、研究、研究中心停着、闲着、查询占比、体检比例、手搬", () => {
  const r = reviewShift(data, prev, zh);
  assert.equal(r.lines[0], "科技包每分钟 (整班平均): 红瓶 12.0、绿瓶 16.0、蓝瓶 —; 上一班: 红瓶 18.1、绿瓶 16.5、蓝瓶 —");
  assert.equal(r.lines[1], "研究: 45 → 55 项; 游戏时间 10 分钟");
  assert.equal(r.lines[2], "研究中心一半以上停着的时间: 67%");
  assert.equal(r.lines[3], "角色闲着的时间: A 33%、B 0%");
  assert.equal(r.lines[4], "A: 请求 5 次, 其中查询 60%、建造 20%、失败 1 次 (20%), 睡 1 次 (请求的时长合计 2 分钟), 10/23 句英文");
  assert.match(r.lines.join("\n"), /体检各类问题出现的比例: 缺料 100%、采矿机采空 50%/);
  assert.match(r.lines.join("\n"), /MK 这一班手搬 2000 个, 重复最多: 煤矿 676 次到热能采矿机/);
});

test("下一班先修: 研究中心 > 产量变低 > 一直在报的体检 > 手搬 > 查询太多, 最多 3 条", () => {
  const r = reviewShift(data, prev, zh);
  assert.equal(r.fixes.length, 3);
  assert.match(r.fixes[0], /^研究中心整班有 67% 的时间/);
  assert.match(r.fixes[1], /产量比上一班低 \(红瓶、绿瓶\)/);
  assert.match(r.fixes[2], /体检里"缺料"整班 100%/);
  const calm = reviewShift({ ...data, monitor: [mon(0, 11, 0, 0), mon(10, 11, 300, 300)], health: [] }, prev, zh);
  assert.match(calm.fixes[0], /MK 手搬 煤矿 676 次到热能采矿机: 改成传送带/);
  assert.match(calm.fixes[1], /A 上一班 60% 的请求是查询/);
});

test("没扩产: 机器几乎没增加就进先修 (排在研究中心之后)", () => {
  const grow = (n: number, machines: number) => ({ ...mon(n, 2, n * 10, n * 10), machines });
  const r = reviewShift({ ...data, monitor: [grow(0, 120), grow(5, 121), grow(10, 121)] }, prev, zh);
  assert.match(r.lines.join("\n"), /生产机器: 开班 120 → 班末 121 \(新增 1\)/);
  assert.match(r.fixes[0], /^研究中心/);
  assert.match(r.fixes[1], /^这一班只新增了 1 台生产机器/);
  const built = reviewShift({ ...data, monitor: [grow(0, 120), grow(10, 160)] }, prev, zh);
  assert.ok(!built.fixes.some((f) => f.startsWith("这一班只新增")));
});

test("写进笔记和 review.md 的样子", () => {
  assert.equal(reviewNotes(["先补蓝瓶线。", "拆采空的采矿机。"], "2026-11-03T09-12-00"), "## 上一班复盘 (监工自动, 2026-11-03T09-12-00): 先修这几条\n1. 先补蓝瓶线。\n2. 拆采空的采矿机。\n\n");
  assert.equal(reviewNotes([], "x"), "");
  assert.match(reviewMarkdown({ lines: ["a"], fixes: [] }, "r1"), /^# 复盘 r1\n\n- a\n\n## 下一班先修\n\(没有\)/);
});
