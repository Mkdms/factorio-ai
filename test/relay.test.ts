// 不装模组那条路的连续换班 (core/run/relay.ts): 用假的一班代替 online.ts (写 current-run.json 和 end.json), 核停 / 续的规矩
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createGroup } from "../src/play/groups.ts";

const RELAY = path.join(import.meta.dirname, "..", "core", "run", "relay.ts");

/** 假的一班: 按 plan.json 里第 n 班的写法收工 (why: 写进 end.json; crash: 不写 end.json 退出码 1) */
const FAKE = `import fs from "node:fs"; import path from "node:path";
const play = path.join(process.env.DATA_DIR, "play");
const plan = JSON.parse(fs.readFileSync(path.join(play, "plan.json"), "utf8"));
const n = fs.readdirSync(path.join(play, "runs")).length;
const runDir = path.join(play, "runs", "2026-11-08T00-00-0" + n); fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(play, "current-run.json"), JSON.stringify({ runId: path.basename(runDir), runDir, startedAt: new Date().toISOString() }));
fs.appendFileSync(path.join(play, "args.txt"), process.argv.slice(2).join(" ") + "\\n");
const step = plan[n] ?? { why: "STOP" };
if (step.stopAfter) fs.writeFileSync(path.join(play, "STOP_AFTER"), "");
if (step.crash) process.exit(1);
fs.writeFileSync(path.join(runDir, "end.json"), JSON.stringify({ why: step.why }));
`;

function setup(plan: object[]) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "relay-"));
  const play = path.join(data, "play");
  fs.mkdirSync(path.join(play, "runs"), { recursive: true });
  const g = createGroup(play, { name: "测试", kind: "new", seats: [{ brain: "none" }] });
  fs.writeFileSync(path.join(play, "plan.json"), JSON.stringify(plan));
  const fake = path.join(data, "fake-shift.mjs");
  fs.writeFileSync(fake, FAKE);
  const r = spawnSync(process.execPath, [RELAY, "--group", g.id], { env: { ...process.env, DATA_DIR: data, RELAY_CHILD: fake, RELAY_RETRY_MS: "10" }, encoding: "utf8", timeout: 60_000 });
  const shifts = fs.readFileSync(path.join(play, "args.txt"), "utf8").trim().split("\n");
  return { r, shifts, play };
}

test("到点就接着开下一班, 停班就停; 接力标记收走", () => {
  const { r, shifts, play } = setup([{ why: "到点" }, { why: "到点" }, { why: "STOP" }]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(shifts.length, 3);
  assert.match(r.stdout, /停班/);
  assert.equal(fs.existsSync(path.join(play, "relay.json")), false);
});

test("关了游戏窗口 = 停班", () => {
  const { shifts } = setup([{ why: "客户端关了" }, { why: "到点" }]);
  assert.equal(shifts.length, 1);
});

test("一班异常退出接着开, 连续 3 班异常才停; 中间好了就重新数", () => {
  assert.equal(setup([{ crash: true }, { crash: true }, { crash: true }, { why: "到点" }]).shifts.length, 3);
  assert.equal(setup([{ crash: true }, { why: "到点" }, { crash: true }, { crash: true }, { why: "STOP" }]).shifts.length, 5);
});

test("STOP_AFTER: 跑完这一班就停, 标记用完删掉", () => {
  const { shifts, play } = setup([{ why: "到点", stopAfter: true }, { why: "到点" }]);
  assert.equal(shifts.length, 1);
  assert.equal(fs.existsSync(path.join(play, "STOP_AFTER")), false);
});

test("第二班起接上一班: 参数里带 --group (onlineStartArgs 每班重新算)", () => {
  const { shifts } = setup([{ why: "到点" }, { why: "STOP" }]);
  assert.ok(shifts.every((s) => s.includes("--group") && s.includes("--lab")));
});
