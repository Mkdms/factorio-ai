// 不装模组那条路的队列和常驻命令 (库, 不直接运行; commands/broker.ts 用)。
// 装模组的路上这两样是模组在游戏里替角色干的 (scheduler.lua / orders.lua); 这条路上游戏里没有模组, 所以由游戏外的代理照手册的规则做 (training/manuals/ref/waits-queues.md):
//   队列: queue_submit {steps [{action, args, label?, on_fail?: abort|skip}], mode?: append|replace} 按顺序一步步跑; on_fail abort (默认) 暂停, skip 接着跑;
//         queue_status / queue_cancel / queue_pause / queue_resume; queue_repeat {steps, interval_ticks?, times?} 一轮轮重复
//   常驻命令: order_set {name, steps, when?, priority?, interval_ticks?, cooldown_ticks?, max_walk?} 最多 6 条 × 32 步; when 成立就跑 (优先级高的先),
//         跑完冷却 cooldown_ticks (默认 600); 没有 when 的是默认例行, 没有条件成立时每 interval_ticks 跑一次; 连败 3 次关掉; orders / order_remove / orders_pause / orders_resume
//   什么时候跑: 角色空着 (模型最后一个自己的动作之后 20 秒) 才跑; 模型一动手, 跑完手上这一步就让出来 (模组是立刻停, 这里一步最多 60 秒)
//   when 这条路认的条件 (参数名照模组): fuel_below / ammo_below {count, position+radius | area | positions}、item_count {item, at_least | below, positions?}、
//         ghosts_waiting {position?, radius?}、damaged {fraction?, position?, radius?}、health_below / health_above {fraction}、no_enemies {position?, radius?};
//         别的条件 (平台、火箭、研究…) 单子照收, 状态写明这条路不认, 不会触发
type Pos = { x: number; y: number };
export type Step = { action: string; args?: Record<string, unknown>; label?: string; on_fail?: string };
export type StepResult = { ok: boolean; error?: string };
export type When = Record<string, unknown> & { until?: string };
type Order = { name: string; steps: Step[]; when?: When; priority: number; intervalTicks: number; cooldownTicks: number; maxWalk?: number; off: boolean; paused: boolean; runs: number; failures: number; failStreak: number; lastRunTick: number | null; lastResult?: string; state?: string };
type Hist = { action: string; label?: string; ok: boolean; error?: string; tick: number; by: string };

export const ORDER_CALLS = new Set(["queue_submit", "queue_status", "queue_cancel", "queue_pause", "queue_resume", "queue_repeat", "queue_edit", "order_set", "orders", "order_remove", "orders_pause", "orders_resume"]);
const CONDS = new Set(["fuel_below", "ammo_below", "item_count", "ghosts_waiting", "damaged", "health_below", "health_above", "no_enemies"]);
export const IDLE_MS = 20_000;
const MAX_ORDERS = 6, MAX_ORDER_STEPS = 32, MAX_QUEUE = 128;

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const posOf = (v: unknown): Pos | null => { const p = v as Partial<Pos> | undefined; return typeof p?.x === "number" && typeof p?.y === "number" ? { x: p.x, y: p.y } : null; };
const lua = (v: unknown): string => JSON.stringify(v).replace(/\[/g, "{").replace(/\]/g, "}").replace(/"([a-z_]+)":/g, "$1=");

