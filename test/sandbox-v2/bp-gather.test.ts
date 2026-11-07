// ./bp build 自己备料 (src/play/bp-gather.ts) 对真游戏 2.1.24: 背包空, 箱子里只有原料, 一条命令拿料、手搓、建好。不开窗口。npm run test:sandbox
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LabInstance } from "../../src/lab/instance.ts";

// 贴蓝图要 is_chunk_charted: 没玩家连着的无界面服务器探不了图 (2.1.24 实测 force.chart、chart_all、雷达都不变真, docs/lab.md), 所以整块建好这项要开窗口跑: BP_GATHER_VIEW=1
const VIEW = process.env.BP_GATHER_VIEW === "1";
const lab = new LabInstance({ name: "test-bp-gather", view: VIEW, repoMods: ["agent-harness-party"] });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-bp-gather-"));
const session = path.join(tmp, "session.json");
const repo = path.join(import.meta.dirname, "..", "..");
const count = async (name: string) => Number(await lab.exec(`return game.surfaces[1].count_entities_filtered{name = "${name}", force = "player"}`));
const bp = (...args: string[]) => spawnSync(process.execPath, ["--env-file-if-exists=.env", "src/play/bp.ts", ...args], { cwd: repo, encoding: "utf8", timeout: 600_000, env: { ...process.env, FP_SESSION: session } });

before(async () => {
  await lab.createMap("t", { seed: 7 });
  await lab.start("t");
  await lab.rpc("time", { speed: 1, paused: false }); // 服务器没人连时默认停着, 探图和走路都要时间在走
  await lab.exec(`local s = game.surfaces[1] s.peaceful_mode = true
    s.request_to_generate_chunks({0, 0}, 8) s.force_generate_chunk_requests()
    game.forces.player.chart(s, {{-128, -128}, {128, 128}})
    for _, t in pairs({"automation", "electronics", "logistics"}) do local x = game.forces.player.technologies[t] if x then x.researched = true end end
    return true`);
  await new Promise((r) => setTimeout(r, 3000)); // 探图要过几个 tick
  await lab.exec(`return remote.call("agent_harness", "bot_create", "Test")`);
  // 只放原料: 块 244 (铁齿轮 × 3) 要 组装机1型*3 电力机械臂*12 基础传送带*20 小型电线杆*4
  await lab.exec(`local s = game.surfaces[1]
    for _, e in pairs(s.find_entities_filtered{area = {{-12, -12}, {12, 12}}, type = {"tree", "simple-entity"}}) do e.destroy() end
    local c = s.create_entity{name = "steel-chest", position = {4.5, 4.5}, force = "player"}
    c.insert{name = "iron-plate", count = 400} c.insert{name = "copper-plate", count = 100} c.insert{name = "wood", count = 10}
    return true`);
  fs.writeFileSync(session, JSON.stringify({ rconPort: lab.rconPort, password: lab.password, bot: "Test", player: 1, logDir: tmp }));
});
after(() => { lab.stop({ save: false }); fs.rmSync(tmp, { recursive: true, force: true }); });

test("背包空, 箱子里只有原料: ./bp build 拿料、手搓, 搓完再跑一次建好", { skip: VIEW ? false : "要开窗口: BP_GATHER_VIEW=1" }, async () => {
  const before0 = await count("assembling-machine-1");
  // 退出码 2 = 还在手搓, 这条命令先结束 (不干等); 模型搓完再跑同一条
  let r = bp("build", "244", "--at", "16.5,16.5");
  for (let i = 0; i < 40 && r.status === 2; i++) { await new Promise((res) => setTimeout(res, 10_000)); r = bp("build", "244", "--at", "16.5,16.5"); }
  console.log(r.stdout.slice(0, 1200), r.stderr.slice(0, 400));
  assert.equal(r.status, 0, r.stdout.slice(-400));
  assert.match(r.stdout, /建好了/);
  assert.equal((await count("assembling-machine-1")) - before0, 3);
  assert.ok((await count("transport-belt")) >= 20);
});

test("料不够: 如实报还缺什么, 不放半块", async () => {
  await lab.exec(`local s = game.surfaces[1] s.find_entity("steel-chest", {4.5, 4.5}).clear_items_inside()
    for _, c in pairs(s.find_entities_filtered{type = "character"}) do c.clear_items_inside() end return true`);
  const machines = await count("assembling-machine-1");
  const r = bp("build", "244", "--at", "60.5,60.5");
  console.log(r.stdout.slice(0, 800));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /还缺/);
  assert.equal(await count("assembling-machine-1"), machines);
});

test("--no-gather: 缺就报, 不去拿", () => {
  const r = bp("build", "244", "--at", "60.5,60.5", "--no-gather");
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /备料: /);
  assert.match(r.stdout, /还缺/);
});
