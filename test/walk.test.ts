// 走路在有网络延迟时不能读半路的位置 (2026-11-06 注入客户端的程序 存档副本: 8 格走了 6 段重算 1 次, 读到 88.46 报到了, 其实还在往回走, 停在 84.75)。
// 假世界和真的一样: 按键过了 latency tick 才落到游戏状态, 读到的是游戏状态; input 要等时间线走完才回。
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPath, walkTo } from "../commands/walk.ts";
import { REPRESS_TICKS } from "../commands/timeline.ts";
import type { Call } from "../commands/query.ts";
import type { Controls } from "../commands/controls.ts";

const SPEED = 0.15, TICK_MS = 1000 / 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const controls = { key: (id: string) => id } as unknown as Controls;
const DIR: Record<string, [number, number]> = { "move-right": [1, 0], "move-left": [-1, 0], "move-up": [0, -1], "move-down": [0, 1] };
type Box = { left_top: { x: number; y: number }; right_bottom: { x: number; y: number } };

function world(start: { x: number; y: number }, latency: number, opts: { stuck?: boolean; walls?: Box[]; belt?: { x0: number; x1: number; y0: number; y1: number; vy: number }; wedged?: boolean } = {}) {
  const t0 = Date.now();
  const tick = () => Math.floor((Date.now() - t0) / TICK_MS);
  const held: { key: string; from: number; to: number }[] = [];
  let inputs = 0;
  /** 第 t tick 的位置: 从头一 tick 一 tick 算 (斜走两个键, 速度不变) */
  const at = (t = tick()) => {
    let { x, y } = start;
    if (opts.stuck) return { x, y };
    let wedged = !!opts.wedged;
    for (let n = 0; n <= t; n++) {
      let dx = 0, dy = 0;
      for (const h of held) if (n >= h.from && n <= h.to) { dx += DIR[h.key][0]; dy += DIR[h.key][1]; }
      if (wedged && dx && dy) wedged = false; // 夹角: 只有斜着才出得来
      const len = Math.hypot(dx, dy);
      if (len && !wedged) { x += (dx / len) * SPEED; y += (dy / len) * SPEED; }
      const b = opts.belt;
      if (b && !wedged && x >= b.x0 && x <= b.x1 && y >= b.y0 && y < b.y1) y = Math.min(b.y1, y + b.vy);
    }
    return { x, y };
  };
  const call: Call = async (name, args) => {
    if (name === "input") {
      inputs++;
      const now = tick();
      let last = 0;
      for (const e of (args as { timeline: { key: string; tick: string }[] }).timeline) {
        const [a, b = a] = e.tick.split("-").map(Number);
        held.push({ key: e.key, from: now + latency + a, to: now + latency + b });
        last = Math.max(last, b);
      }
      await sleep((last + 1) * TICK_MS);
      return { ok: true, data: {} };
    }
    const kind = (args as { selection: { kind: string } }).selection.kind;
    if (kind === "player") return { ok: true, data: { tick: tick(), player: { position: at() }, objects: [{ attributes: {} }] } };
    if (kind === "entities") return { ok: true, data: { objects: (opts.walls ?? []).map((b) => ({ attributes: { type: "wall", bounding_box: b } })) } };
    return { ok: true, data: { objects: [] } };
  };
  return { call, at, inputs: () => inputs };
}

test("有 32 tick 延迟: 走 8 格不多走不折返, 报的位置就是停下的位置", async () => {
  const w = world({ x: 80.5, y: 40.5 }, 32);
  const r = await walkTo(w.call, controls, { x: 88.5, y: 40.5 }, { tolerance: 1 });
  assert.equal(r.arrived, true);
  await sleep(800); // 所有按键都落地了
  const end = w.at();
  assert.ok(Math.hypot(end.x - 88.5, end.y - 40.5) <= 1, `停在 ${end.x},${end.y}`);
  assert.ok(Math.hypot(end.x - r.at.x, end.y - r.at.y) < 0.05, `报 ${r.at.x}, 实际停在 ${end.x}`);
  assert.equal(r.replans, 0, `重算了 ${r.replans} 次, 走了 ${r.segments} 段`);
});

