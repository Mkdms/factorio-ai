// 沙盘集成测试: 注入客户端的程序 (game/client, 编好的 data/client/factorio-ai-client.exe) 挂上一个游戏窗口, 只读查询 / 读内存 / 聊天对 RCON 真值, 摘下来游戏照常。
// npm run test:sandbox。要本机 Factorio、npm run client:setup 编出来的程序。开一个游戏窗口当被挂接的客户端; 不发键鼠 (动作在下一块核)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SandboxServer, freeTcpPort } from "../../game/sandbox/server.ts";
import { Viewer } from "../../game/sandbox/viewer.ts";
import { GameClient, clientExe, clientReady } from "../../game/client/connect.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lab = new SandboxServer({ name: "test-client", view: false });
const viewer = new Viewer("test-client", undefined, { playerName: "ClientCheck" });
let client: GameClient;
let pid = 0;
const log: string[] = [];
type Obj = { attributes?: Record<string, any> };
const must = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.call(name, args, 60_000);
  assert.ok(r.ok, `${name} 失败: ${r.error}`);
  return r.data as Record<string, any>;
};
const bag = (rows: { name: string; x: number; y: number }[]) => rows.map((e) => `${e.name}@${e.x},${e.y}`).sort();

before(async () => {
  assert.ok(clientReady(), `没有 ${clientExe()} 和旁边的桥 dll: 先 npm run client:setup`);
  await lab.createMap("m", { seed: 42 });
  await lab.start("m");
  await lab.rpc("time", { speed: 1, paused: false });
  const proc = viewer.launch(lab.gamePort);
  pid = proc.pid!;
  for (let i = 0; i < 90; i++) { await sleep(2000); if (((await lab.exec(`return #game.connected_players`)) as number) >= 1) break; }
  assert.ok(((await lab.exec(`return #game.connected_players`)) as number) >= 1, "观看窗口没连进来");
  await lab.rpc("viewer", {}).catch(() => undefined);
  await sleep(3000);
  client = new GameClient(await freeTcpPort());
  await client.start((s) => log.push(s));
});
after(async () => {
  await client?.stop().catch(() => undefined);
  viewer.close();
  await lab.stop({ save: false }).catch(() => undefined);
});

test("起程序、挂上游戏窗口: status 报 attached, 工具都在", async () => {
  const tools = await client.tools();
  for (const t of ["status", "attach", "detach", "world_query", "world_overview", "input", "ui_read", "ui_action", "chat_read", "chat_send", "player_action", "memory_read", "screenshot"]) assert.ok(tools.includes(t), `没有工具 ${t}: ${tools.join(" ")}`);
  const before = await must("status");
  assert.equal(before.attached, false);
  await must("attach", { pid });
  let st: Record<string, any> = {};
  for (let i = 0; i < 30; i++) { st = await must("status"); if (st.attached && (st.state === "in_game" || st.state === "paused")) break; await sleep(1000); }
  console.log(`  挂上: ${JSON.stringify({ attached: st.attached, state: st.state, paused: st.paused, pid: st.pid })}`);
  assert.equal(st.attached, true);
  assert.ok(st.state === "in_game" || st.state === "paused", `状态 ${st.state}`);
});

test("只读查询 (暂停着): 玩家周围 16 格的实体名字 + 位置等于 RCON 真值; 玩家位置等于角色位置", async () => {
  await lab.rpc("time", { speed: 1, paused: true });
  await sleep(1500);
  const truth = (await lab.exec(`local p = game.connected_players[1] local c = p.character local out = {}
    for _, e in pairs(p.surface.find_entities_filtered{position = c.position, radius = 16}) do out[#out + 1] = {name = e.name, x = e.position.x, y = e.position.y} end
    return {x = c.position.x, y = c.position.y, entities = out}`)) as { x: number; y: number; entities: { name: string; x: number; y: number }[] };
  const q = await must("world_query", { selection: { kind: "entities", position: { x: truth.x, y: truth.y }, radius: 16 }, fields: ["name", "type", "position"], limit: 512 });
  assert.equal(q.truncated, false, "16 格里超过 512 个实体");
  const got = ((q.objects ?? []) as Obj[]).map((o) => ({ name: String(o.attributes?.name), x: Number(o.attributes?.position?.x), y: Number(o.attributes?.position?.y) }));
  console.log(`  真值 ${truth.entities.length} 个, 查到 ${got.length} 个 (tick ${q.tick ?? "?"})`);
  assert.deepEqual(bag(got), bag(truth.entities));
  const p = await must("world_query", { selection: { kind: "player" }, fields: ["index", "name", "controller_type"] });
  const pos = (p.player?.physical_position ?? p.player?.position) as { x: number; y: number };
  assert.ok(Math.abs(pos.x - truth.x) < 0.02 && Math.abs(pos.y - truth.y) < 0.02, `玩家位置 真值 ${truth.x},${truth.y} 查到 ${JSON.stringify(pos)}`);
  assert.equal(p.objects?.[0]?.attributes?.name, "ClientCheck");
});

