// 沙盘集成测试: 进程外读内存和 RCON 真值逐项比。npm run test:sandbox
// 要本机 Factorio (FACTORIO_DIR)、python 3.12+、data/tools/pdb-dump.exe (npm run memory:setup)。
// 被读的是一个真正的游戏客户端 (观看窗口) 的进程: 服务器是无界面的, 读内存要的是带本地玩家的那个进程, 所以这个测试会开一个游戏窗口。
// 暂停着比 (客户端和服务器同一个 tick, 差别才是真差别); 再跑着连读几次看丢弃数和耗时, 会动的东西 (鱼、虫子) 位置会差, 只报不算错。
// MEMORY_TEST_SAVE=存档.zip 时用那份存档 (大基地) 代替新图; 默认新图 + 现摆的一组特殊状态 (compare.ts FIXTURE_LUA)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SandboxServer } from "../../game/sandbox/server.ts";
import { Viewer } from "../../game/sandbox/viewer.ts";
import { factorioExe } from "../../game/sandbox/paths.ts";
import { readEntities, readPlayer, readWorld, pdbDumpExe, type Row } from "../../game/memory/read.ts";
import { DETAIL_TRUTH_LUA, FIXTURE_LUA, Tally, bag, compareEntity } from "../../game/memory/compare.ts";
import { WORLD_TRUTH_LUA, compareWorld, type WorldMem, type WorldTruth } from "../../game/memory/world-compare.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lab = new SandboxServer({ name: "test-memory", view: false });
const viewer = new Viewer("test-memory", undefined, { playerName: "MemCheck" });
const exe = factorioExe(viewer.factorioDir);
let pid = 0;
let truthRows: Row[] = [];
let statusName: (n: number) => string = String;

const truthAll = async (): Promise<Row[]> => {
  const raw = await lab.exec(`local out = {} for _, e in pairs(game.surfaces[1].find_entities()) do out[#out + 1] = {name = e.name, x = e.position.x, y = e.position.y, type = e.type, unit = e.unit_number} end return out`, undefined, { maxReplyBytes: 512 * 1024 * 1024, timeoutMs: 120_000 });
  return Array.isArray(raw) ? (raw as Row[]) : [];
};
const bagOf = (rows: Row[]) => { const m = new Map<string, number>(); for (const e of rows) { const k = `${e.name}@${e.x},${e.y}`; m.set(k, (m.get(k) ?? 0) + 1); } return m; };
/** 多出来 / 少了的 (同一格可以站几个: 虫子) */
const diffBag = (a: Map<string, number>, b: Map<string, number>) => [...a].filter(([k, n]) => (b.get(k) ?? 0) < n).map(([k]) => k);
const ownedNames = () => [...new Set(truthRows.filter((e) => e.unit != null).map((e) => e.name))];

before(async () => {
  assert.ok(fs.existsSync(pdbDumpExe()), `没有 ${pdbDumpExe()}: 先 npm run memory:setup`);
  const save = process.env.MEMORY_TEST_SAVE;
  if (save) { lab.prepare(); fs.copyFileSync(save, lab.savePath("m")); } else await lab.createMap("m", { seed: 42 });
  await lab.start("m");
  await lab.rpc("time", { speed: 1, paused: false });
  const proc = viewer.launch(lab.gamePort);
  pid = proc.pid!;
  for (let i = 0; i < 90; i++) { await sleep(2000); if (((await lab.exec(`return #game.connected_players`)) as number) >= 1) break; }
  assert.ok(((await lab.exec(`return #game.connected_players`)) as number) >= 1, "观看窗口没连进来");
  await lab.rpc("viewer", {}).catch(() => undefined); // 退出开场动画, 角色不死
  // 真实基地见不到的状态现摆一组 (只改副本), 等它们转几秒进入稳定状态
  await lab.exec(FIXTURE_LUA, undefined, { timeoutMs: 120_000 });
  await sleep(6000);
  await lab.rpc("time", { speed: 1, paused: true });
  await sleep(1500);
  truthRows = await truthAll();
  const names = (await lab.exec(`local t = {} for k, v in pairs(defines.entity_status) do t[tostring(v)] = k end return t`)) as Record<string, string>;
  statusName = (n) => names[String(n)] ?? String(n);
});
after(async () => { viewer.close(); await lab.stop({ save: false }).catch(() => undefined); });

