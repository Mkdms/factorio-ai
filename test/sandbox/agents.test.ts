// 沙盘里的角色: 建两个、查状态 / 周围 / 背包、说话和聊天记录、留言收件箱、同 id 重发不做两次、收回。要本机装有 Factorio。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SandboxServer } from "../../game/sandbox/server.ts";
import { Agents } from "../../game/sandbox/agents.ts";

const lab = new SandboxServer({ name: "test-agents", view: false });
const agents = new Agents(lab);

before(async () => {
  await lab.createMap("t", { seed: 7 });
  await lab.start("t");
});
after(() => lab.stop({ save: false }));

test("建两个角色: 都有身体、位置不同、带开局物品; 名字不合规拒绝", async () => {
  const a = await agents.create("Claude-Opus");
  const b = await agents.create("Gpt-6");
  assert.ok(a.unit > 0 && b.unit > 0 && a.unit !== b.unit);
  assert.ok(Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) >= 1.5, "两个角色不叠在一起");
  const list = await agents.list();
  assert.deepEqual(list.map((x) => x.name), ["Claude-Opus", "Gpt-6"]);
  assert.ok(list.every((x) => x.alive));
  await assert.rejects(agents.create("1bad name"), /角色名/);
  await assert.rejects(agents.create("Claude-Opus"), /已经有角色/);
});

test("status / inventory / observe: 读得到自己和周围; 没有的角色和动作报得清楚", async () => {
  const st = await agents.dispatch({ who: "Claude-Opus", action: "status" });
  assert.equal(st.ok, true, JSON.stringify(st));
  const s = st.result as { alive: boolean; inventory_items: number; position: { x: number; y: number }; health: number };
  assert.equal(s.alive, true);
  assert.ok(s.inventory_items > 0 && s.health > 0);
  const inv = (await agents.dispatch({ who: "Claude-Opus", action: "inventory" })).result as { items: { name: string; count: number }[]; free_slots: number };
  assert.ok(inv.items.some((i) => i.name === "iron-plate"), "开局有铁板");
  assert.ok(inv.free_slots > 0);
  const ob = await agents.dispatch({ who: "Claude-Opus", action: "observe", args: { radius: 32 } });
  assert.equal(ob.ok, true, JSON.stringify(ob));
  const o = ob.result as { radius: number; resources: Record<string, { tiles: number }>; buildings: unknown[]; trees: { count: number } };
  assert.equal(o.radius, 32);
  assert.ok(typeof o.trees.count === "number");
  const bad = await agents.dispatch({ who: "Nobody", action: "status" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.code, "unknown_agent");
  const bad2 = await agents.dispatch({ who: "Claude-Opus", action: "fly" });
  assert.equal(bad2.error?.code, "unknown_action");
  assert.match(bad2.error?.message ?? "", /observe/);
  const udp = await agents.dispatch({ who: "Claude-Opus", action: "status" }, { via: "udp" });
  assert.equal(udp.ok, true, "UDP 通道也能转发");
});

test("say 进聊天记录, 另一个角色 chat 能看到; 留言进收件箱, 拿走后清空", async () => {
  const said = await agents.dispatch({ who: "Claude-Opus", action: "say", args: { text: "我去挖铁" } });
  assert.equal(said.ok, true, JSON.stringify(said));
  const chat = (await agents.dispatch({ who: "Gpt-6", action: "chat" })).result as { messages: { who: string; text: string }[] };
  assert.ok(chat.messages.some((m) => m.who === "Claude-Opus" && m.text === "我去挖铁"));
  await agents.tell("Gpt-6", "先建锅炉");
  const st = (await agents.dispatch({ who: "Gpt-6", action: "status" })).result as { mail: number };
  assert.equal(st.mail, 1);
  const inbox = (await agents.dispatch({ who: "Gpt-6", action: "inbox" })).result as { messages: { text: string }[] };
  assert.deepEqual(inbox.messages.map((m) => m.text), ["先建锅炉"]);
  const again = (await agents.dispatch({ who: "Gpt-6", action: "inbox" })).result as { count: number };
  assert.equal(again.count, 0); // 空表回来是 {} 不是数组, 所以看 count
});

test("同一个 id 重发: 会改东西的动作只做一次, 回同一个回复; 换了内容拒绝", async () => {
  const id = "retry-1";
  const first = await agents.dispatch({ id, who: "Claude-Opus", action: "say", args: { text: "一次" } });
  const second = await agents.dispatch({ id, who: "Claude-Opus", action: "say", args: { text: "一次" } });
  assert.deepEqual(second, first);
  const chat = (await agents.dispatch({ who: "Gpt-6", action: "chat" })).result as { messages: { text: string }[] };
  assert.equal(chat.messages.filter((m) => m.text === "一次").length, 1);
  const changed = await agents.dispatch({ id, who: "Claude-Opus", action: "say", args: { text: "两次" } });
  assert.equal(changed.error?.code, "id_reused");
});

test("收回角色: 身体倒下, 名单里没了; 再查报没有角色", async () => {
  const r = await agents.remove("Gpt-6");
  assert.equal(r.removed, true);
  assert.deepEqual((await agents.list()).map((x) => x.name), ["Claude-Opus"]);
  assert.equal((await agents.dispatch({ who: "Gpt-6", action: "status" })).error?.code, "unknown_agent");
});
