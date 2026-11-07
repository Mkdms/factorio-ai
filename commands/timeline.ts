// 注入客户端的程序 (game/client) `input` 工具的时间线构造器 (M4 清单第 3 条)。
// 原样搬自第一版 pilot/src/mcp/input.ts (Timeline 部分; 第一版的 InputArbiter 绑定了第一版的反射层, 不搬)。
// 2026-11-02 已核对字段和他 0.0.10 的 tools.md "Input timelines" 一致 (timeline、tick 区间字符串、position / motion 的 space、per_point_ticks、start_tick、wheel)。
// 第一版的代码当待核实: 单元测试 test/io.test.ts, 沙盘里用它放东西是测试项 T7。
import type { ResolvedControl } from "./controls.ts";

export type WorldPoint = { x: number; y: number };

export interface InputEntry {
  device: "keyboard" | "mouse";
  key?: string;
  button?: string;
  position?: { space: "world" | "viewport"; x: number; y: number; snap?: "tile_center" };
  motion?: { space: "world" | "viewport"; from: WorldPoint; to: WorldPoint; snap?: "tile_center" };
  wheel?: "up" | "down";
  tick?: string;
  per_point_ticks?: number;
  start_tick?: number;
}

export interface InputResult {
  status: "completed" | "aborted";
  completed_entries: number;
  evaluated_ticks: number;
  reason?: string;
}

/** Fluent builder for concurrent timeline entries. Ticks are inclusive and relative to admission. */
export class Timeline {
  entries: InputEntry[] = [];

  key(name: string, from: number, to = from) {
    this.entries.push({ device: "keyboard", key: name, tick: range(from, to) });
    return this;
  }

  button(name: string, from: number, to = from) {
    this.entries.push({ device: "mouse", button: name, tick: range(from, to) });
    return this;
  }

  /** Hold a resolved control (with its modifiers) for a tick range. */
  control(control: ResolvedControl, from: number, to = from) {
    for (const modifier of control.modifiers) this.key(modifier, from, to);
    if (control.device === "keyboard") return this.key(control.name, from, to);
    if (control.name.startsWith("wheel:")) {
      this.entries.push({ device: "mouse", wheel: control.name.slice(6) as "up" | "down", tick: range(from, to) });
      return this;
    }
    return this.button(control.name, from, to);
  }

  /**
   * 长按键: 拆成首尾相接的多段, 每段重按一次 (工具手册: 相邻区间松开再按, 中间没有一次判定是松开的, 角色不会停)。
   * 窗口拿到或失去焦点时游戏会松开按着的键, 这之后时间线还在走但键已经没按着: 不重按就一直停到这条时间线走完
   * (2026-11-07 同样挖 60 秒, 真切走再切回两次: 旧代码 17.3 个, 重按后 28.8 个, 不切 29~30 个; 一批 10 个 = 20 秒)。
   */
  holdKey(name: string, from: number, to: number, every = REPRESS_TICKS) {
    for (const [a, b] of pieces(from, to, every)) this.key(name, a, b);
    return this;
  }

  /** 同 holdKey, 按游戏里绑定的操作 (带修饰键) */
  holdControl(control: ResolvedControl, from: number, to: number, every = REPRESS_TICKS) {
    for (const [a, b] of pieces(from, to, every)) this.control(control, a, b);
    return this;
  }

  /** Point the mouse at a world position for a tick range. */
  worldPosition(point: WorldPoint, from: number, to = from, snap = false) {
    this.entries.push({
      device: "mouse",
      position: { space: "world", x: point.x, y: point.y, ...(snap ? { snap: "tile_center" } : {}) },
      tick: range(from, to),
    });
    return this;
  }

  viewportPosition(x: number, y: number, from: number, to = from) {
    this.entries.push({ device: "mouse", position: { space: "viewport", x: Math.round(x), y: Math.round(y) }, tick: range(from, to) });
    return this;
  }

  /** Move the mouse along a world path, dwelling `perPointTicks` at each tile step. */
  worldMotion(from: WorldPoint, to: WorldPoint, perPointTicks: number, startTick = 0) {
    this.entries.push({ device: "mouse", motion: { space: "world", from, to }, per_point_ticks: perPointTicks, start_tick: startTick });
    return this;
  }

  get length() {
    return this.entries.length;
  }

  /** Last tick referenced by any entry, used to estimate blocking duration. */
  get lastTick() {
    let last = 0;
    for (const entry of this.entries) {
      if (entry.tick) for (const part of entry.tick.split(",")) last = Math.max(last, Number(part.split("-").pop()));
      if (entry.per_point_ticks && entry.motion) {
        const points = Math.ceil(Math.max(Math.abs(entry.motion.to.x - entry.motion.from.x), Math.abs(entry.motion.to.y - entry.motion.from.y))) + 1;
        last = Math.max(last, (entry.start_tick ?? 0) + points * entry.per_point_ticks - 1);
      }
    }
    return last;
  }
}

/** 长按键多久重按一次: 也是切窗口之后最多停多久 (10 tick = 六分之一秒) */
export const REPRESS_TICKS = 10;

function pieces(from: number, to: number, every: number): [number, number][] {
  if (!(every >= 1)) throw new Error(`Invalid repress interval ${every}`);
  if (to < from) throw new Error(`Invalid tick range ${from}-${to}`);
  const out: [number, number][] = [];
  for (let a = from; a <= to; a += every) out.push([a, Math.min(a + every - 1, to)]);
  return out;
}

function range(from: number, to: number) {
  if (to < from) throw new Error(`Invalid tick range ${from}-${to}`);
  return from === to ? String(from) : `${from}-${to}`;
}
