// ./plan 的纯逻辑 (库, 不直接运行): 一句 "物品 每分钟" → 全链配方 → 减掉场上已有 → 每样差的挑一块实测过的蓝图 → 步骤。
// 大脑自己跑、自己决定照不照做; 工具只给事实和候选 (架构 2b)。为什么要它: 第 5 班 3 小时 ./calc 7 次、./bp 翻了 21 次、一块都没放下 ——
// 算出来的是数字, 库里翻到的是候选, 从"差 8 台内燃机"到"在哪放、料够不够"中间要自己接。
import type { GameData, Recipe } from "../calc/data.ts";
import { defaultFuel, type Plan } from "../calc/solve.ts";
import type { Delta, Tech } from "./expand.ts";
import { rawNeeds, type HandRecipe } from "./bp-gather.ts";

/** 物品名: 内部名 / 官方中文名 (全等优先, 其次唯一包含) → 内部名; 认不出 null */
export function resolveItem(name: string, zh: Map<string, string>, known: (id: string) => boolean): string | null {
  const n = name.trim();
  if (known(n)) return n;
  const rows = [...zh].filter(([id]) => known(id));
  const exact = rows.find(([, v]) => v === n);
  if (exact) return exact[0];
  const part = rows.filter(([, v]) => v.includes(n) || n.includes(v.replace(/（.*?）/g, "")));
  return part.length === 1 ? part[0][0] : null;
}

/** 这些当"从外面进": 矿、水、原油和炼油产物 (炼油另算, 副产品平衡不在这里解) */
const RAW = /(-ore|^coal|^stone|^water|^crude-oil|^petroleum-gas|^heavy-oil|^light-oil|^steam|^wood|^calcite|^tungsten-ore|^holmium-ore|^scrap)$/;
const SKIP_RECIPE = /barrel|recycling|parameter|-from-|^kovarex|asteroid|^nuclear/;

/** 产出这个物品的配方: 同名优先; 回收 / 灌桶之类跳过 */
export function recipeFor(gd: GameData, item: string): Recipe | null {
  const same = gd.recipes.get(item);
  if (same && same.products.some((p) => p.name === item)) return same;
  for (const r of gd.recipes.values()) if (!SKIP_RECIPE.test(r.name) && r.products.some((p) => p.name === item)) return r;
  return null;
}

/** 这个配方用哪台机器: 按已研究的科技挑候选里第一台能做这个类别的 */
export function machineFor(gd: GameData, r: Recipe, tech: Tech): string | null {
  const furnace = tech.electricFurnace ? "electric-furnace" : tech.steelFurnace ? "steel-furnace" : "stone-furnace";
  const am = tech.automation2 ? "assembling-machine-2" : "assembling-machine-1";
  for (const m of [am, "assembling-machine-2", furnace, "chemical-plant", "oil-refinery", "rocket-silo"]) {
    const d = gd.machines.get(m);
    if (d && r.categories.some((c) => d.categories.includes(c))) return m;
  }
  return null;
}

/** 从目标物品往上游展开成计算器方案; 做不了的 (没机器 / 没配方) 当从外面进 */
export function chainPlan(gd: GameData, item: string, perMin: number, tech: Tech): Plan {
  const recipes: Plan["recipes"] = {};
  const imports = new Set<string>();
  const todo = [item];
  const seen = new Set<string>();
  while (todo.length) {
    const it = todo.pop()!;
    if (seen.has(it)) continue;
    seen.add(it);
    if (RAW.test(it)) { imports.add(it); continue; }
    const r = recipeFor(gd, it);
    const m = r ? machineFor(gd, r, tech) : null;
    if (!r || !m) { imports.add(it); continue; }
    recipes[r.name] = { machine: m };
    for (const ing of r.ingredients) todo.push(ing.name);
    // 烧燃料的机器 (石炉、钢炉): 燃料也算从外面进, 否则解不出来。2026-11-05 新图班 ./plan 红瓶崩 "解不出来 (infeasible)":
    // 之前只核过蓝瓶, 它的塑料本来就要煤, 正好把这个漏洞盖住了
    const md = gd.machines.get(m);
    const fuel = md?.source === "burner" ? defaultFuel(gd, md) : undefined;
    if (fuel && !recipes[fuel]) imports.add(fuel);
  }
  return { targets: { [item]: perMin }, recipes, imports: [...imports] };
}

