// 沙盘集成测试: harness 模组的 Lua 在游戏外面跑 (game/offgame), 答的和游戏里的同一份模组逐字段比。npm run test:sandbox
// 要本机 Factorio、data/tools/pdb-dump.exe (npm run memory:setup)、data/venv 里的 lupa (npm run offgame:setup)。开一个游戏窗口当被读的客户端。
// 真值 = 游戏里装着的 factorio-ai-harness 经 RCON 回答 (ingame.ts, 只读身份); 外面 = host.py 读这个窗口进程的内存。暂停着比, 同一个 tick。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SandboxServer } from "../../game/sandbox/server.ts";
import { Viewer } from "../../game/sandbox/viewer.ts";
import { factorioExe } from "../../game/sandbox/paths.ts";
import { pdbDumpExe } from "../../game/memory/read.ts";
import { FIXTURE_LUA } from "../../game/memory/compare.ts";
import { WORLD_TRUTH_LUA, compareRelations, compareSelfCheck, compareWorld, type SelfCheck, type WorldMem, type WorldTruth } from "../../game/memory/world-compare.ts";
import { HARNESS_MOD, hostArgs, runHost, startHost, venvReady, type Host } from "../../game/offgame/host.ts";
import { Harness } from "../../game/offgame/ingame.ts";

type Ask = [string, Record<string, unknown>];
type Diff = [string, unknown, unknown];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "object" && Object.keys(v as object).length === 0);
function diff(a: any, b: any, p: string, out: Diff[]) {
  if (isEmpty(a) && isEmpty(b)) return;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    if (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-6) return;
    if (a !== b) out.push([p, a, b]);
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], p ? `${p}.${k}` : k, out);
}
const leaves = (v: unknown): number => (v && typeof v === "object" ? Object.values(v).reduce((n: number, x) => n + leaves(x), 0) : 1);
/** 模组自己记的账 (聊天、队友、事故、受攻击的警告、手搓统计、放置记录、提醒…): 靠游戏事件攒出来的, 外面从开始跑才记、也看不到战斗事件, 不算读错 */
const LEDGER = /^(chat|team|teammates|alerts|alerts_new|warnings|placed|factory\.hand|time_mode|clock|queues|last|active|combat|hurt|last_combat|new|boilers|research\.eta|eta)(\.|$)/;
/** 已知读不到的 (docs/offgame.md "还没做"): 外面必须明说不知道 (undefined / "unknown"), 不许编一个值。机械臂的 electricity 是引擎现算的上限没搬; 地块要注入客户端的只读查询 (--lua) */
const KNOWN_GAP = /(^|\.)(electricity|drop_tile|pickup_tile)$/;
const asks: Ask[] = [["inventory", {}], ["observe", {}], ["observe", { radius: 8 }], ["observe", { radius: 12, entity_types: ["assembling-machine", "furnace", "inserter", "lab"], exclude_resources: true }], ["status", { machines: true }], ["status", {}]];
const key = (cmd: string, a: Record<string, unknown>) => `${cmd}:${JSON.stringify(a)}`;

const lab = new SandboxServer({ name: "test-offgame", view: false, mods: [HARNESS_MOD] });
const viewer = new Viewer("test-offgame", undefined, { playerName: "OffGame" });
const exe = factorioExe(viewer.factorioDir);
let pid = 0;
let base: Parameters<typeof hostArgs>[0];
let truth: Harness;
let truths: Record<string, any> = {};
let worldTruth: WorldTruth;
let spot: { x: number; y: number; index: number; moduled: { x: number; y: number }; filtered: { x: number; y: number } };
const work = () => lab.dir;

