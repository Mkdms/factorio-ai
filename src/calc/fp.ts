// Factory Planner 对照 (库):
// 把我们的方案 (src/calc Plan) 打包成 Factory Planner 的工厂格式 (和它 export_current_factory 同形), 交给补丁接口
// fp-interface.solve_packed (tools/patch-fp.py 加的), 再把它算出的机器数和我们 solvePlan 的并排比。
// 比"每个配方要几台" (机器、研究产能、插件、分享塔、机器品质都转进去; 固定台数和燃料选择还没转, 标在 notes), 对不上的配方就是要查的。
import { QUALITY_LEVEL, levelOf, type Plan, type Result } from "./solve.ts";
import type { GameData } from "./data.ts";

type Proto = { name: string; category?: string; data_type: string; simplified: true };
/** FP 的"简化原型": 没类别的 (配方、品质) 不能写 category 字段 (它的 find 要求是 nil, 空字符串会查不到; 第四次对照 9 条配方全 invalid 就是这个) */
const proto = (name: string, data_type: string, category?: string): Proto => (category ? { name, category, data_type, simplified: true } : { name, data_type, simplified: true });

export type PackedFactory = {
  class: "Factory"; name: string; blueprint_strings: Record<string, never>; notes: string; productivity_boni: Record<string, number>;
  items: { class: "FactoryItem"; proto: Proto; category: "product"; definition: { type: "amount"; amount: number }; active: true }[];
  top_floor: { class: "Floor"; level: 1; solver: string; lines: unknown[]; gaussian_free_items: unknown[]; simplex_item_weights: unknown[] };
};

/** 方案里没转进 FP 的东西 (插件、分享塔、品质、固定台数): 对照时要知道这些配方的差异可能来自这里 */
export type PackNote = { recipe: string; skipped: string[] };

