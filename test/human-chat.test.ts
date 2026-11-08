// 真人说话: ; "不打断, 除非真人玩家说特别紧急"
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { completeLines, isUrgent, markEnd, mentioned, parseChatLine, readNewLines, tellText } from "../src/play/human-chat.ts";
import { argText } from "../src/play/argv-file.ts";

const seats = [{ id: "a", name: "player2" }, { id: "b", name: "Gpt-6.1-Sol" }, { id: "c", name: "Grok-4.7" }];

test("Windows 的 \\r\\n: 一批只有一句聊天也解析得出来 (11-05 总验证: 最后一行留着 \\r, 这句丢了)", () => {
  const { lines, consumed } = completeLines("2026-11-05 17:31:25 [CHAT] player2: 帮我修下电\r\n");
  assert.deepEqual(lines, ["2026-11-05 17:31:25 [CHAT] player2: 帮我修下电"]);
  assert.deepEqual(parseChatLine(lines[0]), { from: "player2", text: "帮我修下电" });
  assert.equal(consumed, Buffer.byteLength("2026-11-05 17:31:25 [CHAT] player2: 帮我修下电\r\n"));
});

test("开班时定位日志尾: 旧班的聊天不算, 定位之后、第一次轮询之前真人说的不丢 (11-05 总验证丢过一句)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "human-chat-"));
  const file = path.join(dir, "server.out");
  const st = { off: -1 };
  markEnd(file, st);
  assert.equal(st.off, 0, "文件还没有: 从头读");
  fs.writeFileSync(file, "[CHAT] player2: 旧班说的\n");
  markEnd(file, st);
  fs.appendFileSync(file, "[CHAT] player2: 第一次轮询前说的\n");
  assert.deepEqual(readNewLines(file, st), ["[CHAT] player2: 第一次轮询前说的"]);
  assert.deepEqual(readNewLines(file, st), []);
  fs.rmSync(dir, { recursive: true });
});

test("服务器日志的 [CHAT] 行: 真人的话解析出来, 服务器自己说的和别的行不算", () => {
  assert.deepEqual(parseChatLine("2026-11-05 13:02:20 [CHAT] player2: 是谁把铁板丢地上的?"), { from: "player2", text: "是谁把铁板丢地上的?" });
  assert.deepEqual(parseChatLine("2026-11-05 13:02:20 [CHAT] player1 [admin]: 帮我修下电"), { from: "player1", text: "帮我修下电" });
  assert.equal(parseChatLine("2026-11-05 13:02:20 [CHAT] <server>: hello"), null);
  assert.equal(parseChatLine("2026-11-05 13:02:20 [JOIN] player2 joined the game"), null);
});

test("只有明确说紧急才打断", () => {
  for (const t of ["特别紧急! 基地被打了", "紧急", "URGENT fix power"]) assert.ok(isUrgent(t), t);
  for (const t of ["是谁把铁板丢地上的?", "快点", "帮我修下电"]) assert.ok(!isUrgent(t), t);
});

test("@ 点名: 大小写不敏感, 不把 @Grok-4.7x 算成 Grok-4.7; 没 @ 就是全队", () => {
  assert.deepEqual(mentioned("@gpt-6.1-sol 去修电", seats).map((s) => s.id), ["b"]);
  assert.deepEqual(mentioned("@player2 @Grok-4.7 一起", seats).map((s) => s.id), ["a", "c"]);
  assert.deepEqual(mentioned("@Grok-4.7x 不是他", seats), []);
  assert.deepEqual(mentioned("大家好", seats), []);
});

test("转给模型的话: 不紧急说手上的事做完再回, 紧急说先放下; 界面回 operator, 游戏聊天回 say", () => {
  assert.match(tellText("界面", "管理员", "在吗", "direct", false), /做完就回/);
  assert.match(tellText("界面", "管理员", "在吗", "direct", false), /operator/);
  assert.match(tellText("游戏聊天", "player1", "在吗", "team", false), /别每人都回/);
  assert.match(tellText("游戏聊天", "player1", "在吗", "team", false), /fh say "@player1/);
  assert.match(tellText("游戏聊天", "player1", "紧急", "direct", true), /先放下/);
});

test("只取写完的行, 没写完的留到下次", () => {
  assert.deepEqual(completeLines("a\nb\nhalf"), { lines: ["a", "b"], consumed: 4 });
  assert.deepEqual(completeLines("half"), { lines: [], consumed: 0 });
  assert.deepEqual(completeLines("中\n").consumed, 4);
});

test("PowerShell 传来的数字和数组还原成命令行写法 (./fh sleep 60、--near -25,20)", () => {
  assert.equal(argText(60), "60");
  assert.equal(argText([-25, 20]), "-25,20");
  assert.equal(argText("x"), "x");
  assert.equal(argText(true), "true");
});
