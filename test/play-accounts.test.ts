// 账号页 (src/play/accounts.ts): 三家命令行装没装、登没登、额度; 用量回复的样例照 OpenMausBot server/plan-usage.test.ts (Apache-2.0, 见 NOTICE)。
// 不连网、不跑真的命令行: 程序查找用临时目录里的假文件, 命令输出和接口回复都是假的。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KEY_PROVIDERS, PROVIDERS, accountOf, checkKey, claudeStatus, claudeUsage, cleanKey, cleanUrl, codexStatus, codexToken, codexUsage, findCli, grokToken, grokUsage, keyAccountOf, loginCommandLine,
  parseCodexUsage, parseDeepseekBalance, parseGlmQuota, parseGrokUsage, parseRelayBalance, parseRelayModels, parseRelayUser, readKeys, relayConfig, saveKey, saveRelay, versionOf, windowLabel, type Run,
} from "../src/play/accounts.ts";
import { allowedOrigin } from "../src/play/control-lib.ts";
import type { GetJson } from "../src/play/quota.ts";

const SECRET = "account-fixture-secret";
const spec = (id: string) => PROVIDERS.find((p) => p.id === id)!;

test("找程序: 按 PATH 先后和 PATHEXT, 再看安装器默认目录; 找不到 null", () => {
  const files = new Set([path.join("C:/b", "codex.cmd"), path.join("C:/a", "claude.exe"), path.join("C:/grok/bin", "grok.exe")]);
  const env = { PATH: ["C:/a", "C:/b"].join(path.delimiter), PATHEXT: ".EXE;.CMD" };
  const has = (f: string) => files.has(f);
  if (process.platform === "win32") {
    assert.equal(findCli("claude", env, [], has), path.join("C:/a", "claude.exe"));
    assert.equal(findCli("codex", env, [], has), path.join("C:/b", "codex.cmd"));
    assert.equal(findCli("grok", env, [], has), null);
    assert.equal(findCli("grok", env, ["C:/grok/bin"], has), path.join("C:/grok/bin", "grok.exe"), "装完 PATH 还是旧的时, 看 ~/.grok/bin");
  }
});

test("版本号和登录状态的判定 (claude auth status --json; codex login status 照 OpenMausBot)", () => {
  assert.equal(versionOf("2.1.314 (Claude Code)"), "2.1.314");
  assert.equal(versionOf("codex-cli 0.50.0\n"), "0.50.0");
  assert.equal(versionOf("没有版本"), null);
  assert.deepEqual(claudeStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "x@y.z" })), { signedIn: true, plan: "Max" });
  assert.deepEqual(claudeStatus(JSON.stringify({ loggedIn: false })), { signedIn: false, plan: null });
  assert.deepEqual(claudeStatus("看不懂的输出"), { signedIn: null, plan: null });
  assert.deepEqual(codexStatus(0, "Logged in using ChatGPT\n"), { signedIn: true, plan: "ChatGPT 订阅" });
  assert.deepEqual(codexStatus(0, "Logged in using an API key - sk-…\n"), { signedIn: true, plan: "API 密钥 (不是订阅)" });
  assert.deepEqual(codexStatus(1, "Not logged in\n"), { signedIn: false, plan: null });
  assert.deepEqual(codexStatus(0, "Not logged in\n"), { signedIn: null, plan: null }, "退出码和文字对不上就说不准");
});

test("窗口长度 → 中文名 (OpenMausBot 的分档)", () => {
  assert.equal(windowLabel(18000), "5 小时");
  assert.equal(windowLabel(604800), "7 天");
  assert.equal(windowLabel(30 * 86400), "30 天");
  assert.equal(windowLabel(2 * 86400), "2 天");
  assert.equal(windowLabel(null), "额度");
});

