// 监工 (库, 不直接运行; online.ts 每 30 秒 tick 一次): 只给事实, 不替模型做决定。
// 做的事: ① 采样 (产量、研究、研究中心、建筑数、角色位置) 记 monitor.jsonl; ② 闲了就催 (没动作、没走; 开局宽限; 同一角色隔一段才再催);
// ③ 体检每 5 分钟 (health.ts), 新出现的和一直没修的递给模型; ④ 研究队列空了告诉它能排什么 (research.ts); ⑤ 每 30 分钟播报产量; ⑥ 截止前 10 分钟和 3 分钟提醒 (睡觉不算玩);
// ⑦ 模型在 journal 里写的"工具诉求"记进 tool-requests.md。话都经 tell.ts 递 (模组账本 tell → 下一条回复; 能叫醒 sleep)。
// 旧项目的做法: 派对 tools/idle_nudge.py (站 10 分钟才提醒, 隔 20 分钟); 我们这条路动作慢, 闲 5 分钟 (出生点 3 分钟) 就说, 隔 15 分钟。
import fs from "node:fs";
import path from "node:path";
import { HEALTH_LUA, healthLines, normalizeHealth, StuckHealth, type Health } from "./health.ts";
import { hintLine } from "./hints.ts";
import { RESEARCH_LUA, normalizeResearch, researchIdleText } from "./research.ts";
import { ratesFrom, ratesLine, type RateRow } from "./science.ts";

/** 一次采样 (游戏外的假接口读; 读不到的当 0) */
export const SAMPLE_LUA = `local s = game.surfaces[1] local f = game.forces.player
local st = f.get_item_production_statistics(s)
local labs, working = 0, 0 for _, l in pairs(s.find_entities_filtered{type = "lab", force = f}) do labs = labs + 1 if l.status == defines.entity_status.working then working = working + 1 end end
local n = 0 for _, t in pairs(f.technologies) do if t.researched then n = n + 1 end end
return {tick = game.tick, redTotal = st.get_input_count("automation-science-pack"), greenTotal = st.get_input_count("logistic-science-pack"), blueTotal = st.get_input_count("chemical-science-pack"),
  labs = labs, labsWorking = working, research = f.current_research and f.current_research.name or "", researched = n,
  entities = s.count_entities_filtered{force = f}, machines = s.count_entities_filtered{force = f, type = {"assembling-machine", "furnace", "mining-drill", "lab", "rocket-silo"}}}`;

export type Sample = RateRow & { t: number; labs: number; labsWorking: number; research: string; researched: number; entities: number; machines: number; pos: { x: number; y: number } | null; idle: boolean };
const nz = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 动作类请求 (做了就不算闲); 查看和 sleep 不算 */
export const ACTIONS = new Set(["move_to", "build", "transfer", "craft", "mine", "rotate", "research", "build_path", "collect", "refuel", "feed", "shoot", "say"]);

/** journal 里最近一次动作类请求的时间 (毫秒); 没有就 null。只读文件尾 (整班的 journal 会很大) */
export function lastActionAt(journal: string, bytes = 400_000): number | null {
  try {
    const size = fs.statSync(journal).size, len = Math.min(size, bytes);
    const b = Buffer.alloc(len), fd = fs.openSync(journal, "r");
    try { fs.readSync(fd, b, 0, len, size - len); } finally { fs.closeSync(fd); }
    let last: number | null = null;
    for (const line of b.toString("utf8").split(/\r?\n/)) {
      if (!line.includes('"event":"request"')) continue;
      try { const o = JSON.parse(line); if (ACTIONS.has(String(o.request?.action))) { const t = Date.parse(o.at); if (Number.isFinite(t)) last = t; } } catch { /* 半行 */ }
    }
    return last;
  } catch { return null; }
}

