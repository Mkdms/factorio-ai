// 控制接口的读数 (src/play/control-lib.ts): 用临时目录造一班的记录文件
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INTERRUPTED_MIN, agentsOf, blueprintsOf, brainLines, currentRun, gameNameOf, gameState, healthNow, latestReview, latestRunQuota, modelFromTurns, nameFromTurns, namesFor, runStatus, safeFhArgs } from "../src/play/control-lib.ts";
import { parseProxyServer, parseRegQuery, useSystemProxy } from "../src/play/sysproxy.ts";
import { DEFAULT_MODEL_NAME, modelDisplayName } from "../src/play/model-name.ts";

const play = fs.mkdtempSync(path.join(os.tmpdir(), "control-test-"));
const run = path.join(play, "runs", "2026-11-03T11-17-28");
fs.mkdirSync(run, { recursive: true });
fs.mkdirSync(path.join(play, "runs", "2026-11-03T10-13-47"));
const w = (f: string, rows: object[]) => fs.writeFileSync(path.join(run, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
w("session-a.json", []); fs.writeFileSync(path.join(run, "session-a.json"), JSON.stringify({ rconPort: 1, password: "x", player: 1 }));
fs.writeFileSync(path.join(run, "session-b.json"), JSON.stringify({ rconPort: 1, password: "x", player: 1, bot: "ai2" }));
w("turn-a-1.jsonl", [{ type: "assistant", message: { content: [{ type: "text", text: "先修铜列煤道" }, { type: "tool_use", name: "Bash", input: { command: "./fh call status" } }] } }]);
w("turn-a-2.jsonl", [{ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "clock 3h" }] }] } }, { type: "user", isReplay: true, message: { content: "插话" } }, { type: "assistant", message: { content: [{ type: "text", text: "研究中心 11/11" }] } }]);
w("turn-b-1.jsonl", [{ type: "assistant", message: { content: [{ type: "text", text: "B 在补蓝瓶" }] } }]);
w("monitor.jsonl", [{ t: 1, tick: 0, researched: 70, labs: 11, labsWorking: 5, busyBy: { a: true, b: false }, machines: 120, redTotal: 0, greenTotal: 0, blueTotal: 0 }, { t: 2, tick: 36000, researched: 71, research: "rocket-silo", labs: 11, labsWorking: 11, busyBy: { a: true, b: true }, machines: 130, redTotal: 150, greenTotal: 160, blueTotal: 140 }]);
w("health.jsonl", [{ lines: ["缺料: 炉子 7 台"] }]);

test("当前班次 = runs 下最新的; 角色从会话文件来", () => {
  assert.equal(currentRun(play), run);
  assert.deepEqual(agentsOf(run).map((a) => [a.id, a.bot ?? null]), [["a", null], ["b", "ai2"]]);
});

test("收起的班 (hidden 标记, 例: 不叫大脑的验证班) 不当最新一班; 全收起了才取最新", () => {
  const newer = path.join(play, "runs", "2026-11-04T06-43-06");
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(newer, "hidden"), "x");
  assert.equal(currentRun(play), run, "更新的那班收起了, 当前班次还是没收起的那班");
  const all = fs.readdirSync(path.join(play, "runs")).map((d) => path.join(play, "runs", d));
  for (const d of all) fs.writeFileSync(path.join(d, "hidden"), "x");
  assert.equal(currentRun(play), newer, "都收起了: 取最新");
  for (const d of all) fs.rmSync(path.join(d, "hidden"), { force: true });
  fs.rmSync(newer, { recursive: true, force: true });
});

test("大脑最近的话: 按轮次排, 分角色, 插话的回显不算", () => {
  assert.deepEqual(brainLines(run, "a"), [{ kind: "说", text: "先修铜列煤道" }, { kind: "命令", text: "./fh call status" }, { kind: "结果", text: "clock 3h" }, { kind: "说", text: "研究中心 11/11" }]);
  assert.deepEqual(brainLines(run, "b").map((l) => l.text), ["B 在补蓝瓶"]);
  assert.equal(brainLines(run, "a", 1)[0].text, "研究中心 11/11");
});

