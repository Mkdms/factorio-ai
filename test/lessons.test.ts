// 教训 (core/run/lessons.ts、deliver.ts): 种子文件合规、做动作时挑哪几条、笔记里的教训解析和键推断、待核区的读写; 不开游戏
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendLearned, bytes, fitBytes, inferKeys, isGeneralLesson, learnedSeeds, lessonMatches, lessonPicker, loadSeeds, mergePlan, nameIndex, parseNotesLessons, readLearned, RULE_BYTES, validateSeed } from "../core/run/lessons.ts";
import { collectNotesLessons, lessonDelivery } from "../core/run/deliver.ts";
import { trainingRoot } from "../core/run/training.ts";

const SEED_FILE = path.join(trainingRoot(), "lessons", "verified", "seed.json");
const zh = new Map([["iron-plate", "铁板"], ["stone-furnace", "石炉"], ["iron-gear-wheel", "铁齿轮"], ["coal", "煤"], ["transport-belt", "传送带"], ["boiler", "锅炉"], ["crude-oil", "原油"]]);
const idx = nameIndex(zh, ["build", "transfer", "craft", "feed", "refuel", "status", "inspect", "bottleneck"]);

test("训练集的种子: 每条 rule ≤160 字节、键是内部名、不重复、有出处, 至少 25 条", () => {
  const seeds = loadSeeds(SEED_FILE);
  assert.ok(seeds.length >= 25, `只有 ${seeds.length} 条`);
  for (const s of seeds) {
    assert.ok(bytes(s.rule) <= RULE_BYTES, `${s.rule} 超长 (${bytes(s.rule)} 字节)`);
    assert.ok(Object.keys(s.keys).length >= 1);
    assert.ok(s.source, `${s.rule.slice(0, 20)} 没写出处`);
  }
  assert.ok(seeds.some((s) => s.keys.action === "build" && s.keys.entity === "stone-furnace"), "有冶炼列那条");
  assert.ok(seeds.some((s) => s.keys.action === "craft" && s.keys.recipe === "automation-science-pack"), "有科技包不手搓那条");
});

test("validateSeed 拒绝: 超长、没键、键不是内部名、impact 越界; fitBytes 截到 ≤160 字节", () => {
  assert.throws(() => validateSeed({ rule: "中".repeat(60), keys: { action: "build" } }), /超过 160 字节/);
  assert.throws(() => validateSeed({ rule: "x", keys: {} }), /至少一个键/);
  assert.throws(() => validateSeed({ rule: "x", keys: { entity: "Stone Furnace" } }), /内部名/);
  assert.throws(() => validateSeed({ rule: "x", keys: { action: "build" }, impact: 7 }), /impact/);
  assert.equal(validateSeed({ rule: " 好 ", keys: { action: "build" }, impact: 2 }).rule, "好");
  assert.equal(fitBytes("a  b\nc"), "a b c");
  const long = fitBytes("中文教训, ".repeat(30));
  assert.ok(bytes(long) <= RULE_BYTES && long.endsWith("…"), long);
});

test("做动作时挑: 带名字的要名字对上, 只有动作的对所有该动作; 一次最多 2 条, 影响大的先, 同一条一班最多 2 次", () => {
  const seeds = [
    { rule: "炉子出口接带", keys: { action: "build", entity: "stone-furnace" }, impact: 3 },
    { rule: "先清场", keys: { action: "build" }, impact: 1 },
    { rule: "批量放", keys: { action: "build" }, impact: 2 },
    { rule: "别手搓瓶", keys: { action: "craft", recipe: "automation-science-pack" } },
  ];
  assert.equal(lessonMatches(seeds[0], "build", { item: "stone-furnace" }), true);
  assert.equal(lessonMatches(seeds[0], "build", { builds: [{ item: "stone-furnace" }] }), true, "批量里的也算");
  assert.equal(lessonMatches(seeds[0], "build", { item: "lab" }), false);
  assert.equal(lessonMatches(seeds[1], "mine", {}), false);
  assert.equal(lessonMatches(seeds[3], "craft", { recipe: "automation-science-pack" }), true);
  const p = lessonPicker(seeds);
  assert.deepEqual(p.pick("build", { item: "stone-furnace" }), ["炉子出口接带", "批量放"], "影响大的两条");
  assert.deepEqual(p.pick("build", { item: "stone-furnace" }), ["炉子出口接带", "批量放"]);
  assert.deepEqual(p.pick("build", { item: "stone-furnace" }), ["先清场"], "前两条带过 2 次了");
  assert.deepEqual(p.pick("craft", { recipe: "iron-gear-wheel" }), []);
  assert.deepEqual(p.stats(), { shown: 5, distinct: 3 });
  assert.match(lessonPicker([{ rule: "x", keys: { action: "mine" }, unverified: true }]).pick("mine", {})[0], /没核实/);
});

