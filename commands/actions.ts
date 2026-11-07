// ./fh 的动作翻译成玩家操作 (M4 第 4 步; 旧项目 docs/io-client.md 11j): 服务器上不装模组, 每个 AI 一个干净的真客户端, 动作只发键鼠、界面点击和普通玩家动作。
// 走路、放建筑、取放、设配方在第二版已有 (body.ts、gui.ts、walk.ts; 旧项目测试集 56/56); 手搓、挖、研究、旋转搬自第一版 pilot/src/skills (那边在 注入客户端的程序 服务器上真用过), 当待核实, 真值看 npm run io:actcheck。
// 操控 MK 的身体也走这里: 没有控制台命令, 不影响成就 (上真服后要真拿一个才算核过)。
// 回复格式照模组 (班次 10-16-30 journal 的样子), 不同的: 模组是发起后计时跑, 这里做完才回, 所以回复里没有 until_tick, 命令行 --wait 也就不用再等。
import { Timeline } from "./timeline.ts";
import { cancelResearch, craftByHand, researchTech } from "./gui.ts";
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

/** build_path 的点 → 每格带子的位置和方向 (纯函数): 只能横平竖直; 最后一格用 end_direction, 没给就接着上一段的方向。不合规矩的抛错 */
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
  sleep?: (ms: number) => Promise<void>;
  /** 别人的服务器 = 协助模式 (I:\fn 总规则): 不拆不改别人的建筑和设置, 共享的材料每样不超过库存一半。me = 这个客户端的玩家名 */
  /** allowed: 用户点过头的位置 (别人的建筑也能动); 只有用户能给, 模型自己开不了 */
  assist?: { me: string; allowed?: (at: Pos) => boolean };
  /** 自己在游戏里的名字 (不是协助模式时也要: 挡路的建筑是不是自己放的) */
  me?: string;
};

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
const ACTION_NAMES = ["move_to", "build", "transfer", "craft", "mine", "rotate", "research", "say", "build_path", "collect", "refuel", "feed", "shoot"] as const;

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
    return this.refuseOthers(there);
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
      const c = await this.d.call("world_query", { selection: { kind: "inspect", target: { kind: "entities", position: e.position, name: e.name }, path: [{ property: "character_corpse_player_index" }] }, limit: 4 });
      const d = c.data as { objects?: { value?: unknown }[]; player?: { index?: unknown } } | undefined;
      if (c.ok && d?.objects?.[0]?.value === d?.player?.index) return null;
    }
    if (e.position && this.d.assist.allowed?.(e.position)) return null; // 用户点过头的
    return assistVerdict({ ...e, last_user: await this.lastUserName(e) }, this.d.assist.me);
  }

  /** 谁放的 (last_user 的名字; 读不到 / 没有 = 空串) */
  private async lastUserName(e: { position?: Pos; name?: unknown }): Promise<string> {
    const r = await this.d.call("world_query", { selection: { kind: "inspect", target: { kind: "entities", position: e.position, name: e.name }, path: [{ property: "last_user" }] }, fields: ["name"], limit: 4 });
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
    const start = Math.max(1, typeof a.start_index === "number" ? a.start_index : 1);
    const t0 = Date.now();
    let built = 0, next = start;
    try {
      for (; next <= tiles.length; next++) {
        if (Date.now() - t0 > ACT_BUDGET_MS) return { total: tiles.length, built, next_index: next, not_done: `一条命令最多干 ${ACT_BUDGET_MS / 1000} 秒: 加 start_index: ${next} 接着铺` };
        const tile = tiles[next - 1];
        const there = await this.entityAt(tile.position, item);
        { const no = await this.refuseReplacing(tile.position); if (no && !(there && Math.hypot(there.position.x - tile.position.x, there.position.y - tile.position.y) < 0.1 && Number(there.direction ?? 0) === tile.direction)) throw new Error(`第 ${next}/${tiles.length} 格 ${fmt(tile.position)}: ${no} (已铺 ${built})`); }
        if (there && Math.hypot(there.position.x - tile.position.x, there.position.y - tile.position.y) < 0.1 && Number(there.direction ?? 0) === tile.direction) continue; // 已经铺好的跳过, 重跑不重复
        await this.walkInto(tile.position, BUILD_REACH, true);
        const player = await readPlayer(this.d.call);
        if (player.cursor?.name !== item && !(await this.d.holdItem(item))) throw new Error(`no ${item} in inventory (铺到第 ${next}/${tiles.length} 格, 已铺 ${built}; 备好料加 start_index: ${next} 接着铺)`);
        const out = await this.d.placeHeld(tile.position);
        if (!out.ok) throw new Error(`第 ${next}/${tiles.length} 格 ${fmt(tile.position)} 放不下: ${out.error ?? ""} (已铺 ${built})`);
        let e = await this.entityAt(tile.position, item);
        const have = Number(e?.direction ?? 0);
        if (e && have !== tile.direction) {
          const turns = rotateTurns(have, tile.direction) ?? 0;
          for (let i = 0; i < turns; i++) { await this.pressHand("rotate"); await (this.d.sleep ?? defaultSleep)(60); }
          const again = await this.d.placeHeld(tile.position);
          if (!again.ok) throw new Error(`第 ${next} 格转方向没成: ${again.error ?? ""}`);
          const got = await this.directionSettled(tile.position, item, tile.direction, have);
          if (got !== tile.direction) throw new Error(`第 ${next} 格 ${fmt(tile.position)} 转完还是朝 ${NAME_BY_DIR[got]} (要 ${NAME_BY_DIR[tile.direction]})`);
        }
        built++;
      }
    } finally { await this.d.clearCursor().catch(() => undefined); }
    return { total: tiles.length, built, next_index: null };
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
    const rows = (Array.isArray(a.builds) ? a.builds.map((r) => ({ ...a, ...(r as object), builds: undefined })) : [a]) as Record<string, unknown>[];
    if (a.dry_run === true) return this.buildCheck(rows);
    const built: Record<string, unknown>[] = [];
    const start = Math.max(1, typeof a.start_index === "number" ? a.start_index : 1);
    try {
      for (const [i, r] of rows.entries()) {
        if (i + 1 < start) continue;
        // 留点时间给这一件 (放下 2.5 秒, 带配方再 4 秒): 到点回做了多少, 命令行 90 秒等不到就没回复了
        if (rows.length > 1 && Date.now() > this.deadline - 10_000) return { consumed: built.length, built: built.length, total: rows.length, next_index: i + 1, not_done: `一条命令最多干 ${ACT_BUDGET_MS / 1000} 秒: 加 start_index: ${i + 1} 接着放` };
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
          throw fail(`placement blocked by ${names.join(", ") || "别的东西 (水、悬崖、够不着?)"}${out.error ? ` (${out.error.slice(0, 160)})` : ""}`);
        }
        const e = await this.entityAt(at, item);
        if (!e) throw fail(`${item} 放下后在 ${fmt(at)} 读不到 (物品名和实体名不一样? 被挡了?)`);
        const entity: Record<string, unknown> = { name: e.name, type: e.type, position: e.position, ...(e.unit_number ? { unit_number: e.unit_number } : {}) };
        if (typeof r.direction === "string" && NAME_BY_DIR[Number(e.direction ?? 0)] !== r.direction) {
          await this.d.clearCursor();
          // 抽水机的朝向由水岸决定, 转不了; 放上了就是成功, 只报实际朝向 (2026-11-07 Steam 版实跑: 放上了却报"转了 2 下还是朝 west", 模型以为失败)
          if (e.type === "offshore-pump") entity.direction = `${NAME_BY_DIR[Number(e.direction ?? 0)]} (朝向由水岸决定, 要的 ${r.direction} 不算数)`;
          else entity.rotated = await this.rotateTo(e.position, String(e.name), Number(e.direction ?? 0), r.direction);
        }
        if (typeof r.recipe === "string") { await this.d.clearCursor(); await this.d.setRecipe(e.position, r.recipe); entity.recipe = r.recipe; }
        built.push(entity);
      }
    } finally { await this.d.clearCursor().catch(() => undefined); }
    return rows.length === 1 ? { consumed: built.length, entity: built[0] } : { consumed: built.length, built: built.length, total: rows.length, entities: built.slice(-6) };
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
        else if (hits.some((r) => String(r.item ?? r.name) === e.name && posOf(r.position) && Math.hypot(posOf(r.position)!.x - e.position.x, posOf(r.position)!.y - e.position.y) < 0.1)) existing++;
        else blocked.push(`${e.name} ${fmt(e.position as Pos)}`);
      }
    }
    const held = await readInventory(this.d.call);
    const cursor = (await readPlayer(this.d.call)).cursor;
    if (cursor?.name) held[cursor.name] = (held[cursor.name] ?? 0) + (cursor.count ?? 0);
    const missing: Record<string, number> = {};
    for (const [n, c] of Object.entries(need)) if ((held[n] ?? 0) < c) missing[n] = c - (held[n] ?? 0);
    return { dry_run: true, total: rows.length, need, missing, blocked, clear: clear.slice(0, 60), clear_count: clear.length, existing };
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
    await craftByHand(this.d.call, this.d.controls(), recipe, count);
    await (this.d.sleep ?? defaultSleep)(200);
    const queue = (await readPlayer(this.d.call)).craftingQueueSize ?? 0;
    const time = this.d.recipeTime?.(recipe) ?? null;
    const hand = time === null ? undefined : handSeconds(time, count);
    // 队列没变长 = 没排上 (料不够; 动作只报已发出, 看队列): 和模组的 nothing_queued 一样不算失败, bp-gather 靠它判断
    if (queue <= queueBefore && (time === null || time > 0.3)) return { started: 0, nothing_queued: `nothing was queued for ${recipe}: 手搓队列没变长 (料不够?)`, moved: 0, inv: (await this.invLine()).line };
    return { started: count, ...(hand !== undefined ? { hand_s: hand, queue_s: hand } : {}), moved: 0, timed: `crafts land in your inventory as each finishes${hand !== undefined ? ` (hand queue ${hand}s)` : ""}` };
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
      const r = await this.d.call("world_query", { selection: { kind: "inspect", target: { kind: "character" }, path: [{ method: "get_inventory", arguments: [inv] }, { index: k }] }, fields: ["valid_for_read", "name", "count"], limit: 4 });
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
      const r = await this.d.call("world_query", { selection: { kind: "inspect", target: { kind: "character" }, path: [{ method: "get_inventory", arguments: [inv] }, { index: k }] }, fields: ["valid_for_read", "name", "count", "ammo"], limit: 4 });
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
    const r = await this.d.call("world_query", { selection: { kind: "inspect", target: { kind: "character" } }, fields: ["health", "max_health"], limit: 4 });
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
