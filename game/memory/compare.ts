// 读内存实体细节的核对 (库, test/sandbox/memory.test.ts 用): RCON 真值怎么读、怎么逐项比。纯比较函数有单元测试 (test/memory.test.ts)。
import { memStatus, type Raw } from "./status.ts";

export type Stack = { name: string; quality?: string; count: number };
/** 真实基地里见不到的状态, 现摆一组 (只改沙盘这一份存档的副本): 没电、低电、没配方、没燃料、没矿、没弹药、等拆除、等料、等空间 */
export const FIXTURE_LUA = `local s = game.surfaces[1] local f = "player" local ox, oy = 1600, 1600
s.request_to_generate_chunks({ox + 30, oy + 30}, 3) s.force_generate_chunk_requests()
for _, e in pairs(s.find_entities_filtered{area = {{ox - 6, oy - 6}, {ox + 70, oy + 70}}}) do if e.type ~= "character" then e.destroy() end end
s.set_tiles((function() local t = {} for x = ox - 6, ox + 70 do for y = oy - 6, oy + 70 do t[#t + 1] = {name = "landfill", position = {x, y}} end end return t end)())
local function put(name, x, y, extra) local a = {name = name, position = {ox + x, oy + y}, force = f} for k, v in pairs(extra or {}) do a[k] = v end return s.create_entity(a) end
local function grid(x, y, kw) local e = put("electric-energy-interface", x, y) e.power_production = kw * 1000 / 60 e.electric_buffer_size = kw * 1000 e.power_usage = 0 put("medium-electric-pole", x + 2, y) return e end
-- 没接电
put("assembling-machine-2", 0, 0)
put("assembling-machine-2", 4, 0, {recipe = "iron-gear-wheel"})
put("lab", 8, 0) put("inserter", 12, 0) put("electric-mining-drill", 15, 0)
-- 有电的一组
grid(0, 10, 100000)
local a1 = put("assembling-machine-2", 5, 10) -- 没配方
local a2 = put("assembling-machine-2", 9, 10, {recipe = "iron-gear-wheel"}) -- 没料
local a3 = put("assembling-machine-2", 13, 10, {recipe = "iron-gear-wheel"}) a3.insert{name = "iron-plate", count = 40} -- 做着
local a4 = put("assembling-machine-2", 17, 10, {recipe = "iron-gear-wheel"}) a4.insert{name = "iron-gear-wheel", count = 200} a4.insert{name = "iron-plate", count = 40} -- 出料满
for x = 5, 19, 2 do put("medium-electric-pole", x, 13) end
local l1 = put("lab", 21, 10)
-- 机械臂: 从空箱拿 / 手里有东西放不进满的箱子
put("medium-electric-pole", 0, 20)
local c1 = put("iron-chest", 2, 20) put("inserter", 3, 20, {direction = defines.direction.west}) local c2 = put("iron-chest", 4, 20)
local c3 = put("iron-chest", 7, 20) c3.insert{name = "iron-plate", count = 100} put("inserter", 8, 20, {direction = defines.direction.west}) local c4 = put("iron-chest", 9, 20) for i = 1, 32 do c4.insert{name = "wood", count = 100} end
-- 烧的
put("stone-furnace", 0, 30) local f1 = put("stone-furnace", 3, 30) f1.insert{name = "iron-ore", count = 10}
local f2 = put("stone-furnace", 6, 30) f2.insert{name = "coal", count = 5}
local f3 = put("stone-furnace", 9, 30) f3.insert{name = "coal", count = 5} f3.insert{name = "iron-ore", count = 10}
for x = 12, 18 do for y = 28, 34 do s.create_entity{name = "iron-ore", position = {ox + x, oy + y}, amount = 500} end end
put("burner-mining-drill", 13, 30) local d2 = put("burner-mining-drill", 16, 30) d2.insert{name = "coal", count = 5}
put("electric-mining-drill", 13, 33) put("burner-mining-drill", 24, 30)
-- 炮塔、等拆除
put("gun-turret", 0, 40) local t2 = put("gun-turret", 3, 40) t2.insert{name = "firearm-magazine", count = 10}
local c5 = put("iron-chest", 6, 40) c5.order_deconstruction(f)
-- 低电: 电源太小, 六台机器一起抢
grid(0, 50, 30)
for i = 0, 5 do local a = put("assembling-machine-2", 5 + i * 4, 50, {recipe = "iron-gear-wheel"}) a.insert{name = "iron-plate", count = 100} end
for x = 5, 25, 3 do put("medium-electric-pole", x, 53) end
return true`;
/** 服务器上按实体读一遍真值 (沙盘 RCON; 只读) */
export const DETAIL_TRUTH_LUA = `local s = game.surfaces[1]
local function list(inv) if not inv then return {} end local out = {} for _, it in pairs(inv.get_contents()) do out[#out + 1] = {name = it.name, quality = it.quality, count = it.count} end return out end
local function try(f, ...) local ok, v = pcall(f, ...) if ok then return v end return nil end
local TYPES = {"assembling-machine", "furnace", "mining-drill", "lab", "inserter", "transport-belt", "underground-belt", "splitter", "container", "logistic-container", "boiler", "generator", "ammo-turret", "character", "electric-pole", "pipe", "pipe-to-ground", "radar", "offshore-pump"}
local out = {}
for _, e in pairs(s.find_entities_filtered{type = TYPES}) do
  local r = {unit = e.unit_number, name = e.name, type = e.type, x = e.position.x, y = e.position.y, direction = e.direction, health = e.health, status = e.status, quality = e.quality and e.quality.name, energy = e.energy}
  local t = e.type
  if t == "assembling-machine" or t == "furnace" then
    local rec = e.get_recipe() r.recipe = rec and rec.name or nil r.done = e.products_finished
    r.input = list(e.get_inventory(defines.inventory.crafter_input)) r.output = list(e.get_inventory(defines.inventory.crafter_output))
  elseif t == "lab" then r.input = list(e.get_inventory(defines.inventory.lab_input))
  elseif t == "container" or t == "logistic-container" then r.chest = list(e.get_inventory(defines.inventory.chest))
  elseif t == "ammo-turret" then r.ammo = list(e.get_inventory(defines.inventory.turret_ammo))
  elseif t == "character" then r.main = list(e.get_inventory(defines.inventory.character_main)) r.guns = list(e.get_inventory(defines.inventory.character_guns)) r.ammo = list(e.get_inventory(defines.inventory.character_ammo)) r.armor = list(e.get_inventory(defines.inventory.character_armor))
  elseif t == "inserter" then local h = e.held_stack r.held = h and h.valid_for_read and {name = h.name, count = h.count} or nil
  elseif t == "transport-belt" then r.lines = {list(e.get_transport_line(1)), list(e.get_transport_line(2))}
  end
  local fi = try(e.get_fuel_inventory) if fi then r.fuel = list(fi) end
  local bi = try(e.get_burnt_result_inventory) if bi then r.burnt = list(bi) end
  r.has_network = e.is_connected_to_electric_network and try(e.is_connected_to_electric_network) or nil
  out[#out + 1] = r
end
local res = {}
for _, e in pairs(s.find_entities_filtered{type = "resource"}) do res[#res + 1] = {name = e.name, x = e.position.x, y = e.position.y, amount = e.amount} end
return {rows = out, resources = res}`;