test("绕墙: 一路拐弯连成一条按键线, 中途不停, 不重算", async () => {
  // 一堵竖墙挡在正中间, 要拐几次才过得去
  const w = world({ x: 0.5, y: 0.5 }, 32, { walls: [{ left_top: { x: 6, y: -8 }, right_bottom: { x: 7, y: 8 } }] });
  const r = await walkTo(w.call, controls, { x: 12.5, y: 0.5 }, { tolerance: 1 });
  assert.equal(r.arrived, true, JSON.stringify(r));
  assert.equal(r.replans, 0, `重算了 ${r.replans} 次`);
  assert.ok(r.segments >= 2, `应该有拐弯, 只有 ${r.segments} 段`);
  assert.equal(w.inputs(), 1, `发了 ${w.inputs()} 条按键线`);
  await sleep(800);
  const end = w.at();
  assert.ok(Math.hypot(end.x - 12.5, end.y - 0.5) <= 1, `停在 ${end.x},${end.y}`);
});

test("目标在机器堆里: 那一格走不到, 走到够得着的空位就算到", async () => {
  // 目标四周 7×7 全被占, 够得着 6 格 (within 4.5 + 容差 1): 没有 within 算不出路
  const wall = { left_top: { x: 16, y: -3 }, right_bottom: { x: 23, y: 4 } };
  const a = world({ x: 0.5, y: 0.5 }, 32, { walls: [wall] });
  const no = await walkTo(a.call, controls, { x: 19.5, y: 0.5 }, { tolerance: 1, maxReplans: 0 });
  assert.equal(no.arrived, false);
  assert.match(no.reason ?? "", /算不出路/);
  const r = await walkTo(a.call, controls, { x: 19.5, y: 0.5 }, { tolerance: 1, within: 4.5 });
  assert.equal(r.arrived, true, JSON.stringify(r));
  assert.ok(Math.hypot(r.at.x - 19.5, r.at.y - 0.5) <= 5.5, `停在 ${r.at.x},${r.at.y}`);
  assert.ok(r.at.x < 16, `进了墙: ${r.at.x}`);
});

test("够得着的范围内全被占: 如实报走不到, 不算到了", async () => {
  const a = world({ x: 0.5, y: 0.5 }, 0, { walls: [{ left_top: { x: 16, y: -3 }, right_bottom: { x: 23, y: 4 } }] });
  const r = await walkTo(a.call, controls, { x: 19.5, y: 0.5 }, { tolerance: 1, within: 3.5, maxReplans: 0 });
  assert.equal(r.arrived, false);
  assert.match(r.reason ?? "", /够得着/);
});

test("站在两台机器中间 0.6 格的缝里: 整格算不出路, 细化到半格走得出来", async () => {
  // 真服 (2026-11-06): y 198.7~199.3 的缝, 中线在整数 199 上
  const top = { left_top: { x: 100, y: 196.3 }, right_bottom: { x: 110.7, y: 198.7 } }, bottom = { left_top: { x: 100, y: 199.3 }, right_bottom: { x: 110.7, y: 201.7 } };
  const w = world({ x: 105, y: 199 }, 0, { walls: [top, bottom] });
  const r = await walkTo(w.call, controls, { x: 114.5, y: 199.5 }, { tolerance: 1 });
  assert.equal(r.arrived, true, JSON.stringify(r));
  assert.ok(r.at.x > 113, `停在 ${r.at.x},${r.at.y}`);
});

test("要绕很远: 12 格内没路就扩大范围", async () => {
  // 一堵 50 格长的墙, 只能从两头绕
  const w = world({ x: 0.5, y: 0.5 }, 0, { walls: [{ left_top: { x: 5, y: -25 }, right_bottom: { x: 6, y: 25 } }] });
  const r = await walkTo(w.call, controls, { x: 10.5, y: 0.5 }, { tolerance: 1 });
  assert.equal(r.arrived, true, JSON.stringify(r));
  assert.ok(r.path > 30, `路才 ${r.path} 格`);
});

