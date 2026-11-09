// commands/client-reads.ts: 模型直接用注入客户端的只读工具 (./fh call mcp) 和看带子每道 (belt_lanes), 用假的客户端核
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCP_DUMP_FILE, MCP_REPLY_CAP, beltLanes, mcpPassthrough, type ClientCall } from "../commands/client-reads.ts";
import { OWN_HELP } from "../commands/own-help.ts";

const fake = (reply: (tool: string, args: Record<string, unknown>) => unknown, seen: { tool: string; args: Record<string, unknown> }[] = []): ClientCall =>
  async (tool, args) => { seen.push({ tool, args }); const data = reply(tool, args); return { ok: true, ms: 1, data, bytes: 0 }; };

test("mcp: 只开放只读工具, 动作类和截图一律拒, 不发给客户端", async () => {
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const call = fake(() => ({}), seen);
  for (const tool of ["input", "ui_action", "player_action", "chat_send", "attach", "detach", "screenshot", "set_rendering", ""]) {
    const r = await mcpPassthrough(call, { tool, args: {} });
    assert.equal(r.ok, false, tool);
  }
  assert.equal(seen.length, 0, "拒的那些一条都没发");
  const ok = await mcpPassthrough(call, { tool: "world_query", args: { selection: { kind: "player" } } });
  assert.equal(ok.ok, true);
  assert.deepEqual(seen[0], { tool: "world_query", args: { selection: { kind: "player" } } }, "参数原样交给客户端 (包 query 在 connect.ts)");
});

test("mcp: 回复超长只回开头, 全文写进角色目录; 客户端报错带上写法提示", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dump-"));
  try {
    const big = { objects: Array.from({ length: 2000 }, (_, i) => ({ attributes: { name: "transport-belt", position: { x: i, y: 0 } } })) };
    const r = await mcpPassthrough(fake(() => big), { tool: "world_query", args: {} }, dir);
    assert.ok(r.ok);
    const res = r.ok ? r.result : {};
    assert.equal(String(res.head).length, MCP_REPLY_CAP);
    assert.match(String(res.cut), new RegExp(MCP_DUMP_FILE));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, MCP_DUMP_FILE), "utf8")), big);
    const bad = await mcpPassthrough(async () => ({ ok: false, ms: 1, error: "values does not accept collection counts or offsets", bytes: 0 }), { tool: "world_query", args: {} });
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? "" : bad.error.message, /mode: "entries"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("belt_lanes 一格: 一次查询 (带子类型 + 每条线的 get_contents / get_detailed_contents 相对读), 按左右道整理", async () => {
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const row = {
    attributes: { name: "transport-belt", type: "transport-belt", position: { x: 1.5, y: 2.5 }, direction: 4 },
    reads: [
      { value: 2 },
      { value: [{ name: "iron-plate", quality: "normal", count: 3 }] }, { value: [{ name: "copper-plate", quality: "normal", count: 1 }] },
      ...Array.from({ length: 6 }, () => ({ read_status: { status: "error", message: "bad index" } })),
      { value: [{ stack: { name: "iron-plate" }, position: 0.75 }, { stack: { name: "iron-plate" }, position: 0.25 }, { stack: { name: "iron-plate" }, position: 0.5 }] },
      { value: [{ stack: { name: "copper-plate" }, position: 0.4 }] },
    ],
  };
  const r = await beltLanes(fake(() => ({ objects: [row], selection_complete: true }), seen), { position: { x: 1.5, y: 2.5 } });
  assert.equal(seen.length, 1, "一次调用");
  const q = seen[0].args as { selection: { type: string[]; position: unknown }; reads: { path: { method: string; arguments?: number[] }[] }[]; limit: number };
  assert.ok(q.selection.type.includes("transport-belt") && q.selection.type.includes("splitter"));
  assert.equal(q.reads[0].path[0].method, "get_max_transport_line_index");
  assert.deepEqual(q.reads[1].path.map((s) => s.method), ["get_transport_line", "get_contents"]);
  assert.deepEqual(q.reads[9].path.map((s) => s.method), ["get_transport_line", "get_detailed_contents"]);
  assert.ok(r.ok);
  const belt = (r.ok ? r.result.belts : [])[0] as { 朝向: string; 线数: number; lanes: Record<string, { 数: unknown; 位置?: { name: string; at: number }[] }> };
  assert.equal(belt.朝向, "东");
  assert.equal(belt.线数, 2);
  assert.deepEqual(belt.lanes["左道"].数, [{ name: "iron-plate", count: 3 }]);
  assert.deepEqual(belt.lanes["左道"].位置?.map((p) => p.at), [0.25, 0.5, 0.75], "按道上位置排");
  assert.deepEqual(belt.lanes["右道"].数, [{ name: "copper-plate", count: 1 }]);
  assert.equal(Object.keys(belt.lanes).length, 2, "只有 2 条线的带子不列第 3 条以后");
});

test("belt_lanes 一片: 不读位置; 没带子、没给位置都说清; 条数不够标出来", async () => {
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const r = await beltLanes(fake(() => ({ objects: [{ attributes: { name: "transport-belt", direction: 0 }, reads: [{ value: 2 }, { value: [] }, { value: [] }] }], selection_complete: false }), seen), { position: { x: 0, y: 0 }, radius: 5 });
  const q = seen[0].args as { reads: { path: { method: string }[] }[] };
  assert.ok(q.reads.every((x) => x.path.at(-1)?.method !== "get_detailed_contents"), "一片不读每个物品的位置");
  assert.ok(r.ok && /只回了一部分/.test(String(r.result.cut)));
  const belt = (r.ok ? r.result.belts : [])[0] as { lanes: Record<string, { 数: unknown }> };
  assert.equal(belt.lanes["左道"].数, "空");
  const none = await beltLanes(fake(() => ({ objects: [] })), { position: { x: 0, y: 0 } });
  assert.ok(!none.ok && /没有传送带/.test(none.error.message));
  const bad = await beltLanes(fake(() => ({})), {});
  assert.ok(!bad.ok && bad.error.code === "bad_args");
});

test("./fh help mcp / belt_lanes 有说明, 例子是能直接跑的 ./fh call 命令 (参数是合法 JSON)", () => {
  for (const k of ["mcp", "belt_lanes"]) {
    assert.ok(OWN_HELP[k]);
    const cmds = [...OWN_HELP[k].matchAll(/\.\/fh call (\w+) --args '([^']+)'/g)];
    assert.ok(cmds.length >= 2, k);
    for (const [, action, json] of cmds) { assert.equal(action, k); assert.doesNotThrow(() => JSON.parse(json), json); }
  }
});
