// 火车第三批 (补到 10 条): 车站上限计在途的车 (L14 后半)、信号把后车挡在红灯前 (T1/T2)、单头车不能倒着开、在途中车站被停用照样开过去。
// 前两条用一条带信号的西行单向轨 (积木 buildSignals): 单轨没有信号时第二列车 no_path (trains2.ts 第一版写法), 分成区段后才能跟车。
// 后两条复用 trains.ts 的双向直轨。摆放一律 lab.place (查碰撞), 信号位置按 rail-geometry.json 的合法位置表 (东西向直轨: 北侧 1.5 格、朝东 = 管西行的车)。
import type { Experiment, ExpContext } from "../src/verify/types.ts";
import { SET_SCHEDULE, STOP_MODE, build, clearOldStops, status, waitState, rec, type Status } from "./trains.ts";

// 西行单向轨: 西头终点"甲"、中间"丙"(都在北侧, 西行); 信号 S1 (甲区段入口)、S2 (丙区段入口)、S3 (把 A、B 两列车隔开);
// 列车 A、B 都是 1 台朝西机车 + 2 节车厢, A 在 S2 和 S3 之间, B 在 S3 东边。
const BUILD_SIGNALS = `
local a = ...
local s = game.surfaces[a.surface]
local f = "player"
local d = defines.direction
local ry, cx = a.ry, a.x
for x = a.x0 + 1, a.x1 - 1, 2 do lab.place{surface = s, name = "straight-rail", position = {x, ry}, direction = d.east, force = f} end
local function stop(name, x)
  local st = lab.place{surface = s, name = "train-stop", position = {x, ry - 2}, direction = d.west, force = f, station = name}
  if not st.connected_rail then error(name .. " 车站没接上铁轨", 0) end
  st.backer_name = name
  return {x = st.position.x, y = st.position.y}
end
local function signal(rx, tag)
  local sg = lab.place{surface = s, name = "rail-signal", position = {rx + 0.5, ry - 1.5}, direction = d.east, force = f}
  local ok, rails = pcall(sg.get_connected_rails)
  if not ok or #rails == 0 then error(tag .. " 信号没接上铁轨", 0) end
  lab.label(sg, tag)
  return {x = sg.position.x, y = sg.position.y}
end
local function train(fx, tag)
  local l = lab.place{surface = s, name = "locomotive", position = {fx, ry}, direction = d.west, force = f}
  local w1 = lab.place{surface = s, name = "cargo-wagon", position = {fx + 7, ry}, direction = d.west, force = f}
  local w2 = lab.place{surface = s, name = "cargo-wagon", position = {fx + 14, ry}, direction = d.west, force = f}
  if not (l.train.id == w1.train.id and w2.train.id == l.train.id) then error(tag .. " 没拼成一列", 0) end
  l.insert{name = "coal", count = 50}
  lab.label(l, tag)
  return l.train.id
end
local out = {jia = stop("甲", cx - 50), bing = stop("丙", cx - 18)}
out.s1 = signal(cx - 25, "S1")
out.s2 = signal(cx + 7, "S2")
out.s3 = signal(cx + 31, "S3")
out.A = train(cx + 12, "列车 A")
out.B = train(cx + 36, "列车 B")
return out`;

interface Pt { x: number; y: number }
interface SignalSite { jia: Pt; bing: Pt; s1: Pt; s2: Pt; s3: Pt; A: number; B: number; ry: number }

export async function buildSignals(ctx: ExpContext): Promise<SignalSite> {
  const ry = ctx.y + 33, x0 = ctx.x - 60, x1 = ctx.x + 60;
  const area: [[number, number], [number, number]] = [[x0 - 2, ry - 8], [x1 + 2, ry + 8]];
  ctx.watch(area);
  await ctx.lab.rpc("prepare_area", { surface: ctx.surface, area, no_enemies: true }, { timeoutMs: 120_000 });
  await clearOldStops(ctx);
  const b = (await ctx.lua(BUILD_SIGNALS, { ry, x0, x1 })) as Omit<SignalSite, "ry">;
  await ctx.lab.rpc("viewer", { position: [ctx.x, ry - 14], zoom: 0.4, surface: ctx.surface }, { retry: true }).catch(() => undefined);
  return { ...b, ry };
}

