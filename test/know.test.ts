// ./know 查全部积累、监工报研究中心和炉子、放机器算配比
import test from "node:test";
import assert from "node:assert/strict";
import { expandTerms, knowHint, knowLine, loadKnowledge, parseFacts, parsePatterns, parsePoints, parseResearch, parseSeeds, searchKnowledge, type KnowItem } from "../core/run/knowledge.ts"; // 第二版 src/play/know.ts 的库部分 (新项目 src/play/know.ts 只剩 ./know 命令的转接)
import { labCapacity, labNote, normalizeLayout, stuckNote, type LabScan } from "../src/play/layout-lint.ts";
import { calcLine } from "../src/play/calc-brief.ts";
import { denyText, permit } from "../src/play/permit.ts";

const PAT = `### P-a-01 研究区一条带喂一排
- 情况: 中期
- 做法: 带子走中间, 两排研究中心直接取
- 为什么: 省机械臂
- 代价 / 不适用: 瓶种多了不够

### P-a-02 别的
- 做法: 铁板走主线
`;

test("解析: 思路按条、事实和资料按表行, 没编号的行不要", () => {
  const p = parsePatterns(PAT, "ref/pilot-x.md");
  assert.deepEqual(p.map((x) => x.id), ["P-a-01", "P-a-02"]);
  assert.match(p[0].text, /带子走中间/);
  assert.match(p[0].text, /为什么: 省机械臂/);
  assert.equal(p[0].where, "ref/pilot-x.md");
  const f = parseFacts("| 编号 | 说法 | 结果 | 实测 | 关联 | 版本 |\n|---|---|---|---|---|---|\n| a.b | 黄带每秒 15 个 | ✅ 已核实 | 60 秒 900 个 | p | 2.1 |\n", "ref/pilot-facts.md");
  assert.equal(f.length, 1);
  assert.equal(f[0].id, "a.b");
  assert.match(f[0].text, /已核实/);
  const r = parseResearch("| # | 提示 | 要点 |\n|---|---|---|\n| TT5 | 研究中心间转运 | 机械臂传 https://x.y/z 科技包 |\n| 不是编号 | a | b |\n", "ref/research/t.md");
  assert.deepEqual(r.map((x) => x.id), ["TT5"]);
  assert.doesNotMatch(r[0].text, /https/, "网址不占字数");
  assert.equal(parsePoints("# 标题\n- 比例从满带倒推 (P-prod-01)\n", "b")[0].id, "P-prod-01");
  assert.equal(parseSeeds(`{"lessons":[{"rule":"甲","source":"s"},{"rule":"甲","source":"s"},{"rule":"乙"}]}`, "教训库").length, 2, "同一句只留一条");
  assert.deepEqual(parseSeeds("坏的", "x"), []);
});

test("查: 官方名和内部名互查, 标题命中靠前, 多个词要尽量都中", () => {
  const names = new Map([["lab", "研究中心"], ["inserter", "电力机械臂"]]);
  assert.deepEqual(expandTerms("lab", names).map((t) => t.term).sort(), ["lab", "研究中心"].sort());
  assert.ok(expandTerms("机械臂", names).some((t) => t.term === "inserter"));
  const items: KnowItem[] = [
    ...parsePatterns(PAT, "ref/pattern-x.md"), // 新项目角色目录里思路叫 pattern-*.md (第二版 pilot-*.md; 装模组那条路两套都拷)
    { id: "x", source: "资料", where: "ref/research/a.md", title: "别的东西", text: "顺带提到研究中心" },
    { id: "y", source: "事实", where: "ref/pilot-facts.md", title: "地下管道方向", text: "开口朝外" },
  ];
  assert.equal(searchKnowledge(items, "lab", names)[0].id, "P-a-01", "内部名查到写着中文的");
  assert.equal(searchKnowledge(items, "研究中心", names)[0].id, "P-a-01", "标题命中排在只提到的前面");
  assert.equal(searchKnowledge(items, "地下管道 方向", names)[0].id, "y");
  assert.deepEqual(searchKnowledge(items, "完全不存在的词", names), []);
  const line = knowLine(items[0]);
  assert.match(line, /全文: \.\/fh help pattern-x P-a-01/);
  assert.ok(knowLine({ ...items[0], text: "长".repeat(900) }, 100).length < 260);
});