test("游戏读数和体检", () => {
  const g = gameState(run)!;
  assert.equal(g.research, "rocket-silo");
  assert.equal(g.labsWorking, 11);
  assert.deepEqual(g.perMin10, { red: 15, green: 16, blue: 14 });
  assert.deepEqual(healthNow(run), ["缺料: 炉子 7 台"]);
});

test("detail=1 (界面用): 多带时间、命令说明、失败标记; 不带 detail 时格式不变", () => {
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), "control-test-detail-"));
  fs.writeFileSync(path.join(r2, "turn-1.jsonl"), [
    { type: "assistant", timestamp: "2026-11-03T12:00:01.000Z", message: { content: [{ type: "text", text: "去喂炉子" }, { type: "tool_use", name: "Bash", input: { command: "./fh call feed", description: "给炉子加煤" } }] } },
    { type: "user", timestamp: "2026-11-03T12:00:05.000Z", message: { content: [{ type: "tool_result", is_error: true, content: "Exit code 1\nerror: out of reach" }] } },
    { type: "user", timestamp: "2026-11-03T12:00:06.000Z", message: { content: [{ type: "tool_result", content: "ok" }] } },
  ].map((r) => JSON.stringify(r)).join("\n"));
  assert.deepEqual(brainLines(r2, null, 30, true), [
    { kind: "说", text: "去喂炉子", at: "2026-11-03T12:00:01.000Z" },
    { kind: "命令", text: "./fh call feed", at: "2026-11-03T12:00:01.000Z", desc: "给炉子加煤" },
    { kind: "结果", text: "Exit code 1\nerror: out of reach", at: "2026-11-03T12:00:05.000Z", error: true },
    { kind: "结果", text: "ok", at: "2026-11-03T12:00:06.000Z" },
  ]);
  assert.deepEqual(brainLines(r2, null).map((l) => Object.keys(l).sort().join()), ["kind,text", "kind,text", "kind,text", "kind,text"]);
  fs.rmSync(r2, { recursive: true });
});

test("最近一份复盘: 在跑的这班还没有就往前找上一班的; 都没有是 null", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "control-test-empty-"));
  assert.equal(latestReview(empty), null);
  assert.equal(latestReview(play), null);
  fs.writeFileSync(path.join(play, "runs", "2026-11-03T10-13-47", "review.json"), JSON.stringify({ lines: ["研究: 59 → 70 项"], fixes: ["先补绿瓶"] }));
  assert.deepEqual(latestReview(play), { run: "2026-11-03T10-13-47", lines: ["研究: 59 → 70 项"], fixes: ["先补绿瓶"] });
  fs.writeFileSync(path.join(run, "review.json"), JSON.stringify({ lines: ["本班"], fixes: [] }));
  assert.equal(latestReview(play)!.run, "2026-11-03T11-17-28");
  fs.rmSync(path.join(run, "review.json"));
});

test("内部名 → 官方中文名: 逗号分开、去重、去空, 找不到原样回", () => {
  const zh = (n: string) => ({ "mining-productivity-2": "采矿产能 2" })[n] ?? n;
  assert.deepEqual(namesFor(" mining-productivity-2 ,x,,x", zh), { "mining-productivity-2": "采矿产能 2", x: "x" });
  assert.deepEqual(namesFor("", zh), {});
  assert.equal(Object.keys(namesFor(Array.from({ length: 500 }, (_, i) => `n${i}`).join(","), zh)).length, 200);
});