// 列车的东西两端 (车厢中心)、是否有路、要去的站、停在哪个信号前
const TRAIN_EXTRA = `
local a = ...
local t = game.train_manager.get_train_by_id(a.train_id)
local minx, maxx = math.huge, -math.huge
for _, c in pairs(t.carriages) do minx = math.min(minx, c.position.x); maxx = math.max(maxx, c.position.x) end
local pe, sg = t.path_end_stop, t.signal
return {west = minx, east = maxx, has_path = t.has_path, goal = pe and {name = pe.backer_name, x = pe.position.x, y = pe.position.y} or nil,
        signal = sg and {x = sg.position.x, y = sg.position.y} or nil}`;
interface Extra { west: number; east: number; has_path: boolean; goal?: { name: string; x: number; y: number }; signal?: Pt }
const extra = async (ctx: ExpContext, train_id: number) => (await ctx.lua(TRAIN_EXTRA, { train_id })) as Extra;

// 车站: 关联的列车数 (trains_count)、2.1 新增的预约数、上限
const STOP_INFO = `
local a = ...
local st = game.surfaces[a.surface].find_entity("train-stop", {a.x, a.y})
if not st then error("找不到车站", 0) end
local ok, res = pcall(function() return st.train_reservations_count end)
return {count = st.trains_count, reservations = ok and res or -1, limit = st.trains_limit}`;
interface StopInfo { count: number; reservations: number; limit: number }
const stopInfo = async (ctx: ExpContext, p: Pt) => (await ctx.lua(STOP_INFO, p)) as StopInfo;

const SET_LIMIT = `
local a = ...
local st = game.surfaces[a.surface].find_entity("train-stop", {a.x, a.y})
if not st then error("找不到车站", 0) end
st.trains_limit = a.limit
return st.trains_limit`;

const SIGNAL_STATES = `
local a = ...
local names = {} for k, v in pairs(defines.signal_state) do names[v] = k end
local out = {}
for i, p in ipairs(a.signals) do
  local sg = game.surfaces[a.surface].find_entity("rail-signal", {p.x, p.y})
  out[i] = sg and names[sg.signal_state] or "missing"
end
return out`;
const signalStates = async (ctx: ExpContext, signals: Pt[]) => (await ctx.lua(SIGNAL_STATES, { signals })) as string[];

const near = (a: Pt | undefined, b: Pt) => !!a && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
// 等列车停在指定信号前 (状态"等信号"且列车记的信号就是它; 只看状态会把路过别的信号时的短暂等待也算上)
async function waitAtSignal(ctx: ExpContext, train_id: number, sig: Pt, maxSeconds: number) {
  for (let t = 0; t < maxSeconds * 60; t += 10) {
    await ctx.ticks(10);
    const s = await status(ctx, train_id);
    if (s.state === "wait_signal") { const e = await extra(ctx, train_id); if (near(e.signal, sig)) return e; }
  }
  return null;
}
const brief = (s: Status) => `${s.state}${s.station ? " 在 " + s.station : ""}`;

