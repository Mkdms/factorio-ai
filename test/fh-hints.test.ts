// ./fh 回复后面附的东西 (src/play/fh-hints.ts)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { labRoot } from "../src/lab/gamedir.ts";
import { buildHint, builtMachine, dueHint, errorHint, forgetShown, handFact, hintText, lookupHint, lookupQuery, parseLayout, pickLayouts, replyExtras, teamFact } from "../src/play/fh-hints.ts";

const call = (o: unknown) => ["call", "build", "--args", JSON.stringify(o), "--wait"];
const ROW1 = "240. [生成] 组装机排 机自科技包（红瓶） × 6 / 组装机1型 / 电力机械臂×1 出×1 / 基础传送带 / 单排 | 20x7 | 66 个实体 | 实测出 36/分, 吃 iron-gear-wheel 36 copper-plate 36/分, 电 0.484 MW";
const ROW2 = "241. [生成] 组装机排 机自科技包（红瓶） × 12 / 组装机1型 / 电力机械臂×1 出×1 / 基础传送带 / 双排 | 20x13 | 120 个实体 | 实测出 72/分, 吃 x";
const ROW3 = "204. [生成] 组装机排 机自科技包（红瓶） × 6 / 组装机2型 / 电力机械臂×1 出×1 / 基础传送带 / 单排 | 20x7 | 66 个实体 | 实测出 54/分";

// 2026-11-05 sh 版 ./fh 不带 .env, 提示抛错被吞, Claude / Deepseek / Glm 一条都没收到; 单元测试的环境有 .env 变量所以没发现。这里照模型的环境跑: 去掉 .env 里的变量
test("模型走的 ./fh: 没有 .env 变量也发得出提示 (本机有蓝图和游戏数据才跑)", { skip: !fs.existsSync(path.join(import.meta.dirname, "..", ".env")) && "没有 .env" }, () => {
  const repo = path.join(import.meta.dirname, "..");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fp-hints-shim-"));
  fs.writeFileSync(path.join(d, "fake-cli.mjs"), "console.log('ok');\n");
  const names = new Set(fs.readFileSync(path.join(repo, ".env"), "utf8").split(/\r?\n/).map((l) => l.split("=")[0].trim()));
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !names.has(k) && k !== "LAB_DATA_DIR"));
  Object.assign(env, { FH_CLI: path.join(d, "fake-cli.mjs"), FH_PROTO: path.join(labRoot(), "prototypes") });
  const r = spawnSync(process.execPath, [path.join(repo, "src", "play", "fh-shim.ts"), ...call({ item: "assembling-machine-1", recipe: "electronic-circuit" })], { cwd: d, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(d, ".fh-hints.err")), false, fs.existsSync(path.join(d, ".fh-hints.err")) ? fs.readFileSync(path.join(d, ".fh-hints.err"), "utf8") : "");
  assert.match(r.stdout, /提示 \(工具给的/);
  assert.match(r.stdout, /算好的/);
  assert.match(r.stdout, /相关经验/);
  // 联机服务器基地的那段只在本机, 公开仓库没有 (别人克隆后就没有这一句)
  if (fs.existsSync(path.join(labRoot(), "blueprints", "friend-demo.txt")) || fs.existsSync(path.join(labRoot(), "friend-world", "index.json"))) assert.match(r.stdout, /真实的一段/);
  fs.rmSync(d, { recursive: true });
});

test("给程序读的 ./fh 不附东西: --format json、FH_MAX_OUTPUT=0、失败时也是 (开班生成 describe.json 靠它)", { skip: !fs.existsSync(path.join(import.meta.dirname, "..", ".env")) && "没有 .env" }, () => {
  const repo = path.join(import.meta.dirname, "..");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fp-hints-json-"));
  fs.writeFileSync(path.join(d, "fake-cli.mjs"), "console.log('{\"ok\":false}'); process.exit(1);\n");
  const env = { ...process.env, FH_CLI: path.join(d, "fake-cli.mjs"), FH_PROTO: path.join(labRoot(), "prototypes") };
  const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [path.join(repo, "src", "play", "fh-shim.ts"), ...args], { cwd: d, env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 }).stdout;
  assert.equal(run(["call", "describe", "--format", "json"]).trim(), '{"ok":false}');
  assert.equal(run(["call", "describe"], { FH_MAX_OUTPUT: "0" }).trim(), '{"ok":false}');
  assert.match(run(["call", "transfer", "--args", "{}"]), /查法: \.\/know transfer/, "普通命令失败才带查法");
  fs.rmSync(d, { recursive: true });
});