test("Codex 用量: 5 小时 / 7 天 / 附加限额 / 按模型; 回复里混进的令牌不当名字", () => {
  const a = parseCodexUsage({
    plan_type: "plus", access_token: SECRET,
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
    },
    additional_rate_limits: [{ used_percent: 5, limit_window_seconds: 30 * 86400, reset_at: 1_800_000_000_000 }],
  });
  assert.equal(a.plan, "plus");
  assert.deepEqual(a.usage, [
    { label: "5 小时", used: 10, resetsAt: new Date(1_800_000_000_000).toISOString() },
    { label: "7 天", used: 40, resetsAt: new Date(1_800_000_000_000).toISOString() },
    { label: "30 天", used: 5, resetsAt: new Date(1_800_000_000_000).toISOString() },
  ]);
  const b = parseCodexUsage({
    plan_type: "pro",
    rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
    additional_rate_limits: [{ limit_name: "GPT-5.3-Codex-Spark", rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 }, secondary_window: { used_percent: 12, limit_window_seconds: 604800 } } }],
    code_review_rate_limit: { primary_window: { used_percent: 120, window_minutes: 300 } },
  });
  assert.deepEqual(b.usage.map((w) => [w.label, w.used]), [["5 小时", 10], ["代码审查 5 小时", 100], ["GPT-5.3-Codex-Spark 5 小时", 5], ["GPT-5.3-Codex-Spark 7 天", 12]]);
  assert.equal(parseCodexUsage({ plan_type: `Bearer ${SECRET}` }).plan, null);
  assert.deepEqual(parseCodexUsage("不是对象"), { plan: null, usage: [] });
});

test("Grok 用量: 按周的额度、按产品、按月的按需额度、订阅档", () => {
  const g = parseGrokUsage(
    { access_token: SECRET, config: { creditUsagePercent: 8, currentPeriod: { type: "WEEK", start: "2026-09-26T00:00:00.000Z", end: "2026-10-03T00:00:00.000Z" },
      productUsage: [{ product: "GrokBuild", usagePercent: 8 }, { product: "GrokChat", usagePercent: 2 }] } },
    { config: { onDemandCap: { val: 100 }, onDemandUsed: { val: 40 }, currentPeriod: { type: "MONTH", end: "2026-10-26T00:00:00.000Z" } } },
    { settings: { subscription_tier_display: "SuperGrok", access_token: SECRET } },
  );
  assert.equal(g.plan, "SuperGrok");
  assert.deepEqual(g.usage, [
    { label: "7 天", used: 8, resetsAt: "2026-10-03T00:00:00.000Z" },
    { label: "Grok Build 7 天", used: 8, resetsAt: "2026-10-03T00:00:00.000Z" },
    { label: "Grok Chat 7 天", used: 2, resetsAt: "2026-10-03T00:00:00.000Z" },
    { label: "30 天", used: 40, resetsAt: "2026-10-26T00:00:00.000Z" },
  ]);
  assert.deepEqual(parseGrokUsage(null).usage, []);
  // 2026-11-03 真账号 (SuperGrok, 刚登录这周没用过) 的回复形状: 有周期、没有 creditUsagePercent (protobuf JSON 省掉了 0)
  const fresh = parseGrokUsage({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-03T05:41:21.992+00:00", end: "2026-11-10T05:41:21.992+00:00" },
    isUnifiedBillingUser: true, prepaidBalance: { val: 0 }, billingPeriodEnd: "2026-11-10T05:41:21.992+00:00" } },
    { config: { monthlyLimit: { val: 0 }, used: { val: 0 }, onDemandCap: { val: 0 }, billingPeriodEnd: "2026-12-01T00:00:00+00:00" } }, { subscription_tier_display: "SuperGrok" });
  assert.deepEqual(fresh.usage, [{ label: "7 天", used: 0, resetsAt: "2026-11-10T05:41:21.992Z" }]);
  assert.equal(fresh.plan, "SuperGrok");
  assert.match(fresh.note!, /按这周已用 0% 算/);
  assert.equal(g.note, null, "给了用量数字就不加说明");
});