/** 模型在 journal 里向管理员提的工具诉求 (operator 请求, 正文以"工具诉求"开头) */
export function toolRequests(lines: string[]): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  for (const line of lines) {
    if (!line.includes("工具诉求")) continue;
    let e: { at?: string; event?: string; request?: { action?: string; args?: { text?: unknown } } };
    try { e = JSON.parse(line); } catch { continue; }
    const t = e.request?.args?.text;
    if (e.event === "request" && e.request?.action === "operator" && typeof t === "string" && t.startsWith("工具诉求")) out.push({ at: e.at ?? "", text: t });
  }
  return out;
}

export type IdleOpts = { idleMs: number; spawnIdleMs: number; graceMs: number; everyMs: number };
export const DEFAULT_IDLE: IdleOpts = { idleMs: 5 * 60_000, spawnIdleMs: 3 * 60_000, graceMs: 3 * 60_000, everyMs: 15 * 60_000 };
/** 闲了该不该催 (纯函数): idleSince = 开始闲的时间, now, 开班时间 t0, 上次催的时间; 在出生点附近门槛更低 */
export function idleVerdict(o: { idleSince: number | null; now: number; t0: number; lastNudge: number; atSpawn: boolean; opts?: IdleOpts }): { nudge: boolean; idleMin: number } {
  const opts = o.opts ?? DEFAULT_IDLE;
  if (o.idleSince === null) return { nudge: false, idleMin: 0 };
  const idleMs = o.now - o.idleSince;
  const idleMin = Math.round(idleMs / 60_000);
  if (o.now - o.t0 < opts.graceMs) return { nudge: false, idleMin };
  if (idleMs < (o.atSpawn ? opts.spawnIdleMs : opts.idleMs)) return { nudge: false, idleMin };
  if (o.now - o.lastNudge < opts.everyMs) return { nudge: false, idleMin };
  return { nudge: true, idleMin };
}

/** 截止前的提醒: 10 分钟和 3 分钟各一次 */
export function deadlineNudge(leftMs: number, said: Set<number>): number | null {
  for (const m of [10, 3]) if (leftMs <= m * 60_000 && leftMs > 0 && !said.has(m)) { said.add(m); return m; }
  return null;
}

export type SupervisorDeps = {
  evalLua: (code: string) => Promise<unknown>;
  player: () => Promise<{ x: number; y: number; hasCharacter: boolean } | null>;
  tell: (text: string) => Promise<unknown>;
  journal: string; runDir: string; t0: number; deadline: number;
  zh: (n: string) => string; log: (s: string) => void; points: string;
  /** 上一班的平均产量 (接存档时), 播报时比 */ prevRates?: ReturnType<typeof ratesFrom>;
  idle?: Partial<IdleOpts>;
};

export class Supervisor {
  readonly samples: Sample[] = [];
  readonly stats = { nudges: 0, healthTells: 0, researchTells: 0, rateTells: 0, deadlineTells: 0, toolRequests: 0, toolTells: 0 };
  private lastToolTell = 0;
  private d: SupervisorDeps;
  private idleOpts: IdleOpts;
  private idleSince: number | null = null;
  private lastNudge = -Infinity;
  private lastPos: { x: number; y: number } | null = null;
  private lastHealthAt = 0;
  private lastHealthCats = new Set<string>();
  private stuck = new StuckHealth(3, 15 * 60_000);
  private researchIdleSamples = 0;
  private lastResearchTell = -Infinity;
  private lastRateTell: number;
  private deadlineSaid = new Set<number>();
  private journalOff = { off: 0 };
  private busy = false;
  constructor(d: SupervisorDeps) { this.d = d; this.idleOpts = { ...DEFAULT_IDLE, ...(d.idle ?? {}) }; this.lastRateTell = d.t0; }

