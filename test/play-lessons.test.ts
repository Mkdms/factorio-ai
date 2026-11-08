// 教训库 (src/play/lessons.ts): 种子文件合规、登记计划 (已有的复核)、笔记里的教训解析和键推断、合并计划去重
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { bytes, describeActions, fitBytes, inferKeys, keyFallbacks, loadSeeds, mergeNotesLessons, mergePlan, nameIndex, parseNotesLessons, RULE_BYTES, seedLessons, seedPlan, validateSeed, type Reply } from "../src/play/lessons.ts";

const SEED_FILE = path.join(import.meta.dirname, "..", "training", "lessons", "verified", "seed.json"); // 第二版 knowledge/lessons-seed.json
const zh = new Map([["iron-plate", "铁板"], ["stone-furnace", "石炉"], ["iron-gear-wheel", "铁齿轮"], ["coal", "煤"], ["transport-belt", "传送带"], ["boiler", "锅炉"], ["crude-oil", "原油"]]);
const idx = nameIndex(zh, ["build", "transfer", "craft", "feed", "refuel", "order_set", "status", "inspect", "trace", "bottleneck"]);

test("种子文件: 每条 rule ≤160 字节、键是内部名、不重复, 至少 25 条", () => {
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

test("validateSeed 拒绝: 超长、没键、键不是内部名、impact 越界", () => {
  assert.throws(() => validateSeed({ rule: "中".repeat(60), keys: { action: "build" } }), /超过 160 字节/);
  assert.throws(() => validateSeed({ rule: "x", keys: {} }), /至少一个键/);
  assert.throws(() => validateSeed({ rule: "x", keys: { entity: "Stone Furnace" } }), /内部名/);
  assert.throws(() => validateSeed({ rule: "x", keys: { action: "build" }, impact: 7 }), /impact/);
  assert.equal(validateSeed({ rule: " 好 ", keys: { action: "build" }, impact: 2 }).rule, "好");
});

test("fitBytes: 短的原样 (压成一行), 长的截到 ≤160 字节并加 …", () => {
  assert.equal(fitBytes("a  b\nc"), "a b c");
  const long = fitBytes("中文教训, ".repeat(30));
  assert.ok(bytes(long) <= RULE_BYTES && long.endsWith("…"), long);
});

test("seedPlan: 文字和键都一样的复核, 键不同的新加", () => {
  const seeds = [{ rule: "A", keys: { action: "build", entity: "stone-furnace" } }, { rule: "A", keys: { action: "build", entity: "steel-furnace" } }, { rule: "B", keys: { action: "mine" } }];
  const plan = seedPlan(seeds, [{ id: 3, rule: "A ", keys: { action: "build", entity: "stone-furnace" } }, { id: 4, rule: "C", keys: { action: "mine" } }]);
  assert.deepEqual(plan.verify.map((v) => v.id), [3]);
  assert.deepEqual(plan.add.map((a) => a.keys), [{ action: "build", entity: "steel-furnace" }, { action: "mine" }]);
});

test("parseNotesLessons: 只取 Lessons / 教训 一节, 去掉列表符号, 跳过占位", () => {
  const md = "## Now\n- 做事\n\n## Lessons\n- 铁板要走带子\n* **transfer** 往石炉放煤前先看背包\n1. (none)\n\n## Log\n- 不是教训\n";
  assert.deepEqual(parseNotesLessons(md), ["铁板要走带子", "transfer 往石炉放煤前先看背包"]);
  assert.deepEqual(parseNotesLessons("## 教训\n- 无\n- 手搓铁齿轮太慢\n"), ["手搓铁齿轮太慢"]);
  assert.deepEqual(parseNotesLessons("没有这一节"), []);
});

test("inferKeys: 动作名 + 内部名 / 官方中文名; 手搓当配方; 认不出就 null", () => {
  assert.deepEqual(inferKeys("./fh call transfer 往石炉放煤前先看背包", idx), { action: "transfer", item: "stone-furnace" });
  assert.deepEqual(inferKeys("铁板要走带子, 别手搬", idx), { item: "iron-plate" });
  assert.deepEqual(inferKeys("手搓铁齿轮太慢, 用机器", idx), { recipe: "iron-gear-wheel" });
  assert.deepEqual(inferKeys("build 时 stone-furnace 要先清树", idx), { action: "build", item: "stone-furnace" });
  assert.deepEqual(inferKeys("用 ./fh call status 看就行", idx), null, "只读动作不当键");
  assert.equal(inferKeys("今天天气不错", idx), null);
});

test("keyFallbacks: 配方 → 物品 → 实体 → 只留动作", () => {
  assert.deepEqual(keyFallbacks({ action: "craft", recipe: "x" }), [{ action: "craft", recipe: "x" }, { action: "craft", item: "x" }, { action: "craft", entity: "x" }, { action: "craft" }]);
  assert.deepEqual(keyFallbacks({ item: "x" }), [{ item: "x" }, { entity: "x" }]);
  assert.deepEqual(keyFallbacks({ action: "mine" }), [{ action: "mine" }]);
});

test("mergePlan: 去重 (同文字 / 同前 24 字)、截长、每人上限", () => {
  const lines = ["铁板要走带子, 别手搬", "铁板要走带子, 别手搬 (重复)", "锅炉要接煤带, 不然发电停; ".repeat(8), "没有键的一句话", "煤用 transfer 放进锅炉只兜底"];
  const plan = mergePlan(lines, [{ id: 1, rule: "铁板要走带子, 别手搬" }], idx, 2);
  assert.deepEqual(plan.add.map((a) => a.keys), [{ item: "boiler" }, { action: "transfer", item: "boiler" }], "单字的 煤 不当名字, 锅炉 才是");
  assert.ok(bytes(plan.add[0].rule) <= RULE_BYTES && plan.add[0].rule.endsWith("…"));
  assert.deepEqual(plan.skipped.map((s) => s.why), ["库里已有", "库里已有", "认不出键 (没提到动作名或物品 / 建筑的官方名)"]);
  const capped = mergePlan(["铁板 a", "锅炉 b", "传送带 c"], [], idx, 2);
  assert.equal(capped.add.length, 2);
  assert.match(capped.skipped[0].why, /最多 2 条/);
});

test("describeActions: 一行一个动作的 describe.json; 太少就用内置清单", () => {
  const json = "{\n  \"protocol\": 1\n}\n" + ["build", "craft", "mine", "transfer", "feed", "refuel", "research", "inspect", "trace", "bottleneck", "order_set"].map((n) => `{"name":"${n}","args":{}}`).join("\n");
  assert.deepEqual(describeActions(json).slice(0, 3), ["build", "craft", "mine"]);
  assert.ok(describeActions("").includes("build"));
  assert.ok(describeActions(null).length > 10);
});

/** 假的教训库: 记下每次调用, lessons 回已有的, lesson_add 按 keys 决定成败 */
function fakeBook(existing: { id: number; rule: string; keys: Record<string, string> }[], reject: (args: Record<string, unknown>) => string | null = () => null) {
  const calls: { action: string; args: Record<string, unknown> }[] = [];
  let next = 100;
  const call = async (action: string, args: Record<string, unknown>): Promise<Reply> => {
    calls.push({ action, args });
    if (action === "lessons") return { ok: true, result: { lessons: existing } };
    if (action === "lesson_verify") return { ok: true };
    if (action === "lesson_add") { const why = reject(args); if (why) return { ok: false, error: { message: why } }; existing.push({ id: next++, rule: String(args.rule), keys: {} }); return { ok: true }; }
    return { ok: false, error: { message: "unknown" } };
  };
  return { call, calls };
}

test("seedLessons: 已有的复核, 其余登记, 拒绝的记进 failed", async () => {
  const seeds = [{ rule: "A", keys: { action: "build", entity: "stone-furnace" }, impact: 3 }, { rule: "B", keys: { action: "mine" } }, { rule: "C", keys: { action: "build", entity: "no-such" } }];
  const book = fakeBook([{ id: 7, rule: "A", keys: { action: "build", entity: "stone-furnace" } }], (a) => (a.entity === "no-such" ? "entity must be an entity name" : null));
  const r = await seedLessons(book.call, seeds);
  assert.deepEqual([r.added, r.verified, r.total], [1, 1, 2]);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0], /entity name/);
  assert.deepEqual(book.calls.map((c) => c.action), ["lessons", "lesson_verify", "lesson_add", "lesson_add"]);
  assert.deepEqual(book.calls[2].args, { rule: "B", action: "mine" });
});