test("登录文件里的令牌: 没有 / 过期 / API 密钥写原因; Grok 挑最晚过期的那项", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const file = (o: unknown) => () => JSON.stringify(o);
  assert.deepEqual(codexToken({}, now, () => null), { token: null, why: "没有登录文件" });
  assert.deepEqual(codexToken({}, now, file({ tokens: { access_token: SECRET, account_id: "acct" } })), { token: SECRET, accountId: "acct" });
  assert.equal(codexToken({}, now, file({ tokens: { access_token: SECRET, expires_at: "2026-11-03T11:00:00Z" } })).token, null);
  assert.match(codexToken({}, now, file({ OPENAI_API_KEY: "k" })).why!, /API 密钥/);
  const grok = { "https://auth.x.ai::x": { key: "old", expires_at: "2026-11-03T13:00:00Z" }, "https://accounts.x.ai/sign-in": { key: "new", expires_at: "2026-11-04T13:00:00Z" } };
  assert.deepEqual(grokToken({}, now, file(grok)), { token: "new" });
  assert.match(grokToken({}, now, file({ a: { key: "x", expires_at: "2026-11-01T00:00:00Z" } })).why!, /过期/);
  assert.match(grokToken({}, now, () => null).why!, /没有登录文件/);
});

test("读额度: 令牌只进请求头; 401 写原因; Grok 带 X-XAI-Token-Auth", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-test-"));
  fs.mkdirSync(path.join(dir, ".codex")); fs.mkdirSync(path.join(dir, ".grok"));
  fs.writeFileSync(path.join(dir, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: SECRET, account_id: "acct" } }));
  fs.writeFileSync(path.join(dir, ".grok", "auth.json"), JSON.stringify({ s: { key: SECRET, expires_at: "2099-01-01T00:00:00Z" } }));
  const env = { USERPROFILE: dir, HOME: dir };
  const seen: { url: string; h: Record<string, string> }[] = [];
  const ok: GetJson = async (url, h) => { seen.push({ url, h }); return url.includes("wham") ? { status: 200, body: { plan_type: "plus", rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000 } } } }
    : url.includes("settings") ? { status: 200, body: { settings: { subscription_tier_display: "SuperGrok" } } } : url.includes("credits") ? { status: 200, body: { config: { creditUsagePercent: 61 } } } : { status: 404, body: null }; };
  const c = await codexUsage(env, ok);
  assert.deepEqual(c, { plan: "plus", usage: [{ label: "5 小时", used: 30, resetsAt: null }], why: null });
  assert.equal(seen[0].h.Authorization, `Bearer ${SECRET}`);
  assert.equal(seen[0].h["ChatGPT-Account-Id"], "acct");
  const g = await grokUsage(env, ok);
  assert.deepEqual(g, { plan: "SuperGrok", usage: [{ label: "额度", used: 61, resetsAt: null }], why: null });
  assert.equal(seen.find((s) => s.url.includes("credits"))!.h["X-XAI-Token-Auth"], "xai-grok-cli");
  const denied: GetJson = async () => ({ status: 401, body: null });
  assert.match((await codexUsage(env, denied)).why!, /HTTP 401.*重新登录/);
  assert.match((await grokUsage(env, denied)).why!, /HTTP 401/);
  const down: GetJson = async () => { throw new Error("ECONNRESET"); };
  assert.match((await grokUsage(env, down)).why!, /连不上/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("一家的状态: 没装 / 装了没登 (不去读额度) / 登了带额度; 回给界面的东西里没有令牌", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-test-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const exe = process.platform === "win32" ? ".exe" : "";
  const env = { PATH: bin, PATHEXT: ".EXE;.CMD", USERPROFILE: dir, HOME: dir };
  assert.equal((await accountOf(spec("codex"), env)).installed, false);
  fs.writeFileSync(path.join(bin, `codex${exe}`), "");
  let gets = 0;
  const get: GetJson = async () => { gets++; return { status: 200, body: { plan_type: "plus", rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000 } } } }; };
  const out = (version: string, status: { code: number; out: string }): Run => async (_f, args) => (args[0] === "--version" ? { code: 0, out: version, timedOut: false } : { ...status, timedOut: false });
  const off = await accountOf(spec("codex"), env, out("codex-cli 0.50.0", { code: 1, out: "Not logged in" }), get);
  assert.deepEqual([off.installed, off.version, off.signedIn, gets], [true, "0.50.0", false, 0]);
  fs.mkdirSync(path.join(dir, ".codex"));
  fs.writeFileSync(path.join(dir, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: SECRET } }));
  const on = await accountOf(spec("codex"), env, out("codex-cli 0.50.0", { code: 0, out: "Logged in using ChatGPT" }), get);
  assert.deepEqual([on.signedIn, on.plan, on.usage.map((w) => w.used), on.login], [true, "ChatGPT 订阅", [30], "codex login"]);
  assert.ok(!JSON.stringify(on).includes(SECRET));
  // grok: 没有查状态的命令, 看登录文件
  fs.writeFileSync(path.join(bin, `grok${exe}`), "");
  const g = await accountOf(spec("grok"), env, out("grok 1.0.41", { code: 0, out: "" }), get);
  assert.deepEqual([g.installed, g.signedIn, g.usage.length], [true, false, 0]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Claude 有官方额度 (实跑时大脑输出的) 就用它, 不去读用量接口", async () => {
  const official = { t: 1, status: "allowed", windows: { seven_day: { utilization: 0.44, resetsAt: 1794049200 } } };
  assert.deepEqual(await claudeUsage({}, async () => { throw new Error("不该去读用量接口"); }, official),
    { usage: [{ label: "7 天", used: 44, resetsAt: new Date(1794049200 * 1000).toISOString() }], why: null });
});

