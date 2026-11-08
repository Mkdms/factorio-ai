// 沙盘集成测试: ./fh 的动作走"游戏外的模组 + 玩家操作" (commands/), 服务器不装 harness (和联机一样, 只有沙盘模组给测试读真值), 每项做完用 RCON 读真值。
// npm run test:sandbox。要: data/client (npm run client:setup)、data/venv (offgame:setup)、data/tools/pdb-dump.exe (memory:setup)。开一个游戏窗口 (后面再开第二个核"别的玩家")。
// 链路: 派对命令行 (commands/cli, FH_SOCKET) → 我们的代理 (commands/broker.ts, 真服模式) → 读: 游戏外的模组宿主 (game/offgame); 动作: 行动层 (commands/actions.ts → body.ts → game/client)。
// 没搬进来的几项 (开班那块接): 教训自动带出、./bp build 贴蓝图、开班扫描、真人聊天进回复。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SandboxServer, freeTcpPort } from "../../game/sandbox/server.ts";
import { Viewer } from "../../game/sandbox/viewer.ts";
import { ROOT, factorioExe } from "../../game/sandbox/paths.ts";
import { loadDefines } from "../../game/sandbox/defines.ts";
import { pdbDumpExe } from "../../game/memory/read.ts";
import { hostArgs, venvPython, venvReady } from "../../game/offgame/host.ts";
import { clientReady } from "../../game/client/connect.ts";
import { CommandBroker } from "../../commands/broker.ts";
import { Body } from "../../commands/body.ts";
import { closeWindows, openCharacterGui, readTree } from "../../commands/gui.ts";
import { PlayerActions } from "../../commands/actions.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const execFileAsync = promisify(execFile);
type Reply = { ok?: boolean; result?: Record<string, any>; error?: { message?: string } };
type Pos = { x: number; y: number };

const lab = new SandboxServer({ name: "test-actions", view: false });
const viewer = new Viewer("test-actions", undefined, { playerName: "ActCheck" });
const exe = factorioExe(viewer.factorioDir);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "factorio-ai-actions-"));
const pipe = `\\\\.\\pipe\\factorio-ai-actions-${process.pid}`;
let target: Body;
let broker: CommandBroker;
let second: Viewer | null = null;
let home: { x: number; y: number; index: number; name: string };
const assistAllow: Pos[] = [];
const cli = path.join(ROOT, "commands", "cli", "cli.js");

const fh = async (...argv: string[]): Promise<Reply> => {
  const { FACTORIO_RCON_HOST: _h, FACTORIO_RCON_PORT: _p, FACTORIO_RCON_PASSWORD_FILE: _f, FACTORIO_RCON_PASSWORD: _w, ...noRcon } = process.env;
  const env = { ...noRcon, FH_SOCKET: pipe, FH_REF_DIR: work, FH_DESCRIBE_CACHE: path.join(work, "describe.json") };
  try {
    // 代理就在这个进程里, 不能 execFileSync (事件循环堵死代理)。--timeout: 动作要做几秒, 默认 5 秒没回命令行就重发
    const { stdout } = await execFileAsync(process.execPath, [cli, ...argv, "--format", "json", "--timeout", "90000", "--journal", path.join(work, "j.jsonl")], { cwd: work, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000, windowsHide: true });
    return JSON.parse(stdout) as Reply;
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    if (out) { try { return JSON.parse(out) as Reply; } catch { /* 下面报原文 */ } }
    throw new Error(`${(e as { stderr?: string }).stderr ?? ""}${(e as Error).message}`.slice(0, 500));
  }
};
const act = (action: string, args: unknown, ...more: string[]) => fh("call", action, "--args", JSON.stringify(args), ...more);
const truth = <T,>(lua: string, arg?: unknown) => lab.exec(lua, arg, { timeoutMs: 60_000 }) as Promise<T>;
const myCount = (item: string) => truth<number>(`return game.connected_players[1].get_main_inventory().get_item_count("${item}")`);
const P = (dx: number, dy: number): Pos => ({ x: Math.floor(home.x) + dx + 0.5, y: Math.floor(home.y) + dy + 0.5 });
const seenOf = (r: Reply) => (r.ok ? JSON.stringify(r.result) : `error: ${r.error?.message}`);
const clearArea = async (x0: number, y0: number, x1: number, y1: number) => { await lab.rpc("prepare_area", { area: [[Math.floor(home.x) + x0, Math.floor(home.y) + y0], [Math.floor(home.x) + x1, Math.floor(home.y) + y1]], no_enemies: true }, { timeoutMs: 60_000 }); await lab.rpc("time", { speed: 1, paused: false }); };
const entityAt = (name: string, p: Pos) => truth<{ found?: boolean; direction?: number; recipe?: string; fuel?: number } | null>(`local a = ... local e = game.surfaces[1].find_entity(a.name, a.p) if not e then return {found = false} end
  local r = e.type == "assembling-machine" and e.get_recipe() or nil
  local fi = e.get_fuel_inventory and e.get_fuel_inventory() or nil
  return {found = true, direction = e.direction, recipe = r and r.name or "", fuel = fi and fi.get_item_count() or 0}`, { name, p });
/** 一项核对: 回 pass + 看到了什么; 不过就把看到的打出来 */
const check = async (fn: () => Promise<{ pass: boolean; seen: string }>) => {
  const t0 = Date.now();
  const r = await fn();
  console.log(`  ${r.pass ? "过" : "不过"} (${((Date.now() - t0) / 1000).toFixed(1)} 秒): ${r.seen.slice(0, 600)}`);
  assert.ok(r.pass, r.seen.slice(0, 900));
};
const need = (n: string) => `需要 ${n}`;

before(async () => {
  assert.ok(clientReady(), need("data/client (npm run client:setup)"));
  assert.ok(venvReady(), need("data/venv 里的 lupa (npm run offgame:setup)"));
  assert.ok(fs.existsSync(pdbDumpExe()), need("data/tools/pdb-dump.exe (npm run memory:setup)"));
  await lab.createMap("m", { seed: 42 });
  await lab.start("m");
  await lab.rpc("time", { speed: 1, paused: false });
  const proc = viewer.launch(lab.gamePort);
  for (let i = 0; i < 90; i++) { await sleep(2000); if (((await lab.exec(`return #game.connected_players`)) as number) >= 1) break; }
  await lab.rpc("viewer", {}).catch(() => undefined);
  await sleep(2000);
  const defines = loadDefines(path.dirname(await lab.dumpDefines()));
  target = new Body(await freeTcpPort(), defines, { gameExe: exe });
  await target.start();
  await target.attach(proc.pid!);
  await target.prepare();
  console.log(`  挂上了 ${proc.pid}; 原型 ID ${target.idsSource ?? target.idsError}`);
  // 找一块空地当考场: 玩家放过去, 给料
  home = (await lab.exec(`local s = game.surfaces[1] local p = game.connected_players[1]
    local c = p.character
    if not c then return {error = "没有身体"} end
    local at = s.find_non_colliding_position("character", {80, 40}, 60, 1)
    p.teleport(at)
    local inv = p.get_main_inventory()
    inv.clear()
    for _, st in pairs({{"stone-furnace", 6}, {"coal", 60}, {"iron-ore", 60}, {"iron-plate", 80}, {"wooden-chest", 4}, {"inserter", 6}, {"transport-belt", 30}, {"assembling-machine-1", 3}, {"copper-plate", 40}, {"small-electric-pole", 10}}) do inv.insert{name = st[1], count = st[2]} end
    return {x = at.x, y = at.y, index = p.index, name = p.name}`)) as typeof home & { error?: string };
  assert.ok(!(home as { error?: string }).error, (home as { error?: string }).error);
  await lab.rpc("viewer", { position: [home.x, home.y], zoom: 1 }).catch(() => undefined);
  await sleep(800);
  const protoDir = lab.prototypesDir();
  const raw = JSON.parse(fs.readFileSync(path.join(protoDir, "data-raw-dump.json"), "utf8")) as { recipe?: Record<string, { energy_required?: number }> };
  const actions = new PlayerActions({
    call: target.call, controls: () => target.controls!, defines: () => target.defines, tick: () => target.tick(),
    holdItem: (i) => target.holdItem(i), placeHeld: (at) => target.placeHeld(at), clearCursor: () => target.clearCursor(), ensureBody: () => target.ensureBody(), setRecipe: (at, r) => target.setRecipe(at, r),
    insertExact: (at, i, n, inv) => target.insertExactDirect(at, i, n, inv), takeExact: (at, i, n, inv) => target.takeExactDirect(at, i, n, inv), itemCount: (at, inv, i) => target.entityItemCount(at, inv, i),
    stacks: () => target.inventorySlots(), chatSend: (t) => target.chatSend(t), recipeTime: (r) => raw.recipe?.[r]?.energy_required ?? (raw.recipe?.[r] ? 0.5 : null),
    assist: { me: home.name, allowed: (at) => assistAllow.some((p) => Math.hypot(p.x - at.x, p.y - at.y) < 0.6) },
    // 放不下时问模组 placements (和 core/run/online.ts 同一个接法; 代理在下面才建)
    read: (a, args, act) => (broker ? broker.read(a, args, act) : Promise.resolve(null)),
    nextUpgrade: (n) => { const all = raw as unknown as Record<string, Record<string, { next_upgrade?: unknown }>>; for (const rows of Object.values(all)) { const u = rows?.[n]?.next_upgrade; if (typeof u === "string") return u; } return null; },
    setRequest: (at, item, min, max) => target.setRequest(at, item, min, max),
  });
  broker = new CommandBroker({ pipe, python: venvPython(), probeArgs: hostArgs({ defines: path.join(protoDir, "defines.json"), proto: path.join(protoDir, "data-raw-dump.json"), pid: proc.pid!, exe, extra: ["--serve"] }), mode: "server", rcon: null, actions, luaRead: (a) => target.call("world_query", a) });
  await broker.start();
  await clearArea(-16, -16, 40, 24);
});
after(async () => {
  await broker?.stop().catch(() => undefined);
  await target?.stop().catch(() => undefined);
  viewer.close();
  second?.close();
  await lab.stop({ save: false }).catch(() => undefined);
  fs.rmSync(work, { recursive: true, force: true });
});

