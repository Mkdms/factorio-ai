// 读内存的世界数据 (world.py) 和游戏里 RCON 真值逐项比 (库; 沙盘测试和游戏外的模组宿主核对用)。
// 真值由 WORLD_TRUTH_LUA 在同一个暂停的 tick 上读。统计的 get_flow_count 不算在这里: 内存里是采样, 公式另外对。
export type ForceMem = { chart?: { charted: number[][]; fog_timeout: number }; research?: { current: string | null; progress: number; queue: string[] }; technologies?: Record<string, { enabled: boolean; count: number }>; modifiers?: Record<string, number>; evolution?: { factor: number } | null; items?: Flow | null; fluids?: Flow | null; kills?: Flow | null; builds?: Flow | null };
export type Flow = { input: Record<string, number>; output: Record<string, number>; storage: Record<string, number>; precisions: { interval: number; input?: Record<string, ElementMem>; output?: Record<string, ElementMem>; storage?: Record<string, ElementMem> }[] };
export type ElementMem = { cur: number; zeros: number; interval: number; samples: number[] };
export type WorldMem = { tick: number; update_tick: number; ticks_played: number; forces: Record<string, ForceMem>; pollution?: { total: number; stats?: Flow | null }; networks?: Record<string, { flow?: Flow | null }>; errors?: Record<string, string> };

/** 同一 tick 上读真值: 研究、科技、修正、进化度、污染总量、四种统计的累计 + 每种精度的 get_flow_count */
export const WORLD_TRUTH_LUA = `
  local f, s, en = game.forces.player, game.surfaces[1], game.forces.enemy
  local techs = {} for n, t in pairs(f.technologies) do techs[n] = {researched = t.researched, enabled = t.enabled, level = t.level} end
  local mods = {} for _, k in ipairs{"laboratory_speed_modifier", "laboratory_productivity_bonus", "manual_crafting_speed_modifier", "manual_mining_speed_modifier", "character_running_speed_modifier", "character_build_distance_bonus", "character_reach_distance_bonus", "character_resource_reach_distance_bonus", "mining_drill_productivity_bonus", "inserter_stack_size_bonus", "bulk_inserter_capacity_bonus", "worker_robots_speed_modifier", "worker_robots_storage_bonus", "belt_stack_size_bonus", "character_inventory_slots_bonus", "character_health_bonus"} do mods[k] = f[k] end
  local q = {} for i, t in ipairs(f.research_queue or {}) do q[i] = t.name end
  local P = defines.flow_precision_index
  local function flow(st)
    local out = {input = {}, output = {}, flows = {}}
    for k, v in pairs(st.input_counts) do out.input[k] = v end
    for k, v in pairs(st.output_counts) do out.output[k] = v end
    for pname, pi in pairs(P) do
      local row = {}
      for _, cat in ipairs{"input", "output"} do
        for k in pairs(cat == "input" and st.input_counts or st.output_counts) do
          row[cat .. ":" .. k] = {avg = st.get_flow_count{name = k, category = cat, precision_index = pi}, count = st.get_flow_count{name = k, category = cat, precision_index = pi, count = true}}
        end
      end
      out.flows[pname] = row
    end
    return out
  end
  local poles, first = {}, nil
  for _, e in pairs(s.find_entities_filtered{type = "electric-pole"}) do poles[#poles + 1] = {x = e.position.x, y = e.position.y, id = e.electric_network_id} if not first and e.electric_network_statistics then first = e end end
  local function at(e) return e and (e.position.x .. "," .. e.position.y) or false end
  local function ats(list) local o = {} for i, e in ipairs(list or {}) do o[i] = at(e) end table.sort(o) return o end
  local relations = {}
  for _, e in pairs(s.find_entities_filtered{force = "player", type = {"transport-belt", "underground-belt", "splitter", "inserter", "mining-drill"}}) do
    local r = {}
    if e.type == "inserter" then r.pick = at(e.pickup_target) r.drop = at(e.drop_target) r.px = e.pickup_position.x r.py = e.pickup_position.y r.dx = e.drop_position.x r.dy = e.drop_position.y r.filters = e.use_filters r.mode = e.inserter_filter_mode
    elseif e.type == "mining-drill" then r.drop = at(e.drop_target) r.dx = e.drop_position.x r.dy = e.drop_position.y
    else local n = e.belt_neighbours r.ins = ats(n.inputs) r.outs = ats(n.outputs) if e.type == "transport-belt" then r.shape = e.belt_shape end if e.type == "underground-belt" then r.ug = e.belt_to_ground_type r.pair = at(e.underground_belt_neighbour) end end
    relations[at(e)] = r
  end
  local charted, visible = {}, {}
  for c in s.get_chunks() do
    if f.is_chunk_charted(s, c) then charted[#charted + 1] = c.x .. "," .. c.y end
    if f.is_chunk_visible(s, c) then visible[#visible + 1] = c.x .. "," .. c.y end
  end
  return {tick = game.tick, ticks_played = game.ticks_played, research = {current = f.current_research and f.current_research.name or false, progress = f.research_progress, queue = q},
    techs = techs, modifiers = mods, evolution = en.get_evolution_factor(s), pollution = s.get_total_pollution(), poles = poles, charted = charted, visible = visible, relations = relations,
    stats = {items = flow(f.get_item_production_statistics(s)), fluids = flow(f.get_fluid_production_statistics(s)), kills = flow(f.get_kill_count_statistics(s)), builds = flow(f.get_entity_build_count_statistics(s)), pollution = flow(game.get_pollution_statistics(s)), electric = first and flow(first.electric_network_statistics) or nil}}`;

