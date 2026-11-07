// 外面没有游戏事件, 靠两遍扫描比差异合成 (game/memory/live.py EventWatch); 真游戏上跑的是游戏外模组宿主的沙盘测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pythonExe } from "../game/memory/read.ts";

const types = { "iron-chest": "container", "stone-furnace": "furnace", "iron-chest-remnants": "corpse", "small-biter": "unit", character: "character" };
const chest = (addr: number, x: number, extra: Record<string, unknown> = {}) => ({ addr, name: "iron-chest", x, y: 0, unit: addr, force: 1, d: { health: 200 }, ...extra });
function run(scans: unknown[][], t: (x: string) => void): { kind: string; row: { addr: number; name: string }; amount?: number }[][] | null {
  try {
    return JSON.parse(execFileSync(pythonExe(), ["-I", "game/memory/live.py", "--selftest-events"], { input: JSON.stringify({ scans, types }), encoding: "utf8", windowsHide: true }));
  } catch (e) { t(`没有 python: ${(e as Error).message.slice(0, 80)}`); return null; }
}

test("第一遍只记底; 新出现的玩家建筑算建造", (t) => {
  const r = run([[chest(1, 0)], [chest(1, 0), chest(2, 4)]], (m) => t.skip(m));
  if (!r) return;
  assert.deepEqual(r[0], []);
  assert.deepEqual(r[1].map((e) => [e.kind, e.row.addr]), [["built", 2]]);
});

test("虫子生成、角色重生不算建造 (一轮 20 条里 16 条是虫子)", (t) => {
  const biter = { addr: 9, name: "small-biter", x: 1, y: 1, unit: 9, force: 2, d: { health: 15 } };
  const body = { addr: 8, name: "character", x: 2, y: 2, unit: 8, force: 1, d: { health: 250 } };
  const r = run([[chest(1, 0)], [chest(1, 0), biter, body]], (m) => t.skip(m));
  if (!r) return;
  assert.deepEqual(r[1], []);
});

test("血变少算受损, 带差值; 变多不算", (t) => {
  const r = run([[chest(1, 0), chest(2, 4, { d: { health: 100 } })], [chest(1, 0, { d: { health: 150 } }), chest(2, 4, { d: { health: 120 } })]], (m) => t.skip(m));
  if (!r) return;
  assert.deepEqual(r[1].map((e) => [e.kind, e.row.addr, e.amount]), [["damaged", 1, 50]]);
});

test("没了: 原地留残骸算死, 不留算拆; 敌方的没了都算死", (t) => {
  const biter = { addr: 9, name: "small-biter", x: 1, y: 1, unit: 9, force: 2, d: { health: 15 } };
  const remnant = { addr: 20, name: "iron-chest-remnants", x: 4, y: 0 };
  const r = run([[chest(1, 0), chest(2, 4), biter], [remnant]], (m) => t.skip(m));
  if (!r) return;
  assert.deepEqual(r[1].map((e) => [e.kind, e.row.addr]).sort(), [["died", 2], ["died", 9], ["mined", 1]]);
});

test("同一个地址换了编号: 旧的没了, 新的建了", (t) => {
  const r = run([[chest(1, 0)], [{ ...chest(1, 0), unit: 77 }]], (m) => t.skip(m));
  if (!r) return;
  assert.deepEqual(r[1].map((e) => e.kind).sort(), ["built", "mined"]);
});