test("parseNotesLessons: 只取 教训 / Lessons 一节, 去掉列表符号, 跳过占位 (模板里括号的说明也算占位)", () => {
  const md = "## 现在在做\n- 做事\n\n## 教训\n- (持久的规律, 一条一行)\n- 铁板要走带子\n* **transfer** 往石炉放煤前先看背包\n1. (none)\n\n## 日志\n- 不是教训\n";
  assert.deepEqual(parseNotesLessons(md), ["铁板要走带子", "transfer 往石炉放煤前先看背包"]);
  assert.deepEqual(parseNotesLessons("## Lessons\n- 无\n- 手搓铁齿轮太慢\n"), ["手搓铁齿轮太慢"]);
  assert.deepEqual(parseNotesLessons("没有这一节"), []);
});

test("inferKeys: 动作名 + 内部名 / 官方中文名 / 俗名; 手搓当配方; 认不出就 null", () => {
  assert.deepEqual(inferKeys("./fh call transfer 往石炉放煤前先看背包", idx), { action: "transfer", item: "stone-furnace" });
  assert.deepEqual(inferKeys("铁板要走带子, 别手搬", idx), { item: "iron-plate" });
  assert.deepEqual(inferKeys("手搓铁齿轮太慢, 用机器", idx), { recipe: "iron-gear-wheel" });
  assert.deepEqual(inferKeys("build 时 stone-furnace 要先清树", idx), { action: "build", item: "stone-furnace" });
  assert.deepEqual(inferKeys("炉子要接煤带", idx), { item: "stone-furnace" }, "俗名 炉子");
  assert.deepEqual(inferKeys("用 ./fh call status 看就行", idx), null, "只读动作不当键");
  assert.equal(inferKeys("今天天气不错", idx), null);
});

test("mergePlan: 去重 (同文字 / 一条是另一条的开头)、截长、每人上限", () => {
  const lines = ["铁板要走带子, 别手搬", "铁板要走带子, 别手搬 (重复)", "锅炉要接煤带, 不然发电停; ".repeat(8), "没有键的一句话", "煤用 transfer 放进锅炉只兜底"];
  const plan = mergePlan(lines, [{ rule: "铁板要走带子, 别手搬" }], idx, 2);
  assert.deepEqual(plan.add.map((a) => a.keys), [{ item: "boiler" }, { action: "transfer", item: "boiler" }]);
  assert.ok(bytes(plan.add[0].rule) <= RULE_BYTES && plan.add[0].rule.endsWith("…"));
  assert.deepEqual(plan.skipped.map((s) => s.why), ["库里已有", "库里已有", "认不出键 (没提到动作名或物品 / 建筑的官方名)"]);
});

test("待核区 learned.jsonl: 通用的、没有的才记; 带坐标 / 只对这局有用 / 工具毛病的不记; 开班带上时标没核实", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fa-learned-")), "learned.jsonl");
  assert.equal(isGeneralLesson("铁板要走带子"), true);
  assert.equal(isGeneralLesson("箱子在 (12, -30)"), false);
  assert.equal(isGeneralLesson("这班西边有矿"), false);
  assert.equal(isGeneralLesson("工具报 TypeError 已修"), false);
  const n = appendLearned(f, [{ rule: "铁板要走带子", keys: { item: "iron-plate" } }, { rule: "箱子在 (12, -30)", keys: { item: "wooden-chest" } }, { rule: "铁板要走带子", keys: { item: "iron-plate" } }]);
  assert.equal(n, 1);
  assert.equal(appendLearned(f, [{ rule: " 铁板要走带子 ", keys: { item: "iron-plate" } }]), 0, "已有的不重复");
  assert.equal(readLearned(f).length, 1);
  const seeds = learnedSeeds([f], [{ rule: "别的种子", keys: { action: "build" } }]);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].unverified, true);
  assert.equal(seeds[0].impact, 1);
  assert.deepEqual(learnedSeeds([f], [{ rule: "铁板要走带子", keys: { item: "iron-plate" } }]), [], "和种子文字相同的不要");
});

test("开班从训练集读: 种子 + 之前各班的; 放石炉时带出得到; 班末笔记的教训收进待核区 (临时文件), 第二次不重复", () => {
  const d = lessonDelivery();
  assert.ok(d.curated >= 25 && d.learned >= 1, `种子 ${d.curated} 之前的 ${d.learned}`);
  assert.ok(d.learned <= 70);
  const got = d.pick("build", { item: "stone-furnace", position: { x: 0, y: 0 } });
  assert.ok(got.length >= 1 && got.length <= 2, JSON.stringify(got));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fa-collect-")), "learned.jsonl");
  const notes = "# 笔记\n\n## 教训\n- (占位)\n- 石炉出口的板子要接到用板子的地方, 别堆在炉子里\n- 箱子在 (3,4)\n- 今天天气不错\n\n## 日志\n- x\n";
  const r = collectNotesLessons(notes, zh, "claude-haiku", "run-1", f);
  assert.deepEqual([r.candidates, r.added], [3, 1]);
  assert.equal(r.skipped.length, 2, "天气和坐标那两条认不出键 (测试的名单里没有木箱)");
  assert.deepEqual(readLearned(f)[0].who, "claude-haiku");
  assert.deepEqual(collectNotesLessons(notes, zh, "x", "run-2", f).added, 0);
});