test("真实知识库: 五类都读得到, 放机器附的经验不带资料", () => {
  const all = loadKnowledge();
  assert.ok(all.length > 800, `只有 ${all.length} 条`);
  for (const s of ["思路", "事实", "要点", "教训", "资料"]) assert.ok(all.some((x) => x.source === s), s);
  const names = new Map([["lab", "研究中心"]]);
  const hint = knowHint("研究中心", names);
  assert.equal(hint.length, 2);
  assert.ok(hint.every((h) => !h.startsWith("[资料")));
  assert.ok(searchKnowledge(all, "研究中心 串联", names, 6).some((x) => /串联/.test(x.text)), "这班学到的要查得到");
});

const labs = (o: Partial<LabScan>): LabScan => ({ total: 8, working: 8, unit: 30, speed: 0, research: "oil-gathering", packs: [{ name: "automation-science-pack", machines: 6, blocked: 0, rate: 15 }, { name: "logistic-science-pack", machines: 6, blocked: 0, rate: 6.7 }], ...o });

test("研究中心和瓶子谁卡谁: 看最少的瓶; 每种瓶都堵着才说研究中心不够", () => {
  assert.equal(labCapacity(labs({})), 16);
  assert.equal(labCapacity(labs({ unit: 15, total: 3 })), 12);
  assert.equal(labCapacity(labs({ speed: 0.5 })), 24, "研究速度加成算进去");
  assert.equal(labNote(labs({ research: "" })), null);
  assert.equal(labNote(labs({ total: 0 })), null);
  const low = labNote(labs({ working: 5 }), (x) => ({ "logistic-science-pack": "绿瓶" })[x] ?? x)!;
  assert.equal(low.key, "packs-short:logistic-science-pack");
  assert.match(low.text, /卡在 绿瓶/);
  assert.match(low.text, /再加研究中心没用/);
  assert.equal(labNote(labs({})), null, "全在转、瓶子没堵: 不说");
  // 2026-11-05 的错: 绿瓶高峰 26.5、红瓶堵着, 只看最多的那种就喊研究中心不够
  const oneBlocked = labs({ total: 3, unit: 15, packs: [{ name: "automation-science-pack", machines: 6, blocked: 6, rate: 9.6 }, { name: "logistic-science-pack", machines: 6, blocked: 0, rate: 26.5 }] });
  assert.equal(labNote(oneBlocked), null, "只有一种堵着不算");
  const both = labNote(labs({ packs: [{ name: "a", machines: 6, blocked: 3, rate: 20 }, { name: "b", machines: 4, blocked: 4, rate: 20 }] }))!;
  assert.equal(both.key, "labs-short:8");
  assert.match(both.text, /研究中心是瓶颈/);
  assert.match(both.text, /\.\/know 研究中心/);
});

test("炉子积着板没人取: 只报事实和坐标; 读数缺字段不崩", () => {
  assert.equal(stuckNote([]), null);
  assert.match(stuckNote([{ x: -38, y: -40, out: 50 }])!, /1 台炉子积着板.*\(-38,-40\) 50 个/);
  assert.match(stuckNote(Array.from({ length: 6 }, (_, i) => ({ x: i, y: 0, out: 20 })))!, /6 台.*等/);
  const n = normalizeLayout({ poles: 1, stuck: [{ x: 1, y: 2, out: 30 }, { y: 2 }], labs: { total: 2, packs: {} } });
  assert.equal(n.stuck.length, 1);
  assert.equal(n.labs.total, 2);
  assert.deepEqual(n.labs.packs, []);
  assert.deepEqual(normalizeLayout(null).stuck, []);
});

test("放机器附的配比: 台数向上取整, 机器多的在前, 说清楚不算场上已有的", () => {
  const res = { rows: [{ recipe: "iron-plate", machine: "stone-furnace", machines: 3.2, perMachine: 18.75 }, { recipe: "iron-gear-wheel", machine: "assembling-machine-2", machines: 0.33, perMachine: 90 }], imports: { "iron-ore": 60, coal: 0 }, powerW: 60000 } as never;
  const t = calcLine("iron-gear-wheel", 30, res, (id) => ({ "iron-plate": "铁板", "iron-gear-wheel": "铁齿轮" })[id]);
  assert.match(t, /铁板 4 台.*铁齿轮 1 台/);
  assert.match(t, /不算场上已有的/);
  assert.match(t, /从外面进 iron-ore 60/);
  assert.doesNotMatch(t, /coal/);
});

test("./know 放行, 和别的命令一样", () => {
  assert.ok(permit("./know 研究中心"));
  assert.ok(permit("./know 地下管道 方向 | head -5"));
  assert.equal(denyText("./know 研究中心"), null);
});
