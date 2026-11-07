// 基地体检 (库, 不直接运行): 只读, 列出用户会截图来问的那些问题 —— ,
// 之前都是用户看截图发现 (没建的虚影、没燃料、采空、研究中心停、出口堵而下游缺料、厂区里没清的树石)。
// 监工每 5 分钟跑一次塞进收件箱 (run.ts); 我汇报前也跑一次 (health-cli.ts)。
export type Health = {
  tick: number;
  ghosts: { key: string; name: string; at: string }[];
  noFuel: string[];
  depleted: string[];
  labs: { total: number; working: number; missingPacks: number };
  full: Record<string, number>;   // 配方 / 炉子 → 出口堵满的台数
  short: Record<string, number>;  // 配方 → 缺料的台数
  noPower: number;
  obstacles: { count: number; at: string[]; box: string };
  marked?: { count: number; at: string[]; bots: number }; // 标了拆除红叉的树石, 和空闲建设机器人数 (第八轮留下 37 个没人来拆)
  belt_ends?: { at: string; items: string; mixed: boolean }[]; // 带子尽头堵死 (第七轮: 主带混装铜和煤, 尽头没出口, 25 个炉子堵满)
};

// 厂区 = 机器 (组装机、炉子、研究中心、锅炉) 圈出来的范围外扩 5 格 (第一次把远处零散的电线杆、带子也算进去, 圈到 150x357)。
// Lua 里不能写 -- 注释: 发送前拼成一行, 注释会吞掉后面所有代码。
export const HEALTH_LUA = `local s = game.surfaces[1] local f = game.forces.player
local st = defines.entity_status
local function at(e) return string.format("%.1f,%.1f", e.position.x, e.position.y) end
local out = {tick = game.tick, ghosts = {}, noFuel = {}, depleted = {}, labs = {total = 0, working = 0, missingPacks = 0}, full = {}, short = {}, noPower = 0}
for _, g in pairs(s.find_entities_filtered{type = "entity-ghost", force = f}) do if #out.ghosts < 200 then out.ghosts[#out.ghosts + 1] = {key = g.ghost_name .. "@" .. at(g), name = g.ghost_name, at = at(g)} end end
local x0, y0, x1, y1
for _, e in pairs(s.find_entities_filtered{force = f, type = {"assembling-machine", "furnace", "lab", "mining-drill", "boiler", "transport-belt", "inserter", "electric-pole"}}) do
  if e.type == "assembling-machine" or e.type == "furnace" or e.type == "lab" or e.type == "boiler" then
    local p = e.position x0 = math.min(x0 or p.x, p.x - 5) y0 = math.min(y0 or p.y, p.y - 5) x1 = math.max(x1 or p.x, p.x + 5) y1 = math.max(y1 or p.y, p.y + 5)
  end
  local ok, status = pcall(function() return e.status end)
  if ok and status then
    if status == st.no_fuel then out.noFuel[#out.noFuel + 1] = e.name .. "(" .. at(e) .. ")" end
    if status == st.no_minable_resources then out.depleted[#out.depleted + 1] = at(e) end
    if status == st.no_power or status == st.low_power then out.noPower = out.noPower + 1 end
    local r = e.type == "assembling-machine" and e.get_recipe() and e.get_recipe().name or (e.type == "furnace" and "炉子") or nil
    if r and status == st.full_output then out.full[r] = (out.full[r] or 0) + 1 end
    if r and (status == st.item_ingredient_shortage or status == st.no_ingredients) then out.short[r] = (out.short[r] or 0) + 1 end
    if e.type == "lab" then out.labs.total = out.labs.total + 1 if status == st.working then out.labs.working = out.labs.working + 1 end if status == st.missing_science_packs then out.labs.missingPacks = out.labs.missingPacks + 1 end end
  end
end
out.obstacles = {count = 0, at = {}, box = ""}
local seen = {}
for _, m in pairs(s.find_entities_filtered{force = f, type = {"assembling-machine", "furnace", "lab", "boiler", "mining-drill"}}) do
  for _, o in pairs(s.find_entities_filtered{position = m.position, radius = 5, type = {"tree", "simple-entity"}}) do
    local k = at(o) if not seen[k] then seen[k] = true out.obstacles.count = out.obstacles.count + 1 if #out.obstacles.at < 5 then out.obstacles.at[#out.obstacles.at + 1] = k end end
  end
end
if x0 then out.obstacles.box = string.format("%.0f,%.0f ~ %.0f,%.0f", x0, y0, x1, y1) end
out.marked = {count = 0, at = {}, bots = 0}
for _, n in pairs(f.logistic_networks[s.name] or {}) do out.marked.bots = out.marked.bots + n.available_construction_robots end
for _, e in pairs(s.find_entities_filtered{type = {"tree", "simple-entity"}, to_be_deconstructed = true}) do out.marked.count = out.marked.count + 1 if #out.marked.at < 5 then out.marked.at[#out.marked.at + 1] = at(e) end end
out.belt_ends = {}
for _, b in pairs(s.find_entities_filtered{force = f, type = {"transport-belt", "underground-belt"}}) do
  local nb = b.belt_neighbours
  local ends = (not nb.outputs or #nb.outputs == 0) and not (b.type == "underground-belt" and b.belt_to_ground_type == "input")
  if ends then
    local kinds, n = {}, 0
    for li = 1, 2 do for _, it in pairs(b.get_transport_line(li).get_contents()) do kinds[it.name] = (kinds[it.name] or 0) + it.count n = n + it.count end end
    local stopped = n >= 6
    local cur, tail = b, {b}
    for _ = 1, 3 do
      if not stopped then break end
      local ins = cur.belt_neighbours.inputs
      cur = ins and ins[1]
      if not cur then break end
      tail[#tail + 1] = cur
      local m = 0 for li = 1, 2 do m = m + cur.get_transport_line(li).get_item_count() end
      if m < 6 then stopped = false end
    end
    local k = 0 for _ in pairs(kinds) do k = k + 1 end
    local taken = false
    if stopped and k == 1 then
      for _, t in pairs(tail) do for _, i in pairs(s.find_entities_filtered{type = "inserter", position = t.position, radius = 2.5, force = f}) do if i.pickup_target == t then taken = true end end end
    end
    if stopped and (k > 1 or not taken) and #out.belt_ends < 10 then local t = {} for name, c in pairs(kinds) do t[#t + 1] = name .. "*" .. c end out.belt_ends[#out.belt_ends + 1] = {at = at(b), items = table.concat(t, " "), mixed = k > 1} end
  end
end
return out`;

