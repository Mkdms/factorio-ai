// 派对整套代理配置的改写 (src/play/partykit.ts; 不开游戏)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adaptBrief, deadlineText, ensureGamedata, journalToRequests, setupFullTools, topicIndex, zhBrief as adaptBriefZh } from "../src/play/partykit.ts";

// 派对 brief.py 在 Windows 上写出来是 CRLF (第一次干跑: 我们的一节没插进去, "pog" 那句跨行没匹配)
const BRIEF = [
  "# You are playing Factorio",
  "",
  "You control one character (player `MK`) in a Factorio 2.0.77 multiplayer world: base game.",
  "",
  "- Pictures: `./fh view --out view.png` draws a schematic map; `./shot NAME` saves a real game screenshot",
  "  to `shots/NAME.png` that you can open and look at.",
  "- More detail: `../../../vendor/factorio-harness/docs/usage.md`.",
  "",
  "- Play only through `./fh` and `./shot`. Never send console commands or Lua, never talk to RCON directly, never read",
  "  `~/.config/pog`, and never modify the harness or mod.",
  "- `stream-people`, viewers: `profile`, `profiles`.",
  "- `space-age`, rockets: `platforms`.",
  "",
].join("\r\n");

test("派对简报改成本机沙盘的说法, 我们的一节在最前面", () => {
  const { text, missed } = adaptBrief(BRIEF, "## 先读这一节\n- 语言: 简体中文\n");
  assert.deepEqual(missed, ["python3"]); // 片段里没有 python3 那句
  assert.ok(!text.includes("\r"));
  assert.ok(text.startsWith("# You are playing Factorio\n\n## 先读这一节\n"));
  assert.match(text, /Factorio 2\.1\.24/);
  for (const gone of ["./shot", "usage.md", "~/.config/pog", "stream-people"]) assert.ok(!text.includes(gone), gone);
  assert.match(text, /- `space-age`, rockets/);
});

test("简报不超长 (第 6 班是 15187 字); 监工的话不用回、工具诉求都写了", () => {
  const tpl = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "play", "brief-zh.md"), "utf8");
  assert.ok(tpl.length < 5600, `模板 ${tpl.length} 字`);
  assert.ok(tpl.includes("监工的话不用回") && tpl.includes("工具诉求"));
});

test("手册目录缩成 主题: 讲什么, 去掉命令清单和直播主题", () => {
  const raw = "- `building`, placing and belts: `build`, `belt_route`.\n- `stream-people`, viewers: `profile`.\n- `team`, the board\n  and chat: `board`.\n- Core commands: `say`.\n";
  assert.equal(topicIndex(raw), "- `building`: placing and belts\n- `team`: the board and chat");
  assert.equal(topicIndex("没有列表"), "(见 ./fh help)");
});

test("完整工具: 建 tools 和共享目录, 上一班的带过来 (点开头、缓存、超 5MB 不带), 写 fhlib", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ft-"));
  const prev = path.join(root, "prev"), dir = path.join(root, "a"), shared = path.join(root, "team-tools");
  fs.mkdirSync(path.join(prev, "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(prev, "mine.py"), "print(1)");
  fs.writeFileSync(path.join(prev, ".secret"), "x");
  fs.writeFileSync(path.join(prev, "__pycache__", "a.pyc"), "x");
  fs.writeFileSync(path.join(prev, "big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
  setupFullTools({ dir, shared, prevTools: prev, gamedataDir: path.join(root, "gd") });
  assert.deepEqual(fs.readdirSync(path.join(dir, "tools")).sort(), ["fhlib.py", "mine.py"]);
  assert.ok(fs.existsSync(path.join(shared, "fhlib.py")));
  const lib = fs.readFileSync(path.join(dir, "tools", "fhlib.py"), "utf8");
  assert.ok(lib.includes("def fh(") && lib.includes("def gamedata(") && !lib.includes("\\\\"), "路径用正斜杠");
  fs.rmSync(root, { recursive: true, force: true });
});

test("原型数据按种类拆文件, 只拆一次", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp-gd-"));
  const dump = path.join(root, "dump.json"), out = path.join(root, "gd");
  fs.writeFileSync(dump, JSON.stringify({ recipe: { a: { name: "a" } }, item: { b: {} } }));
  assert.equal(ensureGamedata(dump, out), out);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "recipe.json"), "utf8")), { a: { name: "a" } });
  fs.rmSync(dump);
  assert.equal(ensureGamedata(dump, out), out, "拆过就不再读 dump");
  fs.rmSync(root, { recursive: true, force: true });
});

test("中文简报: 占位符都填上, 手册目录取英文原文, 没有队友就不写合作一节", () => {
  const tpl = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "play", "brief-zh.md"), "utf8");
  const en = "# You are playing Factorio\r\n\r\n## Reference topics\r\n\r\n`./fh help TOPIC` prints a topic; `./fh help ACTION` its arguments.\r\n\r\n- `building`, placing: `build`.\r\n\r\n## Your shell (Claude Code)\r\n";
  const two = adaptBriefZh(tpl, en, { ours: "## 先读这一节", player: "ai2", teammate: "MK", teammateNotes: "../a/notes.md", role: "研究", p1: "MK" });
  assert.equal(two.match(/\{\{[A-Z_]+\}\}/g), null);
  assert.ok(two.includes("- `building`: placing") && !two.includes("prints a topic"));
  assert.ok(two.includes("你是 `ai2`; 队友是 `MK`") && two.includes("## Compact instructions"));
  // 5 个人的班不写"那个队友", 笔记路径也不只给一个 (2026-11-05 发现)
  const five = adaptBriefZh(tpl, en, { ours: "", player: "c", teammate: "MK", teammateNotes: "../a/notes.md", p1: "MK", team: "`MK`、`b`、`c`、`d`、`e`" });
  assert.ok(!five.includes("队友是") && !five.includes("`../a/notes.md`") && five.includes("../<他的目录"));
  const one = adaptBriefZh(tpl, en, { ours: "", player: "MK", p1: "MK" });
  assert.ok(!one.includes("## 合作"));
});

test("截止时间写成数字时区 (派对把 CST 当美国中部时间)", () => {
  assert.match(deadlineText(Date.UTC(2026, 10, 3, 3, 58)), /^2026-11-0\d \d{2}:\d{2} [+-]\d{2}:\d{2}$/);
});

test("journal 的请求 / 回复配成一条, 等待里的轮询标 wait", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fp-journal-")), "journal.jsonl");
  const rows = [
    { at: "2026-11-03T03:28:21.000Z", event: "request", request: { id: "1", action: "sleep", args: { ticks: 60 } } },
    { at: "2026-11-03T03:28:21.050Z", event: "response", response: { id: "1", ok: false, tick: 5, error: { code: "action_failed", message: "unknown argument ticks" } } },
    { at: "2026-11-03T03:28:22.000Z", event: "request", request: { id: "2", action: "status", args: {} } },
    { at: "2026-11-03T03:28:22.010Z", event: "response", response: { id: "2", ok: true, tick: 6 } },
    { at: "2026-11-03T03:28:23.000Z", event: "help", topic: "building" },
  ];
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = journalToRequests(f, "a");
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].action, out[0].ok, out[0].ms, out[0].error], ["sleep", false, 50, "action_failed: unknown argument ticks"]);
  assert.equal(out[1].wait, true);
});