  /** 每 30 秒一次; 出错不抛 (记日志), 下次接着来 */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await this.#tick(now); } catch (e) { this.d.log(`监工出错: ${(e as Error).message.slice(0, 160)}`); } finally { this.busy = false; }
  }

  async #tick(now: number): Promise<void> {
    const d = this.d;
    // ① 采样
    const raw = (await d.evalLua(SAMPLE_LUA).catch(() => null)) as Partial<Sample> | null;
    const p = await d.player().catch(() => null);
    const pos = p ? { x: p.x, y: p.y } : null;
    const moved = !!pos && !!this.lastPos && Math.hypot(pos.x - this.lastPos.x, pos.y - this.lastPos.y) > 0.5;
    const lastAct = lastActionAt(d.journal);
    const acted = lastAct !== null && now - lastAct < 60_000;
    const idle = !moved && !acted && !!p?.hasCharacter;
    if (idle) this.idleSince ??= now; else this.idleSince = null;
    this.lastPos = pos;
    const s: Sample = { t: now, tick: nz(raw?.tick), redTotal: nz(raw?.redTotal), greenTotal: nz(raw?.greenTotal), blueTotal: nz(raw?.blueTotal), labs: nz(raw?.labs), labsWorking: nz(raw?.labsWorking), research: String(raw?.research ?? ""), researched: nz(raw?.researched), entities: nz(raw?.entities), machines: nz(raw?.machines), pos, idle };
    this.samples.push(s);
    fs.appendFileSync(path.join(d.runDir, "monitor.jsonl"), JSON.stringify(s) + "\n");
    // ② 闲了就催
    const atSpawn = !!pos && Math.hypot(pos.x, pos.y) < 12;
    const v = idleVerdict({ idleSince: this.idleSince, now, t0: d.t0, lastNudge: this.lastNudge, atSpawn, opts: this.idleOpts });
    if (v.nudge) {
      this.lastNudge = now; this.stats.nudges++;
      const msg = `监工 (只给事实): 你的角色已经闲了约 ${v.idleMin} 分钟 (没发动作、没走)。思考时角色站着不动, 时钟不停; 睡觉不算玩。${atSpawn ? " 你还在出生点附近, 矿不在这里: ./fh call nearest 找矿, 走过去再动手。" : ""}${this.#hint(["闲了"])}`;
      await d.tell(msg);
      d.log(`监工: 闲了 ${v.idleMin} 分钟, 催了`);
    }
    // ②b 开班 8 分钟后还没有机器做出过红瓶: 把能一条命令建整条线的工具递上 (只给事实和命令; 第二版四班都手放到底, 简报里写着没人用); 10 分钟一次
    if (s.redTotal === 0 && now - d.t0 >= 8 * 60_000 && now - this.lastToolTell >= 10 * 60_000) {
      this.lastToolTell = now; this.stats.toolTells++;
      await d.tell(`监工 (只给事实): 开班 ${Math.round((now - d.t0) / 60_000)} 分钟, 场上机器 ${s.machines} 台, 机器做出的红瓶 0。一条命令建整条红瓶线 (算全链 → 挑蓝图块 → 找空地 → 备料 → 放): ./plan automation-science-pack 30 --build; 只看方案: ./plan automation-science-pack 30; 库里的块: ./bp list 冶炼 / ./bp list 组装。手放也行, 工具只是省步数。`);
      d.log("监工: 红瓶还是 0, 递了 ./plan");
    }
    // ③ 体检: 每 5 分钟; 新出现的类别马上说, 一直没修的 (连 3 次) 隔 15 分钟点名
    if (now - this.lastHealthAt >= 5 * 60_000) {
      this.lastHealthAt = now;
      const h = normalizeHealth(((await d.evalLua(HEALTH_LUA).catch(() => null)) ?? { tick: 0 }) as Health);
      const lines = healthLines(h, [], d.zh);
      fs.appendFileSync(path.join(d.runDir, "health.jsonl"), JSON.stringify({ at: new Date(now).toISOString(), tick: h.tick, lines }) + "\n");
      const cats = new Set(lines.map((l) => l.split(/[\s:：(（]/)[0]));
      const fresh = lines.filter((l) => !this.lastHealthCats.has(l.split(/[\s:：(（]/)[0]));
      const stuck = this.stuck.update(lines, now).filter((x) => !fresh.includes(x.line));
      this.lastHealthCats = cats;
      const say = [...fresh, ...stuck.map((x) => `${x.line} (连续 ${x.times} 次体检都在)`)];
      if (say.length) {
        this.stats.healthTells++;
        await d.tell(`监工 (只给事实, 体检): ${say.join("; ")}${this.#hint(say)}`);
        d.log(`监工 (体检): ${say.join("; ").slice(0, 200)}`);
      }
    }
    // ④ 研究队列空了 (连 2 次采样 = 1 分钟; 有研究中心才说; 10 分钟一次)
    this.researchIdleSamples = s.research ? 0 : this.researchIdleSamples + 1;
    if (s.labs > 0 && this.researchIdleSamples >= 2 && now - this.lastResearchTell >= 10 * 60_000) {
      this.lastResearchTell = now;
      const st = normalizeResearch(await d.evalLua(RESEARCH_LUA).catch(() => null));
      if (!st.current && st.queue === 0) {
        this.stats.researchTells++;
        const msg = `监工 (只给事实): ${researchIdleText(st, d.zh)}`;
        await d.tell(msg);
        d.log(`监工 (研究): ${msg.slice(0, 160)}`);
      }
    }
    // ⑤ 每 30 分钟播报产量 (开班 10 分钟后才有读数)
    if (now - this.lastRateTell >= 30 * 60_000 && this.samples.length >= 2) {
      this.lastRateTell = now;
      const win = this.samples.filter((x) => x.t >= now - 10 * 60_000);
      const r = ratesFrom(win.length >= 2 ? win : this.samples, 1);
      if (r) {
        this.stats.rateTells++;
        await d.tell(`监工 (只给事实): ${ratesLine(r, d.prevRates ?? null)}; 研究中心 ${s.labsWorking}/${s.labs} 在工作, 当前研究 ${s.research ? d.zh(s.research) : "无"}, 已研究 ${s.researched} 项; 我方建筑 ${s.entities} 件。`);
      }
    }
    // ⑥ 截止前提醒
    const left = deadlineNudge(d.deadline - now, this.deadlineSaid);
    if (left !== null) {
      this.stats.deadlineTells++;
      await d.tell(left === 10 ? "监工: 还有 10 分钟到截止。把 notes.md 更新好 (坐标、教训、下一班先做什么), 剩下的时间接着干活: 补燃料、把能放的放下; 睡觉不算玩。" : "监工: 还有 3 分钟到截止。现在写最后的总结到 notes.md, 别开新的长动作。");
    }
    // ⑦ 工具诉求
    const fresh = readNew(d.journal, this.journalOff);
    for (const r of toolRequests(fresh)) {
      this.stats.toolRequests++;
      fs.appendFileSync(path.join(d.runDir, "tool-requests.md"), `- ${r.at}: ${r.text}\n`);
      d.log(`工具诉求: ${r.text.slice(0, 200)}`);
    }
  }

  #hint(lines: string[]): string {
    const h = hintLine(this.d.points, lines, 1);
    return h ? ` ${h}` : "";
  }
}

/** 文件新增的整行 (st.off 记读到哪) */
function readNew(file: string, st: { off: number }): string[] {
  try {
    const size = fs.statSync(file).size;
    if (size < st.off) st.off = 0;
    if (size === st.off) return [];
    const b = Buffer.alloc(Math.min(size - st.off, 8_000_000));
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, b, 0, b.length, st.off); } finally { fs.closeSync(fd); }
    const text = b.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return [];
    st.off += Buffer.byteLength(text.slice(0, end + 1));
    return text.slice(0, end).split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}