test("认出放的是不是机器: 单个、批量、带配方、位置、台数; 传送带和坏 JSON 不算", () => {
  assert.deepEqual(builtMachine(call({ item: "assembling-machine-1", recipe: "iron-gear-wheel", position: { x: 1, y: 2 } })), { item: "assembling-machine-1", recipe: "iron-gear-wheel", position: { x: 1, y: 2 }, count: 1 });
  assert.deepEqual(builtMachine(call({ builds: [{ item: "stone-furnace", position: { x: 0, y: 0 } }, { item: "stone-furnace", position: { x: 2, y: 0 } }] })), { item: "stone-furnace", position: { x: 0, y: 0 }, count: 2 });
  assert.equal(builtMachine(call({ item: "transport-belt" })), null);
  assert.equal(builtMachine(["call", "build", "--args", "{坏的"]), null);
  assert.equal(builtMachine(["call", "build"]), null);
});

test("不刷屏: 同一种 10 分钟一次, 一个角色 3 分钟最多一条", () => {
  const s = {};
  const T = 1_000_000_000;
  assert.equal(dueHint(s, "a", T), true);
  assert.equal(dueHint(s, "b", T + 60_000), false, "3 分钟内别的也不说");
  assert.equal(dueHint(s, "b", T + 181_000), true);
  assert.equal(dueHint(s, "a", T + 400_000), false, "同一种没到 10 分钟");
  assert.equal(dueHint(s, "a", T + 601_000), true);
});

test("摆法: 读 ./bp list 的行; 挑不一样的两种, 同档机器优先; 列的不只一种", () => {
  assert.deepEqual({ ...parseLayout(ROW1)!, text: "" }, { no: 240, size: 6, shape: "单排", tier: "组装机1型", w: 20, h: 7, rate: "实测出 36/分", text: "" });
  assert.equal(parseLayout("1. [CC0 x] Provider | 3x3 | 9 个实体"), null, "没有 × 台数的不算摆法");
  assert.deepEqual(pickLayouts([ROW3, ROW1, ROW2], "组装机1型").map((l) => l.no), [240, 241]);
  assert.deepEqual(pickLayouts([ROW3], "组装机1型").map((l) => l.no), [204], "同档没有就退回别的档");
});

test("提示: 坐标查过才写真坐标, 查不了写 x,y; 几种摆法都给命令; 用不用你定", () => {
  const t = hintText("红瓶", [ROW1, ROW2], "红瓶", { tier: "组装机1型", spots: new Map([[240, { x: 5.5, y: -8.5 }], [241, null]]), study: "automation-science-pack" });
  for (const s of ["用不用你定", "A. ./bp build 240 --at 5.5,-8.5", "B. ./bp build 241 --at x,y", "C. 看真实基地怎么摆再自己设计: ./bp study automation-science-pack", "./plan 红瓶 每分钟"]) assert.ok(t.includes(s), s);
});

const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "fp-hints-")); return { d, stateFile: path.join(d, ".fh-hints.json") }; };

test("放机器提示: 给算好坐标的命令; 状态存在文件里; 蓝图库没有就不说; ./plan 要产物不要机器名", async () => {
  const { d, stateFile } = fresh();
  const deps = { list: (k: string) => (k === "铁齿轮" ? ["244. [生成] 组装机排 铁齿轮 × 3 / 组装机1型 / 单排 | 11x7 | 39 个实体 | 实测出 163/分", "38. [生成] 组装机排 铁齿轮 × 12 / 组装机2型 / 双排 | 20x13 | 9 个实体"] : []), zh: (id: string) => ({ "iron-gear-wheel": "铁齿轮", "assembling-machine-1": "组装机1型" } as Record<string, string>)[id], stateFile, now: 1_000_000_000, site: async () => ({ x: 3.5, y: 4.5 }) };
  const t = (await buildHint(call({ item: "assembling-machine-1", recipe: "iron-gear-wheel", position: { x: 1, y: 1 } }), deps))!;
  for (const s of ["铁齿轮", "./plan 铁齿轮 每分钟", "./bp build 244 --at 3.5,4.5", "用不用你定"]) assert.ok(t.includes(s), s);
  assert.equal(await buildHint(call({ item: "assembling-machine-1", recipe: "iron-gear-wheel" }), { ...deps, now: deps.now + 1000 }), null, "下一次调用也算数");
  assert.equal(await buildHint(call({ item: "stone-furnace" }), { ...deps, now: deps.now + 10_000_000 }), null, "蓝图库没有就不说");
  const furnace = (await buildHint(call({ item: "stone-furnace" }), { ...deps, list: () => ["1. [生成] 冶炼列"], zh: () => "石炉", now: deps.now + 20_000_000 }))!;
  assert.ok(furnace.includes("./plan 要的产物 每分钟") && !furnace.includes("./plan 石炉"), "没带配方: ./plan 要产物, 不写机器名");
  assert.equal(await buildHint(call({ item: "transport-belt" }), deps), null);
  assert.ok(hintText("铁齿轮", ["1. " + "长".repeat(300)]).length < 300);
  fs.rmSync(d, { recursive: true });
});