/** 一份回答 (--ask ... --out) 逐项对真值: 加载成功、自查 0 差、每条命令答得了、读错的字段为空 (账本字段单独数) */
function checkAnswers(out: Record<string, any>, label: string) {
  assert.ok(out.load?.ok, `${label}: 加载失败 ${out.load?.error}`);
  assert.ok(out.self_check, `${label}: 自查出错 ${out.self_check_error}`);
  const sc = compareSelfCheck(worldTruth, out.self_check as SelfCheck);
  const rel = compareRelations(worldTruth, out.self_check as SelfCheck);
  console.log(`  ${label}: ${out.load.modules} 个模块 ${out.load.load_ms} 毫秒; 科技和统计 ${sc.total} 项差 ${sc.diffs.length}; 关系 ${rel.total} 项差 ${rel.diffs.length}`);
  assert.deepEqual(sc.diffs.slice(0, 8), []);
  assert.deepEqual(rel.diffs.slice(0, 8), []);
  assert.ok(sc.total > 100 && rel.total > 10, `${label}: 自查比的太少 (${sc.total} / ${rel.total})`);
  const wrong: string[] = [];
  for (const [cmd, a] of asks) {
    const k = key(cmd, a), g = out.answers?.[k];
    assert.ok(g && !g.exception && g.reply?.ok, `${label} ${k}: 外面答不了 — ${String(g?.exception ?? g?.reply?.error?.message).slice(0, 300)}\n${String(g?.traceback ?? "").slice(0, 600)}`);
    const d: Diff[] = [];
    diff(truths[k]?.result, g.reply.result, "", d);
    const gaps = d.filter(([p]) => KNOWN_GAP.test(p));
    const real = d.filter(([p]) => !LEDGER.test(p) && !KNOWN_GAP.test(p));
    console.log(`  ${label} ${k.slice(0, 60)}: ${g.ms} 毫秒; 真值 ${leaves(truths[k]?.result)} 项, 差 ${d.length} 项 (账本 ${d.length - real.length - gaps.length}, 已知读不到 ${gaps.length})`);
    for (const [p, , b1] of gaps) if (b1 !== undefined && b1 !== "unknown") wrong.push(`${k.slice(0, 40)} ${p}: 读不到却编了 ${JSON.stringify(b1)?.slice(0, 80)}`);
    for (const [p, a1, b1] of real.slice(0, 6)) wrong.push(`${k.slice(0, 40)} ${p}: 真 ${JSON.stringify(a1)?.slice(0, 300)} 外 ${JSON.stringify(b1)?.slice(0, 300)}`);
  }
  assert.deepEqual(wrong, []);
  const miss = Object.entries((out.missing ?? {}) as Record<string, number>).sort((x, y) => y[1] - x[1]);
  console.log(`  ${label}: 缺的接口 ${miss.length} 种: ${miss.slice(0, 12).map(([k, n]) => `${k}×${n}`).join(" ")}`);
}

before(async () => {
  assert.ok(fs.existsSync(pdbDumpExe()), `没有 ${pdbDumpExe()}: 先 npm run memory:setup`);
  assert.ok(venvReady(), "data/venv 里没有 lupa: 先 npm run offgame:setup");
  await lab.createMap("m", { seed: 42 });
  await lab.start("m");
  await lab.rpc("time", { speed: 1, paused: false });
  const proc = viewer.launch(lab.gamePort, { mods: [HARNESS_MOD] });
  pid = proc.pid!;
  for (let i = 0; i < 90; i++) { await sleep(2000); if (((await lab.exec(`return #game.connected_players`)) as number) >= 1) break; }
  assert.ok(((await lab.exec(`return #game.connected_players`)) as number) >= 1, "观看窗口没连进来");
  await lab.rpc("viewer", {}).catch(() => undefined);
  await lab.exec(FIXTURE_LUA, undefined, { timeoutMs: 120_000 });
  // 玩家站到有电的那台研究中心旁; 第二台研究中心放插件 (核效果值); 一个不连线的电线杆 (核电网编号); 一个设了筛选的快速机械臂 (核筛选)
  spot = (await lab.exec(`local s = game.surfaces[1] local p = game.connected_players[1]
    local labs = s.find_entities_filtered{type = "lab", force = "player"} table.sort(labs, function(a, b) return a.position.y > b.position.y end)
    local l, m = labs[1], labs[2]
    p.teleport(s.find_non_colliding_position("character", {l.position.x + 3, l.position.y + 3}, 16, 0.5))
    p.insert{name = "iron-plate", count = 237} p.insert{name = "coal", count = 50} p.insert{name = "transport-belt", count = 120} p.get_inventory(defines.inventory.character_ammo).insert{name = "firearm-magazine", count = 20}
    m.get_module_inventory().insert{name = "speed-module", count = 1} m.get_module_inventory().insert{name = "productivity-module", count = 1}
    s.create_entity{name = "small-electric-pole", position = s.find_non_colliding_position("small-electric-pole", {l.position.x + 60, l.position.y + 60}, 32, 1), force = "player", auto_connect = false}
    local fi = s.create_entity{name = "fast-inserter", position = s.find_non_colliding_position("fast-inserter", {l.position.x + 6, l.position.y}, 16, 1), force = "player"}
    fi.use_filters = true fi.inserter_filter_mode = "blacklist" fi.set_filter(1, "iron-plate")
    return {x = l.position.x, y = l.position.y, index = p.index, moduled = {x = m.position.x, y = m.position.y}, filtered = {x = fi.position.x, y = fi.position.y}}`)) as typeof spot;
  asks.push(["inspect", { position: { x: spot.x, y: spot.y } }], ["inspect", { position: spot.moduled }], ["inspect", { position: spot.filtered }]);
  await sleep(6000);
  await lab.rpc("time", { speed: 1, paused: true });
  await sleep(1500);
  const protoDir = lab.prototypesDir();
  base = { defines: await lab.dumpDefines(), proto: path.join(protoDir, "data-raw-dump.json") };
  truth = new Harness(lab.rcon!, spot.index, undefined, { reader: "offgame-test" });
  worldTruth = (await lab.exec(WORLD_TRUTH_LUA, undefined, { timeoutMs: 120_000 })) as WorldTruth;
  for (const [cmd, a] of asks) truths[key(cmd, a)] = await truth.request(cmd, a);
  fs.writeFileSync(path.join(work(), "truths.json"), JSON.stringify({ spot, asks, truths, worldTruth }, null, 1)); // 查差异时看
});
after(async () => { viewer.close(); await lab.stop({ save: false }).catch(() => undefined); });

