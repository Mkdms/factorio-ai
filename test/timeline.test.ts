// M4 io: 搬自第一版的按键映射、时间线, 和 MCP 客户端的只读重试分类 (不开游戏)
import test from "node:test";
import assert from "node:assert/strict";
import { Timeline } from "../commands/timeline.ts";
import { Controls } from "../commands/controls.ts";
import { READ_TOOLS } from "../game/client/connect.ts";
import { extractFilters, readRequests, readRecipe } from "../commands/query.ts";

// 合成的键位 (形状照 注入客户端的程序 input_bindings 的回复; 不用任何人的键位文件)
const controls = new Controls([
  { id: "move-up", effective_bindings: [{ slot: "keyboard_mouse_primary", type: "Keyboard", name: "W", modifiers: [] }] },
  { id: "pipette", effective_bindings: [{ slot: "keyboard_mouse_primary", type: "Keyboard", name: "Q", modifiers: ["shift"] }] },
  { id: "build", effective_bindings: [{ slot: "keyboard_mouse_primary", type: "MouseButton", name: "left", modifiers: [] }] },
  { id: "zoom-in", effective_bindings: [{ slot: "keyboard_mouse_primary", type: "MouseWheel", name: "up", modifiers: [] }] },
  { id: "unbound", effective_bindings: [] },
]);

test("按键映射: 主绑定、修饰键换成左侧键名、鼠标键和滚轮", () => {
  assert.deepEqual(controls.resolve("move-up"), { device: "keyboard", name: "W", modifiers: [] });
  assert.deepEqual(controls.resolve("pipette"), { device: "keyboard", name: "Q", modifiers: ["LSHIFT"] });
  assert.deepEqual(controls.resolve("build"), { device: "mouse", name: "left", modifiers: [] });
  assert.deepEqual(controls.resolve("zoom-in"), { device: "mouse", name: "wheel:up", modifiers: [] });
  assert.throws(() => controls.resolve("nope"), /Unknown control/);
  assert.throws(() => controls.resolve("unbound"), /no keyboard\/mouse binding/);
  assert.throws(() => controls.key("build"), /bound to the mouse/);
});

test("时间线: tick 区间是闭区间字符串, 修饰键单独成条, 最后一个 tick 含鼠标轨迹", () => {
  const t = new Timeline().key("W", 0, 30).control(controls.resolve("pipette"), 40).control(controls.resolve("zoom-in"), 50).worldPosition({ x: 3.5, y: -2.5 }, 60, 70, true);
  assert.deepEqual(t.entries.slice(0, 3), [
    { device: "keyboard", key: "W", tick: "0-30" },
    { device: "keyboard", key: "LSHIFT", tick: "40" },
    { device: "keyboard", key: "Q", tick: "40" },
  ]);
  assert.deepEqual(t.entries[3], { device: "mouse", wheel: "up", tick: "50" });
  assert.deepEqual(t.entries[4].position, { space: "world", x: 3.5, y: -2.5, snap: "tile_center" });
  assert.equal(t.lastTick, 70);
  const m = new Timeline().worldMotion({ x: 0, y: 0 }, { x: 4, y: 1 }, 3, 10); // 5 个点 × 3 tick, 从 10 开始 → 最后 24
  assert.equal(m.lastTick, 24);
  assert.throws(() => new Timeline().key("W", 5, 4), /Invalid tick range/);
});

test("长按键拆成首尾相接的多段, 切窗口松开的键很快重新按上", () => {
  const t = new Timeline().holdKey("W", 0, 65, 30);
  assert.deepEqual(t.entries.map((e) => e.tick), ["0-29", "30-59", "60-65"]);
  assert.equal(t.lastTick, 65);
  assert.deepEqual(new Timeline().holdKey("W", 5, 7).entries.map((e) => e.tick), ["5-7"], "短按不拆");
  const c = new Timeline().holdControl(controls.resolve("pipette"), 0, 3, 2);
  assert.deepEqual(c.entries.map((e) => [e.key, e.tick]), [["LSHIFT", "0-1"], ["Q", "0-1"], ["LSHIFT", "2-3"], ["Q", "2-3"]], "修饰键跟着一起重按");
  assert.throws(() => new Timeline().holdKey("W", 5, 4), /Invalid tick range/);
  assert.throws(() => new Timeline().holdKey("W", 0, 4, 0), /Invalid repress/);
});

test("MCP 客户端: 断线后只重试只读工具, 动作类绝不重放 (注入客户端的程序 规矩; 第一版连动作也重发)", () => {
  for (const r of ["status", "world_query", "world_overview", "ui_read", "chat_read", "screenshot"]) assert.ok(READ_TOOLS.has(r), r);
  for (const w of ["input", "ui_action", "chat_send", "set_rendering", "attach", "detach"]) assert.ok(!READ_TOOLS.has(w), w);
});

// 夹具照 2026-11-02 T9 对 注入客户端的程序 0.0.10 的真实回复删减 (没有 max = 无限)
const filtersReply = { objects: [{ value_type: "table", entries: [
  { key: 1, value: { value: { name: "iron-plate", type: "item", quality: "normal", comparator: "=" }, min: 50, max: 200 } },
  { key: 2, value: { value: { name: "iron-gear-wheel", type: "item", quality: "normal", comparator: "=" }, min: 80 } },
], total: 2 }] };