export const limitCountsEnRoute: Experiment = {
  id: "trains.limit.counts-en-route",
  topic: "火车",
  claim: "车站上限把在途的车也算进去: 上限 1 的站, 第一列车还在路上就占了名额, 第二列车显示\"目的地已满\"原地等; 第一列车停站期间仍占着; 离站后也不立刻释放, 要整列开出车站所在的区段 (车尾过了下一个信号) 名额才放出来, 第二列车才出发",
  refs: ["logistics.md L14 (在途和停站的车都计入上限)", "trains.md T19 (出车站区段才释放预约)", "knowledge/patterns/logistics-choice.md P-logi-09 (通用车网靠优先级 + 上限)"],
  sources: [{ title: "官方 wiki: Train stop (只有设定数量的列车能把这个站预约为目的地)", url: "https://wiki.factorio.com/Train_stop", date: "2026-03-13", credibility: 2 }],
  gameSeconds: 200,
  async run(ctx) {
    const b = await buildSignals(ctx);
    await ctx.powered();
    await ctx.lua(SET_LIMIT, { ...b.bing, limit: 1 });
    const before = await stopInfo(ctx, b.bing);
    await ctx.say("丙站上限 1: 列车 A 先出发去丙, 1 秒后列车 B 也去丙; 看 B 是不是在 A 还没到站时就显示目的地已满");
    await ctx.lua(SET_SCHEDULE, { train_id: b.A, schedule: { current: 1, records: [rec("丙", 15), rec("甲", 600)] } });
    await ctx.ticks(60);
    const aEnRoute = await status(ctx, b.A), stopEnRoute = await stopInfo(ctx, b.bing);
    await ctx.lua(SET_SCHEDULE, { train_id: b.B, schedule: { current: 1, records: [rec("丙", 3), rec("甲", 600)] } });
    await ctx.ticks(90);
    const bEnRoute = await status(ctx, b.B), aThen = await status(ctx, b.A);
    const aAt = await waitState(ctx, b.A, (s) => s.state === "wait_station" && s.station === "丙", 60, 10);
    if (!aAt) return { verdict: "inconclusive", summary: `列车 A 60 秒内没停到丙站 (${brief(await status(ctx, b.A))})`, measured: { before, aEnRoute, stopEnRoute, bEnRoute } };
    await ctx.ticks(120);
    const bParked = await status(ctx, b.B), stopParked = await stopInfo(ctx, b.bing);
    // A 停 15 秒后离站; 每 10 tick 看一次: A 什么时候离站、名额什么时候放出来、B 什么时候不再"目的地已满"
    let aLeft = -1, bGo = -1;
    let stopAtLeave: StopInfo | null = null, bAtGo: Status | null = null, aAtGo: Extra | null = null;
    for (let t = 0; t < 40 * 60; t += 10) {
      await ctx.ticks(10);
      const a = await status(ctx, b.A);
      if (aLeft < 0 && !(a.state === "wait_station" && a.station === "丙")) { aLeft = t; stopAtLeave = await stopInfo(ctx, b.bing); }
      if (aLeft >= 0) {
        const bs = await status(ctx, b.B);
        if (bs.state !== "destination_full") { bGo = t; bAtGo = bs; aAtGo = await extra(ctx, b.A); break; }
      }
    }
    const measured = { before, aEnRoute, stopEnRoute, bEnRoute, aThen, bParked, stopParked, aLeft, stopAtLeave, bGo, bAtGo, aAtGo, s1: b.s1 };
    const enRouteOk = aEnRoute.state === "on_the_path" && stopEnRoute.count === 1 && aThen.state !== "wait_station";
    if (!enRouteOk) return { verdict: "inconclusive", summary: `没测到 A 在途的那一刻 (1 秒时 A ${brief(aEnRoute)}、丙站计数 ${stopEnRoute.count}; 2.5 秒时 A ${brief(aThen)})`, measured };
    // 释放时 A 车尾 (尾节车厢中心 + 约 3.5 格) 应该刚过 S1 (±1.5 格), 且离站那一刻还算着 A
    const releasedAtBlockExit = !!aAtGo && Math.abs(aAtGo.east + 3.5 - b.s1.x) <= 1.5 && stopAtLeave?.count === 1;
    const ok = before.count === 0 && bEnRoute.state === "destination_full" && bParked.state === "destination_full" && stopParked.count === 1 && aLeft >= 0 && bGo >= 0 && releasedAtBlockExit;
    const gap = bGo >= 0 && aLeft >= 0 ? `${((bGo - aLeft) / 60).toFixed(2)} 秒` : "—";
    return {
      verdict: ok ? "verified" : bEnRoute.state === "on_the_path" || bEnRoute.state === "wait_signal" ? "refuted" : "inconclusive",
      summary: `丙站上限 1: A 出发前计数 ${before.count}; A 在路上时计数 ${stopEnRoute.count} (预约 ${stopEnRoute.reservations}), B 是 ${bEnRoute.state}; A 停站时 B 仍是 ${bParked.state}、计数 ${stopParked.count}; ` +
        `A 离站那一刻计数 ${stopAtLeave?.count ?? "—"}, B ${bGo >= 0 ? `在 A 离站后 ${gap} 变成 ${bAtGo?.state} (那时 A 车尾约在 x=${aAtGo ? (aAtGo.east + 3.5).toFixed(1) : "—"}, S1 在 x=${b.s1.x}: ${releasedAtBlockExit ? "刚开出丙区段" : "不是在开出区段时"})` : "40 秒内一直目的地已满"}`,
      measured,
    };
  },
};