let furnace: Pos, fp: Pos, chest: Pos, asm: Pos, ins: Pos;

test("读: inventory 走外面 (游戏外的模组宿主答)", () => check(async () => { const r = await fh("call", "inventory"); return { pass: !!r.ok && String(r.result?.inventory ?? "").includes("stone-furnace"), seen: String(r.result?.inventory ?? seenOf(r)).slice(0, 200) }; }));
test("move_to 走 8 格", () => check(async () => {
  const r = await act("move_to", { position: P(8, 0) }, "--wait");
  const at = await truth<Pos>(`local p = game.connected_players[1].position return {x = p.x, y = p.y}`);
  const d = Math.hypot(at.x - P(8, 0).x, at.y - P(8, 0).y);
  return { pass: !!r.ok && d <= 1.5, seen: `离目标 ${d.toFixed(2)} 格; ${seenOf(r)}` };
}));
test("build 石炉: 放下、背包少一个、手上空", () => check(async () => {
  furnace = P(12, 3); fp = { x: furnace.x + 0.5, y: furnace.y + 0.5 };
  const before = await myCount("stone-furnace");
  const r = await act("build", { item: "stone-furnace", position: fp });
  const e = await entityAt("stone-furnace", fp);
  return { pass: !!r.ok && !!e?.found && (await myCount("stone-furnace")) === before - 1 && (await truth<string | null>(`local c = game.connected_players[1].cursor_stack return c.valid_for_read and c.name or nil`)) == null, seen: `服务器 ${JSON.stringify(e)}; ${seenOf(r)}` };
}));
test("transfer 煤进炉子 (燃料格) 正好 7 个", () => check(async () => {
  const r = await act("transfer", { position: fp, direction: "to_entity", item: "coal", count: 7 });
  const e = await entityAt("stone-furnace", fp);
  return { pass: !!r.ok && e?.fuel === 7 && r.result?.inventory === "fuel" && (await myCount("coal")) === 53, seen: `炉子燃料 ${e?.fuel}, 背包煤 ${await myCount("coal")}; ${seenOf(r)}` };
}));
test("transfer 铁矿进炉子 (原料格) 10 个", () => check(async () => {
  const r = await act("transfer", { position: fp, direction: "to_entity", item: "iron-ore", count: 10 });
  const n = await truth<number>(`local a = ... return game.surfaces[1].find_entity("stone-furnace", a).get_inventory(defines.inventory.crafter_input).get_item_count("iron-ore")`, fp);
  return { pass: !!r.ok && n >= 9, seen: `炉子原料 ${n} (开炼会少 1); ${seenOf(r)}` };
}));
test("transfer 从炉子取铁板", () => check(async () => {
  await sleep(8000);
  const n0 = await truth<number>(`local a = ... return game.surfaces[1].find_entity("stone-furnace", a).get_inventory(defines.inventory.crafter_output).get_item_count("iron-plate")`, fp);
  const b0 = await myCount("iron-plate");
  const r = await act("transfer", { position: fp, direction: "to_player", item: "iron-plate", count: 1 });
  return { pass: !!r.ok && n0 >= 1 && (await myCount("iron-plate")) === b0 + 1, seen: `炉子产出 ${n0} → 背包铁板 ${b0} → ${await myCount("iron-plate")}; ${seenOf(r)}` };
}));
test("build 木箱, 放 25 铁板再取 10", () => check(async () => {
  chest = P(16, 3);
  await act("build", { item: "wooden-chest", position: chest });
  const r1 = await act("transfer", { position: chest, direction: "to_entity", item: "iron-plate", count: 25 });
  const r2 = await act("transfer", { position: chest, direction: "to_player", item: "iron-plate", count: 10 });
  const n = await truth<number>(`local a = ... return game.surfaces[1].find_entity("wooden-chest", a).get_item_count("iron-plate")`, chest);
  return { pass: !!r1.ok && !!r2.ok && n === 15, seen: `箱里 ${n} (要 15); ${seenOf(r1).slice(0, 120)}; ${seenOf(r2).slice(0, 120)}` };
}));
test("build 组装机带配方", () => check(async () => {
  asm = P(20, 3);
  const r = await act("build", { item: "assembling-machine-1", position: asm, recipe: "iron-gear-wheel" });
  const e = await entityAt("assembling-machine-1", asm);
  return { pass: !!r.ok && e?.recipe === "iron-gear-wheel", seen: `服务器 ${JSON.stringify(e)}; ${seenOf(r)}` };
}));
test("transfer 铁板进组装机 8 个", () => check(async () => {
  const r = await act("transfer", { position: asm, direction: "to_entity", item: "iron-plate", count: 8 });
  const n = await truth<number>(`local a = ... return game.surfaces[1].find_entity("assembling-machine-1", a).get_inventory(defines.inventory.crafter_input).get_item_count("iron-plate")`, asm);
  return { pass: !!r.ok && n === 8, seen: `机器原料 ${n}; ${seenOf(r)}` };
}));
test("build 机械臂朝东, rotate 转朝南", () => check(async () => {
  ins = P(8, 8);
  const r = await act("build", { item: "inserter", position: ins, direction: "east" });
  const e = await entityAt("inserter", ins);
  const r2 = await act("rotate", { position: ins, direction: "south" });
  const e2 = await entityAt("inserter", ins);
  return { pass: !!r.ok && e?.direction === 4 && !!r2.ok && e2?.direction === 8, seen: `方向 ${e?.direction} (要 4) → ${e2?.direction} (要 8); ${seenOf(r).slice(0, 120)}; ${seenOf(r2).slice(0, 120)}` };
}));
test("build 批量 3 根电线杆", () => check(async () => {
  const list = [P(4, 10), P(6, 10), P(8, 10)];
  const r = await act("build", { item: "small-electric-pole", builds: list.map((position) => ({ position })) });
  const found = await Promise.all(list.map((p) => entityAt("small-electric-pole", p)));
  return { pass: !!r.ok && found.every((e) => e?.found), seen: `放下 ${found.filter((e) => e?.found).length}/3; ${seenOf(r).slice(0, 200)}` };
}));
test("build 放不下要报; 背包没有要报", () => check(async () => {
  const r = await act("build", { item: "stone-furnace", position: fp });
  const r2 = await act("build", { item: "steel-chest", position: P(0, 12) });
  return { pass: !r.ok && !r2.ok && /steel-chest/.test(r2.error?.message ?? ""), seen: `${seenOf(r).slice(0, 160)} | ${seenOf(r2).slice(0, 160)}` };
}));
test("craft 手搓 6 个齿轮; 没解锁的要报", () => check(async () => {
  const b0 = await myCount("iron-gear-wheel");
  const r = await act("craft", { recipe: "iron-gear-wheel", count: 6 });
  await sleep(5000);
  const r2 = await act("craft", { recipe: "rocket-silo", count: 1 });
  return { pass: !!r.ok && r.result?.started === 6 && (await myCount("iron-gear-wheel")) === b0 + 6 && (!r2.ok || r2.result?.started === 0), seen: `齿轮 ${b0} → ${await myCount("iron-gear-wheel")}; ${seenOf(r).slice(0, 160)} | ${seenOf(r2).slice(0, 120)}` };
}));
test("build_path 带拐弯的带子 (8 格); 重跑不重复铺", () => check(async () => {
  const pts = [P(0, 14), P(4, 14), P(4, 17)];
  const before = await myCount("transport-belt");
  const r = await act("build_path", { points: pts, end_direction: "east" });
  const rows = await truth<{ x: number; y: number; d: number }[]>(`local out = {} for _, b in pairs(game.surfaces[1].find_entities_filtered{area = {{${pts[0].x - 1}, ${pts[0].y - 1}}, {${pts[2].x + 1}, ${pts[2].y + 1}}}, name = "transport-belt"}) do out[#out + 1] = {x = b.position.x, y = b.position.y, d = b.direction} end return out`);
  const at = (p: Pos) => rows.find((b) => b.x === p.x && b.y === p.y)?.d;
  const ok = rows.length === 8 && at(P(0, 14)) === 4 && at(P(3, 14)) === 4 && at(P(4, 14)) === 8 && at(P(4, 16)) === 8 && at(P(4, 17)) === 4;
  const b1 = await myCount("transport-belt");
  const again = await act("build_path", { points: pts, end_direction: "east" });
  return { pass: !!r.ok && ok && b1 === before - 8 && !!again.ok && again.result?.built === 0 && (await myCount("transport-belt")) === b1, seen: `${rows.length} 格, 背包少 ${before - b1}; 拐点方向 ${at(P(4, 14))} 终点 ${at(P(4, 17))}; 重跑 ${seenOf(again).slice(0, 100)}` };
}));
test("collect 从炉子收铁板", () => check(async () => {
  await act("transfer", { position: fp, direction: "to_entity", item: "coal", count: 3 });
  const b0 = await myCount("iron-plate");
  const there = await truth<number>(`local a = ... return game.surfaces[1].find_entity("stone-furnace", a).get_inventory(defines.inventory.crafter_output).get_item_count("iron-plate")`, fp);
  const r = await act("collect", { item: "iron-plate", positions: [fp], count: 2 });
  return { pass: !!r.ok && there >= 2 && (await myCount("iron-plate")) === b0 + 2, seen: `炉子有 ${there}; 背包 ${b0} → ${await myCount("iron-plate")}; ${seenOf(r)}` };
}));
test("refuel 补到 4 个; feed 喂 3 个进组装机", () => check(async () => {
  const f2 = { x: furnace.x + 3.5, y: furnace.y + 6.5 };
  await act("build", { item: "stone-furnace", position: f2 });
  const r = await act("refuel", { positions: [f2, fp], fuel: "coal", count: 4 });
  const a0 = await entityAt("stone-furnace", f2);
  const m0 = await truth<number>(`local a = ... return game.surfaces[1].find_entity("assembling-machine-1", a).get_inventory(defines.inventory.crafter_input).get_item_count("iron-plate")`, asm);
  const r2 = await act("feed", { positions: [asm], item: "iron-plate", count: 3 });
  const m1 = await truth<number>(`local a = ... return game.surfaces[1].find_entity("assembling-machine-1", a).get_inventory(defines.inventory.crafter_input).get_item_count("iron-plate")`, asm);
  return { pass: !!r.ok && a0?.fuel === 4 && !!r2.ok && m1 >= m0 + 2, seen: `新炉燃料 ${a0?.fuel}; 机器原料 ${m0} → ${m1} (开工会用掉); ${seenOf(r).slice(0, 120)}; ${seenOf(r2).slice(0, 120)}` };
}));

