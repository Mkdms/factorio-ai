// 监工那一套 (core/run: supervisor / tell / health / research / science / human-chat); 不开游戏, 读数和代理都用假的
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACTIONS, deadlineNudge, idleVerdict, lastActionAt, Supervisor, toolRequests } from "../core/run/supervisor.ts";
import { chunks, tellCommands, tellModel } from "../core/run/tell.ts";
import { parseDispatch } from "../commands/broker.ts";
import { healthLines, normalizeHealth, StuckHealth, type Health } from "../core/run/health.ts";
import { isMilitary, normalizeResearch, pickResearch, researchIdleText, type TechCandidate } from "../core/run/research.ts";
import { labLine, ratesFrom, ratesLine } from "../core/run/science.ts";
import { chatLine, completeLines, HumanChatBridge, isUrgent, markEnd, mentioned, parseChatLine, readNewLines, tellText } from "../core/run/human-chat.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const M = 60_000;

test("闲了该不该催: 开局宽限; 出生点 3 分钟 / 别处 5 分钟; 同一角色隔 15 分钟; 没闲不催", () => {
  const t0 = 1_000_000_000;
  assert.equal(idleVerdict({ idleSince: null, now: t0 + 10 * M, t0, lastNudge: -Infinity, atSpawn: false }).nudge, false);
  assert.equal(idleVerdict({ idleSince: t0, now: t0 + 2 * M, t0, lastNudge: -Infinity, atSpawn: true }).nudge, false, "开局 3 分钟宽限");
  assert.equal(idleVerdict({ idleSince: t0 + M, now: t0 + 4 * M, t0, lastNudge: -Infinity, atSpawn: true }).nudge, true, "出生点闲 3 分钟");
  assert.equal(idleVerdict({ idleSince: t0 + M, now: t0 + 4 * M, t0, lastNudge: -Infinity, atSpawn: false }).nudge, false, "别处要 5 分钟");
  const v = idleVerdict({ idleSince: t0 + M, now: t0 + 7 * M, t0, lastNudge: -Infinity, atSpawn: false });
  assert.deepEqual([v.nudge, v.idleMin], [true, 6]);
  assert.equal(idleVerdict({ idleSince: t0 + M, now: t0 + 12 * M, t0, lastNudge: t0 + 7 * M, atSpawn: false }).nudge, false, "刚催过");
  assert.equal(idleVerdict({ idleSince: t0 + M, now: t0 + 23 * M, t0, lastNudge: t0 + 7 * M, atSpawn: false }).nudge, true);
  const said = new Set<number>();
  assert.equal(deadlineNudge(12 * M, said), null);
  assert.equal(deadlineNudge(9 * M, said), 10);
  assert.equal(deadlineNudge(8 * M, said), null, "10 分钟那条说过了");
  assert.equal(deadlineNudge(2 * M, said), 3);
  assert.equal(deadlineNudge(-1, said), null);
});

test("journal: 最近一次动作类请求的时间 (sleep / 查看不算); 工具诉求只认 operator 的 '工具诉求…'", () => {
  const f = path.join(tmp("fa-journal-"), "journal.jsonl");
  const row = (at: string, action: string, args: object = {}) => JSON.stringify({ at, event: "request", request: { id: "x", action, args } });
  fs.writeFileSync(f, [row("2026-11-08T01:00:00.000Z", "build"), row("2026-11-08T01:05:00.000Z", "status"), row("2026-11-08T01:06:00.000Z", "sleep", { seconds: 60 }), row("2026-11-08T01:07:00.000Z", "operator", { text: "工具诉求: 想要 belt_route" }), row("2026-11-08T01:08:00.000Z", "observe")].join("\n") + "\n");
  assert.equal(lastActionAt(f), Date.parse("2026-11-08T01:00:00.000Z"));
  assert.equal(lastActionAt(path.join(os.tmpdir(), "no-such-journal.jsonl")), null);
  assert.ok(ACTIONS.has("say") && !ACTIONS.has("sleep") && !ACTIONS.has("observe"));
  assert.deepEqual(toolRequests(fs.readFileSync(f, "utf8").split("\n")), [{ at: "2026-11-08T01:07:00.000Z", text: "工具诉求: 想要 belt_route" }]);
});

