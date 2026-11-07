// ./fh 回复后面附的经验 (commands/hints.ts)、按情况挑的要点 (core/run/hints.ts)、输出封顶 (commands/output-cap.ts); 不开游戏
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHint, builtMachine, errorHint, forgetShown, lookupHint, lookupQuery, replyExtras, teamFact } from "../commands/hints.ts";
import { capOutput } from "../commands/output-cap.ts";
import { HINTS, hintLine, hintsForLines, pointsByTags } from "../core/run/hints.ts";
import { pointsMd } from "../core/run/training.ts";

const call = (o: unknown) => ["call", "build", "--args", JSON.stringify(o), "--wait"];

test("认出放的是不是机器: 单个、批量、带配方、位置、台数; 传送带和坏 JSON 不算", () => {
  assert.deepEqual(builtMachine(call({ item: "assembling-machine-1", recipe: "iron-gear-wheel", position: { x: 1, y: 2 } })), { item: "assembling-machine-1", recipe: "iron-gear-wheel", position: { x: 1, y: 2 }, count: 1 });
  assert.deepEqual(builtMachine(call({ builds: [{ item: "stone-furnace", position: { x: 0, y: 0 } }, { item: "stone-furnace", position: { x: 2, y: 0 } }] })), { item: "stone-furnace", position: { x: 0, y: 0 }, count: 2 });
  assert.equal(builtMachine(call({ item: "transport-belt" })), null);
  assert.equal(builtMachine(["call", "build", "--args", "{坏的"]), null);
  assert.equal(builtMachine(["call", "build"]), null);
});

test("放机器附经验: 隔 45 分钟重新给; 压缩后 (forgetShown) 马上重新给; 没经验就不附", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fa-hints-"));
  const stateFile = path.join(d, ".fh-hints.json");
  const deps = { zh: (id: string) => ({ "iron-gear-wheel": "铁齿轮" } as Record<string, string>)[id], stateFile, now: 1_000_000_000, know: (n: string) => [`[思路 P-1] ${n} 比例从满载带倒推`] };
  const c = call({ item: "assembling-machine-1", recipe: "iron-gear-wheel" });
  assert.match(buildHint(c, deps)!, /\.\/know 铁齿轮 看更多[\s\S]*铁齿轮 比例从满载带倒推/);
  assert.equal(buildHint(c, { ...deps, now: deps.now + 60_000 }), null, "刚给过");
  forgetShown(stateFile);
  assert.match(buildHint(c, { ...deps, now: deps.now + 120_000 })!, /倒推/, "压缩后模型不记得了");
  assert.match(buildHint(c, { ...deps, now: deps.now + 120_000 + 46 * 60_000 })!, /倒推/, "别家看不到压缩: 靠时间");
  assert.equal(buildHint(call({ item: "stone-furnace" }), { ...deps, know: () => [] }), null);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8"))["n:iron-gear-wheel"], 4, "手放计数");
  fs.rmSync(d, { recursive: true });
});

test("接到已经在查的地方: recipes / describe / help / technologies; 手册主题不重复附; 1 分钟一条, 同一个词 20 分钟一次", () => {
  assert.deepEqual(lookupQuery(["call", "recipes", "--args", '{"name":"iron-gear-wheel"}']), { query: "iron-gear-wheel", item: "iron-gear-wheel" });
  assert.deepEqual(lookupQuery(["help", "belt_route"]), { query: "belt_route" });
  assert.deepEqual(lookupQuery(["call", "technologies", "--args", '{"available":true}']), { query: "研究 科技 顺序" });
  assert.equal(lookupQuery(["help", "pattern-production"]), null);
  assert.equal(lookupQuery(["call", "describe", "--format", "json", "--bot", "Test"]), null, "开关的值不是查询词");
  assert.equal(lookupQuery(["call", "status"]), null);
  const state = {};
  const d = { now: 1_000_000_000, know: () => ["[思路 P-1] 比例从满载带倒推"] };
  assert.match(lookupHint(["call", "recipes", "--args", '{"name":"iron-gear-wheel"}'], state, d)!, /\.\/know iron-gear-wheel 看更多[\s\S]*比例从满载带倒推/);
  assert.equal(lookupHint(["help", "build"], state, { ...d, now: d.now + 30_000 }), null, "1 分钟内不再附");
  assert.equal(lookupHint(["call", "recipes", "--args", '{"name":"iron-gear-wheel"}'], state, { ...d, now: d.now + 120_000 }), null, "同一个词 20 分钟一次");
  assert.ok(lookupHint(["help", "build"], state, { ...d, now: d.now + 120_000 }));
});