/** Lua 的空表转成 JSON 是 {} 不是 [] (第八轮: 场上没虚影时监工体检 "object is not iterable", 整轮体检都没进收件箱): 列表字段规整成数组 */
export function normalizeHealth(h: Health): Health {
  const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? x : []);
  return {
    ...h,
    ghosts: arr(h.ghosts), noFuel: arr(h.noFuel), depleted: arr(h.depleted), belt_ends: arr(h.belt_ends),
    full: h.full ?? {}, short: h.short ?? {},
    obstacles: h.obstacles ? { ...h.obstacles, at: arr(h.obstacles.at) } : { count: 0, at: [], box: "" },
    marked: h.marked ? { ...h.marked, at: arr(h.marked.at) } : { count: 0, at: [], bots: 0 },
  };
}

/** 体检结果的中文清单 (问题在前, 没问题的不写); oldGhosts = 已经放了很久还没建的; zh = 内部名 → 官方中文名 (chattags.loadZhNames) */
export function healthLines(h: Health, oldGhosts: { name: string; at: string }[] = [], zh: (n: string) => string = (n) => n): string[] {
  const L: string[] = [];
  const named = (s: string) => s.replace(/^[^(]+/, (n) => zh(n)); // "stone-furnace(-13.0,-64.0)" → "石炉(-13.0,-64.0)"
  if (oldGhosts.length) L.push(`没建的虚影 ${oldGhosts.length} 个放了 5 分钟以上: ${oldGhosts.slice(0, 6).map((g) => `${zh(g.name)}(${g.at})`).join("、")}${oldGhosts.length > 6 ? " …" : ""} —— construct 那一块建掉, 或者拆掉不要的`);
  if (h.noFuel.length) L.push(`缺燃料 ${h.noFuel.length} 台: ${h.noFuel.slice(0, 6).map(named).join("、")}${h.noFuel.length > 6 ? " …" : ""}`);
  if (h.depleted.length) L.push(`采矿机采空 ${h.depleted.length} 台: ${h.depleted.slice(0, 6).map((p) => `(${p})`).join("、")}`);
  if (h.labs.total && h.labs.working * 2 < h.labs.total) L.push(`研究中心 ${h.labs.total} 台只有 ${h.labs.working} 台在工作 (${h.labs.missingPacks} 台缺瓶)`);
  const short = Object.entries(h.short ?? {}).sort((a, b) => b[1] - a[1]);
  const full = Object.entries(h.full ?? {}).sort((a, b) => b[1] - a[1]);
  if (short.length) L.push(`缺料: ${short.slice(0, 6).map(([k, v]) => `${zh(k)} ${v} 台`).join("、")}${full.length ? `; 同时出口堵满: ${full.slice(0, 6).map(([k, v]) => `${zh(k)} ${v} 台`).join("、")} (满着的料没送到缺的地方)` : ""}`);
  const be = h.belt_ends ?? [];
  if (be.length) L.push(`带子尽头堵死 ${be.length} 处 (尽头和上游几格都堆满, 带子停了, 上游跟着全停): ${be.slice(0, 5).map((b) => `(${b.at}) ${b.items.replace(/[a-z0-9-]+(?=\*)/g, (n) => zh(n))}${b.mixed ? " [混装]" : ""}`).join("、")} —— 一条道只放一种料, 尽头要有东西吃掉; 混装的把多余的料分走 (过滤机械臂 / 分流器)`);
  if (h.noPower > 0) L.push(`缺电 ${h.noPower} 台 (发电不够或没接上)`);
  if (h.marked?.count && !h.marked.bots) L.push(`标了拆除红叉的树 / 石头 ${h.marked.count} 个, 没有空闲建设机器人, 不会自己消失, 例: ${h.marked.at.map((p) => `(${p})`).join("、")} —— construct 那一块 (area) 走过去手砍`);
  if (h.obstacles?.count > 10) L.push(`机器周围 5 格内还有 ${h.obstacles.count} 个树 / 石头没清, 例: ${h.obstacles.at.map((p) => `(${p})`).join("、")} —— deconstruct (entity_types tree / simple-entity) + construct 整片清掉`);
  return L;
}

/** 体检一行的类别 (行首的词: 缺燃料、采矿机采空、研究中心、缺料、带子尽头堵死、缺电、标了拆除红叉的树…) */
export const healthCategory = (line: string) => line.split(/[\s:：(（]/)[0];

/** 机器和带子 (燃料、采矿、堵、电) 归冶炼和采矿的人 (A), 科研和缺料归科技包线的人 (B) */
export const healthOwner = (line: string) => (/^(研究中心|缺料)/.test(line) ? "science" : "base");

/**
 * 一直没修的体检问题 (; 第十三轮接续第 1 班:
 * 体检每 5 分钟报一次, 炉子出口堵满 12 → 53 台、采空 16 台整班没挪, 两人一直在扩新线): 同一类连续 n 次体检都在 → 点名, 同一类至少隔 gapMs 再点
 */
export class StuckHealth {
  private streak = new Map<string, number>();
  private last = new Map<string, number>();
  private n: number; private gapMs: number;
  constructor(n = 3, gapMs = 900_000) { this.n = n; this.gapMs = gapMs; }
  /** 记一次体检, 返回这次要点名的行 (带连续次数) */
  update(lines: string[], now = Date.now()): { line: string; times: number }[] {
    const seen = new Set(lines.map(healthCategory));
    for (const k of [...this.streak.keys()]) if (!seen.has(k)) this.streak.delete(k);
    const out: { line: string; times: number }[] = [];
    for (const line of lines) {
      const k = healthCategory(line), times = (this.streak.get(k) ?? 0) + 1;
      this.streak.set(k, times);
      if (times >= this.n && now - (this.last.get(k) ?? -Infinity) >= this.gapMs) { this.last.set(k, now); out.push({ line, times }); }
    }
    return out;
  }
}