test("库满了: 种子优先, 退掉不是种子的 (带坐标的先退, 再退旧的), 退完再加; 没得退才记失败", async () => {
  const calls: { action: string; args: Record<string, unknown> }[] = [];
  let full = true;
  const rows = [{ id: 5, rule: "旧的一条", keys: { action: "mine" } }, { id: 9, rule: "(61,-60) 落点不是箱", keys: { action: "build" } }, { id: 2, rule: "种子 S", keys: { action: "craft" }, status: "open" }];
  const call = async (action: string, args: Record<string, unknown> = {}) => {
    calls.push({ action, args });
    if (action === "lessons") return { ok: true, result: { lessons: rows } };
    if (action === "lesson_add" && full) return { ok: false, error: { message: "the board holds at most 150 lessons: retire one" } };
    if (action === "lesson_edit") { full = false; return { ok: true }; }
    return { ok: true };
  };
  const r = await seedLessons(call as never, [{ rule: "种子 S", keys: { action: "craft" } }, { rule: "新种子", keys: { action: "build" } }]);
  assert.equal(r.added, 1);
  assert.equal(r.dropped, 1);
  assert.deepEqual(calls.find((c) => c.action === "lesson_edit")?.args, { id: 9, status: "dropped" }, "先退带坐标的, 不退种子");
  assert.deepEqual(r.failed, []);
});