test("递话: 切成 ≤480 字节不切断字; 代理认得这个请求 (tell, operator); 代理不在就写收件箱并记 tells.jsonl", async () => {
  const long = "真人说的话".repeat(60);
  const cmds = tellCommands("Claude-Opus", long);
  assert.ok(cmds.length > 1);
  let joined = "";
  for (const c of cmds) {
    const d = parseDispatch(c);
    assert.equal(d?.request.action, "tell");
    assert.equal((d?.request as { operator?: boolean }).operator, true);
    const args = d?.request.args as { to: string; text: string };
    assert.equal(args.to, "Claude-Opus");
    assert.ok(Buffer.byteLength(args.text) <= 480);
    joined += args.text;
  }
  assert.equal(joined, long);
  assert.deepEqual(chunks("短"), ["短"]);
  const dir = tmp("fa-tell-"), runDir = tmp("fa-tellrun-");
  assert.equal(await tellModel(null, { to: "X", dir, runDir, text: "监工: 闲了" }), "inbox");
  assert.match(fs.readFileSync(path.join(dir, ".inbox.md"), "utf8"), /监工: 闲了/);
  assert.match(fs.readFileSync(path.join(runDir, "tells.jsonl"), "utf8"), /"how":"inbox"/);
  const sent: string[] = [];
  const port = { async operatorCall(c: string) { sent.push(c); return { ok: true, text: JSON.stringify({ ok: true, result: {} }) }; } };
  assert.equal(await tellModel(port, { to: "X", dir, runDir, text: "第二条" }), "tell");
  assert.equal(sent.length, 1);
  const bad = { async operatorCall() { return { ok: false, error: "没起" }; } };
  assert.equal(await tellModel(bad, { to: "X", dir, text: "第三条" }), "inbox");
});

test("体检: 空表规整、清单中文化、同一类连报 3 次点名 15 分钟内不重复", () => {
  const fromLua = JSON.parse(`{"tick":1,"ghosts":{},"noFuel":{},"depleted":{},"labs":{"total":16,"working":0,"missingPacks":16},"full":{},"short":{},"noPower":0,"obstacles":{"count":0,"at":{},"box":""},"belt_ends":{}}`) as Health;
  const h = normalizeHealth(fromLua);
  assert.deepEqual(healthLines(h), ["研究中心 16 台只有 0 台在工作 (16 台缺瓶)"]);
  assert.deepEqual(healthLines(normalizeHealth({ tick: 1 } as Health)), [], "缺字段不崩");
  const zh = (n: string) => ({ "stone-furnace": "石炉", "iron-gear-wheel": "铁齿轮", coal: "煤", "iron-ore": "铁矿" } as Record<string, string>)[n] ?? n;
  const text = healthLines(normalizeHealth({ ...fromLua, labs: { total: 0, working: 0, missingPacks: 0 }, noFuel: ["stone-furnace(-13.0,-64.0)"], short: { "iron-gear-wheel": 2 }, belt_ends: [{ at: "1,2", items: "coal*5 iron-ore*3", mixed: true }] }), [], zh).join("\n");
  for (const s of ["石炉(-13.0,-64.0)", "铁齿轮 2 台", "煤*5 铁矿*3", "[混装]"]) assert.ok(text.includes(s), s);
  const st = new StuckHealth();
  assert.deepEqual(st.update(["缺燃料 22 台: x"], 0), []);
  assert.deepEqual(st.update(["缺燃料 10 台: x"], 5 * M), []);
  assert.deepEqual(st.update(["缺燃料 4 台: x", "缺电 8 台"], 10 * M).map((x) => [x.line, x.times]), [["缺燃料 4 台: x", 3]]);
  assert.deepEqual(st.update(["缺燃料 4 台: x"], 15 * M), []);
  assert.deepEqual(st.update(["缺燃料 4 台: x"], 26 * M).map((x) => x.times), [5]);
});

