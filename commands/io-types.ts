// M4 完整测试集 (旧项目 docs/io-client.md 第 11 节) 的公共部分: 被测接口的约定、比对、出表。没有副作用, 可以 import。
// 两边各实现一份 IoTarget: 注入客户端的程序本身 (client-target.ts) 和包在它外面的行动层 (body.ts)。
// 规矩 (第 9b 节): 动作只报"已发出", 结果由测试等过服务器延迟后用沙盘真值 (RCON) 核对; 接口做不到的报 Unsupported, 不编结果。
import { encodeBlueprint } from "../game/blueprint.ts";

/** T10: 编码后至少 target 字的蓝图: 一片传送带 (每行 100 段), 方向按固定种子打乱 (太规则的压缩得太小)。搬自 actions.ts */
export function makeBlueprint(target: number) {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const entities: Record<string, unknown>[] = [];
  const side = 100;
  for (let n = 1; ; n++) {
    entities.push({ entity_number: n, name: "transport-belt", position: { x: ((n - 1) % side) + 0.5, y: Math.floor((n - 1) / side) + 0.5 }, direction: [0, 4, 8, 12][Math.floor(rnd() * 4)] });
    if (n % 25 === 0) {
      const s = encodeBlueprint({ blueprint: { item: "blueprint", label: `T10 ${target}`, entities, version: 562949958139904 } });
      if (s.length >= target) return { text: s, entities: entities.length, w: Math.min(side, n), h: Math.ceil(n / side) };
    }
  }
}

export type Pos = { x: number; y: number };
export type Area = { left_top: Pos; right_bottom: Pos };
export type Stack = { name: string; count: number };

/** 接口本身做不到 (不是这次出错): 表里记 "不支持" 和原因 */
export class Unsupported extends Error {}

/** 一次带看门狗的调用的结果 (T11 暂停、T13 截图、T14 看门狗要看"报错 / 卡住 / 成功"三种) */
export interface Outcome { ok: boolean; ms: number; error?: string; /** 看门狗到点、已发取消 */ watchdog?: boolean; data?: unknown }

/**
 * 读世界的接口 (T2~T6 等读类测试只用它)。两条路都实现它:
 * 只读 Lua (现在: 它的 world_query) 和读内存 (以后: 我们的原生层); 同一套测试、同一份沙盘真值逐类核对, 核对不过就停用那一类。
 */
export interface IoReader {
  readonly label: string;
  /** 累计收到的回复字节 (文字 + 图片) */
  bytes(): number;
  player(): Promise<{ name: string; position: Pos; controller: unknown; cursor: Stack | null; afkTime?: number }>;
  /** 角色主背包, 按格 (空格 = null) */
  inventorySlots(): Promise<(Stack | null)[]>;
  /** 第 1 页快捷栏第 slots 格里的物品名 (空 = null) */
  quickbar(slots: number[]): Promise<(string | null)[]>;
  entities(area: Area, filter?: { type?: string[] }): Promise<{ list: { name: string; position: Pos }[]; calls: number }>;
  /** 实体状态: 接口给什么就填什么 (状态码和 / 或状态名) */
  entityStatus(name: string, at: Pos): Promise<{ code?: number; name?: string }>;
  /** 用电设备有没有接上电网、电网编号; energy 是实体当前储能 (电线杆读数, 第一版坑 #12) */
  power(name: string, at: Pos): Promise<{ connected: boolean | null; networkId: number | null; energy?: number }>;
  evolution(surface: string): Promise<number>;
  research(): Promise<{ current: string | null; progress: number; researched: Set<string> }>;
  /** 客户端当前的游戏 tick (读的那一刻); 和服务器的比, 算客户端落后多少 (动作只报已发出, 核对前要等客户端追上) */
  tick(): Promise<number>;
  /** 当前画面能看到的地图范围 (鼠标只能指屏幕里的点; T7 远程视图) */
  viewArea(): Promise<Area | null>;
}

