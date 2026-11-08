// 群开班选路线 (src/play/groups.ts; docs/decisions.md 2026-11-08): memory (默认, 不装模组) → core/run/online.ts 的参数; mods (装模组全性能) → 第二版 run.ts 的参数; 两条路接同一条存档链
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGroup, onlineStartArgs, readGroup, routeLabel, setGroupGoal, setGroupMe, startArgs } from "../src/play/groups.ts";

test("'我 · 管理员'那一行选的模型 (group.me): 存进群文件、清掉、none 等于清掉、不合格的拒; 选了才有这一局的目标", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "group-me-"));
  try {
    const g = createGroup(play, { name: "t", kind: "new" });
    assert.equal(readGroup(play, g.id)?.me, undefined);
    assert.throws(() => setGroupGoal(play, g.id, "拿成就"), /先在/);
    assert.deepEqual(setGroupMe(play, g.id, { brain: "claude", model: "claude-sonnet-5-5", effort: "medium" }).me, { brain: "claude", model: "claude-sonnet-5-5", effort: "medium" });
    assert.equal(readGroup(play, g.id)?.me?.model, "claude-sonnet-5-5");
    assert.equal(setGroupGoal(play, g.id, "摧毁一个虫巢").goal, "摧毁一个虫巢");
    assert.throws(() => setGroupMe(play, g.id, { brain: "gpt-9", model: "x" }), /不合格/);
    assert.equal(setGroupMe(play, g.id, { brain: "none", model: "" }).me, undefined);
    assert.equal(setGroupMe(play, g.id, null).me, undefined);
  } finally { fs.rmSync(play, { recursive: true, force: true }); }
});

test("群的路线: 不写 = memory; 只有沙盘的群 (new / save) 能选 mods; 存进群文件再读出来还在", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "group-route-"));
  try {
    const a = createGroup(play, { name: "默认", kind: "new" });
    assert.equal(a.route, undefined);
    assert.equal(routeLabel(a.route), "不装模组 (算成就)");
    const b = createGroup(play, { name: "全性能", kind: "new", route: "mods" });
    assert.equal(readGroup(play, b.id)?.route, "mods");
    assert.equal(routeLabel("mods"), "装模组全性能 (不算成就)");
    const c = createGroup(play, { name: "我的", kind: "mine", route: "mods" });
    assert.equal(c.route, undefined, "我的账号那种群不走模组");
    assert.equal(createGroup(play, { name: "怪", kind: "new", route: "whatever" }).route, undefined, "不认识的当 memory");
  } finally { fs.rmSync(play, { recursive: true, force: true }); }
});

test("两条路的参数: memory → online.ts (--lab, 第 1 席的家 / 模型 / 强度, --group); mods → run.ts (--kit party --mod agent-harness-party --brains 全名单); 有上一班都接它的 end.zip 和笔记", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "group-route-"));
  try {
    const g = createGroup(play, { name: "t", kind: "new", seats: [{ brain: "claude", model: "claude-sonnet-5-5", effort: "medium" }, { brain: "grok", model: "grok-4.7" }], minutes: 45 });
    const on = onlineStartArgs(play, g);
    assert.deepEqual(on, ["--lab", "--minutes", "45", "--group", g.id, "--brain", "claude", "--model", "claude-sonnet-5-5", "--effort", "medium"], "第一班没得接; 只带第 1 席");
    const mods = startArgs(play, g);
    assert.deepEqual(mods.slice(0, 6), ["--kit", "party", "--mod", "agent-harness-party", "--minutes", "45"]);
    assert.equal(mods[mods.indexOf("--brains") + 1], "claude:claude-sonnet-5-5@medium,grok:grok-4.7");
    // 上一班: play/runs/<id>/ 有 world.json (这个群)、end.zip、summary.json (brainDir + lineup 不全是 none)
    const notes = fs.mkdtempSync(path.join(os.tmpdir(), "group-notes-"));
    const run = path.join(play, "runs", "2026-11-08T05-00-00");
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, "world.json"), JSON.stringify({ id: g.id, name: "t", kind: "sandbox", createdAt: "", firstRun: "" }));
    fs.writeFileSync(path.join(run, "end.zip"), "x");
    fs.writeFileSync(path.join(run, "summary.json"), JSON.stringify({ brainDir: notes, lineup: [{ brain: "claude", model: "claude-sonnet-5-5" }] }));
    const on2 = onlineStartArgs(play, g);
    assert.equal(on2[on2.indexOf("--save") + 1], path.join(run, "end.zip"));
    assert.equal(on2[on2.indexOf("--notes") + 1], notes);
    const mods2 = startArgs(play, g);
    assert.equal(mods2[mods2.indexOf("--save") + 1], path.join(run, "end.zip"), "两条路接同一条存档链");
    fs.rmSync(notes, { recursive: true, force: true });
    assert.throws(() => onlineStartArgs(play, createGroup(play, { name: "s", kind: "server", server: { address: "h:1" } })), /联机服务器/);
  } finally { fs.rmSync(play, { recursive: true, force: true }); }
});