test("暂停着: 全地表实体的名字 + 位置逐个相等, 编号集合相等, 丢弃 0", () => {
  const m = readEntities(pid, exe, { owned: ownedNames() });
  const tb = bagOf(truthRows), mb = bagOf(m.entities);
  const onlyT = diffBag(tb, mb), onlyM = diffBag(mb, tb);
  const tu = new Set(truthRows.filter((e) => e.unit != null).map((e) => e.unit)), mu = new Set(m.entities.filter((e) => e.unit != null).map((e) => e.unit));
  const unitOnlyT = [...tu].filter((u) => !mu.has(u)), unitOnlyM = [...mu].filter((u) => !tu.has(u));
  // 同一个编号的实体, 名字和位置也要对上 (防止读错指针恰好读到别人的编号)
  const tById = new Map(truthRows.filter((e) => e.unit != null).map((e) => [e.unit, e]));
  const unitWrong = m.entities.filter((e) => e.unit != null && tById.has(e.unit) && (tById.get(e.unit)!.name !== e.name || tById.get(e.unit)!.x !== e.x || tById.get(e.unit)!.y !== e.y));
  const dropped = Object.values(m.dropped).reduce((n, c) => n + c, 0);
  console.log(`  RCON ${truthRows.length} 个; 内存 ${m.count} 个 (${m.chunks} 区块, ${m.ms} 毫秒, 布局 ${m.layout_ms} 毫秒); 丢弃 ${dropped}`);
  assert.deepEqual({ onlyT: onlyT.slice(0, 5), onlyM: onlyM.slice(0, 5) }, { onlyT: [], onlyM: [] }, `只有 RCON 有 ${onlyT.length}, 只有内存有 ${onlyM.length}`);
  assert.deepEqual({ unitOnlyT: unitOnlyT.slice(0, 5), unitOnlyM: unitOnlyM.slice(0, 5), unitWrong: unitWrong.slice(0, 3) }, { unitOnlyT: [], unitOnlyM: [], unitWrong: [] });
  assert.equal(dropped, 0, JSON.stringify(m.dropped));
  assert.ok(m.count > 0);
});

test("暂停着: 实体细节和推算的机器状态逐项等于真值 (方向、血量、配方、进出料、燃料、能量、带上物品、矿量)", async () => {
  const truthD = (await lab.exec(DETAIL_TRUTH_LUA, undefined, { maxReplyBytes: 512 * 1024 * 1024, timeoutMs: 120_000 })) as { rows: Record<string, any>[]; resources: Record<string, any>[] };
  const md = readEntities(pid, exe, { owned: ownedNames(), details: true, proto: path.join(lab.prototypesDir(), "data-raw-dump.json") });
  const memByUnit = new Map(md.entities.filter((e) => e.unit != null).map((e) => [e.unit, e]));
  const memRes = new Map(md.entities.filter((e) => e.d?.cls === "ResourceEntity").map((e) => [`${e.name}@${e.x},${e.y}`, e]));
  const tally = new Tally();
  for (const row of Array.isArray(truthD.rows) ? truthD.rows : []) {
    const m = memByUnit.get(row.unit);
    compareEntity(tally, row, m?.d, `${row.name}(${row.x},${row.y})`, statusName);
    if (m?.d_error) tally.add("读细节出错", false, () => `${row.name}: ${m.d_error}`);
  }
  for (const res of Array.isArray(truthD.resources) ? truthD.resources : []) {
    const m = memRes.get(`${res.name}@${res.x},${res.y}`);
    tally.add("矿量", m?.d?.amount === res.amount, () => `${res.name}(${res.x},${res.y}): 真值 ${res.amount} 内存 ${m?.d?.amount}`);
  }
  console.log(`  细节共比 ${tally.total} 项, 不一样 ${tally.bad} 项 (读 ${md.ms} 毫秒)`);
  const bad = [...tally.fields.values()].filter((f) => f.bad).map((f) => `${f.name} ${f.bad}/${f.compared}: ${f.examples.join(" | ")}`);
  assert.deepEqual(bad, []);
  assert.ok(tally.total > 50, `只比了 ${tally.total} 项`);
});