export const signalHoldsFollower: Experiment = {
  id: "trains.signal.holds-follower-at-red",
  topic: "火车",
  claim: "铁路信号把铁轨分成区段, 一个区段里同时只有一列车: 前方区段有车时信号是红灯, 后车停在信号前 (状态\"等信号\"), 不进区段; 前车整列开出那个区段后信号变绿, 后车才走",
  refs: ["trains.md T1、T2 (信号和区段)", "docs/research/players/game-tips.md TT15 (基础铁路信号: 同一条铁轨上跑多列车)"],
  sources: [
    { title: "官方 wiki: Tutorial:Train signals", url: "https://wiki.factorio.com/Tutorial:Train_signals", date: "2023-02-03", credibility: 2 },
    { title: "游戏内提示与技巧: 基础铁路信号 (本机 2.1.24)", credibility: 1 },
  ],
  gameSeconds: 200,
  async run(ctx) {
    const b = await buildSignals(ctx);
    await ctx.powered();
    await ctx.say("列车 A 去丙站停 30 秒; 列车 B 去甲站, 要经过 A 停着的那个区段: B 应该停在 S2 前等红灯");
    await ctx.lua(SET_SCHEDULE, { train_id: b.A, schedule: { current: 1, records: [rec("丙", 30), rec("甲", 600)] } });
    await ctx.ticks(60);
    await ctx.lua(SET_SCHEDULE, { train_id: b.B, schedule: { current: 1, records: [rec("甲", 600)] } });
    const aAt = await waitState(ctx, b.A, (s) => s.state === "wait_station" && s.station === "丙", 60, 10);
    if (!aAt) return { verdict: "inconclusive", summary: `列车 A 60 秒内没停到丙站 (${brief(await status(ctx, b.A))})`, measured: {} };
    const bHeldAt = await waitAtSignal(ctx, b.B, b.s2, 30);
    if (!bHeldAt) return { verdict: "inconclusive", summary: `A 停在丙时 B 30 秒内没停到 S2 前 (${brief(await status(ctx, b.B))}, 信号 ${JSON.stringify((await extra(ctx, b.B)).signal ?? null)})`, measured: {} };
    const lightsWhileHeld = await signalStates(ctx, [b.s1, b.s2, b.s3]);
    // 从 B 停下到 A 离站、开出丙区段: B 车头 (最西那节车厢中心) 不能越过 S2; 记 S2 变绿和 B 起步时 A 尾部的位置
    let bEnteredEarly = false, minBWest = Infinity, s2Open = -1, bMoved = -1;
    let aAtOpen: Extra | null = null;
    for (let t = 0; t < 60 * 60; t += 10) {
      await ctx.ticks(10);
      const a = await extra(ctx, b.A), bb = await extra(ctx, b.B);
      const aInBing = a.east + 3.5 > b.s1.x; // A 尾部还没过 S1 = 还在丙区段 (车厢中心到车尾约 3 格)
      if (aInBing) { minBWest = Math.min(minBWest, bb.west); if (bb.west < b.s2.x) bEnteredEarly = true; }
      if (s2Open < 0) {
        const [, s2] = await signalStates(ctx, [b.s1, b.s2]);
        if (s2 !== "closed") { s2Open = t; aAtOpen = a; }
      }
      if (bMoved < 0 && !near(bb.signal, b.s2)) bMoved = t;
      if (s2Open >= 0 && bMoved >= 0) break;
    }
    // 最后: A 停在甲 (S1 后面的区段), B 应该再停到 S1 前
    const bAtS1 = await waitAtSignal(ctx, b.B, b.s1, 60);
    const aEnd = await status(ctx, b.A);
    const measured = { bHeldAt, lightsWhileHeld, minBWest, bEnteredEarly, s2Open, bMoved, aAtOpen, bAtS1: bAtS1, aEnd, s1: b.s1, s2: b.s2 };
    const ok = lightsWhileHeld[1] === "closed" && !bEnteredEarly && s2Open >= 0 && bMoved >= 0
      && !!aAtOpen && aAtOpen.east + 3.5 <= b.s1.x + 1 && !!bAtS1 && aEnd.station === "甲";
    return {
      verdict: ok ? "verified" : bEnteredEarly ? "refuted" : "inconclusive",
      summary: `A 停在丙时 B 停在 S2 前等信号 (S1/S2/S3 = ${lightsWhileHeld.join("/")}), B 车头最西到 x=${minBWest.toFixed(1)} (S2 在 x=${b.s2.x}), ${bEnteredEarly ? "提前进了丙区段" : "没进丙区段"}; ` +
        `S2 在 A 尾部车厢中心到 x=${aAtOpen ? aAtOpen.east.toFixed(1) : "—"} (S1 在 x=${b.s1.x}) 时变绿, B 随后起步; A 停在甲后 B ${bAtS1 ? "又停在 S1 前" : "60 秒内没停到 S1 前"}`,
      measured,
    };
  },
};

