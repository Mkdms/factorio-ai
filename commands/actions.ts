// ./fh 的动作翻译成玩家操作 (M4 第 4 步; 旧项目 docs/io-client.md 11j): 服务器上不装模组, 每个 AI 一个干净的真客户端, 动作只发键鼠、界面点击和普通玩家动作。
// 走路、放建筑、取放、设配方在第二版已有 (body.ts、gui.ts、walk.ts; 旧项目测试集 56/56); 手搓、挖、研究、旋转搬自第一版 pilot/src/skills (那边在 注入客户端的程序 服务器上真用过), 当待核实, 真值看 npm run io:actcheck。
// 操控 MK 的身体也走这里: 没有控制台命令, 不影响成就 (上真服后要真拿一个才算核过)。
// 回复格式照模组 (班次 10-16-30 journal 的样子), 不同的: 模组是发起后计时跑, 这里做完才回, 所以回复里没有 until_tick, 命令行 --wait 也就不用再等。
import { Timeline } from "./timeline.ts";
import { cancelResearch, clickWidget, closeWindows, craftByHand, invSlot, openCharacterGui, readTree, researchTech } from "./gui.ts";
import { readArea, readInventory, readPlayer, type Call } from "./query.ts";
import { PASSABLE, walkTo } from "./walk.ts";
import type { Controls, ResolvedControl } from "./controls.ts";
import type { Defines } from "../game/sandbox/defines.ts";

export type Pos = { x: number; y: number };
export type FhRequest = { id?: string; action?: string; args?: Record<string, unknown> };
export type FhReply = { id?: string; ok: boolean; tick: number; result?: Record<string, unknown>; error?: { code: string; message: string } };

/** 够得着的距离 (2.1.24 实测 10 格; 挖矿 2.7): 留点余量, 边上时鼠标选不中 */
const BUILD_REACH = 10, MINE_REACH = 2.7;
/** 一次按住挖多久 (它的 input 要等时间线走完): 一个矿 2 秒, 最多一次 10 个 */
const TICKS_PER_ORE = 122, MINE_BURST = 10;
/** 不带 walk: true 时一条命令最多走多远; move_to 一次最多走多远 (再远回 arrived: false, 再跑一次) */
const WALK_DEFAULT = 64, MOVE_MAX = 400;
/** 一条命令最多干多久: 命令行等同一个 id 最多 90 秒, 到点先回做了多少 */
const ACT_BUDGET_MS = 60_000;
/** 开枪: 一条命令最多按多久 (和模组 shoot 的上限一样); 每隔多久看一眼血量 (撤退、死了) */
const SHOOT_MAX_TICKS = 600, SHOOT_SLICE_TICKS = 60, SHOOT_TRACK_TICKS = 15;
/** auto 找多远的敌人: 最长的单兵枪射程 (冲锋枪 18 格) */
const SHOOT_SCAN_RADIUS = 18;
/** 一个弹匣几发 (普通、穿甲、贫铀都是 10) */
const MAGAZINE_ROUNDS = 10;

/** 鼠标指着, 按住挖 ticks 个 tick; 中途重按, 切窗口不会一直停到这批结束 */
export function mineHold(mine: ResolvedControl, at: Pos, ticks: number) {
  return new Timeline().worldPosition(at, 0, ticks - 1).holdControl(mine, 1, ticks - 1);
}

const DIR_BY_NAME: Record<string, number> = { north: 0, northeast: 2, east: 4, southeast: 6, south: 8, southwest: 10, west: 12, northwest: 14 };
export const NAME_BY_DIR = Object.fromEntries(Object.entries(DIR_BY_NAME).map(([k, v]) => [v, k])) as Record<number, string>;
const FUELS = new Set(["wood", "coal", "solid-fuel", "rocket-fuel", "nuclear-fuel", "uranium-fuel-cell", "fusion-power-cell", "carbon", "yumako-mash", "jelly", "bioflux", "spoilage"]);

/** 模组叫法 → defines.inventory 的名字 */
const INV_NAMES: Record<string, string> = { fuel: "fuel", chest: "chest", input: "crafter_input", source: "crafter_input", crafter_input: "crafter_input", output: "crafter_output", result: "crafter_output", crafter_output: "crafter_output", lab: "lab_input", lab_input: "lab_input", ammo: "turret_ammo", turret_ammo: "turret_ammo", burnt_result: "burnt_result" };

/** 往实体放这种物品进哪个物品栏 (纯函数): 模型写了就听它的, 否则按实体种类和物品 (模组回 inventory: "fuel" 这种, 见 transfer 样子) */
export function insertInventory(entityType: string, item: string, named?: string): string {
  if (named && INV_NAMES[named]) return INV_NAMES[named];
  switch (entityType) {
    case "lab": return "lab_input";
    case "ammo-turret": return "turret_ammo";
    case "boiler": case "mining-drill": case "inserter": case "car": case "locomotive": return "fuel";
    case "furnace": return FUELS.has(item) ? "fuel" : "crafter_input";
    case "assembling-machine": case "rocket-silo": return "crafter_input";
    default: return "chest";
  }
}

/** 从实体取这种物品, 依次看哪些物品栏 (纯函数) */
export function takeInventories(entityType: string, named?: string): string[] {
  if (named && INV_NAMES[named]) return [INV_NAMES[named]];
  switch (entityType) {
    case "furnace": case "assembling-machine": case "rocket-silo": return ["crafter_output", "crafter_input", "fuel"];
    case "lab": return ["lab_input"];
    case "ammo-turret": return ["turret_ammo"];
    case "boiler": case "mining-drill": case "inserter": return ["fuel", "burnt_result"];
    default: return ["chest"];
  }
}

/** 从现在的方向转到要的方向要按几下旋转键 (顺时针 90 度一下, 16 方向制); 不是 4 个正方向的回 null */
export function rotateTurns(from: number, to: number): number | null {
  if (from % 4 !== 0 || to % 4 !== 0) return null;
  return (((to - from) / 4) % 4 + 4) % 4;
}

/** 能按住拖着放的: 普通传送带和水管 (地下带、地下管、分流器不拖; 电线杆不拖: 模组按接线距离算好了每根的位置, 拖着放游戏会自己挑位置) */
const DRAG_ITEM = /^(?:(?:fast-|express-|turbo-)?transport-belt|pipe)$/;
/** 拖一段最多几格: 角色站在段中间, 两头都在够得着的 10 格里 */
export const DRAG_MAX = 14;
const STEP: Record<number, [number, number]> = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };

/**
 * 逐格清单里能一口气拖着放的直线段 (纯函数): 同一种普通传送带、同方向、下一格正好在带子朝向上挨着 (水管没有方向: 按头两格的走向, 后面一格格同一走向挨着); 每段最多 max 格, 不到 3 格不拖。
 * 回每段的 [起, 止] 下标 (从 0 数, 含两头)。拐角那格的方向是出去那段的, 所以归下一段。
 * 注入客户端的程序 0.0.11 起一条 input 时间线能按住建造键沿多段路径拖 (game/client/tools.md "Input timelines"), 原来一格一格走过去放 (沙盘 21 格)。
 */
export function dragRuns(tiles: { item: string; position: Pos; direction: number | null }[], max = DRAG_MAX): [number, number][] {
  const runs: [number, number][] = [];
  for (let i = 0; i < tiles.length;) {
    const t = tiles[i];
    let s: [number, number] | undefined = t.direction === null ? undefined : STEP[t.direction];
    if (t.direction === null && tiles[i + 1]) {
      // 没方向的 (水管): 走向看下一格, 只认横平竖直挨着的
      const dx = tiles[i + 1].position.x - t.position.x, dy = tiles[i + 1].position.y - t.position.y;
      if ((Math.abs(Math.abs(dx) - 1) < 0.01 && Math.abs(dy) < 0.01) || (Math.abs(dx) < 0.01 && Math.abs(Math.abs(dy) - 1) < 0.01)) s = [Math.round(dx), Math.round(dy)];
    }
    if (!s || !DRAG_ITEM.test(t.item)) { i++; continue; }
    let j = i;
    while (j + 1 < tiles.length && j - i + 1 < max) {
      const a = tiles[j], b = tiles[j + 1];
      if (b.item !== t.item || b.direction !== t.direction || Math.abs(b.position.x - a.position.x - s[0]) > 0.01 || Math.abs(b.position.y - a.position.y - s[1]) > 0.01) break;
      j++;
    }
    if (j - i + 1 >= 3) runs.push([i, j]);
    i = j + 1;
  }
  return runs;
}

/**
 * 一批建筑 (./bp build 整块建) 的放置顺序 (纯函数, 稳定排序): 按物品、再按方向排 —— 少换手 (每换一种要开背包拿一次)、少转向;
 * 同一种同方向的再按"横穿的那一维、顺着方向的那一维"排, 同一条直线上的带子挨在一起 (能拖着放), 地下带入口在出口前面。
 * 同样的输入排出来的顺序一样, 所以 start_index 接着放不乱 (src/play/bp-online.ts 每次传同一批)。
 */
export function buildOrder<T extends Record<string, unknown>>(rows: T[]): T[] {
  const dirOf = (r: T) => (typeof r.direction === "string" ? DIR_BY_NAME[r.direction] ?? 0 : typeof r.direction === "number" ? r.direction : 0);
  const keyed = rows.map((r, idx) => {
    const p = posOf(r.position) ?? { x: 0, y: 0 };
    const d = dirOf(r);
    const s = STEP[d] ?? [1, 0];
    return { r, item: String(r.item ?? r.name ?? ""), d, cross: s[0] !== 0 ? p.y : p.x, along: p.x * s[0] + p.y * s[1], idx };
  });
  keyed.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0) || a.d - b.d || a.cross - b.cross || a.along - b.along || a.idx - b.idx);
  return keyed.map((k) => k.r);
}

/** 放歪了能"转手上的方向、原地再放一次"改过来的 (快速替换同名的会按手上的方向换掉): 普通带子、机械臂。地下带不行 (会把入口出口翻过来) */
const REPLACE_TO_ROTATE = new Set(["transport-belt", "inserter"]);

/** build_path 的点 → 每格带子的位置和方向 (纯函数): 只能横平竖直; 最后一格用 end_direction, 没给就接着上一段的方向。不合规矩的抛错 */
/**
 * 模组试算的方案 → 一格格放的清单 (纯函数): pole_route 回 positions + item; belt_route / pipe_route 加 details 回 entities {name, position, direction, type?}。
 * 水管、电线杆不管方向; 地下带的出口端不转 (放在入口下游同向时游戏自动配成出口, 转它会把入口出口翻过来; 待沙盘核)
 */
export function routeTiles(action: string, plan: Record<string, unknown>): { item: string; position: Pos; direction: number | null }[] {
  if (action === "pole_route") {
    const item = typeof plan.item === "string" ? plan.item : "small-electric-pole";
    return (Array.isArray(plan.positions) ? plan.positions : []).map(posOf).filter((p): p is Pos => !!p).map((position) => ({ item, position, direction: null }));
  }
  const out: { item: string; position: Pos; direction: number | null }[] = [];
  for (const e of (Array.isArray(plan.entities) ? plan.entities : []) as Record<string, unknown>[]) {
    const position = posOf(e.position), item = typeof e.name === "string" ? e.name : "";
    if (!position || !item) continue;
    const d = typeof e.direction === "number" ? e.direction : typeof e.direction === "string" ? DIR_BY_NAME[e.direction] ?? null : 0;
    const undirected = item === "pipe" || /electric-pole|substation/.test(item) || ((e.type === "output" || e.ug_type === "output") && /underground-belt/.test(item));
    out.push({ item, position, direction: undirected ? null : d });
  }
  return out;
}

export function pathTiles(points: Pos[], endDirection?: string): { position: Pos; direction: number }[] {
  if (points.length < 2) throw new Error("build_path 要至少 2 个点 (points)");
  const out: { position: Pos; direction: number }[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx !== 0 && dy !== 0) throw new Error(`build_path 的点要横平竖直: ${fmt(a)} 到 ${fmt(b)} 是斜的`);
    if (dx === 0 && dy === 0) continue;
    const dir = dx > 0 ? 4 : dx < 0 ? 12 : dy > 0 ? 8 : 0;
    const len = Math.abs(dx) + Math.abs(dy);
    for (let k = 0; k < len; k++) out.push({ position: { x: a.x + Math.sign(dx) * k, y: a.y + Math.sign(dy) * k }, direction: dir });
  }
  const last = points[points.length - 1];
  const prev = out[out.length - 1]?.direction ?? 4;
  const end = endDirection === undefined ? prev : DIR_BY_NAME[endDirection];
  if (end === undefined) throw new Error(`end_direction 不认识: ${endDirection}`);
  out.push({ position: last, direction: end });
  return out;
}

/** collect / refuel / feed 的目标: positions 优先, 否则 position (或角色) 周围 radius 格; 上限 64 (一条命令走太远就超时) */
export function targetArea(a: Record<string, unknown>, me: Pos, defaultRadius = 32): { positions?: Pos[]; box?: { left_top: Pos; right_bottom: Pos } } {
  const list = Array.isArray(a.positions) ? a.positions.map(posOf).filter((p): p is Pos => !!p) : [];
  if (list.length) return { positions: list };
  const area = a.area as { left_top?: unknown; right_bottom?: unknown } | undefined;
  const lt = posOf(area?.left_top), rb = posOf(area?.right_bottom);
  if (lt && rb) return { box: { left_top: lt, right_bottom: rb } };
  const c = posOf(a.position) ?? me;
  const r = Math.min(typeof a.radius === "number" ? a.radius : defaultRadius, 64);
  return { box: { left_top: { x: c.x - r, y: c.y - r }, right_bottom: { x: c.x + r, y: c.y + r } } };
}

