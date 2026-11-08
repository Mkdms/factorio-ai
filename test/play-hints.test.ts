// 要点提示 (src/play/hints.ts): 按情况从 brief-points.md 挑要点、附蓝图候选
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HINTS, hintLine, hintsForLines, pointsByTags } from "../src/play/hints.ts";

const REAL = fs.readFileSync(path.join(import.meta.dirname, "..", "training", "knowledge", "verified", "points.md"), "utf8"); // 第二版 knowledge/brief-points.md
const MD = ["# 要点", "", "## 推进", "- 先找最卡的那一个 (P-mind-01)", "- 验收看持续产量 (P-prod-04)", "", "## 物流", "- 燃料不手补: 煤带 + 机械臂 (P-ops-fuel)", "- 供电别心算 (P-ops-power)", "不是要点的一行 (P-mind-01)"].join("\n");

test("pointsByTags: 只取带标签的要点行, 去掉 '- ', 不重复", () => {
  assert.deepEqual(pointsByTags(MD, ["P-mind-01", "P-ops-fuel"]), ["先找最卡的那一个 (P-mind-01)", "燃料不手补: 煤带 + 机械臂 (P-ops-fuel)"]);
  assert.deepEqual(pointsByTags(MD, ["没有的标签"]), []);
});

test("hintsForLines: 研究中心停 → 推进要点; 缺燃料 → 燃料要点; 加炉子 → 蓝图候选; 没对上就空", () => {
  assert.deepEqual(hintsForLines(MD, ["研究中心 11 台只有 2 台在工作"]), ["先找最卡的那一个 (P-mind-01)"]);
  assert.deepEqual(hintsForLines(MD, ["缺燃料 6 台: 石炉 (-12,-62)"]), ["燃料不手补: 煤带 + 机械臂 (P-ops-fuel)"]);
  const bp = (kw: string) => (kw === "furnace" ? ["1. [生成] 冶炼列 12 炉 | 14x13 | 实测出 36.0/分", "2. [生成] 冶炼列 24 炉"] : []);
  const h = hintsForLines(MD, ["加炉子: 12 → 20 台"], { bp });
  assert.equal(h.length, 1);
  assert.match(h[0], /^蓝图库里有实测过的块 \(\.\/bp list furnace .*: 1\. \[生成\] 冶炼列 12 炉 .* \/ 2\. \[生成\] 冶炼列 24 炉$/);
  assert.deepEqual(hintsForLines(MD, ["一切正常"]), []);
  assert.equal(hintsForLines(MD, ["研究中心停了", "采矿机采空 3 台", "产量没达标"], { max: 1 }).length, 1, "上限");
});

test("hintLine: 一句话版, 没对上就空串", () => {
  assert.equal(hintLine(MD, ["没事"]), "");
  assert.match(hintLine(MD, ["你的角色已经闲了约 3 分钟"]), /^要点 \(我们核实过的经验.*先找最卡的那一个/);
});

test("每条提示规则的标签在仓库的 brief-points.md 里都能挑到至少一条要点", () => {
  for (const h of HINTS) assert.ok(pointsByTags(REAL, h.tags).length >= 1, `${h.title}: 标签 ${h.tags.join(" / ")} 在 brief-points.md 里挑不到要点`);
});