/** 同一批东西, 不管顺序; 品质没写算普通 */
export const bag = (list: unknown): string[] => (Array.isArray(list) ? (list as Stack[]) : []).map((s) => `${s.name}@${s.quality ?? "normal"}*${s.count}`).sort();
const sameBag = (a: unknown, b: unknown) => JSON.stringify(bag(a)) === JSON.stringify(bag(b));
/** 两个数差不多 */
export const close = (a: unknown, b: unknown, tol: number) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol;

export type Field = { name: string; compared: number; bad: number; examples: string[] };
export class Tally {
  fields = new Map<string, Field>();
  add(name: string, ok: boolean, example: () => string) {
    const f = this.fields.get(name) ?? { name, compared: 0, bad: 0, examples: [] };
    f.compared++;
    if (!ok) { f.bad++; if (f.examples.length < 4) f.examples.push(example()); }
    this.fields.set(name, f);
  }
  get bad() { return [...this.fields.values()].reduce((n, f) => n + f.bad, 0); }
  get total() { return [...this.fields.values()].reduce((n, f) => n + f.compared, 0); }
}

/** 模组 / Lua 的类型 → 内存读出来的类 (虚表认的) */
export const CLASS_OF: Record<string, string[]> = { "assembling-machine": ["AssemblingMachine"], furnace: ["Furnace"], "mining-drill": ["MiningDrill"], lab: ["Lab"], inserter: ["Inserter"], "transport-belt": ["TransportBelt"], "underground-belt": ["UndergroundBelt"], splitter: ["Splitter"], container: ["ContainerEntity"], "logistic-container": ["LogisticContainer"], boiler: ["Boiler"], generator: ["Generator"], "ammo-turret": ["AmmoTurret"], character: ["Character"], "electric-pole": ["ElectricPole"], pipe: ["Pipe"], "pipe-to-ground": ["PipeToGround"], radar: ["Radar"], "offshore-pump": ["OffshorePump"] };

