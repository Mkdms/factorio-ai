// 我们的联机接口 (第一版: TypeScript 行动层, 包在 注入客户端的程序 (game/client) 外面; 旧项目 docs/io-client.md 第 11b 节"还要我们补的", 第 12 节)。
// 注入客户端的程序 的工具只给事实和能力、动作只报"已发出" (他的规矩, 第 9b 节), 下面这些他按设计不做, 由我们这层补 (不改他的东西):
//   ① 状态给名字 (T6): 注入客户端的程序 只给状态码; 数字 → 名字的对照表从本机同版本游戏导出 (src/lab/defines.ts; 联机时客户端和服务器必须同版本)
//   ② "放不下"要报 (T7b): 放完按 tick 等客户端走过服务器延迟, 手上没少、那格也没有这东西 (或虚影) = 放不下, 报出那格有什么
//   ③ 看出联机暂停 (T11a): 它的 paused 只反映本地; 隔一小会儿读两次客户端 tick, 没动 = 服务器暂停了
//   ④ 暂停时不丢动作 (T11c): 键鼠动作发出前先查暂停, 暂停中明确报"暂停中, 没发" (注入客户端的程序 暂停时会回"完成"但动作被丢)
//   ⑤ 有人同时操作要让出 (T15a): 记下我们最后一次发输入时的 tick; 玩家空闲 tick (afk_time) 明显短于"距我们最后一次输入" = 别人按过键
//   ⑥ 直接发玩家动作 (T8 取放太慢): 程序的 player_action 工具 (构造 InputAction 经 Player::sendToListeners 发, 和他发聊天同一条路, 游戏自己同步);
//      取放不再经界面一个个点 (insertExactDirect / takeExactDirect)。沙盘核出来的三条规矩 (2026-11-04, 旧项目 docs/io-client.md 第 11e 节, 旧项目 direct-probe.ts):
//      a. 选中不注入: 注入过一条 SelectedEntityChanged 之后客户端自己的鼠标选中就失灵 (P9 V1), 改用真鼠标悬停选中, 再注入 open_gui
//         (注入的选中还会被客户端下一 tick 清掉, 所以就算注入也得和 open_gui 连发, P1/P2);
//      b. 每条动作里的格子都要带那格"当时"的物品 ID + 品质 ID (空格填 0), 和真实客户端一样: 填 0 时拿不到手, 右键从第 32 个起全丢;
//         ID 从游戏内存的原型表读 (game/memory/reader.py, 进程外只读, 挂接时读一次); 无效 ID 会把客户端弄掉线, 所以只用读出来的;
//      c. 发完按读回的真值补差额 (动作只报"已发出", 不保证落地)。
// 没有副作用, 可以 import。测试: test/sandbox/actions.test.ts (对 RCON 真值)。
import { readProtoIds } from "../game/memory/read.ts";
import { ClientTarget } from "./client-target.ts";
import { Timeline } from "./timeline.ts";
import { readPlayer } from "./query.ts";
import { pressKey } from "./gui.ts";
import type { Outcome, Pos } from "./io-types.ts";
import { defineName, type Defines } from "../game/sandbox/defines.ts";