export type WorldTruth = { tick: number; ticks_played: number; research: { current: string | false; progress: number; queue: string[] }; techs: Record<string, { researched: boolean; enabled: boolean; level: number }>; modifiers: Record<string, number>; evolution: number; pollution: number; poles?: { x: number; y: number; id: number }[]; charted?: string[]; visible?: string[]; relations?: Record<string, Record<string, unknown>>; stats: Record<string, { input: Record<string, number>; output: Record<string, number>; flows: Record<string, Record<string, { avg: number; count: number }>> }> };

export type WorldDiff = { total: number; diffs: [string, unknown, unknown][] };
/** fake_game.lua 的 __self_check: 假接口自己答的科技和统计 */
export type SelfCheck = { techs: Record<string, { researched: boolean; enabled: boolean; level: number }>; flows: Record<string, Record<string, Record<string, { avg: number; count: number }>>>; relations?: Record<string, Record<string, unknown>> };

/** 真值 vs 假接口: 带子邻居和形状、地下带配对、机械臂和矿机的目标、取放位置、筛选。空表 ([] / {}) 和 nil / false 都算没有 */
export function compareRelations(truth: WorldTruth, got: SelfCheck): WorldDiff {
  const diffs: [string, unknown, unknown][] = [];
  let total = 0;
  const norm = (v: unknown) => (v === false || v === null || v === undefined || (typeof v === "object" && Object.keys(v as object).length === 0) ? null : Array.isArray(v) ? v : typeof v === "object" ? Object.values(v as object) : v);
  for (const [at, t] of Object.entries(truth.relations ?? {})) {
    const m = got.relations?.[at] ?? {};
    for (const k of new Set([...Object.keys(t), ...Object.keys(m)])) {
      total++;
      const a = norm(t[k]), b = norm(m[k]);
      const same = typeof a === "number" && typeof b === "number" ? near(a, b) : JSON.stringify(a) === JSON.stringify(b);
      if (!same) diffs.push([`${at}.${k}`, t[k], m[k]]);
    }
  }
  return { total, diffs };
}

