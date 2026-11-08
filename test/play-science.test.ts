// 监工的科研读数说法 (src/play/science.ts; 数字取自 2026-11-03 第十三轮接续第 3 班)
import test from "node:test";
import assert from "node:assert/strict";
import { labLine, ratesFrom, ratesLine } from "../src/play/science.ts";

const ZH: Record<string, string> = { "electric-engine": "电动机", "automation-science-pack": "机自科技包（红瓶）", "logistic-science-pack": "物流科技包（绿瓶）", "chemical-science-pack": "化工科技包（蓝瓶）" };
const zh = (n: string) => ZH[n] ?? n;

test("研究中心停了: 说要哪几种瓶、各剩多少、缺哪种 (用户截图: 红 2 绿 20 蓝 0)", () => {
  const s = labLine("electric-engine", ["automation-science-pack", "logistic-science-pack", "chemical-science-pack"], { "automation-science-pack": 2, "logistic-science-pack": 20 }, zh);
  assert.equal(s, "当前研究 电动机 要 机自科技包（红瓶） + 物流科技包（绿瓶） + 化工科技包（蓝瓶）; 研究中心里: 机自科技包（红瓶） 2 个、物流科技包（绿瓶） 20 个、化工科技包（蓝瓶） 0 个, 缺 化工科技包（蓝瓶）。");
  assert.match(labLine("", [], {}), /没有在研究的科技/);
});

test("每分钟产量: 平均、和上一班比", () => {
  const rows = [{ tick: 0, redTotal: 0, greenTotal: 0, blueTotal: 0 }, { tick: 36000, redTotal: 77, greenTotal: 41, blueTotal: 44 }];
  assert.deepEqual(ratesFrom(rows), { red: 7.7, green: 4.1, blue: 4.4 });
  assert.equal(ratesFrom([{ tick: 0 }, { tick: 3600 }]), null); // 不到 5 游戏分钟
  assert.equal(ratesFrom([{ tick: 0, redTotal: 1 }, { tick: 36000, redTotal: 11 }])!.blue, null); // 旧采样没有蓝瓶
  const line = ratesLine({ red: 7.7, green: 4.1, blue: 4.4 }, { red: 12.9, green: 16.2, blue: null });
  assert.equal(line, "近 10 分钟科技包每分钟: 红瓶 7.7、绿瓶 4.1、蓝瓶 4.4; 上一班平均: 红瓶 12.9、绿瓶 16.2、蓝瓶 — (红瓶、绿瓶比上一班低, 没达到硬指标)");
  assert.equal(ratesLine({ red: 20, green: 20, blue: 5 }, null), "近 10 分钟科技包每分钟: 红瓶 20.0、绿瓶 20.0、蓝瓶 5.0");
});