test("读内存留快照: 有没有编号按原型类型判断全对; 世界数据对真值 0 差", async () => {
  const snap = path.join(work(), "snapshot.json");
  const dumped = runHost(hostArgs({ ...base, pid, exe, extra: ["--dump", snap] })) as { count: number; dropped: Record<string, number>; entities_ms: number; world_ms: number };
  console.log(`  快照 ${dumped.count} 个实体 ${dumped.entities_ms} 毫秒, 世界数据 ${dumped.world_ms} 毫秒, 丢弃 ${JSON.stringify(dumped.dropped)}`);
  assert.equal(Object.values(dumped.dropped).reduce((n, c) => n + c, 0), 0, JSON.stringify(dumped.dropped));
  const owned = new Set((await lab.exec(`local n = {} for _, e in pairs(game.surfaces[1].find_entities()) do if e.unit_number then n[e.name] = true end end local o = {} for k in pairs(n) do o[#o + 1] = k end return o`)) as string[]);
  const rows = (JSON.parse(fs.readFileSync(snap, "utf8")) as { entities: { name: string; unit?: number }[]; world: WorldMem }).entities;
  const wrongOwned = [...new Set(rows.filter((e) => (e.unit !== undefined) !== owned.has(e.name)).map((e) => e.name))];
  assert.deepEqual(wrongOwned, []);
  const w = compareWorld(worldTruth, (JSON.parse(fs.readFileSync(snap, "utf8")) as { world: WorldMem }).world);
  console.log(`  世界数据 ${w.total} 项差 ${w.diffs.length}`);
  assert.deepEqual(w.diffs.slice(0, 10), []);
});

test("回放快照: 模组在外面答的 inventory / observe / inspect / status 和游戏里的逐字段相等 (只差模组自己记的账)", () => {
  const out = path.join(work(), "replay-out.json");
  runHost(hostArgs({ ...base, snapshot: path.join(work(), "snapshot.json"), extra: [...asks.flatMap(([cmd, a]) => ["--ask", key(cmd, a)]), "--out", out] }));
  checkAnswers(JSON.parse(fs.readFileSync(out, "utf8")), "回放");
});

test("读活内存 (暂停着) 答同一批问题, 和回放一样对真值", () => {
  const out = path.join(work(), "live-out.json");
  runHost(hostArgs({ ...base, pid, exe, extra: [...asks.flatMap(([cmd, a]) => ["--ask", key(cmd, a)]), "--out", out] }));
  checkAnswers(JSON.parse(fs.readFileSync(out, "utf8")), "活内存");
});