/** 手搓队列要多久 (秒): 手搓速度 1 */
export const handSeconds = (timeS: number, count: number) => Math.round(timeS * count * 10) / 10;

const NOT_ENTITIES = new Set(["character", "item-entity", "corpse", "character-corpse", "flying-text", "entity-ghost"]);
/** 人走得过去 (walk.ts PASSABLE) 但上面放不了建筑的。高架铁轨不算: 地上的建筑和它不碰撞 (支架是单独的类型)。2026-11-06 真服: 干跑直接用 PASSABLE, 带子和铁轨上也说放得下 */
const WALK_THROUGH_BUT_BLOCKS = new Set(["transport-belt", "underground-belt", "splitter", "lane-splitter", "linked-belt", "loader", "loader-1x1", "pipe-to-ground", "heat-pipe", "land-mine", "straight-rail", "curved-rail-a", "curved-rail-b", "half-diagonal-rail", "legacy-straight-rail", "legacy-curved-rail", "rail-signal", "rail-chain-signal"]);
/** 这种东西占着格子时, 同一格能不能放别的建筑 (纯函数; 树石单独算要拆的) */
export const blocksBuild = (type: string) => WALK_THROUGH_BUT_BLOCKS.has(type) || !(PASSABLE.has(type) || NOT_ENTITIES.has(type));

export type ActionDeps = {
  call: Call;
  controls: () => Controls;
  defines: () => Defines | null;
  /** 当前客户端 tick */ tick: () => Promise<number>;
  holdItem: (item: string) => Promise<{ name: string; count: number } | null>;
  placeHeld: (at: Pos) => Promise<{ ok: boolean; error?: string; data?: unknown }>;
  clearCursor: () => Promise<void>;
  /** 做这条动作该带哪几条教训 (教训库, 开班那块接); 动作不经过模组, 模组带不了 */
  lessons?: (action: string, args: Record<string, unknown>) => string[];
  /** 确认角色在自己视角, 开着地图就退出来 (Body.ensureBody); 没给就不查 */
  ensureBody?: () => Promise<unknown>;
  setRecipe: (at: Pos, recipe: string) => Promise<unknown>;
  insertExact: (at: Pos, item: string, count: number, inv: number) => Promise<unknown>;
  takeExact: (at: Pos, item: string, count: number, inv: number) => Promise<unknown>;
  itemCount: (at: Pos, inv: number, item: string) => Promise<number>;
  stacks: () => Promise<({ name: string; count: number } | null)[]>;
  chatSend: (text: string) => Promise<{ ok: boolean; error?: string }>;
  /** 配方要几秒 (游戏数据); 不知道回 null */ recipeTime?: (recipe: string) => number | null;
  /** 配方能不能手搓、开局就有没有、哪些科技解锁它 (游戏数据, recipeFacts); 不知道回 null */ recipeInfo?: (recipe: string) => RecipeFacts | null;
  sleep?: (ms: number) => Promise<void>;
  /** 别人的服务器 = 协助模式 (I:\fn 总规则): 不拆不改别人的建筑和设置, 共享的材料每样不超过库存一半。me = 这个客户端的玩家名 */
  /** allowed: 用户点过头的位置 (别人的建筑也能动); 只有用户能给, 模型自己开不了 */
  assist?: { me: string; allowed?: (at: Pos) => boolean };
  /** 自己在游戏里的名字 (不是协助模式时也要: 挡路的建筑是不是自己放的) */
  me?: string;
  /** 问模组一句读 (游戏外的假接口上跑; 放不下时找附近放得下的位置用 placements): 问不到回 null; act = 按角色身份问 (模组的读者闸门不放行的试算) */
  read?: (action: string, args: Record<string, unknown>, act?: boolean) => Promise<Record<string, unknown> | null>;
  /** 这种建筑的下一档 (原型的 next_upgrade: 传送带 → 快速传送带, 石炉 → 钢炉); 没有回 null */
  nextUpgrade?: (entity: string) => string | null;
  /** 设请求格 (界面点选; configure 的 requests 用) */
  setRequest?: (at: Pos, item: string, min: number, max?: number) => Promise<unknown>;
};

export type RecipeFacts = { exists: boolean; handable: boolean; category: string; enabledAtStart: boolean; unlockedBy: string[] };

/**
 * 原型数据 (data-raw-dump) 里一个配方的事实 (纯函数): 类别 (没写 = crafting)、角色能不能手搓 (角色的 crafting_categories)、开局就有没有、哪些科技的 unlock-recipe 解锁它。
 * 手搓失败时说清楚为什么 (模型笔记里报过"手搓面板不显示解锁条件", 角色 journal 19 次只说"没解锁或不能手搓")
 */
export function recipeFacts(raw: { recipe?: Record<string, { category?: string; categories?: string[]; enabled?: boolean }>; technology?: Record<string, { name?: string; effects?: { type?: string; recipe?: string }[] }>; character?: Record<string, { crafting_categories?: string[] }> }, recipe: string): RecipeFacts {
  const r = raw.recipe?.[recipe];
  const hand = new Set(raw.character?.character?.crafting_categories ?? ["crafting"]);
  // 2.1 起是 categories (一个配方可以在几类机器里做; 2.1.24 原型导出实测), 之前是 category; 都没写 = crafting
  const cats = r?.categories ?? (r?.category ? [r.category] : ["crafting"]);
  const unlockedBy = Object.entries(raw.technology ?? {}).filter(([, t]) => (t.effects ?? []).some((e) => e.type === "unlock-recipe" && e.recipe === recipe)).map(([n]) => n).sort();
  return { exists: !!r, handable: cats.some((c) => hand.has(c)), category: cats.join(" / "), enabledAtStart: r?.enabled !== false, unlockedBy };
}

/** 协助模式: 这件东西动不动得 (纯函数): 树、石头、矿谁都能挖; 建筑只动自己放的 (last_user 是自己) */
export function assistVerdict(e: { name?: unknown; type?: unknown; last_user?: unknown; position?: { x: number; y: number } }, me: string): string | null {
  if (["resource", "tree", "simple-entity", "fish"].includes(String(e.type))) return null;
  const u = e.last_user as { name?: unknown } | string | undefined | null;
  const who = typeof u === "string" ? u : typeof u?.name === "string" ? u.name : "";
  if (who === me) return null;
  return `协助模式不动别人的东西: ${e.name} ${e.position ? fmt(e.position) : ""} 是${who ? ` ${who} ` : "别人"}放的。要动先在聊天里问 (./fh say)`;
}

/** 协助模式: 从别人的箱子最多拿多少 (库存一半, 向下取整); 自己的不限 */
export const assistTakeLimit = (want: number, stock: number, own: boolean) => (own ? Math.min(want, stock) : Math.min(want, Math.floor(stock / 2)));

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const posOf = (v: unknown): Pos | null => { const p = v as Partial<Pos> | undefined; return typeof p?.x === "number" && typeof p?.y === "number" ? { x: p.x, y: p.y } : null; };
const fmt = (p: Pos) => `(${p.x},${p.y})`;

/** 动手的这些命令 (say 也算: 别人看得到) */
const ACTION_NAMES = ["move_to", "build", "transfer", "craft", "mine", "rotate", "research", "say", "build_path", "collect", "refuel", "feed", "shoot", "pole_route", "belt_route", "pipe_route", "place_ghosts", "construct", "rebuild",
  "walk", "recover", "pickup", "deliver", "rearm", "upgrade", "belt_upgrade", "use_item", "clear_cliffs", "equip", "configure", "cancel_craft", "equipment"] as const;

/** --read-only 的行动层: 认得所有动作, 全部拒绝, 什么都不发给游戏 (这些动作模组的只读闸门有的不拦, 不接这一层就落到假接口上报怪错)。
 *  回复要带真的 tick: 写 0 命令行会当成世界回档了, 告诉模型 "the game rolled back" (2026-11-06 彩排查出) */
export const readOnlyActions = (tick: () => Promise<number>) => ({
  has(action: string): boolean { return (ACTION_NAMES as readonly string[]).includes(action); },
  async run(req: FhRequest): Promise<FhReply> { return { id: req.id, ok: false, tick: await tick(), error: { code: "read_only", message: `${req.action}: 现在只读, 什么都没发给游戏` } }; },
});

export class PlayerActions {
  readonly d: ActionDeps;
  static readonly NAMES = ACTION_NAMES;
  constructor(d: ActionDeps) { this.d = d; }

  has(action: string): boolean { return (PlayerActions.NAMES as readonly string[]).includes(action); }

  /** 这条命令到什么时候要收手 (走路、挖矿到点先回做了多少; 不然命令行 90 秒等不到, 动作还在后台按着键, 下一条报 Input is busy; 2026-11-06 io:actcheck) */
  private deadline = 0;

  async run(req: FhRequest): Promise<FhReply> {
    const a = (req.args ?? {}) as Record<string, unknown>;
    this.deadline = Date.now() + ACT_BUDGET_MS;
    try {
      // 聊天不用身体; 别的动手前确认角色在自己视角 (开着地图走不了路, 放下的只是虚影)
      if (req.action !== "say") await this.d.ensureBody?.();
      const result = await this.dispatch(req.action ?? "", a);
      const lessons = a.dry_run === true ? [] : this.d.lessons?.(req.action ?? "", a) ?? [];
      return { id: req.id, ok: true, tick: await this.d.tick(), result: lessons.length ? { ...result, lessons } : result };
    } catch (e) {
      // 窗口或手上留了东西, 下一条会错: 尽量收拾 (收拾失败不盖过原来的错)
      try { await this.d.clearCursor(); } catch { /* 原来的错更要紧 */ }
      const lessons = this.d.lessons?.(req.action ?? "", a) ?? [];
      return { id: req.id, ok: false, tick: await this.d.tick().catch(() => 0), error: { code: "action_failed", message: `${(e as Error).message}${lessons.length ? `\n相关教训: ${lessons.join(" / ")}` : ""}` } };
    }
  }

  private dispatch(action: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (action) {
      case "move_to": return this.moveTo(a);
      case "build": return this.build(a);
      case "transfer": return this.transfer(a);
      case "craft": return this.craft(a);
      case "mine": return this.mine(a);
      case "rotate": return this.rotate(a);
      case "research": return this.research(a);
      case "say": return this.say(a);
      case "build_path": return this.buildPath(a);
      case "pole_route": case "belt_route": case "pipe_route": return this.route(action, a);
      case "place_ghosts": return this.placeList(a);
      case "construct": case "rebuild": return this.constructGhosts(action, a);
      case "walk": return this.moveTo({ ...a, position: a.position ?? a.to });
      case "recover": return this.recover(a);
      case "pickup": return this.pickup(a);
      case "deliver": return this.deliver(a);
      case "rearm": return this.rearm(a);
      case "upgrade": case "belt_upgrade": return this.upgrade(action, a);
      case "use_item": return this.useItem(a);
      case "clear_cliffs": return this.clearCliffs(a);
      case "equip": return this.equip(a);
      case "configure": return this.configure(a);
      case "cancel_craft": return this.cancelCraft(a);
      case "equipment": return this.equipment(a);
      case "collect": return this.collect(a);
      case "refuel": return this.refuel(a);
      case "feed": return this.feed(a);
      case "shoot": return this.shoot(a);
      default: throw new Error(`${action} 还没翻译成玩家操作`);
    }
  }

  private async me(): Promise<Pos> {
    const p = (await readPlayer(this.d.call)).position;
    if (!p) throw new Error("读不到角色位置 (没有身体? 在远程视图?)");
    return p;
  }

  /** 走到够得着 at 的地方: at 常在建筑里走不到中心, 以它为圆心取一圈点, 离自己近的先试; 够得着就不走。回走了多远 */
  private async walkInto(at: Pos, reach: number, walk = false): Promise<number> {
    const from = await this.me();
    const dist = Math.hypot(from.x - at.x, from.y - at.y);
    if (dist <= reach - 0.5) return 0;
    // 命令行重发的上限是 90 秒, 走路一秒约 9 格 (模组默认也只走 32 格, 再远要 walk: true); 走太远这条命令就答不上了
    if (dist > WALK_DEFAULT && !walk) throw new Error(`${fmt(at)} is ${Math.round(dist)} tiles away, past the ${WALK_DEFAULT} a call walks by default: move_to first, or walk: true`);
    // 走到最近的够得着的空位: 原来只试圆上 4 个点, 基地里这些点大多被机器占着, 真服 3 次"算不出路", 其实够得着的空位有几十个 (2026-11-06, lab.md #101)
    const w = await walkTo(this.d.call, this.d.controls(), at, { within: Math.max(1.2, reach - 1.5), tolerance: 1, deadline: this.deadline });
    const now = w.at;
    if (Math.hypot(now.x - at.x, now.y - at.y) <= reach - 0.3) return Math.round(Math.hypot(now.x - from.x, now.y - from.y) * 10) / 10;
    if (w.timedOut) throw new Error(`一条命令最多干 ${ACT_BUDGET_MS / 1000} 秒, 还没走到 ${fmt(at)}, 现在在 ${fmt(now)}: 再跑一次接着走`);
    throw new Error(`走不到够得着 ${fmt(at)} 的地方 (够得着 ${reach} 格): ${w.reason ?? ""}; 现在在 ${fmt(now)}`);
  }

  /** 协助模式: 放下去会替换这一格别人的东西就拒 (放快速机械臂到普通机械臂上 = 快速替换; 2026-11-06 真服第一班查出来闸门没管 build) */
  private async refuseReplacing(at: Pos): Promise<string | null> {
    if (!this.d.assist) return null;
    const there = await this.entityAt(at);
    if (!there || Math.hypot(there.position.x - at.x, there.position.y - at.y) > 0.75) return null;
    // 虚影 (队友放的、蓝图贴的、被毁的建筑留下的) 照着建是帮忙, 不算动别人的东西 (construct / rebuild)
    if (there.type === "entity-ghost") return null;
    return this.refuseOthers(there);
  }