/** 条件 → 一段只读 Lua (游戏外的模组宿主上跑, broker.evalLua): 回 {holds, saw}。不认的条件回 null */
export function condLua(w: When): string | null {
  const u = String(w.until ?? "");
  if (!CONDS.has(u)) return null;
  const pos = posOf(w.position), area = w.area as { left_top?: unknown; right_bottom?: unknown } | undefined;
  const lt = posOf(area?.left_top), rb = posOf(area?.right_bottom);
  const positions = Array.isArray(w.positions) ? (w.positions as unknown[]).map(posOf).filter((p): p is Pos => !!p).slice(0, 16) : [];
  const radius = Math.min(num(w.radius, 32), 256);
  // 找实体的范围: positions (每处 0.6 格) > area > position + radius > 角色周围 radius
  const find = (filter: string) => positions.length
    ? `local list = {} for _, q in ipairs(${lua(positions)}) do for _, e in pairs(s.find_entities_filtered{position = q, radius = 0.6, force = f, ${filter}}) do list[#list + 1] = e end end`
    : lt && rb ? `local list = s.find_entities_filtered{area = {${lua(lt)}, ${lua(rb)}}, force = f, ${filter}}`
    : `local c = ${pos ? lua(pos) : "me.position"} local list = s.find_entities_filtered{position = c, radius = ${radius}, force = f, ${filter}}`;
  const head = `local s = game.surfaces[1] local f = game.forces.player local me = (game.connected_players and game.connected_players[1]) or player`;
  const at = `local function at(e) return string.format("(%g,%g)", e.position.x, e.position.y) end`;
  switch (u) {
    case "fuel_below": case "ammo_below": {
      const n = num(w.count, u === "fuel_below" ? 5 : 10);
      const filter = u === "fuel_below" ? `type = {"mining-drill", "furnace", "boiler", "inserter", "reactor"}` : `type = "ammo-turret"`;
      const inv = u === "fuel_below" ? "e.get_fuel_inventory and e.get_fuel_inventory()" : "e.get_inventory(defines.inventory.turret_ammo)";
      return `${head} ${at} ${find(filter)} local low = {} for _, e in ipairs(list) do local ok, inv = pcall(function() return ${inv} end) if ok and inv then local c = inv.get_item_count() if c < ${n} then low[#low + 1] = e.name .. at(e) .. " " .. c end end end return {holds = #low > 0, saw = #low > 0 and (#low .. " 处低于 ${n}: " .. table.concat(low, "、", 1, math.min(#low, 3))) or (#list .. " 处都不低于 ${n}")}`;
    }
    case "item_count": {
      const item = String(w.item ?? "");
      const cmp = typeof w.at_least === "number" ? `c >= ${w.at_least}` : typeof w.below === "number" ? `c < ${w.below}` : "c > 0";
      const count = positions.length
        ? `local c = 0 for _, q in ipairs(${lua(positions)}) do for _, e in pairs(s.find_entities_filtered{position = q, radius = 0.6, force = f}) do local ok, n = pcall(function() return e.get_item_count(${JSON.stringify(item)}) end) if ok and n then c = c + n end end end`
        : `local inv = me.get_main_inventory and me.get_main_inventory() local c = inv and inv.get_item_count(${JSON.stringify(item)}) or 0`;
      return `${head} ${count} return {holds = ${cmp}, saw = ${JSON.stringify(item)} .. " " .. c}`;
    }
    case "ghosts_waiting":
      return `${head} ${at} ${find(`type = "entity-ghost"`)} return {holds = #list > 0, saw = #list .. " 个虚影"}`;
    case "damaged": {
      const fr = num(w.fraction, 1);
      return `${head} ${at} ${find(`type = {"assembling-machine", "furnace", "mining-drill", "lab", "boiler", "generator", "inserter", "transport-belt", "ammo-turret", "electric-turret", "wall", "gate", "container", "electric-pole", "pipe", "offshore-pump", "radar"}`)} local hurt = {} for _, e in ipairs(list) do local ok, h, m = pcall(function() return e.health, e.max_health end) if ok and h and m and m > 0 and h < m * ${fr} then hurt[#hurt + 1] = e.name .. at(e) end end return {holds = #hurt > 0, saw = #hurt .. " 处受损"}`;
    }
    case "health_below": case "health_above": {
      const fr = num(w.fraction, u === "health_below" ? 0.5 : 0.9);
      return `${head} local ch = me.character local h = ch and ch.health or 0 local m = ch and ch.max_health or 250 local r = m > 0 and h / m or 0 return {holds = ${u === "health_below" ? `r < ${fr}` : `r > ${fr}`}, saw = string.format("血量 %.0f%%", r * 100)}`;
    }
    case "no_enemies":
      return `${head} local c = ${pos ? lua(pos) : "me.position"} local n = s.count_entities_filtered{position = c, radius = ${radius}, force = "enemy", type = "unit"} return {holds = n == 0, saw = n .. " 只敌人"}`;
  }
  return null;
}

