// 大脑接口警报 (src/play/alerts.ts):
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AlertDedupe, appendAlert, isApiFailure, readAlerts, type Alert } from "../src/play/alerts.ts";

test("接口层失败的判定: API Error / 4xx / 连不上 / 余额 算, 游戏里的失败不算", () => {
  for (const t of ["API Error: 400 Unsupported parameter: metadata (request id: x)", "API Error: 401 authentication_error", "HTTP 429 rate limit", "fetch failed", "insufficient balance", "余额不足", "Error: connect ECONNREFUSED 127.0.0.1:443"]) assert.ok(isApiFailure(t), t);
  for (const t of ["action_failed: entity not found at (3,4)", "out of reach", "我把煤放进锅炉了", "Exit code 1\nerror: area or positions required"]) assert.ok(!isApiFailure(t), t);
});

test("记 / 读警报 (最近 N 条, 坏行跳过); 同一角色同样的话 10 分钟内只记一次", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alerts-test-"));
  assert.deepEqual(readAlerts(dir), []);
  const a: Alert = { at: "2026-11-04T09:34:00.000Z", agent: "c", name: "Gpt-6.1-Terra", brain: "relay", model: "gpt-6.1-terra", kind: "probe", text: "API Error: 400 Unsupported parameter: metadata" };
  appendAlert(dir, a);
  fs.appendFileSync(path.join(dir, "alerts.jsonl"), "{坏行\n");
  appendAlert(dir, { ...a, at: "2026-11-04T09:40:00.000Z", kind: "api" });
  const list = readAlerts(dir);
  assert.deepEqual(list.map((x) => x.kind), ["probe", "api"]);
  assert.equal(readAlerts(dir, 1).length, 1);
  const d = new AlertDedupe();
  const t0 = Date.parse("2026-11-04T09:34:00.000Z");
  assert.ok(d.should("c", a.text, t0));
  assert.ok(!d.should("c", a.text, t0 + 60_000), "1 分钟后同样的话不再记");
  assert.ok(d.should("b", a.text, t0 + 60_000), "别的角色算另一条");
  assert.ok(d.should("c", a.text, t0 + 11 * 60_000), "过了 10 分钟再记");
  fs.rmSync(dir, { recursive: true, force: true });
});
