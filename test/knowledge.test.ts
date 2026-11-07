// 查全部积累 (core/run/knowledge.ts、commands/know.ts): 解析、打分、真实训练集; 不开游戏
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandTerms, knowHint, knowLine, loadKnowledge, parseFacts, parsePatterns, parsePoints, parseResearch, parseSeeds, searchKnowledge, type KnowItem } from "../core/run/knowledge.ts";
import { nextCommands } from "../commands/know.ts";
import { trainingRoot } from "../core/run/training.ts";

const PAT = `### P-a-01 研究区一条带喂一排
- 情况: 中期
- 做法: 带子走中间, 两排研究中心直接取
- 为什么: 省机械臂
- 代价 / 不适用: 瓶种多了不够

### P-a-02 别的
- 做法: 铁板走主线
`;

test("解析: 思路按条、事实和资料按表行, 没编号的行不要", () => {
  const p = parsePatterns(PAT, "ref/pattern-x.md");
  assert.deepEqual(p.map((x) => x.id), ["P-a-01", "P-a-02"]);
  assert.match(p[0].text, /带子走中间/);
  assert.match(p[0].text, /为什么: 省机械臂/);
  const f = parseFacts("| 编号 | 说法 | 结果 | 实测 | 关联 | 版本 |\n|---|---|---|---|---|---|\n| a.b | 黄带每秒 15 个 | ✅ 已核实 | 60 秒 900 个 | p | 2.1 |\n", "ref/facts.md");
  assert.equal(f.length, 1);
  assert.equal(f[0].id, "a.b");
  const r = parseResearch("| # | 提示 | 要点 |\n|---|---|---|\n| TT5 | 研究中心间转运 | 机械臂传 https://x.y/z 科技包 |\n| 不是编号 | a | b |\n", "资料 t.md");
  assert.deepEqual(r.map((x) => x.id), ["TT5"]);
  assert.doesNotMatch(r[0].text, /https/, "网址不占字数");
  assert.equal(parsePoints("# 标题\n- 比例从满带倒推 (P-prod-01)\n", "b")[0].id, "P-prod-01");
  assert.equal(parseSeeds(`{"lessons":[{"rule":"甲","source":"s"},{"rule":"甲","source":"s"},{"rule":"乙"}]}`, "教训库").length, 2, "同一句只留一条");
  assert.deepEqual(parseSeeds("坏的", "x"), []);
});

test("查: 官方名和内部名互查, 标题命中靠前, 多个词要尽量都中; 思路给全文的查法", () => {
  const names = new Map([["lab", "研究中心"], ["inserter", "电力机械臂"]]);
  assert.deepEqual(expandTerms("lab", names).map((t) => t.term).sort(), ["lab", "研究中心"].sort());
  assert.ok(expandTerms("机械臂", names).some((t) => t.term === "inserter"));
  const items: KnowItem[] = [
    ...parsePatterns(PAT, "ref/pattern-x.md"),
    { id: "x", source: "资料", where: "资料 a.md", title: "别的东西", text: "顺带提到研究中心" },
    { id: "y", source: "事实", where: "ref/facts.md", title: "地下管道方向", text: "开口朝外" },
  ];
  assert.equal(searchKnowledge(items, "lab", names)[0].id, "P-a-01", "内部名查到写着中文的");
  assert.equal(searchKnowledge(items, "研究中心", names)[0].id, "P-a-01", "标题命中排在只提到的前面");
  assert.equal(searchKnowledge(items, "地下管道 方向", names)[0].id, "y");
  assert.deepEqual(searchKnowledge(items, "完全不存在的词", names), []);
  assert.match(knowLine(items[0]), /全文: \.\/fh help pattern-x P-a-01/);
  assert.ok(knowLine({ ...items[0], text: "长".repeat(900) }, 100).length < 260);
  assert.deepEqual(nextCommands("build 研究中心"), ["./fh help build"]);
});

test("真实训练集: 五类都读得到 (> 800 条), 自动附的经验不带资料, 查得到实测过的说法", () => {
  const all = loadKnowledge();
  assert.ok(all.length > 800, `只有 ${all.length} 条`);
  for (const s of ["思路", "事实", "要点", "教训", "资料"]) assert.ok(all.some((x) => x.source === s), s);
  const names = new Map([["lab", "研究中心"]]);
  const hint = knowHint("研究中心", names, 2, 180, false, all);
  assert.equal(hint.length, 2);
  assert.ok(hint.every((h) => !h.startsWith("[资料")));
  assert.ok(searchKnowledge(all, "研究中心 串联", names, 6).some((x) => /串联/.test(x.text)));
  const pub = loadKnowledge([trainingRoot()]);
  assert.ok(pub.every((x) => !/朋友/.test(x.text) && !/朋友/.test(x.title)), "公开训练集里不写朋友");
  assert.ok(pub.filter((x) => x.source === "思路").every((x) => x.where.startsWith("ref/pattern-")), "正式区的思路在 ref/ 里有全文");
});