export type SchedulerDeps = {
  /** 跑一步 (和模型发的同一条路: 行动层或游戏外的模组); 回成没成 */
  run: (step: Step) => Promise<StepResult>;
  /** 游戏外的模组宿主上跑一段只读 Lua (broker.evalLua) */
  evalLua: (code: string) => Promise<unknown>;
  tick: () => Promise<number>;
  /** 模型最后一个自己的动作 (不算这里跑的) 是什么时候; 正在做动作时回 Infinity 之外的"现在" */
  lastOwnAction: () => number;
  /** 角色在哪 (max_walk 用); 读不到 null */
  where?: () => Promise<Pos | null>;
  now?: () => number;
};

/** 队列 + 常驻命令: 回复照模组的形状 (result 里的字段名照手册) */
export class Scheduler {
  private pending: Step[] = [];
  private paused = false;
  private repeat: { steps: Step[]; intervalTicks: number; timesLeft: number | null; nextTick: number } | null = null;
  private history: Hist[] = [];
  private orders = new Map<string, Order>();
  private running: { by: string; step: Step } | null = null;
  private orderRun: { name: string; steps: Step[] } | null = null;
  private lastEval = 0;
  private busy = false;
  private readonly d: SchedulerDeps;
  constructor(d: SchedulerDeps) { this.d = d; }
  private now() { return (this.d.now ?? Date.now)(); }

  /** 模型的队列 / 常驻命令请求 → 结果 (抛错 = 参数不对, 代理回 action_failed) */
  async call(action: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (action) {
      case "queue_submit": {
        const steps = this.steps(a.steps, MAX_QUEUE, "queue_submit");
        if (a.dry_run === true) return { dry_run: true, steps: steps.length, note: "这条路上不预演每一步, 只核了格式" };
        if (a.mode === "replace") { this.pending = []; this.repeat = null; }
        this.pending.push(...steps);
        if (a.start !== false) this.paused = false; else this.paused = true;
        return this.queueState();
      }
      case "queue_repeat": {
        const steps = this.steps(a.steps, MAX_QUEUE, "queue_repeat");
        this.pending = [...steps];
        this.repeat = { steps, intervalTicks: Math.max(60, num(a.interval_ticks, 600)), timesLeft: typeof a.times === "number" ? Math.max(1, a.times) - 1 : null, nextTick: 0 };
        this.paused = false;
        return this.queueState();
      }
      case "queue_status": return { ...this.queueState(), pending: this.pending.slice(0, a.pending === "all" ? MAX_QUEUE : 5).map((s) => ({ action: s.action, label: s.label })), history: this.history.slice(-(a.history === "all" ? 64 : 16)) };
      case "queue_cancel": { const n = this.pending.length; this.pending = []; this.repeat = null; return { cancelled: n, ...this.queueState() }; }
      case "queue_pause": this.paused = true; return this.queueState();
      case "queue_resume": this.paused = false; return this.queueState();
      case "queue_edit": throw new Error("这条路上 queue_edit 还不支持: 用 queue_submit {mode: replace} 换掉整个队列");
      case "order_set": return this.orderSet(a);
      case "orders": await this.evaluate(true); return { orders: [...this.orders.values()].map((o) => this.orderLine(o)) };
      case "order_remove": { const name = String(a.name ?? ""); if (!this.orders.delete(name)) throw new Error(`没有这条常驻命令: ${name}`); return { removed: name }; }
      case "orders_pause": case "orders_resume": {
        const on = action === "orders_resume";
        const list = typeof a.name === "string" ? [this.orders.get(a.name)].filter((o): o is Order => !!o) : [...this.orders.values()];
        for (const o of list) { o.paused = !on; if (on) { o.off = false; o.failStreak = 0; } }
        return { orders: list.map((o) => this.orderLine(o)) };
      }
    }
    throw new Error(`不认识 ${action}`);
  }