test("配比和图隔 45 分钟重新给; 压缩后 (forgetShown) 马上重新给; 手放计数留着", async () => {
  const { d, stateFile } = fresh();
  const deps = { list: () => [], zh: () => "铁齿轮", stateFile, now: 1_000_000_000, study: (k: string) => `参考图 ${k}`, calc: () => "算好的" };
  const c = call({ item: "assembling-machine-1", recipe: "iron-gear-wheel" });
  assert.match((await buildHint(c, deps))!, /参考图/);
  assert.equal(await buildHint(c, { ...deps, now: deps.now + 60_000 }), null, "刚给过");
  forgetShown(stateFile);
  assert.match((await buildHint(c, { ...deps, now: deps.now + 120_000 }))!, /参考图/, "压缩后模型不记得了");
  assert.equal(await buildHint(c, { ...deps, now: deps.now + 180_000 }), null);
  assert.match((await buildHint(c, { ...deps, now: deps.now + 120_000 + 46 * 60_000 }))!, /参考图/, "Codex、Grok 看不到压缩: 靠时间");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8"))["n:iron-gear-wheel"], 5, "手放计数不清");
  fs.rmSync(d, { recursive: true });
});

test("手放只报事实: 第 3 台起说一次, 再多 3 台才再说; 不拒绝, 没有 '应该'", async () => {
  const { d, stateFile } = fresh();
  fs.writeFileSync(stateFile, JSON.stringify({ __cmds: 10 }));
  const deps = { list: () => ["244. [生成] 组装机排 铁齿轮 × 3 / 组装机1型 / 单排 | 11x7 | 39 个实体"], zh: (id: string) => ({ "iron-gear-wheel": "铁齿轮", "assembling-machine-1": "组装机1型" } as Record<string, string>)[id], stateFile, now: 1_000_000_000, gap: async () => ({ need: 4, have: 3 }) };
  const c = (n: number) => buildHint(call({ item: "assembling-machine-1", recipe: "iron-gear-wheel", position: { x: 0, y: 0 } }), { ...deps, now: deps.now + n * 60_000 });
  await c(0); // 第 1 台: 提示
  assert.equal(await c(1), null);
  const s = JSON.parse(fs.readFileSync(stateFile, "utf8")); s.__cmds = 25; fs.writeFileSync(stateFile, JSON.stringify(s));
  const fact = (await c(2))!;
  for (const w of ["事实 (工具数的)", "第 3 台组装机1型", "15 条命令", "要 4 台, 场上 3 台", "块 244 一条命令放 3 台"]) assert.ok(fact.includes(w), w);
  assert.doesNotMatch(fact, /应该|必须|不要|别/);
  assert.equal(await c(3), null, "没再多 3 台");
  assert.match(handFact({ machine: "石炉", n: 3, cmds: 2, gap: null, layout: null, at: null }), /第 3 台石炉/);
  fs.rmSync(d, { recursive: true });
});