test("读全库去重: 库里已有的不会被当成新的再加一遍 (2026-11-06 开班 71 条失败就是只读了 64 条)", async () => {
  const calls: { action: string; args: Record<string, unknown> }[] = [];
  const rows = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, rule: `规则 ${i}`, keys: { action: "build" }, score: 5 }));
  const call = async (action: string, args: Record<string, unknown> = {}) => { calls.push({ action, args }); return action === "lessons" ? { ok: true, result: { lessons: rows.slice(0, Number(args.limit)) } } : { ok: true }; };
  const r = await seedLessons(call as never, [{ rule: "规则 149", keys: { action: "build" } }, { rule: "规则 100", keys: { action: "build" }, unverified: true }]);
  assert.equal(calls[0].args.limit, 256);
  assert.deepEqual([r.added, r.verified, r.failed.length, r.total], [0, 1, 0, 150], "已有的种子复核, 往届笔记不刷已核实");
  assert.equal(calls.filter((c) => c.action === "lesson_add").length, 0);
});

test("库满: 核实过的种子挤掉分最低的; 往届笔记不挤别的, 不算失败", async () => {
  const dropped: unknown[] = [];
  const added: unknown[] = [];
  const rows = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, rule: `规则 ${i}`, keys: { action: "build" }, score: i === 40 ? 2 : 9 }));
  const call = async (action: string, args: Record<string, unknown> = {}) => {
    if (action === "lessons") return { ok: true, result: { lessons: rows } };
    if (action === "lesson_edit") { dropped.push(args.id); return { ok: true }; }
    if (action === "lesson_add") { added.push(args.rule); return { ok: true }; }
    return { ok: true };
  };
  const r = await seedLessons(call as never, [{ rule: "往届", keys: { action: "mine" }, unverified: true }, { rule: "新种子", keys: { action: "craft" } }]);
  assert.deepEqual(dropped, [41], "退分最低的那条");
  assert.deepEqual(added, ["新种子"], "种子先进; 退一条进一条后还是满的, 往届笔记不进");
  assert.deepEqual([r.dropped, r.skippedFull, r.failed.length, r.total], [1, 1, 0, 150]);
});

test("mergeNotesLessons 库满: 只挤分不高于新教训的, 种子不退; 没得挤才跳过", async () => {
  const mk = (score: number) => Array.from({ length: 150 }, (_, i) => ({ id: i + 1, rule: i === 0 ? "种子规则" : `规则 ${i}`, keys: { action: "build" }, score: i === 0 ? 1 : score }));
  const run = async (rows: ReturnType<typeof mk>) => {
    const edits: unknown[] = [];
    const call = async (action: string, args: Record<string, unknown> = {}) => {
      if (action === "lessons") return { ok: true, result: { lessons: rows } };
      if (action === "lesson_edit") edits.push(args.id);
      return { ok: true };
    };
    return { r: await mergeNotesLessons(call as never, "## Lessons\n- 手搓铁齿轮太慢, 用机器\n", idx, 8, [{ rule: "种子规则", keys: { action: "build" } }]), edits };
  };
  const a = await run(mk(4));
  assert.deepEqual(a.edits, [2], "分 1 的是种子不退, 退第二低的");
  assert.deepEqual([a.r.added, a.r.retired], [1, 1]);
  const b = await run(mk(9));
  assert.deepEqual(b.edits, [], "别的都比新教训分高");
  assert.equal(b.r.added, 0);
  assert.match(b.r.skipped[0].why, /库满/);
});

test("mergeNotesLessons: 笔记里的教训以这个角色的身份记进去, 配方名不对就退到物品 / 实体", async () => {
  const notes = "## Lessons\n- 手搓铁齿轮太慢, 用机器\n- 原油 (crude-oil) 要有储液罐\n- 铁板要走带子\n";
  const book = fakeBook([{ id: 1, rule: "铁板要走带子", keys: { item: "iron-plate" } }], (a) => (a.item === "crude-oil" ? "item must be an item name" : null));
  const r = await mergeNotesLessons(book.call, notes, idx);
  assert.deepEqual([r.candidates, r.added], [3, 2]);
  assert.deepEqual(r.skipped.map((s) => s.why), ["库里已有"]);
  const adds = book.calls.filter((c) => c.action === "lesson_add").map((c) => c.args);
  assert.deepEqual(adds[0], { rule: "手搓铁齿轮太慢, 用机器", recipe: "iron-gear-wheel" });
  assert.deepEqual(adds.slice(1), [{ rule: "原油 (crude-oil) 要有储液罐", item: "crude-oil" }, { rule: "原油 (crude-oil) 要有储液罐", entity: "crude-oil" }]);
  assert.deepEqual(await mergeNotesLessons(book.call, "## Now\n- 没有教训节\n", idx), { candidates: 0, added: 0, skipped: [] });
});