  private steps(v: unknown, max: number, who: string): Step[] {
    if (!Array.isArray(v) || !v.length) throw new Error(`${who} 要 steps: [{action, args, label?, on_fail?}] (1..${max} 步)`);
    if (v.length > max) throw new Error(`${who} 最多 ${max} 步 (给了 ${v.length})`);
    return v.map((s, i) => {
      const st = s as Step;
      if (!st || typeof st.action !== "string" || !st.action) throw new Error(`${who} 第 ${i + 1} 步要 action`);
      if (ORDER_CALLS.has(st.action)) throw new Error(`${who} 第 ${i + 1} 步不能再是队列命令 (${st.action})`);
      return { action: st.action, args: (st.args ?? {}) as Record<string, unknown>, ...(st.label ? { label: String(st.label) } : {}), ...(st.on_fail ? { on_fail: String(st.on_fail) } : {}) };
    });
  }

  private queueState() {
    return { state: this.paused ? "paused, held until queue_resume" : this.pending.length || this.running ? "running" : "empty", pending_count: this.pending.length, ...(this.running ? { active: { action: this.running.step.action, label: this.running.step.label, by: this.running.by } } : {}), ...(this.repeat ? { repeating: { interval_ticks: this.repeat.intervalTicks, times_left: this.repeat.timesLeft } } : {}) };
  }

  private orderSet(a: Record<string, unknown>) {
    const name = String(a.name ?? "");
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error("name: 1..32 letters, digits, - or _");
    const steps = this.steps(a.steps, MAX_ORDER_STEPS, "order_set");
    if (!this.orders.has(name) && this.orders.size >= MAX_ORDERS) throw new Error(`最多 ${MAX_ORDERS} 条常驻命令: 先 order_remove 一条`);
    const when = a.when && typeof a.when === "object" ? (a.when as When) : undefined;
    if (!when && [...this.orders.values()].some((o) => !o.when && o.name !== name)) throw new Error("没有 when 的默认例行只能有一条");
    const o: Order = { name, steps, when, priority: Math.min(9, Math.max(1, num(a.priority, 5))), intervalTicks: Math.min(216000, Math.max(60, num(a.interval_ticks, 3600))), cooldownTicks: Math.min(216000, Math.max(300, num(a.cooldown_ticks, 600))),
      ...(typeof a.max_walk === "number" ? { maxWalk: a.max_walk } : {}), off: false, paused: false, runs: 0, failures: 0, failStreak: 0, lastRunTick: null };
    this.orders.set(name, o);
    return { order: this.orderLine(o), ...(when && !condLua(when) ? { warning: `这条路认的条件只有 ${[...CONDS].join("、")}: ${String(when.until)} 不会触发` } : {}) };
  }

  private orderLine(o: Order) {
    return { name: o.name, state: o.off ? "off (连败 3 次)" : o.paused ? "paused" : o.state ?? "ready", priority: o.priority, steps: o.steps.length, runs: o.runs, failures: o.failures, last: o.lastResult ?? null, ...(o.when ? { when: o.when } : { interval_ticks: o.intervalTicks }) };
  }