test("铁轨、地下管道、物流机器人不挡路 (2.1.24 运行时真值), 机器挡", async () => {
  const rows = (type: string) => ({ objects: Array.from({ length: 41 }, (_, i) => ({ attributes: { type, bounding_box: { left_top: { x: 5, y: i - 20 }, right_bottom: { x: 6, y: i - 19 } } } })) });
  const run = async (type: string) => {
    const w = world({ x: 0.5, y: 0.5 }, 0);
    const call: Call = async (name, args) => ((args as { selection?: { kind?: string } }).selection?.kind === "entities" ? { ok: true, data: rows(type) } : w.call(name, args));
    return walkTo(call, controls, { x: 8.5, y: 0.5 }, { tolerance: 1, maxReplans: 0, margin: 12 }); // 固定范围: 不然会扩大范围绕过这堵墙
  };
  for (const t of ["straight-rail", "pipe-to-ground", "logistic-robot"]) assert.equal((await run(t)).arrived, true, t);
  assert.equal((await run("assembling-machine")).arrived, false);
});

test("时间到: 走完手上这一批就停, 回 timedOut 和现在的位置, 不再发按键", async () => {
  const w = world({ x: 0.5, y: 0.5 }, 32);
  const r = await walkTo(w.call, controls, { x: 90.5, y: 0.5 }, { tolerance: 1, deadline: Date.now() + 100 });
  assert.equal(r.arrived, false);
  assert.equal(r.timedOut, true);
  assert.equal(w.inputs(), 1);
  assert.ok(r.at.x > 60 && r.at.x < 75, `一批约 67 格, 到了 ${r.at.x}`);
});

test("逆着传送带走: 按键走到了, 不等带子把人运回去 (2026-11-07 朋友存档副本: 走到 y 210 又被运回 217.6, 重算 5 次全这样)", async () => {
  const w = world({ x: 0.5, y: 22.5 }, 32, { belt: { x0: 0, x1: 1, y0: 0, y1: 23, vy: 0.03125 } });
  const r = await walkTo(w.call, controls, { x: 0.5, y: 4.5 }, { tolerance: 1 });
  assert.equal(r.arrived, true, JSON.stringify(r));
  assert.ok(r.at.y < 7.1, `报到了 ${r.at.y}`); // 带子上容差放宽到 2.5 格
  assert.ok(r.replans <= 3, `重算了 ${r.replans} 次`);
});

test("重算不算失败, 没进展才算: 带子推得一路对不上也走得到", async () => {
  // 按键走 20 格, 带子反推 20%: 每批都和算的差超过 1.5 格, 原来 5 次就放弃; 这段路一直在靠近
  const w = world({ x: 0.5, y: 80.5 }, 32, { belt: { x0: 0, x1: 1, y0: 0, y1: 81, vy: 0.03125 } });
  const r = await walkTo(w.call, controls, { x: 0.5, y: 4.5 }, { tolerance: 1, maxReplans: 0 });
  assert.equal(r.arrived, true, JSON.stringify(r));
});

test("楔在夹角里: 单按一个方向不动, 斜着推出来再走", async () => {
  const w = world({ x: 0.5, y: 0.5 }, 0, { wedged: true });
  const r = await walkTo(w.call, controls, { x: 8.5, y: 0.5 }, { tolerance: 1 });
  assert.equal(r.arrived, true, JSON.stringify(r));
});

test("传送带: 能绕就不踩, 够得着就不停在上面 (2026-11-07: 报到了, 回复之后接着被运走, 读到时差 5 格)", () => {
  const free = () => false;
  // 路中间一小段带子: 绕一点比踩过去便宜 (代价只给一点, 绕远了不划算)
  const patch = (x: number, y: number) => x >= 3 && x <= 6 && y === 0;
  const around = planPath({ x: 0.5, y: 0.5 }, { x: 9.5, y: 0.5 }, free, 60_000, 0, patch)!;
  assert.ok(around.every((p) => !patch(Math.floor(p.x), Math.floor(p.y))), JSON.stringify(around));
  assert.ok(planPath({ x: 0.5, y: 0.5 }, { x: 9.5, y: 0.5 }, free)!.some((p) => patch(Math.floor(p.x), Math.floor(p.y))), "不给 belt 就是直线");
  // 目标在一大片带子中间: 停在够得着的空地, 不停在带子上
  const wide = (x: number, y: number) => x >= 3 && x <= 8 && y >= -20 && y <= 20;
  const stop = planPath({ x: 0.5, y: 0.5 }, { x: 5.5, y: 0.5 }, free, 60_000, 4, wide)!;
  const end = stop.at(-1)!;
  assert.ok(!wide(Math.floor(end.x), Math.floor(end.y)) && Math.hypot(end.x - 5.5, end.y - 0.5) <= 4, JSON.stringify(end));
  // 够得着的全是带子: 这条路算不出来, 由调用方退回去
  assert.equal(planPath({ x: 0.5, y: 0.5 }, { x: 5.5, y: 0.5 }, free, 60_000, 1, wide), null);
});

