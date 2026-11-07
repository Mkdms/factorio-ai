// 检查器共用的几何: 实体落到格子上 (按朝向旋转碰撞盒)、格子索引。各项检查 (check.ts、check-belts.ts、check-fluids.ts、check-rails.ts) 都用这里的。
import type { BpEntity } from "./inspect.ts";
import { type EntityRule, type Rules, rotate } from "./rules.ts";

export interface Finding {
  level: "error" | "warn" | "info";
  kind: string;
  msg: string;
  at?: { x: number; y: number };
  entity?: string;
  /** 给沙盘核对用的附加数据 (例: 弯道的位置清单) */
  data?: unknown;
}

export interface Placed {
  e: BpEntity;
  r: EntityRule;
  dir: number;
  /** 占地的整格 (含) */
  x1: number; y1: number; x2: number; y2: number;
}

export const key = (x: number, y: number) => `${x},${y}`;

/** 实体朝 dir 时的碰撞盒 (绝对坐标): 把朝北的盒子四角旋转; 碰撞盒可以不对称 (抽取泵往水里多伸一格) */
export function absBox(e: BpEntity, r: EntityRule): [number, number, number, number] {
  const dir = e.direction ?? 0;
  const [x1, y1, x2, y2] = r.box;
  const [ax, ay] = rotate(x1, y1, dir), [bx, by] = rotate(x2, y2, dir);
  return [e.position.x + Math.min(ax, bx), e.position.y + Math.min(ay, by), e.position.x + Math.max(ax, bx), e.position.y + Math.max(ay, by)];
}

export function footprint(e: BpEntity, r: EntityRule): Placed {
  const dir = e.direction ?? 0;
  const [bx1, by1, bx2, by2] = absBox(e, r);
  const eps = 0.01;
  return { e, r, dir, x1: Math.floor(bx1 + eps), y1: Math.floor(by1 + eps), x2: Math.ceil(bx2 - eps) - 1, y2: Math.ceil(by2 - eps) - 1 };
}

/** 蓝图里的实体落到格子上, 加格子索引 (铁轨和信号不进索引: 铁轨之间可以重叠) */
export class Layout {
  readonly placed: Placed[] = [];
  readonly byNumber = new Map<number, Placed>();
  readonly unknown = new Set<string>();
  readonly tile = new Map<string, Placed[]>();
  readonly rules: Rules;

  constructor(entities: BpEntity[], rules: Rules) {
    this.rules = rules;
    for (const e of entities) {
      const r = rules.get(e.name);
      if (!r) { this.unknown.add(e.name); continue; }
      const p = footprint(e, r);
      this.placed.push(p);
      this.byNumber.set(e.entity_number, p);
    }
    for (const p of this.placed) {
      if (p.r.rail || p.r.type === "rail-signal" || p.r.type === "rail-chain-signal") continue;
      for (let x = p.x1; x <= p.x2; x++) for (let y = p.y1; y <= p.y2; y++) {
        const k = key(x, y);
        const list = this.tile.get(k) ?? [];
        list.push(p);
        this.tile.set(k, list);
      }
    }
  }

  /** 某个点所在格子上的实体 */
  at(x: number, y: number): Placed[] {
    return this.tile.get(key(Math.floor(x), Math.floor(y))) ?? [];
  }
}

/** 并查集 (电网、传送带段、管网都用) */
export class Union {
  private parent = new Map<number, number>();
  add(i: number) { if (!this.parent.has(i)) this.parent.set(i, i); }
  find(i: number): number {
    this.add(i);
    let r = i;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = i;
    while (this.parent.get(c) !== r) { const n = this.parent.get(c)!; this.parent.set(c, r); c = n; }
    return r;
  }
  join(a: number, b: number) { this.parent.set(this.find(a), this.find(b)); }
  has(i: number) { return this.parent.has(i); }
}
