// 蓝图检查器的单元测试 (不开游戏): 用自己拼的小蓝图, 不用别人的蓝图原文。
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBlueprint } from "../src/lab/blueprint.ts";
import { decodeAll } from "../src/blueprint/inspect.ts";

const e = (n: number, name: string, x: number, y: number, extra = {}) => ({ entity_number: n, name, position: { x, y }, ...extra });

test("车站在机器人网里、旁边有紫箱: 报警", () => {
  const s = encodeBlueprint({
    blueprint: {
      item: "blueprint",
      label: "坏车站",
      entities: [e(1, "train-stop", 0, 0, { station: "卸铁" }), e(2, "active-provider-chest", 3.5, 2.5), e(3, "roboport", 10, 10)],
    },
  });
  const [b] = decodeAll(s);
  assert.equal(b.stations[0], "卸铁");
  assert.ok(b.findings.some((f) => f.includes("主动供货箱")), JSON.stringify(b.findings));
});

test("蓝图书摊平; 铜线不算电路线", () => {
  const s = encodeBlueprint({
    blueprint_book: {
      item: "blueprint-book",
      label: "书",
      blueprints: [
        { index: 0, blueprint: { item: "blueprint", label: "甲", entities: [e(1, "medium-electric-pole", 0, 0), e(2, "medium-electric-pole", 5, 0)], wires: [[1, 5, 2, 5]] } },
        { index: 1, blueprint: { item: "blueprint", label: "乙", entities: [e(1, "inserter", 0, 0), e(2, "inserter", 1, 0)], wires: [[1, 1, 2, 1]] } },
      ],
    },
  });
  const list = decodeAll(s);
  assert.equal(list.length, 2);
  assert.equal(list[0].wires, 0);
  assert.equal(list[1].wires, 1);
  assert.equal(list[1].counts.inserter, 2);
});
