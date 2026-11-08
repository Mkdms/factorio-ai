// 游戏外的放置检查 (game/offgame/placeable.lua = 假接口 can_place_entity 的替身): 真原型数据 + 手搭的地块 / 实体, 在 data/venv 的 lupa 里跑 (test/fixtures/placeable_check.py)。
// 要 data/venv (npm run offgame:setup) 和一份原型导出 (data/prototypes/*/data-raw-dump.json); 没有就跳过。不开游戏。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { venvPython, venvReady } from "../game/offgame/host.ts";
import { dataRoot } from "../game/sandbox/paths.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
function dumpFile(): string | null {
  const dir = path.join(dataRoot(), "prototypes");
  if (!fs.existsSync(dir)) return null;
  for (const d of fs.readdirSync(dir)) { const f = path.join(dir, d, "data-raw-dump.json"); if (fs.existsSync(f)) return f; }
  return null;
}

test("放置检查: 抽水机要脚下陆地 + 正面 3x2 水 (方向跟着转), 树 / 建筑 / 带子挡、鱼 / 矿 / 角色不挡, 水上放不了炉子, 地块没读到明说", { skip: !venvReady() ? "data/venv 没有 lupa (npm run offgame:setup)" : !dumpFile() ? "没有原型导出 (data/prototypes/*/data-raw-dump.json)" : false }, () => {
  const out = JSON.parse(execFileSync(venvPython(), ["-I", path.join(ROOT, "test", "fixtures", "placeable_check.py"), path.join(ROOT, "game", "offgame", "placeable.lua"), dumpFile()!], { encoding: "utf8", windowsHide: true, timeout: 120_000 })) as Record<string, { ok: boolean; why: string | null } | number[]>;
  const r = (k: string) => out[k] as { ok: boolean; why: string | null };
  for (const k of ["pump_north_ok", "pump_east_ok", "pump_south_ok", "pump_fish", "furnace_ok", "furnace_ore", "furnace_touching", "furnace_character", "drill_ok"]) assert.equal(r(k).ok, true, `${k}: ${r(k).why}`);
  for (const k of ["pump_one_row", "pump_on_water", "pump_east_wrong_dir", "pump_tree", "furnace_water", "furnace_neighbor", "furnace_belt", "furnace_unknown_tile"]) assert.equal(r(k).ok, false, `${k} 该放不下`);
  assert.match(r("pump_one_row").why!, /要 水/, "少第二排水: 说清哪格要水");
  assert.match(r("pump_on_water").why!, /要 陆地/);
  assert.match(r("pump_tree").why!, /tree-01 .* 挡着/);
  assert.match(r("furnace_water").why!, /脚下 \(9,9\) 是 water/);
  assert.match(r("furnace_neighbor").why!, /stone-furnace \(11,10\) 挡着/);
  assert.match(r("furnace_unknown_tile").why!, /没读到/);
  // 朝东的框: 抽水机 [[-0.6,-1.05],[0.6,0.3]] 在 (0.5,0.5) → 向东伸 1.05 到水上
  const bx = out.rot_box_east as number[];
  assert.deepEqual(bx.map((v) => Math.round(v * 100) / 100), [0.2, -0.1, 1.55, 1.1]);
});
