// 用 注入客户端的程序 (game/client) 读游戏状态 (M4 基线; 旧项目 docs/io-client.md 第 10、11 节)。
// 搬自第一版 pilot/src/game/state.ts (按"写新模块前先查已有的": 结果在 objects[].attributes、玩家信封在 player、
// 分页用 truncated / next_offset、背包按角色读) —— 第一版的代码当待核实, 每个函数都有沙盘真值测试 (旧项目 baseline.ts; 新项目 test/sandbox/actions.test.ts)。
import type { CallResult } from "../game/client/connect.ts";

export type Call = (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
type Obj = { attributes?: Record<string, unknown>; valid_for_read?: boolean };
type Page = { objects?: Obj[]; truncated?: boolean; next_offset?: number; player?: Record<string, unknown>; tick?: number; selection_complete?: boolean };

/** 区域查询有没有因为条数漏掉: 0.0.11 起看 selection_complete (truncated 还包括嵌套值按深度省略); 老版本没有这个字段就看 truncated */
export const areaCut = (page: { truncated?: boolean; selection_complete?: boolean }) => page.selection_complete === undefined ? Boolean(page.truncated) : page.selection_complete === false;

async function must(call: Call, name: string, args: Record<string, unknown>): Promise<Page> {
  const r = await call(name, args);
  if (!r.ok) throw new Error(`${name} 失败: ${r.error}`);
  return (r.data ?? {}) as Page;
}

/** 按页读完 (truncated → next_offset), 每页 limit 条 */
async function allPages(call: Call, args: Record<string, unknown>, limit = 128): Promise<Obj[]> {
  const out: Obj[] = [];
  let offset = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await must(call, "world_query", { ...args, limit, offset });
    out.push(...(page.objects ?? []));
    if (!page.truncated || page.next_offset === undefined) return out;
    offset = page.next_offset;
  }
  throw new Error("分页超过 1000 页");
}

export async function readPlayer(call: Call) {
  const r = await must(call, "world_query", { selection: { kind: "player" }, fields: ["index", "name", "controller_type", "character", "cursor_stack", "crafting_queue_size", "driving"] });
  const a = r.objects?.[0]?.attributes ?? {};
  const env = r.player ?? {};
  const pos = (env.physical_position ?? env.position) as { x: number; y: number } | undefined;
  const surface = ((env.physical_surface ?? env.surface) as { name?: string } | undefined)?.name;
  const cursor = a.cursor_stack as { valid_for_read?: boolean; name?: string; count?: number } | undefined;
  return { tick: r.tick, name: env.name as string, position: pos, surface, controllerType: a.controller_type, hasCharacter: Boolean(a.character), cursor: cursor?.valid_for_read ? { name: cursor.name, count: cursor.count } : null, craftingQueueSize: typeof a.crafting_queue_size === "number" ? a.crafting_queue_size : undefined };
}

/** 背包: 按角色读 (第一版: 默认按玩家读时, 远程视图 / 开场动画 / 重连会报"物品栏不可用", 角色其实好好的) */
export async function readInventory(call: Call): Promise<Record<string, number>> {
  let objs: Obj[];
  try { objs = await allPages(call, { selection: { kind: "inventory", owner: { kind: "character" } }, fields: ["name", "count"] }, 512); }
  catch { objs = await allPages(call, { selection: { kind: "inventory" }, fields: ["name", "count"] }, 512); }
  const inv: Record<string, number> = {};
  for (const o of objs) {
    if (!o.valid_for_read) continue;
    const n = String(o.attributes?.name);
    inv[n] = (inv[n] ?? 0) + Number(o.attributes?.count ?? 0);
  }
  return inv;
}

/** 当前研究、进度、已研究的科技 (按页) */
export async function readResearch(call: Call) {
  const f = await must(call, "world_query", { selection: { kind: "force" }, fields: ["current_research", "research_progress"] });
  const a = f.objects?.[0]?.attributes ?? {};
  const techs = await allPages(call, { selection: { kind: "technologies" }, fields: ["name", "researched"] });
  return { current: ((a.current_research as { name?: string } | undefined)?.name) ?? null, progress: Number(a.research_progress ?? 0), researched: new Set(techs.filter((t) => t.attributes?.researched).map((t) => String(t.attributes?.name))) };
}

/** 一块区域的实体 (按页); fields 默认名字、位置、状态 */
export async function readEntities(call: Call, area: { left_top: { x: number; y: number }; right_bottom: { x: number; y: number } }, fields = ["name", "position", "status"]) {
  // 区域实体查询不收 offset (只有目录类收; 注入客户端的程序 tools.md 查询大小表): 一次读, 满了要切区域再读 (第一版 readArea 的做法, 下一步搬)
  const page = await must(call, "world_query", { selection: { kind: "entities", area }, fields, limit: 256 });
  if (areaCut(page)) throw new Error("区域里实体超过 256 个, 要切区域再读 (待搬第一版的分区读)");
  return (page.objects ?? []).map((o) => o.attributes ?? {});
}

