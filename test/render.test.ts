// 出图 (bp render) 的纯函数测试 (不开浏览器): 网格间距、渲染分辨率、压缩顺序、坐标参照。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gridStep, renderResolution, ENCODE_TRIES, referenceOf, cropBlueprint, previewLink, LINK_INLINE_MAX } from "../src/blueprint/render.ts";

test("网格间距: 相邻两条线至少 40 像素, 取 1/2/5 进位里最小的", () => {
  assert.equal(gridStep(32), 2); // 每格 32 像素: 1 格 32 < 40, 2 格 64
  assert.equal(gridStep(40), 1);
  assert.equal(gridStep(13.8), 5); // 2 格 27.6 < 40
  assert.equal(gridStep(0.6), 100); // 朋友基地 1369 格缩到 800 像素
  assert.equal(gridStep(1e-6), 2000); // 再小也有上限
});

test("渲染分辨率: 按 2 倍目标渲染再缩, 小图不放大", () => {
  assert.equal(renderResolution(320, 320, 800), 1); // 10 格见方: 原样
  assert.equal(renderResolution(32 * 100, 32 * 50, 800), 0.5); // 3200 像素宽 → 1600
  assert.ok(Math.abs(renderResolution(32 * 1421, 32 * 1369, 800) * 32 * 1421 - 1600) < 1e-6);
  assert.equal(renderResolution(0, 0, 800), 1);
});

test("压缩顺序: 先 png, 再 jpeg 质量递减", () => {
  assert.equal(ENCODE_TRIES[0].mime, "image/png");
  const q = ENCODE_TRIES.slice(1).map((t) => t.quality!);
  assert.ok(ENCODE_TRIES.slice(1).every((t) => t.mime === "image/jpeg"));
  assert.deepEqual([...q].sort((a, b) => b - a), q);
});

test("坐标参照: 取前 10 件带编号的实体当候选; 没编号 (fatul 格式) 就没有参照", () => {
  assert.deepEqual(referenceOf({ entities: [{ position: { x: 1, y: 2 } }, { entity_number: 7, position: { x: 3.5, y: -4.5 } }] }), [{ n: 7, x: 3.5, y: -4.5 }]);
  assert.equal(referenceOf({ entities: Array.from({ length: 30 }, (_, i) => ({ entity_number: i + 1, position: { x: i, y: 0 } })) })!.length, 10);
  assert.equal(referenceOf({ entities: [{ position: { x: 1, y: 2 } }] }), undefined);
  assert.equal(referenceOf({}), undefined);
});

test("裁局部: 只留框里的实体、地砖, 两头都在的电线和有车头的时刻表", () => {
  const bp = {
    label: "测试",
    entities: [
      { entity_number: 1, name: "small-electric-pole", position: { x: 0.5, y: 0.5 } },
      { entity_number: 2, name: "small-electric-pole", position: { x: 5.5, y: 0.5 } },
      { entity_number: 3, name: "small-electric-pole", position: { x: 50.5, y: 0.5 } },
      { entity_number: 4, name: "locomotive", position: { x: 60, y: 3 } },
    ],
    tiles: [{ name: "concrete", position: { x: 1, y: 1 } }, { name: "concrete", position: { x: 40, y: 1 } }],
    wires: [[1, 5, 2, 5], [2, 5, 3, 5]],
    schedules: [{ locomotives: [4], schedule: {} }],
  };
  const c = cropBlueprint(bp, [10, 10, -1, -1]); // 两角顺序不限
  assert.deepEqual(c.entities.map((e) => e.entity_number), [1, 2]);
  assert.equal(c.tiles!.length, 1);
  assert.deepEqual(c.wires, [[1, 5, 2, 5]]);
  assert.deepEqual(c.schedules, []);
  assert.equal(c.label, "测试");
  assert.equal(bp.entities.length, 4); // 原蓝图不动
});

test("预览链接: 短蓝图放进链接, 长的写进编辑器本机目录给短链接", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbe-"));
  assert.equal(previewLink("0abc", dir, "http://localhost:8080/"), "http://localhost:8080/#source=0abc");
  const long = "0" + "x".repeat(LINK_INLINE_MAX);
  const link = previewLink(long, dir, "http://localhost:8080");
  const m = /^http:\/\/localhost:8080\/\?source=http:\/\/localhost:8080\/local-bp\/([0-9a-f]{12}\.txt)$/.exec(link);
  assert.ok(m, link);
  assert.equal(fs.readFileSync(path.join(dir, "packages", "website", "public", "local-bp", m[1]), "utf8"), long);
  fs.rmSync(dir, { recursive: true });
});