test("模型显示名: 别名、完整 id、以后的 grok; 什么都没有用 Claude Opus 5.5", () => {
  assert.equal(modelDisplayName("claude", "opus"), "Claude Opus 5.5");
  assert.equal(modelDisplayName("claude", "sonnet"), "Claude Sonnet 5.5");
  assert.equal(modelDisplayName("claude", "haiku"), "Claude Haiku 5.5");
  assert.equal(modelDisplayName("claude", "claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(modelDisplayName("claude", "claude-sonnet-4-5-20250929"), "Claude Sonnet 4.5");
  assert.equal(modelDisplayName("grok", ""), "Grok 4.7");
  assert.equal(modelDisplayName("grok", "grok-4.7"), "Grok-4.7", "别家 = 模型名规范写法");
  assert.equal(modelDisplayName("codex", "gpt-5.5"), "Gpt-5.5");
  assert.equal(modelDisplayName("relay", "glm-5.3"), "Glm-5.3");
  assert.equal(modelDisplayName(undefined, undefined), DEFAULT_MODEL_NAME);
  assert.equal(DEFAULT_MODEL_NAME, "Claude Opus 5.5");
});

test("角色的游戏名和模型: 会话文件有就用; 旧会话文件模型从大脑轮次文件第一行读, 再没有用 Claude Opus 5.5; 游戏名 → bot → RCON 读到的 → 玩家 N", () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "control-test-names-"));
  fs.writeFileSync(path.join(r, "session-a.json"), JSON.stringify({ rconPort: 1, password: "x", player: 1, name: "MK", model: "Claude Sonnet 5.5" }));
  fs.writeFileSync(path.join(r, "session-b.json"), JSON.stringify({ rconPort: 1, password: "x", player: 1, bot: "ai2" }));
  fs.writeFileSync(path.join(r, "session-c.json"), JSON.stringify({ rconPort: 1, password: "x", player: 2 }));
  fs.writeFileSync(path.join(r, "turn-b-1.jsonl"), [{ type: "system", subtype: "init", model: "claude-haiku-5-5" }, { type: "assistant", message: { content: [] } }].map((o) => JSON.stringify(o)).join("\n") + "\n");
  const got = agentsOf(r).map((a) => [a.id, a.name ?? null, a.model, gameNameOf(a)]);
  assert.deepEqual(got, [["a", "MK", "Claude Sonnet 5.5", "MK"], ["b", null, "Claude Haiku 5.5", "ai2"], ["c", null, "Claude Opus 5.5", "玩家 2"]]);
  assert.equal(gameNameOf({ player: 1 }, "MK"), "MK");
  assert.equal(gameNameOf({ name: "MK", bot: "ai2" }, "别的"), "MK");
  assert.equal(modelFromTurns(r, "c"), null);
  // 原来的会话文件 (没有 name / model) 也照样读
  assert.deepEqual(agentsOf(run).map((a) => a.model), ["Claude Opus 5.5", "Claude Opus 5.5"]);
});

