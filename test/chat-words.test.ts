// 聊天不露英文 (src/play/chattags.ts zhWords)
import test from "node:test";
import assert from "node:assert/strict";
import { chatTags, fromMap, zhWords } from "../src/play/chattags.ts";

const idx = fromMap(new Map([["铁板", "[item=iron-plate]"], ["组装机1型", "[item=assembling-machine-1]"], ["电力机械臂", "[item=inserter]"], ["研究中心", "[item=lab]"]]));

test("工具的英文状态词和内部名换成中文", () => {
  assert.equal(zhWords("assembler 有 low_power/no_power", idx), "组装机 有 电力不足/没电");
  assert.equal(zhWords("iron-plate 不够, assembling-machine-1 停了, inserter 没动", idx), "铁板 不够, 组装机1型 停了, 电力机械臂 没动");
  assert.equal(zhWords("往 north 拉 poles", idx), "往 北 拉 电线杆");
});

test("名字、命令、参数不动", () => {
  for (const s of ["@Grok-4.7 你来", "@mkdm 收到", "Gpt-6.1-Sol 说了", "./fh call status", "用 ./bp build 240", "--near -4", "Claude-Haiku-5.5 接了"]) assert.equal(zhWords(s, idx), s, s);
});

test("接进聊天标签: 换完中文再加图标和坐标, 已有标签不动", () => {
  assert.equal(chatTags("iron-plate 放 (2.5,-39.5)", idx), "[planet=nauvis] [item=iron-plate]铁板 放 [gps=2.5,-39.5,nauvis]");
  assert.equal(chatTags("[item=iron-plate]铁板 够了", idx), "[planet=nauvis] [item=iron-plate]铁板 够了");
});