test("角色掉进小口袋: 规划器算不出路也要推出来, 不报被围住 (2026-11-07 棋盘格里 0.1 格宽的缝)", async () => {
  // 脚下一圈全是墙 (假世界的物理不挡人, 推一下就出去了; 真的挡不挡看沙盘动作测试)
  const ring = [{ left_top: { x: -1, y: -1 }, right_bottom: { x: 2, y: 0 } }, { left_top: { x: -1, y: 1 }, right_bottom: { x: 2, y: 2 } }, { left_top: { x: -1, y: 0 }, right_bottom: { x: 0, y: 1 } }, { left_top: { x: 1, y: 0 }, right_bottom: { x: 2, y: 1 } }];
  const w = world({ x: 0.5, y: 0.5 }, 0, { walls: ring });
  const r = await walkTo(w.call, controls, { x: 10.5, y: 0.5 }, { tolerance: 1 });
  assert.equal(r.arrived, true, JSON.stringify(r));
});

test("目标被围住但角色在开阔地: 不乱推, 如实报算不出路", async () => {
  const box = [{ left_top: { x: 8, y: -2 }, right_bottom: { x: 13, y: 3 } }];
  const w = world({ x: 0.5, y: 0.5 }, 0, { walls: box });
  const r = await walkTo(w.call, controls, { x: 10.5, y: 0.5 }, { tolerance: 0.5 });
  assert.equal(r.arrived, false);
  assert.match(r.reason ?? "", /算不出路/);
  assert.equal(w.inputs(), 0, `按了 ${w.inputs()} 次键`);
});

test("够得着的范围全是带子: 退回去站在带子上, 不报走不到", async () => {
  const w = world({ x: 0.5, y: 0.5 }, 0);
  const rows = { objects: [{ attributes: { type: "transport-belt", bounding_box: { left_top: { x: 3, y: -20 }, right_bottom: { x: 9, y: 20 } } } }] };
  const call: Call = async (name, args) => ((args as { selection?: { kind?: string } }).selection?.kind === "entities" ? { ok: true, data: rows } : w.call(name, args));
  const r = await walkTo(call, controls, { x: 5.5, y: 0.5 }, { tolerance: 0.2, within: 1, margin: 12 });
  assert.equal(r.arrived, true, JSON.stringify(r));
});

test("走路的键中途一直重按, 走得和以前一样远: 切窗口松开的键很快接上", async () => {
  const w = world({ x: 0.5, y: 0.5 }, 0);
  const lines: { key: string; tick: string }[][] = [];
  const call: Call = async (name, args) => {
    if (name === "input") lines.push((args as { timeline: { key: string; tick: string }[] }).timeline);
    return w.call(name, args);
  };
  const r = await walkTo(call, controls, { x: 40.5, y: 0.5 }, { tolerance: 1 });
  assert.equal(r.arrived, true);
  assert.ok(Math.hypot(w.at().x - 40.5, w.at().y - 0.5) <= 1, `停在 ${w.at().x},${w.at().y}`);
  const holds = lines[0].map((e) => e.tick.split("-").map(Number));
  assert.ok(holds.length > 1, "长路拆成了多段");
  assert.ok(holds.every((h) => (h[1] ?? h[0]) - h[0] < REPRESS_TICKS), "每段不超过重按间隔");
  assert.ok(lines[0].length <= 256, "工具一次最多 256 条");
  for (let i = 1; i < holds.length; i++) if (lines[0][i].key === lines[0][i - 1].key) assert.equal(holds[i][0], (holds[i - 1][1] ?? holds[i - 1][0]) + 1, "首尾相接");
});

test("真被挡住: 不动就报走不到, 不算到了", async () => {
  const w = world({ x: 80.5, y: 40.5 }, 32, { stuck: true });
  const r = await walkTo(w.call, controls, { x: 84.5, y: 40.5 }, { tolerance: 1, maxReplans: 1 });
  assert.equal(r.arrived, false);
});