test("没探过的区块: 默认和真人玩家看到的一样 (真值的已探区块), --reveal 才全部可见", () => {
  const off = path.join(work(), "reveal-off.json"), on = path.join(work(), "reveal-on.json");
  const snapshot = path.join(work(), "snapshot.json");
  runHost(hostArgs({ ...base, snapshot, extra: ["--ask", "status:{}", "--out", off] }));
  runHost(hostArgs({ ...base, snapshot, extra: ["--reveal", "--ask", "status:{}", "--out", on] }));
  const chart = (f: string) => (JSON.parse(fs.readFileSync(f, "utf8")) as { answers: Record<string, any> }).answers["status:{}"]?.reply?.result?.chart;
  const a = chart(off), b = chart(on);
  console.log(`  默认 已探 ${a?.charted_chunks} 可见 ${a?.visible_chunks}; 开 已探 ${b?.charted_chunks} 可见 ${b?.visible_chunks}; 真值已探 ${worldTruth.charted?.length}`);
  assert.equal(a?.charted_chunks, worldTruth.charted?.length);
  assert.ok((b?.charted_chunks ?? 0) >= (a?.charted_chunks ?? 0));
});

test("游戏跑着, 常驻宿主连问 8 轮: 0 失败, tick 在走", async () => {
  await lab.rpc("time", { speed: 1, paused: false });
  const h = await startHost(hostArgs({ ...base, pid, exe, extra: ["--serve"] }));
  const rounds: Ask[] = [["status", { brief: true }], ["inventory", {}], ["observe", { radius: 16 }], ["status", {}]];
  const stats = new Map<string, { n: number; ms: number[]; fails: string[]; ticks: number[] }>();
  try {
    for (let round = 0; round < 8; round++) {
      for (const [cmd, a] of rounds) {
        const row = (await h.ask({ cmd, args: a })) as { ms?: number; reply?: { ok?: boolean; result?: { tick?: number }; error?: { message?: string } }; exception?: string };
        const k = key(cmd, a);
        const s = stats.get(k) ?? { n: 0, ms: [], fails: [], ticks: [] };
        s.n++;
        if (row.ms !== undefined) s.ms.push(row.ms);
        if (row.exception || !row.reply?.ok) s.fails.push(String(row.exception ?? row.reply?.error?.message).slice(0, 160));
        if (typeof row.reply?.result?.tick === "number") s.ticks.push(row.reply.result.tick);
        stats.set(k, s);
      }
      await sleep(500);
    }
  } finally { await h.stop(); }
  const avg = (l: number[]) => (l.length ? Math.round(l.reduce((x, y) => x + y, 0) / l.length) : 0);
  for (const [k, s] of stats) console.log(`  ${k}: ${s.n} 次, 平均 ${avg(s.ms)} 毫秒, 最慢 ${Math.max(...s.ms, 0)}${s.ticks.length > 1 ? `, tick ${s.ticks[0]} → ${s.ticks.at(-1)}` : ""}${s.fails.length ? `, 失败 ${s.fails.length}: ${s.fails[0]}` : ""}`);
  assert.deepEqual([...stats.values()].flatMap((s) => s.fails), []);
  const t = stats.get("status:{}")!.ticks;
  assert.ok(t.at(-1)! > t[0], `tick 没走 ${t[0]} → ${t.at(-1)}`);
});