test("相邻两台在烧的炉子: 煤进指定的那台不进旁边的, 按背包少的算成功; 箱子里一组不够的分几组取 (真跑 11-08 的 7 条取放失败)", () => check(async () => {
  // 往右 15 格 (x +28 列): 原来 +8.5 和前面用例放的组装机 P(20, 3) (3x3) 重叠, 全量跑时放不下 (单跑才过)
  const a = { x: furnace.x + 15.5, y: furnace.y + 0.5 }, b = { x: a.x + 2, y: a.y };
  const rb = await act("build", { builds: [{ item: "stone-furnace", position: a }, { item: "stone-furnace", position: b }], walk: true }, "--wait");
  if (!rb.ok) return { pass: false, seen: `放两台炉子没成: ${seenOf(rb)}` };
  // 各放 1 个煤和矿让它烧起来: 那 1 个煤进了燃烧器, 燃料格又是空的 (真跑里失败的都是在烧的机器)
  const lit = await truth<{ found: number; where: string }>(`local a = ... local s = game.surfaces[1] local n, where = 0, {} for _, p in pairs(a) do local e = s.find_entity("stone-furnace", p) if e then n = n + 1 e.get_fuel_inventory().insert{name = "coal", count = 1} e.get_inventory(defines.inventory.crafter_input).insert{name = "iron-ore", count = 20} end end
    for _, e in pairs(s.find_entities_filtered{name = "stone-furnace", area = {{a[1].x - 4, a[1].y - 4}, {a[2].x + 4, a[2].y + 4}}}) do where[#where + 1] = e.position.x .. "," .. e.position.y end
    return {found = n, where = table.concat(where, " ")}`, [a, b]);
  if (lit.found < 2) return { pass: false, seen: `两台炉子只找到 ${lit.found} 台 (要在 ${a.x},${a.y} 和 ${b.x},${b.y}; 附近的: ${lit.where}); build 回复 ${seenOf(rb).slice(0, 300)}` };
  await sleep(4000);
  const c0 = await myCount("coal");
  const r1 = await act("transfer", { position: a, direction: "to_entity", item: "coal", count: 2 });
  const r2 = await act("transfer", { position: b, direction: "to_entity", item: "coal", count: 4 });
  const fa = await entityAt("stone-furnace", a), fb = await entityAt("stone-furnace", b);
  const c1 = await myCount("coal");
  // 箱子里 2 组石头 (50 + 30), 一次取 60: 要分两组取
  const box = { x: a.x + 0.5, y: a.y + 3.5 }; // 木箱 1x1, 中心在 .5
  const rc = await act("build", { item: "wooden-chest", position: box, walk: true });
  if (!rc.ok) return { pass: false, seen: `放箱子没成: ${seenOf(rc)}` };
  await truth(`local a = ... local e = game.surfaces[1].find_entity("wooden-chest", a) e.get_inventory(defines.inventory.chest).insert{name = "stone", count = 80} return true`, box);
  const s0 = await myCount("stone");
  const r3 = await act("transfer", { position: box, direction: "to_player", item: "stone", count: 60 });
  const s1 = await myCount("stone");
  return { pass: !!r1.ok && !!r2.ok && (fa?.fuel ?? 0) >= 1 && (fb?.fuel ?? 0) >= 3 && c0 - c1 === 6 && !!r3.ok && s1 - s0 === 60, seen: `a 燃料 ${fa?.fuel} b 燃料 ${fb?.fuel} 背包煤 ${c0}→${c1}; 石头 ${s0}→${s1}; ${seenOf(r1).slice(0, 140)}; ${seenOf(r2).slice(0, 140)}; ${seenOf(r3).slice(0, 140)}` };
}));

