// 蓝图静态检查器的单元测试 (不开游戏, 但要本机导出的原型数据): 好样本 0 错误, 坏样本必须抓住。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { encodeBlueprint, decodeBlueprint, Dir } from "../src/lab/blueprint.ts";
import { flatten, analyze } from "../src/blueprint/inspect.ts";
import { loadRules, defaultDumpPath } from "../src/blueprint/rules.ts";
import { checkBlueprint, type Finding } from "../src/blueprint/check.ts";
import { loadRailGeometry } from "../src/blueprint/rail-geometry.ts";

const have = fs.existsSync(defaultDumpPath());
const rules = have ? loadRules() : null;
const geom = have ? loadRailGeometry() : null; // 没有就跳过铁轨测试 (npm run lab:dump 生成)
const zh = (n: string) => n;

type E = { name: string; x: number; y: number; direction?: number; [k: string]: unknown };
function check(list: E[], wires?: number[][]): Finding[] {
  const entities = list.map((e, i) => ({ entity_number: i + 1, name: e.name, position: { x: e.x, y: e.y }, ...(e.direction !== undefined ? { direction: e.direction } : {}), ...Object.fromEntries(Object.entries(e).filter(([k]) => !["name", "x", "y", "direction"].includes(k))) }));
  const s = encodeBlueprint({ blueprint: { item: "blueprint", entities, ...(wires ? { wires } : {}) } });
  const [b] = flatten(decodeBlueprint(s));
  return checkBlueprint(analyze(b.label, b.path, b.bp).entities, b.bp.wires, rules!, zh, geom);
}
const kinds = (f: Finding[], level?: Finding["level"]) => f.filter((x) => !level || x.level === level).map((x) => x.kind);

test("供电: 机械臂离中型电线杆 4 格 → 没覆盖; 3 格 → 覆盖", { skip: !have }, () => {
  const far = check([{ name: "medium-electric-pole", x: 0.5, y: 0.5 }, { name: "inserter", x: 4.5, y: 0.5, direction: Dir.north }]);
  assert.ok(kinds(far, "error").includes("no-power-coverage"));
  const near = check([{ name: "medium-electric-pole", x: 0.5, y: 0.5 }, { name: "inserter", x: 3.5, y: 0.5, direction: Dir.north }]);
  assert.ok(!kinds(near, "error").includes("no-power-coverage"));
});

test("电网: 两根中型电线杆相距 10 格 (超过 9) → 两张网", { skip: !have }, () => {
  const f = check([{ name: "medium-electric-pole", x: 0.5, y: 0.5 }, { name: "medium-electric-pole", x: 10.5, y: 0.5 }]);
  assert.ok(kinds(f).includes("power-components"));
  const ok = check([{ name: "medium-electric-pole", x: 0.5, y: 0.5 }, { name: "medium-electric-pole", x: 9.5, y: 0.5 }]);
  assert.ok(!kinds(ok).includes("power-components"));
});

test("地下传送带: 入口和出口隔 6 格 (基础带最多 5) → 报错; 隔 5 格 → 过", { skip: !have }, () => {
  const bad = check([{ name: "underground-belt", x: 0.5, y: 0.5, direction: Dir.east, type: "input" }, { name: "underground-belt", x: 6.5, y: 0.5, direction: Dir.east, type: "output" }]);
  assert.ok(kinds(bad, "error").includes("underground-unpaired"));
  const ok = check([{ name: "underground-belt", x: 0.5, y: 0.5, direction: Dir.east, type: "input" }, { name: "underground-belt", x: 5.5, y: 0.5, direction: Dir.east, type: "output" }]);
  assert.ok(!kinds(ok, "error").includes("underground-unpaired"));
});

test("传送带迎头相对 → 报错", { skip: !have }, () => {
  const f = check([{ name: "transport-belt", x: 0.5, y: 0.5, direction: Dir.east }, { name: "transport-belt", x: 1.5, y: 0.5, direction: Dir.west }]);
  assert.ok(kinds(f, "error").includes("belt-head-on"));
});