  /** 每条常驻命令的条件现在成不成立 (最多 10 秒算一次; force = 马上算) */
  private async evaluate(force = false): Promise<Order | null> {
    if (!force && this.now() - this.lastEval < 10_000) return null;
    this.lastEval = this.now();
    const tick = await this.d.tick();
    const me = this.d.where ? await this.d.where().catch(() => null) : null;
    let best: Order | null = null;
    for (const o of this.orders.values()) {
      if (o.off || o.paused) continue;
      if (o.lastRunTick !== null && o.when && tick - o.lastRunTick < o.cooldownTicks) { o.state = `cooling ${Math.ceil((o.cooldownTicks - (tick - o.lastRunTick)) / 60)} s`; continue; }
      const place = posOf(o.steps[0]?.args?.position) ?? posOf(o.when?.position);
      if (o.maxWalk !== undefined && place && me && Math.hypot(place.x - me.x, place.y - me.y) > o.maxWalk) { o.state = `waits: ${Math.round(Math.hypot(place.x - me.x, place.y - me.y))} tiles off (max_walk ${o.maxWalk})`; continue; }
      if (!o.when) { o.state = o.lastRunTick === null || tick - o.lastRunTick >= o.intervalTicks ? "ready" : `next in ${Math.ceil((o.intervalTicks - (tick - o.lastRunTick)) / 60)} s`; continue; }
      const code = condLua(o.when);
      if (!code) { o.state = `这条路不认条件 ${String(o.when.until)}`; continue; }
      try {
        const r = (await this.d.evalLua(code)) as { holds?: boolean; saw?: string };
        o.state = r.holds ? `holds (${r.saw ?? ""})` : `not holding (${r.saw ?? ""})`;
        if (r.holds && (!best || o.priority > best.priority)) best = o;
      } catch (e) { o.state = `条件读不到: ${(e as Error).message.slice(0, 80)}`; }
    }
    if (best) return best;
    const routine = [...this.orders.values()].find((o) => !o.when && !o.off && !o.paused && o.state === "ready");
    return routine ?? null;
  }

  /** 代理定时叫 (几秒一次): 角色空着才干一步 */
  async step(): Promise<void> {
    if (this.busy) return;
    if (this.now() - this.d.lastOwnAction() < IDLE_MS) return;
    this.busy = true;
    try {
      // ① 模型自己的队列
      if (!this.paused && !this.pending.length && this.repeat && (this.repeat.timesLeft === null || this.repeat.timesLeft > 0)) {
        const tick = await this.d.tick();
        if (tick >= this.repeat.nextTick) { this.pending = [...this.repeat.steps]; if (this.repeat.timesLeft !== null) this.repeat.timesLeft--; }
      }
      if (!this.paused && this.pending.length) {
        const s = this.pending.shift()!;
        const ok = await this.exec(s, "queue");
        if (!ok && (s.on_fail ?? "abort") !== "skip") this.paused = true;
        if (!this.pending.length && this.repeat) this.repeat.nextTick = (await this.d.tick()) + this.repeat.intervalTicks;
        return;
      }
      // ② 常驻命令: 正在跑的一条接着跑; 没有就挑条件成立的 (或到点的默认例行)
      if (!this.orderRun) {
        const o = await this.evaluate();
        if (!o) return;
        this.orderRun = { name: o.name, steps: [...o.steps] };
      }
      const run = this.orderRun, o = this.orders.get(run.name);
      if (!o) { this.orderRun = null; return; }
      const s = run.steps.shift()!;
      const ok = await this.exec(s, `order ${o.name}`);
      if (!ok && (s.on_fail ?? "abort") !== "skip") { this.finish(o, false); return; }
      if (!run.steps.length) this.finish(o, true);
    } finally { this.busy = false; }
  }

  private finish(o: Order, ok: boolean) {
    this.orderRun = null;
    void this.d.tick().then((t) => { o.lastRunTick = t; }).catch(() => undefined);
    o.runs++;
    if (ok) { o.failStreak = 0; o.lastResult = "ok"; }
    else { o.failures++; o.failStreak++; if (o.failStreak >= 3) o.off = true; }
  }

  private async exec(s: Step, by: string): Promise<boolean> {
    this.running = { by, step: s };
    let r: StepResult;
    try { r = await this.d.run(s); } catch (e) { r = { ok: false, error: (e as Error).message }; }
    this.running = null;
    const tick = await this.d.tick().catch(() => 0);
    this.history.push({ action: s.action, ...(s.label ? { label: s.label } : {}), ok: r.ok, ...(r.error ? { error: r.error.slice(0, 200) } : {}), tick, by });
    if (this.history.length > 64) this.history.splice(0, this.history.length - 64);
    if (!r.ok && by.startsWith("order ")) { const o = this.orders.get(by.slice(6)); if (o) o.lastResult = `failed: ${(r.error ?? "").slice(0, 120)}`; }
    return r.ok;
  }
}