let others: Pos, otherIns: Pos;
test("协助模式: 不拆别人的, 不转别人的, 不快速替换别人的", () => check(async () => {
  others = P(0, 19); otherIns = P(4, 19);
  await truth(`local a = ... local s = game.surfaces[1] local c = s.create_entity{name = "iron-chest", position = a.c, force = "player"} c.insert{name = "copper-plate", count = 60} s.create_entity{name = "inserter", position = a.i, direction = defines.direction.north, force = "player"} return true`, { c: others, i: otherIns });
  const m = await act("mine", { position: others });
  const r = await act("rotate", { position: otherIns, direction: "east" });
  const left = await truth<{ c: boolean; d: number }>(`local a = ... local s = game.surfaces[1] return {c = s.find_entity("iron-chest", a.c) ~= nil, d = s.find_entity("inserter", a.i).direction}`, { c: others, i: otherIns });
  await truth(`game.connected_players[1].get_main_inventory().insert{name = "fast-inserter", count = 1} return true`);
  const b = await act("build", { item: "fast-inserter", position: otherIns });
  const still = await truth<boolean>(`local a = ... return game.surfaces[1].find_entity("inserter", a) ~= nil`, otherIns);
  return { pass: !m.ok && !r.ok && !b.ok && [m, r, b].every((x) => /协助模式/.test(x.error?.message ?? "")) && left.c && left.d === 0 && still, seen: `箱子还在 ${left.c}, 方向 ${left.d}, 普通机械臂还在 ${still}; ${seenOf(m).slice(0, 120)}` };
}));
test("协助模式: 用户点头的位置才能换, 别的还拦; 别人的箱子最多拿一半", () => check(async () => {
  assistAllow.push(otherIns);
  const r = await act("build", { item: "fast-inserter", position: otherIns });
  const swapped = await truth<boolean>(`local a = ... return game.surfaces[1].find_entity("fast-inserter", a) ~= nil`, otherIns);
  const still = await act("mine", { position: others });
  assistAllow.length = 0;
  const b0 = await myCount("copper-plate");
  const t = await act("transfer", { position: others, direction: "to_player", item: "copper-plate", count: 50 });
  const n = await truth<number>(`local a = ... return game.surfaces[1].find_entity("iron-chest", a).get_item_count("copper-plate")`, others);
  return { pass: !!r.ok && swapped && !still.ok && /协助模式/.test(still.error?.message ?? "") && !!t.ok && n === 30 && (await myCount("copper-plate")) === b0 + 30, seen: `换成快速机械臂 ${swapped}; 箱子 ${seenOf(still).slice(0, 80)}; 要 50 箱里 60 → ${n}, 背包 ${b0} → ${await myCount("copper-plate")}` };
}));
test("放建筑: 传送带上放不下, 干跑要报挡着 (走得过去不等于放得下)", () => check(async () => {
  await truth(`local inv = game.connected_players[1].get_main_inventory() inv.insert{name = "transport-belt", count = 1} inv.insert{name = "stone-furnace", count = 1} return true`);
  const q = { x: Math.floor(home.x) - 20, y: Math.floor(home.y) + 12 };
  await clearArea(-24, 8, -16, 16);
  const belt = await act("build", { item: "transport-belt", position: { x: q.x + 0.5, y: q.y + 0.5 }, walk: true });
  const dry = await act("build", { builds: [{ item: "stone-furnace", position: q, box: { left: q.x - 1, top: q.y - 1, right: q.x + 1, bottom: q.y + 1 } }], dry_run: true });
  const blocked = (dry.result?.blocked ?? []) as string[];
  const placed = await act("build", { item: "stone-furnace", position: q, walk: true });
  const left = await truth<{ belt: boolean; furnace: boolean }>(`local a = ... local s = game.surfaces[1] local area = {{a.x - 2, a.y - 2}, {a.x + 2, a.y + 2}} return {belt = s.count_entities_filtered{area = area, name = "transport-belt"} == 1, furnace = s.count_entities_filtered{area = area, name = "stone-furnace"} > 0}`, q);
  return { pass: !!belt.ok && blocked.some((b) => /transport-belt/.test(b)) && !placed.ok && left.belt && !left.furnace, seen: `干跑挡着 ${JSON.stringify(blocked)}; 真放 ok=${placed.ok}; 带子在 ${left.belt}, 炉子在 ${left.furnace}; ${seenOf(placed).slice(0, 160)}` };
}));
test("走太远要报, 不闷声走", () => check(async () => {
  const r = await act("build", { item: "wooden-chest", position: P(200, 0) });
  return { pass: !r.ok && /move_to first/.test(r.error?.message ?? ""), seen: seenOf(r) };
}));
test("mine 挖 3 个矿", () => check(async () => {
  const ore = await truth<{ x: number; y: number; name: string; item: string }>(`local p = game.connected_players[1].position local s = game.surfaces[1]
    local e = s.find_entities_filtered{position = p, radius = 400, name = {"iron-ore", "copper-ore", "coal", "stone"}, limit = 400}
    local best, bd = nil, 1e9 for _, x in pairs(e) do if s.count_entities_filtered{area = {{x.position.x - 1.5, x.position.y - 1.5}, {x.position.x + 1.5, x.position.y + 1.5}}, force = "player"} == 0 then local d = (x.position.x - p.x) ^ 2 + (x.position.y - p.y) ^ 2 if d < bd then best, bd = x, d end end end
    return {x = best.position.x, y = best.position.y, name = best.name, item = best.name}`);
  const b0 = await myCount(ore.item);
  const r = await act("mine", { position: { x: ore.x, y: ore.y }, count: 3, walk: true }, "--wait");
  return { pass: !!r.ok && (await myCount(ore.item)) >= b0 + 3, seen: `${ore.item} ${b0} → ${await myCount(ore.item)}; ${seenOf(r)}` };
}));
test("research 开始研究; 不带参数是查; remove 只取消那一项", () => check(async () => {
  // 新图最早的科技是触发型 (造出东西才解锁), 研究中心研究不了: 测试先把触发型的标成已研究 (只改沙盘), 才有能排队的
  await truth(`local f = game.forces.player for _, t in pairs(f.technologies) do if t.prototype.research_trigger and not t.researched then t.researched = true end end return true`);
  const pick = await truth<string>(`local f = game.forces.player for n, t in pairs(f.technologies) do if not t.researched and t.enabled then local ok = true for _, q in pairs(t.prerequisites) do if not q.researched then ok = false end end if ok and #t.research_unit_ingredients > 0 then return n end end end return ""`);
  if (!pick) return { pass: false, seen: "没有能研究的科技" };
  const r = await act("research", { technology: pick });
  await sleep(500);
  const queue = await truth<string[]>(`local out = {} for i, t in pairs(game.forces.player.research_queue) do out[#out + 1] = t.name end if #out == 0 and game.forces.player.current_research then out[1] = game.forces.player.current_research.name end return out`);
  const pick2 = await truth<string>(`local f = game.forces.player local inq = {} for _, t in pairs(f.research_queue) do inq[t.name] = true end for n, t in pairs(f.technologies) do if not t.researched and t.enabled and not inq[n] and not t.prototype.research_trigger then local ok = true for _, q in pairs(t.prerequisites) do if not q.researched then ok = false end end if ok then return n end end end return ""`);
  if (!pick2) return { pass: false, seen: "没有能排的第二项科技" };
  const added = await act("research", { technology: pick2 });
  await sleep(500);
  const queueNow = async () => { const q = await truth<string[]>(`local out = {} for _, t in pairs(game.forces.player.research_queue) do out[#out + 1] = t.name end return out`); return Array.isArray(q) ? q : Object.values(q ?? {}); };
  const before = await queueNow();
  const read = await act("research", {});
  const text = JSON.stringify(read.result ?? read.error);
  const rm = await act("research", { remove: pick2 });
  await sleep(800);
  const list = await queueNow();
  const right = JSON.stringify(list) === JSON.stringify(before.filter((n) => n !== pick2));
  return { pass: !!r.ok && queue.includes(pick) && !!added.ok && !!read.ok && text.includes(pick2) && !!rm.ok && right, seen: `排 ${pick} → 队列 ${JSON.stringify(queue).slice(0, 80)}; 再排 ${pick2}; 查到 ${text.includes(pick2)}; 取消前 ${JSON.stringify(before).slice(0, 80)} 后 ${JSON.stringify(list).slice(0, 80)}` };
}));
test("建筑压在矿上: 取、放、数、拆都认得出", () => check(async () => {
  const spot = await truth<{ c1?: Pos; c2?: Pos; f?: Pos }>(`local p = game.connected_players[1] local s = p.surface
    local ore = s.find_entities_filtered{position = p.position, radius = 400, name = {"coal", "iron-ore", "copper-ore", "stone"}, limit = 2000}
    local best for _, e in pairs(ore) do local x, y = math.floor(e.position.x), math.floor(e.position.y)
      local n = s.count_entities_filtered{area = {{x - 3, y - 3}, {x + 4, y + 4}}, type = "resource"}
      local b = s.count_entities_filtered{area = {{x - 3, y - 3}, {x + 4, y + 4}}, force = "player"}
      if n >= 40 and b == 0 then best = {x = x, y = y} break end end
    if not best then return {} end
    p.teleport({best.x - 4, best.y})
    local c1 = s.create_entity{name = "wooden-chest", position = {best.x + 0.5, best.y + 0.5}, force = "player"} c1.insert{name = "coal", count = 66}
    local c2 = s.create_entity{name = "wooden-chest", position = {best.x + 0.5, best.y + 1.5}, force = "player"} c2.insert{name = "coal", count = 5}
    local f = s.create_entity{name = "stone-furnace", position = {best.x + 3, best.y}, force = "player"}
    p.get_main_inventory().insert{name = "iron-ore", count = 40}
    return {c1 = c1.position, c2 = c2.position, f = f.position}`);
  if (!spot.c1) return { pass: false, seen: "这张图 400 格内没有够大的矿" };
  const before = await myCount("coal");
  const take = await act("transfer", { position: spot.c1, item: "coal", count: 20, direction: "to_player" }, "--wait");
  const took = (await myCount("coal")) - before;
  const get = await act("collect", { item: "coal", position: spot.c2, radius: 1, chests: true, count: 5 });
  const put = await act("transfer", { position: spot.f, item: "iron-ore", count: 30, direction: "to_entity" }, "--wait");
  const inFurnace = await truth<number>(`local a = ... local e = game.surfaces[1].find_entity("stone-furnace", a) return e.get_inventory(defines.inventory.crafter_input).get_item_count("iron-ore")`, spot.f);
  assistAllow.push(spot.c1!);
  const t0 = Date.now();
  const mined = await act("mine", { position: spot.c1 }, "--wait");
  const mineSec = (Date.now() - t0) / 1000;
  const gone = await truth<boolean>(`local a = ... return game.surfaces[1].find_entity("wooden-chest", a) == nil`, spot.c1);
  const other = await truth<boolean>(`local a = ... return game.surfaces[1].find_entity("wooden-chest", a) ~= nil`, spot.c2);
  assistAllow.length = 0;
  return { pass: !!take.ok && took === 20 && !!get.ok && !!put.ok && inFurnace >= 28 && !!mined.ok && gone && other && mineSec < 20, seen: `取 ${took}/20; collect ${seenOf(get).slice(0, 100)}; 炉子里 ${inFurnace}/30; 拆箱子 ${mineSec.toFixed(1)} 秒, 拆了 ${gone}, 旁边那个还在 ${other}` };
}));
test("弹药格里的弹匣装进炮塔 (主背包没有时)", () => check(async () => {
  const t = await truth<Pos>(`local p = game.connected_players[1] local s = p.surface local c = p.character
    p.get_main_inventory().remove{name = "firearm-magazine", count = 1000}
    local am = c.get_inventory(defines.inventory.character_ammo) am.clear() am.insert{name = "firearm-magazine", count = 30}
    local at = s.find_non_colliding_position("gun-turret", {p.position.x + 4, p.position.y}, 12, 1)
    local e = s.create_entity{name = "gun-turret", position = at, force = "player"}
    return {x = e.position.x, y = e.position.y}`);
  const r = await act("transfer", { position: t, item: "firearm-magazine", count: 10, direction: "to_entity" }, "--wait");
  const read = () => truth<{ turret: number; slot: number; main: number }>(`local a = ... local p = game.connected_players[1] local e = game.surfaces[1].find_entity("gun-turret", a)
    return {turret = e.get_inventory(defines.inventory.turret_ammo).get_item_count("firearm-magazine"), slot = p.character.get_inventory(defines.inventory.character_ammo).get_item_count("firearm-magazine"), main = p.get_main_inventory().get_item_count("firearm-magazine")}`, t);
  const got = await read();
  await truth(`local a = ... local p = game.connected_players[1] local e = game.surfaces[1].find_entity("gun-turret", a) e.get_inventory(defines.inventory.turret_ammo).clear() p.get_main_inventory().insert{name = "firearm-magazine", count = 30} p.character.get_inventory(defines.inventory.character_ammo).clear() return true`, t);
  const fromMain = await act("transfer", { position: t, item: "firearm-magazine", count: 10, direction: "to_entity" }, "--wait");
  const main = await read();
  await truth(`local a = ... game.surfaces[1].find_entity("gun-turret", a).destroy() return true`, t);
  return { pass: !!r.ok && got.turret === 10 && got.slot + got.main === 20 && !!fromMain.ok && main.turret === 10, seen: `弹药格: 炮塔 ${got.turret}/10, 弹药格 ${got.slot} 主背包 ${got.main} (共该 20) | 主背包: 炮塔 ${main.turret}/10` };
}));
test("捡尸体: 东西全回背包", () => check(async () => {
  const box = await truth<Pos>(`local p = game.connected_players[1] local s = p.surface
    local at = s.find_non_colliding_position("character", {p.position.x + 6, p.position.y + 3}, 12, 1)
    local b = s.create_entity{name = "character-corpse", position = at, force = "player", inventory_size = 16, player_index = p.index}
    local inv = b.get_inventory(defines.inventory.character_corpse) inv.insert{name = "gun-turret", count = 3} inv.insert{name = "copper-cable", count = 77}
    return {x = b.position.x, y = b.position.y}`);
  const found = await act("nearest", { type: "character-corpse", radius: 64 });
  const t0 = await truth<{ turret: number; cable: number }>(`local inv = game.connected_players[1].get_main_inventory() return {turret = inv.get_item_count("gun-turret"), cable = inv.get_item_count("copper-cable")}`);
  const mined = await act("mine", { position: box, walk: true }, "--wait");
  await sleep(500);
  const got = await truth<{ turret: number; cable: number; corpse: number }>(`local a = ... local p = game.connected_players[1] local inv = p.get_main_inventory()
    return {turret = inv.get_item_count("gun-turret"), cable = inv.get_item_count("copper-cable"), corpse = p.surface.count_entities_filtered{type = "character-corpse", position = a, radius = 3}}`, box);
  return { pass: !!found.ok && !!mined.ok && got.turret - t0.turret === 3 && got.cable - t0.cable === 77 && got.corpse === 0, seen: `找尸体 ${seenOf(found).slice(0, 100)}; 回到背包 炮塔 ${got.turret - t0.turret}/3 铜线 ${got.cable - t0.cable}/77, 尸体还剩 ${got.corpse}` };
}));
test("shoot 按住开火键打虫巢 (自动找目标 / 瞄准位置)", () => check(async () => {
  const nest = await truth<{ x: number; y: number; health: number }>(`local p = game.connected_players[1] local c = p.character
    c.get_inventory(defines.inventory.character_guns).insert{name = "pistol"}
    c.get_inventory(defines.inventory.character_ammo).insert{name = "firearm-magazine", count = 30}
    local at = p.surface.find_non_colliding_position("biter-spawner", {p.position.x + 9, p.position.y}, 12, 1)
    local e = p.surface.create_entity{name = "biter-spawner", position = at, force = "enemy"}
    return {x = e.position.x, y = e.position.y, health = e.health}`);
  const hp = () => truth<number>(`local a = ... local e = game.surfaces[1].find_entity("biter-spawner", a) return e and e.health or -1`, { x: nest.x, y: nest.y });
  const auto = await act("shoot", { auto: true, ticks: 180 }, "--wait");
  const h1 = await hp();
  const aimed = await act("shoot", { position: { x: nest.x, y: nest.y }, ticks: 120 }, "--wait");
  const h2 = await hp();
  await truth(`local a = ... local e = game.surfaces[1].find_entity("biter-spawner", a) if e then e.destroy() end
    for _, u in pairs(game.surfaces[1].find_entities_filtered{force = "enemy", type = "unit"}) do u.destroy() end return true`, { x: nest.x, y: nest.y });
  const used = Number(auto.result?.accepted?.rounds_used ?? auto.result?.rounds_used ?? 0);
  return { pass: !!auto.ok && h1 < nest.health && used > 0 && !!aimed.ok && h2 < h1, seen: `虫巢血量 ${nest.health} → 自动 ${h1} → 瞄准 ${h2}; 自动 ${seenOf(auto).slice(0, 200)}` };
}));
test("shoot 有虫子时打虫子", () => check(async () => {
  const peace = await truth<boolean>(`local s = game.surfaces[1] local was = s.peaceful_mode s.peaceful_mode = false return was`);
  const ids = await truth<number[]>(`local p = game.connected_players[1] for _, u in pairs(p.surface.find_entities_filtered{force = "enemy", type = "unit", position = p.position, radius = 30}) do u.destroy() end
    local out = {} for i = 1, 3 do local at = p.surface.find_non_colliding_position("small-biter", {p.position.x + 7, p.position.y + i}, 8, 1) out[i] = p.surface.create_entity{name = "small-biter", position = at, force = "enemy"}.unit_number end return out`);
  const r = await act("shoot", { auto: true, ticks: 300 }, "--wait");
  const left = await truth<number>(`local a, n = ..., 0 local want = {} for _, id in pairs(a) do want[id] = true end for _, u in pairs(game.surfaces[1].find_entities_filtered{force = "enemy", type = "unit"}) do if want[u.unit_number] then n = n + 1 end end return n`, ids);
  const hurt = await truth<number>(`local p = game.connected_players[1] local h = p.character and p.character.health or 0 for _, u in pairs(p.surface.find_entities_filtered{force = "enemy", type = "unit", position = p.position, radius = 30}) do u.destroy() end if p.character then p.character.health = p.character.max_health end game.surfaces[1].peaceful_mode = ${peace ? "true" : "false"} return h`);
  return { pass: !!r.ok && left < 3, seen: `原来和平模式 ${peace}; 3 只小虫子还剩 ${left}; 角色血量 ${hurt}; ${seenOf(r).slice(0, 200)}` };
}));
test("地块: map 有水, nearest_water 找得到, observe 看得到, 抽水机放得上", () => check(async () => {
  const pond = await truth<{ x0: number; y0: number; n: number; cx: number; cy: number }>(`local p = game.connected_players[1] local s = p.surface
    local x0 = (math.floor(p.position.x / 32) + 2) * 32 local y0 = (math.floor(p.position.y / 32) + 2) * 32
    p.force.chart(s, {{x0, y0}, {x0 + 32, y0 + 32}})
    local t = {} for x = x0 + 8, x0 + 13 do for y = y0 + 8, y0 + 13 do t[#t + 1] = {name = "water", position = {x, y}} end end
    s.set_tiles(t, true, true)
    return {x0 = x0, y0 = y0, n = s.count_tiles_filtered{area = {{x0, y0}, {x0 + 32, y0 + 32}}, collision_mask = "water_tile"}, cx = x0 + 11, cy = y0 + 11}`);
  const center = { x: pond.cx, y: pond.cy };
  const map = await act("map", { position: center, radius: 64 });
  const regions = ((map.result?.regions ?? []) as { kind: string; count: number; left: number; right: number; top: number; bottom: number }[]).filter((r) => r.kind === "water" && r.left <= pond.cx && r.right >= pond.cx && r.top <= pond.cy && r.bottom >= pond.cy);
  const near = await act("nearest_water", { position: center, radius: 32 });
  const seen = await act("observe", { position: center, radius: 6, tiles: true, limit: 1 });
  const inPond = Math.abs(Number(near.result?.position?.x) - pond.cx) <= 3.5 && Math.abs(Number(near.result?.position?.y) - pond.cy) <= 3.5;
  const tilesText = JSON.stringify(seen.result?.tiles ?? {});
  // 假接口的放置检查 (game/offgame/placeable.lua, 2026-11-08): nearest_water 要带抽水机能放的位置; 放错地方 (离水 4 格) 要被拒, 回复带附近放得下的位置
  const spots = (near.result?.pump_spots ?? []) as { position: { x: number; y: number }; direction?: string }[];
  await truth(`game.connected_players[1].get_main_inventory().insert{name = "offshore-pump", count = 1} return true`);
  const bad = await act("build", { item: "offshore-pump", position: { x: pond.x0 + 3.5, y: pond.y0 + 10.5 }, direction: "east", walk: true }, "--wait");
  const badMsg = seenOf(bad);
  const pump = await act("build", { item: "offshore-pump", position: { x: pond.x0 + 7.5, y: pond.y0 + 10.5 }, direction: "north", walk: true }, "--wait");
  await truth(`local a = ... for _, e in pairs(game.surfaces[1].find_entities_filtered{name = "offshore-pump", area = {{a.x0, a.y0}, {a.x0 + 32, a.y0 + 32}}}) do e.destroy() end
    local t = {} for x = a.x0 + 8, a.x0 + 13 do for y = a.y0 + 8, a.y0 + 13 do t[#t + 1] = {name = "grass-1", position = {x, y}} end end game.surfaces[1].set_tiles(t) return true`, pond);
  return { pass: !!map.ok && regions.some((r) => r.count >= pond.n) && near.result?.found === true && inPond && tilesText.includes("water") && !!pump.ok && spots.length > 0 && !bad.ok && /附近放得下的位置 \(按游戏规则算的, 12 格内\): \(/.test(badMsg),
    seen: `真值 ${pond.n} 格; map ${JSON.stringify(regions).slice(0, 120)}; nearest_water ${String(near.result?.line ?? seenOf(near)).slice(0, 160)}; pump_spots ${spots.length}; observe ${tilesText.slice(0, 80)}; 放错 ${badMsg.slice(0, 160)}; 抽水机 ${seenOf(pump).slice(0, 120)}` };
}));
test("say 发聊天", () => check(async () => { const r = await act("say", { text: "动作核对 你好 [gps=1,2,nauvis]" }); return { pass: !!r.ok, seen: seenOf(r) }; }));
test("走路: 逆着传送带走到了, 不被运回去", () => check(async () => {
  await clearArea(-34, 8, -28, 32);
  const x = Math.floor(home.x) - 31, y0 = Math.floor(home.y) + 10;
  await truth(`local a = ... local s = game.surfaces[1] for i = 0, 19 do s.create_entity{name = "transport-belt", position = {a.x + 0.5, a.y + i + 0.5}, direction = defines.direction.south, force = "player"} end game.connected_players[1].teleport({a.x + 0.5, a.y + 18.5}) return true`, { x, y: y0 });
  await sleep(500);
  const goal = { x: x + 0.5, y: y0 + 1.5 };
  const r = await act("move_to", { position: goal }, "--wait");
  const got = (r.result?.accepted ?? r.result ?? {}) as { position?: Pos; replans?: number };
  const d = got.position ? Math.hypot(got.position.x - goal.x, got.position.y - goal.y) : 99;
  return { pass: !!r.ok && d <= 2.5, seen: `离目标 ${d.toFixed(2)} 格 (带子上容差 2.3), 重算 ${got.replans}; ${seenOf(r).slice(0, 160)}` };
}));
test("走路: move_to 终点被机器占着, 停最近的空位并说明", () => check(async () => {
  const at = await truth<{ mx: number; my: number }>(`local s = game.surfaces[1] local p = game.connected_players[1].position
    local m = s.find_entities_filtered{position = p, radius = 80, type = {"assembling-machine", "furnace"}, force = "player", limit = 1}[1]
    return {mx = m and m.position.x or 0, my = m and m.position.y or 0}`);
  const inMachine = { x: at.mx, y: at.my };
  const r = await act("move_to", { position: inMachine }, "--wait");
  const p = await truth<Pos>(`local p = game.connected_players[1].position return {x = p.x, y = p.y}`);
  const d = Math.hypot(p.x - inMachine.x, p.y - inMachine.y);
  return { pass: !!r.ok && d <= 4.5 && /被占/.test(JSON.stringify(r.result ?? {})), seen: `终点在机器里 ${seenOf(r).slice(0, 140)}; 差 ${d.toFixed(1)} 格` };
}));
test("inspect: 离得远 in_reach 是 false; power by_cause 不崩", () => check(async () => {
  const d = await truth<number>(`local a = ... local p = game.connected_players[1].position return ((p.x - a.x) ^ 2 + (p.y - a.y) ^ 2) ^ 0.5`, others);
  const r = await act("inspect", { position: others });
  const want = d > 12 ? false : d < 8 ? true : null;
  const pw = await act("power", { by_cause: true });
  return { pass: !!r.ok && (want === null || r.result?.in_reach === want) && !!pw.ok, seen: `距离 ${Math.round(d)}, in_reach ${JSON.stringify(r.result?.in_reach)}; power ${seenOf(pw).slice(0, 120)}` };
}));
test("sleep 账本命令在外面跑; 没翻译的动作明确拒绝", () => check(async () => {
  const t0 = Date.now();
  const r = await fh("sleep", "2");
  const s = (Date.now() - t0) / 1000;
  // construct 2026-11-08 接上了 (按虚影放实物); 还没翻译的拿 turret_feeds 当例子
  const c = await act("turret_feeds", { position: P(0, 0), radius: 4 }).catch((e: Error) => ({ ok: false, error: { message: e.message } }) as Reply);
  return { pass: !!r.ok && s >= 1.5 && s < 30 && !c.ok && /不能做/.test(c.error?.message ?? ""), seen: `sleep ${s.toFixed(1)} 秒; turret_feeds ${seenOf(c).slice(0, 120)}` };
}));
test("换地表: 读数跟着身体走, 地表清单对真值; 新地表上放和取; 回来不把原来的算成被拆", () => check(async () => {
  await truth(`local s = game.planets.gleba.create_surface()
    s.request_to_generate_chunks({0, 0}, 3) s.force_generate_chunk_requests()
    for _, e in pairs(s.find_entities_filtered{area = {{-6, -6}, {12, 12}}}) do if e.type ~= "character" then e.destroy() end end
    local tiles = {} for x = -6, 12 do for y = -6, 12 do tiles[#tiles + 1] = {name = "landfill", position = {x, y}} end end
    s.set_tiles(tiles)
    local c = s.create_entity{name = "iron-chest", position = {3.5, 3.5}, force = "player"} c.insert{name = "copper-plate", count = 17}
    game.connected_players[1].teleport({0.5, 0.5}, s)
    game.forces.enemy.set_evolution_factor(0.33, s)
    return true`);
  await sleep(1500);
  const obs = await fh("call", "inspect", "--args", JSON.stringify({ position: { x: 3.5, y: 3.5 } }));
  const text = JSON.stringify(obs.result ?? obs.error);
  const status = JSON.stringify((await fh("call", "status")).result ?? {});
  const evo = /"factor":([\d.]+)/.exec(status)?.[1];
  const real = await truth<Record<string, number>>(`local out = {} for _, s in pairs(game.surfaces) do out[s.name] = s.index end return out`);
  const glebaCount = () => truth<number>(`return #game.surfaces.gleba.find_entities()`);
  let count = 0, w = await broker.where();
  for (let i = 0; i < 8; i++) { const c0 = await glebaCount(); w = await broker.where(); count = await glebaCount(); if (c0 === count) break; await sleep(1000); }
  const here = w.surfaces.find((s) => s.here), row = w.surfaces.find((s) => s.name === "gleba");
  const indexesOk = w.surfaces.every((s) => real[s.name] === s.index);
  const at = { x: 5.5, y: 3.5 };
  const r1 = await act("build", { item: "wooden-chest", position: at });
  const r2 = await act("transfer", { position: at, direction: "to_entity", item: "iron-plate", count: 3 });
  const n = await truth<number>(`local a = ... local e = game.surfaces.gleba.find_entity("wooden-chest", a) return e and e.get_item_count("iron-plate") or -1`, at);
  type Ev = { kind: string; row?: { name: string; x: number; y: number } };
  const earlier = new Set((((await broker.probeStats()).events ?? []) as Ev[]).map((e) => JSON.stringify(e)));
  await truth(`game.connected_players[1].teleport({${home.x}, ${home.y}}, game.surfaces.nauvis) return true`);
  await sleep(1500);
  const back = JSON.stringify((await fh("call", "inspect", "--args", JSON.stringify({ position: chest }))).result ?? {});
  const w2 = await broker.where();
  const minedAll = ((((await broker.probeStats()).events ?? []) as Ev[]).filter((e) => e.kind === "mined" && !earlier.has(JSON.stringify(e))));
  const minedNear = minedAll.filter((e) => e.row && Math.hypot(e.row.x - home.x, e.row.y - home.y) < 40).length;
  return { pass: here?.name === "gleba" && row?.entities === count && /iron-chest/.test(text) && /copper-plate/.test(text) && indexesOk && evo === "0.33" && !!r1.ok && !!r2.ok && n === 3 && w2.surfaces.find((s) => s.here)?.name === "nauvis" && /wooden-chest/.test(back) && minedNear === 0, seen: `在 ${here?.name}, 地表 ${JSON.stringify(w.surfaces.map((s) => [s.name, s.index]))}; gleba 实体 ${row?.entities} vs ${count}; 进化度 ${evo}; gleba 木箱里 ${n}; 回到 ${w2.surfaces.find((s) => s.here)?.name}, 换地表后"拆除" ${minedNear} 条` };
}));

// 内存读不到的问注入客户端的只读查询: 流体、红绿线、物流网、别的玩家, 全部对 RCON 真值
let tank: Pos, boiler: Pos, red1: Pos, red2: Pos;
test("注入 Lua: 流体 (储罐的水); 状态 (锅炉没水, 内存算不出)", () => check(async () => {
  tank = P(26, -12); boiler = P(26, -6); red1 = P(30, -4); red2 = P(32, -4);
  const port = { x: Math.floor(home.x) + 36, y: Math.floor(home.y) - 8 }, provider = P(31, -12);
  await truth(`local a = ... local s = game.surfaces[1]
    local t = s.create_entity{name = "storage-tank", position = a.tank, force = "player"} t.insert_fluid{name = "water", amount = 5000}
    s.create_entity{name = "boiler", position = a.boiler, force = "player"}
    local c1 = s.create_entity{name = "iron-chest", position = a.red1, force = "player"} c1.insert{name = "copper-plate", count = 7}
    local c2 = s.create_entity{name = "iron-chest", position = a.red2, force = "player"}
    c1.get_wire_connector(defines.wire_connector_id.circuit_red, true).connect_to(c2.get_wire_connector(defines.wire_connector_id.circuit_red, true))
    local r = s.create_entity{name = "roboport", position = a.port, force = "player"} r.insert{name = "logistic-robot", count = 3}
    s.create_entity{name = "passive-provider-chest", position = a.provider, force = "player"}.insert{name = "iron-plate", count = 11}
    game.connected_players[1].teleport({a.port.x - 6, a.port.y + 6})
    return true`, { tank, boiler, red1, red2, port, provider });
  await sleep(1500);
  const r = await fh("call", "inspect", "--args", JSON.stringify({ position: tank }));
  const text = JSON.stringify(r.result ?? r.error);
  const real = await truth<{ name: string; amount: number }>(`local a = ... return game.surfaces[1].find_entity("storage-tank", a).get_fluid(1)`, tank);
  const b = await fh("call", "inspect", "--args", JSON.stringify({ position: boiler }));
  const realStatus = await truth<number>(`local a = ... return game.surfaces[1].find_entities_filtered{name = "boiler", position = a, radius = 3}[1].status`, boiler);
  return { pass: text.includes(real.name) && text.includes(String(real.amount)) && b.result?.status === realStatus, seen: `储罐真值 ${JSON.stringify(real)} ${text.slice(0, 160)}; 锅炉状态 读到 ${b.result?.status} 真值 ${realStatus}` };
}));
test("注入 Lua: 红绿线 (谁接谁, 网络编号); 接线点只放行只读的写法", () => check(async () => {
  const r = await fh("call", "inspect", "--args", JSON.stringify({ position: red1 }));
  const text = JSON.stringify(r.result ?? r.error);
  const real = await truth<number>(`local a = ... return game.surfaces[1].find_entity("iron-chest", a).get_circuit_network(defines.wire_connector_id.circuit_red).network_id`, red1);
  const t = { kind: "entities", unit_number: await truth<number>(`local a = ... return game.surfaces[1].find_entity("iron-chest", a).unit_number`, red2), position: red2 };
  const asRead = await target.call("world_query", { selection: { kind: "inspect", target: t, path: [{ method: "get_wire_connector", arguments: [1, false] }] }, fields: ["network_id", "connection_count"] });
  const asWrite = await target.call("world_query", { selection: { kind: "inspect", target: t, path: [{ method: "get_wire_connector", arguments: [1, true] }] }, fields: ["network_id"] });
  const noArg = await target.call("world_query", { selection: { kind: "inspect", target: t, path: [{ method: "get_wire_connector", arguments: [1] }] }, fields: ["network_id"] });
  return { pass: /circuit|red|wire/i.test(text) && text.includes(String(real)) && asRead.ok && !asWrite.ok && !noArg.ok && /or_create/.test(String(asWrite.error)), seen: `红线网络真值 ${real}; ${text.slice(0, 200)}; 接线点 false ${asRead.ok} / true ${asWrite.ok} / 不给 ${noArg.ok}` };
}));
test("注入 Lua: 物流网 (站的地方归哪个网, 机器人和库存)", () => check(async () => {
  const st = await fh("call", "status");
  const here = JSON.stringify(st.result?.logistics_here ?? null);
  const real = await truth<{ id: number; robots: number; plates: number }>(`local n = game.surfaces[1].find_logistic_network_by_position(game.connected_players[1].position, "player") return {id = n.network_id, robots = n.all_logistic_robots, plates = n.get_item_count("iron-plate")}`);
  return { pass: !!st.ok && !/no logistic network/.test(here) && here !== "null" && here.includes(String(real.robots)), seen: `真值 ${JSON.stringify(real)}; logistics_here ${here.slice(0, 240)}` };
}));
test("注入 Lua: 别的玩家 (第二个客户端); 后台没出错; 服务器没有不同步", () => check(async () => {
  second = new Viewer("test-actions-b", undefined, { playerName: "ActSecond" });
  second.launch(lab.gamePort);
  for (let i = 0; i < 40; i++) { await sleep(1500); if (((await lab.exec(`return #game.connected_players`)) as number) >= 2) break; }
  await sleep(3500); // 缓存 3 秒
  const r = await fh("call", "players");
  const text = JSON.stringify(r.result ?? r.error);
  const real = await truth<string[]>(`local o = {} for _, p in pairs(game.connected_players) do o[#o + 1] = p.name end return o`);
  await sleep(3000);
  const s = await broker.probeStats() as { fault?: unknown; background?: { errors?: number; last_error?: unknown }; lua?: { reads?: number; errors?: number } };
  const out = fs.readFileSync(path.join(lab.dir, "server.out"), "utf8");
  const bad = /desync|Desync/.test(out);
  const still = (await lab.exec(`return #game.connected_players`)) as number;
  return { pass: !!r.ok && real.includes("ActSecond") && text.includes("ActSecond") && !s.fault && !s.background?.errors && (s.lua?.reads ?? 0) > 0 && !bad && still >= 2, seen: `真值在线 ${JSON.stringify(real)}; ${text.slice(0, 160)}; Lua ${JSON.stringify(s.lua)}; 后台出错 ${s.background?.errors}; 不同步 ${bad}, 在线 ${still}` };
}));

// ── 2026-11-08 接上的命令 (docs/run.md "第二版给模型的命令在这条路上接了多少"): 单跑 --test-name-pattern "接线:" ──
const give = (items: Record<string, number>) => truth(`local inv = game.connected_players[1].get_main_inventory() for n, c in pairs(...) do inv.insert{name = n, count = c} end return true`, items);
const countIn = (name: string, a: Pos, b: Pos) => truth<number>(`local a = ... return game.surfaces[1].count_entities_filtered{area = {{a.x0, a.y0}, {a.x1, a.y1}}, name = a.name}`, { name, x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) });
// mine: true = 以角色的名义造 (last_user 是自己; 协助模式下自己的才能动)
const spawnAt = (name: string, p: Pos, extra: Record<string, unknown> = {}) => truth(`local a = ... local e = game.surfaces[1].create_entity{name = a.name, position = a.p, force = "player", inner_name = a.inner, direction = a.dir, player = a.mine and game.connected_players[1] or nil} return e ~= nil`, { name, p, ...extra });