  /** place_ghosts: 这条路上没有机器人, 虚影没人建 → 清单里的东西直接放实物 (要背包里有); 参数和模组的一样 (entities [{name, position, direction?, recipe?}]) */
  private async placeList(a: Record<string, unknown>) {
    const ents = (Array.isArray(a.entities) ? a.entities : []) as Record<string, unknown>[];
    if (!ents.length) throw new Error(`place_ghosts 要 entities: [{"name":"stone-furnace","position":{"x":1,"y":2}}] (这条路上没有机器人, 直接放实物; 整块的用 ./bp build)`);
    const dirName = (d: unknown) => (typeof d === "string" ? d : typeof d === "number" ? NAME_BY_DIR[d] : undefined);
    const builds = ents.map((e) => ({ item: String(e.name ?? e.item ?? ""), position: e.position, ...(dirName(e.direction) ? { direction: dirName(e.direction) } : {}), ...(typeof e.recipe === "string" ? { recipe: e.recipe } : {}) }));
    if (a.dry_run === true) return this.buildCheck(builds);
    const out = await this.build({ builds, walk: true, skip_existing: true, ...(typeof a.start_index === "number" ? { start_index: a.start_index } : {}) });
    return { op: "place_ghosts", note: "没有机器人, 虚影没人建: 直接放了实物", ...out };
  }

  /** recover: 走到自己的尸体挖回背包 (近的先; 尸体 = character-corpse) */
  private async recover(a: Record<string, unknown>) {
    const me = await this.me();
    const r = Math.min(typeof a.radius === "number" ? a.radius : 256, 256);
    const box = { left_top: { x: me.x - r, y: me.y - r }, right_bottom: { x: me.x + r, y: me.y + r } };
    const corpses = ((await readArea(this.d.call, box, ["name", "type", "position"], 64, { type: ["character-corpse"] })).entities as Record<string, any>[])
      .sort((p, q) => Math.hypot(p.position.x - me.x, p.position.y - me.y) - Math.hypot(q.position.x - me.x, q.position.y - me.y));
    if (!corpses.length) return { op: "recover", corpses: 0, note: `${r} 格内没有尸体` };
    let recovered = 0;
    for (const c of corpses) {
      if (Date.now() > this.deadline - 15_000) break;
      await this.mine({ position: c.position, walk: true });
      recovered++;
    }
    return { op: "recover", corpses: corpses.length, recovered, ...(recovered < corpses.length ? { not_done: "再跑一次接着拿" } : {}) };
  }

  /** pickup: 地上的物品 (item-on-ground), 走过去按住拾取键; 回实际进背包多少 */
  private async pickup(a: Record<string, unknown>) {
    const me = await this.me();
    const t = targetArea(a, me, 10);
    const box = t.box ?? { left_top: { x: Math.min(...t.positions!.map((p) => p.x)) - 1, y: Math.min(...t.positions!.map((p) => p.y)) - 1 }, right_bottom: { x: Math.max(...t.positions!.map((p) => p.x)) + 1, y: Math.max(...t.positions!.map((p) => p.y)) + 1 } };
    const items = ((await readArea(this.d.call, box, ["name", "type", "position"], 512, { type: ["item-entity"] })).entities as Record<string, any>[])
      .sort((p, q) => Math.hypot(p.position.x - me.x, p.position.y - me.y) - Math.hypot(q.position.x - me.x, q.position.y - me.y));
    if (!items.length) return { op: "pickup", picked: 0, note: "范围里地上没有东西" };
    const total = async () => Object.values(await readInventory(this.d.call)).reduce((n, c) => n + c, 0);
    const before = await total();
    const control = this.d.controls().resolve("pick-items");
    // 拾取键只捡角色身边一小圈 (2026-11-08 沙盘: 站在一处按住, 撒开的 20 块只捡回 4~6): 每轮重读地上还剩的, 走到最近那件按 1 秒; 连着 3 轮背包不增加就停
    let stuck = 0;
    for (let round = 0; round < 60 && stuck < 3 && Date.now() < this.deadline - 8_000; round++) {
      const here = await this.me();
      const left = ((await readArea(this.d.call, box, ["name", "type", "position"], 512, { type: ["item-entity"] })).entities as Record<string, any>[])
        .sort((p, q) => Math.hypot(p.position.x - here.x, p.position.y - here.y) - Math.hypot(q.position.x - here.x, q.position.y - here.y));
      if (!left.length) break;
      await walkTo(this.d.call, this.d.controls(), left[0].position as Pos, { tolerance: 0.4, deadline: this.deadline }).catch(() => undefined);
      const was = await total();
      const r = await this.d.call("input", { timeline: new Timeline().holdControl(control, 0, 60).entries });
      if (!r.ok) throw new Error(`拾取键没按下去: ${(r.error ?? "").slice(0, 160)}`);
      stuck = (await total()) > was ? 0 : stuck + 1;
    }
    const picked = (await total()) - before;
    return { op: "pickup", on_ground: items.length, picked, ...(picked <= 0 ? { note: "一件都没进背包 (背包满了?)" } : {}) };
  }

  /** deliver: 物品送进目标 (燃料、弹药、原料): 走过去一样样放; 这条路上没有机器人送货 */
  private async deliver(a: Record<string, unknown>) {
    const want: [string, number][] = Array.isArray(a.items)
      ? (a.items as unknown[]).map((x) => (typeof x === "string" ? [x, 10] : [String((x as { name?: unknown }).name), Number((x as { count?: unknown }).count ?? 10)]) as [string, number])
      : typeof a.items === "object" && a.items ? Object.entries(a.items as Record<string, number>) : typeof a.item === "string" ? [[a.item, typeof a.count === "number" ? a.count : 10]] : [];
    if (!want.length) throw new Error(`deliver 要 items; e.g. fh call deliver --args '{"position":{"x":1,"y":2},"items":{"coal":20}}'`);
    const targets = (Array.isArray(a.positions) ? a.positions.map(posOf) : [posOf(a.position)]).filter((p): p is Pos => !!p);
    if (!targets.length) throw new Error("deliver 要 position 或 positions");
    let moved = 0;
    for (const at of targets) for (const [item, count] of want) {
      if (Date.now() > this.deadline - 10_000) return { op: "deliver", moved, not_done: "一条命令最多干 60 秒: 再跑一次接着送" };
      const r = await this.transfer({ position: at, direction: "to_entity", item, count, walk: true });
      moved += Number(r.moved ?? 0);
    }
    return { op: "deliver", moved, note: "没有机器人: 角色走过去放的" };
  }

  /** rearm: 范围里的炮塔补弹 (背包里最好的弹匣, 每台 count 个, 默认 10) */
  private async rearm(a: Record<string, unknown>) {
    const inv = await readInventory(this.d.call);
    const ammo = typeof a.ammo === "string" ? a.ammo : ["uranium-rounds-magazine", "piercing-rounds-magazine", "firearm-magazine"].find((n) => (inv[n] ?? 0) > 0);
    if (!ammo || (inv[ammo] ?? 0) <= 0) throw new Error("背包里没有弹匣 (firearm-magazine 等): 先 craft 或从箱子取");
    const per = typeof a.count === "number" ? a.count : 10;
    const rows = await this.targets(a, ["ammo-turret"]);
    if (!rows.length) return { op: "rearm", turrets: 0, note: "范围里没有炮塔" };
    let moved = 0, places = 0;
    for (const e of rows) {
      if (Date.now() > this.deadline - 10_000) return { op: "rearm", turrets: rows.length, places, moved, ammo, not_done: "一条命令最多干 60 秒: 再跑一次接着补" };
      if (((await readInventory(this.d.call))[ammo] ?? 0) <= 0) break;
      const r = await this.transfer({ position: e.position, direction: "to_entity", item: ammo, count: per, walk: true });
      moved += Number(r.moved ?? 0); places++;
    }
    return { op: "rearm", turrets: rows.length, places, moved, ammo };
  }

  /**
   * upgrade / belt_upgrade: 拿下一档 (原型的 next_upgrade, 或 to 指定) 放在原位, 游戏快速替换 (方向照旧, 拆下的旧件回背包)。
   * belt_upgrade 只换带子类 (传送带、地下带、分流器); 只给 position 时换它周围 radius (默认 16) 内的, 不是按整条线追
   */
  private async upgrade(action: string, a: Record<string, unknown>) {
    const me = await this.me();
    const t = targetArea(a, me, action === "belt_upgrade" ? 16 : 10);
    const belts = new Set(["transport-belt", "underground-belt", "splitter"]);
    const rows = t.positions ? (await Promise.all(t.positions.map((p) => this.entityAt(p)))).filter((e): e is Record<string, any> => !!e)
      : ((await readArea(this.d.call, t.box!, ["name", "type", "position", "direction"], 512)).entities as Record<string, any>[]).filter((e) => !NOT_ENTITIES.has(String(e.type)) && e.type !== "resource");
    const to = (e: Record<string, any>) => (typeof a.to === "string" ? a.to : this.d.nextUpgrade?.(String(e.name)) ?? null);
    const want = rows.filter((e) => (action !== "belt_upgrade" || belts.has(String(e.type))) && (typeof a.from !== "string" || e.name === a.from) && to(e) && to(e) !== e.name);
    if (!want.length) return { op: action, upgraded: 0, note: "范围里没有能升级的 (或没有下一档)" };
    const builds = want.map((e) => ({ item: to(e)!, position: e.position as Pos, direction: NAME_BY_DIR[Number(e.direction ?? 0)] }));
    if (a.dry_run === true) return { op: action, dry_run: true, count: builds.length, ...(await this.buildCheck(builds)) };
    const out = await this.build({ builds, walk: true, ...(typeof a.start_index === "number" ? { start_index: a.start_index } : {}) });
    return { op: action, upgraded: Number((out as { built?: number; consumed?: number }).built ?? (out as { consumed?: number }).consumed ?? 0), ...out };
  }

  /** use_item: 手里拿着胶囊 / 手雷 / 悬崖炸药 / 鱼, 左键点那一点 (够不着先走近, range 默认 15); 回用掉几个 */
  private async useItem(a: Record<string, unknown>) {
    const item = String(a.item ?? a.name ?? "");
    const at = posOf(a.position) ?? (await this.me());
    if (!item) throw new Error(`use_item 要 item; e.g. fh call use_item --args '{"item":"grenade","position":{"x":1,"y":2}}'`);
    const count = async () => { const p = await readPlayer(this.d.call); return ((await readInventory(this.d.call))[item] ?? 0) + (p.cursor?.name === item ? p.cursor.count ?? 0 : 0); };
    const before = await count();
    if (before < 1) throw new Error(`背包里没有 ${item}`);
    try {
      await this.walkInto(at, typeof a.range === "number" ? a.range : 15, true);
      if (!(await this.d.holdItem(item))) throw new Error(`${item} 没拿到手上`);
      // 用物品是单独的键 use-item (2026-11-08 沙盘读键位表; 放建筑的 build 键扔不出手雷): 鼠标指着那一点按一下
      const t = new Timeline().worldPosition(at, 0, 10).control(this.d.controls().resolve("use-item"), 4, 6);
      const r = await this.d.call("input", { timeline: t.entries });
      if (!r.ok) throw new Error(`use-item 键没按下去: ${(r.error ?? "").slice(0, 160)}`);
      await (this.d.sleep ?? defaultSleep)(500);
    } finally { await this.d.clearCursor().catch(() => undefined); }
    const used = before - (await count());
    if (used <= 0) throw new Error(`${item} 没用出去 (够不着、冷却中, 或这东西不能这样用)`);
    return { op: "use_item", item, used, at };
  }

  /** clear_cliffs: 范围里的悬崖一处处扔悬崖炸药 (要背包里有; 走到 9 格内扔) */
  private async clearCliffs(a: Record<string, unknown>) {
    const me = await this.me();
    const t = targetArea(a, me, 10);
    const cliffs = t.positions ? t.positions.map((p) => ({ position: p })) : ((await readArea(this.d.call, t.box!, ["name", "type", "position"], 128, { type: ["cliff"] })).entities as Record<string, any>[])
      .sort((p, q) => Math.hypot(p.position.x - me.x, p.position.y - me.y) - Math.hypot(q.position.x - me.x, q.position.y - me.y));
    if (!cliffs.length) return { op: "clear_cliffs", cliffs: 0, note: "范围里没有悬崖" };
    let used = 0;
    for (const c of cliffs) {
      if (Date.now() > this.deadline - 10_000) return { op: "clear_cliffs", cliffs: cliffs.length, used, not_done: "再跑一次接着炸" };
      used += Number((await this.useItem({ item: "cliff-explosives", position: c.position, range: 9 })).used ?? 0);
    }
    return { op: "clear_cliffs", cliffs: cliffs.length, used };
  }

  /** equip: 枪 / 弹匣 / 护甲从背包装上 (背包里 Shift+点那一格, 游戏把它移进对应的装备格); 回装上几个 */
  private async equip(a: Record<string, unknown>) {
    const item = String(a.item ?? a.name ?? "");
    if (!item) throw new Error(`equip 要 item; e.g. fh call equip --args '{"item":"submachine-gun"}'`);
    const before = (await readInventory(this.d.call))[item] ?? 0;
    if (before < 1) throw new Error(`背包里没有 ${item}`);
    await openCharacterGui(this.d.call, this.d.controls());
    try { await clickWidget(this.d.call, invSlot(item), "left", ["shift"]); await (this.d.sleep ?? defaultSleep)(300); }
    finally { await closeWindows(this.d.call, this.d.controls()).catch(() => undefined); }
    const moved = before - ((await readInventory(this.d.call))[item] ?? 0);
    if (moved <= 0) throw new Error(`${item} 没装上 (装备格满了, 或这东西不进装备格)`);
    return { op: "equip", item, moved };
  }

