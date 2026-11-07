// 手册按段查 (commands/ref-sections.ts; 不开游戏)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { manualAnswer, sectionText, splitSections, tocText } from "../commands/ref-sections.ts";

const long = (c: string, n = 400) => c.repeat(n);
const MD = `# 主题\n开头一段 ${long("甲")}\n## 第一章\n${long("乙")}\n### P-prod-01 比例从满载带倒推\n${long("丙")}\n### P-prod-02 另一条\n短\n## 第二章\n${long("丁", 12000)}\n`;

test("切段: ## 和 ### 都算, 没到 300 字的短段留着自己的标题", () => {
  const s = splitSections(MD);
  assert.deepEqual(s.map((x) => x.title), ["开头", "第一章", "P-prod-01 比例从满载带倒推", "P-prod-02 另一条", "第二章"]);
  assert.equal(s[2].line, 5);
});

test("目录和一段: 序号或关键词; 太长的段说明怎么接着看", () => {
  const toc = tocText("pattern-x", MD);
  for (const w of ["./fh help pattern-x 序号", "./know", "3. P-prod-01 比例从满载带倒推"]) assert.ok(toc.includes(w), w);
  assert.match(sectionText("pattern-x", MD, "3")!, /第 3\/5 段 \(下一段: \.\/fh help pattern-x 4\)[\s\S]*丙/);
  assert.match(sectionText("pattern-x", MD, "p-prod-02")!, /第 4\/5 段/);
  assert.equal(sectionText("pattern-x", MD, "没有这个"), null);
  assert.match(sectionText("pattern-x", MD, "5", 9000)!, /后面还有 3\d+ 字; 用 Read ref\/pattern-x\.md offset=/);
});

test("./fh help 主题: 够小交给命令行, 太大回目录; 不是手册文件也交给它; 主题名只认普通字符", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ref-"));
  fs.writeFileSync(path.join(d, "big.md"), MD);
  fs.writeFileSync(path.join(d, "small.md"), "## 小\n短\n");
  assert.equal(manualAnswer(d, "small", undefined, 9000), null);
  assert.match(manualAnswer(d, "big", undefined, 9000)!, /整份读太占上下文/);
  assert.equal(manualAnswer(d, "big", undefined, 0), null, "FH_MAX_OUTPUT=0 我们自己要整段时不拦");
  assert.equal(manualAnswer(d, "belt_route", undefined, 9000), null);
  assert.match(manualAnswer(d, "big", "没有", 9000)!, /没有 "没有" 这一段[\s\S]*序号/);
  assert.equal(manualAnswer(d, "../secret", undefined, 9000), null);
  fs.rmSync(d, { recursive: true });
});
