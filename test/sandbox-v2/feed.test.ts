// 喂料测产量 (数据集第三层, src/dataset/feed.ts + 模组 feed_setup / feed_stats) 的回归测试:
// 自己拼的小冶炼块 (不用别人的蓝图): 4 座石炉, 南边一条东行输入带 + 电力机械臂, 北边出料机械臂 + 东行输出带; 不放电线杆 (补电逻辑也测到)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { LabInstance } from "../../src/lab/instance.ts";
import { placeBlueprint, feedArea } from "../../src/dataset/feed.ts";

const E = 4, S = 8; // 东、南 (16 向)
function smelterBlueprint() {
  const entities: Record<string, unknown>[] = [];
  const add = (name: string, x: number, y: number, extra: Record<string, unknown> = {}) => entities.push({ entity_number: entities.length + 1, name, position: { x, y }, ...extra });
  for (let x = -1; x <= 9; x++) add("transport-belt", x + 0.5, 0.5, { direction: E }); // 输入带
  for (let x = -1; x <= 9; x++) add("transport-belt", x + 0.5, -4.5, { direction: E }); // 输出带
  for (const fx of [1, 3, 5, 7]) {
    add("stone-furnace", fx, -2);
    add("inserter", fx - 0.5, -0.5, { direction: S }); // 从南边的输入带取货, 放进炉子 (机械臂 direction = 取货方向)
    add("inserter", fx - 0.5, -3.5, { direction: S }); // 从南边的炉子取货, 放到北边输出带
  }
  return { item: "blueprint", label: "测试冶炼块", entities };
}

test("喂料测产量: 4 座石炉的小冶炼块 —— 推出输入带要铁矿 + 煤、尽头只收铁板、效率接近满速", async () => {
  const lab = new LabInstance({ name: "test-feed", view: false });
  await lab.createMap("feed", { seed: 1 });
  await lab.start("feed");
  try {
    const bp = smelterBlueprint();
    const { area, placed } = await placeBlueprint(lab, bp, "测试冶炼块");
    assert.equal(placed.built, bp.entities.length);
    const f = await feedArea(lab, area, bp, { warmS: 40, measureS: 120 });
    assert.ok(!f.error && !f.skipped, JSON.stringify(f));
    assert.equal(f.feeds, 1, "输入带起点 1 个 (输出带起点没有要的料, 不喂)");
    assert.equal(f.sinks, 1, "输出带尽头收料; 输入带尽头上游没有往上放东西的, 不收");
    assert.ok((f.powerFixed ?? 0) > 0, "没电线杆, 要补电");
    assert.deepEqual(f.final, ["iron-plate"]);
    assert.ok(f.fedPerMin["iron-ore"] > 0 && f.fedPerMin["coal"] > 0, JSON.stringify(f.fedPerMin));
    assert.deepEqual(Object.keys(f.sinkPerMin), ["iron-plate"], "尽头只收做出来的东西, 原料留在带上");
    // 石炉: 速度 1, 铁板 3.2 秒 → 每台每分钟 18.75, 4 台 75
    assert.ok(Math.abs(f.theoryPerMin["iron-plate"] - 75) < 0.01, JSON.stringify(f.theoryPerMin));
    assert.ok(f.efficiency !== null && f.efficiency > 0.9 && f.efficiency < 1.05, `效率 ${f.efficiency}`);
    assert.ok(f.trend !== null && f.trend !== undefined && f.trend > 0.9, `趋势 ${f.trend}`);
  } finally {
    await lab.stop({ save: false });
  }
});