/** 和建筑站在同一点上、但不是要读的那件东西 */
const NOT_THE_BUILDING = new Set(["resource", "character", "item-entity", "corpse", "character-corpse", "flying-text", "entity-ghost", "logistic-robot", "construction-robot"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 读内存拿到的原型 ID 表: 名字 → 游戏内部的数字 ID (ItemStack.itemID / ClientItemStackLocation.itemID 用的) */
export type ProtoIds = { item: Record<string, number>; quality: Record<string, number> };
/** 每步动作之后的读回: 选中的实体、手上 (名字×个数)、手的来源格、打开的窗口 (实体名) */
export type Peek = { step: string; selected: string | null; cursor: string | null; hand: unknown; opened: string | null };

/** 挂接后跑一次 game/memory/reader.py (进程外 ReadProcessMemory, 布局由 pdb-dump 现场取); exe = 被读进程的 factorio.exe */
export function loadProtoIds(pid: number, exe: string): ProtoIds {
  const j = readProtoIds(pid, exe);
  return { item: j.Item.by_name, quality: j.Quality.by_name };
}

/**
 * 右键 (cursor_split, 一次放 1 个) 的分段计划 (纯函数, 有单元测试): 目标格现在有 existing 个同种物品 (0 = 空), 要再放 count 个。
 * 规矩 b: 空格的第 1 次填 0 (那格当时是空的), 之后每条都带物品 ID + 品质 ID; 一条最多 burst 次 (工具上限 256)。
 */
export function splitPlan(existing: number, count: number, item: number, quality: number, burst = 64): { count: number; item?: number; quality?: number }[] {
  const out: { count: number; item?: number; quality?: number }[] = [];
  let left = Math.max(0, Math.floor(count));
  if (left > 0 && existing <= 0) { out.push({ count: 1 }); left--; }
  while (left > 0) { const n = Math.min(burst, left); out.push({ count: n, item, quality }); left -= n; }
  return out;
}
/** 读回里手上有几个 (#peek 写成 "名字×个数", 空手是 null) */
const inHandOf = (p: { cursor: string | null }) => Number(p.cursor?.split("×")[1] ?? 0);
/** 放完 / 动完之后等客户端走过多少 tick 再读回 (第 11c 节第 2 条: 按 tick 等, 不按秒; 服务器延迟一般 1~2 tick, 留足) */
export const SETTLE_TICKS = 20;
/** 判暂停: 隔这么久读两次 tick (1 倍速时约 18 tick) */
export const PAUSE_PROBE_MS = 300;
/** 判"别人按过键": 空闲 tick 比"距我们最后一次输入"短这么多以上 */
export const OTHERS_MARGIN_TICKS = 30;

/** ⑤ 的判法 (纯函数, 有单元测试): ourLastInput = 我们最后一次发输入时的客户端 tick (没发过 = null), afk = 玩家空闲 tick */
export function othersActed(now: number, ourLastInput: number | null, afk: number | undefined, margin = OTHERS_MARGIN_TICKS): boolean {
  if (afk === undefined) return false;
  if (ourLastInput === null) return afk < margin; // 我们没发过输入, 玩家却刚动过
  return afk + margin < now - ourLastInput;
}

export class Body extends ClientTarget {
  /** 状态码对照表 (测试集开沙盘后没有就现导) */
  defines: Defines | null;
  /** 我们最后一次发输入 (键鼠、界面点击) 时的客户端 tick */
  lastInputTick: number | null = null;

  /** 直接发玩家动作 (⑥): 程序的 player_action 工具, 取放不再经界面一个个点; 关掉就全走界面 (对照用) */
  readonly direct: boolean;
  /** 读内存拿到的原型 ID 表 (规矩 b; 挂接时读); 读不到时 idsError 记原因, 取放退回界面那条路 */
  ids: ProtoIds | null = null;
  idsError: string | null = null;
  /** 被挂接的游戏 exe (memory_read 不可用时退到 game/memory/reader.py 读 ID 表要它) */
  gameExe: string | null = null;

  constructor(port: number, defines: Defines | null, opts: { exe?: string; direct?: boolean; gameExe?: string } = {}) {
    super(port, opts.exe);
    this.defines = defines;
    this.direct = opts.direct ?? true;
    this.gameExe = opts.gameExe ?? null;
    (this as { label: string }).label = `行动层${this.direct ? " + player_action" : ""} (包在注入客户端的程序外面)`;
  }

  /** ID 表从哪来: 程序的 memory_read 工具 (进程外读, 1~4 毫秒) 优先; 不可用就退到 game/memory/reader.py (约 50 毫秒, 要 gameExe) */
  idsSource: "memory_read" | "python" | null = null;

  override async attach(pid: number) {
    await super.attach(pid);
    if (!this.direct) return;
    const item = await this.mcp.call("memory_read", { kind: "item_ids" });
    const quality = item.ok ? await this.mcp.call("memory_read", { kind: "quality_ids" }) : item;
    if (item.ok && quality.ok) {
      this.ids = { item: (item.data as any).ids ?? {}, quality: (quality.data as any).ids ?? {} };
      this.idsSource = "memory_read"; this.idsError = null;
      return;
    }
    try {
      if (!this.gameExe) throw new Error("memory_read 不可用, 又没给 gameExe 退到 reader.py");
      this.ids = loadProtoIds(pid, this.gameExe); this.idsSource = "python"; this.idsError = null;
    } catch (e) { this.ids = null; this.idsSource = null; this.idsError = ((e as any).stderr ?? (e as Error).message).toString().slice(0, 300); console.error(`  [直接动作] 读内存拿原型 ID 失败 (memory_read: ${(item.error ?? quality.error ?? "").slice(0, 80)}), 取放退回界面: ${this.idsError}`); }
  }

  /** 直接动作可用: 有 player_action 且 ID 表读到了 */
  get #directReady() { return this.direct && this.ids !== null; }

  /** 名字 → 物品 ID + 品质 ID (规矩 b); 表里没有就抛 (绝不猜 ID: 无效 ID 会把客户端弄掉线) */
  #idOf(item: string, quality = "normal") {
    if (!this.ids) throw new Error(`没有原型 ID 表 (${this.idsError ?? "还没挂接"})`);
    const i = this.ids.item[item], q = this.ids.quality[quality];
    if (i === undefined || q === undefined) throw new Error(`原型 ID 表里没有 ${item} / ${quality}`);
    return { item: i, quality: q };
  }

  /** 发一条 player_action (程序的工具); 失败抛错 */
  async #act(action: string, extra: Record<string, unknown> = {}) {
    const r = await this.mcp.call("player_action", { action, ...extra });
    if (!r.ok) throw new Error(`player_action ${action} 失败: ${(r.error ?? "").slice(0, 200)}`);
    return (r.data ?? {}) as { sent?: number };
  }

  /** 等到读回满足条件 (动作从发出到落地的 tick 数不固定: 沙盘里见过 5~7 tick, 也见过 30 多 tick), 最多 maxTicks; 返回最后一次读回和等了几 tick */
  async #untilPeek(step: string, pred: (p: Peek) => boolean, maxTicks = 90) {
    const t0 = await this.tick();
    let p = await this.#peek(step);
    while (!pred(p)) {
      const t = await this.tick();
      if (t >= t0 + maxTicks) return { p, ticks: t - t0, ok: false };
      await sleep(40);
      p = await this.#peek(step);
    }
    return { p, ticks: (await this.tick()) - t0, ok: true };
  }

  /** 等实体某格的个数满足条件 (最多 maxTicks); 返回最后读到的个数 */
  async #untilSlot(at: Pos, inv: number, slot: number, pred: (n: number) => boolean, maxTicks = 90) {
    const t0 = await this.tick();
    let n = (await this.#entitySlot(at, inv, slot + 1))?.count ?? 0;
    while (!pred(n)) {
      const t = await this.tick();
      if (t >= t0 + maxTicks) return { n, ticks: t - t0, ok: false };
      await sleep(40);
      n = (await this.#entitySlot(at, inv, slot + 1))?.count ?? 0;
    }
    return { n, ticks: (await this.tick()) - t0, ok: true };
  }

  /**
   * 规矩 a (2026-11-04 改): 选中**不注入** —— 注入一条 SelectedEntityChanged 之后客户端自己的鼠标选中就失灵了 (换个地方再悬停 / 点击都选不中,
   * 旧项目 direct-probe.ts P9 变体 V1 复现, V0/V2 对照正常), 后面走界面的操作 (设请求、设配方) 全挂。改成真鼠标悬停让客户端自己发选中
   * (它的 input 时间线把鼠标放到世界坐标上), 等 selected 出现再注入 open_gui; 开窗口之后的取放照旧注入。
   */
  async #openGui(at: Pos) {
    let last = "";
    let ticks = 0;
    /** 这次已经发过 open_gui 的实体: 开窗口过了网络延迟才落地, 重试时看到它开着就是上一轮晚到的, 不用再开 */
    let wanted: string | null = null;
    // 开着窗口时鼠标悬停选不中东西: 上一个动作留下的先关 (2026-11-06 注入客户端的程序 存档副本: 设配方走按键关窗口, 机器窗口留着, 下一条取放悬停 3 次都选不中)
    if ((await this.#peek("hover")).opened) await this.#closeGui();
    // 刚关完窗口、鼠标没动过时客户端的选中有竞态 (2026-11-04 T8b 偶发: 读到 selected 了, open_gui 却没开窗口): 悬停先偏开 0.3 格再回来, 让客户端重新选中; 没开就重试
    for (let attempt = 1; attempt <= 3; attempt++) {
      const d = attempt % 2 ? 0.3 : -0.3;
      const hover = await this.mcp.call("input", { timeline: new Timeline().worldPosition({ x: at.x + d, y: at.y + d }, 0, 1).worldPosition(at, 2, 4).entries }, 10_000);
      if (!hover.ok) throw new Error(`鼠标悬停失败: ${(hover.error ?? "").slice(0, 200)}`);
      const s = await this.#untilPeek("hover", (p) => !!p.selected || !!p.opened, 60);
      ticks += s.ticks;
      if (s.p.opened) {
        if (s.p.opened === wanted) return { ...s.p, ticks, attempt };
        await this.#closeGui();
        last = `悬停时开着别的窗口 ${s.p.opened}, 关了重试`;
        continue;
      }
      if (!s.ok) { last = `鼠标悬停 ${s.ticks} tick 后还没选中 (实体不在屏幕上? 够不着?): ${JSON.stringify(s.p)}`; continue; }
      wanted = s.p.selected;
      await this.#act("open_gui");
      // 真服有网络延迟 (latency 32 tick + 来回), 45 tick 太紧
      const r = await this.#untilPeek("open_gui", (p) => !!p.opened, 90);
      ticks += r.ticks;
      if (r.ok) return { ...r.p, ticks, attempt };
      last = `悬停选中 ${s.p.selected} 后注入 open_gui、等了 ${r.ticks} tick 之后 opened 还是空: ${JSON.stringify(r.p)}`;
    }
    throw new Error(`窗口没打开 (试了 3 次, 共 ${ticks} tick): ${last}`);
  }

  /** 清手 (手上的回背包) + 关窗口, 读回核对 */
  async #closeGui() {
    await this.#act("clear_cursor");
    await this.#act("close_gui");
    // 等读回干净才算完: 联机有网络延迟 (真服日志 latency 32 tick), 大世界帧也慢; 只等 4 tick 时手上剩的 43 个煤还没回背包就回复了 (2026-11-06 注入客户端的程序 存档副本, 背包读成 10)
    const r = await this.#untilPeek("close_gui", (p) => !p.opened && !p.cursor, 150);
    if (!r.ok) console.error(`  [直接动作] 关窗口 / 清手之后还有: ${JSON.stringify(r.p)}`);
    return r.p;
  }

  /**
   * 角色要在自己视角才能动手: 开着地图 (远程视图) 时走不了路、放下的只是虚影、点不到画面外。退出来; 退不出来抛错, 不闷声做错事。
   * 真服上 Claude-Opus 就是在远程视图里存的 (2026-11-06 存档副本 controller_type = 7, 身体 1), 下次进去还在地图里; 有人在窗口里开地图也一样。
   */
  async ensureBody(): Promise<boolean> {
    const want = this.defines?.controllers?.character ?? 1;
    const inBody = async () => { const p = await readPlayer(this.call); return Number(p.controllerType) === want || p.controllerType === "character"; };
    if (await inBody()) return false;
    // 死了等复活的时候是幽灵控制器: 按键退不出来, 按 ESC 还会开菜单; 老实说死了 (2026-11-07 Steam 版实跑, 原来报"退不出地图", 模型看不懂)
    const ghost = this.defines?.controllers?.ghost ?? 0;
    const now = await readPlayer(this.call);
    if (!now.hasCharacter && (Number(now.controllerType) === ghost || now.controllerType === "ghost")) throw new Error("角色死了, 等复活 (一般十来秒, 在出生点); 背包留在尸体上 (character-corpse); 动作没发");
    for (const key of [this.controls?.key("toggle-map") ?? "M", "ESCAPE"]) {
      await this.#input(() => pressKey(this.call, key));
      for (let i = 0; i < 15; i++) { await sleep(100); if (await inBody()) return true; }
    }
    throw new Error(`角色不在自己视角 (控制器 ${String((await readPlayer(this.call)).controllerType)}), 按键也退不出地图; 动作没发`);
  }

  /**
   * 按位置点名那件建筑: 建筑压在矿上时那一点有两个实体, 它的 inspect 要求正好一个, 不点名就读不到。
   * 2026-11-07 Steam 版实跑: 煤矿上的箱子 66 个煤读成 0, 模型只好拆箱子取; 炉子放矿只进 14 个、refuel 放不进, 都是这个。沙盘考场的箱子不在矿上, 测不出来。
   */
  async #entityTarget(at: Pos): Promise<{ kind: "entities"; position: Pos; name?: string }> {
    const r = await this.mcp.call("world_query", { selection: { kind: "entities", position: at }, fields: ["name", "type"], limit: 16 });
    const rows = r.ok ? ((r.data as { objects?: { attributes?: { name?: string; type?: string } }[] })?.objects ?? []).map((o) => o.attributes ?? {}) : [];
    const name = rows.find((e) => e.name && !NOT_THE_BUILDING.has(String(e.type)))?.name;
    return { kind: "entities", position: at, ...(name ? { name } : {}) };
  }

  /**
   * 带状态的物品 (弹匣、枪、护甲) 右键放进一格时要带的编号: 还要带那一格物品自己的 item_number, 不带就被游戏忽略
   * (2026-11-07 沙盘: 弹匣拿不起来, 放炮塔只进第一个; 带上后拿得起来)。第一个放进空格的不带编号, 等它落地才读得到。
   * 普通物品不走这里: 放进正在烧的炉子时第一个矿马上被吃掉, 等它落地就晚了, 后面的右键全打在空格上 (回归查出来的)。
   */
  async #splitIds(at: Pos, inv: number, slot: number, cur: number, s: { item?: number; quality?: number }) {
    if (s.item === undefined) return {};
    if (cur <= 0) await this.#untilSlot(at, inv, slot, (n) => n >= 1);
    const number = (await this.#entitySlot(at, inv, slot + 1))?.number;
    return { item: s.item, quality: s.quality, ...(number ? { item_number: number } : {}) };
  }

  /** 自己身上某个物品栏第 k 格 (1 起) 那件物品的 item_number; 普通物品没有 */
  async #ownItemNumber(inv: number, k: number): Promise<{ item_number?: number }> {
    const r = await this.mcp.call("world_query", { selection: { kind: "inspect", target: { kind: "character" }, path: [{ method: "get_inventory", arguments: [inv] }, { index: k }] }, fields: ["valid_for_read", "item_number"], limit: 4 });
    const n = r.ok ? (r.data as { objects?: { attributes?: { item_number?: unknown } }[] })?.objects?.[0]?.attributes?.item_number : undefined;
    return typeof n === "number" && n > 0 ? { item_number: n } : {};
  }

  /** 规矩 c: 对实体的 slot 格 (0 起) 右键放 want 个 (那格现在 cur 个), 发完读回, 不够再补 (最多 rounds 轮); 返回最后读到的个数 */
  async #splitUntil(at: Pos, inv: number, slot: number, cur: number, want: number, id: { item: number; quality: number }, numbered = false, rounds = 4) {
    let sent = 0, r = 0;
    for (; r < rounds && cur < want; r++) {
      for (const s of splitPlan(cur, want - cur, id.item, id.quality)) {
        const a = await this.#act("cursor_split", { count: s.count, target: { source: "entity_inventory", inventory: inv, slot, ...(numbered ? await this.#splitIds(at, inv, slot, cur, s) : s.item !== undefined ? { item: s.item, quality: s.quality } : {}) } });
        sent += a.sent ?? s.count;
      }
      // 等落地 (最多 90 tick): 到数就走; 没到数再等 SETTLE_TICKS 让迟到的都落完, 再按读回补差额
      const w = await this.#untilSlot(at, inv, slot, (n) => n >= want);
      if (!w.ok) await this.waitTicks(SETTLE_TICKS);
      cur = w.ok ? w.n : (await this.#entitySlot(at, inv, slot + 1))?.count ?? 0;
    }
    return { cur, sent, rounds: r };
  }

  /**
   * 手上放回实体, 直到手上正好 keep 个。看手不看格子: 机器还在产出时格子的数自己会涨, 看格子以为放够了;
   * 而且"这格是空的"那次右键遇上新产出会被游戏拒掉 (规矩 b)。2026-11-06 注入客户端的程序 存档副本: 炉子取 1 个, 拿了 2 个。每轮重读那格, 按当时的样子发。
   */
  async #putBackUntil(at: Pos, inv: number, slot: number, inHand: number, keep: number, id: { item: number; quality: number }, numbered = false, rounds = 4) {
    let sent = 0, r = 0;
    for (; r < rounds && inHand > keep; r++) {
      const cur = (await this.#entitySlot(at, inv, slot + 1))?.count ?? 0;
      for (const s of splitPlan(cur, inHand - keep, id.item, id.quality)) {
        const a = await this.#act("cursor_split", { count: s.count, target: { source: "entity_inventory", inventory: inv, slot, ...(numbered ? await this.#splitIds(at, inv, slot, cur, s) : s.item !== undefined ? { item: s.item, quality: s.quality } : {}) } });
        sent += a.sent ?? s.count;
      }
      const w = await this.#untilPeek("cursor_split", (p) => inHandOf(p) <= keep);
      // 没到数再等一会儿, 让迟到的都落完, 再按读回补差额
      if (!w.ok) await this.waitTicks(SETTLE_TICKS);
      inHand = w.ok ? inHandOf(w.p) : inHandOf(await this.#peek("cursor_split"));
    }
    return { inHand, sent, rounds: r };
  }

  /**
   * 实体某个物品栏的第 k 格 (1 起) 里是什么: inspect get_inventory(inv)[k], 只读 valid_for_read / name / count 三个属性; 空格 null。
   * 它的 inspect 不带 fields 时按他的属性表顺序分页读全部属性 (limit 4 只读到前 4 个, 空格时全是 read_status 报错, attributes 是空的), 所以必须给 fields。
   */
  async #entitySlot(at: Pos, inv: number, k: number, known?: { kind: "entities"; position: Pos; name?: string }): Promise<{ name: string; count: number; number?: number } | null> {
    const target = known ?? await this.#entityTarget(at);
    const ask = () => this.mcp.call("world_query", { selection: { kind: "inspect", target, path: [{ method: "get_inventory", arguments: [inv] }, { index: k }] }, fields: ["valid_for_read", "name", "count", "item_number"], limit: 8 });
    let r = await ask();
    // 这一点上不止一个实体: 通常是物流机器人正飞过箱子 (2026-11-06 注入客户端的程序 存档副本), 过一下就走了
    for (let i = 0; i < 12 && !r.ok && /exactly one entity/.test(r.error ?? ""); i++) { await new Promise((ok) => setTimeout(ok, 200)); r = await ask(); }
    if (!r.ok) throw new Error(`读实体物品栏 ${inv} 第 ${k} 格失败: ${(r.error ?? "").slice(0, 200)}`);
    const o = (r.data as any)?.objects?.[0];
    const a = o?.attributes ?? {};
    if (a.valid_for_read === false) return null; // 空格: name / count 读不到 (在 read_status 里报错), valid_for_read 是 false
    if (typeof a.name !== "string") throw new Error(`读实体物品栏 ${inv} 第 ${k} 格: 看不懂的回复 ${JSON.stringify((r.data as any)?.objects ?? r.data).slice(0, 2000)}`);
    return { name: a.name, count: Number(a.count ?? 0), ...(typeof a.item_number === "number" && a.item_number > 0 ? { number: a.item_number } : {}) };
  }

  /** 找实体物品栏里第一个满足条件的格子 (0 起的格号, 给动作用); 没有返回 -1。第 1 格就读不到 = 查询本身有问题, 抛出去 */
  async #findEntitySlot(at: Pos, inv: number, pick: (s: { name: string; count: number } | null) => boolean, max = 48): Promise<{ slot: number; stack: { name: string; count: number; number?: number } | null }> {
    const target = await this.#entityTarget(at);
    for (let k = 1; k <= max; k++) {
      let s: { name: string; count: number } | null;
      try { s = await this.#entitySlot(at, inv, k, target); } catch (e) { if (k === 1) throw e; break; } // 超出格数时 index 报错 = 到头了
      if (pick(s)) return { slot: k - 1, stack: s };
    }
    return { slot: -1, stack: null };
  }

  /** 实体某物品栏里这种物品有几个 (M4 第 4 步: 取放前后核对); 读不到这个物品栏 (这个实体没有) 算 0 */
  async entityItemCount(at: Pos, inv: number, item: string, max = 48): Promise<number> {
    let n = 0;
    const target = await this.#entityTarget(at);
    for (let k = 1; k <= max; k++) {
      let s: { name: string; count: number } | null;
      try { s = await this.#entitySlot(at, inv, k, target); } catch { break; } // 超出格数或没有这个物品栏
      if (s?.name === item) n += s.count;
    }
    return n;
  }

  /** 诊断: 选中的实体、手上、打开的界面 (每步动作之后读一次, 好看出动作在哪一步被游戏丢掉) */
  async #peek(step: string) {
    const p = await this.mcp.call("world_query", { selection: { kind: "player" }, fields: ["selected", "cursor_stack", "hand_location"] });
    const a = (p.data as any)?.objects?.[0]?.attributes ?? {};
    // opened 是个 LuaEntity (或别的对象) 引用: inspect 的 values 模式按属性表分页读, 要给 fields 才能直接拿到 name (不带 fields 时 limit 4 只读到前 4 个属性)
    const o = await this.mcp.call("world_query", { selection: { kind: "inspect", target: { kind: "player" }, path: [{ property: "opened" }] }, fields: ["name"], limit: 4 });
    const opened = (o.data as any)?.objects?.[0];
    const openedName = opened?.availability === "nil" ? null : opened?.attributes?.name ?? opened?.object_name ?? null;
    const out = { step, selected: a.selected?.name ?? null, cursor: a.cursor_stack?.valid_for_read === false ? null : a.cursor_stack ? `${a.cursor_stack.name}×${a.cursor_stack.count}` : null, hand: a.hand_location ?? null, opened: o.ok ? openedName : `读不到: ${(o.error ?? "").slice(0, 80)}` };
    console.error(`  [直接动作] ${JSON.stringify(out)}`);
    return out;
  }

  /**
   * 直接发动作的"放正好 count 个": 选中 + 开窗口 (连发) → 在背包里找够数的那一组拿到手上 (cursor_transfer, 带 ID) →
   * 对实体的格子右键 count 次 (cursor_split, 一次 1 个, 空格第 1 次 ID 0、之后带 ID) → 读回不够就补 → 清手 (剩下的回背包) → 关窗口。
   * inv = 实体的物品栏编号 (箱子 1 = defines.inventory.chest); 只对箱子这类单物品栏的实体核过; 品质只做普通 (背包读法没带品质)。
   */
  async insertExactDirect(at: Pos, item: string, count: number, inv = this.defines?.inventory?.chest ?? 1) {
    const id = this.#idOf(item);
    const slots = await this.inventorySlots();
    let mine = slots.findIndex((s) => s && s.name === item && s.count >= count);
    let source = this.defines?.inventory?.character_main ?? 1;
    // 弹匣搓好先进枪的弹药格, 主背包里没有 (2026-11-07 Steam 版实跑: 50 个弹匣装不进炮塔): 从弹药格拿
    if (mine < 0 && this.defines?.inventory?.character_ammo !== undefined) {
      const ammoInv = this.defines.inventory.character_ammo;
      const me = { kind: "character" };
      for (let k = 1; k <= 3 && mine < 0; k++) {
        const r = await this.mcp.call("world_query", { selection: { kind: "inspect", target: me, path: [{ method: "get_inventory", arguments: [ammoInv] }, { index: k }] }, fields: ["valid_for_read", "name", "count"], limit: 4 });
        const a = r.ok ? (r.data as { objects?: { attributes?: { valid_for_read?: boolean; name?: string; count?: number } }[] })?.objects?.[0]?.attributes : null;
        if (a?.valid_for_read && a.name === item && Number(a.count) >= count) { mine = k - 1; source = ammoInv; }
      }
    }
    if (mine < 0) throw new Error(`背包里没有一组 ≥ ${count} 个的 ${item}`);
    // 目标格: 先找空格, 没有再找同种物品的格 (满了放不进去由读回发现)
    let found = await this.#findEntitySlot(at, inv, (s) => !s);
    if (found.slot < 0) found = await this.#findEntitySlot(at, inv, (s) => !!s && s.name === item);
    if (found.slot < 0) throw new Error(`实体物品栏 ${inv} 里没有空格或同种物品的格子`);
    const { slot } = found;
    const existing = found.stack?.count ?? 0;
    return this.#input(async () => {
      const trace: unknown[] = [];
      let r = { cur: existing, sent: 0, rounds: 0 };
      try {
        trace.push(await this.#openGui(at));
        const own = await this.#ownItemNumber(source, mine + 1);
        await this.#act("cursor_transfer", { target: { source: "player_inventory", inventory: source, slot: mine, ...id, ...own } });
        const held = await this.#untilPeek("cursor_transfer", (p) => !!p.cursor?.startsWith(`${item}×`)); trace.push({ ...held.p, ticks: held.ticks });
        if (!held.ok) throw new Error(`没拿到手 (背包第 ${mine + 1} 格 ${item}, 等了 ${held.ticks} tick): ${JSON.stringify(held.p)}`);
        r = await this.#splitUntil(at, inv, slot, existing, existing + count, id, own.item_number !== undefined);
      } finally { trace.push(await this.#closeGui()); }
      if (r.cur !== existing + count) throw new Error(`放了 ${r.rounds} 轮还不对: 那格 ${r.cur} 个 (要 ${existing + count}), 发了 ${r.sent} 次右键`);
      return { direct: true, playerSlot: mine, entitySlot: slot, sent: r.sent, rounds: r.rounds, trace };
    });
  }

  /** 直接发动作的"取正好 count 个": 找到实体里那一组 → 拿到手上 (带 ID) → 右键放回 (组里数 − count) 个 (读回不够就补) → 清手 (正好 count 个进背包) → 关窗口 */
  async takeExactDirect(at: Pos, item: string, count: number, inv = this.defines?.inventory?.chest ?? 1) {
    const id = this.#idOf(item);
    const { slot, stack } = await this.#findEntitySlot(at, inv, (s) => !!s && s.name === item && s.count >= count);
    if (slot < 0 || !stack) throw new Error(`实体物品栏 ${inv} 里没有一组 ≥ ${count} 个的 ${item}`);
    return this.#input(async () => {
      const trace: unknown[] = [];
      let r = { inHand: 0, sent: 0, rounds: 0 }, had = stack.count;
      try {
        trace.push(await this.#openGui(at));
        await this.#act("cursor_transfer", { target: { source: "entity_inventory", inventory: inv, slot, ...id, ...(stack.number ? { item_number: stack.number } : {}) } });
        // 机器还在产出时拿到手的可能比刚才读到的多, 按手上实际的算
        const held = await this.#untilPeek("cursor_transfer", (p) => !!p.cursor?.startsWith(`${item}×`)); trace.push({ ...held.p, ticks: held.ticks });
        if (!held.ok) throw new Error(`没拿到手 (实体第 ${slot + 1} 格 ${item}×${stack.count}, 等了 ${held.ticks} tick): ${JSON.stringify(held.p)}`);
        had = inHandOf(held.p);
        r = await this.#putBackUntil(at, inv, slot, had, count, id, stack.number !== undefined);
      } finally { trace.push(await this.#closeGui()); }
      if (r.inHand < count) throw new Error(`放回 ${r.rounds} 轮还不对: 手上 ${r.inHand} 个 (要 ${count}), 发了 ${r.sent} 次右键`);
      // 手上多的放不回去: 那格被机械臂又装满了 (2026-11-06 注入客户端的程序 存档副本, 取 1 个煤, 箱子一直在进煤)。多拿几个不算错, 回复的 moved 按背包实际算
      if (r.inHand > count) console.error(`  [直接动作] 要 ${count} 个, 手上多 ${r.inHand - count} 个放不回去 (那格满了), 进了背包`);
      return { direct: true, entitySlot: slot, had, putBack: had - r.inHand, extra: r.inHand - count, sent: r.sent, rounds: r.rounds, trace };
    });
  }

  /** ① 状态码 → 名字 */
  override async entityStatus(name: string, at: Pos) {
    const v = await super.entityStatus(name, at);
    if (v.code !== undefined && v.name === undefined) {
      const n = defineName(this.defines, "entity_status", v.code);
      if (n) return { ...v, name: n };
    }
    return v;
  }

  /** ③ 服务器暂停了没有: 两次 tick 一样 = 暂停 */
  async isPaused(): Promise<boolean> {
    const t0 = await this.tick();
    await sleep(PAUSE_PROBE_MS);
    return (await this.tick()) === t0;
  }

  override async status() {
    const s = await super.status();
    if (!s.attached || s.state !== "in_game") return s;
    return { ...s, paused: s.paused === true ? true : await this.isPaused() };
  }

  /** 等客户端再走 n tick (暂停时走不动, 到 capMs 为止) */
  async waitTicks(n: number, capMs = 3_000) {
    const t0 = await this.tick();
    const end = Date.now() + capMs;
    while (Date.now() < end) { if ((await this.tick()) >= t0 + n) return true; await sleep(50); }
    return false;
  }

  /** 发输入前后记 tick (⑤ 用) */
  async #input<T>(f: () => Promise<T>): Promise<T> {
    try { return await f(); } finally { this.lastInputTick = await this.tick().catch(() => this.lastInputTick); }
  }

  /** ④ 键鼠动作前先查暂停 */
  async #unlessPaused(f: () => Promise<Outcome>): Promise<Outcome> {
    const t = Date.now();
    if (await this.isPaused()) return { ok: false, ms: Date.now() - t, error: "游戏暂停中 (服务器), 动作没发; 恢复运行后再发", watchdog: false };
    return this.#input(f);
  }

  override hold(control: string, ticks: number, watchdogMs: number) {
    return this.#unlessPaused(() => super.hold(control, ticks, watchdogMs));
  }

  /** ② 放下手上的东西, 读回核对: 手上少了一个, 或那格出现了这东西 / 虚影 = 放下了; 都没有 = 放不下, 报出那格有什么 */
  override async placeHeld(at: Pos): Promise<Outcome> {
    const before = (await this.player()).cursor;
    const sent = await this.#unlessPaused(() => super.placeHeld(at));
    if (!sent.ok || !before) return sent;
    // 等落地: 联机有网络延迟 (latency 32 tick), 只等 20 tick 时东西放上了还报"放不下", 接着又重放一次 (2026-11-06 注入客户端的程序 存档副本)
    const t0 = await this.tick();
    let after = before as typeof before | null, here: string[] = [], used = false;
    for (;;) {
      await this.waitTicks(SETTLE_TICKS);
      after = (await this.player()).cursor;
      used = !after || after.name !== before.name || after.count < before.count;
      here = (await this.entities({ left_top: { x: at.x - 0.4, y: at.y - 0.4 }, right_bottom: { x: at.x + 0.4, y: at.y + 0.4 } })).list.map((e) => e.name);
      if (used || here.includes(before.name) || here.includes("entity-ghost") || (await this.tick()) - t0 >= 70) break;
    }
    if (used || here.includes(before.name) || here.includes("entity-ghost")) return { ...sent, data: { placed: true, here } };
    return { ...sent, ok: false, error: `放不下: ${before.name} 没放上 (手上还是 ${after?.count ?? 0} 个), 那格是 ${here.length ? here.join("、") : "空的 (可能够不着或被挡)"}`, data: { placed: false, here } };
  }

  // 界面类动作也是输入 (点击会清零空闲计时), 一样记 tick
  override holdItem(item: string) { return this.#input(() => super.holdItem(item)); }
  override clearCursor() { return this.#input(() => super.clearCursor()); }
  override insertExact(at: Pos, item: string, count: number) { return this.#directReady ? this.insertExactDirect(at, item, count) : this.#input(() => super.insertExact(at, item, count)); }
  override takeExact(at: Pos, item: string, count: number) { return this.#directReady ? this.takeExactDirect(at, item, count) : this.#input(() => super.takeExact(at, item, count)); }
  // 这两个走界面、靠按键关窗口, 有网络延迟时会把机器窗口留下; 窗口开着后面的悬停和放东西都选不中, 读回关干净才回 (2026-11-06 注入客户端的程序 存档副本)
  override setRequest(at: Pos, item: string, min: number, max?: number) { return this.#input(async () => { const r = await super.setRequest(at, item, min, max); if (this.#directReady) await this.#closeGui(); return r; }); }
  override setRecipe(at: Pos, recipe: string) { return this.#input(async () => { const r = await super.setRecipe(at, recipe); if (this.#directReady) await this.#closeGui(); return r; }); }
  override importBlueprint(text: string, mode: string) { return this.#input(() => super.importBlueprint(text, mode)); }
  override placeHeldBlueprint(at: Pos) { return this.#input(() => super.placeHeldBlueprint(at)); }
  override pressKey(key: string) { return this.#input(() => super.pressKey(key)); }

  /** ⑤ 我们上次发输入之后, 有没有别人在这个客户端上按过键 / 动过鼠标 (有就该让出) */
  async othersActive(): Promise<{ active: boolean; afk?: number; sinceOurs: number | null }> {
    const p = await this.player();
    const now = await this.tick();
    return { active: othersActed(now, this.lastInputTick, p.afkTime), afk: p.afkTime, sinceOurs: this.lastInputTick === null ? null : now - this.lastInputTick };
  }
}
