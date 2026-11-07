// 电线杆斜穿空地、地下管道没配上 (库, 不直接运行): 和 belt-lint.ts 一样, 只报事实和坐标。
// 。那班 61 根杆 78 段连线 39 段是斜的; 一对地下管道开口相对, 锅炉一直没水。
// 斜线短的 (机器之间挪一两格) 不报: 两个方向都差 3 格以上才算斜穿; 连接的东西走 Lua 读, 每 5 分钟一次。
export const LAYOUT_LUA = `local s = game.surfaces[1]
  local poles, seen = {}, {}
  local nPoles, nEdges = 0, 0
  for _, e in pairs(s.find_entities_filtered{type = "electric-pole", force = "player"}) do
    nPoles = nPoles + 1
    local c = e.get_wire_connector(defines.wire_connector_id.pole_copper, true)
    for _, w in pairs(c.connections) do
      local o = w.target.owner
      if o.valid and o.type == "electric-pole" then
        local a, b = e.position, o.position
        local first = a.x < b.x or (a.x == b.x and a.y < b.y)
        local k = first and (a.x .. "," .. a.y .. ">" .. b.x .. "," .. b.y) or (b.x .. "," .. b.y .. ">" .. a.x .. "," .. a.y)
        if not seen[k] then
          seen[k] = true
          nEdges = nEdges + 1
          if math.abs(a.x - b.x) >= 3 and math.abs(a.y - b.y) >= 3 and #poles < 200 then poles[#poles + 1] = {x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y} end
        end
      end
    end
  end
  local pipes = {}
  for _, e in pairs(s.find_entities_filtered{name = "pipe-to-ground", force = "player"}) do
    local ok, list = pcall(e.get_fluid_box_pipe_connections, 1)
    if ok and list then
      local joined = 0
      for _, c in pairs(list) do if c.target then joined = joined + 1 end end
      if joined < #list and #pipes < 60 then pipes[#pipes + 1] = {x = e.position.x, y = e.position.y, joined = joined, total = #list} end
    end
  end
  local dry = {}
  for _, e in pairs(s.find_entities_filtered{name = "boiler", force = "player"}) do
    local w = e.get_fluid(1)
    if (not w or w.amount < 1) and #dry < 40 then dry[#dry + 1] = {x = e.position.x, y = e.position.y} end
  end
  local stuck = {}
  for _, f in pairs(s.find_entities_filtered{type = "furnace", force = "player"}) do
    local out = f.get_inventory(defines.inventory.crafter_output).get_item_count()
    if out >= 20 and #stuck < 60 then
      local has = false
      for _, x in pairs(s.find_entities_filtered{area = {{f.position.x - 4, f.position.y - 4}, {f.position.x + 4, f.position.y + 4}}, type = "inserter", force = "player"}) do
        if x.pickup_target == f then has = true break end
      end
      if not has then stuck[#stuck + 1] = {x = f.position.x, y = f.position.y, out = out} end
    end
  end
  local force = game.forces.player
  local t = force.current_research
  local labs = {total = 0, working = 0, unit = t and t.research_unit_energy / 60 or 0, speed = force.laboratory_speed_modifier, research = t and t.name or "", packs = {}}
  for _, l in pairs(s.find_entities_filtered{type = "lab", force = "player"}) do
    labs.total = labs.total + 1
    if l.status == defines.entity_status.working then labs.working = labs.working + 1 end
  end
  if t then
    local st = force.get_item_production_statistics(s)
    local crafters = s.find_entities_filtered{type = "assembling-machine", force = "player"}
    for _, g in pairs(t.research_unit_ingredients) do
      local made, blocked = 0, 0
      for _, c in pairs(crafters) do
        local r = c.get_recipe()
        if r and r.name == g.name then
          made = made + 1
          if c.status == defines.entity_status.full_output then blocked = blocked + 1 end
        end
      end
      labs.packs[#labs.packs + 1] = {name = g.name, machines = made, blocked = blocked, rate = st.get_flow_count{name = g.name, category = "input", precision_index = defines.flow_precision_index.ten_minutes, count = true} / 10}
    end
  end
  return {poles = nPoles, edges = nEdges, diagonal = poles, pipes = pipes, dry = dry, stuck = stuck, labs = labs}`;

export type PoleEdge = { x1: number; y1: number; x2: number; y2: number };
export type PipeEnd = { x: number; y: number; joined: number; total: number };
export type At = { x: number; y: number };
/** 炉子里积了板, 周围没有机械臂取 */
export type StuckFurnace = At & { out: number };
export type LabPack = { name: string; machines: number; blocked: number; rate: number };
export type LabScan = { total: number; working: number; unit: number; speed: number; research: string; packs: LabPack[] };
export type LayoutScan = { poles: number; edges: number; diagonal: PoleEdge[]; pipes: PipeEnd[]; dry: At[]; stuck: StuckFurnace[]; labs: LabScan };

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []); // Lua 空表回来是 {}
export function normalizeLayout(raw: unknown): LayoutScan {
  let o: any = raw;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { o = null; } }
  const l = o?.labs ?? {};
  return { poles: Number(o?.poles) || 0, edges: Number(o?.edges) || 0, diagonal: arr<PoleEdge>(o?.diagonal).filter((e) => Number.isFinite(e?.x1) && Number.isFinite(e?.y2)), pipes: arr<PipeEnd>(o?.pipes).filter((e) => Number.isFinite(e?.x)), dry: arr<At>(o?.dry).filter((e) => Number.isFinite(e?.x)), stuck: arr<StuckFurnace>(o?.stuck).filter((e) => Number.isFinite(e?.x)),
    labs: { total: Number(l.total) || 0, working: Number(l.working) || 0, unit: Number(l.unit) || 0, speed: Number(l.speed) || 0, research: typeof l.research === "string" ? l.research : "", packs: arr<LabPack>(l.packs).filter((p) => typeof p?.name === "string").map((p) => ({ name: p.name, machines: Number(p.machines) || 0, blocked: Number(p.blocked) || 0, rate: Number(p.rate) || 0 })) } };
}