test("报错给查法: 退出码或 error: 行都算; 命令行写错和聊天不附; 同一个命令 10 分钟一次", () => {
  const state = {};
  const d = { now: 1_000_000_000, know: (q: string) => [`经验 ${q}`] };
  const t = errorHint(["call", "build", "--args", "{}"], "tick: 1\nerror: action_failed: Unknown item name: small-pipe-to-ground", 1, state, d)!;
  assert.match(t, /经验 build small-pipe-to-ground/);
  assert.match(t, /查法: \.\/know build small-pipe-to-ground/);
  assert.match(t, /\.\/fh help build/);
  assert.equal(errorHint(["call", "build"], "error: x", 1, state, { ...d, now: d.now + 1000 }), null);
  assert.equal(errorHint(["call", "transfer"], "ok", 0, state, d), null, "成功的不附");
  assert.equal(errorHint(["status", "--brief"], "error: client_error: fh status does not take --brief", 1, state, d), null);
  assert.equal(errorHint(["say", "你好"], "error: x", 1, state, d), null);
});

test("队友事实: 只报别人的、新的, 5 分钟最多一条; 普通命令不加载知识库; 动作计数", async () => {
  const T = 1_000_000_000, state = {};
  const rows = [{ at: T - 40 * 60_000, who: "A", text: "太旧" }, { at: T - 60_000, who: "我", text: "我自己" }, { at: T - 30_000, who: "A", text: "A 放了 6 台" }];
  const read = () => rows.map((r) => JSON.stringify(r)).join("\n");
  assert.equal(teamFact(state, T, "我", read), "队友: A 放了 6 台");
  rows.push({ at: T + 1000, who: "B", text: "B 放了" });
  assert.equal(teamFact(state, T + 2000, "我", read), null, "5 分钟内不再说");
  assert.equal(teamFact(state, T + 5 * 60_000 + 1, "我", read), "队友: B 放了");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fa-extras-"));
  const stateFile = path.join(d, ".fh-hints.json");
  let loaded = 0;
  const load = async () => { loaded++; throw new Error("不该加载"); };
  assert.equal(await replyExtras(["call", "status"], "ok", 0, { stateFile, now: 1, me: "x", load }), null);
  assert.equal(await replyExtras(["call", "transfer", "--args", "{}"], "ok", 0, { stateFile, now: 2, me: "x", load }), null);
  assert.equal(loaded, 0);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).__cmds, 1, "status 不算, transfer 算");
  fs.rmSync(d, { recursive: true });
});

test("capOutput: 不超不动; 超了留头留尾, 中间一行说明", () => {
  assert.equal(capOutput("短的", 100), "短的");
  const c = capOutput("a".repeat(5000) + "b".repeat(5000), 1000);
  assert.ok(c.startsWith("a".repeat(800)) && c.endsWith("b".repeat(150)));
  assert.match(c, /中间省略 9050 个字/);
});

const MD = ["# 要点", "", "## 推进", "- 先找最卡的那一个 (P-mind-01)", "- 验收看持续产量 (P-prod-04)", "", "## 物流", "- 燃料不手补: 煤带 + 机械臂 (P-ops-fuel)", "不是要点的一行 (P-mind-01)"].join("\n");

test("要点: 按出处标签挑; 扫描的句子对得上才附; 每条提示规则的标签在训练集的 points.md 里都挑得到", () => {
  assert.deepEqual(pointsByTags(MD, ["P-mind-01", "P-ops-fuel"]), ["先找最卡的那一个 (P-mind-01)", "燃料不手补: 煤带 + 机械臂 (P-ops-fuel)"]);
  assert.deepEqual(hintsForLines(MD, ["研究中心 11 台只有 2 台在工作"]), ["先找最卡的那一个 (P-mind-01)"]);
  assert.deepEqual(hintsForLines(MD, ["一切正常"]), []);
  assert.equal(hintLine(MD, ["没事"]), "");
  assert.match(hintLine(MD, ["你的角色已经闲了约 3 分钟"]), /^要点 \(我们核实过的经验.*先找最卡的那一个/);
  const real = pointsMd();
  assert.ok(real.length > 1000);
  for (const h of HINTS) assert.ok(pointsByTags(real, h.tags).length >= 1, `${h.title}: 标签 ${h.tags.join(" / ")} 在 points.md 里挑不到要点`);
  assert.ok(hintsForLines(real, ["阶段: 刚开局"]).length >= 1, "开班扫描的阶段句子要对得上");
});