/** 我们的方案 → FP 的打包工厂。产品 = targets (每分钟; FP 偏好默认时间尺度 60 秒); 一个配方一条生产线, 机器按名字 (FP 校验时在配方类别里找) */
export function packFactory(gd: GameData, plan: Plan, opts: { solver?: "sequential" | "simplex" | "gaussian"; name?: string } = {}): { packed: PackedFactory; notes: PackNote[] } {
  const isFluid = (item: string) => { for (const r of gd.recipes.values()) for (const p of [...(r.products ?? []), ...(r.ingredients ?? [])]) if (p.name === item && p.type === "fluid") return true; return false; };
  // FP 内部数量按秒 (界面显示时才乘时间尺度, ui/components/item_views.lua:61); 第五次对照每条正好大 60 倍就是这个
  const items = Object.entries(plan.targets).map(([name, perMin]) => ({
    class: "FactoryItem" as const, proto: proto(name, "items", isFluid(name) ? "fluid" : "item"), category: "product" as const, definition: { type: "amount" as const, amount: perMin / 60 }, active: true as const,
  }));
  const notes: PackNote[] = [];
  const productivity_boni: Record<string, number> = {};
  // 品质: 我们用等级数或名字, FP 用品质原型名 (normal / uncommon / rare / epic / legendary)
  const qualityName = (q?: number | string) => { const lv = levelOf(q); return Object.entries(QUALITY_LEVEL).find(([, l]) => l === lv)?.[0] ?? "normal"; };
  const qualityProto = (q?: number | string) => proto(qualityName(q), "qualities");
  // 插件: 我们是 "名字@品质" 的列表 (一格一个), FP 是 {插件, 品质, 数量} 的集合; 插件原型按它的类别 (speed / productivity / …) 找
  const moduleSet = (specs: string[] | undefined) => {
    const groups = new Map<string, { name: string; quality?: string; amount: number }>();
    for (const spec of specs ?? []) { const [name, q] = spec.split("@"); const key = `${name}@${q ?? ""}`; const g = groups.get(key) ?? { name, quality: q, amount: 0 }; g.amount++; groups.set(key, g); }
    return { class: "ModuleSet", modules: [...groups.values()].map((g) => ({ class: "Module", proto: proto(g.name, "modules", gd.modules.get(g.name)?.category ?? ""), quality_proto: qualityProto(g.quality), amount: g.amount })) };
  };
  // 线的顺序: FP 的顺序求解器 (sequential) 只让下面的线供上面的线 (第八次对照: 铜缆线排在电路板线上面, FP 把电路板要的铜缆当外购, 铜缆 0 台);
  // 按"离目标多少步"排: 产目标的线最上, 供它原料的往下 (有循环的链按先到先算, 循环本身要 --solver simplex)
  const producers = new Map<string, string[]>();
  for (const r of Object.keys(plan.recipes)) for (const p of gd.recipes.get(r)?.products ?? []) producers.set(p.name, [...(producers.get(p.name) ?? []), r]);
  // 深度 = 最深的消费者再往下一层 (最长路径; 第九次对照: 铜板同时供红瓶和铜缆, 按最先碰到的层排会排在铜缆上面, FP 又把铜缆要的铜板当外购)
  const depth = new Map<string, number>();
  for (const it of Object.keys(plan.targets)) for (const r of producers.get(it) ?? []) depth.set(r, 0);
  const cap = Object.keys(plan.recipes).length + 1;
  for (let pass = 0; pass < cap; pass++) {
    let changed = false;
    for (const [r, d] of [...depth]) for (const ing of gd.recipes.get(r)?.ingredients ?? []) for (const p of producers.get(ing.name) ?? []) {
      if (d + 1 > (depth.get(p) ?? -1) && d + 1 <= cap) { depth.set(p, d + 1); changed = true; }
    }
    if (!changed) break;
  }
  const ordered = Object.entries(plan.recipes).sort(([a], [b]) => (depth.get(a) ?? 99) - (depth.get(b) ?? 99));
  const lines = ordered.map(([recipe, s]) => {
    const skipped: string[] = [];
    if (s.count) skipped.push(`固定 ${s.count} 台`);
    if (s.fuel) skipped.push(`燃料 ${s.fuel} (FP 用它的默认)`);
    for (const m of s.modules ?? []) if (!gd.modules.has(m.split("@")[0])) skipped.push(`不认识的插件 ${m}`);
    if (skipped.length) notes.push({ recipe, skipped });
    if (s.researchProductivity) productivity_boni[recipe] = s.researchProductivity;
    // 分享塔: 我们的 count = 每台机器被几座照到 = FP 的 amount (Line.lua: 单塔模式 amount = 1)
    const beacon = s.beacons && s.beacons.count > 0
      ? { class: "Beacon", proto: proto(s.beacons.name, "beacons"), quality_proto: qualityProto(s.beacons.quality), amount: s.beacons.count, module_set: moduleSet(s.beacons.modules) }
      : undefined;
    return {
      class: "Line", done: false, active: true, comment: "",
      recipe: { class: "Recipe", proto: proto(recipe, "recipes"), temperatures: {} },
      machine: { class: "Machine", proto: proto(s.machine, "machines"), quality_proto: qualityProto(s.quality), module_set: moduleSet(s.modules) },
      ...(beacon ? { beacon } : {}),
    };
  });
  return {
    packed: {
      class: "Factory", name: opts.name ?? "factorio-pilot 对照", blueprint_strings: {}, notes: "", productivity_boni, items,
      top_floor: { class: "Floor", level: 1, solver: opts.solver ?? "sequential", lines, gaussian_free_items: [], simplex_item_weights: [] },
    },
    notes,
  };
}

export type FpLine = { recipe: string; machine: string; machines: number; products: Record<string, number>; ingredients: Record<string, number> };
export type FpResult = { error?: string; valid?: boolean; lines: FpLine[]; products: Record<string, number>; /** 补丁接口附带的调试信息 (解包 / 校验 / 修复各剩几条) */ debug?: unknown };

