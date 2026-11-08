// 大脑说英文的判断和提醒节奏 (src/play/lang.ts; 句子取自 2026-11-03 第十三轮接续第 1 班的日志)
import test from "node:test";
import assert from "node:assert/strict";
import { isEnglish, hasEnglishSentence, EnglishWatch } from "../src/play/lang.ts";

test("整句英文算英文", () => {
  for (const s of ["Now furnaces, inserters, poles and chest.", "Loops aren't allowed; I'll chain them with && instead.", "Need to walk there first.", "Gap tile (53.5,-1.5) — add a pipe there, and link power.", "Meanwhile walk to the copper patch and take a picture."])
    assert.equal(isEnglish(s), true, s);
});

test("中文句子 (夹着内部名、坐标、命令) 不算英文", () => {
  for (const s of ["MK 上线。这班我做铜矿第一条传送带冶炼列", "先放 transport-belt 到 (53.5,-1.5), 再接电", "用 `./fh call craft --args '{\"recipe\":\"iron-gear-wheel\"}'` 手搓齿轮", "好", "OK", "完成: 铜板 200 → chest"])
    assert.equal(isEnglish(s), false, s);
});

test("中英混在一段里: 按句切开, 有整句英文就算 (2026-11-08 装模组连续班漏掉的那种)", () => {
  for (const s of ["先补煤。Now the refuel tour (the standing order's step with 105 coal in hand).", "这一轮补了料\nNext I'll walk to the copper patch."])
    assert.equal(hasEnglishSentence(s), true, s);
  for (const s of ["先放 transport-belt 到 (53.5,-1.5), 再接电。好。", "用 `Now walk there and build it.` 这句是代码里的", "OK"])
    assert.equal(hasEnglishSentence(s), false, s);
});

test("5 分钟内 2 段带英文就提醒, 隔 3 分钟; 提醒后不清零, 还说英文就再提醒; 计数", () => {
  const w = new EnglishWatch();
  const en = "Now furnaces, inserters, poles and chest.";
  assert.equal(w.note(en, 0), false);
  assert.equal(w.note("中文的一句话", 1000), false);
  assert.equal(w.note(en, 2000), true); // 第 2 段英文
  assert.equal(w.note(en, 3000), false); // 离上次提醒不到 3 分钟
  assert.equal(w.note(en, 100_000), false);
  assert.equal(w.note(en, 200_000), true); // 过了 3 分钟, 5 分钟窗口里还有英文 → 再提醒 (原来清零后要重新攒)
  assert.equal(w.note(en, 900_000), false); // 窗口外, 只剩这一段
  assert.deepEqual([w.total, w.english], [7, 6]);
  const slow = new EnglishWatch();
  assert.equal(slow.note(en, 0) || slow.note(en, 400_000) || slow.note(en, 800_000), false); // 隔得太开, 不提醒
});