test("地下管道: 另一头隔 11 格 (最多 10) → 警告 (单根当封口是正常用法); 隔 10 格 → 过", { skip: !have }, () => {
  // 朝北的地下管道, 地下口在南边: 另一头在南边 N 格、朝南
  const bad = check([{ name: "pipe-to-ground", x: 0.5, y: 0.5, direction: Dir.north }, { name: "pipe-to-ground", x: 0.5, y: 11.5, direction: Dir.south }]);
  assert.ok(kinds(bad, "warn").includes("pipe-underground-unpaired"));
  const ok = check([{ name: "pipe-to-ground", x: 0.5, y: 0.5, direction: Dir.north }, { name: "pipe-to-ground", x: 0.5, y: 10.5, direction: Dir.south }]);
  assert.ok(!kinds(ok).includes("pipe-underground-unpaired"));
});

test("机械臂对着空地 → 警告; 两头都有箱子 → 不警告", { skip: !have }, () => {
  const bad = check([{ name: "medium-electric-pole", x: 2.5, y: 0.5 }, { name: "inserter", x: 0.5, y: 0.5, direction: Dir.north }]);
  assert.ok(kinds(bad, "warn").includes("inserter-empty-target"));
  const ok = check([{ name: "medium-electric-pole", x: 2.5, y: 0.5 }, { name: "iron-chest", x: 0.5, y: -0.5 }, { name: "inserter", x: 0.5, y: 0.5, direction: Dir.north }, { name: "iron-chest", x: 0.5, y: 1.5 }]);
  assert.ok(!kinds(ok, "warn").includes("inserter-empty-target"));
});

test("车站: 铁轨要在车站朝向的左手边 2 格", { skip: !have }, () => {
  // 东行 (朝东) 的车站在轨道南侧: 轨道 y=1, 车站 (x, 3)
  const ok = check([{ name: "straight-rail", x: 41, y: 1, direction: Dir.east }, { name: "train-stop", x: 41, y: 3, direction: Dir.east, station: "甲" }]);
  assert.ok(!kinds(ok, "error").includes("train-stop-no-rail"));
  const bad = check([{ name: "straight-rail", x: 41, y: 1, direction: Dir.east }, { name: "train-stop", x: 41, y: 3, direction: Dir.west, station: "甲" }]);
  assert.ok(kinds(bad, "error").includes("train-stop-no-rail"));
});

test("重叠: 两台组装机挨太近 → 报错; 抽取泵 (不对称碰撞盒) 和它正南的管道 → 不报", { skip: !have }, () => {
  const bad = check([{ name: "assembling-machine-2", x: 0.5, y: 0.5 }, { name: "assembling-machine-2", x: 2.5, y: 0.5 }]);
  assert.ok(kinds(bad, "error").includes("overlap"));
  const ok = check([{ name: "offshore-pump", x: 64.5, y: 31.5, direction: Dir.north }, { name: "pipe-to-ground", x: 64.5, y: 32.5, direction: Dir.north }]);
  assert.ok(!kinds(ok, "error").includes("overlap"));
});

test("流体口: 化工厂做硫酸 (用流体) 没接管 → 警告; 组装机做齿轮 (不用流体) → 不提", { skip: !have }, () => {
  const chem = check([{ name: "medium-electric-pole", x: 3.5, y: 0.5 }, { name: "chemical-plant", x: 0.5, y: 0.5, direction: Dir.north, recipe: "sulfuric-acid" }]);
  assert.ok(kinds(chem, "warn").includes("fluid-open"));
  const gear = check([{ name: "medium-electric-pole", x: 3.5, y: 0.5 }, { name: "assembling-machine-2", x: 0.5, y: 0.5, recipe: "iron-gear-wheel" }]);
  assert.ok(!kinds(gear).includes("fluid-open"));
});

// ---- 传送带连续性 (check-belts.ts)
test("传送带顶着分流器的侧面 → 警告; 从背后进分流器 → 不警告", { skip: !have }, () => {
  // 朝东的分流器在 (1, 1.5) 占 (0.5,1.5)(0.5,2.5)… 实际: 中心 x=1.5? 分流器朝东时横跨 y 方向 2 格, 中心 (x.5, y.0)
  const side = check([{ name: "splitter", x: 1.5, y: 2, direction: Dir.east }, { name: "transport-belt", x: 1.5, y: 0.5, direction: Dir.south }]);
  assert.ok(kinds(side, "warn").includes("belt-blocked"));
  const back = check([{ name: "splitter", x: 1.5, y: 2, direction: Dir.east }, { name: "transport-belt", x: 0.5, y: 1.5, direction: Dir.east }]);
  assert.ok(!kinds(back).includes("belt-blocked"));
});

