// 群 = 对话 = 世界 (src/play/groups.ts):
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectArgs, createGroup, groupWorld, latestRunOfGroup, readGroup, readGroups, saveGroupSeats, setBackend, setRevealUncharted, startArgs } from "../src/play/groups.ts";

test("读没探过的区块: 只有联机服务器的群有, 默认关, 能开能关", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "groups-reveal-"));
  const s = createGroup(play, { name: "联机", kind: "server", server: { address: "1.2.3.4:34197" } });
  assert.ok(!fs.readFileSync(path.join(play, "groups", `${s.id}.json`), "utf8").includes("1.2.3.4"), "地址不写进群文件 (群文件进备份)");
  assert.equal(s.backend, undefined, "走哪条路默认自动, 不写");
  assert.equal(setBackend(play, s.id, "rcon").backend, "rcon");
  assert.equal(readGroup(play, s.id)?.backend, "rcon", "存下来了");
  assert.equal(setBackend(play, s.id, "memory").backend, "memory");
  assert.equal(setBackend(play, s.id, "auto").backend, undefined);
  assert.equal(setBackend(play, s.id, "乱写").backend, undefined);
  assert.equal(createGroup(play, { name: "建的时候选", kind: "server", server: { address: "x:1" }, backend: "memory" }).backend, "memory");
  assert.equal(createGroup(play, { name: "本机存的", kind: "server", savedServer: true }).kind, "server", "地址空着用本机已存的");
  assert.deepEqual(connectArgs(s), ["--server", "--group", s.id, "--read-only", "--minutes", "5"]);
  const local = createGroup(play, { name: "新图也选", kind: "new", backend: "memory" });
  assert.equal(local.backend, undefined, "本地的班没有这个选项");
  assert.throws(() => setBackend(play, local.id, "rcon"), /只给联机服务器/);
  assert.throws(() => connectArgs(local), /只有联机服务器/);
  assert.equal(s.revealUncharted, undefined, "默认关");
  assert.equal(setRevealUncharted(play, s.id, true).revealUncharted, true);
  assert.equal(readGroup(play, s.id)?.revealUncharted, true, "存下来了");
  assert.equal(setRevealUncharted(play, s.id, false).revealUncharted, undefined);
  assert.equal(createGroup(play, { name: "建的时候开", kind: "server", server: { address: "x:1" }, revealUncharted: true }).revealUncharted, true);
  const n = createGroup(play, { name: "新图", kind: "new", revealUncharted: true });
  assert.equal(n.revealUncharted, undefined, "本地的班没有这个选项");
  assert.throws(() => setRevealUncharted(play, n.id, true), /只给联机服务器/);
  fs.rmSync(play, { recursive: true, force: true });
});

test("新建 / 读 / 改成员 / 校验; 群就是世界; 开班参数接群自己最近一班", () => {
  const play = fs.mkdtempSync(path.join(os.tmpdir(), "groups-test-"));
  assert.deepEqual(readGroups(play), []);
  assert.throws(() => createGroup(play, { name: " ", kind: "new" }), /名字要 1~40/);
  assert.throws(() => createGroup(play, { name: "x", kind: "save", save: "C:/nope.zip" }), /存在的 \.zip/);
  assert.throws(() => createGroup(play, { name: "x", kind: "server" }), /要给地址/);
  assert.throws(() => createGroup(play, { name: "x", kind: "new", seats: [{ brain: "gpt9", model: "" }] }), /不认识的家/);
  const g = createGroup(play, { name: "  第二张图  ", kind: "new", minutes: 45 }, new Date("2026-11-04T10:00:00Z"));
  assert.match(g.id, /^g-[a-z0-9]+$/);
  assert.deepEqual([g.name, g.kind, g.minutes, g.seats], ["第二张图", "new", 45, [{ brain: "claude", model: "opus" }]], "成员默认管理员 Claude Opus");
  assert.deepEqual(readGroup(play, g.id), g);
  assert.equal(readGroup(play, "nope"), null);
  assert.deepEqual(groupWorld(g), { id: g.id, name: "第二张图", kind: "sandbox", createdAt: "2026-11-04T10:00:00.000Z", firstRun: "" });
  // 成员
  const g2 = saveGroupSeats(play, g.id, [{ brain: "claude", model: "opus" }, { brain: "relay", model: "glm-5.3" }, { brain: "relay", model: "MiniMax-M3.1-Flash" }]);
  assert.equal(g2.seats.length, 3);
  assert.throws(() => saveGroupSeats(play, g.id, []), /至少留一个角色/);
  assert.throws(() => saveGroupSeats(play, "g-zzzz", [{ brain: "claude", model: "" }]), /没有这个群/);
  // 开班参数: 还没跑过 → 新地图, 不带 --save
  assert.deepEqual(startArgs(play, g2), ["--kit", "party", "--mod", "agent-harness-party", "--minutes", "45", "--group", g.id, "--brains", "claude:opus,relay:glm-5.3,relay:MiniMax-M3.1-Flash"]);
  // 跑过一班 (world.json 是这个群, 有 end.zip 和 summary.brainDir) → 接它
  const run = path.join(play, "runs", "2026-11-04T10-30-00");
  const brain = path.join(play, "brain-1");
  fs.mkdirSync(run, { recursive: true }); fs.mkdirSync(brain, { recursive: true });
  fs.writeFileSync(path.join(run, "world.json"), JSON.stringify(groupWorld(g)));
  fs.writeFileSync(path.join(run, "end.zip"), "zip");
  fs.writeFileSync(path.join(run, "summary.json"), JSON.stringify({ brainDir: brain }));
  assert.deepEqual(latestRunOfGroup(play, g.id), { runId: "2026-11-04T10-30-00", endZip: path.join(run, "end.zip"), brainDir: brain });
  assert.deepEqual(startArgs(play, g2).slice(-4), ["--save", path.join(run, "end.zip"), "--notes", brain]);
  // 别的世界的班不算; 没 end.zip 的班不算
  const other = path.join(play, "runs", "2026-11-04T11-00-00");
  fs.mkdirSync(other); fs.writeFileSync(path.join(other, "world.json"), JSON.stringify({ id: "sandbox-x", name: "x", kind: "sandbox" })); fs.writeFileSync(path.join(other, "end.zip"), "zip");
  const noEnd = path.join(play, "runs", "2026-11-04T12-00-00");
  fs.mkdirSync(noEnd); fs.writeFileSync(path.join(noEnd, "world.json"), JSON.stringify(groupWorld(g)));
  assert.equal(latestRunOfGroup(play, g.id)?.runId, "2026-11-04T10-30-00");
  // 接着存档的群: 第一班接给的 zip
  const gs = createGroup(play, { name: "接存档", kind: "save", save: path.join(run, "end.zip") });
  assert.deepEqual(startArgs(play, gs).slice(-4), ["--save", path.join(run, "end.zip"), "--notes", brain], "是我们某一班的 end.zip 就连笔记一起接");
  // 联机的群只能建
  const sv = createGroup(play, { name: "联机服务器", kind: "server", server: { address: "1.2.3.4:34197" } });
  assert.equal(groupWorld(sv).kind, "server");
  assert.throws(() => startArgs(play, sv), /还开不了班/);
  assert.equal(readGroups(play).length, 3);
  fs.rmSync(play, { recursive: true, force: true });
});
