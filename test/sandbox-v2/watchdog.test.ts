// 看门狗 / 崩溃恢复的沙盘测试 (M6): 杀掉无界面服务器 → 用最新完整自动存档重启, 端口密码不变, 存档里的东西还在、存档后的不在。
// 不开窗口。npm run test:sandbox
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { LabInstance } from "../../src/lab/instance.ts";
import { newestAutosave, recoverLab, newWatchState, observe, recovered } from "../../src/play/watchdog.ts";

const lab = new LabInstance({ name: "test-watchdog", view: false });
after(() => lab.stop({ save: false }));

test("服务器被杀后: 用最新自动存档重启, 端口密码不变, 读的是存档不是内存", async () => {
  await lab.createMap("m", { seed: 42 });
  const t0 = Date.now() - 1000; // 文件时间精度留 1 秒余量; 同名实例上次测试留下的自动存档在这之前, 不算
  await lab.start("m");
  const ports = { game: lab.gamePort, rcon: lab.rconPort, udp: lab.udpPort, pw: lab.password };
  // 存档前放一个箱子当标记, 让服务器写一份自动存档 (io-lab.save → game.server_save, 写到实例的 saves 目录)
  await lab.exec(`game.surfaces[1].create_entity{name = "wooden-chest", position = {3.5, 3.5}, force = "player"} return true`);
  await lab.rpc("save", { name: "_autosave1" });
  const savesDir = path.join(lab.dir, "saves");
  let pick = null;
  for (let i = 0; i < 60 && !pick; i++) { await new Promise((r) => setTimeout(r, 500)); pick = newestAutosave(savesDir, { notBefore: t0 }); }
  assert.ok(pick, "server_save 之后 saves 目录里应有 _autosave1.zip");
  // 存档之后再放一个: 重启后它不该在 (证明读的是存档)
  await lab.exec(`game.surfaces[1].create_entity{name = "wooden-chest", position = {6.5, 6.5}, force = "player"} return true`);
  // 模拟崩溃: 直接杀进程
  const proc = lab.proc!;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  proc.kill();
  await exited;
  assert.equal(lab.alive, false);
  // 看门狗判定: 没到 45 秒先等, 到了才恢复
  const st = newWatchState();
  const now = Date.now();
  assert.equal(observe(st, false, now), "down");
  assert.equal(observe(st, false, now + 46_000), "recover");
  const r = await recoverLab(lab, { startSave: "m", notBefore: t0 });
  recovered(st, now + 60_000, true);
  assert.equal(r.save, "_autosave1");
  assert.equal(r.fallback, false);
  assert.equal(lab.alive, true);
  assert.deepEqual({ game: lab.gamePort, rcon: lab.rconPort, udp: lab.udpPort, pw: lab.password }, ports, "端口和密码不变, ./fh 配置不用改");
  const ping = (await lab.rpc("ping")) as { mod?: string };
  assert.ok(ping.mod, "重启后沙盘模组能答"); // 第二版 io-lab 回 io_lab 字段, 新项目的沙盘模组 (game/mod/factorio-ai) 回 mod
  const xs = (await lab.exec(`local t = {} for _, e in pairs(game.surfaces[1].find_entities_filtered{name = "wooden-chest"}) do t[#t + 1] = e.position.x end return t`)) as number[];
  assert.deepEqual(xs, [3.5], "存档前放的箱子在, 存档后放的不在");
  assert.equal(st.downtimeMs, 60_000);
});

test("没有这一班的自动存档: 退回开班存档 (fallback), 服务器照样起来", async () => {
  const proc = lab.proc!;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  proc.kill();
  await exited;
  const r = await recoverLab(lab, { startSave: "m", notBefore: Date.now() + 1 }); // 把所有自动存档都挡在门外
  assert.equal(r.save, null);
  assert.equal(r.fallback, true);
  assert.equal(lab.alive, true);
});