// 拆掉朝东的机车: 剩 朝西机车 + 车厢 = 单头车 (只能往西开); 返回新列车编号 (改编组后编号会变)
const MAKE_SINGLE_HEADED = `
local a = ...
local t = game.train_manager.get_train_by_id(a.train_id)
local w = t.cargo_wagons[1]
local gone = 0
for _, l in pairs(t.locomotives.front_movers) do if math.abs(l.orientation - 0.25) < 0.01 then l.destroy(); gone = gone + 1 end end
if gone == 0 then for _, l in pairs(t.locomotives.back_movers) do if math.abs(l.orientation - 0.25) < 0.01 then l.destroy(); gone = gone + 1 end end end
local nt = w.train
local locos = #nt.locomotives.front_movers + #nt.locomotives.back_movers
if gone ~= 1 or locos ~= 1 then error("没改成单头车: 拆了 " .. gone .. " 台, 剩 " .. locos .. " 台", 0) end
local l = nt.locomotives.front_movers[1] or nt.locomotives.back_movers[1]
lab.label(l, "单头车 (故意): 只有朝西的车头")
return {train_id = nt.id}`;

// 在列车东头加一台朝东的机车, 变回双头车
const ADD_EAST_LOCO = `
local a = ...
local s = game.surfaces[a.surface]
local t = game.train_manager.get_train_by_id(a.train_id)
local east
for _, c in pairs(t.carriages) do if not east or c.position.x > east.position.x then east = c end end
local l = lab.place{surface = s, name = "locomotive", position = {east.position.x + 7, east.position.y}, direction = defines.direction.east, force = "player"}
l.insert{name = "coal", count = 50}
if l.train.id ~= east.train.id then error("加的机车没连上", 0) end
local locos = #l.train.locomotives.front_movers + #l.train.locomotives.back_movers
lab.label(l, "加上的朝东车头")
return {train_id = l.train.id, locos = locos}`;

