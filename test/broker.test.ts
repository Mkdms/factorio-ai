// ./fh ↔ 游戏外模组的代理: 请求解析和路由 (commands/broker.ts); 真游戏上跑的是 test/sandbox/actions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandBroker, MEM_READS, RconPipe, isReaderRefusal, parseDispatch, routeOf } from "../commands/broker.ts";
import { readOnlyActions } from "../commands/actions.ts";

// 派对命令行 harness.js luaString 的写法
const luaString = (value: string) => {
  let equals = "";
  while (value.includes(`]${equals}]`) || value.endsWith(`]${equals}`)) equals += "=";
  return `[${equals}[\n${value}]${equals}]`;
};
const dispatch = (req: unknown) => `/silent-command rcon.print(remote.call("agent_harness", "dispatch", ${luaString(JSON.stringify(req))}))`;

test("解析: 派对命令行发的请求, 里面带 ]] 也能拆", () => {
  const d = parseDispatch(dispatch({ id: "x", action: "observe", player: 3, args: { radius: 8, s: "a]]b]=]" } }));
  assert.equal(d?.request.action, "observe");
  assert.equal((d?.request.args as { s: string }).s, "a]]b]=]");
  assert.equal(parseDispatch('/silent-command local i=remote.interfaces.agent_harness; rcon.print(i)'), null);
  assert.equal(parseDispatch("/silent-command rcon.print(remote.call(\"agent_harness\", \"dispatch\", [[\n不是 JSON]]))"), null);
});

test("路由: 沙盘只有核过的读命令走外面, 轮询和动作走真 RCON", () => {
  const d = (action: string, args: Record<string, unknown> = {}) => parseDispatch(dispatch({ id: "x", action, args }));
  for (const a of MEM_READS) assert.equal(routeOf(d(a), "sandbox"), "mem", a);
  assert.equal(routeOf(d("status", { brief: true }), "sandbox"), "rcon", "--wait 轮询要看模组里的动作走到哪");
  assert.equal(routeOf(d("observe", { scope: "sleep_check" }), "sandbox"), "rcon", "命令行把 sleep_check 发成 observe + scope");
  assert.equal(routeOf(d("observe", { scope: "power" }), "sandbox"), "rcon", "没核过的视图还问模组");
  assert.equal(routeOf(d("observe", { scope: "nearest" }), "sandbox"), "mem");
  assert.equal(routeOf(d("build"), "sandbox"), "rcon");
  assert.equal(routeOf(null, "sandbox"), "rcon");
});

test("路由: 真服没有 RCON, 全问外面; 不是请求的直接拒绝", () => {
  const d = (action: string) => parseDispatch(dispatch({ id: "x", action, args: {} }));
  assert.equal(routeOf(d("build"), "server"), "mem");
  assert.equal(routeOf(d("status"), "server"), "mem");
  assert.equal(routeOf(null, "server"), "refuse");
});

test("认得出模组只读闸门的拒绝", () => {
  assert.equal(isReaderRefusal(JSON.stringify({ ok: false, error: { message: "reader ext: build acts as the agent (it can drive the character); a reader request takes reads only" } })), true);
  assert.equal(isReaderRefusal(JSON.stringify({ ok: false, error: { message: "no such thing" } })), false);
  assert.equal(isReaderRefusal(JSON.stringify({ ok: true, result: {} })), false);
  assert.equal(isReaderRefusal("不是 JSON"), false);
});

// 不起真进程: 把问模组宿主那一步换掉, 看代理怎么回
class FakeBroker extends CommandBroker {
  replies: Record<string, string> = {};
  asked: string[] = [];
  protected override async ask2(raw: string) { this.asked.push(raw); return { ms: 3, text: this.replies[(JSON.parse(raw) as { action: string }).action] }; }
}

test("读被重发: 世界大了一次读超过 5 秒, 同一个 id 接到第一次的结果上, 不再读一遍", async () => {
  let release = () => {};
  class Slow extends FakeBroker {
    protected override async ask2(raw: string) { this.asked.push(raw); await new Promise<void>((r) => { release = r; }); return { ms: 3, text: JSON.stringify({ id: "r1", ok: true, result: { n: this.asked.length } }) }; }
  }
  const b = new Slow({ pipe: "x", python: "x", probeArgs: [], mode: "server" });
  const req = dispatch({ id: "r1", action: "status", args: {} });
  const first = b.handle(req), retry = b.handle(req);
  await new Promise((r) => setTimeout(r, 10));
  release();
  assert.deepEqual(await first, await retry);
  assert.equal(b.asked.length, 1);
  const later = b.handle(dispatch({ id: "r2", action: "status", args: {} }));
  await new Promise((r) => setTimeout(r, 10));
  release();
  await later;
  assert.equal(b.asked.length, 2, "新的 id 照常读");
});

