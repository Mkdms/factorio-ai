// 界面选模型玩用户的账号 (src/play/mk-lib.ts, groups.ts kind = mine); 真开局要用户的 Steam 版, 这里只测逻辑
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSteamClientLine, mkArgs, mkModelLines, mkRunning, mkStop, mkView, readMkCurrent, writeMkCurrent, type MkCurrent } from "../src/play/mk-lib.ts";
import { createGroup, readGroup, saveGroupSeats, setGroupGoal, startArgs } from "../src/play/groups.ts";
import { mkStatusLine } from "../app/src/logic.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mk-lib-"));
const cur = (play: string, over: Partial<MkCurrent> = {}): MkCurrent => ({ runId: "r1", runDir: path.join(play, "online", "r1"), pid: 123, startedAt: "x", brain: "claude-api", effort: "low", minutes: 90, ...over });

test("第 1 席 + 群的设置 → 启动参数; 每个群一张图; 强度默认 low; 目标文件可选", () => {
  const g = { id: "g-abc1", minutes: 90, seats: [{ brain: "claude-api", model: "claude-opus-5-5", effort: "high" }, { brain: "relay", model: "x" }] };
  assert.deepEqual(mkArgs(g, "goal.md"), ["--world", "g-abc1", "--brain", "claude-api", "--model", "claude-opus-5-5", "--effort", "high", "--minutes", "90", "--goal-file", "goal.md"]);
  assert.deepEqual(mkArgs({ ...g, seats: [{ brain: "none", model: "" }] }), ["--world", "g-abc1", "--brain", "none", "--effort", "low", "--minutes", "90"]);
  assert.throws(() => mkArgs({ ...g, seats: [] }), /没有选模型/);
});

test("在不在跑: 写了收工就不算, 进程没了也不算 (被强行结束时写不了收工)", () => {
  const play = tmp();
  assert.equal(mkRunning(null), false);
  assert.equal(mkRunning(cur(play), () => true), true);
  assert.equal(mkRunning(cur(play), () => false), false);
  assert.equal(mkRunning(cur(play, { ended: "t" }), () => true), false);
});

test("停: 往这一局的目录放 STOP; 收工了或没有局不写; 目录不在 play/online 下面不写", () => {
  const play = tmp();
  assert.equal(mkStop(play, "界面").ok, false, "没有局");
  writeMkCurrent(play, cur(play));
  assert.deepEqual(mkStop(play, "界面"), { ok: true, runId: "r1" });
  assert.equal(fs.readFileSync(path.join(play, "online", "r1", "STOP"), "utf8").trim(), "界面");
  mkStop(play, "第二次");
  assert.equal(fs.readFileSync(path.join(play, "online", "r1", "STOP"), "utf8").trim(), "界面", "留着最早的原因");
  writeMkCurrent(play, cur(play, { ended: "t" }));
  assert.equal(mkStop(play, "界面").ok, false, "收工了");
  writeMkCurrent(play, cur(play, { runDir: path.join(play, "elsewhere") }));
  const bad = mkStop(play, "界面");
  assert.equal(bad.ok, false);
  assert.equal(fs.existsSync(path.join(play, "elsewhere", "STOP")), false, "乱写的目录不碰");
});

test("模型说的话: 取最新的几句, 半行和工具调用跳过, 只读文件尾", () => {
  const play = tmp(), run = path.join(play, "online", "r1");
  fs.mkdirSync(run, { recursive: true });
  const say = (t: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  fs.writeFileSync(path.join(run, "turn-1.jsonl"), [say("第一轮"), say("第一轮之二")].join("\n"));
  fs.writeFileSync(path.join(run, "turn-10.jsonl"), [JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }), say("第十轮"), '{"type":"assistant","mess'].join("\n"));
  assert.deepEqual(mkModelLines(run, 2), ["第一轮之二", "第十轮"], "第 10 轮在第 1 轮后面, 不按文件名字母排");
  assert.deepEqual(mkModelLines(path.join(play, "没有"), 2), []);
});