test("接线: 键位表里用物品 / 扔东西是哪个键 (打出来)", () => check(async () => {
  const r = await target.call("input_bindings", { limit: 1024 });
  const ids = (((r.data ?? {}) as { controls?: { id: string }[] }).controls ?? []).map((c) => c.id);
  return { pass: ids.length > 0, seen: `共 ${ids.length} 个; 相关: ${ids.filter((i) => /use|throw|capsule|shoot|build|item|pick/i.test(i)).join(", ")}` };
}));
test("接线: cancel_craft 取消手搓队列; equipment 往护甲网格装插件", () => check(async () => {
  await give({ "iron-plate": 100, "modular-armor": 1, "solar-panel-equipment": 2 });
  await act("craft", { recipe: "iron-gear-wheel", count: 20 }, "--wait");
  const q0 = await truth<number>(`return game.connected_players[1].crafting_queue_size`);
  const r1 = await act("cancel_craft", { recipe: "iron-gear-wheel" }, "--wait");
  const q1 = await truth<number>(`return game.connected_players[1].crafting_queue_size`);
  const r2 = await act("equip", { item: "modular-armor" }, "--wait");
  // 穿上带网格的护甲后的界面树: 找打开网格的那一格 (存 data/play/ui-tree-armor.json)
  await openCharacterGui(target.call, target.controls!);
  const armorTree = await readTree(target.call);
  await closeWindows(target.call, target.controls!).catch(() => undefined);
  fs.writeFileSync(path.join(ROOT, "data", "play", "ui-tree-armor.json"), JSON.stringify(armorTree, null, 1));
  console.log(`  护甲界面相关: ${[...new Set(armorTree.filter((n) => /Equip|Grid|Armor/i.test(n.type) || /armor|equipment/.test(String(n.properties?.prototype?.name ?? ""))).map((n) => `${n.type}${n.properties?.prototype?.name ? `(${n.properties.prototype.name})` : ""}`))].join(", ")}`);
  const r3 = await act("equipment", { insert: "solar-panel-equipment" }, "--wait");
  const grid = await truth<number>(`local ch = game.connected_players[1].character local arm = ch.get_inventory(defines.inventory.character_armor)[1] if not (arm and arm.valid_for_read and arm.grid) then return -1 end return #arm.grid.equipment`);
  return { pass: !!r1.ok && q1 < q0 && !!r2.ok && !!r3.ok && grid >= 1, seen: `队列 ${q0} → ${q1}; 网格里 ${grid} 件; cancel ${seenOf(r1).slice(0, 120)}; equip ${seenOf(r2).slice(0, 100)}; equipment ${seenOf(r3).slice(0, 120)}` };
}));

