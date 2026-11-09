// 注入客户端的程序 (game/client) 包成 IoTarget (io-types.ts), 不加游戏逻辑; 读取和界面动作复用 query.ts / gui.ts (有沙盘真值测试)。
// 行动层 (body.ts) 继承它。没有副作用, 可以 import。
import { GameClient, type CallResult } from "../game/client/connect.ts";
import { Controls } from "./controls.ts";
import { Timeline } from "./timeline.ts";
import { readPlayer, readResearch, readArea, readRequests, readRecipe, type Call } from "./query.ts";
import { clearCursor, openCharacterGui, clickWidget, closeWindows, insertExact, takeExact, setRequest, setRecipe, importBlueprint, placeHeldBlueprint, invSlot, readTree, type ImportMode } from "./gui.ts";
type UiNode = Awaited<ReturnType<typeof readTree>>[number];
import { Unsupported, type IoTarget, type Outcome, type Pos, type Area, type Stack } from "./io-types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 注入客户端的程序 的键鼠时间线中途放弃时不报错, 回 {status: "aborted", reason} (tools.md "Input timelines"; 例: 目标点不在画面里) → 也算没成 */
const outcome = (r: CallResult): Outcome => {
  const d = r.data as { status?: string; reason?: string } | undefined;
  if (r.ok && d?.status === "aborted") return { ok: false, ms: r.ms, error: `中途放弃: ${d.reason ?? "(没给原因)"}`, watchdog: false, data: r.data };
  return { ok: r.ok, ms: r.ms, error: r.error, watchdog: r.error?.startsWith("看门狗") ?? false, data: r.data };
};

export class ClientTarget implements IoTarget {
  readonly mcp: GameClient;
  readonly label: string;
  controls: Controls | null = null;
  /** 诊断: 上一次 holdItem 点完 / 关窗后手上是什么 */
  lastHold: Record<string, unknown> = {};
  readonly call: Call;

  /** exe = 编好的 factorio-ai-client.exe (不给就是 data/client/ 里的) */
  constructor(port: number, exe?: string) {
    this.mcp = new GameClient(port, exe);
    this.label = "注入客户端的程序 (game/client)";
    this.call = (n, a = {}) => this.mcp.call(n, a);
  }

  bytes() { return this.mcp.bytesIn; }
  async start(log?: (s: string) => void) { await this.mcp.start(log); }
  async stop() { await this.mcp.stop(); }