test("状态: 没开过局; 在跑; 正在收尾", () => {
  const play = tmp();
  assert.equal(mkView(play).current, null);
  writeMkCurrent(play, cur(play));
  assert.equal(readMkCurrent(play)?.runId, "r1");
  assert.deepEqual([mkView(play, () => true).running, mkView(play, () => true).stopping], [true, false]);
  mkStop(play, "x");
  assert.equal(mkView(play, () => true).stopping, true);
});

test("Steam 版开着的判断: 只认这个程序本身的客户端, 它起的服务器和独立版都不算", () => {
  const exe = "I:/SteamLibrary/steamapps/common/Factorio/bin/x64/factorio.exe";
  const win = exe.replace(/\//g, "\\");
  assert.equal(isSteamClientLine(`${win}|"${win}" --mp-connect 127.0.0.1:1`, exe), true);
  assert.equal(isSteamClientLine(`${win.toUpperCase()}|x`, exe), true, "大小写不敏感");
  assert.equal(isSteamClientLine(`${win}|"${win}" --start-server m.zip`, exe), false);
  assert.equal(isSteamClientLine(`${win}|"${win}" --create m.zip`, exe), false);
  assert.equal(isSteamClientLine(`I:\\standalone\\bin\\x64\\factorio.exe|x`, exe), false);
});

test("界面这一行: 这个群在跑 / 收尾 / 别的群占着账号 / 结果 / 没跑完", () => {
  const c = { runId: "r", brain: "claude-api", model: "claude-opus-5-5", effort: "low", minutes: 90, startedAt: "x", group: "g-a" };
  const v = (over: object, running = false, stopping = false) => ({ current: { ...c, ...over }, running, stopping, lines: [] });
  assert.equal(mkStatusLine(null, "g-a"), null);
  assert.match(mkStatusLine(v({}, true), "g-a")!, /在跑.*claude-opus-5-5/);
  assert.match(mkStatusLine(v({}, true, true), "g-a")!, /正在收尾/);
  assert.match(mkStatusLine(v({}, true), "g-b")!, /别的群/);
  assert.equal(mkStatusLine(v({ ended: "t", result: { before: 6, after: 7, fresh: ["害虫防治"] } }), "g-b"), null, "别的群的结果不显示在这里");
  assert.match(mkStatusLine(v({ ended: "t", result: { before: 6, after: 7, fresh: ["害虫防治"] } }), "g-a")!, /6 → 7.*害虫防治/);
  assert.match(mkStatusLine(v({ ended: "t", result: { before: 7, after: 7, fresh: [] } }), "g-a")!, /没有新的/);
  assert.match(mkStatusLine(v({ ended: "t", result: { before: 7, after: null, fresh: [] } }), "g-a")!, /读不到/);
  assert.match(mkStatusLine(v({ ended: "t", error: "你的 Steam 版开着" }), "g-a")!, /没跑完.*Steam 版开着/);
  assert.match(mkStatusLine(v({}), "g-a")!, /中断/, "进程没了又没写收工");
});

test("我的账号的群: 只留第 1 席; 有目标; 不走班次; 别的群不能设目标", () => {
  const play = tmp();
  const g = createGroup(play, { name: "我的", kind: "mine", goal: "  打虫巢  ", seats: [{ brain: "claude-api", model: "claude-opus-5-5" }, { brain: "relay", model: "glm-5.3" }], minutes: 90 });
  assert.equal(g.kind, "mine");
  assert.equal(g.goal, "打虫巢");
  assert.equal(g.seats.length, 1);
  assert.equal(readGroup(play, g.id)?.goal, "打虫巢", "读回来还在");
  assert.equal(saveGroupSeats(play, g.id, [{ brain: "relay", model: "glm-5.3" }, { brain: "claude", model: "opus" }]).seats.length, 1);
  assert.equal(setGroupGoal(play, g.id, "").goal, undefined, "清空目标");
  assert.equal(setGroupGoal(play, g.id, "新目标").goal, "新目标");
  assert.throws(() => startArgs(play, g), /不走班次/);
  const other = createGroup(play, { name: "别的", kind: "new" });
  assert.throws(() => setGroupGoal(play, other.id, "x"), /只有"我的账号"/);
  assert.equal(readGroup(play, createGroup(play, { name: "带目标的新图", kind: "new", goal: "x" }).id)?.goal, undefined, "别的类型不存目标");
});
