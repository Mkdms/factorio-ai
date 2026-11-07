// 聊天的富文本标签和官方中文名表 (commands/chattags.ts; 不开游戏)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chatTags, fromMap, loadNameIndex, loadZhNames, zhWords } from "../commands/chattags.ts";
import { dataRoot } from "../game/sandbox/paths.ts";

const idx = fromMap(new Map([["地下管道", "[item=pipe-to-ground]"], ["木箱", "[item=wooden-chest]"], ["原油", "[fluid=crude-oil]"], ["采矿产能 1", "[technology=mining-productivity-1]"], ["管道", "[item=pipe]"]]));

test("星球前缀、坐标变 gps、官方名加图标; 最长的名字先匹配", () => {
  assert.equal(chatTags("@MK 地下管道 17 对放在木箱 -14.5,-52.5, 请直接去拿", idx), "[planet=nauvis] @MK [item=pipe-to-ground]地下管道 17 对放在[item=wooden-chest]木箱 [gps=-14.5,-52.5,nauvis], 请直接去拿");
  assert.equal(chatTags("往基地 x≈55,y≈15 铺原油管道", idx), "[planet=nauvis] 往基地 [gps=55,15,nauvis] 铺[fluid=crude-oil]原油[item=pipe]管道");
  assert.match(chatTags("在 (3,4) 放地下管道", idx), /\[gps=3,4,nauvis\] 放\[item=pipe-to-ground\]地下管道/);
});

test("普通数字不当坐标; 已有标签不重复加; 内部名和英文状态词换中文, 命令不动", () => {
  assert.equal(chatTags("红瓶 30, 绿瓶 30", idx), "[planet=nauvis] 红瓶 30, 绿瓶 30");
  assert.equal(chatTags("[planet=nauvis] 看 [gps=1,2,nauvis] 的[item=wooden-chest]木箱", idx), "[planet=nauvis] 看 [gps=1,2,nauvis] 的[item=wooden-chest]木箱");
  assert.match(chatTags("研究 采矿产能 1", idx), /\[technology=mining-productivity-1\]采矿产能 1/);
  assert.equal(zhWords("wooden-chest 满了 (full_output), 用 ./fh call status 看", idx), "木箱 满了 (出口满), 用 ./fh call status 看");
});

test("本机导出的名单: 版本目录本身或上一层都读得到", (t) => {
  const root = path.join(dataRoot(), "prototypes");
  if (!fs.existsSync(root)) return t.skip("本机没导出原型数据");
  const sub = fs.readdirSync(root).find((d) => fs.existsSync(path.join(root, d, "locale", "zh-CN")));
  if (!sub) return t.skip("没有 zh-CN 名单");
  for (const dir of [root, path.join(root, sub)]) {
    const zh = loadZhNames(dir);
    assert.equal(zh.get("stone-furnace"), "石炉", dir);
    assert.ok(zh.size > 500);
    assert.equal(loadNameIndex(dir).byZh.get("地下管道"), "[item=pipe-to-ground]");
  }
});