/** 一个实体逐项比 (t = RCON 真值, d = 内存读的细节) */
export function compareEntity(tally: Tally, t: Record<string, any>, d: Record<string, any> | undefined, tag: string, statusName: (n: number) => string = String) {
  tally.add("认出类 (虚表)", !!d && (CLASS_OF[t.type] ?? []).includes(d.cls), () => `${tag} 类型 ${t.type} 内存 ${d?.cls}`);
  if (!d) return;
  const st = memStatus(d as Raw);
  // 真值的状态有数才比 (电线杆、角色、地下带没有状态)
  if (typeof t.status === "number" && st !== null) tally.add(`状态 ${t.type}`, st === t.status, () => `${tag}: 真值 ${statusName(t.status)} 推算 ${statusName(st)} | ${JSON.stringify({ sleep: d.sleep, flags: d.flags, active: d.active, stored: d.stored, recipeEnergy: d.recipeEnergy, recipe: d.recipe, last: d.last, heldItem: d.heldItem, atPickup: d.atPickup, atDrop: d.atDrop, dropFull: d.dropFull, hasDrop: d.hasDrop, bufferEmpty: d.bufferEmpty, resources: d.resources, stuck: d.stuck, power: d.power && { src: d.power.src, e: d.power.energy, cap: d.power.capacity, burning: d.power.burning, rem: d.power.remaining, net: d.power.network } }).slice(0, 300)}`);
  const check = (name: string, ok: boolean, a: unknown, b: unknown) => tally.add(name, ok, () => `${tag}: 真值 ${JSON.stringify(a)} 内存 ${JSON.stringify(b)}`);
  check("血量", close(t.health, d.health, 0.01), t.health, d.health);
  check("品质", t.quality === d.quality, t.quality, d.quality);
  if (d.direction !== undefined) check(`方向 ${t.type}`, t.direction === d.direction, t.direction, d.direction);
  if ("recipe" in d) check("配方", (t.recipe ?? null) === (d.recipe ?? null), t.recipe, d.recipe);
  if ("done" in d) check("产出次数", t.done === d.done, t.done, d.done);
  if (t.input && d.input) check(`进料 ${t.type}`, sameBag(t.input, d.input), bag(t.input), bag(d.input));
  if (t.output && d.output && t.type !== "mining-drill") check(`出料 ${t.type}`, sameBag(t.output, d.output), bag(t.output), bag(d.output));
  if (t.chest) check("箱子", sameBag(t.chest, d.chest), bag(t.chest), bag(d.chest));
  if (t.type === "ammo-turret") check("炮塔弹药", sameBag(t.ammo, d.ammo), bag(t.ammo), bag(d.ammo));
  if (t.type === "character") for (const k of ["main", "guns", "ammo", "armor"]) check(`角色 ${k}`, sameBag(t[k], d[k]), bag(t[k]), bag(d[k]));
  if (t.type === "inserter") check("机械臂手上", JSON.stringify(t.held ?? null) === JSON.stringify(d.held ?? null), t.held, d.held);
  if (t.type === "transport-belt" && d.lines) { check("带子左道", sameBag(t.lines?.[0], d.lines[0]), bag(t.lines?.[0]), bag(d.lines[0])); check("带子右道", sameBag(t.lines?.[1], d.lines[1]), bag(t.lines?.[1]), bag(d.lines[1])); }
  const p = d.power as Record<string, any> | undefined;
  if (p?.src === "burner") { check("燃料", sameBag(t.fuel, p.fuel), bag(t.fuel), bag(p.fuel)); check("燃烧剩余", sameBag(t.burnt, p.burnt), bag(t.burnt), bag(p.burnt)); }
  if (p?.src === "electric" || p?.src === "burner") check(`能量 ${p.src}`, close(t.energy, p.energy, Math.max(1, Math.abs(t.energy ?? 0) * 0.001)), t.energy, p.energy);
}