test("接线: 界面树: 手搓队列、护甲网格的控件名 (存一份到 data/play/ui-tree-character.json)", () => check(async () => {
  await clearArea(-12, 26, 44, 74);
  await give({ "iron-plate": 200, "modular-armor": 1, "solar-panel-equipment": 2 });
  await act("craft", { recipe: "iron-gear-wheel", count: 30 }, "--wait");
  await openCharacterGui(target.call, target.controls!);
  const nodes = await readTree(target.call);
  await closeWindows(target.call, target.controls!).catch(() => undefined);
  fs.writeFileSync(path.join(ROOT, "data", "play", "ui-tree-character.json"), JSON.stringify(nodes, null, 1));
  const types = [...new Set(nodes.map((n) => n.type))];
  return { pass: nodes.length > 0, seen: `控件 ${nodes.length} 个; 相关: ${types.filter((t) => /Craft|Queue|Equip|Grid|Armor|Gun|Ammo/i.test(t)).join(", ")}; 全部类型 ${types.length} 种` };
}));
test("接线: pole_route 模组按接线距离算位置, 角色一根根放", () => check(async () => {
  await give({ "small-electric-pole": 20 });
  const before = await myCount("small-electric-pole");
  const r = await act("pole_route", { from: P(0, 30), to: P(30, 30) }, "--wait");
  const n = await countIn("small-electric-pole", P(-2, 28), P(33, 33));
  return { pass: !!r.ok && n >= 4 && (await myCount("small-electric-pole")) === before - n, seen: `放了 ${n} 根; ${seenOf(r)}` };
}));
test("接线: belt_route 带拐弯, 角色一格格放, 方向对", () => check(async () => {
  await give({ "transport-belt": 60, "underground-belt": 4 });
  const r = await act("belt_route", { from: P(0, 36), to: P(16, 40) }, "--wait");
  const n = await countIn("transport-belt", P(-1, 35), P(17, 41));
  return { pass: !!r.ok && n >= 18, seen: `带子 ${n} 格; ${seenOf(r)}` };
}));
test("接线: pipe_route 水管 (可用地下管), 角色一格格放", () => check(async () => {
  await give({ pipe: 40, "pipe-to-ground": 6 });
  const r = await act("pipe_route", { from: P(0, 44), to: P(14, 44) }, "--wait");
  const n = (await countIn("pipe", P(-1, 43), P(15, 45))) + (await countIn("pipe-to-ground", P(-1, 43), P(15, 45)));
  return { pass: !!r.ok && n >= 3, seen: `管子 ${n} 件; ${seenOf(r)}` };
}));
test("接线: place_ghosts 直接放实物; construct 按现有的虚影放实物", () => check(async () => {
  await give({ "stone-furnace": 4, "wooden-chest": 4 });
  const r1 = await act("place_ghosts", { entities: [{ name: "stone-furnace", position: P(0, 50) }, { name: "stone-furnace", position: P(3, 50) }] }, "--wait");
  const f = await countIn("stone-furnace", P(-2, 48), P(5, 52));
  await spawnAt("entity-ghost", P(8, 50), { inner: "wooden-chest" });
  await spawnAt("entity-ghost", P(10, 50), { inner: "wooden-chest" });
  const r2 = await act("construct", { position: P(9, 50), radius: 4 }, "--wait");
  const c = await countIn("wooden-chest", P(7, 49), P(11, 51));
  return { pass: !!r1.ok && f === 2 && !!r2.ok && c === 2, seen: `炉子 ${f}, 箱子 ${c}; place_ghosts ${seenOf(r1).slice(0, 160)}; construct ${seenOf(r2).slice(0, 160)}` };
}));
test("接线: pickup 地上的东西; rearm 炮塔补弹", () => check(async () => {
  await truth(`local a = ... game.surfaces[1].spill_item_stack{position = a, stack = {name = "iron-plate", count = 20}} return true`, P(14, 50));
  const before = await myCount("iron-plate");
  const r1 = await act("pickup", { position: P(14, 50), radius: 4 }, "--wait");
  const got = (await myCount("iron-plate")) - before;
  await spawnAt("gun-turret", P(18, 50));
  await give({ "firearm-magazine": 30 });
  const r2 = await act("rearm", { position: P(18, 50), radius: 4, count: 10 }, "--wait");
  const ammo = await truth<number>(`local a = ... local t = game.surfaces[1].find_entity("gun-turret", a) return t and t.get_inventory(defines.inventory.turret_ammo).get_item_count() or -1`, P(18, 50));
  return { pass: !!r1.ok && got >= 15 && !!r2.ok && ammo >= 10, seen: `捡回 ${got}; 炮塔 ${ammo} 发; pickup ${seenOf(r1).slice(0, 140)}; rearm ${seenOf(r2).slice(0, 140)}` };
}));
test("接线: upgrade 带子换下一档 (快速替换, 方向照旧)", () => check(async () => {
  for (let i = 0; i < 3; i++) await spawnAt("transport-belt", P(i, 56), { dir: 4, mine: true });
  await give({ "fast-transport-belt": 5 });
  const r = await act("upgrade", { area: { left_top: P(-1, 55), right_bottom: P(3, 57) } }, "--wait");
  const fast = await countIn("fast-transport-belt", P(-1, 55), P(3, 57)), old = await countIn("transport-belt", P(-1, 55), P(3, 57));
  return { pass: !!r.ok && fast === 3 && old === 0, seen: `快速 ${fast}, 旧的 ${old}; ${seenOf(r)}` };
}));
test("接线: use_item 扔手雷; equip 装冲锋枪; configure 改配方", () => check(async () => {
  await give({ grenade: 3, "submachine-gun": 1 });
  const r1 = await act("use_item", { item: "grenade", position: P(8, 62) }, "--wait");
  const g = await myCount("grenade");
  const r2 = await act("equip", { item: "submachine-gun" }, "--wait");
  const gun = await truth<number>(`return game.connected_players[1].character.get_inventory(defines.inventory.character_guns).get_item_count("submachine-gun")`);
  await spawnAt("assembling-machine-1", P(20, 62));
  const r3 = await act("configure", { position: P(20, 62), recipe: "iron-gear-wheel" }, "--wait");
  const e = await entityAt("assembling-machine-1", P(20, 62));
  return { pass: !!r1.ok && g === 2 && !!r2.ok && gun === 1 && !!r3.ok && e?.recipe === "iron-gear-wheel", seen: `手雷剩 ${g}; 枪格 ${gun}; 配方 ${e?.recipe}; use ${seenOf(r1).slice(0, 100)}; equip ${seenOf(r2).slice(0, 100)}; configure ${seenOf(r3).slice(0, 100)}` };
}));
test("接线: 读命令按角色身份问 (ingredient_gap ghosts players); wait_ticks", () => check(async () => {
  const rs = [await act("ingredient_gap", { position: P(20, 62) }), await act("ghosts", {}), await act("players", {}), await act("wait_ticks", { ticks: 30 }, "--wait")];
  return { pass: rs.every((r) => r.ok), seen: rs.map((r) => seenOf(r).slice(0, 90)).join(" | ") };
}));
test("接线: queue_submit 角色空着 20 秒后一步步跑; order_set 燃料低了自动补", () => check(async () => {
  await give({ "wooden-chest": 2, coal: 40 });
  const q = await act("queue_submit", { steps: [{ action: "build", args: { item: "wooden-chest", position: P(24, 66) }, label: "箱子" }] });
  await spawnAt("stone-furnace", P(28, 66));
  const o = await act("order_set", { name: "keep-fuel", when: { until: "fuel_below", count: 3, position: P(28, 66), radius: 2 }, steps: [{ action: "refuel", args: { positions: [P(28, 66)], fuel: "coal", count: 5 } }] });
  let chest = 0, fuel = 0;
  for (let i = 0; i < 40 && (chest < 1 || fuel < 3); i++) { await sleep(3000); chest = await countIn("wooden-chest", P(23, 65), P(25, 67)); fuel = (await entityAt("stone-furnace", P(28, 66)))?.fuel ?? 0; }
  const st = await act("queue_status", {}), ord = await act("orders", {});
  await act("order_remove", { name: "keep-fuel" });
  return { pass: !!q.ok && !!o.ok && chest === 1 && fuel >= 3, seen: `箱子 ${chest}, 炉子燃料 ${fuel}; 队列 ${seenOf(st).slice(0, 160)}; 常驻 ${seenOf(ord).slice(0, 200)}` };
}));
