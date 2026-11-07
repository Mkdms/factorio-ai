// 订阅额度 (src/play/quota.ts): 用量接口 (不花额度) 的解析、凭据、读不到时的原因; 不联网
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePlanUsage, claudeOauthToken, readPlanUsage, maxUtilization, describeQuota, type GetJson } from "../src/play/quota.ts";

// 2026-11-03 本机实测的回复形状 (Max 订阅; 5 小时窗口为空, 其余没用到的窗口是 null)
const REAL = { five_hour: null, seven_day: { utilization: 37.0, resets_at: "2026-11-07T11:00:00.033606+00:00", limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day_oauth_apps: null, seven_day_opus: null, seven_day_sonnet: null, seven_day_cowork: null, extra_usage: { is_enabled: false, utilization: 12 } };

test("用量接口的回复 → 和 rate_limit_event 同一个形状 (0~1, 秒)", () => {
  const q = parsePlanUsage(REAL, 1)!;
  assert.deepEqual(Object.keys(q.windows), ["seven_day"]); // null 和 extra_usage 不算窗口
  assert.equal(q.windows.seven_day.utilization, 0.37);
  assert.equal(q.windows.seven_day.resetsAt, 1794049200); // 和第五轮 rate_limit_event 记的重置时间一样
  assert.equal(q.status, "allowed");
  assert.equal(maxUtilization(q), 0.37);
  assert.match(describeQuota(q, 1794049200 * 1000 - 2 * 86_400_000), /7 天窗口已用 37%, 2\.0 天后重置/);
  assert.equal(parsePlanUsage({ five_hour: { utilization: 100, resets_at: null } })!.status, "rejected");
  assert.equal(parsePlanUsage({ usage: { seven_day_opus: { utilization: 5 } } })!.windows.seven_day_opus.utilization, 0.05);
  assert.equal(parsePlanUsage({ error: { type: "forbidden" } }), null);
  assert.equal(parsePlanUsage(null), null);
});

function credDir(oauth: object | null) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "quota-test-"));
  if (oauth) fs.writeFileSync(path.join(d, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));
  return d;
}

test("凭据: 没有文件 / 没有订阅登录 / 快过期 → 不用 (退回探针)", () => {
  assert.match(claudeOauthToken({ CLAUDE_CONFIG_DIR: credDir(null) }).why!, /没有登录凭据文件/);
  assert.match(claudeOauthToken({ CLAUDE_CONFIG_DIR: credDir({}) }).why!, /没有订阅登录/);
  assert.match(claudeOauthToken({ CLAUDE_CONFIG_DIR: credDir({ accessToken: "t", expiresAt: 1000 }) }, 1000).why!, /过期/);
  assert.equal(claudeOauthToken({ CLAUDE_CONFIG_DIR: credDir({ accessToken: "t", expiresAt: 10_000_000 }) }, 1000).token, "t");
});

test("读用量: 凭据只进请求头; 403 时提示看代理; 回复格式不对说原因", async () => {
  const env = { CLAUDE_CONFIG_DIR: credDir({ accessToken: "tok", expiresAt: Date.now() + 3_600_000 }), HTTPS_PROXY: "http://127.0.0.1:1" };
  const seen: { url: string; headers: Record<string, string>; env: NodeJS.ProcessEnv }[] = [];
  const ok: GetJson = async (url, headers, e) => { seen.push({ url, headers, env: e }); return { status: 200, body: REAL }; };
  const r = await readPlanUsage(env, ok);
  assert.equal(r.q!.windows.seven_day.utilization, 0.37);
  assert.equal(seen[0].headers.Authorization, "Bearer tok");
  assert.equal(seen[0].headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(seen[0].env.HTTPS_PROXY, "http://127.0.0.1:1"); // 代理设置传给请求 (Node 自带 fetch 不走代理)
  const forbidden: GetJson = async () => ({ status: 403, body: { error: { type: "forbidden", message: "Request not allowed" } } });
  assert.match((await readPlanUsage(env, forbidden)).why!, /HTTP 403.*HTTPS_PROXY/);
  const odd: GetJson = async () => ({ status: 200, body: { something: 1 } });
  assert.match((await readPlanUsage(env, odd)).why!, /没有窗口数据/);
  const down: GetJson = async () => { throw new Error("ECONNREFUSED"); };
  assert.match((await readPlanUsage(env, down)).why!, /连不上: ECONNREFUSED/);
  assert.match((await readPlanUsage({ CLAUDE_CONFIG_DIR: credDir(null) }, ok)).why!, /没有登录凭据文件/);
});
