#!/usr/bin/env node
// 大脑链路第 2 步 (docs/brain-run.md): 红瓶链路要用的动作逐个在沙盘里核对。
// 本机沙盘服务器 (io-lab + agent-harness) + 一个游戏窗口 (连着的玩家就是被测角色, 用户能看着);
// io-lab 只当夹具 (清场、放矿、给初始背包、解锁前置科技), 被测动作一律走 agent-harness 的玩家规则, 真值用 RCON 读。
// 角色要有连着的客户端才存在 (无界面服务器造不出玩家), 所以这不是无窗口回归; 以后批量跑再搬 bots.lua。
//   npm run play:check [-- --only move_to,craft]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { LabInstance } from "../lab/instance.ts";
import { ViewerClient } from "../lab/viewer.ts";
import { execFileSync } from "node:child_process";
import { labRoot, REPO } from "../lab/gamedir.ts";
import { Harness, type LogEntry } from "./harness.ts";
import { BOT_LABEL_LUA } from "./botlabel.ts";

// --mod agent-harness-party: 同一套核对跑 factorio-ai-party 的分支版 (mods/agent-harness-party)
const { values } = parseArgs({ options: { only: { type: "string" }, linger: { type: "string", default: process.env.LAB_VIEW_LINGER ?? "60" }, mod: { type: "string", default: "agent-harness" } } });
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} 秒] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODS = [values.mod!];