test("侧向汇入 vs 弯道: 有上游的直带被侧向汇入算侧汇; 没上游、只有一侧来的是弯道", { skip: !have }, () => {
  const sideLoad = check([
    { name: "transport-belt", x: 0.5, y: 0.5, direction: Dir.east }, { name: "transport-belt", x: 1.5, y: 0.5, direction: Dir.east }, { name: "transport-belt", x: 1.5, y: 1.5, direction: Dir.north },
  ]);
  assert.ok(sideLoad.some((f) => f.kind === "belt-side-load" && f.msg.startsWith("侧向汇入 1 处")));
  assert.ok(!kinds(sideLoad).includes("belt-curve"));
  const curve = check([{ name: "transport-belt", x: 1.5, y: 0.5, direction: Dir.east }, { name: "transport-belt", x: 1.5, y: 1.5, direction: Dir.north }]);
  assert.ok(curve.some((f) => f.kind === "belt-curve" && f.msg.startsWith("弯道 1 处")));
  assert.ok(!kinds(curve).includes("belt-side-load"));
});

test("整段传送带没有来源 → 警告; 有机械臂往上放货 → 不警告", { skip: !have }, () => {
  const belts: E[] = [0, 1, 2].map((i) => ({ name: "transport-belt", x: i + 0.5, y: 0.5, direction: Dir.east }));
  const bare = check(belts);
  assert.ok(kinds(bare, "warn").includes("belt-no-source"));
  assert.ok(kinds(bare, "info").includes("belt-no-sink"));
  // 朝北的机械臂放货格在南边 (0.5, 0.7) → 带子 (0.5, 0.5); 取货格北边放个箱子
  const fed = check([...belts, { name: "medium-electric-pole", x: 2.5, y: -1.5 }, { name: "iron-chest", x: 0.5, y: -1.5 }, { name: "inserter", x: 0.5, y: -0.5, direction: Dir.north }]);
  assert.ok(!kinds(fed).includes("belt-no-source"));
});

// ---- 管网 (check-fluids.ts)
test("混管: 锅炉的水口用管子接到蒸汽机 → 错误; 正常的锅炉→蒸汽机 → 不报", { skip: !have }, () => {
  // 锅炉 3×2 朝北在 (1.5, 1): 水口在 (0.5,1.5) 朝西、(2.5,1.5) 朝东, 蒸汽口 (1.5,0.5) 朝北; 蒸汽机 3×5 朝北在 (1.5,-2.5): 口在 (1.5,-0.5) 朝南、(1.5,-4.5) 朝北
  const base: E[] = [{ name: "boiler", x: 1.5, y: 1, direction: Dir.north }, { name: "steam-engine", x: 1.5, y: -2.5, direction: Dir.north }];
  const ok = check(base);
  assert.ok(!kinds(ok).includes("fluid-mixed"));
  assert.ok(ok.find((f) => f.kind === "fluid-networks")?.msg.startsWith("管网 2 张"));
  const pipes: E[] = [];
  for (let y = 1.5; y >= -5.5; y--) pipes.push({ name: "pipe", x: -0.5, y });
  pipes.push({ name: "pipe", x: 0.5, y: -5.5 }, { name: "pipe", x: 1.5, y: -5.5 });
  const mixed = check([...base, ...pipes]);
  assert.ok(mixed.some((f) => f.kind === "fluid-mixed" && f.msg.includes("water") && f.msg.includes("steam")));
});

test("管网没来源也没留口 → 警告; 留了口 → 提示 (外部供液)", { skip: !have }, () => {
  // 化工厂做硫酸 (只用水口 1 个) 的水口接一根地下管道当封口: 没来源、没留口
  const sealed = check([{ name: "medium-electric-pole", x: 3.5, y: 0.5 }, { name: "chemical-plant", x: 0.5, y: 0.5, direction: Dir.north, recipe: "sulfuric-acid" }, { name: "pipe-to-ground", x: -0.5, y: -1.5, direction: Dir.south }]);
  assert.ok(kinds(sealed, "warn").includes("fluid-no-source"));
  const open = check([{ name: "medium-electric-pole", x: 3.5, y: 0.5 }, { name: "chemical-plant", x: 0.5, y: 0.5, direction: Dir.north, recipe: "sulfuric-acid" }, { name: "pipe", x: -0.5, y: -1.5 }]);
  assert.ok(!kinds(open).includes("fluid-no-source"));
  assert.ok(kinds(open, "info").includes("fluid-external"));
});