test("接到已经在查的地方: recipes / describe / help / technologies; 手册主题不重复附", () => {
  assert.deepEqual(lookupQuery(["call", "recipes", "--args", '{"name":"iron-gear-wheel"}']), { query: "iron-gear-wheel", item: "iron-gear-wheel" });
  assert.deepEqual(lookupQuery(["recipes", "iron-gear-wheel"]), { query: "iron-gear-wheel", item: "iron-gear-wheel" });
  assert.deepEqual(lookupQuery(["help", "belt_route"]), { query: "belt_route" });
  assert.deepEqual(lookupQuery(["call", "describe", "--args", '{"action":"build"}']), { query: "build" });
  assert.deepEqual(lookupQuery(["call", "technologies", "--args", '{"available":true}']), { query: "研究 科技 顺序" });
  assert.equal(lookupQuery(["help", "pilot-production"]), null);
  assert.equal(lookupQuery(["call", "describe", "--format", "json", "--bot", "Test"]), null, "开关的值不是查询词");
  assert.equal(lookupQuery(["call", "status"]), null);
  const state = {};
  const d = { now: 1_000_000_000, know: () => ["[思路 P-1] 比例从满载带倒推"], zh: () => "铁齿轮", hasBlock: () => true };
  const t = lookupHint(["call", "recipes", "--args", '{"name":"iron-gear-wheel"}'], state, d)!;
  for (const s of ["比例从满载带倒推", "./know iron-gear-wheel", "./plan 铁齿轮 每分钟", "./bp list 铁齿轮", "./bp study 铁齿轮"]) assert.ok(t.includes(s), s);
  assert.equal(lookupHint(["help", "build"], state, { ...d, now: d.now + 30_000 }), null, "1 分钟内不再附");
  assert.equal(lookupHint(["call", "recipes", "--args", '{"name":"iron-gear-wheel"}'], state, { ...d, now: d.now + 120_000 }), null, "同一个词 20 分钟一次");
  assert.ok(lookupHint(["help", "build"], state, { ...d, now: d.now + 120_000 }));
});

test("报错给查法: 退出码或 error: 行都算; 命令行写错和聊天不附; 同一个命令 10 分钟一次", () => {
  const state = {};
  const d = { now: 1_000_000_000, know: (q: string) => [`经验 ${q}`] };
  const t = errorHint(["call", "build", "--args", "{}"], "tick: 1\nerror: action_failed: Unknown item name: small-pipe-to-ground", 1, state, d)!;
  assert.match(t, /经验 build small-pipe-to-ground/);
  assert.match(t, /查法: \.\/know build small-pipe-to-ground/);
  assert.match(t, /\.\/fh help build/);
  assert.equal(errorHint(["call", "build"], "error: x", 1, state, { ...d, now: d.now + 1000 }), null);
  assert.equal(errorHint(["call", "transfer"], "ok", 0, state, d), null, "成功的不附");
  assert.equal(errorHint(["status", "--brief"], "error: client_error: fh status does not take --brief", 1, state, d), null);
  assert.equal(errorHint(["say", "你好"], "error: x", 1, state, d), null);
});

test("队友事实: 只报别人的、新的, 5 分钟最多一条, 太旧的不说", () => {
  const T = 1_000_000_000, state = {};
  const rows = [{ at: T - 40 * 60_000, who: "A", text: "太旧" }, { at: T - 60_000, who: "我", text: "我自己" }, { at: T - 30_000, who: "A", text: "A 用 ./bp build 240 一条命令放了 6 台" }];
  const read = () => rows.map((r) => JSON.stringify(r)).join("\n");
  assert.equal(teamFact(state, T, "我", read), "队友: A 用 ./bp build 240 一条命令放了 6 台");
  rows.push({ at: T + 1000, who: "B", text: "B 放了" });
  assert.equal(teamFact(state, T + 2000, "我", read), null, "5 分钟内不再说");
  assert.equal(teamFact(state, T + 5 * 60_000 + 1, "我", read), "队友: B 放了");
  assert.equal(teamFact(state, T + 11 * 60_000, "我", read), null, "没有新的");
  assert.equal(teamFact({}, T, "我", () => { throw new Error("没有文件"); }), null);
});

test("回复附加: 普通命令不加载知识库和蓝图库 (大多数 ./fh 不该变慢); 动作计数", async () => {
  const { d, stateFile } = fresh();
  let loaded = 0;
  const load = async () => { loaded++; throw new Error("不该加载"); };
  assert.equal(await replyExtras(["call", "status"], "ok", 0, { stateFile, now: 1, me: "x", load }), null);
  assert.equal(await replyExtras(["call", "transfer", "--args", "{}"], "ok", 0, { stateFile, now: 2, me: "x", load }), null);
  assert.equal(loaded, 0);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).__cmds, 1, "status 不算, transfer 算");
  fs.rmSync(d, { recursive: true });
});