/** 从 inspect 回复里抽出物流请求 (任意形状: value{name} / name 加 min / max / count)。原样搬自第一版 pilot manual.ts extractFilters */
export function extractFilters(data: unknown): { item: string; min?: number; max?: number }[] {
  const out: { item: string; min?: number; max?: number }[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 12 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const o = node as Record<string, any>;
    const value = o.value && typeof o.value === "object" ? o.value : undefined;
    const name = value?.name ?? (typeof o.name === "string" && ("min" in o || "count" in o) ? o.name : undefined);
    if (typeof name === "string" && ("min" in o || "max" in o || "count" in o)) {
      const min = typeof o.min === "number" ? o.min : typeof o.count === "number" ? o.count : undefined;
      out.push({ item: name, min, ...(typeof o.max === "number" ? { max: o.max } : {}) });
      return;
    }
    for (const child of Object.values(o)) walk(child, depth + 1);
  };
  walk(data, 0);
  return out;
}

type EntityRef = { name: string; position: { x: number; y: number } };
export type RequestPath = "sections" | "get_section";

/**
 * 物流箱 / 接驳站的请求, 按分组读 (没有 max = 无限)。2026-11-02 T9 对 注入客户端的程序 0.0.10 实测三条路:
 * `sections[i].filters` 和 `get_section(i).filters` 都读得到; 实体查询 `include: ["filters"]` 读不到 (那只是机械臂 / 装卸机 / 矿机的过滤,
 * 第一版日志"filters 字段读不到请求箱"就是这个)。默认走 sections。
 */
export async function readRequests(call: Call, entity: EntityRef, path: RequestPath = "sections") {
  const target = { kind: "entities", name: entity.name, position: entity.position };
  // 0.0.11: values 模式 (默认) 不收 limit, 表要条目和总数得写 mode: "entries"
  const inspect = (p: unknown[], entries = false) => must(call, "world_query", { selection: { kind: "inspect", target, path: p }, ...(entries ? { mode: "entries", limit: 64 } : {}) });
  const secs = await inspect([{ method: "get_logistic_sections" }, { property: "sections" }], true);
  const total = Number((secs.objects?.[0] as { total?: number } | undefined)?.total ?? 0);
  const out: { item: string; min?: number; max?: number; section: number }[] = [];
  for (let i = 1; i <= total; i++) {
    const p = path === "sections"
      ? [{ method: "get_logistic_sections" }, { property: "sections" }, { index: i }, { property: "filters" }]
      : [{ method: "get_logistic_sections" }, { method: "get_section", arguments: [i] }, { property: "filters" }];
    for (const f of extractFilters((await inspect(p)).objects)) out.push({ ...f, section: i });
  }
  return out;
}

/** 机器当前的配方名 (没有 = null): 实体查询 include recipe (inspect get_recipe 也行, 2026-11-02 T9 两条都对) */
export async function readRecipe(call: Call, at: { x: number; y: number }): Promise<string | null> {
  const r = await must(call, "world_query", { selection: { kind: "entities", position: at }, fields: ["name"], include: ["recipe"] });
  const d = (r.objects?.[0] as { details?: { recipe?: { recipe?: { name?: string } | null } } } | undefined)?.details;
  return d?.recipe?.recipe?.name ?? null;
}

type Area = { left_top: { x: number; y: number }; right_bottom: { x: number; y: number } };

/**
 * 读一大片区域的实体。注入客户端的程序 0.0.9 起区域查询不再限每边 128 格, limit 只是建议值 (tools.md "Query sizes"), 所以先一次读完;
 * 真被截断才退回第一版的做法 (pilot layout-diff / damage-report: 四等分再读, 最多 6 轮), 并按实体编号去重 ——
 * 跨在两块边界上的大实体会被两块各读到一次, 第一版 damage-report 没去重会重复计数。
 */
export async function readArea(call: Call, area: Area, fields = ["name", "position"], limit = 100_000, filter: { type?: string[]; name?: string[] } = {}) {
  const want = [...new Set([...fields, "unit_number", "name", "position"])];
  const seen = new Map<string, Record<string, unknown>>();
  let boxes: Area[] = [area];
  let calls = 0, splits = 0, truncated = false;
  for (let round = 0; round < 6 && boxes.length; round++) {
    const again: Area[] = [];
    for (const b of boxes) {
      // 按类型 / 名字筛 (注入客户端的程序 0.0.10: selection 的 type / name 收一个字符串或不重复的列表, 列表内是"或")
      const page = await must(call, "world_query", { selection: { kind: "entities", area: b, ...(filter.type?.length ? { type: filter.type } : {}), ...(filter.name?.length ? { name: filter.name } : {}) }, fields: want, limit });
      calls++;
      const w = b.right_bottom.x - b.left_top.x;
      if (areaCut(page) && w > 8) {
        const mx = (b.left_top.x + b.right_bottom.x) / 2, my = (b.left_top.y + b.right_bottom.y) / 2;
        again.push({ left_top: b.left_top, right_bottom: { x: mx, y: my } }, { left_top: { x: mx, y: b.left_top.y }, right_bottom: { x: b.right_bottom.x, y: my } },
          { left_top: { x: b.left_top.x, y: my }, right_bottom: { x: mx, y: b.right_bottom.y } }, { left_top: { x: mx, y: my }, right_bottom: b.right_bottom });
        splits++;
        continue;
      }
      if (areaCut(page)) truncated = true;
      for (const o of page.objects ?? []) {
        const a = o.attributes ?? {};
        const pos = a.position as { x: number; y: number } | undefined;
        const key = a.unit_number != null ? `u${a.unit_number}` : `${a.name}@${pos?.x},${pos?.y}`;
        seen.set(key, a);
      }
    }
    boxes = again;
  }
  return { entities: [...seen.values()], calls, splits, truncated };
}