// ---- 铁轨 (check-rails.ts; 几何来自引擎导出的 rail-geometry.json)
test("铁轨连通: 直轨 + 曲轨 a + 曲轨 b 首尾相接 → 一张网; 隔开的两段 → 两张网", { skip: !have || !geom }, () => {
  // 曲轨 a 朝北在 (1,0): 两端 (1,2)↓8 和 (0,-3)↗15; 直轨朝北在 (1,3): 两端 (1,2)↑0、(1,4)↓8; 曲轨 b 朝北在 (-1,-5): 两端 (0,-3)↘7、(-3,-7)↖14
  const joined = check([{ name: "curved-rail-a", x: 1, y: 0, direction: 0 }, { name: "straight-rail", x: 1, y: 3, direction: 0 }, { name: "curved-rail-b", x: -1, y: -5, direction: 0 }]);
  assert.ok(!kinds(joined).includes("rail-components"), JSON.stringify(joined));
  assert.ok(!kinds(joined).includes("rail-off-grid"));
  assert.ok(joined.some((f) => f.kind === "rail-dead-end" && f.msg.startsWith("铁轨尽头 2 处")));
  const split = check([{ name: "straight-rail", x: 1, y: 1, direction: 0 }, { name: "straight-rail", x: 1, y: 5, direction: 0 }]);
  assert.ok(kinds(split, "warn").includes("rail-components"));
  const offGrid = check([{ name: "straight-rail", x: 2, y: 1, direction: 0 }]);
  assert.ok(kinds(offGrid, "error").includes("rail-off-grid"));
});

test("信号: 东西直轨南侧的信号要朝西 (面朝东行的来车); 朝东 → 错误", { skip: !have || !geom }, () => {
  const rail: E = { name: "straight-rail", x: 41, y: 1, direction: Dir.east };
  const ok = check([rail, { name: "rail-signal", x: 41.5, y: 2.5, direction: Dir.west }]);
  assert.ok(!kinds(ok).includes("signal-misplaced"), JSON.stringify(ok));
  const bad = check([rail, { name: "rail-signal", x: 41.5, y: 2.5, direction: Dir.east }]);
  assert.ok(kinds(bad, "error").includes("signal-misplaced"));
  const far = check([rail, { name: "rail-signal", x: 41.5, y: 3.5, direction: Dir.west }]);
  assert.ok(kinds(far, "error").includes("signal-misplaced"));
});

test("覆盖: 物流箱离机器人指令平台 24 格 → 在网里; 27 格 → 不在", { skip: !have }, () => {
  const f = check([{ name: "roboport", x: 0, y: 0 }, { name: "requester-chest", x: 24.5, y: 0.5 }, { name: "requester-chest", x: -27.5, y: 0.5 }]);
  const w = f.filter((x) => x.kind === "logistic-chest-outside-network");
  assert.equal(w.length, 1);
  assert.equal(w[0].at?.x, -27.5);
});

test("覆盖: 两个机器人指令平台相距 40 (重叠)、50 (刚好相接) → 一张网; 52 → 两张网 (沙盘核实)", { skip: !have }, () => {
  const one = check([{ name: "roboport", x: 0, y: 0 }, { name: "roboport", x: 40, y: 0 }]);
  assert.ok(!kinds(one).includes("roboport-networks"));
  const two = check([{ name: "roboport", x: 0, y: 0 }, { name: "roboport", x: 60, y: 0 }]);
  assert.ok(kinds(two).includes("roboport-networks"));
  const touch = check([{ name: "roboport", x: 0, y: 0 }, { name: "roboport", x: 50, y: 0 }]);
  assert.ok(!kinds(touch).includes("roboport-networks"));
  const gap = check([{ name: "roboport", x: 0, y: 0 }, { name: "roboport", x: 52, y: 0 }]);
  assert.ok(kinds(gap).includes("roboport-networks"));
});