const nameOf = (p: unknown): string => (p && typeof p === "object" && "name" in p ? String((p as { name: unknown }).name) : String(p ?? ""));
/** FP 的数量按秒; 我们的按分钟 */
const PER_MIN = 60;
const simpleItems = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as object) : [];
  for (const it of list as { proto?: unknown; name?: unknown; amount?: number }[]) { const n = nameOf(it.proto ?? it.name); if (n) out[n] = (out[n] ?? 0) + Number(it.amount ?? 0) * PER_MIN; }
  return out;
};

/** solve_packed 的回复 (pack(full)) → 每条生产线的机器数、产物、原料 (楼层递归; 出错时 error) */
export function parseFpResult(raw: unknown): FpResult {
  const r = (raw ?? {}) as { error?: string; valid?: boolean; items?: unknown; top_floor?: { lines?: unknown }; debug?: unknown };
  if (r.error) return { error: r.error, lines: [], products: {}, debug: r.debug };
  const lines: FpLine[] = [];
  const walk = (floor: { lines?: unknown } | undefined) => {
    const list = Array.isArray(floor?.lines) ? floor!.lines : floor?.lines && typeof floor.lines === "object" ? Object.values(floor.lines as object) : [];
    for (const l of list as { class?: string; recipe?: { proto?: unknown }; machine?: { proto?: unknown; amount?: number }; products?: unknown; ingredients?: unknown; lines?: unknown }[]) {
      if (l.class === "Floor") { walk(l); continue; }
      lines.push({ recipe: nameOf(l.recipe?.proto), machine: nameOf(l.machine?.proto), machines: Number(l.machine?.amount ?? 0), products: simpleItems(l.products), ingredients: simpleItems(l.ingredients) });
    }
  };
  walk(r.top_floor);
  const products: Record<string, number> = {};
  const items = Array.isArray(r.items) ? r.items : r.items && typeof r.items === "object" ? Object.values(r.items as object) : [];
  for (const it of items as { proto?: unknown; category?: string; amount?: number }[]) if (it.category === "product") products[nameOf(it.proto)] = Number(it.amount ?? 0) * PER_MIN;
  return { valid: r.valid, lines, products, debug: r.debug };
}

export type Comparison = { recipe: string; machine: string; ours: number; fp: number | null; diffPct: number | null; note?: string };

/** 并排比每个配方的机器数 (小数、满负荷); fp 里没有这条线就 null; 差 = (fp - ours) / ours */
export function compareRows(ours: Result, fp: FpResult, notes: PackNote[] = []): Comparison[] {
  const byRecipe = new Map(fp.lines.map((l) => [l.recipe, l]));
  return ours.rows.map((row) => {
    const f = byRecipe.get(row.recipe);
    const note = notes.find((n) => n.recipe === row.recipe)?.skipped.join("; ");
    return { recipe: row.recipe, machine: row.machine, ours: +row.machines.toFixed(3), fp: f ? +f.machines.toFixed(3) : null, diffPct: f && row.machines > 0 ? +(((f.machines - row.machines) / row.machines) * 100).toFixed(1) : null, note };
  });
}

/** 对照报告的一行一行文字 (给命令行和 docs) */
export function comparisonLines(cmp: Comparison[], tolerancePct = 2): string[] {
  return cmp.map((c) => {
    const flag = c.fp === null ? "？FP 没算这条" : Math.abs(c.diffPct ?? 0) <= tolerancePct ? "✅" : "❌";
    return `${flag} ${c.recipe} (${c.machine}): 我们 ${c.ours} 台, FP ${c.fp ?? "—"} 台${c.diffPct === null ? "" : ` (${c.diffPct > 0 ? "+" : ""}${c.diffPct}%)`}${c.note ? ` [没转进 FP: ${c.note}]` : ""}`;
  });
}