export const singleHeadedCannotReverse: Experiment = {
  id: "trains.single-headed.cannot-reverse",
  topic: "火车",
  claim: "自动模式下列车只能朝车头方向开: 只有一台朝西机车的单头车去东边的站是\"无路可走\", 原地不动; 往西 (车头方向) 的站照常能到; 东头加一台朝东的机车 (两台机车朝向相反) 后前后都能开",
  refs: ["mindset.md M41 (单车头 + 环线 vs 双车头 + 终点站)", "trains.md 检索缺口 (双头车还是环线没找到 2.0 之后的来源)"],
  sources: [{ title: "官方 wiki: Railway (列车自动行驶时只能往前开; 两台朝向不同的机车连在一起才能前后都开; 无路可走时检查是否只往前开就能到)", url: "https://wiki.factorio.com/Railway", date: "2026-10-22", credibility: 2 }],
  gameSeconds: 300,
  async run(ctx) {
    const b = await build(ctx);
    await ctx.powered();
    const single = (await ctx.lua(MAKE_SINGLE_HEADED, { train_id: b.train_id })) as { train_id: number };
    await ctx.say("拆掉朝东的车头, 剩下的是单头车 (车头朝西): 先让它去东头的乙站 (要倒着开, 应该无路可走), 再去西头的甲站");
    const x0 = (await status(ctx, single.train_id)).x;
    await ctx.lua(SET_SCHEDULE, { train_id: single.train_id, schedule: { current: 1, records: [rec("乙", 3)] } });
    await ctx.ticks(20 * 60);
    const back = await status(ctx, single.train_id), backX = await extra(ctx, single.train_id);
    await ctx.lua(SET_SCHEDULE, { train_id: single.train_id, schedule: { current: 1, records: [rec("甲", 3)] } });
    const fwd = await waitState(ctx, single.train_id, (s) => s.state === "wait_station" && s.station === "甲", 120);
    await ctx.say("东头加一台朝东的车头, 再去乙站");
    const dbl = (await ctx.lua(ADD_EAST_LOCO, { train_id: single.train_id })) as { train_id: number; locos: number };
    await ctx.lua(SET_SCHEDULE, { train_id: dbl.train_id, schedule: { current: 1, records: [rec("乙", 3)] } });
    const dblAtYi = await waitState(ctx, dbl.train_id, (s) => s.state === "wait_station" && s.station === "乙", 150);
    const moved = Math.abs(back.x - x0);
    const measured = { back, backX, moved, fwd: !!fwd, locos: dbl.locos, dblAtYi: !!dblAtYi };
    const ok = back.state === "no_path" && !backX.has_path && moved < 0.5 && !!fwd && dbl.locos === 2 && !!dblAtYi;
    return {
      verdict: ok ? "verified" : back.state !== "no_path" && moved > 5 ? "refuted" : "inconclusive",
      summary: `单头车 (车头朝西) 去东边乙站: 20 秒后 ${back.state}, 有路=${backX.has_path}, 挪了 ${moved.toFixed(1)} 格; 去西边甲站${fwd ? "到了" : "没到"}; 加朝东车头 (共 ${dbl.locos} 台) 后去乙站${dblAtYi ? "到了" : "没到"}`,
      measured,
    };
  },
};

