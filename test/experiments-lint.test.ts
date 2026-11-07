// 实验代码的规矩检查 (不开游戏): 新实验不许手摆电线杆 / 配电站 / 电力接口, 供电一律走框架的 ctx.power() / power_area / power_fix (按原型数据算覆盖)。
// 2026-11-01: 手摆杆子盖漏了五次, 框架能抓住但抓住不等于防住; 这条测试让"手摆"过不了 npm test。
// 老实验 (下面的清单) 是在这条规矩之前写的, 都过了供电检查, 暂时放行; 新改动不要往清单里加名字, 改成用框架的供电函数。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ALLOW_OLD = new Set(["beacons.ts", "belts.ts", "blueprint-snap.ts", "compare-modules.ts", "compare-trains.ts", "compare-walls.ts", "logistics.ts", "planets.ts", "poles.ts", "power.ts" /* 供电本身是实验对象 */]);
const POWER = /"(small|medium|big)-electric-pole"|"substation"|"electric-energy-interface"/;

// 记过的坑 (docs/lab.md), 实验代码里出现就不让过; 真要用时在那一行写注释 "lint-ok: 原因"
const PITFALLS: { re: RegExp; why: string }[] = [
  { re: /prototypes\.entity\[[^\]]+\]\.max_health/, why: "2.1 原型没有 max_health 属性, 用 get_max_health(quality) 或读刚建出来的实体 (lab.md #34)" },
  { re: /prototypes\.recipe\[[^\]]+\]\.category\b/, why: "2.1 配方原型是 categories (可以多类别), 没有 category (lab.md #34)" },
  { re: /\.neighbours\b/, why: "2.x 的 LuaEntity 没有 neighbours, 电线用 get_wire_connector / 传送带用 belt_neighbours (lab.md #34)" },
  { re: /\.fluidbox\b/, why: "2.1.24 的 LuaEntity 没有 fluidbox, 用 get_fluid_box_pipe_connections / lab.connections (lab.md #15)" },
  { re: /\.schedule\s*=\s*a\.schedule\b/, why: "时刻表表格式会悄悄丢掉中断, 中断走 get_schedule().set_interrupts() 并回读 (lab.md #29)" },
  { re: /type\s*[~=]=\s*"substation"/, why: "substation 是名字不是 type, 广域配电站的 type 是 electric-pole (lab.md #35)" },
  { re: /power_production\s*=\s*0/, why: "电力接口当负载默认先吃自己 10GJ 缓冲、不从电网取电; 要同时把 electric_buffer_size 设成 2 tick 的量, 或改用雷达 (lab.md #33)" },
  { re: /get_rail_end\([^)]*\)\.position/, why: "LuaRailEnd 没有 position, 用 .location.position (lab.md #22)" },
  { re: /\.insert_at_back\(/, why: "insert_at_back 只在队尾有空时成功, 连着塞多个只进 1 个, 用 insert_at(位置, 物品) (lab.md #38)" },
  { re: /invert\s*=\s*true/, why: "find_entities_filtered 的 invert 把所有条件一起取反 (连 force 也反), 类型排除用 Lua 表逐个跳过 (lab.md #49)" },
  { re: /\.products_finished\b/, why: "products_finished 把产能白送的也算一次; 算开工次数 / 原料消耗要按吃掉的原料或定量箱子 (lab.md #19)" },
];

test("实验代码里没有记过的 API 坑 (lab.md 里的教训变成检查)", () => {
  const dir = path.join(import.meta.dirname, "..", "experiments");
  const bad: string[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/lint-ok:/.test(line) || /^\s*(\/\/|--)/.test(line)) return;
      for (const p of PITFALLS) if (p.re.test(line)) bad.push(`${f}:${i + 1}: ${p.why}\n    ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, [], "实验代码里有记过的坑:\n" + bad.join("\n"));
});

test("实验代码不手摆电线杆 / 配电站 / 电力接口 (老实验除外)", () => {
  const dir = path.join(import.meta.dirname, "..", "experiments");
  const bad: string[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
    if (ALLOW_OLD.has(f)) continue;
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      // 故意自建电网的 (测电力不足、测电线杆本身) 在那一行写 "lint-ok: 原因", 原因不能空
      if (/lint-ok:\s*\S/.test(line)) return;
      if (POWER.test(line) && /create_entity|lab\.place|name:\s*"/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(bad, [], "这些地方在手摆供电设备, 改用 ctx.power() / power_area / power_fix:\n" + bad.join("\n"));
});