test("研究: 只提场上在产的瓶能研究的, 最便宜的先, 和平跳军事; 都研究完或触发型说清楚; 空表不崩", () => {
  const red = "automation-science-pack", green = "logistic-science-pack", gray = "military-science-pack";
  const c = (name: string, units: number, time: number, packs: string[]): TechCandidate => ({ name, units, time, packs });
  const st = { current: "", queue: 0, peaceful: false, producing: [red, green], candidates: [c("advanced-material-processing", 75, 30, [red, green]), c("fast-inserter", 30, 30, [red]), c("chemical-science-pack", 75, 10, [red, green]), c("stronger-explosives-1", 50, 30, [red, green, gray])], triggers: [] };
  assert.equal(pickResearch(st).pick?.name, "chemical-science-pack");
  assert.match(researchIdleText(st), /^研究队列空了。[\s\S]*chemical-science-pack \(75 单位[\s\S]*\.\/fh call research --args '\{"technology":"chemical-science-pack"\}'/);
  const cands = [c("weapon-shooting-speed-1", 10, 30, [red]), c("gun-turret", 10, 10, [red]), c("logistics", 20, 15, [red])];
  assert.equal(pickResearch({ ...st, peaceful: true, producing: [red], candidates: cands }).pick?.name, "logistics");
  assert.equal(isMilitary("rocket-silo"), false);
  assert.match(researchIdleText({ current: "", queue: 0, peaceful: true, producing: [red], candidates: [], triggers: [{ name: "steam-power", trigger: "craft-item iron-plate x10" }] }, (n) => ({ "iron-plate": "铁板", "steam-power": "蒸汽动力" } as Record<string, string>)[n] ?? n), /靠做事触发 —— 蒸汽动力 \(做出 10 个 铁板\)/);
  assert.match(researchIdleText({ current: "", queue: 0, peaceful: true, producing: [red], candidates: [c("x", 1, 1, [green])], triggers: [] }), /都研究完了/);
  const n = normalizeResearch({ current: "", queue: 0, peaceful: true, producing: {}, candidates: [{ name: "a", units: 1, time: 1, packs: {} }] });
  assert.deepEqual(n.producing, []);
  assert.equal(pickResearch(n).pick, null);
});

test("科研读数: 平均产量 (不到最短时长给 null)、和上一班比、研究中心缺哪种瓶", () => {
  const rows = [{ tick: 0, redTotal: 0, greenTotal: 0 }, { tick: 10 * 3600, redTotal: 120, greenTotal: 60 }];
  assert.deepEqual(ratesFrom(rows), { red: 12, green: 6, blue: null });
  assert.equal(ratesFrom([{ tick: 0, redTotal: 0 }, { tick: 3600, redTotal: 10 }]), null);
  assert.match(ratesLine({ red: 12, green: 6, blue: null }, { red: 18, green: 5, blue: null }), /红瓶 12\.0、绿瓶 6\.0、蓝瓶 —; 上一班平均: 红瓶 18\.0[\s\S]*\(红瓶比上一班低, 没达到硬指标\)/);
  assert.match(labLine("automation", ["automation-science-pack"], {}, (n) => ({ "automation-science-pack": "红瓶", automation: "自动化" } as Record<string, string>)[n] ?? n), /当前研究 自动化 要 红瓶; 研究中心里: 红瓶 0 个, 缺 红瓶/);
  assert.match(labLine("", [], {}), /队列空了/);
});

test("真人说话: 日志行解析、紧急、@ 点名、口径; 新增行只取写完的 (Windows \\r\\n); 客户端聊天桥过滤自己和 AI", async () => {
  assert.deepEqual(parseChatLine("2026-11-05 13:02:20 [CHAT] mkdm: 是谁把铁板丢地上的?"), { from: "mkdm", text: "是谁把铁板丢地上的?" });
  assert.deepEqual(parseChatLine("2026-11-05 13:02:20 [CHAT] someone [admin]: 帮我修下电"), { from: "someone", text: "帮我修下电" });
  assert.equal(parseChatLine("2026-11-05 13:02:20 [CHAT] <server>: hello"), null);
  for (const t of ["特别紧急! 基地被打了", "URGENT fix power"]) assert.ok(isUrgent(t), t);
  for (const t of ["快点", "帮我修下电"]) assert.ok(!isUrgent(t), t);
  const seats = [{ id: "a", name: "mkdm" }, { id: "b", name: "Gpt-6.1-Sol" }];
  assert.deepEqual(mentioned("@gpt-6.1-sol 去修电", seats).map((s) => s.id), ["b"]);
  assert.deepEqual(mentioned("@Gpt-6.1-Solx 不是他", seats), []);
  assert.match(tellText("游戏聊天", "czp", "在吗", "team", false), /call say --args '\{"text":"@czp[\s\S]*别每人都回/);
  assert.match(tellText("界面", "管理员", "紧急", "direct", true), /先放下[\s\S]*operator/);
  assert.deepEqual(completeLines("a\r\nb\r\nhalf"), { lines: ["a", "b"], consumed: 6 });
  const dir = tmp("fa-chatlog-"), file = path.join(dir, "server.out"), st = { off: -1 };
  markEnd(file, st);
  fs.writeFileSync(file, "[CHAT] mkdm: 旧班说的\n");
  markEnd(file, st);
  fs.appendFileSync(file, "[CHAT] mkdm: 新的\r\n");
  assert.deepEqual(readNewLines(file, st), ["[CHAT] mkdm: 新的"]);
  assert.deepEqual(readNewLines(file, st), []);
  const pages: unknown[] = [
    { messages: [{ player_name: "czp", text: "进服务器之前说的" }], next_offset: { tick: 5 } },
    { messages: [{ player_name: "czp", text: ": @Test 帮我修下电", raw: "\": @Test 帮我修下电\"" }, { player_name: "Claude-Opus", text: "我在修" }, { player_name: "mkdm", text: "自己说的" }, { text: "科技研究完成" }, { player_name: "<server>", text: "x" }, { player_name: "路人", text: "", raw: "\": 只有 raw\"" }], next_offset: { tick: 6 }, has_more: false },
  ];
  const calls: Record<string, unknown>[] = [];
  const b = new HumanChatBridge({ async chatRead(args) { calls.push(args); return { ok: true, data: pages.shift() ?? { messages: [], next_offset: { tick: 9 } } }; } }, { self: "mkdm", aiNames: () => ["Claude-Opus"] });
  await b.start();
  assert.deepEqual(await b.poll(), [{ from: "czp", text: "@Test 帮我修下电" }, { from: "路人", text: "只有 raw" }]);
  assert.deepEqual(calls[1].offset, { tick: 5 }, "接着上次的位置读");
  assert.deepEqual(await new HumanChatBridge({ async chatRead() { return { ok: false, error: "没挂上" }; } }, { self: "m", aiNames: () => [] }).poll(), []);
  assert.equal(chatLine("/c game.print(1)"), "c game.print(1)");
});

test("监工 tick (假读数): 闲够了催一次并记 monitor.jsonl; 体检新出现的说; 研究队列空了说; 截止前 10 分钟提醒", async () => {
  const runDir = tmp("fa-sup-"), journal = path.join(runDir, "journal.jsonl");
  fs.writeFileSync(journal, "");
  const told: string[] = [];
  const t0 = 1_000_000_000;
  let health: Partial<Health> = { tick: 1, labs: { total: 0, working: 0, missingPacks: 0 } };
  let research = "";
  const sup = new Supervisor({
    evalLua: async (code) => code.includes("redTotal") ? { tick: 100, redTotal: 0, labs: 1, labsWorking: 0, research, researched: 0, entities: 3, machines: 1 } : code.includes("research_unit_count") ? { current: "", queue: 0, peaceful: true, producing: [], candidates: [{ name: "automation", units: 10, time: 10, packs: ["automation-science-pack"] }], triggers: [] } : health,
    player: async () => ({ x: 40, y: 0, hasCharacter: true }),
    tell: async (t) => { told.push(t); },
    journal, runDir, t0, deadline: t0 + 30 * M, zh: (n) => n, log: () => undefined, points: "- 先找最卡的那一个 (P-mind-01)\n",
    idle: { graceMs: 0, idleMs: 2 * M, spawnIdleMs: M, everyMs: 30 * M },
  });
  await sup.tick(t0);
  await sup.tick(t0 + M);
  assert.equal(told.filter((t) => /闲了/.test(t)).length, 0, "闲 1 分钟还没到 2 分钟");
  await sup.tick(t0 + 2 * M + 1);
  assert.equal(told.filter((t) => /闲了约 2 分钟/.test(t)).length, 1);
  assert.match(told.find((t) => /闲了/.test(t))!, /要点 .*先找最卡/);
  await sup.tick(t0 + 3 * M);
  assert.equal(told.filter((t) => /闲了/.test(t)).length, 1, "10 分钟内不再催");
  assert.ok(fs.readFileSync(path.join(runDir, "monitor.jsonl"), "utf8").split("\n").filter(Boolean).length >= 4);
  // 体检: 5 分钟后第二次, 新出现"缺燃料"
  health = { tick: 2, noFuel: ["stone-furnace(1.0,2.0)"], labs: { total: 1, working: 0, missingPacks: 1 } };
  await sup.tick(t0 + 6 * M);
  assert.ok(told.some((t) => /体检\): 缺燃料 1 台/.test(t)), told.join("\n"));
  assert.ok(told.some((t) => /研究队列空了[\s\S]*automation/.test(t)), "有研究中心、研究空了 1 分钟以上 → 说能排什么");
  await sup.tick(t0 + 21 * M);
  assert.ok(told.some((t) => /还有 10 分钟到截止/.test(t)));
  assert.equal(sup.stats.nudges, 1);
  assert.ok(sup.stats.healthTells >= 1 && sup.stats.researchTells >= 1 && sup.stats.deadlineTells === 1);
});
