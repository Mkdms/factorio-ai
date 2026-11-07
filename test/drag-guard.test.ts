// 拖窗口守卫 (src/io/drag-guard.ts); 真实效果是真鼠标拖真窗口量的, 见 docs/lab.md
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { DRAG_GUARD_SCRIPT, dragGuardCommand, dragGuardLine, startDragGuard } from "../commands/drag-guard.ts";

test("守卫脚本只有 ASCII: 系统自带的 PowerShell 5.1 按本地编码读不带 BOM 的脚本, 中文可能把它读坏", () => {
  const text = fs.readFileSync(DRAG_GUARD_SCRIPT, "utf8");
  assert.ok(text.length > 1000);
  const bad = text.split(/\r?\n/).findIndex((l) => /[^\x00-\x7F]/.test(l));
  assert.equal(bad, -1, `第 ${bad + 1} 行有非 ASCII`);
});

test("用系统自带的 PowerShell 起, 盯给的进程", () => {
  const { cmd, args } = dragGuardCommand(123);
  assert.equal(cmd, "powershell.exe");
  assert.equal(args.at(-1), "123");
  assert.equal(args.at(-2), DRAG_GUARD_SCRIPT);
});

test("日志只留起来了和出问题的, 平常拖一下不记", () => {
  assert.match(dragGuardLine("up\r")!, /起来了/);
  assert.match(dragGuardLine("fail: no event hook")!, /no event hook/);
  assert.match(dragGuardLine("stuck: move loop did not end")!, /游戏会停/);
  assert.equal(dragGuardLine("drag: 3719 ms"), null);
  assert.equal(dragGuardLine(""), null);
});

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { setEncoding(): void }; stderr: EventEmitter & { setEncoding(): void }; kill(): boolean; killed: boolean };
  c.stdout = Object.assign(new EventEmitter(), { setEncoding() { /* 测试里本来就是字符串 */ } });
  c.stderr = Object.assign(new EventEmitter(), { setEncoding() { /* 同上 */ } });
  c.killed = false;
  c.kill = () => { c.killed = true; return true; };
  return c;
}

test("起守卫: 输出切成行再翻译, 半行留着等下一块; 关的时候杀掉, 主动关不报错", () => {
  const c = fakeChild(), logs: string[] = [];
  const stop = startDragGuard(9, (s) => logs.push(s), (() => c) as never, "win32");
  c.stdout.emit("data", "u");
  assert.deepEqual(logs, [], "半行不处理");
  c.stdout.emit("data", "p\r\ndrag: 5 ms\r\n");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /起来了/);
  stop();
  assert.equal(c.killed, true);
  c.emit("exit", 1);
  assert.equal(logs.length, 1, "主动关的退出码不报");
});

test("守卫自己挂了或起不来: 只报一句, 不抛错", () => {
  const c = fakeChild(), logs: string[] = [];
  startDragGuard(9, (s) => logs.push(s), (() => c) as never, "win32");
  c.stderr.emit("data", "Add-Type 编译失败");
  c.emit("exit", 1);
  assert.match(logs[0], /退出了 \(1\): Add-Type 编译失败/);
  const d = fakeChild();
  startDragGuard(9, (s) => logs.push(s), (() => d) as never, "win32");
  d.emit("error", new Error("找不到 powershell.exe"));
  assert.match(logs[1], /起不来: 找不到 powershell/);
});

test("不是 Windows 什么都不起", () => {
  let called = false;
  const stop = startDragGuard(9, () => undefined, (() => { called = true; return fakeChild(); }) as never, "linux");
  stop();
  assert.equal(called, false);
});