test("只读: 所有动作在代理就拒了, 连模组宿主都不问; 读照常", async () => {
  const b = new FakeBroker({ pipe: "x", python: "x", probeArgs: [], mode: "server", actions: readOnlyActions(async () => 395898) });
  b.replies = { status: JSON.stringify({ id: "s", ok: true, result: {} }) };
  for (const action of ["say", "craft", "research", "build", "move_to", "transfer", "mine", "rotate", "build_path", "collect", "refuel", "feed"]) {
    // research 不带要改的参数是查队列, 模组自己答, 不算动作 (isResearchRead)
    const out = await b.handle(dispatch({ id: `a-${action}`, action, args: action === "research" ? { technology: "automation" } : {} }));
    const reply = JSON.parse(out.text ?? "{}") as { ok: boolean; tick: number; error?: { code: string; message: string } };
    assert.equal(reply.ok, false, action);
    assert.equal(reply.tick, 395898, "写 0 命令行会当成世界回档了");
    assert.equal(reply.error?.code, "read_only", action);
    assert.match(reply.error?.message ?? "", /什么都没发给游戏/);
  }
  assert.equal(b.asked.length, 0);
  assert.equal((await b.handle(dispatch({ id: "s", action: "status", args: {} }))).ok, true);
  assert.equal(b.asked.length, 1);
});

// 假的模组宿主: 收到请求先回问一句 (和 modhost_probe.py 的 py_lua 一样), 等到回复才答; 启动参数原样报回来
const FAKE_HOST = `
const rl = require("node:readline").createInterface({ input: process.stdin });
console.log(JSON.stringify({ ready: true, load: { ok: true } }));
let asked = null;
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if ("lua_reply" in m) { console.log(JSON.stringify({ tick: 7, reply: m, argv: process.argv.slice(1), req: asked })); return; }
  asked = m;
  console.log(JSON.stringify({ lua_read: { selection: { kind: "players" } }, seq: 5 }));
});`;

test("模组宿主起来前就退了: 立刻报退出码和错误, 不干等 (2026-11-06 全新目录缺 pdb-dump, 空等 60 秒才报)", async () => {
  const b = new CommandBroker({ pipe: `\\\\.\\pipe\\fp-test-gone-${process.pid}`, python: process.execPath, probeArgs: ["-e", "console.error('找不到 pdb-dump'); process.exit(3)", "--"], mode: "server" });
  const t0 = Date.now();
  await assert.rejects(b.start(), /退出码 3[\s\S]*找不到 pdb-dump/);
  assert.ok(Date.now() - t0 < 20_000, "不能等到超时");
  await b.stop();
});

test("注入 Lua: 宿主中途回问, 代理查了写回去; 不算这次提问的回复; 给了 luaRead 才带 --lua", async () => {
  const seen: unknown[] = [];
  const pipe = `\\\\.\\pipe\\fp-test-lua-${process.pid}`;
  // "--" 之后的才是脚本的参数, 不然 node 把 --lua 当自己的选项, 一启动就退
  const b = new CommandBroker({ pipe, python: process.execPath, probeArgs: ["-e", FAKE_HOST, "--"], mode: "server", luaRead: async (a) => { seen.push(a); return { ok: true, data: { objects: [{ attributes: { name: "队友" } }], player: { name: "不要的信封" } } }; } });
  await b.start();
  try {
    const out = await b.probeStats() as { tick: number; reply: { lua_reply: number; ok: boolean; data: { objects: unknown[]; player?: unknown } }; argv: string[] };
    assert.equal(out.tick, 7, "等回问答完才拿到回复");
    assert.deepEqual(seen, [{ selection: { kind: "players" } }]);
    assert.equal(out.reply.lua_reply, 5);
    assert.equal(out.reply.ok, true);
    assert.equal((out.reply.data.objects[0] as { attributes: { name: string } }).attributes.name, "队友");
    assert.equal(out.reply.data.player, undefined, "玩家信封不传回去");
    assert.ok(out.argv.includes("--lua"));
  } finally { await b.stop(); }

  const failing = new CommandBroker({ pipe: `${pipe}-2`, python: process.execPath, probeArgs: ["-e", FAKE_HOST, "--"], mode: "server", luaRead: async () => { throw new Error("连不上"); } });
  await failing.start();
  try {
    const out = await failing.probeStats() as { reply: { ok: boolean; error: string } };
    assert.equal(out.reply.ok, false);
    assert.match(out.reply.error, /连不上/);
  } finally { await failing.stop(); }

  const off = new CommandBroker({ pipe: `${pipe}-3`, python: process.execPath, probeArgs: ["-e", FAKE_HOST.replace('console.log(JSON.stringify({ lua_read: { selection: { kind: "players" } }, seq: 5 }));', 'console.log(JSON.stringify({ argv: process.argv.slice(1) }));')], mode: "server" });
  await off.start();
  try {
    const out = await off.probeStats() as { argv: string[] };
    assert.ok(!out.argv.includes("--lua"), "只读默认不注入: 不给 luaRead 就不带");
  } finally { await off.stop(); }
});