test("读请求: extractFilters 从 inspect 的 entries 里抽出物品、最小、最大 (没有 max 不编默认值)", () => {
  assert.deepEqual(extractFilters(filtersReply.objects), [{ item: "iron-plate", min: 50, max: 200 }, { item: "iron-gear-wheel", min: 80 }]);
  // 分组本身 (LuaLogisticSection 引用) 不是请求
  assert.deepEqual(extractFilters([{ entries: [{ key: 1, value: { object_name: "LuaLogisticSection", index: 1, valid: true } }] }]), []);
});

test("读请求: 先读分组数, 再按分组读 filters; 两条路径 (sections[i] / get_section(i)) 发的查询不同", async () => {
  for (const path of ["sections", "get_section"] as const) {
    const sent: unknown[][] = [];
    const call = async (_n: string, a: Record<string, unknown> = {}) => {
      const p = (a.selection as { path: unknown[] }).path;
      sent.push(p);
      const data = p.length === 2 ? { objects: [{ entries: [{ key: 1, value: { object_name: "LuaLogisticSection" } }], total: 1 }] } : filtersReply;
      return { ok: true, ms: 1, bytes: 1, data };
    };
    const rs = await readRequests(call, { name: "requester-chest", position: { x: 4.5, y: -2.5 } }, path);
    assert.deepEqual(rs.map((r) => [r.item, r.min, r.max, r.section]), [["iron-plate", 50, 200, 1], ["iron-gear-wheel", 80, undefined, 1]]);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1][1], path === "sections" ? { property: "sections" } : { method: "get_section", arguments: [1] });
  }
});

test("读配方: include recipe 的 details; 没配方给 null", async () => {
  const reply = (recipe: unknown) => async () => ({ ok: true, ms: 1, bytes: 1, data: { objects: [{ attributes: { name: "assembling-machine-2" }, details: { recipe: { recipe } } }] } });
  assert.equal(await readRecipe(reply({ object_name: "LuaRecipe", name: "iron-chest" }), { x: 5.5, y: 2.5 }), "iron-chest");
  assert.equal(await readRecipe(reply(null), { x: 5.5, y: 2.5 }), null);
});

// M4 测试集的公共部分 (src/io/suite-lib.ts): 比对和出表
import { diffList, fmtDiff, diffCounts, diffSlots, fps, table, summary, makeBlueprint, routeOf } from "../commands/io-types.ts";
import { decodeBlueprint } from "../game/blueprint.ts";

test("测试集比对: 清单不计顺序、重复要成对; 数量表; 背包逐格", () => {
  assert.deepEqual(diffList(["a", "b", "b"], ["b", "a", "b"]), { same: true, onlyTruth: [], onlyGot: [] });
  const d = diffList(["a", "b", "b"], ["b", "c"]);
  assert.deepEqual(d, { same: false, onlyTruth: ["a", "b"], onlyGot: ["c"] });
  assert.equal(fmtDiff(d), "只在真值里 2 个 (a b); 只在接口里 1 个 (c)");
  assert.equal(fmtDiff(diffList([], [])), "无");
  assert.deepEqual(diffCounts({ x: 1, y: 2 }, { y: 2, z: 3 }), ["x 真值 1 / 接口 0", "z 真值 0 / 接口 3"]);
  assert.deepEqual(diffSlots([{ name: "iron-plate", count: 100 }, null], [{ name: "iron-plate", count: 100 }, null]), []);
  assert.deepEqual(diffSlots([{ name: "iron-plate", count: 100 }, null], [{ name: "iron-plate", count: 99 }]), ["第 1 格 真值 iron-plate×100 / 接口 iron-plate×99", "格数 真值 2 / 接口 1"]);
});

test("测试集出表: 帧率、markdown 表 (竖线转义、超长截断)、小结", () => {
  assert.equal(fps(100, 0, 160, 1000), 60);
  assert.ok(Number.isNaN(fps(0, 5, 10, 5)));
  const rows = [
    { id: "T1a", test: "状态", ok: true, ms: 15, bytes: 120, diff: "无" },
    { id: "T4a", test: "进化度", ok: null, note: "不支持: a|b" },
    { id: "T6a", test: "状态名", ok: false, ms: 20, bytes: 3 * 1024 * 1024, diff: "x".repeat(300) },
  ];
  const md = table(rows).split("\n");
  assert.equal(md.length, 5);
  assert.equal(md[2], "| T1a | 状态 | ✅ | 15 | 120B | 原生 | 和真值一致 |");
  assert.equal(md[3], "| T4a | 进化度 | — |  |  | Lua | 不支持: a/b |");
  assert.ok(md[4].includes("| ❌ | 20 | 3.00MB | 内存+Lua |") && md[4].endsWith("… |"));
  assert.deepEqual(summary(rows), { pass: 1, fail: 1, na: 1, total: 3 });
});

test("T10 长蓝图: 至少要求的字数, 解码后实体数对", () => {
  const bp = makeBlueprint(4000);
  assert.ok(bp.text.length >= 4000);
  const d = decodeBlueprint(bp.text) as { blueprint: { entities: unknown[] } };
  assert.equal(d.blueprint.entities.length, bp.entities);
  assert.equal(bp.w, 100);
});

test("测试集: 每项以后的主路 (第 4b 节: 读类内存和 Lua 都做)", () => {
  assert.deepEqual(["T1b", "T2c", "T3b", "T4a", "T5a", "T6e", "T7a", "T10c", "T11a", "T12", "T13d", "T14a", "T15b", "运行"].map(routeOf),
    ["原生", "内存+Lua", "内存+Lua", "Lua", "Lua", "内存+Lua", "动作", "动作", "内存+Lua", "内存", "原生", "宿主", "Lua", ""]);
});