test("覆盖: 炮塔离机器人指令平台 54 格 → 能修; 57 格 → 报没机器人修", { skip: !have }, () => {
  const f = check([{ name: "roboport", x: 0, y: 0 }, { name: "gun-turret", x: 54, y: 0 }, { name: "gun-turret", x: -57, y: 0 }]);
  const w = f.filter((x) => x.kind === "turret-no-repair");
  assert.equal(w.length, 1);
  assert.equal(w[0].at?.x, -57);
});

test("覆盖: 墙离机枪炮塔 (射程 18) 15.5 格 → 护着 (墙外 2 格也在射程内); 16.5 格 → 报没炮塔护着", { skip: !have }, () => {
  const near = check([{ name: "gun-turret", x: 0, y: 0 }, { name: "stone-wall", x: 15.5, y: 0.5 }]);
  assert.ok(!kinds(near, "warn").includes("wall-no-turret"));
  const far = check([{ name: "gun-turret", x: 0, y: 0 }, { name: "stone-wall", x: 16.5, y: 0.5 }]);
  assert.ok(kinds(far, "warn").includes("wall-no-turret"));
});

test("覆盖: 机枪炮塔旁有机械臂往里放 → 不报; 没有 → 提示没人补弹", { skip: !have }, () => {
  // 机械臂朝北 = 从北边取、往南边放 (放货格在南边 1 格多): 炮塔 2×2 在它南边
  const fed = check([{ name: "gun-turret", x: 0, y: 2 }, { name: "inserter", x: 0.5, y: 0.5, direction: Dir.north }, { name: "iron-chest", x: 0.5, y: -0.5 }]);
  assert.ok(!kinds(fed).includes("turret-no-ammo-feed"));
  const bare = check([{ name: "gun-turret", x: 0, y: 2 }]);
  assert.ok(kinds(bare).includes("turret-no-ammo-feed"));
});

test("装卸机: 带子从背后进装货的装卸机 → 不报顶错面; 顶着卸货的 → 报", { skip: !have }, () => {
  const ok = check([{ name: "transport-belt", x: 0.5, y: 0.5, direction: Dir.east }, { name: "loader", x: 2, y: 0.5, direction: Dir.east, type: "input" }, { name: "iron-chest", x: 3.5, y: 0.5 }]);
  assert.ok(!kinds(ok).includes("belt-blocked"));
  const bad = check([{ name: "transport-belt", x: 0.5, y: 0.5, direction: Dir.east }, { name: "loader", x: 2, y: 0.5, direction: Dir.east, type: "output" }, { name: "iron-chest", x: 3.5, y: 0.5 }]);
  assert.ok(kinds(bad).includes("belt-blocked"));
});

test("区段: 普通信号后面只有 20 格、出口也有信号 → 放不下 4 节列车 (28 格) 报警告; 40 格不报", { skip: !have || !geom }, () => {
  const line = Array.from({ length: 50 }, (_, i) => ({ name: "straight-rail", x: 1 + 2 * i, y: 1, direction: Dir.east }));
  // 北侧朝东的信号管西行的车 (rail-geometry 表: 东西直轨 (±0.5, -1.5, 朝向 4)); 信号 79.5 → 接头 x=80
  const sig = (x: number) => ({ name: "rail-signal", x, y: -0.5, direction: Dir.east });
  const short = check([...line, sig(79.5), sig(59.5), sig(19.5)]);
  assert.deepEqual(short.filter((f) => f.kind === "block-too-short").map((f) => f.at?.x), [79.5]); // 西行: 79.5 的信号保护它西边 [60,80] 那 20 格
  // 反方向: 南侧朝西的信号管东行的车, 同样三个接头 → 59.5 的信号保护它东边 [60,80]
  const sigE = (x: number) => ({ name: "rail-signal", x, y: 2.5, direction: Dir.west });
  const east = check([...line, sigE(79.5), sigE(59.5), sigE(19.5)]);
  assert.deepEqual(east.filter((f) => f.kind === "block-too-short").map((f) => f.at?.x), [59.5]);
  const long = check([...line, sig(79.5), sig(39.5)]);
  assert.ok(!kinds(long).includes("block-too-short"));
});