  /**
   * cancel_craft: 取消手搓队列 (背包窗口里的手搓队列格子 CraftingQueueSlot, 2026-11-08 沙盘读界面树): recipe 不给 = 最后排的那一项;
   * count 不给或 ≥ 剩下的 = 那一项全取消 (Shift+左键), 否则左键一次取消一个
   */
  private async cancelCraft(a: Record<string, unknown>) {
    const sizeOf = async () => (await readPlayer(this.d.call)).craftingQueueSize ?? 0;
    const before = await sizeOf();
    if (!before) return { op: "cancel_craft", cancelled: 0, note: "手搓队列是空的" };
    await openCharacterGui(this.d.call, this.d.controls());
    try {
      const slots = (await readTree(this.d.call, { path: [{ axis: "descendant", match: { native_type: "CraftingQueueSlot" } }] })).filter((n) => n.type === "CraftingQueueSlot");
      const recipe = typeof a.recipe === "string" ? a.recipe : slots.at(-1)?.properties?.prototype?.name;
      const slot = slots.find((n) => n.properties?.prototype?.name === recipe);
      if (!recipe || !slot) throw new Error(`手搓队列里没有 ${recipe ?? "东西"} (队列: ${slots.map((n) => `${n.properties?.prototype?.name}×${n.properties?.number?.value ?? "?"}`).join("、") || "读不到格子"})`);
      const left = Number(slot.properties?.number?.value ?? 1);
      const want = typeof a.count === "number" ? Math.max(1, a.count) : left;
      const sel = { path: [{ axis: "descendant", match: { native_type: "CraftingQueueSlot", prototype: { name: recipe } } }] };
      if (want >= left) await clickWidget(this.d.call, sel, "left", ["shift"]);
      else for (let i = 0; i < want; i++) { await clickWidget(this.d.call, sel, "left"); await (this.d.sleep ?? defaultSleep)(80); }
      await (this.d.sleep ?? defaultSleep)(300);
    } finally { await closeWindows(this.d.call, this.d.controls()).catch(() => undefined); }
    const after = await sizeOf();
    if (after >= before) throw new Error("点了手搓队列, 队列没变短");
    return { op: "cancel_craft", queue_before: before, queue_after: after };
  }

  /** equipment {insert: 插件名 | [插件名…]}: 护甲网格里装插件 (穿着带网格的护甲; 背包里 Shift+点插件, 游戏放进网格的空位); 回装上几个。取下来这条路上还没做 */
  private async equipment(a: Record<string, unknown>) {
    const items = Array.isArray(a.insert) ? a.insert.map(String) : typeof a.insert === "string" ? [a.insert] : typeof a.item === "string" ? [a.item] : [];
    if (!items.length) throw new Error(`equipment 这条路上只会装 (insert): e.g. fh call equipment --args '{"insert":"solar-panel-equipment"}'; 取下来还没做`);
    const moved: Record<string, number> = {};
    let seenTypes = "";
    await openCharacterGui(this.d.call, this.d.controls());
    try {
      // 网格要先打开: 装备栏 (ToolEquipGui) 里穿着的护甲那一格右键 (2026-11-08 沙盘读界面树: 那一格是 InventoryGuiSlot, 带护甲名)
      const armorSel = (name: string) => ({ path: [{ axis: "descendant", match: { native_type: "ToolEquipGui" } }, { axis: "descendant", match: { native_type: "InventoryGuiSlot", prototype: { name } } }] });
      const armor = (await readTree(this.d.call, { path: [{ axis: "descendant", match: { native_type: "ToolEquipGui" } }, { axis: "descendant", match: { native_type: "InventoryGuiSlot" } }] }))
        .map((n) => String(n.properties?.prototype?.name ?? "")).find((n) => /armor/.test(n));
      if (!armor) throw new Error("没穿护甲 (先 equip 一件带网格的护甲, 例 modular-armor)");
      await clickWidget(this.d.call, armorSel(armor), "right");
      await (this.d.sleep ?? defaultSleep)(400);
      seenTypes = [...new Set((await readTree(this.d.call)).map((n) => n.type).filter((t) => /Grid|Equip/i.test(t)))].join(", ");
      for (const item of items) {
        const before = (await readInventory(this.d.call))[item] ?? 0;
        if (before < 1) throw new Error(`背包里没有 ${item}`);
        await clickWidget(this.d.call, invSlot(item), "left", ["shift"]);
        await (this.d.sleep ?? defaultSleep)(300);
        moved[item] = before - ((await readInventory(this.d.call))[item] ?? 0);
      }
    } finally { await closeWindows(this.d.call, this.d.controls()).catch(() => undefined); }
    if (!Object.values(moved).some((n) => n > 0)) throw new Error(`一件都没装上 (网格满了, 或网格没打开; 当时界面里: ${seenTypes || "没有网格类控件"}): ${items.join("、")}`);
    return { op: "equipment", inserted: moved };
  }

  /** configure: 这条路上能设的: recipe (组装机配方)、requests [{name, min, max?}] (请求格); 别的设置 (过滤、限格、优先级…) 还没翻译成界面点选, 明说 */
  private async configure(a: Record<string, unknown>) {
    const at = posOf(a.position);
    if (!at) throw new Error(`configure 要 position; e.g. fh call configure --args '{"position":{"x":1,"y":2},"recipe":"iron-gear-wheel"}'`);
    const known = new Set(["position", "recipe", "requests", "request", "walk"]);
    const other = Object.keys(a).filter((k) => !known.has(k));
    if (other.length) throw new Error(`configure 在这条路上只会设 recipe 和 requests; ${other.join("、")} 还没翻译成界面点选`);
    const done: Record<string, unknown> = {};
    if (typeof a.recipe === "string") { await this.walkInto(at, BUILD_REACH, true); await this.d.setRecipe(at, a.recipe); done.recipe = a.recipe; }
    const reqs = (Array.isArray(a.requests) ? a.requests : a.request ? [a.request] : []) as { name?: unknown; min?: unknown; count?: unknown; max?: unknown }[];
    if (reqs.length && !this.d.setRequest) throw new Error("这条路没接请求格的界面操作");
    for (const r of reqs) { await this.walkInto(at, BUILD_REACH, true); await this.d.setRequest!(at, String(r.name), Number(r.min ?? r.count ?? 0), typeof r.max === "number" ? r.max : undefined); }
    if (reqs.length) done.requests = reqs.length;
    if (!Object.keys(done).length) throw new Error("configure 没给要设的 (recipe / requests)");
    return { op: "configure", applied: done };
  }

  /** construct / rebuild: 范围里现有的虚影 (队友放的、./bp 贴的、被毁的建筑留下的) 按名字走过去一个个放实物; 近的先。标了拆除的这条路上不管 (要拆用 mine) */
  private async constructGhosts(action: string, a: Record<string, unknown>) {
    const me = await this.me();
    const t = targetArea(a, me, 32);
    const box = t.box ?? (() => { const xs = t.positions!.map((p) => p.x), ys = t.positions!.map((p) => p.y); return { left_top: { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1 }, right_bottom: { x: Math.max(...xs) + 1, y: Math.max(...ys) + 1 } }; })();
    const rows = (await readArea(this.d.call, box, ["name", "type", "position", "direction", "ghost_name"], 512, { type: ["entity-ghost"] })).entities as Record<string, any>[];
    const ghosts = rows.filter((g) => typeof g.ghost_name === "string" && (!t.positions || t.positions.some((p) => Math.hypot(p.x - g.position.x, p.y - g.position.y) < 0.75)))
      .sort((p, q) => Math.hypot(p.position.x - me.x, p.position.y - me.y) - Math.hypot(q.position.x - me.x, q.position.y - me.y));
    if (!ghosts.length) return { op: action, ghosts: 0, note: rows.length ? "范围里的虚影读不出是什么 (ghost_name)" : "范围里没有虚影" };
    const builds = ghosts.map((g) => ({ item: String(g.ghost_name), position: g.position as Pos, direction: NAME_BY_DIR[Number(g.direction ?? 0)] }));
    if (a.dry_run === true) return { op: action, dry_run: true, ghosts: ghosts.length, ...(await this.buildCheck(builds)) };
    return { op: action, ghosts: ghosts.length, ...(await this.build({ builds, walk: true, ...(typeof a.start_index === "number" ? { start_index: a.start_index } : {}) })) };
  }

  /** 这个位置上的实体 (建筑优先, 同名优先); 没有 null */
  private async entityAt(at: Pos, wantName?: string, withResource = false, corpseFirst = false): Promise<Record<string, any> | null> {
    const box = { left_top: { x: at.x - 1, y: at.y - 1 }, right_bottom: { x: at.x + 1, y: at.y + 1 } };
    const r = await readArea(this.d.call, box, ["name", "type", "position", "direction", "unit_number"], 64);
    const all = r.entities as Record<string, any>[];
    // 捡尸体: 尸体常常压在矿上, 指名要尸体时先看它 (2026-11-07 Steam 版实跑: 尸体被当成不算实体的东西过滤掉, 东西取不回, 模型只好重造炮塔)
    if (corpseFirst) {
      const body = all.filter((e) => e.type === "character-corpse").sort((p, q) => Math.hypot(p.position.x - at.x, p.position.y - at.y) - Math.hypot(q.position.x - at.x, q.position.y - at.y))[0];
      if (body) return body;
    }
    const rows = all.filter((e) => !NOT_ENTITIES.has(String(e.type)) && (withResource || e.type !== "resource"));
    const dist = (e: Record<string, any>) => Math.hypot(e.position.x - at.x, e.position.y - at.y);
    const named = wantName ? rows.filter((e) => e.name === wantName) : rows;
    return [...named].sort((p, q) => dist(p) - dist(q))[0] ?? null;
  }

  /** 协助模式: 这件东西动不动得 (null = 能动)。谁放的要单独 inspect: 注入客户端的程序 的实体查询不收 last_user 字段 (2026-11-06 真跑报错) */
  private async refuseOthers(e: Record<string, any>): Promise<string | null> {
    if (!this.d.assist) return null;
    if (assistVerdict(e, this.d.assist.me) === null) return null; // 矿、树、石头
    // 自己的尸体总能捡: 尸体没有"谁放的", 看它记的玩家编号; 别人的不动
    if (e.type === "character-corpse") {
      const c = await this.d.call("world_query", { selection: { kind: "inspect", target: { kind: "entities", position: e.position, name: e.name }, path: [{ property: "character_corpse_player_index" }] } });
      const d = c.data as { objects?: { value?: unknown }[]; player?: { index?: unknown } } | undefined;
      if (c.ok && d?.objects?.[0]?.value === d?.player?.index) return null;
    }
    if (e.position && this.d.assist.allowed?.(e.position)) return null; // 用户点过头的
    return assistVerdict({ ...e, last_user: await this.lastUserName(e) }, this.d.assist.me);
  }

  /** 谁放的 (last_user 的名字; 读不到 / 没有 = 空串) */
  private async lastUserName(e: { position?: Pos; name?: unknown }): Promise<string> {
    const r = await this.d.call("world_query", { selection: { kind: "inspect", target: { kind: "entities", position: e.position, name: e.name }, path: [{ property: "last_user" }] }, fields: ["name"] });
    const o = (r.data as { objects?: { availability?: string; attributes?: { name?: unknown } }[] } | undefined)?.objects?.[0];
    return o?.availability === "nil" || !r.ok ? "" : typeof o?.attributes?.name === "string" ? o.attributes.name : "";
  }

  /** 挡路的建筑是谁放的: 自己的就说"你自己放的" (2026-11-08 真跑: 模型把自己的采矿机当成别人的, 绕着走) */
  private async ownerTag(e: { position?: Pos; name?: unknown }): Promise<string> {
    try {
      const who = await this.lastUserName(e);
      const me = this.d.assist?.me ?? this.d.me;
      return who ? (me && who === me ? ", 你自己放的" : `, ${who} 放的`) : "";
    } catch { return ""; }
  }

  private invIndex(name: string): number {
    const n = this.d.defines()?.inventory?.[name];
    if (n === undefined) throw new Error(`defines.inventory 里没有 ${name}`);
    return n;
  }

  private async invLine(item?: string) {
    const inv = await readInventory(this.d.call);
    return { held: item ? inv[item] ?? 0 : undefined, line: `held: ${item ?? ""} ${item ? inv[item] ?? 0 : ""}`.trim() };
  }

  /** 悬停实体, 按一下某个操作 (旋转) */
  private async pressOn(at: Pos, control: string) {
    const t = new Timeline().worldPosition(at, 0, 8).control(this.d.controls().resolve(control), 3, 5);
    const r = await this.d.call("input", { timeline: t.entries });
    if (!r.ok) throw new Error(`${control} 按键失败: ${(r.error ?? "").slice(0, 200)}`);
  }