test("RCON 管道: 动手时原样转发; 只读时动作拒绝, 读带 reader 并去掉没造的服务器角色", async () => {
  const sent: string[] = [];
  const send = async (c: string) => { sent.push(c); return "回复"; };
  const act = new RconPipe({ pipe: "x", send });
  const raw = dispatch({ id: "a", action: "build", bot: "Claude-Opus", args: {} });
  assert.equal((await act.handle(raw)).text, "回复");
  assert.equal(sent[0], raw);
  assert.equal(act.stats.sent, 1);

  sent.length = 0;
  const ro = new RconPipe({ pipe: "x", send, readOnly: true, actions: readOnlyActions(async () => 42) });
  const refused = JSON.parse((await ro.handle(dispatch({ id: "b", action: "say", bot: "Claude-Opus", args: {} }))).text!) as { tick: number; error: { message: string } };
  assert.match(refused.error.message, /现在只读/);
  assert.equal(refused.tick, 42);
  assert.equal(sent.length, 0, "动作什么都没发");
  assert.equal((await ro.handle("/silent-command rcon.print(1)")).refused, true, "不是读请求的也不发");
  assert.equal(sent.length, 0);
  await ro.handle(dispatch({ id: "c", action: "status", bot: "Claude-Opus", args: { x: "a]]b" } }));
  const d = parseDispatch(sent[0])!;
  assert.equal((d.request as { reader?: string }).reader, "ext");
  assert.equal(d.request.bot, undefined);
  assert.equal(d.request.player, 1);
  assert.equal((d.request.args as { x: string }).x, "a]]b", "带 ]] 也拼得对");
});

test("动作: 真服上明确拒绝 (什么都不发), 沙盘转发", async () => {
  const refusal = JSON.stringify({ id: "x", ok: false, error: { message: "reader ext: build acts as the agent (it can drive the character); a reader request takes reads only" } });
  const server = new FakeBroker({ pipe: "x", python: "x", probeArgs: [], mode: "server" });
  server.replies = { build: refusal, status: JSON.stringify({ id: "x", ok: true, result: {} }) };
  const out = await server.handle(dispatch({ id: "x", action: "build", args: {} }));
  assert.equal(out.ok, false);
  assert.equal(out.refused, true);
  assert.match(out.error ?? "", /什么都没发给游戏/);
  const ok = await server.handle(dispatch({ id: "x", action: "status", args: {} }));
  assert.equal(ok.ok, true);
  assert.deepEqual(server.stats.byAction.build.route, "refuse");
  assert.deepEqual(server.stats.byAction.status.route, "mem");

  const sent: string[] = [];
  const sandbox = new FakeBroker({ pipe: "x", python: "x", probeArgs: [], mode: "sandbox", rcon: { async send(c) { sent.push(c); return "真 RCON 回的"; } } });
  const fwd = await sandbox.handle(dispatch({ id: "x", action: "build", args: {} }));
  assert.equal(fwd.text, "真 RCON 回的");
  assert.equal(sent.length, 1);
  assert.equal(sandbox.asked.length, 0, "沙盘的动作直接转发, 不问外面");
});

test("记账类和被闸门当成动手的读 (AGENT_CALLS): 真服模式直接按角色身份问游戏外的模组 (act), 不先按读者问", async () => {
  class ActBroker extends CommandBroker {
    calls: { action: string; act: boolean }[] = [];
    protected override async ask2(raw: string, act = false) { this.calls.push({ action: (JSON.parse(raw) as { action: string }).action, act }); return { ms: 2, text: JSON.stringify({ ok: true, result: {} }) }; }
  }
  const b = new ActBroker({ pipe: "x", python: "x", probeArgs: [], mode: "server" });
  for (const action of ["board_post", "reminder_add", "lesson_add", "ingredient_gap", "ghosts", "players"]) assert.equal((await b.handle(dispatch({ id: action, action, args: {} }))).ok, true, action);
  assert.deepEqual(b.calls.map((c) => c.act), [true, true, true, true, true, true]);
  assert.equal(b.stats.byAction.board_post?.route, "ledger");
  await b.handle(dispatch({ id: "o", action: "observe", args: {} }));
  assert.deepEqual(b.calls.at(-1), { action: "observe", act: false }, "普通的读照旧按读者问");
});
