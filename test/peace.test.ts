// 开班和平 (src/play/peace.ts) + 群字段 + 简报和开班扫描怎么写 + 窗口只看 (src/play/observer.ts) 的纯逻辑; 真游戏里的读数见 docs/brain-run.md
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginPeace, makePeace, minutesLeft, peaceActive, peaceLeftMs, peaceText, peaceTick } from "../src/play/peace.ts";
import { createGroup, readGroup, setPeacefulMinutes } from "../src/play/groups.ts";
import { oursBrief } from "../src/play/ours-brief.ts";
import { handoverText, normalizeHandover, OBSERVER_LUA } from "../src/play/observer.ts";

const MIN = 60_000;

test("和平: 大脑开始前钟不走, 开始后到点只关一次, 快到了提醒一次", () => {
  const p = makePeace(10);
  assert.equal(peaceActive(p), true);
  assert.equal(peaceLeftMs(p, 5 * MIN), 10 * MIN, "钟没走");
  assert.equal(peaceTick(p, 5 * MIN), null, "没开始不到点");
  beginPeace(p, 0);
  beginPeace(p, 3 * MIN);
  assert.equal(peaceLeftMs(p, 3 * MIN), 7 * MIN, "只走一次");
  assert.equal(peaceTick(p, 3 * MIN), null);
  assert.equal(peaceTick(p, 8 * MIN), "warn");
  assert.equal(peaceTick(p, 8.5 * MIN), null, "只提醒一次");
  assert.equal(peaceTick(p, 10 * MIN), "end");
  assert.equal(peaceActive(p), false);
  assert.equal(peaceTick(p, 11 * MIN), null, "只关一次");
  assert.equal(peaceLeftMs(p, 11 * MIN), 0);
});

test("和平: 0 分钟 = 没有这一段; 不超过 2 分钟的不提醒; 没用完的向上取整留给下一班", () => {
  assert.equal(peaceActive(makePeace(0)), false);
  assert.equal(peaceActive(makePeace(Number.NaN)), false);
  const short = makePeace(2); beginPeace(short, 0);
  assert.equal(peaceTick(short, MIN), null);
  assert.equal(peaceTick(short, 2 * MIN), "end");
  assert.equal(minutesLeft(30_000), 1);
  assert.equal(minutesLeft(5 * MIN), 5);
  assert.equal(minutesLeft(0), 0);
  assert.equal(makePeace(999).minutes, 120);
});

test("和平: 告诉全队的话只讲事实和读数", () => {
  const e = { nests: 2, nearest: 100, x: -76, y: -174, turrets: 1 };
  assert.equal(peaceText("warn", 90_000, e), "和平模式还有 2 分钟自动关, 之后虫子会按污染来打。 现在炮塔 1 座, 虫巢 2 个, 最近 100 格 (-76,-174)。");
  assert.equal(peaceText("end", 0, { ...e, nests: 0 }), "和平模式刚关了, 虫子从现在起会按污染来打。 现在炮塔 1 座, 虫巢 0 个。");
  assert.equal(peaceText("end", 0), "和平模式刚关了, 虫子从现在起会按污染来打。");
});

test("群文件: peacefulMinutes 只在有虫子时算; 用完清掉, 没用完记剩下的", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "peace-"));
  try {
    const g = createGroup(play, { name: "t", kind: "new" });
    const f = path.join(play, "groups", `${g.id}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...g, peaceful: false, peacefulMinutes: 10 }));
    assert.equal(readGroup(play, g.id)?.peacefulMinutes, 10);
    assert.equal(setPeacefulMinutes(play, g.id, 3.2)?.peacefulMinutes, 4);
    assert.equal(readGroup(play, g.id)?.peaceful, false, "别的字段不丢");
    assert.equal(setPeacefulMinutes(play, g.id, 0)?.peacefulMinutes, undefined);
    assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).peacefulMinutes, undefined, "文件里也没了");
    fs.writeFileSync(f, JSON.stringify({ ...g, peacefulMinutes: 10 }));
    assert.equal(readGroup(play, g.id)?.peacefulMinutes, undefined, "开着和平的世界这个字段没意义");
    assert.equal(setPeacefulMinutes(play, "g-nothere00", 5), null);
  } finally { fs.rmSync(play, { recursive: true, force: true }); }
});

test("简报: 有虫子时写清和平还剩多久; 写明真人是谁、没有身体", () => {
  const base = { resume: true, multi: true, peaceful: false };
  assert.match(oursBrief({ ...base, peaceMinutes: 10 }), /这一班开始后 10 分钟自动关/);
  assert.doesNotMatch(oursBrief({ ...base, peaceMinutes: 0 }), /自动关/);
  assert.doesNotMatch(oursBrief({ ...base, peaceful: true, peaceMinutes: 0 }), /自动关/);
  assert.match(oursBrief({ ...base, human: "管理员" }), /用户在游戏里叫 `管理员`, 只看和说话, 没有身体/);
  assert.doesNotMatch(oursBrief(base), /\*\*真人\*\*/);
});

test("窗口只看: 回复解析和说明", () => {
  assert.deepEqual(normalizeHandover(null), { bodies: 0, watching: 0, moved: 0, left: 0, chests: [], names: [] });
  const h = normalizeHandover(JSON.stringify({ bodies: 2, watching: 1, moved: 268, left: 0, chests: {}, names: ["管理员"] }));
  assert.deepEqual(h.chests, [], "Lua 空表回来是 {}");
  assert.equal(handoverText(h, "Claude-Opus-5.5"), "窗口 管理员 只看, 没有身体; 收了 2 个身体, 物品 268 个 交给 Claude-Opus-5.5");
  assert.equal(handoverText({ ...h, bodies: 0 }, "x"), "窗口 管理员 只看, 没有身体");
  assert.equal(handoverText({ ...h, names: [], bodies: 0 }, "x"), "窗口还没连上");
  assert.match(handoverText({ ...h, chests: [{ x: 1, y: 2 }], left: 3 }, "x"), /放不下的进钢箱 \(1, 2\), 还有 3 个放不下丢了/);
  assert.match(OBSERVER_LUA, /defines\.controllers\.spectator/);
});