test("登录窗口的命令行: 标题、程序带引号、登完停住等你看", () => {
  const line = loginCommandLine(spec("grok"), "C:\\Users\\x\\.grok\\bin\\grok.exe");
  assert.equal(line, `/d /c start "登录 Grok Build" cmd.exe /d /c ""C:\\Users\\x\\.grok\\bin\\grok.exe" login & echo. & echo 登录完了就可以关掉这个窗口, 界面里的账号页会自己更新 & pause"`);
  assert.match(loginCommandLine(spec("claude"), "C:\\c.exe"), /""C:\\c\.exe" auth login &/);
});

test("DeepSeek 余额 (官方文档的回复样例) 和 GLM 额度 (照智谱插件的回复形状; HTTP 200 正文里报错也算不认)", () => {
  assert.deepEqual(parseDeepseekBalance({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1.00", granted_balance: "0", topped_up_balance: "1.00" },
    { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }] }),
    { currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00", enough: true });
  assert.equal(parseDeepseekBalance({ balance_infos: [] }), null);
  assert.deepEqual(parseGlmQuota({ code: 200, msg: "操作成功", success: true, data: { limits: [
    { type: "TOKENS_LIMIT", percentage: 23, nextResetTime: 1_800_000_000_000 }, { type: "TIME_LIMIT", percentage: 5, currentValue: 50, usage: 1000 }] } }),
    { usage: [{ label: "5 小时", used: 23, resetsAt: new Date(1_800_000_000_000).toISOString() }, { label: "MCP 每月", used: 5, resetsAt: null }], rejected: null });
  assert.deepEqual(parseGlmQuota({ code: 1001, msg: "令牌已过期或验证不正确", success: false }), { usage: [], rejected: "令牌已过期或验证不正确" });
});

test("用密钥查: DeepSeek 带 Bearer; GLM 不带 Bearer, 国内不认再试国际版; 401 = 不认, 连不上 = 说不准", async () => {
  const seen: { url: string; h: Record<string, string> }[] = [];
  const get = (map: Record<string, { status: number; body: unknown }>): GetJson => async (url, h) => { seen.push({ url, h }); const k = Object.keys(map).find((x) => url.includes(x)); if (!k) throw new Error("ECONNREFUSED"); return map[k]; };
  const ds = await checkKey("deepseek", SECRET, {}, get({ "api.deepseek.com/user/balance": { status: 200, body: { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "5.20", granted_balance: "0", topped_up_balance: "5.20" }] } } }));
  assert.deepEqual([ds.signedIn, ds.balance?.total, ds.why], [true, "5.20", null]);
  assert.equal(seen.at(-1)!.h.Authorization, `Bearer ${SECRET}`);
  assert.match((await checkKey("deepseek", SECRET, {}, get({ deepseek: { status: 401, body: null } }))).why!, /不认这个密钥 \(HTTP 401\)/);
  assert.equal((await checkKey("deepseek", SECRET, {}, get({}))).signedIn, null);
  seen.length = 0;
  const glm = await checkKey("glm", SECRET, {}, get({ "open.bigmodel.cn": { status: 401, body: null }, "api.z.ai": { status: 200, body: { data: { limits: [{ type: "TOKENS_LIMIT", percentage: 40 }] } } } }));
  assert.deepEqual([glm.signedIn, glm.plan, glm.usage.map((w) => [w.label, w.used])], [true, "Z.ai (国际)", [["5 小时", 40]]]);
  assert.deepEqual(seen.map((s) => [new URL(s.url).host, s.h.Authorization]), [["open.bigmodel.cn", SECRET], ["api.z.ai", SECRET]]);
  const bad = await checkKey("glm", SECRET, {}, get({ "open.bigmodel.cn": { status: 200, body: { success: false, code: 1001, msg: "令牌不正确" } }, "api.z.ai": { status: 401, body: null } }));
  assert.deepEqual([bad.signedIn, bad.why], [false, "GLM 不认这个密钥 (HTTP 401): 检查有没有复制全、是不是这家的密钥"]);
});

