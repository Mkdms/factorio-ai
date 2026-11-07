#!/usr/bin/env node
// 把本机一份存档的基地导成 ./bp study 能读的布局。
//   npm run play:world-export [-- --save 存档.zip] [--out 目录]
// 默认读 play:online --keep-map 留的 <lab-data>/friend-world/map.zip。只在本机沙盘开这份存档, 不碰别人的服务器; 结果只在 lab-data, 不进仓库, 也不进备份。
// 每个地表一个 <地表>.json ({entities: [...]}, 世界坐标, 字段和蓝图实体一样), 加一个 index.json (哪种东西哪个地表有几台)。
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { LabInstance, labRoot } from "../lab/instance.ts";
import { loadRules } from "../blueprint/rules.ts";
import type { BpEntity } from "../blueprint/inspect.ts";
import { machineKey, placeAll } from "./layout-study.ts";

const { values } = parseArgs({ options: { save: { type: "string" }, out: { type: "string" } } });
const out = values.out ?? path.join(labRoot(), "friend-world");
const save = values.save ?? path.join(out, "map.zip");
if (!fs.existsSync(save)) { console.error(`没有存档 ${save}: 先 npm run play:online -- --server --read-only --keep-map`); process.exit(2); }
const LOCK = path.join(labRoot(), "GAME_LOCK");
if (fs.existsSync(LOCK)) { console.error(`游戏锁被占: ${fs.readFileSync(LOCK, "utf8").trim()}`); process.exit(2); }
const lockText = `world-export pid ${process.pid}`;
fs.writeFileSync(LOCK, lockText);
process.on("exit", () => { try { if (fs.readFileSync(LOCK, "utf8") === lockText) fs.rmSync(LOCK); } catch { /* 已删 */ } });

// 机器人、货舱这些自己会动的不算布局; 铁轨太多, 字符图也不画
const SKIP_TYPES = ["character", "logistic-robot", "construction-robot", "combat-robot", "cargo-pod", "rocket-silo-rocket", "rocket-silo-rocket-shadow", "entity-ghost", "tile-ghost", "item-request-proxy", "deconstructible-tile-proxy", "straight-rail", "curved-rail-a", "curved-rail-b", "half-diagonal-rail", "elevated-straight-rail", "elevated-curved-rail-a", "elevated-curved-rail-b", "elevated-half-diagonal-rail", "rail-ramp", "rail-support", "car", "tank", "spider-vehicle", "locomotive", "cargo-wagon", "fluid-wagon", "artillery-wagon", "corpse", "character-corpse"];
const dumpLua = (surface: string) => `local s = game.get_surface(${JSON.stringify(surface)})
local SKIP = {} for _, t in pairs(${"{" + SKIP_TYPES.map((t) => JSON.stringify(t)).join(",") + "}"}) do SKIP[t] = true end
local CRAFT = {["assembling-machine"] = true, furnace = true, ["rocket-silo"] = true}
local file = ${JSON.stringify(`friend-world/${surface}.jsonl`)}
helpers.write_file(file, "")
local buf, n = {}, 0
for _, e in pairs(s.find_entities_filtered{force = "player"}) do
  if not SKIP[e.type] then
    local row = {name = e.name, position = {x = e.position.x, y = e.position.y}, direction = e.direction}
    if CRAFT[e.type] then local r = e.get_recipe() or (e.type == "furnace" and e.previous_recipe) if r then row.recipe = r.name end end
    if e.type == "underground-belt" then row.type = e.belt_to_ground_type end
    buf[#buf + 1] = helpers.table_to_json(row)
    n = n + 1
    if #buf >= 2000 then helpers.write_file(file, table.concat(buf, "\\n") .. "\\n", true) buf = {} end
  end
end
if #buf > 0 then helpers.write_file(file, table.concat(buf, "\\n") .. "\\n", true) end
return n`;

const lab = new LabInstance({ name: "friend", view: false, label: "导出全图布局" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  lab.prepare();
  fs.copyFileSync(save, lab.savePath("m"));
  const t0 = Date.now();
  await lab.start("m");
  console.log(`存档起来了, ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  await lab.rpc("time", { paused: true });
  const meta = await lab.exec(`local out = {tick = game.tick, surfaces = {}} for _, s in pairs(game.surfaces) do out.surfaces[#out.surfaces + 1] = s.name end return out`) as { tick: number; surfaces: string[] };
  fs.mkdirSync(out, { recursive: true });
  const rules = loadRules();
  const index = { at: new Date().toISOString(), tick: meta.tick, hours: Math.round(meta.tick / 216000), surfaces: [] as { name: string; entities: number; machines: number }[], keys: {} as Record<string, Record<string, number>> };
  const so = path.join(lab.dir, "script-output", "friend-world");
  for (const name of meta.surfaces) {
    const n = await lab.exec(dumpLua(name), undefined, { timeoutMs: 300_000 }) as number;
    await sleep(300); // helpers.write_file 下一 tick 才落盘; 暂停时靠 RCON 这一 tick
    const f = path.join(so, `${name}.jsonl`);
    const entities = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as BpEntity) : [];
    if (entities.length !== n) console.log(`${name}: 游戏里 ${n} 件, 文件 ${entities.length} 件 (对不上)`);
    let machines = 0;
    for (const p of placeAll(entities, rules)) {
      const k = machineKey(p);
      if (!k) continue;
      machines++;
      (index.keys[k] ??= {})[name] = (index.keys[k][name] ?? 0) + 1;
    }
    if (!entities.length) continue;
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ entities }));
    index.surfaces.push({ name, entities: entities.length, machines });
    console.log(`${name}: ${entities.length} 件, 机器 ${machines}`);
  }
  fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index));
  console.log(`写好了 ${out}; 游戏 ${index.hours} 小时, ${index.surfaces.length} 个地表, ${Object.keys(index.keys).length} 种生产线`);
} finally {
  await lab.stop({ save: false }).catch(() => undefined);
}
process.exit(0);
