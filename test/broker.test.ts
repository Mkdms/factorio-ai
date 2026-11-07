// 本地中转和模型命令行 (不开游戏): 令牌管角色、只转动作、坏请求报清楚; fa 的参数解析和输出格式; fa 经中转跑一条并写记录。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startBroker, whoOf } from "../core/broker.ts";
import { parseArgv, formatReply } from "../commands/fa.ts";
import { compact, cap } from "../commands/format.ts";

test("令牌 → 角色: 对上才认, 格式不对不认", () => {
  const tokens = new Map([["A", "tokA"], ["B", "tokB"]]);
  assert.equal(whoOf(tokens, "Bearer tokB"), "B");
  assert.equal(whoOf(tokens, "Bearer nope"), null);
  assert.equal(whoOf(tokens, "tokA"), null);
  assert.equal(whoOf(tokens, undefined), null);
});

test("中转: 只转 POST /act, 角色由令牌定 (请求里写别人也没用), 坏 JSON / 缺 action / 游戏不通都报清楚", async () => {
  const seen: unknown[] = [];
  const b = await startBroker({ agents: ["A", "B"], dispatch: async (req) => { seen.push(req); if (req.action === "boom") throw new Error("游戏没回"); return { id: req.id, ok: true, tick: 1, result: { who: req.who, action: req.action } }; } });
  try {
    const post = (token: string | null, body: string, url = "/act") => fetch(b.url + url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
    assert.equal((await (await fetch(b.url + "/ping")).json()).ok, true);
    assert.equal((await post(b.tokens.get("A")!, "{}", "/other")).status, 404);
    assert.equal((await post(null, JSON.stringify({ action: "status" }))).status, 401);
    assert.equal((await post("wrong", JSON.stringify({ action: "status" }))).status, 401);
    assert.equal((await post(b.tokens.get("A")!, "not json")).status, 400);
    assert.equal((await post(b.tokens.get("A")!, JSON.stringify({ args: {} }))).status, 400);
    const ok = await (await post(b.tokens.get("B")!, JSON.stringify({ id: "x1", who: "A", action: "status", args: { radius: 3 } }))).json();
    assert.deepEqual(ok.result, { who: "B", action: "status" }, "令牌是 B 的, 冒充 A 没用");
    assert.deepEqual(seen.at(-1), { id: "x1", who: "B", action: "status", args: { radius: 3 } });
    const down = await post(b.tokens.get("A")!, JSON.stringify({ action: "boom" }));
    assert.equal(down.status, 502);
    assert.equal((await down.json()).error.code, "game_unreachable");
  } finally { await b.close(); }
});

test("fa 参数解析: help、动作、JSON 对象、@文件、不是对象 / 不是 JSON 报错", () => {
  assert.equal(parseArgv([]).help, true);
  assert.equal(parseArgv(["help"]).help, true);
  assert.deepEqual(parseArgv(["status"]), { action: "status", args: {}, json: false });
  assert.deepEqual(parseArgv(["observe", '{"radius": 32}', "--json"]), { action: "observe", args: { radius: 32 }, json: true });
  const f = path.join(os.tmpdir(), `fa-args-${process.pid}.json`);
  fs.writeFileSync(f, '{"text": "你好"}');
  assert.deepEqual(parseArgv(["say", `@${f}`]).args, { text: "你好" });
  fs.rmSync(f);
  assert.match(parseArgv(["say", "[1,2]"]).error ?? "", /JSON 对象/);
  assert.match(parseArgv(["say", "{bad"]).error ?? "", /不是 JSON/);
  assert.match(parseArgv(["say", "@/no/such/file"]).error ?? "", /读不到/);
});

test("输出格式: 紧凑文字、错误带代码、超长截断", () => {
  const text = formatReply({ ok: true, result: { name: "A", position: { x: 1.26, y: -2 }, items: [{ name: "iron-plate", count: 8 }], tags: ["a", "b"], empty: {} } }, false);
  assert.match(text, /^name: A$/m);
  assert.match(text, /position: \{x: 1\.26, y: -2\}/);
  assert.match(text, /- \{name: iron-plate, count: 8\}/);
  assert.match(text, /empty: \(空\)/);
  assert.equal(formatReply({ ok: false, error: { code: "unknown_action", message: "没有动作 fly" } }, false), "error: 没有动作 fly (unknown_action)");
  assert.equal(formatReply({ ok: true, result: 1 }, true), '{"ok":true,"result":1}');
  const long = cap(compact({ list: Array.from({ length: 2000 }, (_, i) => ({ i })) }), 500);
  assert.ok(long.length < 700 && long.includes("截断"));
});

test("fa 经中转跑一条: 打印回复、写记录; 没有令牌时报错", async () => {
  const b = await startBroker({ agents: ["A"], dispatch: async (req) => ({ id: req.id, ok: true, tick: 5, result: { got: req.action, args: req.args } }) });
  const journal = path.join(os.tmpdir(), `fa-journal-${process.pid}.jsonl`);
  fs.rmSync(journal, { force: true });
  try {
    const env = { ...process.env, FA_BROKER: b.url, FA_TOKEN: b.tokens.get("A")!, FA_JOURNAL: journal };
    const r = spawnSync(process.execPath, ["commands/fa.ts", "observe", '{"radius": 8}'], { cwd: path.join(import.meta.dirname, ".."), env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /got: observe/);
    assert.match(r.stdout, /args: \{radius: 8\}/);
    const lines = fs.readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].request.action, "observe");
    assert.equal(lines[0].reply.ok, true);
    const none = spawnSync(process.execPath, ["commands/fa.ts", "status"], { cwd: path.join(import.meta.dirname, ".."), env: { ...process.env, FA_BROKER: "", FA_TOKEN: "" }, encoding: "utf8" });
    assert.equal(none.status, 2);
    assert.match(none.stdout, /FA_BROKER/);
  } finally { await b.close(); fs.rmSync(journal, { force: true }); }
});