  private async moveTo(a: Record<string, unknown>) {
    const at = posOf(a.position);
    if (!at) throw new Error(`position requires x and y; e.g. fh call move_to --args '{"position":{"x":30,"y":-12}}'`);
    const me = await this.me();
    const dist = Math.hypot(me.x - at.x, me.y - at.y);
    // 太远先走一段: 一条命令要在 90 秒内答
    const leg = dist > MOVE_MAX ? { x: Math.round(me.x + ((at.x - me.x) * MOVE_MAX) / dist) + 0.5, y: Math.round(me.y + ((at.y - me.y) * MOVE_MAX) / dist) + 0.5 } : at;
    const tolerance = typeof a.tolerance === "number" ? a.tolerance : 1;
    let w = await walkTo(this.d.call, this.d.controls(), leg, { tolerance, deadline: this.deadline });
    // 终点那格被占 (基地里常见, 2026-11-06 真服 move_to 一半失败在这): 走到最近的空位, 回复里说清楚停在哪
    const occupied = !w.arrived && !w.timedOut && /算不出路/.test(w.reason ?? "");
    if (occupied) w = await walkTo(this.d.call, this.d.controls(), leg, { tolerance, within: 3, deadline: this.deadline });
    if (w.timedOut) return { position: w.at, arrived: false, left: Math.round(Math.hypot(w.at.x - at.x, w.at.y - at.y)), note: `一条命令最多干 ${ACT_BUDGET_MS / 1000} 秒, 还在路上; 同一条命令再跑一次接着走` };
    if (!w.arrived) throw new Error(`走不到 ${fmt(leg)}: ${w.reason ?? ""}; 现在在 ${fmt(w.at)}`);
    if (leg !== at) return { position: w.at, arrived: false, left: Math.round(Math.hypot(w.at.x - at.x, w.at.y - at.y)), note: `路太远, 这次走了 ${MOVE_MAX} 格; 同一条命令再跑一次接着走` };
    const notes = [occupied ? `${fmt(leg)} 那格走不到 (被占), 停在最近的空位` : "", w.carried ? "脚下是传送带, 站着不动会被运走" : ""].filter(Boolean);
    return { position: w.at, arrived: true, segments: w.segments, replans: w.replans, ...(notes.length ? { note: notes.join("; ") } : {}) };
  }

  /** 实体里一共有几个 (所有物品栏; 一次查询, 不用逐格读) */
  private async entityTotal(at: Pos, item: string, name?: string): Promise<number> {
    // 要点名: 建筑压在矿上时那一点有两个实体, 不点名就查询失败、算成 0 个 (2026-11-07 Steam 版实跑)
    const r = await this.d.call("world_query", { selection: { kind: "inspect", target: { kind: "entities", position: at, ...(name ? { name } : {}) }, path: [{ method: "get_item_count", arguments: [item] }] } });
    const v = (r.data as { objects?: { value?: unknown }[] } | undefined)?.objects?.[0]?.value;
    return r.ok && typeof v === "number" ? v : 0;
  }

  /** 目标列表: 给了 positions 就是这些位置上的实体; 否则按区域和种类找, 离自己近的先做 */
  private async targets(a: Record<string, unknown>, types: string[]): Promise<Record<string, any>[]> {
    const me = await this.me();
    const t = targetArea(a, me);
    const rows: Record<string, any>[] = [];
    if (t.positions) { for (const p of t.positions) { const e = await this.entityAt(p); if (e) rows.push(e); } }
    else rows.push(...((await readArea(this.d.call, t.box!, ["name", "type", "position"], 512, { type: types })).entities as Record<string, any>[]));
    return rows.sort((p, q) => Math.hypot(p.position.x - me.x, p.position.y - me.y) - Math.hypot(q.position.x - me.x, q.position.y - me.y));
  }

  /** 铺带子: 按点展开成一格一格, 手上拿着放; 方向不对就转手上的再放一次 (同一格快捷替换只改方向, 不多花料), 接下来同方向的就对了 */
  private async buildPath(a: Record<string, unknown>) {
    const item = String(a.item ?? "transport-belt");
    const points = Array.isArray(a.points) ? a.points.map(posOf).filter((p): p is Pos => !!p) : [];
    const tiles = pathTiles(points, typeof a.end_direction === "string" ? a.end_direction : undefined);
    return this.layTiles(tiles.map((t) => ({ item, ...t })), typeof a.start_index === "number" ? a.start_index : 1, "铺");
  }

  /**
   * 按清单一格格放 (build_path 和三个铺线命令共用): 已经有同名同方向的跳过 (重跑不重复); 要方向的先放下, 不对就转手上的方向再放一次 (快速替换);
   * direction 为 null 的 (水管、电线杆) 不管方向。干到 60 秒先回做了多少, start_index 接着来
   */
  private async layTiles(tiles: { item: string; position: Pos; direction: number | null }[], startIndex: number, verb: string) {
    const start = Math.max(1, startIndex);
    const t0 = Date.now();
    let built = 0, dragged = 0, next = start;
    // 普通传送带的直线段按住拖着放 (dragRuns); 段的起点 (从 1 数) → 终点
    const runs = new Map(dragRuns(tiles).map(([a, b]) => [a + 1, b + 1] as const));
    try {
      for (; next <= tiles.length; next++) {
        if (Date.now() - t0 > ACT_BUDGET_MS) return { total: tiles.length, built, ...(dragged ? { dragged } : {}), next_index: next, not_done: `一条命令最多干 ${ACT_BUDGET_MS / 1000} 秒: 加 start_index: ${next} 接着${verb}` };
        const end = runs.get(next);
        if (end !== undefined) {
          const r = await this.dragRun(tiles, next, end, verb, built);
          if (r) { built += r.built; dragged += r.dragged; next = end; continue; }
          // 段里有别的东西 / 拖不了: 这一段照旧一格格放
        }
        if (await this.placeTile(tiles, next, verb, built)) built++;
      }
    } finally { await this.d.clearCursor().catch(() => undefined); }
    return { total: tiles.length, built, ...(dragged ? { dragged } : {}), next_index: null };
  }

  /** 这一格已经是要的东西 (同名、方向对): 重跑跳过 */
  private static same(there: Record<string, any> | null, tile: { position: Pos; direction: number | null }) {
    return !!there && Math.hypot(there.position.x - tile.position.x, there.position.y - tile.position.y) < 0.1 && (tile.direction === null || Number(there.direction ?? 0) === tile.direction);
  }

  /** 放清单里第 n 格 (从 1 数): 已经有了回 false; 放下去方向不对就转手上的方向再放一次 (快速替换) */
  private async placeTile(tiles: { item: string; position: Pos; direction: number | null }[], n: number, verb: string, built: number): Promise<boolean> {
    const tile = tiles[n - 1];
    const item = tile.item;
    const there = await this.entityAt(tile.position, item);
    { const no = await this.refuseReplacing(tile.position); if (no && !PlayerActions.same(there, tile)) throw new Error(`第 ${n}/${tiles.length} 格 ${fmt(tile.position)}: ${no} (已${verb} ${built})`); }
    if (PlayerActions.same(there, tile)) return false;
    await this.walkInto(tile.position, BUILD_REACH, true);
    await this.holdFor(item, n, tiles.length, verb, built);
    const out = await this.d.placeHeld(tile.position);
    if (!out.ok) throw new Error(`第 ${n}/${tiles.length} 格 ${fmt(tile.position)} ${item} 放不下: ${out.error ?? ""} (已${verb} ${built}${await this.placeWhy(item, tile.position, false)})`);
    const e = await this.entityAt(tile.position, item);
    const have = Number(e?.direction ?? 0);
    if (e && tile.direction !== null && have !== tile.direction) {
      const turns = rotateTurns(have, tile.direction) ?? 0;
      for (let i = 0; i < turns; i++) { await this.pressHand("rotate"); await (this.d.sleep ?? defaultSleep)(60); }
      const again = await this.d.placeHeld(tile.position);
      if (!again.ok) throw new Error(`第 ${n} 格转方向没成: ${again.error ?? ""}`);
      const got = await this.directionSettled(tile.position, item, tile.direction, have);
      if (got !== tile.direction) throw new Error(`第 ${n} 格 ${fmt(tile.position)} 转完还是朝 ${NAME_BY_DIR[got]} (要 ${NAME_BY_DIR[tile.direction]})`);
    }
    return true;
  }

  /** 手上拿着这种东西 (没有就从背包拿; 背包没有就报还差, 带接着放的下标) */
  private async holdFor(item: string, n: number, total: number, verb: string, built: number) {
    const player = await readPlayer(this.d.call);
    if (player.cursor?.name !== item && !(await this.d.holdItem(item))) throw new Error(`no ${item} in inventory (${verb}到第 ${n}/${total} 格, 已${verb} ${built}; 备好料加 start_index: ${n} 接着${verb})`);
  }

  /**
   * 拖着放一段 (第 a~b 格, 从 1 数): 段里只要有别的东西 (不是同名同方向的带子) 就回 null, 由调用方一格格放 (协助模式不动别人的东西、挡路的报清楚, 都在 placeTile 里);
   * 角色走到段中间 → 第一格照旧放 (顺带把手上的方向对好) → 剩下的按住建造键沿直线拖过去 → 一次读回, 漏的 / 方向不对的一格格补。
   */
  private async dragRun(tiles: { item: string; position: Pos; direction: number | null }[], a: number, b: number, verb: string, built: number): Promise<{ built: number; dragged: number } | null> {
    const seg = tiles.slice(a - 1, b);
    const item = seg[0].item;
    const xs = seg.map((t) => t.position.x), ys = seg.map((t) => t.position.y);
    const box = { left_top: { x: Math.min(...xs) - 0.5, y: Math.min(...ys) - 0.5 }, right_bottom: { x: Math.max(...xs) + 0.5, y: Math.max(...ys) + 0.5 } };
    const onTile = (e: Record<string, any>, p: Pos) => Math.abs(e.position.x - p.x) < 0.6 && Math.abs(e.position.y - p.y) < 0.6;
    const scan = async () => ((await readArea(this.d.call, box, ["name", "type", "position", "direction"], 2_000)).entities as Record<string, any>[]).filter((e) => !NOT_ENTITIES.has(String(e.type)) && e.type !== "resource");
    const before = await scan();
    const missing = (rows: Record<string, any>[]) => seg.map((t, k) => ({ t, n: a + k })).filter(({ t }) => !rows.some((e) => onTile(e, t.position) && PlayerActions.same(e, t)));
    // 段里有别的东西 (别人的建筑、方向不对的带子、树石): 不拖, 免得快速替换掉别人的东西或拖出半段
    if (seg.some((t) => before.some((e) => onTile(e, t.position) && !PlayerActions.same(e, t)))) return null;
    const todo = missing(before);
    if (!todo.length) return { built: 0, dragged: 0 };
    let placed = 0;
    // 站到段中间旁边 2 格 (站在线上会被刚放的带子运走): 两头离角色都在 BUILD_REACH 以内 (14 格一段: √(6.5² + 2²) + 走到的误差 1.5 ≈ 8.3)
    const mid = seg[Math.floor(seg.length / 2)].position;
    const side = Math.abs(seg[0].position.y - seg[seg.length - 1].position.y) < 0.01 ? { x: mid.x, y: mid.y + 2 } : { x: mid.x + 2, y: mid.y };
    await this.walkInto(side, 3, true);
    // 第一格照旧放 (手上的方向对好以后, 拖出来的同一方向)
    const firstIdx = todo[0].n;
    if (await this.placeTile(tiles, firstIdx, verb, built)) placed++;
    const rest = seg.slice(firstIdx - a);
    if (rest.length >= 2) {
      await this.holdFor(item, firstIdx, tiles.length, verb, built + placed);
      const from = rest[0].position, to = rest[rest.length - 1].position;
      const perPoint = 3;
      const ticks = rest.length * perPoint;
      // 指针先到起点 (motion 在按键之前), 整段按住建造键; 中途每 10 tick 重按一次 (切窗口时游戏会松开按着的键)
      const t = new Timeline().worldMotion(from, to, perPoint, 0).holdControl(this.d.controls().resolve("build"), 0, ticks);
      const r = await this.d.call("input", { timeline: t.entries });
      if (!r.ok) throw new Error(`拖着放第 ${firstIdx}~${b} 格没成: ${(r.error ?? "").slice(0, 200)}`);
      await (this.d.sleep ?? defaultSleep)(150);
    }
    // 读回: 拖出来的数一下, 漏的 / 方向不对的一格格补
    const after = await scan();
    const left = missing(after);
    const dragged = todo.length - left.length - (placed && !left.some((x) => x.n === firstIdx) ? 1 : 0);
    for (const { n } of left) if (await this.placeTile(tiles, n, verb, built + placed + dragged)) placed++;
    return { built: placed + Math.max(0, dragged), dragged: Math.max(0, dragged) };
  }

  /**
   * 铺电线杆 / 带子 / 水管 (2026-11-08 起; 原来这条路上直接被拒): 游戏外的模组按它的规则算 (试算; 带子和水管加 details 给逐格清单, 电线杆给位置),
   * 角色按清单走过去一个个放 (layTiles), 没有虚影。dry_run: 只回模组算的方案。参数和第二版一样 (./fh help pole_route 等)
   */
  private async route(action: "pole_route" | "belt_route" | "pipe_route", a: Record<string, unknown>) {
    if (!this.d.read) throw new Error(`${action}: 没接游戏外的模组, 算不了路线`);
    const { dry_run, start_index, ...rest } = a;
    const plan = await this.d.read(action, { ...rest, dry_run: true, ...(action === "pole_route" ? {} : { details: true }) });
    if (!plan) throw new Error(`${action}: 游戏外的模组没回方案`);
    const tiles = routeTiles(action, plan);
    const failed = Array.isArray(plan.failed) ? (plan.failed as { position?: Pos; error?: string }[]) : [];
    if (dry_run === true) return { ...plan, tiles: tiles.length, how: "真放时角色走过去一个个放 (玩家操作), 不放虚影" };
    if (!tiles.length) throw new Error(`${action} 算出来没有能放的格子${failed.length ? `: ${failed.slice(0, 3).map((f) => `${f.position ? fmt(f.position) : ""} ${String(f.error ?? "").slice(0, 80)}`).join("; ")}` : ""}`);
    const out = await this.layTiles(tiles, typeof start_index === "number" ? start_index : 1, "放");
    return { op: action, planned: tiles.length, ...(typeof plan.route === "string" ? { route: plan.route } : {}), ...(failed.length ? { not_planned: failed.length } : {}), ...(plan.missing ? { missing: plan.missing } : {}), ...out };
  }

  /** 手上拿着东西按一下 (转手上的方向): 不悬停 */
  private async pressHand(control: string) {
    const r = await this.d.call("input", { timeline: new Timeline().control(this.d.controls().resolve(control), 0, 2).entries });
    if (!r.ok) throw new Error(`${control} 按键失败: ${(r.error ?? "").slice(0, 200)}`);
  }