  async #must(name: string, args: Record<string, unknown>, watchdogMs?: number) {
    const r = await this.mcp.call(name, args, watchdogMs);
    if (!r.ok) throw new Error(`${name} 失败: ${(r.error ?? "").slice(0, 300)}`);
    return (r.data ?? {}) as Record<string, any>;
  }

  async status() {
    const d = await this.#must("status", {});
    return { attached: Boolean(d.attached), state: String(d.state), paused: (d.paused ?? null) as boolean | null, raw: d };
  }

  async attach(pid: number) { await this.#must("attach", { pid }); }

  /** 读当前键位 (不写死, 也不用任何人的键位文件) */
  async prepare() {
    const b = await this.#must("input_bindings", { limit: 1024 });
    this.controls = Controls.fromToolResult(b as { controls: [] });
  }

  async detach() { await this.#must("detach", {}); }

  get #c() { if (!this.controls) throw new Error("还没挂上 (没有键位)"); return this.controls; }

  async player() {
    const d = await this.#must("world_query", { selection: { kind: "player" }, fields: ["name", "controller_type", "cursor_stack", "afk_time"] });
    const a = (d.objects?.[0]?.attributes ?? {}) as Record<string, any>;
    const env = (d.player ?? {}) as Record<string, any>;
    const cursor = a.cursor_stack as { valid_for_read?: boolean; name?: string; count?: number } | undefined;
    return {
      name: String(env.name ?? a.name),
      position: (env.physical_position ?? env.position) as Pos,
      controller: a.controller_type,
      cursor: cursor?.valid_for_read ? { name: String(cursor.name), count: Number(cursor.count) } : null,
      afkTime: typeof a.afk_time === "number" ? a.afk_time : undefined,
    };
  }

  async inventorySlots() {
    const out: (Stack | null)[] = [];
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const d = await this.#must("world_query", { selection: { kind: "inventory", owner: { kind: "character" } }, fields: ["name", "count"], limit: 512, offset });
      for (const o of (d.objects ?? []) as Record<string, any>[]) {
        const i = Number(o.index ?? out.length + 1) - 1;
        out[i] = o.valid_for_read ? { name: String(o.attributes?.name ?? o.name), count: Number(o.attributes?.count ?? o.count) } : null;
      }
      if (!d.truncated || d.next_offset === undefined) break;
      offset = d.next_offset;
    }
    return Array.from(out, (s) => s ?? null);
  }

  async quickbar(slots: number[]) {
    const d = await this.#must("world_query", { selection: { kind: "quickbar", slots: slots.map((s) => ({ page_index: 1, slot_index: s })) } });
    // attributes.value = {type, filter / item / record / selection} (tools.md "Quickbar"); 物品名取里面第一个 name
    const nameIn = (v: unknown, depth = 0): string | null => {
      if (!v || typeof v !== "object" || depth > 4) return null;
      const o = v as Record<string, unknown>;
      if (typeof o.name === "string") return o.name;
      for (const c of Object.values(o)) { const n = nameIn(c, depth + 1); if (n) return n; }
      return null;
    };
    const objs = (d.objects ?? []) as Record<string, any>[];
    return slots.map((s) => nameIn(objs.find((o) => Number(o.slot_index ?? o.attributes?.slot_index) === s)?.attributes?.value));
  }

  async entities(area: Area, filter: { type?: string[] } = {}) {
    const r = await readArea(this.call, area, ["name", "position"], 100_000, filter);
    if (r.truncated) throw new Error("区域读取被截断");
    return { list: r.entities.map((e) => ({ name: String(e.name), position: e.position as Pos })), calls: r.calls };
  }

  async entityStatus(name: string, at: Pos) {
    const d = await this.#must("world_query", { selection: { kind: "entities", position: at, name }, fields: ["name", "status"] });
    const st = d.objects?.[0]?.attributes?.status;
    if (st === undefined) throw new Error(`没读到状态: ${JSON.stringify(d.objects?.[0] ?? null).slice(0, 200)}`);
    // 注入客户端的程序 按原样给游戏的值 (数字), 不翻成名字 (他的规矩: 保留原值)
    return typeof st === "number" ? { code: st } : { name: String(st) };
  }

  async power(name: string, at: Pos) {
    const target = { kind: "entities", name, position: at };
    const v = await this.#must("world_query", { selection: { kind: "inspect", target }, fields: ["electric_network_id", "energy"] });
    const a = (v.objects?.[0]?.attributes ?? {}) as Record<string, unknown>;
    const m = await this.#must("world_query", { selection: { kind: "inspect", target, path: [{ method: "is_connected_to_electric_network" }] } });
    const conn = m.objects?.[0]?.value;
    return { connected: typeof conn === "boolean" ? conn : null, networkId: typeof a.electric_network_id === "number" ? a.electric_network_id : null, energy: typeof a.energy === "number" ? a.energy : undefined };
  }

  async evolution(surface: string) {
    // 0.0.11 起上游放行 LuaForce.get_evolution_factor (按星球), 我们分支原来加的阵营字段 enemy_evolution 合并时去掉了
    const b = await this.mcp.call("world_query", { selection: { kind: "inspect", target: { kind: "game" }, path: [{ property: "forces" }, { index: "enemy" }, { method: "get_evolution_factor", arguments: [surface] }] } });
    if (b.ok) { const v = (b.data as any)?.objects?.[0]?.value; if (typeof v === "number") return v; }
    throw new Unsupported(`inspect game.forces.enemy.get_evolution_factor(${surface}): ${(b.error ?? JSON.stringify(b.data)).slice(0, 300)}`);
  }

  async research() { return readResearch(this.call); }

  async tick() {
    const d = await this.#must("world_query", { selection: { kind: "player" }, fields: ["name"] });
    return Number(d.tick);
  }

  async viewArea() {
    // world_overview 不给区域 = 当前画面; 结果里 viewport.area 是画面对应的地图范围 (只要它, 实体取 1 个)
    const d = await this.#must("world_overview", { detail: "entities", entity_limit: 1, fields: ["name"] });
    return (d.viewport?.area ?? null) as Area | null;
  }

  async frame() {
    // 只要帧号: 只回根 (max_depth 0), 不要字段 (0.0.11 去掉了 max_nodes)
    const d = await this.#must("ui_read", { max_depth: 0, fields: [] });
    return Number(d.frame);
  }

  async holdItem(item: string) {
    // 从背包拿起一组: 打开背包、左键物品所在的第一格、关背包 (手上的东西留着)
    const c = this.#c;
    await clearCursor(this.call, c);
    await openCharacterGui(this.call, c);
    {
      // 诊断: 选择器匹配到哪些格子、各自的上级类型
      const all = await readTree(this.call);
      const byId = new Map(all.map((n) => [n.id, n]));
      const chain = (n: UiNode) => { const out: string[] = []; for (let cur: UiNode | undefined = n, d = 0; cur && d < 8; cur = cur.parent !== undefined ? byId.get(cur.parent) : undefined, d++) out.push(`${cur.type}${cur.visible === false ? "(隐)" : ""}`); return out.join("<"); };
      this.lastHold = { slots: all.filter((n) => n.type === "InventoryGuiSlot" && n.properties?.prototype?.name === item).map(chain).slice(0, 4), nodes: all.length };
    }
    await clickWidget(this.call, invSlot(item), "left");
    // 动作只报已发出: 等手上真的有了再关窗口 (最多 2 秒)
    let p = await readPlayer(this.call);
    for (let i = 0; i < 20 && !p.cursor; i++) { await sleep(100); p = await readPlayer(this.call); }
    this.lastHold.afterClick = p.cursor;
    await closeWindows(this.call, c);
    await sleep(200);
    p = await readPlayer(this.call);
    this.lastHold.afterClose = p.cursor;
    return p.cursor ? { name: String(p.cursor.name), count: Number(p.cursor.count) } : null;
  }

  async placeHeld(at: Pos) {
    const t = new Timeline().worldPosition(at, 0, 10).control(this.#c.resolve("build"), 4, 6);
    return outcome(await this.mcp.call("input", { timeline: t.entries }));
  }

  async clearCursor() { await clearCursor(this.call, this.#c); }
  insertExact(at: Pos, item: string, count: number) { return insertExact(this.call, this.#c, at, item, count); }
  takeExact(at: Pos, item: string, count: number) { return takeExact(this.call, this.#c, at, item, count); }
  setRequest(at: Pos, item: string, min: number, max?: number) { return setRequest(this.call, this.#c, at, item, min, max); }
  readRequests(name: string, at: Pos) { return readRequests(this.call, { name, position: at }, "sections"); }
  setRecipe(at: Pos, recipe: string) { return setRecipe(this.call, this.#c, at, recipe); }
  readRecipe(at: Pos) { return readRecipe(this.call, at); }
  importBlueprint(text: string, mode: string) { return importBlueprint(this.call, this.#c, text, mode as ImportMode); }
  importModes(length: number) { return length <= 1024 ? ["set_text", "clipboard"] : ["clipboard"]; }
  placeHeldBlueprint(at: Pos) { return placeHeldBlueprint(this.call, this.#c, at); }

  async hold(control: string, ticks: number, watchdogMs: number) {
    const t = new Timeline().control(this.#c.resolve(control), 0, ticks);
    return outcome(await this.mcp.call("input", { timeline: t.entries }, watchdogMs));
  }

  async pressKey(key: string) { return outcome(await this.mcp.call("ui_action", { action: "press_key", key })); }

  async screenshot(o: { maxHeight: number; quality: number; watchdogMs: number }) {
    const r = await this.mcp.call("screenshot", { max_height: o.maxHeight, quality: o.quality }, o.watchdogMs);
    const d = (r.data ?? {}) as Record<string, any>;
    // 看门狗到点时 SDK 已发取消; 再显式取消一次截图 (他的规矩: 截图只许一个在排队, 卡住的要明确取消)
    if (!r.ok && r.error?.startsWith("看门狗")) await this.mcp.call("screenshot", { action: "cancel" }, 10_000).catch(() => undefined);
    return { ...outcome(r), bytes: r.bytes, width: d.width, height: d.height };
  }

  async setRendering(enabled: boolean) { return outcome(await this.mcp.call("set_rendering", { enabled })); }
  async chatSend(text: string) { return outcome(await this.mcp.call("chat_send", { text })); }
  /** 自己客户端保留的聊天 (真人说话从这里读, core/run/human-chat.ts): {messages, next_offset, has_more, history_lost} */
  async chatRead(args: Record<string, unknown>) { return outcome(await this.mcp.call("chat_read", args)); }

  async chatWait(timeoutS: number, watchdogMs: number) {
    const head = await this.#must("chat_read", { limit: 1 });
    return outcome(await this.mcp.call("chat_read", { offset: head.next_offset, timeout: timeoutS, limit: 8 }, watchdogMs));
  }

  async probe(watchdogMs: number) {
    return outcome(await this.mcp.call("world_query", { selection: { kind: "player" }, fields: ["name"] }, watchdogMs));
  }
}
