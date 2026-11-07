// 拼轨 (src/blueprint/rail-path.ts) 的单元测试: 用本机端点表 (npm run lab:dump 生成; 没有就跳过), 结果和沙盘第十八批核实的一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRailGeometry } from "../src/blueprint/rail-geometry.ts";
import { railPath, straightStart } from "../src/blueprint/rail-path.ts";

let geom: ReturnType<typeof loadRailGeometry> = null;
try { geom = loadRailGeometry(); } catch { geom = null; }
const skip = !geom;

test("90° 右弯 = 曲轨 A、B、B、A, 开口横竖各差 13 格 (rails.turn-90-radius-13 ✅)", { skip }, () => {
  const s = straightStart(geom!, 0, 0, 0);
  const t = railPath(geom!, s.end, [1, 2, 3, 4]);
  assert.deepEqual(t.pieces.map((p) => p.name), ["curved-rail-a", "curved-rail-b", "curved-rail-b", "curved-rail-a"]);
  assert.deepEqual([t.end.x - s.end.x, s.end.y - t.end.y, t.end.dir], [13, 13, 4]);
  assert.equal(t.ends.length, 4);
  const l = railPath(geom!, s.end, [-1, -2, -3, -4]);
  assert.deepEqual([l.end.x - s.end.x, s.end.y - l.end.y, l.end.dir], [-13, 13, 12]);
});

test("S 弯每多一段半斜轨横移多 2、前进多 4 (rails.s-bend-any-length ✅)", { skip }, () => {
  const s = straightStart(geom!, 0, 0, 0);
  const shift = [0, 1, 2, 3].map((n) => { const p = railPath(geom!, s.end, [1, ...Array(n).fill(1), 0]); return [p.end.x - s.end.x, s.end.y - p.end.y, p.pieces.filter((x) => x.name === "half-diagonal-rail").length]; });
  assert.deepEqual(shift, [[2, 10, 0], [4, 14, 1], [6, 18, 2], [8, 22, 3]]);
});

test("拼不上就报错 (直行中突然要转 90°)", { skip }, () => {
  const s = straightStart(geom!, 0, 0, 0);
  assert.throws(() => railPath(geom!, s.end, [4]), /拼不上/);
});