  /** 收料: 周围的机器产物 (chests: true 连箱子) 或 positions, 近的先拿, 够数就停 */
  private async collect(a: Record<string, unknown>) {
    const item = String(a.item ?? "");
    if (!item) throw new Error(`collect 要 item; e.g. fh call collect --args '{"item":"iron-plate","radius":32,"count":50}'`);
    const want = typeof a.count === "number" ? a.count : 50;
    const types = ["furnace", "assembling-machine", ...(a.chests === true || a.outputs_only === false ? ["container", "logistic-container"] : [])];
    const rows = await this.targets(a, types);
    const t0 = Date.now();
    const before = (await readInventory(this.d.call))[item] ?? 0;
    let places = 0, stock = 0;
    const got = async () => ((await readInventory(this.d.call))[item] ?? 0) - before;
    for (const e of rows) {
      const left = want - (await got());
      if (left <= 0 || Date.now() - t0 > ACT_BUDGET_MS) break;
      const there = await this.entityTotal(e.position, item, String(e.name));
      stock += there;
      if (there <= 0) continue;
      try { await this.transfer({ position: e.position, direction: "to_player", item, count: Math.min(left, there), walk: true }); places++; } catch { /* 这一处拿不到 (只有原料格没有产物): 下一处 */ }
    }
    const moved = await got();
    if (!moved && !stock) throw new Error(`no ${item} near: 范围里 ${rows.length} 处都没有${a.chests === true ? "" : " (要连箱子加 chests: true)"}`);
    return { item, want, stock, places, moved, inv: (await this.invLine(item)).line };
  }

  /** 补燃料: 每处补到 count 个 (默认 5); 燃料要在背包里 (没有先 collect) */
  private async refuel(a: Record<string, unknown>) {
    const fuel = String(a.fuel ?? a.item ?? "coal");
    const per = typeof a.count === "number" ? a.count : 5;
    const rows = await this.targets(a, ["furnace", "mining-drill", "boiler", "inserter"]);
    const t0 = Date.now();
    let places = 0, moved = 0, skipped = 0;
    const fuelInv = this.invIndex("fuel");
    for (const e of rows) {
      if (Date.now() - t0 > ACT_BUDGET_MS) return { op: "refuel", item: fuel, places, moved, not_done: `一条命令最多干 ${ACT_BUDGET_MS / 1000} 秒: 再跑一次接着补` };
      const held = (await readInventory(this.d.call))[fuel] ?? 0;
      if (held <= 0) { if (!moved) throw new Error(`no ${fuel} in inventory (先 collect 或从箱子取)`); return { op: "refuel", item: fuel, places, moved, short: `背包的 ${fuel} 用完了, 还有 ${rows.length - places - skipped} 处没补` }; }
      const cur = await this.d.itemCount(e.position, fuelInv, fuel);
      if (cur >= per) { skipped++; continue; }
      const r = await this.transfer({ position: e.position, direction: "to_entity", item: fuel, count: Math.min(per - cur, held), inventory: "fuel", walk: true });
      moved += Number(r.moved ?? 0); places++;
    }
    return { op: "refuel", item: fuel, places, skipped, moved, inv: (await this.invLine(fuel)).line };
  }

  /** 喂料: 每处放 count 个 (默认 10); 物品要在背包里 */
  private async feed(a: Record<string, unknown>) {
    const items = Array.isArray(a.items) ? a.items.map(String) : a.item ? [String(a.item)] : [];
    if (!items.length) throw new Error(`feed 要 item 或 items; e.g. fh call feed --args '{"positions":[{"x":1,"y":2}],"item":"iron-plate","count":10}'`);
    const per = typeof a.count === "number" ? a.count : 10;
    const rows = await this.targets(a, ["assembling-machine", "lab", "furnace", "ammo-turret"]);
    const t0 = Date.now();
    let places = 0, moved = 0;
    for (const e of rows) {
      if (Date.now() - t0 > ACT_BUDGET_MS) return { op: "feed", places, moved, not_done: `一条命令最多干 ${ACT_BUDGET_MS / 1000} 秒: 再跑一次接着喂` };
      let fed = false;
      for (const item of items) {
        if (((await readInventory(this.d.call))[item] ?? 0) <= 0) continue;
        const r = await this.transfer({ position: e.position, direction: "to_entity", item, count: per, walk: true });
        moved += Number(r.moved ?? 0); fed = true;
      }
      if (fed) places++;
    }
    if (!moved) throw new Error(`一件都没喂: 背包里有 ${items.join("、")} 吗? 范围里找到 ${rows.length} 处`);
    return { op: "feed", places, moved, inv: (await this.invLine(items[0])).line };
  }

  /** 等方向读回来: 转动过了网络延迟才落到游戏状态 (latency 32 tick), 只等 150 毫秒时转好了还报"还是朝北" (2026-11-06 注入客户端的程序 存档副本, ./bp build) */
  private async directionSettled(at: Pos, entityName: string, to: number, fallback: number): Promise<number> {
    let after = fallback;
    for (let i = 0; i < 14; i++) {
      after = Number((await this.entityAt(at, entityName))?.direction ?? fallback);
      if (after === to) return after;
      await (this.d.sleep ?? defaultSleep)(150);
    }
    return after;
  }

  private async rotateTo(at: Pos, entityName: string, from: number, want: string) {
    const to = DIR_BY_NAME[want];
    if (to === undefined) throw new Error(`方向不认识: ${want} (north / east / south / west)`);
    const turns = rotateTurns(from, to);
    if (turns === null) throw new Error(`${entityName} 现在朝 ${NAME_BY_DIR[from] ?? from}, 只能转正方向`);
    for (let i = 0; i < turns; i++) { await this.pressOn(at, "rotate"); await (this.d.sleep ?? defaultSleep)(150); }
    const after = await this.directionSettled(at, entityName, to, from);
    if (after !== to) throw new Error(`${entityName} ${fmt(at)} 转了 ${turns} 下还是朝 ${NAME_BY_DIR[after] ?? after} (要 ${want})`);
    return { before: NAME_BY_DIR[from] ?? String(from), after: want, turns };
  }