const num = (v: number) => (Math.round(v * 10) / 10).toString();

/** 这项科技研究中心每分钟最多吃几组瓶 */
export const labCapacity = (l: LabScan) => (l.unit > 0 ? (l.total * 60 * (1 + l.speed)) / l.unit : 0);

/**
 * 研究中心和瓶子谁卡谁 (我先拿绿瓶 26.5/分的短时高峰喊"研究中心不够", 加到 8 台后绿瓶掉回 6.7/分):
 * 一组瓶按最少的那种吃, 看最少的那种瓶, 不看最多的; 只有研究中心全在转 **而且每种瓶的机器都有一半以上出口堵着** 才算吃不完。
 * 返回 key (状态变了才报) 和一句事实; 没有研究或没有研究中心 null。
 */
export function labNote(l: LabScan, zh: (id: string) => string = (x) => x): { key: string; text: string } | null {
  if (!l.total || !l.research || !l.packs.length) return null;
  const cap = labCapacity(l);
  const rates = l.packs.map((p) => `${zh(p.name)} ${num(p.rate)}/分`).join("、");
  const head = `研究中心 ${l.working}/${l.total} 台在转, 这项科技 ${num(l.unit)} 秒一单位, 最多吃 ${num(cap)} 组瓶/分; 近 10 分钟产 ${rates}`;
  const low = [...l.packs].sort((a, b) => a.rate - b.rate)[0];
  const allBlocked = l.packs.every((p) => p.machines > 0 && p.blocked * 2 >= p.machines);
  if (l.working === l.total && allBlocked) return { key: `labs-short:${l.total}`, text: `${head}; 每种瓶的机器都有一半以上出口堵着, 瓶子吃不完, 研究中心是瓶颈。摆法和台数看 ./know 研究中心、./bp study 研究中心。` };
  if (l.working < l.total && low.rate < cap * 0.8) return { key: `packs-short:${low.name}`, text: `${head}; 一组瓶按最少的吃, 现在卡在 ${zh(low.name)}, 再加研究中心没用。` };
  return null;
}

/** 炉子积着板却没有机械臂取 (只能手取, 满了就停) */
export function stuckNote(list: StuckFurnace[], max = 4): string | null {
  if (!list.length) return null;
  return `${list.length} 台炉子积着板, 周围没有机械臂取 (只能手取, 满了就停): ${list.slice(0, max).map((f) => `(${f.x},${f.y}) ${f.out} 个`).join("、")}${list.length > max ? " 等" : ""}`;
}

/** 这次新出现的; 修好的从 seen 里去掉, 以后再出现还报 */
export function freshItems<T>(list: T[], seen: Set<string>, key: (x: T) => string): T[] {
  const now = new Set(list.map(key));
  for (const k of [...seen]) if (!now.has(k)) seen.delete(k);
  const fresh = list.filter((x) => !seen.has(key(x)));
  for (const x of fresh) seen.add(key(x));
  return fresh;
}
export const edgeKey = (e: PoleEdge) => `${e.x1},${e.y1}>${e.x2},${e.y2}`;
export const atKey = (e: At) => `${e.x},${e.y}`;

/** 监工发给大脑的一句 (只给事实和坐标; 没有新问题回 null) */
export function layoutNote(poles: PoleEdge[], pipes: PipeEnd[], dry: At[], max = 4): string | null {
  const parts: string[] = [];
  if (poles.length) parts.push(`新出现 ${poles.length} 段电线杆斜着拉: ${poles.slice(0, max).map((e) => `(${e.x1},${e.y1})→(${e.x2},${e.y2})`).join("、")}${poles.length > max ? " 等" : ""}, 用户要横平竖直、沿带子和产线边走, 不切碎空地, 这段改一下`);
  if (pipes.length) parts.push(`${pipes.length} 个地下管道没接好: ${pipes.slice(0, max).map(atKey).map((k) => `(${k})`).join("、")}${pipes.length > max ? " 等" : ""} (direction 是开口朝向, 配对在反方向, 一对要开口朝外)`);
  if (dry.length) parts.push(`${dry.length} 台锅炉没水: ${dry.slice(0, max).map(atKey).map((k) => `(${k})`).join("、")}${dry.length > max ? " 等" : ""}`);
  return parts.length ? `${parts.join("; ")}。` : null;
}