test("读内存 (宿主进程 ReadProcessMemory, 不进游戏): 角色位置和主背包等于真值; 物品 ID 表读得出", async () => {
  const truth = (await lab.exec(`local c = game.connected_players[1].character local inv = {} for _, it in pairs(c.get_main_inventory().get_contents()) do inv[#inv + 1] = it.name .. "*" .. it.count end table.sort(inv) return {x = c.position.x, y = c.position.y, inv = inv}`)) as { x: number; y: number; inv: string[] };
  const m = await must("memory_read", { kind: "player" });
  assert.ok(Math.abs(m.position.x - truth.x) < 0.02 && Math.abs(m.position.y - truth.y) < 0.02, `位置 真值 ${truth.x},${truth.y} 内存 ${JSON.stringify(m.position)}`);
  const ids = await must("memory_read", { kind: "item_ids" });
  const byId = new Map(Object.entries(ids.ids as Record<string, number>).map(([n, i]) => [i, n]));
  assert.ok(byId.size > 300 && typeof (ids.ids as Record<string, number>)["iron-plate"] === "number", `物品 ID 表 ${byId.size} 条`);
  const merged = new Map<string, number>();
  for (const s of m.inventory.stacks as { item: number; count: number }[]) { const n = byId.get(s.item) ?? String(s.item); merged.set(n, (merged.get(n) ?? 0) + s.count); }
  assert.deepEqual([...merged].map(([n, c]) => `${n}*${c}`).sort(), truth.inv);
  console.log(`  背包 ${m.inventory.stacks.length} 格非空, 读 ${m.reads} 次, 稳定 ${m.stable}; 物品 ID ${byId.size} 条`);
});

test("聊天: chat_send 发出的话 chat_read 读得回来 (服务器日志也有); 游戏跑着没有不同步", async () => {
  await lab.rpc("time", { speed: 1, paused: false });
  await sleep(1000);
  const text = `客户端测试 ${Date.now()}`;
  const sent = await must("chat_send", { text });
  assert.equal(sent.dispatch, "completed");
  let found = false;
  for (let i = 0; i < 20 && !found; i++) {
    await sleep(500);
    const r = await must("chat_read", { limit: 64 });
    found = ((r.messages ?? []) as { text?: string; raw?: string }[]).some((m) => (m.text ?? "").includes(text) || (m.raw ?? "").includes(text));
  }
  assert.ok(found, "chat_read 里没读到自己发的话");
  const serverSaw = (await lab.exec(`return #game.connected_players`)) as number;
  assert.equal(serverSaw, 1, "窗口掉线了");
  const t1 = ((await lab.rpc("ping")) as { tick: number }).tick;
  await sleep(1500);
  const t2 = ((await lab.rpc("ping")) as { tick: number }).tick;
  assert.ok(t2 > t1, `游戏没在走 ${t1} → ${t2}`);
});

test("摘下来: status 报 detached, 窗口还连着, 程序日志里没有报错", async () => {
  await must("detach");
  const st = await must("status");
  assert.equal(st.attached, false);
  assert.equal((await lab.exec(`return #game.connected_players`)) as number, 1);
  const bad = log.filter((l) => /error|exception|crash/i.test(l) && !/no error/i.test(l));
  console.log(`  程序日志 ${log.length} 行${bad.length ? `, 可疑: ${bad.slice(0, 3).join(" | ")}` : ""}`);
  assert.deepEqual(bad.slice(0, 3), []);
});