  private async build(a: Record<string, unknown>) {
    const given = (Array.isArray(a.builds) ? a.builds.map((r) => ({ ...a, ...(r as object), builds: undefined })) : [a]) as Record<string, unknown>[];
    if (a.dry_run === true) return this.buildCheck(given);
    // 整块建 (一批、跳过已有的): 按物品 / 方向排, 少换手少转向; 同一直线上的普通带子挨在一起, 一段段拖着放 (buildOrder、dragRuns)
    const batch = given.length > 1 && a.skip_existing === true;
    const rows = batch ? buildOrder(given) : given;
    const tiles = rows.map((r) => ({ item: String(r.item ?? r.name ?? ""), position: posOf(r.position) ?? { x: 0, y: 0 }, direction: typeof r.direction === "string" ? DIR_BY_NAME[r.direction] ?? null : null }));
    // 带配方的 (组装机) 不进拖动段
    const runs = batch ? new Map(dragRuns(tiles.map((t, i) => (typeof rows[i].recipe === "string" ? { ...t, item: "" } : t)))) : new Map<number, number>();
    const built: Record<string, unknown>[] = [];
    let dragged = 0;
    const start = Math.max(1, typeof a.start_index === "number" ? a.start_index : 1);
    try {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (i + 1 < start) continue;
        // 留点时间给这一件 (放下 2.5 秒, 带配方再 4 秒): 到点回做了多少, 命令行 90 秒等不到就没回复了
        if (rows.length > 1 && Date.now() > this.deadline - 10_000) return { consumed: built.length, built: built.length, ...(dragged ? { dragged } : {}), total: rows.length, next_index: i + 1, not_done: `一条命令最多干 ${ACT_BUDGET_MS / 1000} 秒: 加 start_index: ${i + 1} 接着放` };
        const end = runs.get(i);
        if (end !== undefined) {
          // 一段直线上的带子拖着放; 段里有别的东西 (dragRun 回 null) 就照下面一件件放
          const d = await this.dragRun(tiles, i + 1, end + 1, "放", built.length);
          if (d) {
            for (let k = 0; k < d.built; k++) built.push({ name: tiles[i].item, position: tiles[Math.min(end, i + k)].position });
            dragged += d.dragged;
            i = end;
            continue;
          }
        }
        const item = String(r.item ?? r.name ?? "");
        const at = posOf(r.position);
        if (!item || !at) throw new Error(`build 要 item 和 position; e.g. fh call build --args '{"item":"stone-furnace","position":{"x":1,"y":2}}'`);
        const fail = (msg: string) => new Error(rows.length > 1 ? `build ${i + 1}/${rows.length} failed after ${built.length} built: ${msg}` : msg);
        if (a.skip_existing === true) {
          const same = await this.entityAt(at, item);
          if (same && Math.hypot(same.position.x - at.x, same.position.y - at.y) < 0.1) continue;
        }
        const player = await readPlayer(this.d.call);
        const inHand = player.cursor?.name === item ? player.cursor.count ?? 0 : 0;
        const held = ((await readInventory(this.d.call))[item] ?? 0) + inHand;
        if (held < 1) throw fail(`materials before build: ${item} need 1, held 0, missing 1 (先 craft 或从箱子取)`);
        { const no = await this.refuseReplacing(at); if (no) throw fail(no); }
        await this.walkInto(at, BUILD_REACH, r.walk === true);
        if (!inHand && !(await this.d.holdItem(item))) throw fail(`${item} 没拿到手上`);
        // 放下了 = 手上加背包少了一个 (那格本来就有同样的东西时, 只看"那格有"会当成放下了; 2026-11-06 核出来)
        const total = async () => { const p = await readPlayer(this.d.call); return ((await readInventory(this.d.call))[item] ?? 0) + (p.cursor?.name === item ? p.cursor.count ?? 0 : 0); };
        let out = await this.d.placeHeld(at);
        let consumed = out.ok && (await total()) < held;
        if (!consumed) {
          // 站在占地上放不下 (第一版坑): 走开一点再试一次
          const me = await this.me();
          if (Math.hypot(me.x - at.x, me.y - at.y) < 4) {
            await walkTo(this.d.call, this.d.controls(), { x: at.x + 5, y: at.y }, { tolerance: 1.5 }).catch(() => undefined);
            out = await this.d.placeHeld(at);
            consumed = out.ok && (await total()) < held;
          }
        }
        if (!consumed) {
          const box = { left_top: { x: at.x - 0.4, y: at.y - 0.4 }, right_bottom: { x: at.x + 0.4, y: at.y + 0.4 } };
          const here = (await readArea(this.d.call, box, ["name", "type", "position"], 16)).entities as Record<string, any>[];
          const blockers = here.filter((x) => !NOT_ENTITIES.has(String(x.type)) && x.type !== "resource");
          const names = await Promise.all(blockers.map(async (x) => `${x.name} (${x.position.x},${x.position.y}${await this.ownerTag(x)})`));
          throw fail(`placement blocked by ${names.join(", ") || "看不到挡着的东西"}${await this.placeWhy(item, at, blockers.length > 0)}${out.error ? ` (${out.error.slice(0, 160)})` : ""}`);
        }
        const e = await this.entityAt(at, item);
        if (!e) throw fail(`${item} 放下后在 ${fmt(at)} 读不到 (物品名和实体名不一样? 被挡了?)`);
        const entity: Record<string, unknown> = { name: e.name, type: e.type, position: e.position, ...(e.unit_number ? { unit_number: e.unit_number } : {}) };
        if (typeof r.direction === "string" && NAME_BY_DIR[Number(e.direction ?? 0)] !== r.direction) {
          const want = DIR_BY_NAME[r.direction];
          let fixed = false;
          // 带子 / 机械臂: 转手上的方向, 原地再放一次 (快速替换成手上的方向) —— 手上的东西不放下, 后面同方向的直接放对 (整块建按方向排过)
          if (REPLACE_TO_ROTATE.has(String(e.type)) && want !== undefined) {
            const turns = rotateTurns(Number(e.direction ?? 0), want);
            if (turns) {
              for (let k = 0; k < turns; k++) { await this.pressHand("rotate"); await (this.d.sleep ?? defaultSleep)(60); }
              const again = await this.d.placeHeld(e.position as Pos);
              if (again.ok && (await this.directionSettled(e.position as Pos, String(e.name), want, Number(e.direction ?? 0))) === want) { entity.rotated = `转手上方向再放 (${turns} 下)`; fixed = true; }
            }
          }
          if (!fixed) {
            await this.d.clearCursor();
            // 抽水机的朝向由水岸决定, 转不了; 放上了就是成功, 只报实际朝向 (2026-11-07 Steam 版实跑: 放上了却报"转了 2 下还是朝 west", 模型以为失败)
            if (e.type === "offshore-pump") entity.direction = `${NAME_BY_DIR[Number(e.direction ?? 0)]} (朝向由水岸决定, 要的 ${r.direction} 不算数)`;
            else entity.rotated = await this.rotateTo(e.position, String(e.name), Number(e.direction ?? 0), r.direction);
          }
        }
        if (typeof r.recipe === "string") { await this.d.clearCursor(); await this.d.setRecipe(e.position, r.recipe); entity.recipe = r.recipe; }
        built.push(entity);
      }
    } finally { await this.d.clearCursor().catch(() => undefined); }
    return rows.length === 1 ? { consumed: built.length, entity: built[0] } : { consumed: built.length, built: built.length, ...(dragged ? { dragged } : {}), total: rows.length, entities: built.slice(-6) };
  }

  /**
   * 放不下时多说几句 (2026-11-08 Sonnet 第四班: 19 次放不下里 17 次是抽水机放在不是岸边的格子, 回复只说"那格是空的", 模型换个格子再试, 一直错):
   * 那格地块、离角色多远 (够不着)、这种建筑的放置规则、附近真放得下的位置 (问模组的 placements, 按游戏规则算的; 游戏外的假接口 can_place_entity 见 game/offgame/placeable.lua)
   */
  private async placeWhy(item: string, at: Pos, hasBlocker: boolean): Promise<string> {
    const parts: string[] = [];
    try { const tile = await this.tileAt(at); if (tile) parts.push(`那格地块 ${tile}`); } catch { /* 地块读不到就不说 */ }
    try {
      const me = await this.me();
      const d = Math.hypot(me.x - at.x, me.y - at.y);
      if (d > BUILD_REACH) parts.push(`离你 ${d.toFixed(1)} 格 (够得着 ${BUILD_REACH})`);
    } catch { /* 读不到位置就不说 */ }
    const pump = item === "offshore-pump";
    const radius = pump ? 12 : 6;
    if (pump) parts.push("抽水机只能放在岸上: 脚下那格是陆地, 正面紧挨着 3 宽 2 深全是水, 朝向游戏自己定 (direction 不算数)");
    const spots = (await this.d.read?.("placements", { name: item, near: { x: at.x, y: at.y }, radius, limit: 3 }).catch(() => null)) ?? null;
    const list = Array.isArray(spots?.placements) ? (spots!.placements as { position?: Pos; direction?: string }[]).filter((s) => s.position) : [];
    if (list.length) parts.push(`附近放得下的位置 (按游戏规则算的, ${radius} 格内): ${list.map((s) => `${fmt(s.position!)}${s.direction ? ` 朝 ${s.direction}` : ""}`).join("、")}`);
    else if (spots) {
      const note = spots.in_the_way ?? spots.note;
      parts.push(`${radius} 格内没有放得下的位置${typeof note === "string" ? ` (${note.slice(0, 120)})` : ""}${pump ? "; 换一片水: ./fh call nearest_water" : ""}`);
    } else if (!hasBlocker) parts.push(`找附近放得下的位置: ./fh call placements --args '{"name":"${item}","near":{"x":${at.x},"y":${at.y}}}'`);
    return parts.length ? `; ${parts.join("; ")}` : "";
  }

  /** 那一格的地块名 (注入客户端的 world_query kind=tiles, 和 walk.ts 同一个读法; 没注入 / 读不到回 null) */
  private async tileAt(at: Pos): Promise<string | null> {
    const x = Math.floor(at.x), y = Math.floor(at.y);
    const r = await this.d.call("world_query", { selection: { kind: "tiles", area: { left_top: { x, y }, right_bottom: { x: x + 1, y: y + 1 } } }, fields: ["name"], limit: 4 });
    const o = (r.data as { objects?: { attributes?: { name?: unknown } }[] } | undefined)?.objects?.[0];
    return r.ok && typeof o?.attributes?.name === "string" ? o.attributes.name : null;
  }

  /**
   * build 的 dry_run: 什么都不发给游戏, 只读。每行带 box {left,top,right,bottom} 时查占地: 别的东西挡着 (blocked)、树和石头 (clear, 走过去拆)、同名同位置已经有了 (existing);
   * 还算差多少料 (missing)。联机没有模组的 paste dry_run, ./bp build 靠这个 (src/play/bp-online.ts)。
   */
  private async buildCheck(rows: Record<string, unknown>[]) {
    type Box = { left: number; top: number; right: number; bottom: number };
    const boxes = rows.map((r) => r.box as Box | undefined).filter((b): b is Box => !!b);
    const need: Record<string, number> = {};
    for (const r of rows) { const n = String(r.item ?? r.name ?? ""); need[n] = (need[n] ?? 0) + 1; }
    const blocked: string[] = [], clear: Pos[] = [];
    const seen = new Set<string>();
    let existing = 0;
    /** 已经放好的, 按物品数: 接着放时不该再算进要备的料 (2026-11-09 沙盘: 16 座石炉的冶炼列放了 25 件后再跑, 报缺机械臂, 什么都没放) */
    const existingBy: Record<string, number> = {};
    if (boxes.length) {
      const area = { left_top: { x: Math.min(...boxes.map((b) => b.left)) - 0.5, y: Math.min(...boxes.map((b) => b.top)) - 0.5 }, right_bottom: { x: Math.max(...boxes.map((b) => b.right)) + 0.5, y: Math.max(...boxes.map((b) => b.bottom)) + 0.5 } };
      const here = (await readArea(this.d.call, area, ["name", "type", "position", "bounding_box"], 4096)).entities as Record<string, any>[];
      for (const e of here) {
        if (!blocksBuild(String(e.type)) || !e.bounding_box) continue;
        const bb = e.bounding_box as { left_top: Pos; right_bottom: Pos };
        const hits = rows.filter((r) => { const b = r.box as Box | undefined; return b && bb.left_top.x < b.right && bb.right_bottom.x > b.left && bb.left_top.y < b.bottom && bb.right_bottom.y > b.top; });
        if (!hits.length) continue;
        const key = `${e.name}@${e.position.x},${e.position.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (e.type === "tree" || e.type === "simple-entity") clear.push(e.position as Pos);
        else if (hits.some((r) => String(r.item ?? r.name) === e.name && posOf(r.position) && Math.hypot(posOf(r.position)!.x - e.position.x, posOf(r.position)!.y - e.position.y) < 0.1)) { existing++; existingBy[e.name] = (existingBy[e.name] ?? 0) + 1; }
        else blocked.push(`${e.name} ${fmt(e.position as Pos)}`);
      }
    }
    const held = await readInventory(this.d.call);
    const cursor = (await readPlayer(this.d.call)).cursor;
    if (cursor?.name) held[cursor.name] = (held[cursor.name] ?? 0) + (cursor.count ?? 0);
    const missing: Record<string, number> = {};
    for (const [n, c] of Object.entries(need)) { const left = c - (existingBy[n] ?? 0); if ((held[n] ?? 0) < left) missing[n] = left - (held[n] ?? 0); }
    // 单件被挡 / 抽水机: 一起给附近放得下的位置 (问模组的 placements, 按游戏规则算的), 模型不用一格一格试
    let spots: { position?: Pos; direction?: string }[] | undefined;
    const item0 = String(rows[0]?.item ?? rows[0]?.name ?? ""), at0 = posOf(rows[0]?.position);
    if (rows.length === 1 && at0 && (blocked.length > 0 || item0 === "offshore-pump")) {
      const pl = (await this.d.read?.("placements", { name: item0, near: at0, radius: item0 === "offshore-pump" ? 12 : 6, limit: 3 }).catch(() => null)) ?? null;
      if (Array.isArray(pl?.placements)) spots = (pl!.placements as { position?: Pos; direction?: string }[]).slice(0, 3).map((s) => ({ position: s.position, direction: s.direction }));
    }
    return { dry_run: true, total: rows.length, need, missing, blocked, clear: clear.slice(0, 60), clear_count: clear.length, existing, ...(spots ? { spots } : {}) };
  }

  private async transfer(a: Record<string, unknown>) {
    const at = posOf(a.position ?? a.entity_position);
    const item = String(a.item ?? "");
    const direction = String(a.direction ?? "to_entity");
    if (!at || !item) throw new Error(`transfer 要 position 和 item; e.g. fh call transfer --args '{"position":{"x":1,"y":2},"direction":"to_entity","item":"coal","count":5}'`);
    if (direction !== "to_entity" && direction !== "to_player") throw new Error(`direction 只能是 to_entity 或 to_player, 收到 ${direction}`);
    const e = await this.entityAt(at);
    if (!e) throw new Error(`${fmt(at)} 没有实体`);
    await this.walkInto(e.position, BUILD_REACH, a.walk === true);
    const named = typeof a.inventory === "string" ? a.inventory : undefined;
    const requested = typeof a.count === "number" ? a.count : undefined;
    const before = (await readInventory(this.d.call))[item] ?? 0;
    let moved = 0, invName = "";
    if (direction === "to_entity") {
      // 弹匣搓好先进枪的弹药格, 主背包里没有: 主背包不够时把弹药格算上 (2026-11-07 Steam 版实跑: 50 个弹匣装不进炮塔)
      const inAmmo = async () => (requested !== undefined ? before >= requested : before > 0) ? [] : await this.ammoSlotCounts(item);
      const have = before + (await inAmmo()).reduce((s, n) => s + n, 0);
      if (have <= 0) throw new Error(`no ${item} in inventory`);
      const want = Math.min(requested ?? have, have);
      invName = insertInventory(String(e.type), item, named);
      const inv = this.invIndex(invName);
      const had = await this.d.itemCount(e.position, inv, item);
      let left = want;
      for (let round = 0; round < 12 && left > 0; round++) {
        const biggest = Math.max(0, ...(await this.d.stacks()).filter((s) => s?.name === item).map((s) => s!.count), ...(await inAmmo()));
        if (biggest <= 0) break;
        const n = Math.min(left, biggest);
        await this.d.insertExact(e.position, item, n, inv);
        left -= n;
      }
      moved = (await this.d.itemCount(e.position, inv, item)) - had;
    } else {
      const own = (await this.refuseOthers(e)) === null;
      const ammoBefore = (await this.ammoSlotCounts(item)).reduce((s, n) => s + n, 0); // 弹匣取回来先进弹药格, moved 要把它算上
      for (const name of takeInventories(String(e.type), named)) {
        const inv = this.invIndex(name);
        const there = await this.d.itemCount(e.position, inv, item);
        if (there <= 0) continue;
        invName = name;
        const want = assistTakeLimit(requested ?? there, there, own);
        if (want <= 0) throw new Error(`协助模式: ${e.name} ${fmt(e.position)} 是别人的, 库存 ${there} 个, 每样最多拿一半; 这里拿不了`);
        let left = want;
        for (let round = 0; round < 12 && left > 0; round++) {
          const remaining = await this.d.itemCount(e.position, inv, item);
          if (remaining <= 0) break;
          const n = Math.min(left, remaining, 200);
          // 一组不够 n 个时取最大的那一组 (石头一组 50, 要 60 就分两次), 按实际取到的算
          const t = (await this.d.takeExact(e.position, item, n, inv)) as { taken?: number } | undefined;
          const taken = typeof t?.taken === "number" ? t.taken : n;
          if (taken <= 0) break;
          left -= taken;
        }
        break;
      }
      if (!invName) throw new Error(`no ${item} in ${e.name} ${fmt(e.position)}`);
      moved = ((await readInventory(this.d.call))[item] ?? 0) - before + (await this.ammoSlotCounts(item)).reduce((s, n) => s + n, 0) - ammoBefore;
    }
    return { transferred: moved, inventory: invName, requested: requested ?? moved, moved, inv: (await this.invLine(item)).line };
  }

  private async craft(a: Record<string, unknown>) {
    const recipe = String(a.recipe ?? a.item ?? "");
    const count = typeof a.count === "number" ? a.count : 1;
    if (!recipe) throw new Error(`craft 要 recipe; e.g. fh call craft --args '{"recipe":"iron-gear-wheel","count":5}'`);
    const queueBefore = (await readPlayer(this.d.call)).craftingQueueSize ?? 0;
    try { await craftByHand(this.d.call, this.d.controls(), recipe, count); }
    catch (e) { if (/recipe is unavailable/.test((e as Error).message)) throw new Error(`${(e as Error).message}${await this.craftWhy(recipe)}`); throw e; }
    await (this.d.sleep ?? defaultSleep)(200);
    const queue = (await readPlayer(this.d.call)).craftingQueueSize ?? 0;
    const time = this.d.recipeTime?.(recipe) ?? null;
    const hand = time === null ? undefined : handSeconds(time, count);
    // 队列没变长 = 没排上 (料不够; 动作只报已发出, 看队列): 和模组的 nothing_queued 一样不算失败, bp-gather 靠它判断
    if (queue <= queueBefore && (time === null || time > 0.3)) return { started: 0, nothing_queued: `nothing was queued for ${recipe}: 手搓队列没变长 (料不够?)`, moved: 0, inv: (await this.invLine()).line };
    return { started: count, ...(hand !== undefined ? { hand_s: hand, queue_s: hand } : {}), moved: 0, timed: `crafts land in your inventory as each finishes${hand !== undefined ? ` (hand queue ${hand}s)` : ""}` };
  }

  /** 手搓面板里没有这个配方: 说清是不能手搓、还是没研究 (哪项科技解锁、研究了没, 注入客户端读势力的科技), 附能跑的下一条命令 */
  private async craftWhy(recipe: string): Promise<string> {
    const f = this.d.recipeInfo?.(recipe);
    if (!f) return "";
    if (!f.exists) return `。没有叫 ${recipe} 的配方 (名字写错? ./know ${recipe})`;
    if (!f.handable) return `。${recipe} 是 ${f.category} 类的配方, 手搓不了, 要放进机器做 (组装机 / 化工厂…; ./know ${recipe})`;
    if (f.enabledAtStart || !f.unlockedBy.length) return "";
    let state = "";
    try {
      const r = await this.d.call("world_query", { selection: { kind: "technologies", names: f.unlockedBy }, fields: ["name", "researched"] });
      const rows = r.ok ? ((r.data as { objects?: { attributes?: { name?: string; researched?: boolean } }[] })?.objects ?? []).map((o) => o.attributes ?? {}) : [];
      if (rows.length) state = rows.map((t) => `${t.name} ${t.researched ? "已研究" : "没研究"}`).join("、");
    } catch { /* 读不到研究状态就只说谁解锁 */ }
    const first = f.unlockedBy[0];
    return `。由科技 ${f.unlockedBy.join(" / ")} 解锁${state ? ` (${state})` : ""}; 先研究: ./fh call research --args '{"technology":"${first}"}'`;
  }

  private async holdMine(at: Pos, ticks: number) {
    const t = mineHold(this.d.controls().resolve("mine"), at, ticks);
    const r = await this.d.call("input", { timeline: t.entries }, );
    if (!r.ok) throw new Error(`挖矿按键失败: ${(r.error ?? "").slice(0, 200)}`);
  }

  private async mine(a: Record<string, unknown>) {
    const at = posOf(a.position);
    if (!at) throw new Error(`mine 要 position; e.g. fh call mine --args '{"position":{"x":1,"y":2},"count":5}'`);
    const e = await this.entityAt(at, undefined, true, true);
    if (!e) throw new Error(`${fmt(at)} 没有能挖的东西`);
    { const no = await this.refuseOthers(e); if (no) throw new Error(no); }
    const resource = e.type === "resource";
    await this.walkInto(e.position, resource || e.type === "tree" || e.type === "simple-entity" ? MINE_REACH : BUILD_REACH, a.walk === true);
    const count = typeof a.count === "number" ? a.count : 1;
    const total = async () => Object.values(await readInventory(this.d.call)).reduce((s, n) => s + n, 0);
    const before = await total();
    let idle = 0;
    for (let round = 0; round < 40; round++) {
      const got = (await total()) - before;
      if (resource && got >= count) break;
      if (Date.now() > this.deadline) return { mined: e.name, moved: got, not_done: `一条命令最多干 ${ACT_BUDGET_MS / 1000} 秒: 挖了 ${got} / ${count}, 再跑一次接着挖`, inv: (await this.invLine()).line };
      const left = resource ? count - got : 1;
      await this.holdMine(e.position, Math.min(left, MINE_BURST) * TICKS_PER_ORE + 6);
      const gained = (await total()) - before - got;
      // 拆东西: 比位置, 不能只看同名 (旁边一格的同种箱子也算的话一直等到 60 秒到点, 2026-11-07 Steam 版实跑拆箱子每次 60 秒)
      if (!resource) { const still = await this.entityAt(e.position, String(e.name), true, e.type === "character-corpse"); if (!still || still.name !== e.name || Math.hypot(still.position.x - e.position.x, still.position.y - e.position.y) > 0.01) break; }
      idle = gained > 0 ? 0 : idle + 1;
      if (idle >= 3) throw new Error(`挖 ${e.name} ${fmt(e.position)} 没有进展 (够不着? 手上有东西? 背包满了?), 已得 ${got}`);
    }
    return { mined: e.name, moved: (await total()) - before, inv: (await this.invLine()).line };
  }

  /** 弹药格里这种弹匣每一格有几个; 不是弹药或读不到回空 */
  private async ammoSlotCounts(item: string): Promise<number[]> {
    const inv = this.d.defines()?.inventory?.character_ammo;
    if (inv === undefined) return [];
    const out: number[] = [];
    for (let k = 1; k <= 3; k++) {
      const r = await this.d.call("world_query", { selection: { kind: "inspect", target: { kind: "character" }, path: [{ method: "get_inventory", arguments: [inv] }, { index: k }] }, fields: ["valid_for_read", "name", "count"] });
      const s = r.ok ? (r.data as { objects?: { attributes?: { valid_for_read?: boolean; name?: string; count?: number } }[] })?.objects?.[0]?.attributes : null;
      if (s?.valid_for_read && s.name === item) out.push(Number(s.count ?? 0));
    }
    return out;
  }

  /** 弹药格里还有多少 (开枪前后比); 读不到回 null, 不当失败 */
  private async ammoLeft(): Promise<{ magazines: number; rounds: number } | null> {
    const inv = this.d.defines()?.inventory?.character_ammo;
    if (inv === undefined) return null;
    let magazines = 0, rounds = 0;
    const names = new Set<string>();
    for (let k = 1; k <= 3; k++) {
      const r = await this.d.call("world_query", { selection: { kind: "inspect", target: { kind: "character" }, path: [{ method: "get_inventory", arguments: [inv] }, { index: k }] }, fields: ["valid_for_read", "name", "count", "ammo"] });
      if (!r.ok) return null;
      const s = (r.data as { objects?: { attributes?: { valid_for_read?: boolean; name?: string; count?: number; ammo?: number } }[] })?.objects?.[0]?.attributes;
      if (!s?.valid_for_read) continue;
      if (s.name) names.add(s.name);
      const n = Number(s.count ?? 0);
      magazines += n;
      rounds += n <= 0 ? 0 : (n - 1) * MAGAZINE_ROUNDS + Number(s.ammo ?? MAGAZINE_ROUNDS);
    }
    // 打着打着游戏会从主背包往弹药格补, 只数弹药格就成了负数 (回归查出来的): 把主背包同种的算上
    if (names.size) { const main = await readInventory(this.d.call); for (const name of names) { const n = main[name] ?? 0; magazines += n; rounds += n * MAGAZINE_ROUNDS; } }
    return { magazines, rounds };
  }

  /** 最近的敌人: 先打会动的虫子 (它们在咬你), 没有虫子才打虫巢 / 虫子塔; 都没有回 null */
  private async nearestEnemy(): Promise<{ name: string; position: Pos; moving: boolean } | null> {
    const me = await this.me();
    const r = await this.d.call("world_query", { selection: { kind: "entities", position: me, radius: SHOOT_SCAN_RADIUS, type: ["unit", "spider-unit", "segmented-unit", "unit-spawner", "turret"] }, fields: ["name", "type", "position", "force"], limit: 64 });
    if (!r.ok) { console.error(`  [开枪] 读周围的敌人失败: ${(r.error ?? "").slice(0, 200)}`); return null; }
    const rows = ((r.data as { objects?: { attributes?: { name?: string; type?: string; position?: Pos; force?: { name?: string } } }[] })?.objects ?? []).map((o) => o.attributes ?? {})
      .filter((e) => e.position && e.force?.name === "enemy");
    const moves = (e: { type?: string }) => e.type !== "unit-spawner" && e.type !== "turret";
    const dist = (p: Pos) => Math.hypot(p.x - me.x, p.y - me.y);
    const best = rows.sort((a, b) => Number(moves(b)) - Number(moves(a)) || dist(a.position!) - dist(b.position!))[0];
    return best ? { name: String(best.name), position: best.position!, moving: moves(best) } : null;
  }

  private async health(): Promise<{ health: number; max: number } | null> {
    const r = await this.d.call("world_query", { selection: { kind: "inspect", target: { kind: "character" } }, fields: ["health", "max_health"] });
    const s = r.ok ? (r.data as { objects?: { attributes?: { health?: number; max_health?: number } }[] })?.objects?.[0]?.attributes : null;
    return typeof s?.health === "number" ? { health: s.health, max: Number(s.max_health ?? 250) } : null;
  }

  /**
   * 开枪: 鼠标指着敌人按住开火键 (auto = 自己找最近的敌人, position = 指着那一点), 和人玩一样; 没有控制台。
   * 模组的 shoot 记下目标让引擎一直打, 这里是一条命令按多久就打多久 (最多 10 秒, 和模组上限一样), 回复时已经打完。
   * 2026-11-07 Steam 版实跑: 这条路原来没有开枪, 模型靠近虫巢被咬死两次, 还不了手。
   */
  private async shoot(a: Record<string, unknown>) {
    const at = posOf(a.position);
    if (a.auto !== true && !at) throw new Error(`shoot 要 auto: true 或 position; e.g. fh call shoot --args '{"auto":true,"ticks":300}'`);
    for (const k of ["vehicle", "gun", "ammo", "gun_slot"]) if (a[k] !== undefined) throw new Error(`shoot 的 ${k} 这条路还没翻译 (只开当前选中的枪), 什么都没发给游戏`);
    const ticks = Math.max(2, Math.min(SHOOT_MAX_TICKS, Math.round(Number(a.ticks ?? 60)) || 60));
    const r = a.retreat as { to?: unknown; x?: unknown; health_below?: unknown } | undefined;
    const retreatTo = r ? posOf(r.to ?? r) : null;
    const below = typeof r?.health_below === "number" ? r.health_below : 0.4;
    const start = await this.ammoLeft();
    if (start && start.magazines === 0) throw new Error("弹药格是空的, 开不了枪: 手搓 firearm-magazine (搓好自动进弹药格)");
    let fired = 0, retreated = false, died = false, aimedAt: string | undefined;
    while (fired < ticks) {
      // auto: 虫子按"打最近的敌人"键 (沙盘 3 发打死一只小虫子, 发发命中; 和平模式下这个键一发不打); 虫巢、虫子塔指着打 (120 tick 8 发, 满射速; 这个键打不打建筑没在开虫子时核过)。
      // 虫子会跑, 一小段就重读一次它在哪
      const foe = at ? null : await this.nearestEnemy();
      if (foe) aimedAt = foe.name;
      const aim = at ?? foe?.position ?? null;
      const n = Math.max(2, Math.min(foe?.moving ? SHOOT_TRACK_TICKS : SHOOT_SLICE_TICKS, ticks - fired));
      if (aim) {
        // 会动的虫子鼠标指不准 (每 6 tick 重新瞄也只打 1 发), 用"打最近的敌人"键; 虫巢、虫子塔、指定的点: 指着打
        const t = new Timeline().worldPosition(aim, 0, n - 1).holdControl(this.d.controls().resolve(foe?.moving ? "shoot-enemy" : "shoot-selected"), 1, n - 1);
        const sent = await this.d.call("input", { timeline: t.entries });
        if (!sent.ok) throw new Error(`开火按键失败: ${(sent.error ?? "").slice(0, 200)}`);
      } else {
        await (this.d.sleep ?? defaultSleep)(n * (1000 / 60)); // 周围没有敌人: 按了也打不出去, 等一小段再看
      }
      fired += n;
      const hp = await this.health();
      if (!hp) { died = true; break; }
      if (retreatTo && hp.health / hp.max < below) {
        await this.moveTo({ position: retreatTo, walk: true });
        retreated = true;
        break;
      }
    }
    const left = died ? null : await this.ammoLeft();
    const used = start && left ? start.rounds - left.rounds : undefined;
    const hp = died ? null : await this.health();
    return {
      ...(at ? { position: at } : { auto: true }), ...(aimedAt ? { aimed_at: aimedAt } : {}), fired_ticks: fired,
      ...(start ? { ammo_start: start.magazines } : {}), ...(left ? { ammo_left: left.magazines } : {}), ...(used !== undefined ? { rounds_used: used } : {}),
      ...(hp ? { health: Math.round(hp.health), max_health: hp.max } : {}),
      ...(retreated ? { retreated: retreatTo } : {}), ...(died ? { died: "角色死了: 等复活, 背包留在尸体上" } : {}),
      ...(used === 0 && !died ? { why: at ? "一发没打: 目标超出射程或那里没东西可打" : "一发没打: 射程内没有敌人 (手枪射程 15 格)" } : {}),
      moved: 0,
    };
  }

  private async rotate(a: Record<string, unknown>) {
    const at = posOf(a.position);
    if (!at) throw new Error(`rotate 要 position; e.g. fh call rotate --args '{"position":{"x":1,"y":2},"direction":"north"}'`);
    const e = await this.entityAt(at);
    if (!e) throw new Error(`${fmt(at)} 没有实体`);
    { const no = await this.refuseOthers(e); if (no) throw new Error(no); }
    await this.walkInto(e.position, BUILD_REACH, a.walk === true);
    await this.d.clearCursor();
    const from = Number(e.direction ?? 0);
    const want = typeof a.direction === "string" ? a.direction : NAME_BY_DIR[(from + 4) % 16];
    const r = await this.rotateTo(e.position, String(e.name), from, want);
    return { rotated: r.turns > 0, ...r, entity: { name: e.name, position: e.position } };
  }

  private async research(a: Record<string, unknown>) {
    const off = a.remove ?? a.cancel;
    if (typeof off === "string" || Array.isArray(off)) {
      const names = (Array.isArray(off) ? off : [off]).map(String);
      const skippedOff: string[] = [];
      await this.d.clearCursor();
      for (const t of names) { try { await cancelResearch(this.d.call, this.d.controls(), t); } catch (e) { skippedOff.push(`${t}: ${(e as Error).message.slice(0, 160)}`); } }
      if (skippedOff.length === names.length) throw new Error(skippedOff.join("; "));
      return { removed: names.filter((t) => !skippedOff.some((s) => s.startsWith(`${t}:`))), note: "依赖它的会被游戏一起拿掉; ./fh call research 看现在的队列", ...(skippedOff.length ? { skipped: skippedOff } : {}) };
    }
    const list = Array.isArray(a.research_queue) ? a.research_queue.map(String) : typeof a.technology === "string" ? [a.technology] : [];
    if (!list.length) throw new Error(`research 要 technology、research_queue 或 remove; 挪位置联机还不支持; e.g. fh call research --args '{"technology":"automation"}'; 不带参数是查队列`);
    const queued: string[] = [], skipped: string[] = [];
    await this.d.clearCursor();
    for (const t of list) {
      try { await researchTech(this.d.call, this.d.controls(), t); queued.push(t); } catch (e) { skipped.push(`${t}: ${(e as Error).message.slice(0, 160)}`); }
    }
    if (!queued.length) throw new Error(skipped.join("; "));
    return { queue: queued, ...(skipped.length ? { skipped } : {}) };
  }

  private async say(a: Record<string, unknown>) {
    // 压成一行、去掉开头的 / (以 / 开头是控制台命令, 发了这张图就不算成就; 客户端也会拒, 这里先挡)
    const text = String(a.text ?? "").replace(/\s*\r?\n\s*/g, " ").trim().replace(/^\/+/, "").trim();
    if (!text) throw new Error("say 要 text");
    const r = await this.d.chatSend(text);
    if (!r.ok) throw new Error(`chat_send 失败: ${(r.error ?? "").slice(0, 200)}`);
    return { said: true };
  }
}