test("暂停着: 世界数据 (研究、科技、修正、进化度、污染、统计累计) 等于真值", async () => {
  const truth = (await lab.exec(WORLD_TRUTH_LUA, undefined, { maxReplyBytes: 512 * 1024 * 1024, timeoutMs: 120_000 })) as WorldTruth;
  const mem = readWorld(pid, exe) as WorldMem;
  assert.deepEqual(mem.errors ?? {}, {}, "读世界数据出错");
  const w = compareWorld(truth, mem);
  console.log(`  世界数据共比 ${w.total} 项, 不一样 ${w.diffs.length} 项`);
  assert.deepEqual(w.diffs.slice(0, 10), []);
  assert.ok(w.total > 100);
});

test("暂停着: 本地玩家的位置和主背包等于真值", async () => {
  const truth = (await lab.exec(`local p = game.connected_players[1] local c = p.character if not c then return {no_body = p.controller_type} end
    local inv = {} for _, it in pairs(c.get_main_inventory().get_contents()) do inv[#inv + 1] = {name = it.name, quality = it.quality, count = it.count} end
    return {x = c.position.x, y = c.position.y, inv = inv}`)) as { x: number; y: number; inv: { name: string; quality: string; count: number }[]; no_body?: number };
  assert.equal(truth.no_body, undefined, `窗口里的玩家没有身体 (控制器 ${truth.no_body})`);
  const p = readPlayer(pid, exe, { names: true });
  assert.ok(Math.abs(p.position.x - truth.x) < 0.02 && Math.abs(p.position.y - truth.y) < 0.02, `位置 真值 ${truth.x},${truth.y} 内存 ${p.position.x},${p.position.y}`);
  // 品质: 读内存给的是编号, 这里只比名字和数量 (都是普通品质的开局物品)
  const merged = new Map<string, number>();
  for (const s of p.inventory.slots) merged.set(s.name ?? String(s.item), (merged.get(s.name ?? String(s.item)) ?? 0) + s.count);
  const memBag = [...merged].map(([name, count]) => `${name}*${count}`).sort();
  const truthBag = bag(truth.inv).map((s) => s.replace("@normal", ""));
  assert.deepEqual(memBag, truthBag);
  console.log(`  背包 ${p.inventory.slots.length} 格非空, 读 ${p.reads} 次 ${p.ms} 毫秒`);
});

test("跑着连读 5 次: 丢弃 0; 和真值只差会动的东西", async () => {
  await lab.rpc("time", { speed: 1, paused: false });
  await sleep(2000);
  const runs = [];
  for (let i = 0; i < 5; i++) { const r = readEntities(pid, exe); runs.push({ count: r.count, ms: r.ms, dropped: Object.values(r.dropped).reduce((n, c) => n + c, 0) }); }
  console.log(`  ${runs.map((r) => `${r.count} 个 ${r.ms} 毫秒 丢弃 ${r.dropped}`).join(" | ")}`);
  assert.deepEqual(runs.map((r) => r.dropped), [0, 0, 0, 0, 0]);
  const t2 = await truthAll(), m2 = readEntities(pid, exe);
  const moved = diffBag(bagOf(t2), bagOf(m2.entities));
  const movedBy: Record<string, number> = {};
  for (const k of moved) { const n = k.split("@")[0]; movedBy[n] = (movedBy[n] ?? 0) + 1; }
  console.log(`  跑着对真值: RCON ${t2.length} 个; 内存 ${m2.count} 个; 位置不同 ${moved.length} 个 ${JSON.stringify(movedBy)}`);
  // 不会动的东西不该差: 建筑、树、矿。会动 / 会消失的按真值里的类型认 (鱼、虫子、角色、机器人、爆炸、烟、火、弹)
  const typeOf = new Map(t2.map((e) => [e.name, e.type ?? ""]));
  const MOVING = /^(fish|unit|character|explosion|smoke|smoke-with-trigger|fire|stream|projectile|artillery-projectile|particle-source|beam|sticker|flying-text|logistic-robot|construction-robot|combat-robot|cargo-pod|car|spider-vehicle|locomotive|cargo-wagon|fluid-wagon|artillery-wagon|rocket-silo-rocket)$/;
  const still = Object.keys(movedBy).filter((n) => !MOVING.test(typeOf.get(n) ?? "")).map((n) => `${n} (${typeOf.get(n) ?? "内存里多出来的"})`);
  assert.deepEqual(still, [], `不会动的东西位置也不同: ${JSON.stringify(movedBy)}`);
});
