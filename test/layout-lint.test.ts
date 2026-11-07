// 电线杆斜穿、地下管道没配上、锅炉没水 (src/play/layout-lint.ts) + 教训跨世界 (src/play/lessons.ts)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAYOUT_LUA, atKey, edgeKey, freshItems, layoutNote, normalizeLayout } from "../src/play/layout-lint.ts";
import { appendLearned, inferKeys, isGeneralLesson, learnedSeeds, loadSeeds, nameIndex, readLearned, type Seed } from "../src/play/lessons.ts";
import { parseFhRead } from "../src/play/control-lib.ts";
import { pickBlock, type Block } from "../src/play/plan-lib.ts";

test("读 Lua 回复: 空表是 {} 也不炸; 坏数据当没有", () => {
  const noLabs = { total: 0, working: 0, unit: 0, speed: 0, research: "", packs: [] };
  assert.deepEqual(normalizeLayout({ poles: 3, edges: 2, diagonal: {}, pipes: {}, dry: {} }), { poles: 3, edges: 2, diagonal: [], pipes: [], dry: [], stuck: [], labs: noLabs });
  assert.deepEqual(normalizeLayout("坏的"), { poles: 0, edges: 0, diagonal: [], pipes: [], dry: [], stuck: [], labs: noLabs });
  assert.equal(normalizeLayout({ diagonal: [{ x1: 1, y1: 2, x2: 5, y2: 7 }, { x1: "a" }] }).diagonal.length, 1);
});

test("只报新出现的; 修好的再出现还报", () => {
  const seen = new Set<string>();
  const a = { x1: 0, y1: 0, x2: 5, y2: 5 }, b = { x1: 9, y1: 9, x2: 14, y2: 14 };
  assert.deepEqual(freshItems([a], seen, edgeKey), [a]);
  assert.deepEqual(freshItems([a, b], seen, edgeKey), [b]);
  assert.deepEqual(freshItems([b], seen, edgeKey), []);
  assert.deepEqual(freshItems([a, b], seen, edgeKey), [a], "a 修好过, 又出现");
  assert.equal(atKey({ x: 1.5, y: 2.5 }), "1.5,2.5");
});

test("监工的话: 带坐标和要求; 没问题不说", () => {
  assert.equal(layoutNote([], [], []), null);
  const t = layoutNote([{ x1: 0, y1: 0, x2: 5, y2: 5 }], [{ x: 33.5, y: 48.5, joined: 0, total: 2 }], [{ x: 31.5, y: 46 }])!;
  assert.match(t, /\(0,0\)→\(5,5\)/);
  assert.match(t, /横平竖直/);
  assert.match(t, /33\.5,48\.5/);
  assert.match(t, /开口朝向/);
  assert.match(t, /锅炉没水/);
});

test("Lua 没有注释 (一行化后注释会吞掉后面)", () => {
  assert.ok(!LAYOUT_LUA.includes("--"));
});

const idx = nameIndex(new Map([["inserter", "电力机械臂"], ["pipe-to-ground", "地下管道"], ["pipe", "管道"], ["small-electric-pole", "小型电线杆"], ["transport-belt", "基础传送带"]]), ["build", "transfer"]);

test("大脑写俗名也认: 机械臂 / 水管 / 电线杆 (Grok 那条就这么丢的)", () => {
  assert.deepEqual(inferKeys("机械臂 direction 是抓取侧，向东送料设 west", idx), { item: "inserter" });
  assert.deepEqual(inferKeys("电线杆横平竖直，别压在 3x3 机器上", idx), { item: "small-electric-pole" });
  assert.deepEqual(inferKeys("地下水管要背对背", idx), { item: "pipe-to-ground" });
  assert.equal(inferKeys("思考时游戏继续走, 短想快做", idx), null);
});

test("带坐标和只对这局有用的不跨世界", () => {
  assert.ok(isGeneralLesson("机械臂 direction 是抓取侧"));
  assert.ok(!isGeneralLesson("煤箱 (63,-18) 也快见底"));
  assert.ok(!isGeneralLesson("铁矿在 x = -85 那边"));
  assert.ok(!isGeneralLesson("这班铁板不够"));
  assert.ok(!isGeneralLesson("iron-plate 永远缺: 场上的铁全在西边 90+ 格"));
  assert.ok(!isGeneralLesson("calc 工具报 TypeError, 坏了"), "工具的毛病修好就过期了");
});

// 第二版的"跨世界教训"和"种子文件"两个用例测的是第二版 lessons.ts 的规则 (lab-data/play/lessons-learned.jsonl、knowledge/lessons-seed.json); 新项目的教训库在 training/lessons/, 规则由 test/lessons.test.ts 核, 这两条不搬

test("界面 / 命令里能走只读的写法: call X、单个动作、--args 带引号; 别的写法走真的 ./fh", () => {
  assert.deepEqual(parseFhRead("call status"), { action: "status", args: {} });
  assert.deepEqual(parseFhRead("board"), { action: "board", args: {} });
  assert.deepEqual(parseFhRead(`call observe --args '{"radius":24}'`), { action: "observe", args: { radius: 24 } });
  assert.deepEqual(parseFhRead(`call observe --args {\\"radius\\":24}`), { action: "observe", args: { radius: 24 } });
  assert.equal(parseFhRead("board plan doing x"), null);
  assert.equal(parseFhRead("call build --args 不是json"), null);
  assert.equal(parseFhRead("sleep 5"), null);
});

test("化工厂排能被 ./plan 挑到, 同配方优先机器对得上的", () => {
  const block = (no: number, label: string): Block => ({ no, label, w: 11, h: 8, io: "", counts: {} });
  const zh = (id: string) => ({ "plastic-bar": "塑料", "chemical-plant": "化工厂", "processing-unit": "处理器", "assembling-machine-2": "组装机2型" } as Record<string, string>)[id] ?? id;
  const d = { kind: "assembler" as const, key: "plastic-bar", machine: "chemical-plant", need: 2, have: 0, add: 2 };
  const p = pickBlock(d, [block(1, "组装机排 铁齿轮 × 6 / 组装机2型"), block(2, "化工厂排 塑料 × 3 / 化工厂 / 石油气进管")], zh);
  assert.equal(p?.block.no, 2);
  assert.equal(pickBlock({ ...d, key: "processing-unit", machine: "assembling-machine-2" }, [block(3, "组装机排 处理器 × 3 / 组装机2型 / 硫酸进管")], zh)?.block.no, 3);
});