/** 被测接口: 读 (IoReader) + 挂接 + 动作; 测试只通过它读和动, 不碰具体协议 */
export interface IoTarget extends IoReader {
  start(): Promise<void>;
  stop(): Promise<void>;
  // T1 挂接
  status(): Promise<{ attached: boolean; state: string; paused: boolean | null; raw: unknown }>;
  attach(pid: number): Promise<void>;
  /** 挂上后的一次性准备 (注入客户端的程序: 读当前键位), 不算进挂接耗时 */
  prepare(): Promise<void>;
  detach(): Promise<void>;
  /** 界面帧号 (算帧率, T2 读大区域时卡不卡帧) */
  frame(): Promise<number>;
  // 动作 (只报已发出)
  holdItem(item: string): Promise<Stack | null>;
  /** 手上的东西放到地面 at; 返回发出结果 (不代表放成了) */
  placeHeld(at: Pos): Promise<Outcome>;
  clearCursor(): Promise<void>;
  insertExact(at: Pos, item: string, count: number): Promise<unknown>;
  takeExact(at: Pos, item: string, count: number): Promise<unknown>;
  setRequest(at: Pos, item: string, min: number, max?: number): Promise<unknown>;
  readRequests(name: string, at: Pos): Promise<{ item: string; min?: number; max?: number }[]>;
  setRecipe(at: Pos, recipe: string): Promise<unknown>;
  readRecipe(at: Pos): Promise<string | null>;
  importBlueprint(text: string, mode: string): Promise<{ pasted: number; cursor: string | null }>;
  /** 这个接口导入蓝图能用的方式 (注入客户端的程序: set_text ≤1024 字、剪贴板) */
  importModes(length: number): string[];
  placeHeldBlueprint(at: Pos): Promise<void>;
  /** 按住一个操作 (control id) ticks 个 tick; 看门狗 watchdogMs 到点就取消 */
  hold(control: string, ticks: number, watchdogMs: number): Promise<Outcome>;
  /** 按一下键 (界面层, 暂停时也能发) */
  pressKey(key: string): Promise<Outcome>;
  screenshot(o: { maxHeight: number; quality: number; watchdogMs: number }): Promise<Outcome & { bytes?: number; width?: number; height?: number }>;
  setRendering(enabled: boolean): Promise<Outcome>;
  chatSend(text: string): Promise<Outcome>;
  /** 等新聊天 (最多 timeoutS 秒); 看门狗 watchdogMs */
  chatWait(timeoutS: number, watchdogMs: number): Promise<Outcome>;
  /** 一次只读的世界查询 (看门狗用), 返回成败 */
  probe(watchdogMs: number): Promise<Outcome>;
}

/** 一行结果 */
export interface Row {
  id: string;
  test: string;
  /** true 通过 / false 不通过 / null 不支持或没测 */
  ok: boolean | null;
  ms?: number;
  bytes?: number;
  /** 和真值的差别 (通过时写"无") */
  diff?: string;
  note?: string;
  /** 以后的主路 (不填就按 routeOf) */
  route?: string;
}

/**
 * 每项以后走哪条路 (第 4b 节: 读内存和只读 Lua 都做, 每类数据按实测定主路; 现在只测了 Lua 这一路, 内存那一路做出来后用同一套测试比)。
 * 内存+Lua = 两路都做、按实测定主路; 动作 = 直接发玩家动作 / 键鼠 (第 7 节第 1 条); 原生 = 注入 / 进程 / 渲染层; 宿主 = 我们的调度层。
 */
export function routeOf(id: string): string {
  const n = Number(/^T(\d+)/.exec(id)?.[1] ?? NaN);
  if (n === 1 || n === 13) return "原生";
  if (n === 2 || n === 3 || n === 6 || n === 11) return "内存+Lua";
  if (n === 4 || n === 5 || n === 15) return "Lua";
  if (n >= 7 && n <= 10) return "动作";
  if (n === 12) return "内存";
  if (n === 14) return "宿主";
  return "";
}

