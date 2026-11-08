// 按负责人发的工厂摘要 (src/play/digest.ts; 搬自派对 factory_digest.py / hauling.py)。
// 数据: 2026-11-03 第十三轮接续第 3 班服务器的真实操作员读数 (factory_digest、hauling), 裁短后放在 test/fixtures/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { currentFacts, delta, moved, owners, shiftHauls, haulLine, digestText, list, type Claim, type Report, type HaulAgent } from "../src/play/digest.ts";

const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "digest-2026-11-03.json"), "utf8")) as { report: Report; hauling: HaulAgent[] };
const ZH: Record<string, string> = { "stone-furnace": "石炉", "assembling-machine-2": "组装机2型", "assembling-machine-1": "组装机1型", coal: "煤矿", "burner-mining-drill": "热能采矿机", "logistic-science-pack": "物流科技包（绿瓶）", lab: "研究中心" };
const zh = (n: string) => ZH[n] ?? n;
const roleOf = (type: string) => (type === "assembling-machine" || type === "lab" ? ["ai2"] : ["MK"]);

test("没有认领: 按分工发 (冶炼 → MK, 组装机 / 研究中心 → ai2); 堵满照派对一律报, 同时有缺料加一句", () => {
  const cur = currentFacts(fx.report, [], roleOf, zh);
  assert.equal(cur["short|nauvis|stone-furnace"].value, 8);
  assert.deepEqual(cur["short|nauvis|stone-furnace"].to, ["MK"]);
  assert.match(cur["short|nauvis|stone-furnace"].text, /^石炉 缺料 8 台 在 \(/);
  assert.deepEqual(cur["labs|nauvis"], { value: 11, to: ["ai2"], text: "研究中心停着 11 台 (缺科技包 11)" });
  assert.deepEqual(cur["short|nauvis|assembling-machine-2"].to, ["ai2"]);
  assert.match(cur["full|nauvis|stone-furnace"].text, /出口堵满 24 台.*同时有机器缺料/);
  assert.equal(cur["dry|nauvis|electric-mining-drill"], undefined); // 采矿机只是等带子有空, 不是采空
  // 没有缺料时也报堵满 (照派对), 只是不加"料没送到"
  const calm: Report = { surfaces: [{ surface: "nauvis", machines: { "stone-furnace": { type: "furnace", counts: { full_output: 5, working: 3 } } } }] };
  assert.equal(currentFacts(calm, [], roleOf)["full|nauvis|stone-furnace"].text, "stone-furnace 出口堵满 5 台");
});

test("有认领: 坐标落在谁的区域就发给谁 (含帮忙看着的), 区域外发给这个星球所有认领人", () => {
  const claims: Claim[] = [
    { owner: "MK", surface: "nauvis", status: "claimed", area: { left_top: { x: -50, y: -90 }, right_bottom: { x: 0, y: -20 } }, covers: [{ name: "ai2" }] },
    { owner: "ai2", surface: "nauvis", status: "doing", area: { left_top: { x: 20, y: -60 }, right_bottom: { x: 60, y: 0 } } },
  ];
  assert.deepEqual(owners("nauvis", [{ x: -17, y: -60 }], claims, ["x"]), ["MK", "ai2"]);
  assert.deepEqual(owners("nauvis", [{ x: 38, y: -12 }], claims, ["x"]), ["ai2"]);
  assert.deepEqual(owners("nauvis", [{ x: 500, y: 500 }], claims, ["x"]), ["MK", "ai2"]);
  assert.deepEqual(owners("gleba", [{ x: 0, y: 0 }], claims, ["x"]), ["x"]);
  assert.deepEqual(list({}), []); // Lua 空表
});

test("只发变化: 新出现、变化明显、已解决; 小变化不重复发", () => {
  assert.equal(moved(undefined, 3), true);
  assert.equal(moved(10, 11), false);
  assert.equal(moved(10, 12), true);
  assert.equal(moved(3, 0), true);
  const a = { "short|nauvis|stone-furnace": { value: 8, to: ["MK"], text: "石炉 缺料 8 台" }, "labs|nauvis": { value: 11, to: ["ai2"], text: "研究中心停着 11 台" } };
  assert.deepEqual(delta(null, a).map((r) => r.to), ["MK", "ai2"]);
  const b = { "short|nauvis|stone-furnace": { value: 9, to: ["MK"], text: "石炉 缺料 9 台" } };
  assert.deepEqual(delta(a, b), [{ to: "ai2", text: "已解决: 研究中心停着 11 台" }]); // 8 → 9 不算变化
  const c = { "short|nauvis|stone-furnace": { value: 20, to: ["MK"], text: "石炉 缺料 20 台" } };
  assert.deepEqual(delta(b, c), [{ to: "MK", text: "石炉 缺料 20 台 (上次 9)" }]);
});

test("这一班的手搬: 减去开班时的读数, 重复最多的一条成一句话", () => {
  const first: HaulAgent[] = [{ name: "MK", items: 100000, calls: 3000, hauls: [{ ...fx.hauling[0].hauls![0], times: 600, items: 1600 }] }];
  const rows = shiftHauls(first, fx.hauling);
  const mk = rows.find((r) => r.name === "MK")!;
  assert.equal(mk.hauls![0].item, "inserter"); // 煤那条开班前已经 600 次, 这一班只加了 76 次, 不再是最多
  const line = haulLine(rows.find((r) => r.name === "ai2"), zh)!;
  assert.match(line, /^你这一班重复最多的手搬: 物流科技包（绿瓶） 513 次/);
  assert.match(line, /改成传送带 \+ 机械臂/);
  assert.equal(haulLine({ name: "x", hauls: [{ item: "coal", times: 1 }] }), null);
});

test("普查过期时用体检: 采空 / 缺燃料带坐标, 缺料按名字, 有缺料才报堵满", async () => {
  const { factsFromHealth } = await import("../src/play/digest.ts");
  const h = { noFuel: ["stone-furnace(-25.0,-29.0)", "stone-furnace(-23.0,-29.0)", "boiler(10.0,5.0)"], depleted: ["-7.0,-53.0", "-5.0,-53.0"], labs: { total: 11, working: 1, missingPacks: 10 }, short: { "logistic-science-pack": 2, "炉子": 7 }, full: { "炉子": 25 } };
  const f = factsFromHealth(h, [], roleOf, zh);
  assert.deepEqual(f["dry|nauvis|mining-drill"], { value: 2, to: ["MK"], text: "采矿机 采空 2 台 在 (-7,-53)、(-5,-53)" });
  assert.deepEqual(f["fuel|nauvis|stone-furnace"], { value: 2, to: ["MK"], text: "石炉 没燃料 2 台 在 (-25,-29)、(-23,-29)" });
  assert.deepEqual(f["short|nauvis|logistic-science-pack"].to, ["ai2"]);
  assert.deepEqual(f["short|nauvis|炉子"].to, ["MK"]); // 体检把炉子合成一项叫"炉子"
  assert.match(f["full|nauvis|炉子"].text, /出口堵满 25 台/);
  assert.deepEqual(f["labs|nauvis"], { value: 10, to: ["ai2"], text: "研究中心停着 10 台 (缺科技包 10)" });
  assert.equal(factsFromHealth({ full: { "stone-furnace": 25 } }, [], roleOf)["full|nauvis|stone-furnace"].text, "stone-furnace 出口堵满 25 台");
});

test("每人的摘要正文: 只含归他的; 都没有就不发", () => {
  const rows = [{ to: "MK", text: "石炉 缺料 8 台" }, { to: "ai2", text: "研究中心停着 11 台" }];
  assert.equal(digestText("MK", rows, null, "监工摘要"), "监工摘要\n归你管的变化: 石炉 缺料 8 台");
  assert.equal(digestText("MK", [], null, "监工摘要"), null);
  assert.match(digestText("ai2", [], "你这一班重复最多的手搬: …", "监工摘要")!, /归你管的没有新变化。\n你这一班/);
});