const lab = new LabInstance({ name: "play-check", view: false, label: "大脑链路 动作核对", repoMods: MODS });
const viewer = new ViewerClient("play-check");
const calls: LogEntry[] = [];
const rows: string[] = [];
try {
  await lab.createMap("m", { seed: 1 });
  await lab.start("m");
  await lab.exec(`remote.call("freeplay", "set_skip_intro", true) remote.call("freeplay", "set_disable_crashsite", true) return true`);
  await lab.rpc("time", { speed: 1, paused: false });
  viewer.launch(lab.gamePort, { repoMods: MODS });
  for (let i = 0; i < 60; i++) { await sleep(2000); if (((await lab.exec(`return #game.connected_players`)) as number) >= 1) break; }
  await lab.rpc("viewer", {}).catch(() => undefined); // 退出开场动画 (lab.md #58)
  // 夹具: 和平模式; 玩家放到 (0,0); 场地清空铺地; 放一块铁矿、一块煤; 背包只给测试要用的
  await lab.exec(`local s = game.surfaces[1] s.peaceful_mode = true
    for _, e in pairs(s.find_entities_filtered{force = "enemy", position = {0, 0}, radius = 400}) do e.destroy() end
    game.connected_players[1].teleport({0, 0}) return true`);
  await lab.rpc("prepare_area", { area: [[-24, -24], [24, 24]], no_enemies: true }, { timeoutMs: 120_000 });
  await lab.rpc("time", { speed: 1, paused: false });
  await lab.exec(`local s = game.surfaces[1]
    for x = 8, 10 do for y = -1, 1 do s.create_entity{name = "iron-ore", position = {x + 0.5, y + 0.5}, amount = 500} end end
    for x = 8, 9 do for y = 5, 6 do s.create_entity{name = "coal", position = {x + 0.5, y + 0.5}, amount = 500} end end
    local p = game.connected_players[1] local inv = p.get_main_inventory() inv.clear()
    for _, st in pairs({{"iron-plate", 20}, {"stone-furnace", 1}, {"burner-mining-drill", 1}, {"assembling-machine-1", 1}, {"transport-belt", 40}, {"underground-belt", 4}, {"small-electric-pole", 2}, {"coal", 20}}) do inv.insert{name = st[1], count = st[2]} end
    game.forces.player.technologies["automation-science-pack"].researched = true
    return true`);
  await sleep(1000);

  const h = new Harness(lab.rcon!, 1, (e) => calls.push(e));
  const me = async () => (await lab.exec(`local p = game.connected_players[1] local inv = p.get_main_inventory()
    local c = {} for _, it in pairs(inv.get_contents()) do c[it.name] = (c[it.name] or 0) + it.count end
    return {x = p.position.x, y = p.position.y, inv = c, queue = p.crafting_queue_size}`)) as { x: number; y: number; inv: Record<string, number>; queue: number };
  const ent = async (name: string, x: number, y: number, r = 1.5) => (await lab.exec(`local a = ... local e = game.surfaces[1].find_entities_filtered{name = a.n, position = {a.x, a.y}, radius = a.r}[1]
    if not e then return {found = false} end
    local out = {found = true, x = e.position.x, y = e.position.y, net = e.electric_network_id}
    if e.type == "furnace" or e.type == "mining-drill" or e.type == "assembling-machine" then
      local f = e.get_fuel_inventory() out.fuel = f and f.get_item_count() or 0
      if e.type ~= "mining-drill" then out.recipe = e.get_recipe() and e.get_recipe().name or "" end
      if e.type == "furnace" then out.source = e.get_inventory(defines.inventory.crafter_input).get_item_count() out.result = e.get_inventory(defines.inventory.crafter_output).get_item_count() end
    end
    return out`, { n: name, x, y, r })) as Record<string, any>;
  const furnace = { x: 4, y: 3 };
  // ── 太空核对的夹具 (M8 准备, 2026-11-04): 派对 space.lua 的动作只在他们的假引擎上测过, 这里在 2.1.24 真引擎上走玩家规则。
  //    沙盘里允许作弊: 全部科技 (2.1.7 起角色要第一颗星球的科技研究后才能上平台)、发射井 (-18,18) 和降落仓 (18,-18) 直接造、火箭零件直接填满;
  //    被测的是 platform_create / launch (含 ride) / platforms / platform_schedule / requests / drop / land 这些动作本身。等火箭和货舱时 4 倍速。
  const SILO = { x: -18, y: 18 }, PAD = { x: 18, y: -18 }, PLATFORM = "试验台";
  const spaceOnly = values.mod === "agent-harness-party";
  type SpaceInfo = { found: boolean; player_surface: string; has_character: boolean; /** 还在火箭 / 货舱里 (游戏里算"在载具中", 这期间平台动作都被拒; 第四次跑发现) */ driving: boolean; state?: string; hub?: boolean; surface?: string; at?: string; stops?: number; silo?: string; parts?: number; pad_iron?: number };
  const platformInfo = async () => (await lab.exec(`local a = ... local f = game.forces.player local p = game.connected_players[1]
    local pnames = {} for k, v in pairs(defines.space_platform_state) do pnames[v] = k end
    local snames = {} for k, v in pairs(defines.rocket_silo_status) do snames[v] = k end
    local pl for _, x in pairs(f.platforms) do if x.valid and x.name == a.name then pl = x end end
    local out = {found = pl ~= nil, player_surface = p.surface.name, has_character = p.character ~= nil, driving = p.driving and true or false}
    if pl then out.state = pnames[pl.state] or tostring(pl.state) out.hub = pl.hub ~= nil and pl.hub.valid out.surface = pl.surface and pl.surface.name or "" out.at = pl.space_location and pl.space_location.name or "" out.stops = pl.schedule and pl.schedule.records and #pl.schedule.records or 0 end
    local silo = game.surfaces[1].find_entities_filtered{name = "rocket-silo", position = {a.sx, a.sy}, radius = 1}[1]
    if silo then out.silo = snames[silo.rocket_silo_status] or tostring(silo.rocket_silo_status) out.parts = silo.rocket_parts end
    local pad = game.surfaces[1].find_entities_filtered{name = "cargo-landing-pad", position = {a.px, a.py}, radius = 1}[1]
    if pad then out.pad_iron = pad.get_inventory(defines.inventory.cargo_landing_pad_main).get_item_count("iron-plate") end
    return out`, { name: PLATFORM, sx: SILO.x, sy: SILO.y, px: PAD.x, py: PAD.y })) as SpaceInfo;
  const waitUntil = async (pred: (s: SpaceInfo) => boolean, seconds: number) => { let s = await platformInfo(); for (let i = 0; i < seconds * 2 && !pred(s); i++) { await sleep(500); s = await platformInfo(); } return s; };
  const fast = (on: boolean) => lab.rpc("time", { speed: on ? 4 : 1, paused: false });
  /** 火箭零件填满、等到 rocket_ready; pack = 再往火箭货舱塞一个太空平台起始包 */
  const rocketReady = async (pack: boolean) => {
    await lab.exec(`local a = ... local silo = game.surfaces[1].find_entities_filtered{name = "rocket-silo", position = {a.x, a.y}, radius = 1}[1]
      silo.rocket_parts = silo.prototype.rocket_parts_required return true`, SILO);
    await fast(true);
    const s = await waitUntil((x) => x.silo === "rocket_ready", 90);
    await fast(false);
    const inserted = pack ? await lab.exec(`local a = ... local silo = game.surfaces[1].find_entities_filtered{name = "rocket-silo", position = {a.x, a.y}, radius = 1}[1]
      return silo.get_inventory(defines.inventory.rocket_silo_rocket).insert{name = "space-platform-starter-pack", count = 1}`, SILO) : 1;
    return s.silo === "rocket_ready" && inserted === 1;
  };
  const brief = (r: { ok: boolean; result?: unknown; error?: { message?: string } }, n = 180) => (r.ok ? JSON.stringify(r.result).slice(0, n) : `错: ${r.error?.message?.slice(0, n)}`);
  type Case = [string, () => Promise<{ pass: boolean; seen: string }>];
  const cases: Case[] = [
    ["observe", async () => { const r = await h.call("observe", { radius: 16 }); const s = JSON.stringify(r); return { pass: r.ok && s.includes("iron-ore"), seen: `${r.ok ? "ok" : r.error?.message} ${s.length} 字节, 含铁矿 ${s.includes("iron-ore")}` }; }],
    ["move_to", async () => { const r = await h.call("move_to", { position: { x: 6, y: 0 } }, { wait: true }); const m = await me(); const d = Math.hypot(m.x - 6, m.y); return { pass: r.ok && d < 1, seen: `${r.ok ? r.result?.completion?.outcome : r.error?.message}; 服务器位置 (${m.x.toFixed(2)}, ${m.y.toFixed(2)}) 离目标 ${d.toFixed(2)} 格` }; }],
    ["mine", async () => { await h.call("move_to", { position: { x: 7, y: 0.5 } }, { wait: true }); const b = (await me()).inv["iron-ore"] ?? 0; const r = await h.call("mine", { position: { x: 8.5, y: 0.5 }, ticks: 300 }, { wait: true }); const a = (await me()).inv["iron-ore"] ?? 0; return { pass: a > b, seen: `${r.ok ? r.result?.completion?.outcome : r.error?.message}; 背包铁矿 ${b} → ${a}` }; }],
    ["craft", async () => { const b = await me(); const r = await h.call("craft", { recipe: "iron-gear-wheel", count: 2 }); for (let i = 0; i < 50 && (await me()).queue > 0; i++) await sleep(200); const a = await me(); const dg = (a.inv["iron-gear-wheel"] ?? 0) - (b.inv["iron-gear-wheel"] ?? 0), dp = (b.inv["iron-plate"] ?? 0) - (a.inv["iron-plate"] ?? 0); return { pass: r.ok && dg === 2 && dp === 4, seen: `${r.ok ? "已排队" : r.error?.message}; 齿轮 +${dg}, 铁板 -${dp}` }; }],
    ["build", async () => { const r = await h.call("build", { item: "stone-furnace", position: furnace }); const e = await ent("stone-furnace", furnace.x, furnace.y); const n = (await me()).inv["stone-furnace"] ?? 0; return { pass: r.ok && e.found && n === 0, seen: `${r.ok ? "ok" : r.error?.message}; 服务器 ${e.found ? `有石炉 (${e.x},${e.y})` : "没有石炉"}, 背包剩 ${n}` }; }],
    ["transfer 燃料", async () => { const r = await h.call("transfer", { position: furnace, item: "coal", count: 5 }); const e = await ent("stone-furnace", furnace.x, furnace.y); return { pass: r.ok && e.fuel === 5, seen: `${r.ok ? JSON.stringify(r.result).slice(0, 80) : r.error?.message}; 炉子燃料 ${e.fuel}` }; }],
    // 第六轮: refuel 报 "LuaItemPrototype doesn't contain key fuel_category" (2.1.19 之后改成 fuel_categories, lab.md #75)
    ["refuel 补燃料", async () => { const before = (await ent("stone-furnace", furnace.x, furnace.y)) as { fuel?: number }; const r = await h.call("refuel", { positions: [furnace], count: 8 }, { wait: true }); const e = (await ent("stone-furnace", furnace.x, furnace.y)) as { fuel?: number }; return { pass: r.ok && (e.fuel ?? 0) > (before.fuel ?? 0), seen: `${r.ok ? JSON.stringify(r.result).slice(0, 160) : r.error?.message}; 炉子燃料 ${before.fuel} → ${e.fuel}` }; }],
    ["transfer 原料 + 取产物", async () => {
      const ore = (await me()).inv["iron-ore"] ?? 0;
      const r1 = await h.call("transfer", { position: furnace, item: "iron-ore", count: ore });
      const e1 = await ent("stone-furnace", furnace.x, furnace.y);
      await sleep(3600 * Math.max(1, ore) / 1 + 500); // 石炉炼一块铁板 3.2 秒
      const b = (await me()).inv["iron-plate"] ?? 0;
      const r2 = await h.call("transfer", { position: furnace, item: "iron-plate", direction: "to_player" });
      const a = (await me()).inv["iron-plate"] ?? 0;
      return { pass: r1.ok && e1.source + e1.result >= 1 && r2.ok && a > b, seen: `放进铁矿 ${ore} (炉内 ${e1.source}); 取回铁板 ${b} → ${a}${r2.ok ? "" : " " + r2.error?.message}` };
    }],
    ["build 采矿机 + 加燃料", async () => { const r = await h.call("build", { item: "burner-mining-drill", position: { x: 9, y: 0 }, direction: "west" }); const f = await h.call("transfer", { position: { x: 9, y: 0 }, item: "coal", count: 3 }); const e = await ent("burner-mining-drill", 9, 0); return { pass: r.ok && f.ok && e.found && e.fuel >= 2, seen: `${r.ok ? "ok" : r.error?.message}; 服务器 ${e.found ? `有采矿机, 燃料 ${e.fuel}` : "没有"}${f.ok ? "" : " 加燃料: " + f.error?.message}` }; }],
    ["build 组装机 + configure 配方", async () => { const r = await h.call("build", { item: "assembling-machine-1", position: { x: 2, y: -4 } }); const e0 = await ent("assembling-machine-1", 2, -4); const c = await h.call("configure", { position: { x: e0.x, y: e0.y }, recipe: "iron-gear-wheel" }); const e = await ent("assembling-machine-1", 2, -4); return { pass: r.ok && c.ok && e.recipe === "iron-gear-wheel", seen: `建 ${r.ok ? "ok" : r.error?.message}; 配方 ${c.ok ? "ok" : c.error?.message}; 服务器配方 ${e.recipe || "无"}` }; }],
    ["research", async () => { const r = await h.call("research", { technology: "automation" }); const cur = await lab.exec(`local c = game.forces.player.current_research return c and c.name or ""`); return { pass: r.ok && cur === "automation", seen: `${r.ok ? JSON.stringify(r.result).slice(0, 100) : r.error?.message}; 服务器当前研究 ${cur || "无"}` }; }],
    ["belt_route + construct", async () => {
      const r = await h.call("belt_route", { from: { x: -2.5, y: 6.5 }, to: { x: -10.5, y: 10.5 } });
      const c = await h.call("construct", {}, { wait: true, timeoutMs: 60_000 });
      const cnt = (await lab.exec(`local s = game.surfaces[1] return {belts = s.count_entities_filtered{name = "transport-belt", area = {{-12, 5}, {-1, 12}}}, ghosts = s.count_entities_filtered{type = "entity-ghost", area = {{-12, 5}, {-1, 12}}}}`)) as { belts: number; ghosts: number };
      const tiles = r.result?.tiles ?? r.result?.items?.["transport-belt"];
      return { pass: r.ok && c.ok && cnt.belts > 0 && cnt.ghosts === 0, seen: `路线 ${r.ok ? `${r.result?.route} (${tiles} 格)` : r.error?.message}; 建造 ${c.ok ? c.result?.completion?.outcome : c.error?.message}; 服务器传送带 ${cnt.belts}、虚影 ${cnt.ghosts}` };
    }],
    // 第六轮: 分支版建 / 查看地下带报 "LuaEntity doesn't contain key neighbours" (2.1 删了这个接口, lab.md #73)
    ["build 地下带一对 + inspect", async () => {
      await h.call("move_to", { position: { x: -4, y: -5.5 } }, { wait: true }); // 前一项结束时角色在 10 格外
      const a = await h.call("build", { item: "underground-belt", position: { x: -6.5, y: -3.5 }, direction: "north", type: "input" }, { wait: true });
      const b = await h.call("build", { item: "underground-belt", position: { x: -6.5, y: -7.5 }, direction: "north", type: "output" }, { wait: true });
      const t = (await lab.exec(`local u = game.surfaces[1].find_entities_filtered{name = "underground-belt", area = {{-8, -9}, {-5, -2}}} local n = u[1] and u[1].underground_belt_neighbour return {count = #u, paired = n ~= nil and n.valid}`)) as { count: number; paired: boolean };
      const i = await h.call("inspect", { position: { x: -6.5, y: -7.5 } });
      return { pass: a.ok && b.ok && t.count === 2 && t.paired && i.ok, seen: `入口 ${a.ok ? JSON.stringify(a.result).slice(0, 160) : a.error?.message}; 出口 ${b.ok ? JSON.stringify(b.result).slice(0, 220) : b.error?.message}; 服务器 ${t.count} 节, 配对 ${t.paired}; inspect ${i.ok ? "ok" : i.error?.message}` };
    }],
    ["build 电线杆连网", async () => { await h.call("move_to", { position: { x: 2.5, y: -6 } }, { wait: true }); const r = await h.call("build", { item: "small-electric-pole", builds: [{ item: "small-electric-pole", position: { x: 0, y: -8 } }, { item: "small-electric-pole", position: { x: 5, y: -8 } }] }); const a = await ent("small-electric-pole", 0, -8, 0.8), b = await ent("small-electric-pole", 5, -8, 0.8); return { pass: r.ok && a.found && b.found && a.net === b.net, seen: `${r.ok ? "ok" : r.error?.message}; 服务器两根 ${a.found && b.found ? `都在, 电网 ${a.net} / ${b.net}` : "不全"}` }; }],
    // 上游: 够不着直接拒绝; 派对分支版: 32 格内先自己走过去再建 (回"已接受")。两种都守规则: 要么没建, 要么建成时角色在够得着的地方
    ["规则: 够不着要拒绝或先走过去", async () => {
      const r = await h.call("build", { item: "transport-belt", position: { x: 22, y: -20 } });
      if (r.ok) for (let i = 0; i < 40 && !(await ent("transport-belt", 22.5, -19.5, 0.6)).found; i++) await sleep(250);
      const e = await ent("transport-belt", 22.5, -19.5, 0.6); const m = await me(); const d = Math.hypot(m.x - 22.5, m.y + 19.5);
      const st = r.ok && !e.found ? await h.request("status") : null;
      return { pass: (!r.ok && !e.found) || (r.ok && e.found && d <= 10.5), seen: `${r.ok ? `已接受 ${JSON.stringify(r.result).slice(0, 160)}` : "拒绝: " + r.error?.message?.slice(0, 100)}; 服务器 ${e.found ? `建成, 角色离它 ${d.toFixed(1)} 格` : "没有"}${st ? `; 之后 status.last: ${JSON.stringify(st.result?.last).slice(0, 200)}` : ""}` };
    }],
    // 第八轮: 没有建设机器人时, 够不着的树被标红叉"留给机器人", 建造干等 → 应该走过去手砍再建
    ["build clear_obstacles 够不着的树 (没机器人)", async () => {
      await h.call("move_to", { position: { x: -18, y: 16 } }, { wait: true });
      const at = { x: -3.5, y: 16.5 }; // 离角色约 14.5 格, 超出够得着的距离; 第二棵树在占地外 2 格 (第九轮: 占地外 2 格也要清)
      await lab.exec(`local a = ... local s = game.surfaces[1] s.create_entity{name = "tree-01", position = {a.x, a.y}} s.create_entity{name = "tree-02", position = {a.x + 2, a.y}} game.connected_players[1].insert{name = "wooden-chest", count = 1} return true`, at);
      const r = await h.call("build", { item: "wooden-chest", position: at, clear_obstacles: true });
      for (let i = 0; i < 160 && !(await ent("wooden-chest", at.x, at.y, 0.6)).found; i++) await sleep(250);
      const e = await ent("wooden-chest", at.x, at.y, 0.6);
      const trees = await lab.exec(`local a = ... return game.surfaces[1].count_entities_filtered{type = "tree", position = {a.x, a.y}, radius = 2.5}`, at);
      return { pass: r.ok && e.found && trees === 0, seen: `${r.ok ? JSON.stringify(r.result).slice(0, 260) : r.error?.message}; 服务器 ${e.found ? "箱子建成" : "没建成"}, 树剩 ${trees}` };
    }],
    // 第八轮 (服务器角色没挂玩家) → 地图标记, 重复调用不叠加; 头顶不画 (第九轮: harness 自己画了, 叠在一起)
    // 用户不要任何 AI2 标识 (第九、十轮): 存档里以前加的地图标记和头顶大字, 开局要清干净
    ["清掉服务器角色的旧标识", async () => {
      await lab.exec(`local s = game.surfaces[1] game.forces.player.add_chart_tag(s, {position = {0, 0}, text = "AI2"}) rendering.draw_text{text = "AI2", surface = s, target = {0, 0}, color = {1, 1, 1}} return true`);
      const r = (await lab.exec(BOT_LABEL_LUA, { n: "AI2" })) as { tags: number; texts: number };
      const t = (await lab.exec(`local n = 0 for _, t in pairs(game.forces.player.find_chart_tags(game.surfaces[1])) do if t.text == "AI2" then n = n + 1 end end
        local m = 0 for _, o in pairs(rendering.get_all_objects()) do if o.valid and o.type == "text" and o.text == "AI2" then m = m + 1 end end return {tags = n, texts = m}`)) as { tags: number; texts: number };
      return { pass: r.tags === 1 && r.texts === 1 && t.tags === 0 && t.texts === 0, seen: `清掉地图标记 ${r.tags}、头顶大字 ${r.texts}; 之后剩 ${t.tags} / ${t.texts}` };
    }],
    // 第十轮: harness 引用未回复的聊天时按字节截断, 把汉字切成半个, 派对命令行严格解码 UTF-8 整条失败 (玩家 A 的 ./fh 全挂)
    ["长中文聊天被截断后回复仍是合法 UTF-8", async () => {
      if (values.mod !== "agent-harness-party") return { pass: true, seen: "只有分支版有服务器角色, 跳过" };
      const name = String(await lab.exec(`return game.players[1].name`));
      await lab.exec(`local r = remote.call("agent_harness", "bot_create", "ai3") return true`).catch(() => undefined);
      const say = JSON.stringify({ id: `utf8-say-${Date.now()}`, action: "say", bot: "ai3", args: { text: `@${name} ${"已出发动机".repeat(30)}` } });
      await lab.rcon!.exec(`/silent-command rcon.print(remote.call("agent_harness", "dispatch", [==[${say}]==]))`);
      const st = JSON.stringify({ id: `utf8-st-${Date.now()}`, action: "status", player: 1, args: {} });
      const raw = await lab.rcon!.exec(`/silent-command rcon.print(remote.call("agent_harness", "dispatch", [==[${st}]==]))`);
      const quoted = raw.includes("已出发动");
      return { pass: quoted && !raw.includes("�"), seen: `status ${raw.length} 字, 引用了那条聊天 ${quoted}, 坏字符 ${(raw.match(/�/g) ?? []).length} 个` };
    }],
    // 派对的常驻命令 (docs/STANDING-ORDERS.md: 会用队列 / 常驻命令的角色空闲 0~6%, 一次一条请求的 43~85%; 写法照 vendor usage.md:2520-2546):
    // 炉子燃料低就自己去箱子取煤、走一圈补 —— 我们第七~十轮"缺燃料"一直没人管
    ["常驻命令: 炉子缺燃料自己补", async () => {
      if (values.mod !== "agent-harness-party") return { pass: true, seen: "只有分支版有常驻命令, 跳过" };
      await lab.exec(`local s = game.surfaces[1] local c = s.create_entity{name = "wooden-chest", position = {-14.5, -14.5}, force = "player"} c.insert{name = "coal", count = 50}
        for _, x in pairs({-10, -7}) do s.create_entity{name = "stone-furnace", position = {x, -14}, force = "player"} end return true`);
      const o = await h.call("order_set", {
        name: "keep-furnaces-fueled", when: { until: "fuel_below", count: 1, position: { x: -8.5, y: -14 }, radius: 6 }, cooldown_ticks: 600, max_ticks: 6000,
        steps: [
          { action: "transfer", args: { position: { x: -14.5, y: -14.5 }, direction: "to_player", item: "coal", count: 20, up_to: 20, walk: true, ticks: 1800 } },
          { action: "feed", args: { area: { left_top: { x: -12, y: -16 }, right_bottom: { x: -5, y: -12 } }, types: ["furnace"], fuel: "coal", fuel_count: 5, walk: true, ticks: 3600, up_to: true } },
        ],
      });
      let f: { a: number; b: number } = { a: 0, b: 0 };
      for (let i = 0; i < 90 && (f.a === 0 || f.b === 0); i++) {
        await sleep(1000);
        f = (await lab.exec(`local s = game.surfaces[1] local function fuel(x) local e = s.find_entities_filtered{name = "stone-furnace", position = {x, -14}, radius = 0.6}[1] return e and e.get_fuel_inventory().get_item_count() or -1 end return {a = fuel(-10), b = fuel(-7)}`)) as { a: number; b: number };
      }
      const ord = await h.request("orders");
      return { pass: o.ok && f.a > 0 && f.b > 0, seen: `设命令 ${o.ok ? "ok" : o.error?.message?.slice(0, 120)}; 两台炉子燃料 ${f.a} / ${f.b}; orders: ${JSON.stringify(ord.result ?? ord.error).slice(0, 200)}` };
    }],
    // 监工改用操作员私信 (run.ts tellAgent; 派对 tools/idle_nudge.py): 要出现在角色下一条回复里; 开班 shift_start 要能调
    ["监工私信进下一条回复 + 开班", async () => {
      if (values.mod !== "agent-harness-party") return { pass: true, seen: "只有分支版有私信, 跳过" };
      const name = String(await lab.exec(`return game.players[1].name`));
      const shift = await lab.rcon!.exec(`/silent-command local ok, r = pcall(remote.call, "agent_harness", "shift_start", 1, "") rcon.print(ok and (type(r) == "table" and helpers.table_to_json(r) or tostring(r)) or ("失败: " .. tostring(r)))`);
      const text = "监工 (只给事实): 炉子 (-10,-14) 缺燃料";
      const tell = JSON.parse(await lab.rcon!.exec(`/silent-command rcon.print(remote.call("agent_harness", "dispatch", [==[${JSON.stringify({ id: `tell-${Date.now()}`, operator: true, action: "tell", args: { to: name, text } })}]==]))`));
      const st = await h.request("status");
      const seen = JSON.stringify(st).includes("缺燃料");
      return { pass: tell.ok && seen && !String(shift).startsWith("失败"), seen: `shift_start: ${String(shift).slice(0, 80)}; 私信 ${tell.ok ? "ok" : tell.error?.message}; 下一条回复里带上了 ${seen}` };
    }],
    // 通读模组时核出的 2.1 漏改 (docs/research/factorio-ai-party-reading.md): trace upstream 把 e.fluidbox 当参数传会报错, 2.1 管道连接的
    // target 是实体; 往熔炉放不能熔炼的东西时解释原因的代码读配方 .category 会报错
    ["2.1 流体上游 + 熔炉拒收的解释", async () => {
      if (values.mod !== "agent-harness-party") return { pass: true, seen: "只有分支版有 trace upstream, 跳过" };
      await h.call("move_to", { position: { x: 12, y: 12 } }, { wait: true });
      await lab.exec(`local s = game.surfaces[1] local f = "player"
        local t = s.create_entity{name = "storage-tank", position = {14.5, 18.5}, force = f} t.insert_fluid{name = "water", amount = 5000}
        s.create_entity{name = "pipe", position = {14.5, 16.5}, force = f} s.create_entity{name = "pipe", position = {14.5, 15.5}, force = f}
        local c = s.create_entity{name = "chemical-plant", position = {14.5, 13.5}, force = f, direction = defines.direction.south} c.set_recipe("sulfuric-acid")
        s.create_entity{name = "stone-furnace", position = {9, 12}, force = f}
        game.connected_players[1].insert{name = "iron-gear-wheel", count = 5} return true`);
      const tr = await h.call("trace", { position: { x: 14.5, y: 13.5 }, upstream: true });
      const fu = await h.call("transfer", { position: { x: 9, y: 12 }, item: "iron-gear-wheel", count: 5 });
      const fuText = fu.ok ? JSON.stringify(fu.result).slice(0, 160) : String(fu.error?.message);
      const luaErr = (s: string) => /doesn't contain key|attempt to (index|call)|LuaEntity was invalid/.test(s);
      return {
        pass: tr.ok && !luaErr(JSON.stringify(tr)) && !luaErr(fuText),
        seen: `trace upstream ${tr.ok ? JSON.stringify(tr.result).slice(0, 180) : tr.error?.message?.slice(0, 180)}; 熔炉放齿轮: ${fuText.slice(0, 160)}`,
      };
    }],
    ["规则: 背包里没有要拒绝", async () => { const r = await h.call("build", { item: "steel-chest", position: { x: 3, y: 0 } }); await sleep(1500); const e = await ent("steel-chest", 3.5, 0.5, 0.6); const st = r.ok ? await h.request("status") : null; return { pass: !e.found && (!r.ok || /fail|missing|short|not/i.test(JSON.stringify(st?.result?.last ?? ""))), seen: `${r.ok ? `已接受 ${JSON.stringify(r.result).slice(0, 160)}` : r.error?.message?.slice(0, 120)}; 服务器 ${e.found ? "有" : "没有"}${st ? `; 之后 status.last: ${JSON.stringify(st.result?.last).slice(0, 200)}` : ""}` }; }],
    // 整块贴蓝图 (第 3 班两人 50 分钟只建了 44 次):
    // 像大脑那样用会话文件调 ./bp build (src/play/bp.ts), 再数那片区域建成的实体; 放在西边 (-17,6), 不碰前面各项摆的东西
    ["bp build 整块蓝图 (16 炉冶炼列)", async () => {
      await lab.exec(`local inv = game.connected_players[1].get_main_inventory()
        for _, st in pairs({{"transport-belt", 60}, {"inserter", 32}, {"stone-furnace", 16}, {"small-electric-pole", 12}}) do inv.insert{name = st[1], count = st[2]} end return true`);
      const sf = path.join(labRoot(), "play", "check-session.json");
      fs.writeFileSync(sf, JSON.stringify({ rconPort: lab.rconPort, password: lab.password, player: 1, logDir: path.join(labRoot(), "play") }));
      let out = "";
      try { out = execFileSync(process.execPath, ["--env-file-if-exists=" + path.join(REPO, ".env"), path.join(REPO, "src", "play", "bp.ts"), "build", "1", "--at", "-17,6"], { env: { ...process.env, FP_SESSION: sf }, encoding: "utf8", timeout: 15 * 60_000 }); }
      catch (e) { out = `${(e as { stdout?: string }).stdout ?? ""}${(e as Error).message}`; }
      const n = (await lab.exec(`local s = game.surfaces[1] local a = {{-24, -6}, {-10, 18}}
        return {f = s.count_entities_filtered{area = a, name = "stone-furnace"}, i = s.count_entities_filtered{area = a, name = "inserter"},
          b = s.count_entities_filtered{area = a, type = "transport-belt"}, p = s.count_entities_filtered{area = a, name = "small-electric-pole"}, g = s.count_entities_filtered{area = a, type = "entity-ghost"}}`)) as { f: number; i: number; b: number; p: number; g: number };
      return { pass: n.f === 16 && n.i === 32 && n.p === 12 && n.g === 0, seen: `炉 ${n.f}/16 机械臂 ${n.i}/32 电线杆 ${n.p}/12 传送带 ${n.b} 剩虚影 ${n.g}; ${out.trim().split("\n").slice(-2).join(" | ").slice(0, 240)}` };
    }],
    // ── 太空 (M8 准备): 顺序有依赖, 单独跑用 --only space ──
    ["space 夹具 + platform_create", async () => {
      if (!spaceOnly) return { pass: true, seen: "只有分支版有太空动作, 跳过" };
      const fx = (await lab.exec(`local a = ... local s = game.surfaces[1] local f = game.forces.player
        f.research_all_technologies()
        for _, box in pairs({{{a.sx - 5, a.sy - 5}, {a.sx + 5, a.sy + 5}}, {{a.px - 5, a.py - 5}, {a.px + 5, a.py + 5}}}) do
          for _, e in pairs(s.find_entities_filtered{area = box}) do if e.name ~= "character" then e.destroy() end end
        end
        local silo = s.create_entity{name = "rocket-silo", position = {a.sx, a.sy}, force = f}
        local pad = s.create_entity{name = "cargo-landing-pad", position = {a.px, a.py}, force = f}
        -- 发射井和降落仓都要电 (第一次跑: 没电的发射井一直停在"门正在打开", 火箭升不起来): 各配一座变电站 + 一个电力接口 (沙盘夹具, 不是玩家建的)
        local function power(x, y) s.create_entity{name = "substation", position = {x, y}, force = f} s.create_entity{name = "electric-energy-interface", position = {x + 3, y}, force = f} end
        power(a.sx, a.sy + 7) power(a.px, a.py + 7)
        game.connected_players[1].teleport({a.sx - 8, a.sy + 7})
        return {silo = silo ~= nil, pad = pad ~= nil}`, { sx: SILO.x, sy: SILO.y, px: PAD.x, py: PAD.y })) as { silo: boolean; pad: boolean };
      const r = await h.call("platform_create", { name: PLATFORM });
      const s = await platformInfo();
      return { pass: fx.silo && fx.pad && r.ok && s.found && s.state === "waiting_for_starter_pack", seen: `发射井 ${fx.silo} 降落仓 ${fx.pad}; platform_create ${brief(r)}; 平台状态 ${s.state}` };
    }],
    ["space launch 起始包 → 平台有枢纽", async () => {
      if (!spaceOnly) return { pass: true, seen: "跳过" };
      const ready = await rocketReady(true);
      // 起始包进了火箭货舱、平台又在等它, 游戏自己就会发射 (platform_create 的回复也这么说; 第二次跑: 我们的 launch 晚了一步, 回 "launch_started"), 所以只认结果: 平台有了枢纽
      const r = await h.call("launch", { position: SILO, platform: PLATFORM });
      await fast(true);
      const s = await waitUntil((x) => !!x.hub, 150);
      await fast(false);
      return { pass: ready && !!s.hub, seen: `火箭就绪 ${ready}; launch ${brief(r, 120)}; 平台 ${s.state} 枢纽 ${s.hub} 在 ${s.at}` };
    }],
    ["space launch ride 角色坐火箭上平台", async () => {
      if (!spaceOnly) return { pass: true, seen: "跳过" };
      const ready = await rocketReady(false);
      // harness 的乘客规矩: 只能带装甲和枪 (第二次跑: 背包里的传送带被拒; 第三次: 弹药槽里开局的 10 发子弹被拒); 先清空背包、弹药槽、垃圾槽
      await lab.exec(`local p = game.connected_players[1] p.get_main_inventory().clear()
        for _, k in pairs({"character_ammo", "character_trash"}) do local inv = p.get_inventory(defines.inventory[k]) if inv then inv.clear() end end return true`);
      const r = await h.call("launch", { position: SILO, platform: PLATFORM, ride: true });
      await fast(true);
      const s = await waitUntil((x) => x.player_surface !== "nauvis" && x.has_character && !x.driving, 150);
      await fast(false);
      return { pass: ready && r.ok && s.player_surface !== "nauvis" && s.has_character && !s.driving, seen: `火箭就绪 ${ready}; launch ride ${brief(r)}; 角色所在 ${s.player_surface} (平台面 ${s.surface}) 有身体 ${s.has_character} 还在坐 ${s.driving}` };
    }],
    ["space platform_schedule + platforms + requests", async () => {
      if (!spaceOnly) return { pass: true, seen: "跳过" };
      const sc = await h.call("platform_schedule", { platform: PLATFORM, stops: [{ station: "nauvis", wait: [{ type: "time", ticks: 600 }] }] });
      const ls = await h.call("platforms", {});
      const rq = await h.call("requests", { platform: PLATFORM });
      const s = await platformInfo();
      return { pass: sc.ok && ls.ok && rq.ok && (s.stops ?? 0) >= 1, seen: `schedule ${brief(sc, 120)}; platforms ${brief(ls, 140)}; requests ${brief(rq, 120)}; 时刻表 ${s.stops} 站` };
    }],
    ["space drop 投货到降落仓", async () => {
      if (!spaceOnly) return { pass: true, seen: "跳过" };
      const ins = await lab.exec(`local a = ... for _, pl in pairs(game.forces.player.platforms) do if pl.valid and pl.name == a.name and pl.hub and pl.hub.valid then return pl.hub.get_inventory(defines.inventory.hub_main).insert{name = "iron-plate", count = 50} end end return 0`, { name: PLATFORM });
      const r = await h.call("drop", { platform: PLATFORM, items: [{ item: "iron-plate", count: 50 }] });
      await fast(true);
      const s = await waitUntil((x) => (x.pad_iron ?? 0) >= 50, 120);
      await fast(false);
      return { pass: ins === 50 && r.ok && (s.pad_iron ?? 0) >= 50, seen: `枢纽放入 ${ins}; drop ${brief(r)}; 降落仓里的铁板 ${s.pad_iron}` };
    }],
    ["space land 角色坐货舱回星球", async () => {
      if (!spaceOnly) return { pass: true, seen: "跳过" };
      const r = await h.call("land", {});
      await fast(true);
      const s = await waitUntil((x) => x.player_surface === "nauvis" && x.has_character && !x.driving, 120);
      await fast(false);
      return { pass: r.ok && s.player_surface === "nauvis" && s.has_character && !s.driving, seen: `land ${brief(r)}; 角色所在 ${s.player_surface} 有身体 ${s.has_character} 还在坐 ${s.driving}` };
    }],
  ];
  const only = values.only?.split(",");
  for (const [name, fn] of cases) {
    if (only && !only.some((o) => name.startsWith(o))) continue;
    let line: string;
    try { const t = Date.now(); const { pass, seen } = await fn(); line = `${pass ? "✅" : "❌"} ${name} (${((Date.now() - t) / 1000).toFixed(1)} 秒): ${seen}`; }
    catch (e) { line = `❌ ${name}: ${(e as Error).message.slice(0, 220)}`; }
    log(line);
    rows.push(line);
  }
  const linger = Number(values.linger);
  if (linger > 0) { log(`做完了, 窗口留 ${linger} 秒再关`); await sleep(linger * 1000); }
} catch (e) {
  log(`出错: ${(e as Error).message.slice(0, 300)}`);
} finally {
  const dir = path.join(labRoot(), "play");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `check-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`), calls.map((c) => JSON.stringify(c)).join("\n") + "\n");
  viewer.close();
  await lab.stop({ save: false });
}
console.log(`\n${rows.join("\n")}\n动作调用 ${calls.length} 次 (含等待时的 status), 平均 ${(calls.reduce((s, c) => s + c.ms, 0) / Math.max(1, calls.length)).toFixed(0)} 毫秒`);