/** ./calc 只给 targets 时用: 几个目标各展开一条链再合起来; 默认组装机2型 + 石炉 */
export function chainPlans(gd: GameData, targets: Record<string, number>, tech: Partial<Tech> = {}): Plan {
  const t: Tech = { automation2: true, steelFurnace: false, electricFurnace: false, ...tech } as Tech;
  const plans = Object.entries(targets).map(([item, rate]) => chainPlan(gd, item, rate, t));
  return { targets, recipes: Object.assign({}, ...plans.map((p) => p.recipes)), imports: [...new Set(plans.flatMap((p) => p.imports ?? []))] };
}

export type Block = { no: number; label: string; w: number; h: number; io: string; counts: Record<string, number> };
export type Pick = { delta: Delta; block: Block; size: number; copies: number };

/** 蓝图库里给这一项差额挑一块: 同种机器优先; 一块够就挑最小的够用块, 不够就最大块放几份。没有现成的 null */
export function pickBlock(d: Delta, blocks: Block[], zh: (id: string) => string): Pick | null {
  const rows: { block: Block; size: number; fit: boolean }[] = [];
  for (const b of blocks) {
    if (d.kind === "furnace") {
      const m = /^冶炼列 ([\w-]+) × (\d+)/.exec(b.label);
      if (m) rows.push({ block: b, size: Number(m[2]), fit: m[1] === d.machine });
    } else if (d.kind === "assembler") {
      const m = /^(?:组装机|化工厂)排 (.+?) × (\d+)/.exec(b.label);
      if (m && m[1] === zh(d.key)) rows.push({ block: b, size: Number(m[2]), fit: b.label.includes(zh(d.machine)) });
    }
  }
  if (!rows.length) return null;
  const pool = rows.some((r) => r.fit) ? rows.filter((r) => r.fit) : rows;
  const enough = pool.filter((r) => r.size >= d.add).sort((a, b) => a.size - b.size)[0];
  const pick = enough ?? pool.sort((a, b) => b.size - a.size)[0];
  return { delta: d, block: pick.block, size: pick.size, copies: Math.ceil(d.add / pick.size) };
}

/** 高档机器在块标签里的写法 (组装机排写官方名, 冶炼列写内部名) 和拿不到时按科技关掉哪一档 */
const TIERS: { item: string; mark: string; tech: "automation2" | "electricFurnace" | "steelFurnace" }[] = [
  { item: "assembling-machine-2", mark: "组装机2型", tech: "automation2" },
  { item: "electric-furnace", mark: "electric-furnace", tech: "electricFurnace" },
  { item: "steel-furnace", mark: "steel-furnace", tech: "steelFurnace" },
];

/**
 * 科技研究了不等于造得出: 班次 2026-11-06T05-05-16 组装机2型已研究但场上没钢, ./plan 红瓶 150 --build 挑了要 12 台组装机2型的块, 搓不了就整条失败, 明明组装机1型的块能放。
 * 缺的是高档机器就按低一档重算; 缺别的 (带子、机械臂) 或已经是最低档 null。
 */
export function downgrade(tech: Tech, missing: Record<string, number>): { tech: Tech; item: string } | null {
  for (const t of TIERS) if (missing[t.item] && tech[t.tech]) return { tech: { ...tech, [t.tech]: false }, item: t.item };
  return null;
}

/**
 * 放之前查: 缺的高档机器拿不拿得到 (背包 + 库存里现成的, 或手搓的原料都够)。拿不到回低一档的科技和差什么, 都拿得到 null。
 * 只读, 所以不带 --build 的 ./plan 也不再写"会先拿先搓: 组装机2型"; stockOf 查不了 (回 Infinity) 就当拿得到, 真放时 ./plan --build 还有回退兜着。
 */
export async function unreachableTier(lack: Record<string, number>, tech: Tech, held: Record<string, number>, recipe: HandRecipe, stockOf: (item: string) => Promise<number>): Promise<{ item: string; tech: Tech; short: { item: string; need: number; have: number } } | null> {
  for (const t of TIERS) {
    const n = lack[t.item];
    if (!n || !tech[t.tech]) continue;
    if ((await stockOf(t.item)) >= n) continue;
    for (const [item, need] of Object.entries(rawNeeds({ [t.item]: n }, held, recipe))) {
      const have = await stockOf(item);
      if (have < need) return { item: t.item, tech: { ...tech, [t.tech]: false }, short: { item, need, have } };
    }
  }
  return null;
}