/** 真值 vs 假接口的回答: 科技 researched / enabled / level, 统计 get_flow_count 的平均和总数。比较用千分之二容差: 真值和假接口的公式之间隔一层浮点 (内存里采样是 float) */
export function compareSelfCheck(truth: WorldTruth, got: SelfCheck): WorldDiff {
  const diffs: [string, unknown, unknown][] = [];
  let total = 0;
  const check = (p: string, a: unknown, b: unknown) => {
    total++;
    const same = typeof a === "number" && typeof b === "number" ? near(a, b, 2e-3) : a === b;
    if (!same) diffs.push([p, a, b]);
  };
  for (const [name, t] of Object.entries(truth.techs ?? {})) {
    const m = got.techs?.[name];
    check(`tech.${name}.researched`, t.researched, m?.researched);
    check(`tech.${name}.enabled`, t.enabled, m?.enabled);
    check(`tech.${name}.level`, t.level, m?.level);
  }
  for (const [label, st] of Object.entries(truth.stats ?? {})) {
    for (const [pname, row] of Object.entries(st.flows ?? {})) {
      for (const [k, v] of Object.entries(row ?? {})) {
        const m = got.flows?.[label]?.[pname]?.[k];
        check(`${label}.${pname}.${k}.avg`, v.avg, m?.avg);
        check(`${label}.${pname}.${k}.count`, v.count, m?.count);
      }
    }
  }
  return { total, diffs };
}

/** 接着东西最多的电网 (真值那边选第一个有统计的电线杆, 也是主网; 只有一根杆的小网没有统计) */
function biggestNetwork(mem: WorldMem) {
  return Object.values(mem.networks ?? {}).sort((a, b) => Object.keys(b.flow?.input ?? {}).length - Object.keys(a.flow?.input ?? {}).length)[0];
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

/** 真值 vs 内存: 研究、科技、修正、进化度、污染总量、统计累计。Lua 空表回来是 {} 或 [] 都算空 */
export function compareWorld(truth: WorldTruth, mem: WorldMem): WorldDiff {
  const diffs: [string, unknown, unknown][] = [];
  let total = 0;
  const check = (p: string, a: unknown, b: unknown) => {
    total++;
    const same = typeof a === "number" && typeof b === "number" ? near(a, b) : JSON.stringify(a) === JSON.stringify(b);
    if (!same) diffs.push([p, a, b]);
  };
  const fm = mem.forces.player ?? {};
  check("tick", truth.tick, mem.tick);
  check("research.current", truth.research.current || null, fm.research?.current ?? null);
  check("research.progress", truth.research.progress, fm.research?.progress);
  check("research.queue", Object.values(truth.research.queue ?? {}), fm.research?.queue ?? []);
  for (const [name, t] of Object.entries(truth.techs ?? {})) {
    const m = fm.technologies?.[name];
    check(`tech.${name}.enabled`, t.enabled, m?.enabled);
  }
  for (const [k, v] of Object.entries(truth.modifiers ?? {})) check(`modifier.${k}`, v, fm.modifiers?.[k]);
  check("evolution", truth.evolution, mem.forces.enemy?.evolution?.factor ?? 0);
  check("pollution.total", truth.pollution, mem.pollution?.total);
  const sortedSet = (list: Iterable<string>) => [...new Set(list)].sort();
  if (truth.charted) check("chart.charted", sortedSet(truth.charted), sortedSet((fm.chart?.charted ?? []).map(([x, y]) => `${x},${y}`)));
  // 可见 = 探图时间还在迷雾时间内 (SubChart.tickOfCharting + fogOfWarTimeout)
  if (truth.visible) check("chart.visible", sortedSet(truth.visible), sortedSet((fm.chart?.charted ?? []).filter(([, , at]) => mem.tick - at < (fm.chart?.fog_timeout ?? 0)).map(([x, y]) => `${x},${y}`)));
  const flowOf: Record<string, Flow | null | undefined> = { items: fm.items, fluids: fm.fluids, kills: fm.kills, builds: fm.builds, pollution: mem.pollution?.stats, electric: biggestNetwork(mem)?.flow };
  for (const [label, t] of Object.entries(truth.stats ?? {})) {
    const m = flowOf[label];
    for (const cat of ["input", "output"] as const) {
      for (const [k, v] of Object.entries(t[cat] ?? {})) check(`${label}.${cat}.${k}`, v, m?.[cat]?.[k] ?? 0);
    }
  }
  return { total, diffs };
}
