// 看门狗 / 崩溃恢复的纯函数 (src/play/watchdog.ts); 真起服务器杀进程的在 test/sandbox/watchdog.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newestAutosave, crashedInLog, newWatchState, observe, recovered, downtimeMs } from "../src/play/watchdog.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-"));

test("最新完整自动存档: 跳过 .tmp 和别的文件, 按修改时间取最新, notBefore 之前的不算", () => {
  const d = tmp();
  const w = (name: string, ageS: number) => {
    const f = path.join(d, name);
    fs.writeFileSync(f, "x");
    const t = new Date(Date.now() - ageS * 1000);
    fs.utimesSync(f, t, t);
  };
  w("_autosave1.zip", 600);
  w("_autosave2.zip", 60);
  w("_autosave3.zip.tmp", 1);
  w("_autosave4.tmp.zip", 1);
  w("m.zip", 1);
  assert.equal(newestAutosave(d)?.name, "_autosave2");
  assert.equal(newestAutosave(d, { notBefore: Date.now() - 30_000 }), null, "30 秒内没写过自动存档");
  assert.equal(newestAutosave(path.join(d, "none")), null, "目录不存在不报错");
});

test("崩溃报告只看日志末尾 4000 字", () => {
  const d = tmp();
  const f = path.join(d, "server.out");
  fs.writeFileSync(f, "a".repeat(10_000) + "\n   0.123 Factorio crashed. Generating symbolized stacktrace, please wait ...\n");
  assert.equal(crashedInLog(f), true);
  fs.writeFileSync(f, "Unexpected error occurred\n" + "b".repeat(10_000));
  assert.equal(crashedInLog(f), false, "字样在末尾 4000 字之前不算 (每次崩溃写在末尾)");
  assert.equal(crashedInLog(path.join(d, "no.out")), false);
});

test("看门狗判定: 45 秒门槛、恢复后 5 分钟内不重复、最多 10 次、停机记账", () => {
  const st = newWatchState();
  const t = 1_000_000;
  assert.equal(observe(st, true, t), "ok");
  assert.equal(observe(st, false, t), "down");
  assert.equal(observe(st, false, t + 44_000), "down");
  assert.equal(observe(st, false, t + 45_000), "recover");
  recovered(st, t + 70_000, true);
  assert.equal(st.recoveries, 1);
  assert.equal(st.downtimeMs, 70_000, "停机 = 掉线到恢复完成");
  assert.equal(observe(st, true, t + 100_000), "ok");
  // 恢复后 5 分钟内又掉: 到了 45 秒也先等, 满 5 分钟才再恢复
  assert.equal(observe(st, false, t + 110_000), "down");
  assert.equal(observe(st, false, t + 160_000), "down");
  assert.equal(observe(st, false, t + 370_000), "recover");
  recovered(st, t + 400_000, false);
  assert.equal(st.failed, 1);
  assert.equal(st.downSince, t + 110_000, "恢复失败不关停机窗口");
  assert.equal(downtimeMs(st, t + 500_000), 70_000 + (500_000 - 110_000));
  st.recoveries = 10;
  assert.equal(observe(st, false, t + 800_000), "gave-up");
  // 自己活过来了 (例: 下一次恢复成功): 窗口关上
  assert.equal(observe(st, true, t + 900_000), "ok");
  assert.equal(st.downtimeMs, 70_000 + 790_000);
});
