// 这个世界走哪条路 (src/io/backend.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseBackend, cleanBackendPref } from "../src/io/backend.ts";

test("本地存档和新地图走 RCON + 模组", () => {
  assert.equal(chooseBackend({ kind: "new" }).backend, "rcon");
  assert.equal(chooseBackend({ kind: "save" }).backend, "rcon");
});

test("联机服务器没开 RCON 走内存外挂", () => {
  assert.equal(chooseBackend({ kind: "server" }).backend, "memory");
  assert.equal(chooseBackend({ kind: "server", rcon: false }).backend, "memory");
});

test("联机服务器明确开了 RCON 走 RCON; 查到没装模组才退回内存外挂", () => {
  assert.equal(chooseBackend({ kind: "server", rcon: true }).backend, "rcon");
  assert.equal(chooseBackend({ kind: "server", rcon: true, harnessOnServer: true }).backend, "rcon");
  assert.equal(chooseBackend({ kind: "server", rcon: true, harnessOnServer: false }).backend, "memory");
});

test("选项: 不选就是自动, 不认识的也算自动", () => {
  assert.equal(cleanBackendPref(undefined), "auto");
  assert.equal(cleanBackendPref("乱写"), "auto");
  assert.equal(cleanBackendPref("memory"), "memory");
  assert.equal(cleanBackendPref("rcon"), "rcon");
  assert.equal(chooseBackend({ kind: "server", prefer: "auto" }).backend, "memory");
  assert.equal(chooseBackend({ kind: "server", rcon: true, harnessOnServer: true, prefer: "auto" }).backend, "rcon");
});

test("选项: 选了外挂就走外挂, 服务器有模组时干净客户端进不去要报", () => {
  const c = chooseBackend({ kind: "server", rcon: true, prefer: "memory" });
  assert.equal(c.backend, "memory");
  assert.equal(c.problem, undefined);
  assert.match(chooseBackend({ kind: "server", rcon: true, harnessOnServer: true, prefer: "memory" }).problem!, /干净客户端进不去/);
});

test("选项: 选了 RCON 没填或没装模组要报, 不偷偷换路", () => {
  assert.match(chooseBackend({ kind: "server", prefer: "rcon" }).problem!, /没填/);
  assert.match(chooseBackend({ kind: "server", rcon: true, harnessOnServer: false, prefer: "rcon" }).problem!, /没装我们的模组/);
  const ok = chooseBackend({ kind: "server", rcon: true, harnessOnServer: true, prefer: "rcon" });
  assert.equal(ok.backend, "rcon");
  assert.equal(ok.problem, undefined);
});

test("选项只管联机: 本地的班一律 RCON + 模组", () => {
  assert.equal(chooseBackend({ kind: "new", prefer: "memory" }).backend, "rcon");
  assert.equal(chooseBackend({ kind: "save", prefer: "memory" }).backend, "rcon");
});
