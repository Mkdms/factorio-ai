// 游戏窗口是用户关的还是崩的 (src/lab/viewer.ts normalQuitReason): 用户手关窗口被当掉线重开 (backlog #294), run.ts 现在把正常退出当停班
import test from "node:test";
import assert from "node:assert/strict";
import { normalQuitReason } from "../src/lab/viewer.ts";

// 本机 2.1.24 客户端日志原文 (lab-data/clients/viewer/factorio-current.log 结尾, 2026-11-05 查)
const closed = [
  " 405.936 Quitting: window closed.",
  " 409.293 Info ClientMultiplayerManager.cpp:610: UpdateTick(371342) changing state from(WaitingForDisconnectConfirmation) to(Disconnected)",
  " 409.293 Info GlobalContext.cpp:763: Deleting active scenario.",
  " 409.471 UDPSocket.cpp:238: Closing socket",
  " 409.594 Steam API shutdown.",
  " 409.598 Goodbye",
].join("\r\n");

test("点右上角 × 关窗口: Quitting: window closed.", () => {
  assert.equal(normalQuitReason(closed), "window closed");
});

test("菜单里退出: Quitting: user-quit.", () => {
  assert.equal(normalQuitReason(" 652.814 Quitting: user-quit.\n 653.001 Goodbye\n"), "user-quit");
});

test("崩掉 / 被杀: 没有 Quitting 那一行 → null (仍按掉线重开)", () => {
  assert.equal(normalQuitReason(" 100.000 Error CrashHandler.cpp:641: Received 3221225477\n 100.001 Error CrashHandler.cpp:1000: Stack trace\n"), null);
  assert.equal(normalQuitReason(""), null);
});

test("只看结尾 60 行: 上一次正常退出留在文件前面不算", () => {
  const old = " 10.000 Quitting: window closed.\n 10.100 Goodbye\n";
  const later = Array.from({ length: 80 }, (_, i) => ` ${(20 + i).toFixed(3)} Info ClientMultiplayerManager.cpp:610: UpdateTick(${i}) changing state`).join("\n");
  assert.equal(normalQuitReason(old + later), null);
});
