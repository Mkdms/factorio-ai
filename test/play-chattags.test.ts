// 大脑聊天的富文本标签 (src/play/chattags.ts; 不开游戏)
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { chatTags, fromMap, loadNameIndex } from "../src/play/chattags.ts";
import { labRoot } from "../src/lab/gamedir.ts";

const idx = fromMap(new Map([["地下管道", "[item=pipe-to-ground]"], ["木箱", "[item=wooden-chest]"], ["原油", "[fluid=crude-oil]"], ["采矿产能 1", "[technology=mining-productivity-1]"], ["管道", "[item=pipe]"]]));

test("星球前缀、坐标变 gps、官方名加图标", () => {
  const t = chatTags("@MK 地下管道 17 对放在木箱 -14.5,-52.5, 请直接去拿", idx);
  assert.equal(t, "[planet=nauvis] @MK [item=pipe-to-ground]地下管道 17 对放在[item=wooden-chest]木箱 [gps=-14.5,-52.5,nauvis], 请直接去拿");
});

test("x≈55,y≈15 和括号坐标; 最长的名字先匹配 (地下管道 不被拆成 管道)", () => {
  assert.equal(chatTags("往基地 x≈55,y≈15 铺原油管道", idx), "[planet=nauvis] 往基地 [gps=55,15,nauvis] 铺[fluid=crude-oil]原油[item=pipe]管道");
  assert.match(chatTags("在 (3,4) 放地下管道", idx), /\[gps=3,4,nauvis\] 放\[item=pipe-to-ground\]地下管道/);
});

test("普通数字不当坐标; 已有标签不重复加; 已有星球前缀不再加", () => {
  assert.equal(chatTags("红瓶 30, 绿瓶 30", idx), "[planet=nauvis] 红瓶 30, 绿瓶 30");
  assert.equal(chatTags("[planet=nauvis] 看 [gps=1,2,nauvis] 的[item=wooden-chest]木箱", idx), "[planet=nauvis] 看 [gps=1,2,nauvis] 的[item=wooden-chest]木箱");
  assert.match(chatTags("研究 采矿产能 1", idx), /\[technology=mining-productivity-1\]采矿产能 1/);
});

test("本机有导出的名单时能读到官方名", (t) => {
  const root = path.join(labRoot(), "prototypes");
  if (!fs.existsSync(root)) return t.skip("本机没导出原型数据");
  const real = loadNameIndex(root);
  assert.equal(real.byZh.get("地下管道"), "[item=pipe-to-ground]");
  assert.ok(real.byZh.size > 500);
});