test("这一班大脑输出里最近的官方额度事件 (quota.jsonl): 太旧的不用", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-quota-"));
  assert.equal(latestRunQuota(dir), null, "没有文件");
  const row = (t: number, u: number) => JSON.stringify({ agent: "a", t, status: "allowed", type: "seven_day", windows: { seven_day: { utilization: u, resetsAt: 1794049200 } } });
  fs.writeFileSync(path.join(dir, "quota.jsonl"), [row(1_000, 0.4), row(2_000, 0.41), "坏行"].join("\n") + "\n");
  assert.deepEqual(latestRunQuota(dir, 60_000, 30_000), { t: 2_000, status: "allowed", type: "seven_day", windows: { seven_day: { utilization: 0.41, resetsAt: 1794049200 } } });
  assert.equal(latestRunQuota(dir, 60_000, 2_000 + 60_001), null, "超过 1 分钟没新的");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("一班的状态: 收尾了 / 在跑 / 中断了 (没收尾、30 分钟没有新记录)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-status-"));
  fs.writeFileSync(path.join(dir, "monitor.jsonl"), JSON.stringify({ t: 1_000_000, tick: 0 }) + "\n");
  const old = new Date(1_000_000);
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old);
  assert.deepEqual(runStatus(dir, 1_000_000 + 60_000), { ended: false, interrupted: false, lastAt: 1_000_000 });
  assert.equal(runStatus(dir, 1_000_000 + (INTERRUPTED_MIN + 1) * 60_000).interrupted, true);
  fs.writeFileSync(path.join(dir, "turn-a-3.jsonl"), "{}\n"); // 大脑还在写 → 不算中断
  assert.equal(runStatus(dir, Date.now() + 60_000).interrupted, false);
  fs.writeFileSync(path.join(dir, "summary.json"), "{}");
  assert.deepEqual([runStatus(dir).ended, runStatus(dir, Date.now() + 99 * 3_600_000).interrupted], [true, false]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("旧会话文件没存游戏名: 从大脑第一轮读到的交接笔记 (its notes.md for MK) 读; 没有就 null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-name-"));
  fs.writeFileSync(path.join(dir, "turn-a-1.jsonl"), JSON.stringify({ type: "user", message: { content: "(Carried over from the previous shift, run 2026-11-03T10-13-47: its notes.md for MK, as that shift left it.)" } }) + "\n");
  assert.equal(nameFromTurns(dir, "a"), "MK");
  assert.equal(nameFromTurns(dir, "b"), null);
  assert.equal(gameNameOf({ player: 1 }, nameFromTurns(dir, "a")), "MK");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Windows 系统代理: reg query 输出、分协议的写法; 已经设了代理变量就不动", () => {
  const out = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:10809\r\n";
  assert.equal(parseRegQuery(out), "http://127.0.0.1:10809");
  assert.equal(parseRegQuery(out.replace("0x1", "0x0")), null, "没开");
  assert.equal(parseProxyServer("http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080"), "http://127.0.0.1:8443");
  assert.equal(parseProxyServer("socks=127.0.0.1:1080"), null);
  const env: NodeJS.ProcessEnv = {};
  assert.equal(useSystemProxy(env, () => "http://127.0.0.1:10809"), "http://127.0.0.1:10809");
  assert.deepEqual([env.HTTPS_PROXY, env.HTTP_PROXY, env.NO_PROXY], ["http://127.0.0.1:10809", "http://127.0.0.1:10809", "127.0.0.1,localhost"]);
  assert.equal(useSystemProxy({ HTTPS_PROXY: "http://x:1" }, () => { throw new Error("不该读"); }), null);
});

test("这一班看过的蓝图: 同一张只留最后一次、新的在前, 短字符串有 #source= 预览链接", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "control-bp-"));
  const row = (cmd: string, label: string, t: string, bp = "0eNqrVkrKKU0t") => JSON.stringify({ at: t, agent: "a", cmd, no: 3, label, source: "生成", w: 30, h: 12, bp });
  fs.writeFileSync(path.join(d, "blueprints.jsonl"), [row("show", "冶炼列", "2026-11-04T05:00:00Z"), row("show", "组装机排", "2026-11-04T05:01:00Z"), row("build", "冶炼列", "2026-11-04T05:02:00Z")].join("\n") + "\n");
  const out = blueprintsOf(d);
  assert.deepEqual(out.map((b) => [b.label, b.cmd]), [["冶炼列", "build"], ["组装机排", "show"]]);
  assert.match(out[0].link ?? "", /^http.*#source=0eNqrVkrKKU0t$/);
  assert.equal("bp" in out[0], false, "蓝图字符串本身不发给界面");
  assert.deepEqual(blueprintsOf(path.join(d, "none")), []);
  // 长蓝图没设 FBE_DIR 就没有链接 (不往不存在的目录写文件)
  const saved = process.env.FBE_DIR; delete process.env.FBE_DIR;
  fs.writeFileSync(path.join(d, "blueprints.jsonl"), row("file", "大基地", "2026-11-04T05:03:00Z", "x".repeat(3000)) + "\n");
  assert.equal(blueprintsOf(d)[0].link, null);
  if (saved !== undefined) process.env.FBE_DIR = saved;
});

test("手动命令只许 ./fh 的参数", () => {
  assert.equal(safeFhArgs("./fh call status"), "call status");
  assert.equal(safeFhArgs(`call build --args '{"item":"stone-furnace"}'`), `call build --args '{"item":"stone-furnace"}'`);
  for (const bad of ["call status; rm -rf /", "call status | tee x", "call $(whoami)", "call x > f", "", "call a && b"]) assert.equal(safeFhArgs(bad), null, bad);
});