export const disabledEnRouteStillGoes: Experiment = {
  id: "trains.disabled-en-route.still-goes",
  topic: "火车",
  claim: "列车已经在去某站的路上时该站被停用 (电路停用或上限改 0), 列车照样开到这个站并等完条件, 不改去别的同名站; 只有出发时目的站已经停用, 才挑另一个启用的同名站",
  refs: ["logistics.md L14 (停用 = 上限 0)", "trains.md T20 (半路状态)", "verify.md 下一批原写作\"在途中被停用就改去另一个同名站\", 和 wiki 原文相反, 以实测为准"],
  sources: [{ title: "官方 wiki: Train stop (列车在途中或已停站时车站被停用, 列车照样开到站并完成等待条件; 上限在途中改变也一样; 目的站已停用才选同名的启用站)", url: "https://wiki.factorio.com/Train_stop", date: "2026-03-13", credibility: 2 }],
  gameSeconds: 400,
  async run(ctx) {
    // 两个"甲": 近的在中间偏东 (北侧西行), 远的在西头; 列车从东头乙站出发, 正常会去近的
    const b = await build(ctx, [{ name: "甲", x: ctx.x + 20 }]);
    await ctx.powered();
    const mids = Array.isArray(b.mids) ? b.mids : [];
    const nearStop = mids[0].north, farStop = { x: b.jia.x, y: b.jia.y };
    const toYi = async () => {
      await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 2, records: [rec("甲", 3), rec("乙", 3)] } });
      return waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "乙", 120);
    };
    if (!(await toYi())) return { verdict: "inconclusive", summary: "列车没停到乙站", measured: {} };
    const results: Record<string, { at: string; waitedTicks: number; goalBefore?: string; goalAfter?: string }> = {};
    for (const round of ["出发前停用 (对照)", "途中电路停用", "途中上限改 0"] as const) {
      if (round === "出发前停用 (对照)") await ctx.lua(STOP_MODE, { ...nearStop, mode: "circuit-off" });
      await ctx.say(`第 ${Object.keys(results).length + 1} 轮: ${round}`);
      await ctx.lua(SET_SCHEDULE, { train_id: b.train_id, schedule: { current: 1, records: [rec("甲", 3), rec("乙", 3)] } });
      let goalBefore: string | undefined, goalAfter: string | undefined;
      if (round !== "出发前停用 (对照)") {
        // 等它确实朝近站开起来 (要去的站 = 近站、在走) 再停用
        let moving = false;
        for (let t = 0; t < 10 * 60 && !moving; t += 10) {
          await ctx.ticks(10);
          const e = await extra(ctx, b.train_id), s = await status(ctx, b.train_id);
          if (s.state === "on_the_path" && Math.abs(s.speed) > 0.05 && near(e.goal, nearStop)) { moving = true; goalBefore = "近站"; }
        }
        if (!moving) return { verdict: "inconclusive", summary: `${round}: 列车 10 秒内没朝近站开起来`, measured: results };
        await ctx.lua(STOP_MODE, { ...nearStop, mode: round === "途中电路停用" ? "circuit-off" : "limit0" });
        await ctx.ticks(30);
        const e2 = await extra(ctx, b.train_id);
        goalAfter = near(e2.goal, nearStop) ? "近站" : near(e2.goal, farStop) ? "远站" : (e2.goal?.name ?? "无");
      }
      const at = await waitState(ctx, b.train_id, (s) => s.state === "wait_station" && s.station === "甲", 120, 10);
      let waited = 0;
      if (at) { while (waited < 10 * 60) { await ctx.ticks(10); waited += 10; const s = await status(ctx, b.train_id); if (!(s.state === "wait_station" && s.station === "甲")) break; } }
      results[round] = { at: !at ? "没到" : Math.abs(at.x - farStop.x) < 8 ? "远站" : "近站", waitedTicks: waited, goalBefore, goalAfter };
      await ctx.lua(STOP_MODE, { ...nearStop, mode: "normal" });
      if (!(await toYi())) return { verdict: "inconclusive", summary: `${round} 之后列车没回到乙站`, measured: results };
    }
    const c = results["出发前停用 (对照)"], r1 = results["途中电路停用"], r2 = results["途中上限改 0"];
    const stayed = (r: typeof r1) => r.at === "近站" && r.waitedTicks >= 170;
    const ok = c.at === "远站" && stayed(r1) && stayed(r2);
    const desc = (k: string, r: typeof r1) => `${k} → 到${r.at}${r.at !== "没到" ? `、停了 ${(r.waitedTicks / 60).toFixed(1)} 秒` : ""}${r.goalAfter ? ` (停用后要去的站: ${r.goalAfter})` : ""}`;
    return {
      verdict: ok ? "verified" : c.at === "远站" && (r1.at === "远站" || r2.at === "远站") ? "refuted" : "inconclusive",
      summary: Object.entries(results).map(([k, v]) => desc(k, v)).join("; "),
      measured: results,
    };
  },
};
