// 大脑说英文的判断和提醒节奏 (src/play/lang.ts; 句子取自 2026-11-03 第十三轮接续第 1 班的日志)
import test from "node:test";
import assert from "node:assert/strict";
import { isEnglish, EnglishWatch } from "../src/play/lang.ts";

test("整句英文算英文", () => {
  for (const s of ["Now furnaces, inserters, poles and chest.", "Loops aren't allowed; I'll chain them with && instead.", "Need to walk there first.", "Gap tile (53.5,-1.5) — add a pipe there, and link power.", "Meanwhile walk to the copper patch and take a picture."])
    assert.equal(isEnglish(s), true, s);
});

test("中文句子 (夹着内部名、坐标、命令) 不算英文", () => {
  for (const s of ["MK 上线。这班我做铜矿第一条传送带冶炼列", "先放 transport-belt 到 (53.5,-1.5), 再接电", "用 `./fh call craft --args '{\"recipe\":\"iron-gear-wheel\"}'` 手搓齿轮", "好", "OK", "完成: 铜板 200 → chest"])
    assert.equal(isEnglish(s), false, s);
});

test("5 分钟内 3 句英文提醒一次, 提醒后 5 分钟内不再提醒; 计数", () => {
  const w = new EnglishWatch();
  const en = "Now furnaces, inserters, poles and chest.";
  assert.equal(w.note(en, 0), false);
  assert.equal(w.note("中文的一句话", 1000), false);
  assert.equal(w.note(en, 2000), false);
  assert.equal(w.note(en, 3000), true); // 第 3 句英文
  assert.equal(w.note(en, 4000), false);
  assert.equal(w.note(en, 5000), false);
  assert.equal(w.note(en, 6000), false); // 又 3 句, 但离上次提醒不到 5 分钟
  assert.equal(w.note(en, 400_000), false); // 5 分钟窗口外, 只剩这一句
  assert.deepEqual([w.total, w.english], [8, 7]);
  const slow = new EnglishWatch();
  assert.equal(slow.note(en, 0) || slow.note(en, 200_000) || slow.note(en, 400_000), false); // 隔得太开, 不提醒
});