/** 这块要的高档机器拿不到时, 同一产物不用这种机器的块, 小的在前; 块标签认不出产物或缺的不是高档机器时为空 */
export function blocksWithout(label: string, missing: Record<string, number>, blocks: Block[], n = 2): { item: string; block: Block; size: number }[] {
  const tier = TIERS.find((t) => missing[t.item] && label.includes(t.mark));
  if (!tier) return [];
  const shape = /^((?:组装机|化工厂)排 .+?|冶炼列 [\w-]+) × /.exec(label)?.[1];
  if (!shape) return [];
  const same = (l: string) => shape.startsWith("冶炼列") ? l.startsWith("冶炼列 ") : l.startsWith(`${shape} × `);
  const size = (l: string) => Number(/ × (\d+)/.exec(l)?.[1] ?? 0);
  return blocks.filter((b) => same(b.label) && !b.label.includes(tier.mark)).sort((a, b) => size(a.label) - size(b.label)).slice(0, n).map((block) => ({ item: tier.item, block, size: size(block.label) }));
}

/** 同一项差额的别的摆法: 单排 / 双排 / 另一档机器, 按大小去重, 不含 not (已经推荐的); 最多 n 个 */
export function otherBlocks(d: Delta, blocks: Block[], zh: (id: string) => string, not: number, n = 2): { block: Block; size: number; shape: string }[] {
  const out: { block: Block; size: number; shape: string }[] = [], seen = new Set<string>();
  for (const b of blocks) {
    if (b.no === not) continue;
    let size = 0;
    if (d.kind === "furnace") { const m = /^冶炼列 ([\w-]+) × (\d+)/.exec(b.label); if (!m || m[1] !== d.machine) continue; size = Number(m[2]); }
    else if (d.kind === "assembler") { const m = /^(?:组装机|化工厂)排 (.+?) × (\d+)/.exec(b.label); if (!m || m[1] !== zh(d.key)) continue; size = Number(m[2]); }
    else continue;
    const shape = b.label.split(" / ").filter((x) => /排$|^组装机\d型$/.test(x)).join(" ") || `${size} 台`;
    const k = `${shape}:${size}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ block: b, size, shape });
  }
  return out.sort((a, b) => a.size - b.size).slice(0, n);
}

/** 找空地的 Lua: 从 (x, y) 往外一圈圈找 w×h 的地方; 树和石头不算挡路 (bp build 会清), 矿、水、建筑、已占的算。taken = 这次已经分出去的地方 */
export function siteLua(near: [number, number] | null, w: number, h: number, taken: { x: number; y: number; w: number; h: number }[], margin = 3): string {
  const t = taken.map((r) => `{${r.x},${r.y},${r.w},${r.h}}`).join(",");
  return `local s = game.surfaces[1] local f = game.forces.player
    local cx, cy = ${near ? near[0] : "nil"}, ${near ? near[1] : "nil"}
    if not cx then local n, sx, sy = 0, 0, 0 for _, e in pairs(s.find_entities_filtered{type = {"assembling-machine", "lab", "furnace"}, force = f}) do n = n + 1 sx = sx + e.position.x sy = sy + e.position.y end
      if n > 0 then cx, cy = sx / n, sy / n else local p = game.connected_players[1] cx, cy = p and p.position.x or 0, p and p.position.y or 0 end end
    local hw, hh = ${w} / 2 + ${margin}, ${h} / 2 + ${margin}
    local taken = {${t}}
    local OK = {tree = true, ["simple-entity"] = true, ["item-entity"] = true, corpse = true, character = true, ["character-corpse"] = true, fish = true}
    local function free(x, y)
      for _, r in ipairs(taken) do if math.abs(x - r[1]) < hw + r[3] / 2 and math.abs(y - r[2]) < hh + r[4] / 2 then return false end end
      if not s.is_chunk_generated({math.floor(x / 32), math.floor(y / 32)}) then return false end
      local a = {{x - hw, y - hh}, {x + hw, y + hh}}
      for _, e in pairs(s.find_entities_filtered{area = a}) do if not OK[e.type] then return false end end
      return s.count_tiles_filtered{area = a, collision_mask = "water_tile"} == 0
    end
    local tries = 0
    for ring = 0, 60 do
      local d = ring * 8
      local x = -d
      while x <= d do
        local y = -d
        while y <= d do
          if math.abs(x) == d or math.abs(y) == d then
            tries = tries + 1
            if tries > 4000 then return {found = false, tries = tries} end
            local px, py = math.floor(cx + x) + 0.5, math.floor(cy + y) + 0.5
            if free(px, py) then return {found = true, x = px, y = py, tries = tries} end
          end
          y = y + 8
        end
        x = x + 8
      end
    end
    return {found = false, tries = tries}`;
}

/**
 * 差额 → 算好的放置命令 (监工发给闲着的角色):
 * 上游先 (炉子再组装机), 每项挑一块蓝图, 从基地中心往外找空地, 找过的不重复。找空地由调用方给 (真游戏跑 siteLua, 测试给假的)。
 */
export async function placementSteps(ds: Delta[], blocks: Block[], zh: (id: string) => string, site: (w: number, h: number, taken: { x: number; y: number; w: number; h: number }[]) => Promise<{ found?: boolean; x?: number; y?: number } | null>, max = 3): Promise<string[]> {
  const out: string[] = [];
  const taken: { x: number; y: number; w: number; h: number }[] = [];
  for (const d of [...ds.filter((x) => x.kind === "furnace"), ...ds.filter((x) => x.kind === "assembler")].filter((x) => x.add > 0)) {
    if (out.length >= max) break;
    const pick = pickBlock(d, blocks, zh);
    if (!pick) continue;
    const at = await site(pick.block.w, pick.block.h, taken);
    if (!at?.found || at.x === undefined || at.y === undefined) continue;
    taken.push({ x: at.x, y: at.y, w: pick.block.w, h: pick.block.h });
    out.push(`./bp build ${pick.block.no} --at ${at.x},${at.y}  (${d.kind === "furnace" ? "炉子" : zh(d.key)}: 还差 ${d.add} 台, 这块 ${pick.size} 台)`);
  }
  return out;
}

/** 蓝图要的 vs 背包里有的 → 缺什么 */
export function missingItems(counts: Record<string, number>, held: Record<string, number>, copies = 1): { item: string; lack: number }[] {
  return Object.entries(counts).map(([item, n]) => ({ item, lack: n * copies - (held[item] ?? 0) })).filter((x) => x.lack > 0);
}

/** 给大脑看的结果 */
export function planText(a: { item: string; perMin: number; zh: (id: string) => string; deltas: Delta[]; steps: { pick: Pick; at: { x: number; y: number } | null; lack: { item: string; lack: number }[]; others?: { block: Block; size: number; shape: string }[] }[]; noBlock: Delta[]; imports: Record<string, number>; goCmd?: string }): string {
  const { zh } = a;
  const out = [`目标: ${zh(a.item)} ${a.perMin} 个/分 (场上已有的已经减掉)`];
  const todo = a.deltas.filter((d) => d.add > 0);
  if (!todo.length) {
    out.push("机器数已经够了。产量还上不来就不是机器的问题: 查原料和带子 (./fh call bottleneck)。");
    return out.join("\n");
  }
  a.steps.forEach((s, i) => {
    const d = s.pick.delta, name = d.kind === "furnace" ? `炉子 (${d.note ?? ""})` : zh(d.key);
    const where = s.at ? `./bp build ${s.pick.block.no} --at ${s.at.x},${s.at.y}` : `./bp show ${s.pick.block.no}  (附近找不到空地, 用 --near 换个地方)`;
    out.push(`${i + 1}. ${where}`);
    out.push(`   ${name}: 现 ${d.have} 台${d.equiv !== undefined ? ` (按${zh(d.machine)}折合 ${d.equiv} 台)` : ""}, 要 ${d.need} 台; 这块 ${s.pick.size} 台, ${s.pick.block.w}x${s.pick.block.h}${s.pick.copies > 1 ? `, 共要放 ${s.pick.copies} 块 (这次先放 1 块)` : ""}${s.pick.block.io ? `; ${s.pick.block.io}` : ""}`);
    if (s.lack.length) out.push(`   缺的料 ./bp build 会先拿先搓: ${s.lack.slice(0, 8).map((x) => `${zh(x.item)} ${x.lack}`).join("、")}`);
    if (s.others?.length) out.push(`   别的摆法: ${s.others.map((o) => `./bp show ${o.block.no} (${o.shape} ${o.size} 台 ${o.block.w}x${o.block.h})`).join("、")}; 看真实基地怎么摆再自己设计: ./bp study ${d.key}`);
  });
  if (a.goCmd && a.steps.some((s) => s.at)) out.push(`一条命令按上面全放下 (备料、清场、建造、比对都在里面, 放完回接线命令): ${a.goCmd}`);
  for (const d of a.noBlock) {
    if (d.kind === "drill") out.push(`- ${zh(d.key)}: 差 ${d.add} 台采矿机 (${d.note ?? ""}); 用 ./fh call placements 找矿位`);
    else out.push(`- ${zh(d.key)}: 差 ${d.add} 台${zh(d.machine)}, 库里没有现成的块, 自己搭`);
  }
  const fluids = Object.entries(a.imports).filter(([k]) => !/-ore$|^coal$|^stone$/.test(k));
  if (fluids.length) out.push(`要从外面进: ${fluids.slice(0, 8).map(([k, v]) => `${zh(k)} ${v.toFixed(0)}/分`).join("、")}`);
  out.push("块放下后用 belt_route 把料接到入口、把产物接出去, 再 ./fh call belt_gaps 查断口。步骤不合适就改, 用不用你定。");
  return out.join("\n");
}