test("密钥存本机文件: 格式检查、存、删; 账号里只回末 4 位", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-test-"));
  const file = path.join(dir, "accounts", "keys.json");
  assert.equal(cleanKey("  sk-abcdef123456 \n"), "sk-abcdef123456");
  assert.equal(cleanKey("有中文的密钥123"), null);
  assert.equal(cleanKey("sk 有空格 1234"), null);
  assert.equal(cleanKey("short"), null);
  assert.throws(() => saveKey(file, "deepseek", "bad key"), /格式不对/);
  const spec = KEY_PROVIDERS.find((p) => p.id === "deepseek")!;
  const none = await keyAccountOf(spec, file, {}, async () => { throw new Error("不该去查"); });
  assert.deepEqual([none.kind, none.signedIn, none.keyTail, none.keyUrl], ["key", false, null, "https://platform.deepseek.com/api_keys"]);
  saveKey(file, "deepseek", `  ${SECRET}  `);
  assert.deepEqual(readKeys(file), { deepseek: SECRET });
  const got = await keyAccountOf(spec, file, {}, async () => ({ status: 200, body: { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "9.00", granted_balance: "0", topped_up_balance: "9.00" }] } }));
  assert.deepEqual([got.signedIn, got.keyTail, got.balance?.total], [true, SECRET.slice(-4), "9.00"]);
  assert.ok(!JSON.stringify(got).includes(SECRET));
  saveKey(file, "deepseek", "");
  assert.deepEqual(readKeys(file), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("中转站 (New API, 2026-11-04): 地址清理、存三样、用令牌读模型表和余额; 401 = 不认, 没地址 = 没填", async () => {
  // 地址: 补 https、去末尾 / 和 /v1 (Claude Code 自己加 /v1); 不是网址 → null
  assert.equal(cleanUrl("ai.example.com"), "https://ai.example.com");
  assert.equal(cleanUrl(" https://ai.example.com/v1/ "), "https://ai.example.com");
  assert.equal(cleanUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.equal(cleanUrl("https://x.y/sub/v1"), "https://x.y/sub");
  assert.deepEqual([cleanUrl(""), cleanUrl("ftp://a.b"), cleanUrl("有 空格.com"), cleanUrl("https://")], [null, null, null, null]);
  // 存: 没给的不动, key 空 = 整个删掉
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
  const file = path.join(dir, "keys.json");
  saveKey(file, "deepseek", SECRET);
  assert.throws(() => saveRelay(file, { url: "not a url", key: SECRET }), /地址不对/);
  assert.throws(() => saveRelay(file, { url: "https://a.b", key: "bad key" }), /令牌格式不对/);
  saveRelay(file, { url: "a.b/v1", key: `  ${SECRET} ` });
  assert.deepEqual(relayConfig(readKeys(file)), { url: "https://a.b", key: SECRET, model: "", access: "", user: "" });
  saveRelay(file, { model: "glm-5.3" });
  assert.deepEqual(readKeys(file), { deepseek: SECRET, relay: SECRET, relay_url: "https://a.b", relay_model: "glm-5.3" }, "只给 model 时令牌和地址不动, 别家的也不动");
  assert.throws(() => saveRelay(file, { model: "有中文" }), /模型名不对/);
  assert.throws(() => saveRelay(file, { access: "ok-access-token", user: "abc" }), /用户 ID 要是数字/);
  saveRelay(file, { access: " access-fixture-token ", user: "7" });
  assert.deepEqual(relayConfig(readKeys(file)), { url: "https://a.b", key: SECRET, model: "glm-5.3", access: "access-fixture-token", user: "7" });
  saveRelay(file, { access: "" });
  assert.equal(relayConfig(readKeys(file)).user, "", "删系统访问令牌时用户 ID 一起删");
  saveRelay(file, { key: "" });
  assert.deepEqual(readKeys(file), { deepseek: SECRET }, "删中转站 = 几样一起删");
  // 解析: 模型表去重排序, 价目表里标了 anthropic 格式的排前面; 账单 hard_limit_usd 剩余 (美元) + total_usage 已用 (美分)
  assert.deepEqual(parseRelayModels({ object: "list", data: [{ id: "glm-5.3" }, { id: "deepseek-v4-pro" }, { id: "glm-5.3" }, { nope: 1 }] }).map((m) => [m.id, m.formats]), [["deepseek-v4-pro", []], ["glm-5.3", []]]);
  const pricing = { data: [{ model_name: "glm-5.3", supported_endpoint_types: ["openai-response", "openai", "anthropic"] }, { model_name: "grok-4.7", supported_endpoint_types: ["openai"] }] };
  assert.deepEqual(parseRelayModels({ data: [{ id: "grok-4.7" }, { id: "glm-5.3" }, { id: "aaa" }] }, pricing).map((m) => [m.id, m.formats.includes("anthropic")]), [["glm-5.3", true], ["aaa", false], ["grok-4.7", false]]);
  assert.deepEqual(parseRelayModels({}), []);
  const b = parseRelayBalance({ hard_limit_usd: 12.5 }, { total_usage: 731 });
  assert.deepEqual([b?.currency, b?.total, b?.toppedUp, b?.enough, b?.note?.includes("已用 $7.31")], ["USD", "12.50", "7.31", true, true]);
  assert.equal(parseRelayBalance({ hard_limit_usd: 0 }, null)?.enough, false);
  assert.equal(parseRelayBalance({}, { total_usage: 1 }), null);
  // 不限额的令牌站回 1 亿: 显示不限额, 账户余额走用户级接口 (500000 = $1)
  const u = parseRelayBalance({ hard_limit_usd: 100000000 }, { total_usage: 0 });
  assert.deepEqual([u?.total, u?.enough, u?.note?.includes("没设上限")], ["不限额", true, true]);
  const me = parseRelayUser({ success: true, data: { id: 7, username: "mk", quota: 50_000_000, used_quota: 1_250_000 } });
  assert.deepEqual([me?.total, me?.toppedUp, me?.enough, me?.note], ["100.00", "2.50", true, "账户余额 (mk) · 累计已用 $2.50 · 按 500000 = $1 折算 (待核)"]);
  assert.equal(parseRelayUser({ success: false, message: "无权进行此操作" }), null);
  // 查: /v1/models 带 Bearer; 账单读不到不算失败
  const seen: string[] = [];
  const get = (map: Record<string, { status: number; body: unknown }>): GetJson => async (url, h) => { seen.push(`${url} ${h.Authorization}`); const k = Object.keys(map).find((x) => url.includes(x)); if (!k) throw new Error("ECONNREFUSED"); return map[k]; };
  const ok = await checkKey("relay", SECRET, {}, get({ "/v1/models": { status: 200, body: { data: [{ id: "glm-5.3" }, { id: "kimi-k3" }] } }, "/api/pricing": { status: 200, body: pricing },
    "billing/subscription": { status: 200, body: { hard_limit_usd: 20 } }, "billing/usage": { status: 200, body: { total_usage: 250 } } }), 8_000, "https://a.b/");
  assert.deepEqual([ok.signedIn, ok.plan, ok.models?.map((m) => m.id), ok.balance?.total, ok.why], [true, "2 个模型, 1 个标了 Claude 格式", ["glm-5.3", "kimi-k3"], "20.00", null]);
  assert.equal(seen[0], `https://a.b/v1/models Bearer ${SECRET}`);
  assert.ok(seen.some((s) => s.startsWith("https://a.b/api/pricing")), "读了公开价目表");
  const noBill = await checkKey("relay", SECRET, {}, get({ "/v1/models": { status: 200, body: { data: [{ id: "glm-5.3" }] } } }), 8_000, "https://a.b");
  assert.deepEqual([noBill.signedIn, noBill.balance, noBill.why], [true, null, "余额没读到 (站的账单接口没开或格式不同), 不影响用"]);
  // 填了系统访问令牌 + 用户 ID: 读用户级余额, 盖过令牌级的"不限额"; 头是 Bearer 系统访问令牌 + New-Api-User
  seen.length = 0;
  const acct = await checkKey("relay", SECRET, {}, get({ "/v1/models": { status: 200, body: { data: [{ id: "glm-5.3" }] } }, "billing/subscription": { status: 200, body: { hard_limit_usd: 100000000 } },
    "/api/user/self": { status: 200, body: { success: true, data: { id: 7, quota: 50_000_000, used_quota: 0 } } } }), 8_000, "https://a.b", { access: "access-fixture-token", user: "7" });
  assert.deepEqual([acct.balance?.total, acct.why], ["100.00", null]);
  const self = seen.find((s) => s.includes("/api/user/self Bearer access-fixture-token"));
  assert.ok(self, "用户接口带系统访问令牌");
  const bad = await checkKey("relay", SECRET, {}, get({ "/v1/models": { status: 200, body: { data: [{ id: "glm-5.3" }] } }, "/api/user/self": { status: 401, body: null } }), 8_000, "https://a.b", { access: "access-fixture-token", user: "7" });
  assert.deepEqual([bad.signedIn, bad.why?.startsWith("系统访问令牌不认 (HTTP 401)")], [true, true], "系统访问令牌不对不影响令牌本身能用");
  assert.match((await checkKey("relay", SECRET, {}, get({ "/v1/models": { status: 401, body: null } }), 8_000, "https://a.b")).why!, /中转站不认这个密钥 \(HTTP 401\)/);
  assert.deepEqual((await checkKey("relay", SECRET, {}, get({}), 8_000, "")).why, "中转站地址没填 (像 https://ai.example.com, 不用带 /v1)");
  assert.equal((await checkKey("relay", SECRET, {}, get({}), 8_000, "https://a.b")).signedIn, null, "连不上 = 说不准");
  // 账号卡: 没填 → 没查; 填了 → url / model / models 都回; 整个令牌不回
  const spec = KEY_PROVIDERS.find((p) => p.id === "relay")!;
  const none = await keyAccountOf(spec, file, {}, async () => { throw new Error("不该去查"); });
  assert.deepEqual([none.kind, none.signedIn, none.keyTail, none.keyUrl, none.url, none.model, none.models], ["key", false, null, null, null, null, []]);
  saveRelay(file, { url: "https://a.b", key: SECRET, model: "glm-5.3" });
  const got = await keyAccountOf(spec, file, {}, get({ "/v1/models": { status: 200, body: { data: [{ id: "glm-5.3" }] } } }));
  assert.deepEqual([got.signedIn, got.keyTail, got.keyUrl, got.url, got.model, got.models], [true, SECRET.slice(-4), "https://a.b/console/token", "https://a.b", "glm-5.3", [{ id: "glm-5.3", formats: [] }]]);
  assert.ok(!JSON.stringify(got).includes(SECRET));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("控制接口只许界面的页面调 (带 Origin 头时)", () => {
  for (const o of ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:1420", "http://127.0.0.1:1420"]) assert.ok(allowedOrigin(o), o);
  for (const o of ["https://evil.example", "http://localhost:3000", "http://tauri.localhost.evil.com", "null"]) assert.ok(!allowedOrigin(o), o);
});
