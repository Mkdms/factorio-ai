// ./bp build 和 ./plan 用的 (库, 不直接运行): 放之前问模组 paste dry_run (游戏自己的判断, 40~60 毫秒), 放不下给能放下的坐标; 放完比对、算入口出口, 回能跑的下一条命令。
// : 班次 10-16-30 ./bp 12 次错 5 次。实测 (2026-11-06, 班次 19-20-57): --at 就是蓝图中心 (贴出来中心差 ≤0.5 格), Gpt 看到的 y 偏 12 是模组 not_placed 的 locate
// 拿场上同名实体投票算错了; 真正的坑是普通贴蓝图全有或全无 (模组 paste_note: "a normal paste is all or nothing"), 一棵树或一件东西挡着就 0 个, 而且那时候才知道。

export type Dry = { blocked?: string[]; trees_rocks?: string; summary?: string; missing?: Record<string, number>; power?: { connected?: string[]; islands?: string[] }; paste?: { origin_at?: { x: number; y: number }; center_at?: { x: number; y: number } } };

/** 这些 ./bp build 会自己清 (树、石头) 或者会自己走开 (角色) */
const CLEARABLE = /tree|rock|stump|^character$/;

/** dry_run 的 blocked 一行: "#7 transport-belt (97.5,57.5): blocked by dead-tree-desert (98.4375,57.5), lab (1,2)" → 挡路的 ["dead-tree-desert (98.4375,57.5)", "lab (1,2)"]; 不是"被实体挡" (水、地图外) 就是这一行的原因 */
export function blockersOf(line: string): string[] {
  const i = line.indexOf("blocked by ");
  if (i < 0) return [line.replace(/^#\d+\s*/, "")];
  const hits = [...line.slice(i + "blocked by ".length).matchAll(/([\w-]+) \((-?[\d.]+),\s*(-?[\d.]+)\)/g)].map((m) => `${m[1]} (${m[2]},${m[3]})`);
  return hits.length ? hits : [line.slice(i + "blocked by ".length)];
}

/** 除去 ./bp build 能自己清的, 还挡着的东西 (去重) */
export function realBlockers(blocked: string[] = []): string[] {
  const out: string[] = [];
  for (const l of blocked) for (const b of blockersOf(l)) if (!CLEARABLE.test(b.split(" ")[0]) && !out.includes(b)) out.push(b);
  return out;
}

/** 模型直接调 ./fh call paste / blueprint_place 时: 要不要先干跑。自己写了 mode 或 dry_run 就听它的; --args 不是 JSON 的不碰。回参数在 args 里的位置和解析好的值 */
export function pasteArgs(args: string[]): { index: number; value: Record<string, unknown> } | null {
  const cmd = args[0] === "call" ? args[1] : args[0];
  if (cmd !== "paste" && cmd !== "blueprint_place") return null;
  const i = args.indexOf("--args");
  if (i < 0 || !args[i + 1]) return null;
  let o: unknown;
  try { o = JSON.parse(args[i + 1]); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const v = o as Record<string, unknown>;
  return v.mode !== undefined || v.dry_run !== undefined ? null : { index: i + 1, value: v };
}

/** 干跑的结果 → 怎么贴: 只有树石挡路 → 用 forced 贴 (66/66, 树标拆除, construct 时砍掉); 有建筑挡路不能 forced (2026-11-06 实测只贴上 24/66, 留半块) */
export function pasteDecision(dry: Dry | null | undefined): { force: boolean; blockers: string[] } {
  const blockers = realBlockers(dry?.blocked);
  return { force: !blockers.length && (dry?.blocked?.length ?? 0) > 0, blockers };
}

export type At = { x: number; y: number };
export type SiteFn = (near: [number, number], w: number, h: number, taken: { x: number; y: number; w: number; h: number }[]) => Promise<{ found?: boolean; x?: number; y?: number } | null>;

/** 在 near 附近找一个 dry_run 也说放得下的地方; 找空地 (siteLua) 猜的不算数, 只认 dry_run; 找不到 null */
export async function findSpot(near: [number, number], w: number, h: number, site: SiteFn, blockersAt: (x: number, y: number) => Promise<string[]>, tries = 6): Promise<At | null> {
  const taken: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < tries; i++) {
    const s = await site(near, w, h, taken);
    if (!s?.found || s.x === undefined || s.y === undefined) return null;
    if (!(await blockersAt(s.x, s.y)).length) return { x: s.x, y: s.y };
    taken.push({ x: s.x, y: s.y, w, h });
  }
  return null;
}

/** 放不下时给模型看的: 挡着什么 + 能跑的下一条命令 */
export function blockedText(spec: string, at: number[], blockers: string[], spot: At | null, rest = ""): string {
  const list = blockers.slice(0, 8).join(", ") + (blockers.length > 8 ? ` 等 ${blockers.length} 件` : "");
  const next = spot ? `最近放得下: ./bp build ${spec} --at ${spot.x},${spot.y}${rest} (游戏查过, 这条能一次成)` : "附近 200 格内找不到放得下的地方, 用 --at 换个方向, 或先和放这些东西的队友说好";
  return `error: 放不下, 什么都没动 (贴蓝图全有或全无, 一件挡着就一个也贴不上)。蓝图中心在 (${at.join(",")}), 挡路的: ${list}。\n${next}`;
}

const DIR: Record<number, [number, number]> = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };
const DIRNAME: Record<number, string> = { 0: "北", 4: "东", 8: "南", 12: "西" };
const TURN: Record<string, number> = { north: 0, east: 1, south: 2, west: 3 };
export type BpEntity = { name: string; position: { x: number; y: number }; direction?: number; type?: string; recipe?: string };
const key = (x: number, y: number) => `${x},${y}`;
const BELT = /transport-belt$|underground-belt$/;
const INSERTER = /inserter$/;

/** 蓝图里料从哪进、产物从哪出: 带子连成串, 有机械臂从上面取的串 → 串头是入口; 有机械臂往上放、没人取的串 → 串尾是出口。坐标已换成世界坐标 (origin = dry_run 的 origin_at) */
export function blockPorts(entities: BpEntity[], origin: At, dirName?: string): { inputs: { x: number; y: number; dir: string }[]; outputs: { x: number; y: number; dir: string }[] } {
  const turns = TURN[dirName ?? "north"] ?? 0;
  const place = (e: BpEntity) => { let { x, y } = e.position; for (let i = 0; i < turns; i++) [x, y] = [-y, x]; return { x, y, d: ((e.direction ?? 0) + turns * 4) % 16 }; };
  const belts = new Map<string, { x: number; y: number; d: number; ug?: string }>();
  for (const e of entities) if (BELT.test(e.name)) { const p = place(e); belts.set(key(p.x, p.y), { ...p, ug: e.type }); }
  const next = (b: { x: number; y: number; d: number; ug?: string }): string | null => {
    const v = DIR[b.d];
    if (!v) return null;
    if (b.ug === "input") { for (let n = 1; n <= 10; n++) { const t = belts.get(key(b.x + v[0] * n, b.y + v[1] * n)); if (t?.ug === "output" && t.d === b.d) return key(t.x, t.y); } return null; }
    const k = key(b.x + v[0], b.y + v[1]);
    return belts.has(k) ? k : null;
  };
  const down = new Map<string, string>(), hasUp = new Set<string>();
  for (const [k, b] of belts) { const n = next(b); if (n) { down.set(k, n); hasUp.add(n); } }
  // 串: 每个没有上游的格子往下走到头
  const chainOf = new Map<string, number>(); const heads: string[] = [], tails: string[] = [];
  for (const k of belts.keys()) {
    if (hasUp.has(k)) continue;
    const id = heads.length; heads.push(k);
    let c = k, guard = 0, last = k;
    while (c && guard++ < 4096) { chainOf.set(c, id); last = c; c = down.get(c)!; }
    tails.push(last);
  }
  const picks = new Set<number>(), drops = new Set<number>();
  for (const e of entities) {
    if (!INSERTER.test(e.name)) continue;
    const p = place(e), v = DIR[p.d];
    if (!v) continue;
    const reach = e.name.startsWith("long-handed") ? 2 : 1;
    // 蓝图里机械臂 direction = 取货方向 (2.1.24 核实, I:\fn\CLAUDE.md 工具坑; 这里用 dry_run 的 pickup / drop 对过, test/play-bp-fit)
    const from = chainOf.get(key(p.x + v[0] * reach, p.y + v[1] * reach)), to = chainOf.get(key(p.x - v[0] * reach, p.y - v[1] * reach));
    if (from !== undefined) picks.add(from);
    if (to !== undefined) drops.add(to);
  }
  const world = (k: string) => { const b = belts.get(k)!; return { x: b.x + origin.x, y: b.y + origin.y, dir: DIRNAME[b.d] ?? "?" }; };
  return { inputs: [...picks].map((i) => world(heads[i])), outputs: [...drops].filter((i) => !picks.has(i)).map((i) => world(tails[i])) };
}

/** 放完在游戏里比对的 Lua: 这片范围里蓝图要的东西各有几件、虚影还剩几个、机器配方、电; area 是 paste 回的 bounds */
export function verifyLua(area: { left_top: At; right_bottom: At }, names: string[]): string {
  const a = `{{${area.left_top.x - 0.5},${area.left_top.y - 0.5}},{${area.right_bottom.x + 0.5},${area.right_bottom.y + 0.5}}}`;
  // 块里的杆自己连成一片不算有电: 看机器所在的电网上有没有发电的 (蒸汽机、太阳能、蓄电池)
  return `local s = game.surfaces[1] local a = ${a} local c = {}
    for _, n in ipairs({${names.map((n) => `"${n}"`).join(",")}}) do c[n] = s.count_entities_filtered{area = a, name = n} end
    local g = s.count_entities_filtered{area = a, type = "entity-ghost"}
    local live = {}
    for _, e in pairs(s.find_entities_filtered{type = {"generator", "solar-panel", "accumulator"}}) do if e.electric_network_id then live[e.electric_network_id] = true end end
    local m, r, p, need = 0, 0, 0, 0
    for _, e in pairs(s.find_entities_filtered{area = a, type = {"assembling-machine", "furnace", "lab"}}) do
      if e.type == "assembling-machine" then m = m + 1 if e.get_recipe() then r = r + 1 end end
      if e.prototype.electric_energy_source_prototype then need = need + 1 if e.electric_network_id and live[e.electric_network_id] then p = p + 1 end end
    end
    local ph, pd, inner = nil, 1e9, nil
    if need > p then
      for _, e in pairs(s.find_entities_filtered{position = {(a[1][1] + a[2][1]) / 2, (a[1][2] + a[2][2]) / 2}, radius = 80, type = "electric-pole"}) do
        local inside = e.position.x >= a[1][1] and e.position.x <= a[2][1] and e.position.y >= a[1][2] and e.position.y <= a[2][2]
        if inside then inner = inner or {x = e.position.x, y = e.position.y}
        elseif e.electric_network_id and live[e.electric_network_id] then
          local dx, dy = math.max(a[1][1] - e.position.x, 0, e.position.x - a[2][1]), math.max(a[1][2] - e.position.y, 0, e.position.y - a[2][2])
          local d = math.sqrt(dx * dx + dy * dy)
          if d < pd then pd, ph = d, {x = e.position.x, y = e.position.y} end
        end
      end
    end
    return {counts = c, ghosts = g, machines = m, recipes = r, powered = p, needPower = need, pole = ph, poleDist = ph and pd or nil, inner = inner}`;
}

export type Verify = { counts: Record<string, number>; ghosts: number; machines: number; recipes: number; powered: number; needPower: number; pole?: At; poleDist?: number; inner?: At };

/** 比对结果一行: 只报事实 */
export function verifyText(v: Verify, want: Record<string, number>): string {
  const short = Object.entries(want).filter(([n, c]) => (v.counts[n] ?? 0) < c).map(([n, c]) => `${n} ${v.counts[n] ?? 0}/${c}`);
  const total = Object.values(want).reduce((a, b) => a + b, 0);
  const parts = [short.length ? `少了 ${short.join("、")}` : `${total} 件都在`];
  if (v.ghosts) parts.push(`还剩 ${v.ghosts} 个虚影`);
  if (v.machines) parts.push(`配方 ${v.recipes}/${v.machines} 台设好了`);
  if (v.needPower) parts.push(v.powered >= v.needPower ? `电 ${v.powered}/${v.needPower} 台接上了` : `电 ${v.powered}/${v.needPower} 台接上${v.pole ? `, 最近的杆 (${v.pole.x},${v.pole.y}) 离这块 ${Math.round(v.poleDist ?? 0)} 格` : ", 80 格内没有杆"}`);
  return `比对 (游戏里读的): ${parts.join("; ")}。`;
}

/** 一条料线的查法结果: at = 最近有这种料的带子; route = 游戏 dry_run 回的 (ok 才给命令) */
export type WireCheck = { item: string; at: At | null; to?: At; ok?: boolean; tiles?: number; why?: string };

/** 接线的下一条命令: 只有游戏查过能走的才写成命令, 走不通的只报事实 (2026-11-06 真跑: belt_route 从别的带子中间接出来报 "the start tile is fed by another belt", 给的命令得真能跑) */
export function wireLines(checks: WireCheck[], pole?: { from: At; to: At; ok: boolean; why?: string; count?: number }): string[] {
  const out: string[] = [];
  for (const c of checks) {
    if (!c.at) { out.push(`附近 60 格的带子上没有 ${c.item}: ./fh call nearest --args '${JSON.stringify({ name: c.item, radius: 64 })}' 找来源, 或 ./plan ${c.item} 每分钟`); continue; }
    if (c.ok) out.push(`./fh call belt_route --args '${JSON.stringify({ from: c.at, to: c.to, item: c.item })}'  (${c.item}, 游戏查过能走${c.tiles ? `, ${c.tiles} 格` : ""})`);
    else out.push(`${c.item} 最近的带子在 (${c.at.x},${c.at.y}), 但直接接不上 (${(c.why ?? "").slice(0, 120)}): 要从中间分出来得加分流器或机械臂, ./know 分流器`);
  }
  if (pole) out.push(pole.ok ? `./fh call pole_route --args '${JSON.stringify({ from: pole.from, to: pole.to })}'  (接电, 游戏查过${pole.count ? `, 要放 ${pole.count} 根杆` : ""})` : `接电: 最近有电的杆 (${pole.from.x},${pole.from.y}), pole_route 走不通 (${(pole.why ?? "").slice(0, 120)})`);
  return out;
}

/** 找离入口最近的、带子上有这些物品的格子的 Lua (给 belt_route 的 from) */
export function sourceLua(items: string[], near: At, radius = 60): string {
  return `local s = game.surfaces[1] local out = {}
    local want = {${items.map((i) => `["${i}"] = true`).join(",")}} local best = {}
    for _, b in pairs(s.find_entities_filtered{position = {${near.x}, ${near.y}}, radius = ${radius}, type = {"transport-belt", "underground-belt"}}) do
      for l = 1, 2 do
        local line = b.get_transport_line(l)
        for _, c in pairs(line.get_contents()) do
          if want[c.name] then
            local dx, dy = b.position.x - (${near.x}), b.position.y - (${near.y})
            local d = dx * dx + dy * dy
            if not best[c.name] or d < best[c.name].d then best[c.name] = {d = d, x = b.position.x, y = b.position.y} end
          end
        end
      end
    end
    for n, b in pairs(best) do out[n] = {x = b.x, y = b.y} end
    return out`;
}

/** 这块蓝图吃什么 (配方的固体原料, 去掉本块自己做的) */
export function blockInputs(entities: BpEntity[], ingredients: (recipe: string) => { name: string; fluid?: boolean }[]): string[] {
  const made = new Set<string>(), eat: string[] = [];
  for (const e of entities) if (e.recipe) made.add(e.recipe);
  for (const r of made) for (const g of ingredients(r)) if (!g.fluid && !made.has(g.name) && !eat.includes(g.name)) eat.push(g.name);
  return eat;
}