/** 两个字符串清单 (排序无关) 的差别 */
export function diffList(truth: string[], got: string[]) {
  const t = new Map<string, number>(), g = new Map<string, number>();
  for (const s of truth) t.set(s, (t.get(s) ?? 0) + 1);
  for (const s of got) g.set(s, (g.get(s) ?? 0) + 1);
  const onlyTruth: string[] = [], onlyGot: string[] = [];
  for (const [k, n] of t) for (let i = g.get(k) ?? 0; i < n; i++) onlyTruth.push(k);
  for (const [k, n] of g) for (let i = t.get(k) ?? 0; i < n; i++) onlyGot.push(k);
  return { same: onlyTruth.length === 0 && onlyGot.length === 0, onlyTruth: onlyTruth.sort(), onlyGot: onlyGot.sort() };
}

export function fmtDiff(d: ReturnType<typeof diffList>, max = 6) {
  if (d.same) return "无";
  const part = (label: string, xs: string[]) => (xs.length ? `${label} ${xs.length} 个 (${xs.slice(0, max).join(" ")}${xs.length > max ? " …" : ""})` : "");
  return [part("只在真值里", d.onlyTruth), part("只在接口里", d.onlyGot)].filter(Boolean).join("; ");
}

/** 两个"名字 → 数量"表的差别 */
export function diffCounts(truth: Record<string, number>, got: Record<string, number>) {
  const keys = [...new Set([...Object.keys(truth), ...Object.keys(got)])].sort();
  return keys.filter((k) => (truth[k] ?? 0) !== (got[k] ?? 0)).map((k) => `${k} 真值 ${truth[k] ?? 0} / 接口 ${got[k] ?? 0}`);
}

/** 按格比两个背包 (空格 = null); 返回对不上的格子说明 */
export function diffSlots(truth: (Stack | null)[], got: (Stack | null)[]) {
  const out: string[] = [];
  const n = Math.max(truth.length, got.length);
  const f = (s: Stack | null | undefined) => (s ? `${s.name}×${s.count}` : "空");
  for (let i = 0; i < n; i++) if (f(truth[i]) !== f(got[i])) out.push(`第 ${i + 1} 格 真值 ${f(truth[i])} / 接口 ${f(got[i])}`);
  if (truth.length !== got.length) out.push(`格数 真值 ${truth.length} / 接口 ${got.length}`);
  return out;
}

/** 帧率: 两次帧号和墙钟时间 */
export const fps = (f0: number, t0: number, f1: number, t1: number) => (t1 > t0 ? ((f1 - f0) * 1000) / (t1 - t0) : NaN);

/** 实体 → "名字@x,y" (和真值比用) */
export const key = (e: { name: string; position: Pos }) => `${e.name}@${e.position.x},${e.position.y}`;

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

/** 结果表 (markdown): 编号、测什么、结果、耗时、回复大小、和真值的差别 / 备注 */
export function table(rows: Row[], maxText = 160) {
  const mark = (r: Row) => (r.ok === true ? "✅" : r.ok === false ? "❌" : "—");
  const size = (b?: number) => (b === undefined ? "" : b < 1024 ? `${b}B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1024 / 1024).toFixed(2)}MB`);
  const lines = rows.map((r) => {
    const text = [r.diff && r.diff !== "无" ? `差别: ${r.diff}` : r.diff === "无" ? "和真值一致" : "", r.note ?? ""].filter(Boolean).join("; ");
    return `| ${r.id} | ${cell(r.test)} | ${mark(r)} | ${r.ms ?? ""} | ${size(r.bytes)} | ${r.route ?? routeOf(r.id)} | ${cell(text.length > maxText ? text.slice(0, maxText) + "…" : text)} |`;
  });
  return ["| # | 测什么 | 结果 | 耗时 ms | 回复 | 以后主路 | 和真值的差别 / 备注 |", "|---|---|---|---|---|---|---|", ...lines].join("\n");
}

/** 小结: 通过 / 不通过 / 不支持 各几项 */
export function summary(rows: Row[]) {
  const n = (v: boolean | null) => rows.filter((r) => r.ok === v).length;
  return { pass: n(true), fail: n(false), na: n(null), total: rows.length };
}