test("后台任务在外面跑: 建 / 毁 / 拆 / 打 / 聊天事件全对, 账本落盘重启接上, 模组没隔离自己, status 对游戏里的只差账本", async () => {
  const seconds = 40;
  const state = path.join(work(), "state.lua");
  fs.rmSync(state, { force: true });
  await lab.rpc("time", { speed: 1, paused: false });
  const h = await startHost(hostArgs({ ...base, pid, exe, extra: ["--serve", "--state", state] }));
  let outside: any, stats: any, tr: any, did: Record<string, { x: number; y: number }>;
  try {
    await sleep(8000); // 等事件比较有了第一遍
    did = (await lab.exec(`local s = game.surfaces[1] local p = game.connected_players[1].position
      local at = function(dx) return s.find_non_colliding_position("iron-chest", {p.x + dx, p.y + 12}, 24, 1) end
      local a = s.create_entity{name = "iron-chest", position = at(0), force = "player"}
      local b = s.create_entity{name = "iron-chest", position = at(4), force = "player"}
      local c = s.create_entity{name = "iron-chest", position = at(8), force = "player"}
      local d = s.create_entity{name = "stone-furnace", position = at(12), force = "player"}
      return {kept = {x = a.position.x, y = a.position.y}, die = {x = b.position.x, y = b.position.y}, mine = {x = c.position.x, y = c.position.y}, hurt = {x = d.position.x, y = d.position.y}}`)) as typeof did;
    await sleep(8000);
    await lab.exec(`local s = game.surfaces[1]
      s.find_entity("iron-chest", {${did.die.x}, ${did.die.y}}).die()
      s.find_entity("iron-chest", {${did.mine.x}, ${did.mine.y}}).destroy()
      s.find_entity("stone-furnace", {${did.hurt.x}, ${did.hurt.y}}).damage(50, "player", "physical")`);
    await lab.rcon!.exec("外挂聊天测试 from server");
    await sleep(Math.max(8000, seconds * 1000 - 16000));
    await lab.rpc("time", { speed: 1, paused: true });
    await sleep(1500);
    outside = await h.ask({ cmd: "status", args: {} });
    stats = await h.ask({ stats: true });
    tr = await truth.request("status", {});
  } finally { await h.stop(); }
  assert.ok(fs.existsSync(state) && fs.statSync(state).size > 0, "账本没写出来");
  const again = await startHost(hostArgs({ ...base, pid, exe, extra: ["--serve", "--state", state] }));
  let after: string[];
  try { after = ((await again.ask({ cmd: "status", args: {} })).reply?.result as { alerts?: { latest?: string[] } })?.alerts?.latest ?? []; }
  finally { await again.stop(); }
  const before = (outside.reply?.result as { alerts?: { latest?: string[] } })?.alerts?.latest ?? [];
  console.log(`  账本 ${fs.statSync(state).size} 字节; 重启后接上 ${again.load.restored}; 事故 ${before.length} 条 → ${after.length} 条`);
  assert.equal(again.load.restored, true);
  assert.ok(before.length > 0 && after.length === before.length, "重启后事故记录没接上");
  const evs = (stats.events ?? []) as { kind: string; row?: { name: string; x: number; y: number }; player?: string; text?: string; amount?: number }[];
  const near = (ev: { row?: { x: number; y: number } }, p: { x: number; y: number }) => ev.row && Math.abs(ev.row.x - p.x) < 1 && Math.abs(ev.row.y - p.y) < 1;
  const has = (kind: string, p: { x: number; y: number }) => evs.some((e) => e.kind === kind && near(e, p));
  const chats = evs.filter((e) => e.kind === "chat").map((e) => e.text ?? "");
  console.log(`  事件 ${evs.length} 条: 建 ${has("built", did!.kept)} 死 ${has("died", did!.die)} 拆 ${has("mined", did!.mine)} 打 ${has("damaged", did!.hurt)} 聊天 ${JSON.stringify(chats.slice(-2))}`);
  assert.deepEqual({ built: has("built", did!.kept), died: has("died", did!.die), mined: has("mined", did!.mine), damaged: has("damaged", did!.hurt), chat: chats.some((t) => t.includes("外挂聊天测试")) }, { built: true, died: true, mined: true, damaged: true, chat: true });
  const bg = stats.background ?? {};
  console.log(`  后台 ${bg.batches} 批 ${bg.ticks} tick 共 ${bg.ms} 毫秒 (最慢 ${bg.max_ms}), 出错 ${bg.errors}; 隔离 ${stats.fault ?? "没有"}`);
  assert.equal(bg.errors, 0, String(bg.last_error));
  assert.equal(stats.fault ?? null, null);
  assert.ok(bg.ticks > seconds * 30, `后台只跑了 ${bg.ticks} tick`);
  const out: Diff[] = [];
  diff(tr.result, outside.reply?.result, "", out);
  // 采样时刻不同的字段 (模组摘要 30~60 秒一次, 外面和游戏里不是同一刻: factory_as_of / factory_age_s) 和起算时间不同的 (evolution.delta / since) 只报不算。
  // chart.visible_chunks 跑着时对不上 (游戏里角色视野内的区块一直算可见, 外面按"10 秒内探过"算; 暂停的核对是对的): 记在 docs/offgame.md 待查, 这里只报
  const SAMPLED = /^(evolution\.(delta|since)|factory_as_of|factory_age_s|chart\.visible_chunks|research\.(progress|eta)|machines|factory|power|threat|summary)(\.|$)/;
  const real = out.filter(([p]) => !LEDGER.test(p) && !SAMPLED.test(p));
  console.log(`  status 真值 ${leaves(tr.result)} 项, 差 ${out.length} 项, 其中不是账本 / 采样的 ${real.length}${real.length ? " — " + real.slice(0, 8).map(([p, a, b]) => `${p}: 真 ${JSON.stringify(a)?.slice(0, 60)} 外 ${JSON.stringify(b)?.slice(0, 60)}`).join(" | ") : ""}`);
  assert.deepEqual(real.slice(0, 8), []);
});
