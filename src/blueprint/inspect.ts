// 蓝图解析和检查: 解码蓝图字符串 (单张或蓝图书), 列出用了什么 (官方中文名)、多大,
// 再按已核实的规则检查 (例: 车站和紫箱在同一张机器人网里)。别人的蓝图原文只放本机 lab-data/blueprints/, 不进仓库。
import { decodeBlueprint } from "../lab/blueprint.ts";

export interface BpEntity {
  name: string;
  position: { x: number; y: number };
  direction?: number;
  recipe?: string;
  station?: string;
  [k: string]: unknown;
}

export interface BpInfo {
  label: string;
  path: string; // 在蓝图书里的位置, 例 "书/第 3 张"
  entities: BpEntity[];
  tiles: number;
  size: { w: number; h: number };
  counts: Record<string, number>;
  recipes: Record<string, number>;
  stations: string[];
  wires: number;
  findings: string[];
}

type Raw = Record<string, any>;

/** 把蓝图书摊平成一张张蓝图 */
export function flatten(obj: Raw, prefix = ""): { label: string; path: string; bp: Raw }[] {
  if (obj.blueprint) return [{ label: obj.blueprint.label ?? "(无名)", path: prefix || "单张蓝图", bp: obj.blueprint }];
  if (obj.blueprint_book) {
    const book = obj.blueprint_book;
    const out: { label: string; path: string; bp: Raw }[] = [];
    for (const item of book.blueprints ?? []) {
      out.push(...flatten(item, `${prefix}${book.label ?? "蓝图书"} / 第 ${(item.index ?? 0) + 1} 张 `));
    }
    return out;
  }
  return []; // 升级规划、拆除规划等, 跳过
}

const LOGISTIC_RADIUS: Record<string, number> = { roboport: 25 }; // 本机原型: 机器人指令平台物流范围 25 (边长 50 的方框)

export function analyze(label: string, path: string, bp: Raw): BpInfo {
  const entities: BpEntity[] = (bp.entities ?? []).map((e: Raw) => ({ ...e, position: e.position }));
  const counts: Record<string, number> = {};
  const recipes: Record<string, number> = {};
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of entities) {
    counts[e.name] = (counts[e.name] ?? 0) + 1;
    if (e.recipe) recipes[e.recipe] = (recipes[e.recipe] ?? 0) + 1;
    minX = Math.min(minX, e.position.x);
    minY = Math.min(minY, e.position.y);
    maxX = Math.max(maxX, e.position.x);
    maxY = Math.max(maxY, e.position.y);
  }
  const stations = entities.filter((e) => e.name === "train-stop").map((e) => e.station ?? "(无名车站)");
  const info: BpInfo = {
    label,
    path,
    entities,
    tiles: (bp.tiles ?? []).length,
    size: entities.length ? { w: Math.ceil(maxX - minX) + 1, h: Math.ceil(maxY - minY) + 1 } : { w: 0, h: 0 },
    counts,
    recipes,
    stations,
    // 只数电路线; 接点编号 1~4 是红绿线, 5、6 是铜线 (电线杆、电闸), 2.1.24 从 defines.wire_connector_id 读的
    wires: (bp.wires ?? []).filter((w: number[]) => w[1] <= 4 && w[3] <= 4).length,
    findings: [],
  };
  info.findings = check(info);
  return info;
}

/** 按已核实的规则检查 (每条写明依据) */
function check(info: BpInfo): string[] {
  const out: string[] = [];
  const at = (n: string) => info.entities.filter((e) => e.name === n);
  const stops = at("train-stop");
  const ports = info.entities.filter((e) => LOGISTIC_RADIUS[e.name]);
  const covered = (p: { x: number; y: number }) =>
    ports.some((r) => Math.abs(r.position.x - p.x) <= LOGISTIC_RADIUS[r.name] && Math.abs(r.position.y - p.y) <= LOGISTIC_RADIUS[r.name]);
  // 规则 1: 车站在机器人网里, 旁边又有紫箱 → 卸下的货会被机器人先搬走 (已核实: 紫箱不看远近先被取)
  for (const s of stops) {
    const near = at("active-provider-chest").filter((c) => Math.abs(c.position.x - s.position.x) <= 12 && Math.abs(c.position.y - s.position.y) <= 12);
    if (near.length && covered(s.position)) {
      out.push(`⚠️ 车站"${s.station ?? ""}"在机器人网里, 附近有 ${near.length} 个主动供货箱 (紫箱): 机器人取货先找紫箱、不看远近 (沙盘已核实 logistics.pickup.active-provider-first), 卸下的货会被立刻搬走。`);
    } else if (covered(s.position)) {
      // 规则: 同一张网里可以用火车, 但车站两头只许普通箱; 机车燃料请求箱除外
      const LOGI = ["passive-provider-chest", "storage-chest", "buffer-chest", "requester-chest"];
      const logi = info.entities.filter((c) => LOGI.includes(c.name) && Math.abs(c.position.x - s.position.x) <= 12 && Math.abs(c.position.y - s.position.y) <= 12);
      if (logi.length) {
        out.push(`ℹ️ 车站"${s.station ?? ""}"在机器人网里, 附近有 ${logi.length} 个物流箱: 我们的规则是车站两头只用普通箱 (机车燃料的请求箱除外), 要看这些箱子是不是装卸货用的。`);
      }
    }
  }
  // 规则 2: 有电路线的组装机 / 机械臂 → 2.1 起"既设配方又读原料"要分红绿线 (检索 circuits.md C1~C3, 待核实)
  if (info.wires && (info.counts["assembling-machine-2"] || info.counts["assembling-machine-3"]) && info.wires > 0) {
    out.push(`ℹ️ 有 ${info.wires} 根电路线: 如果是按电路设配方, 2.1 起输入和输出要接不同颜色的线 (检索 circuits.md C1~C3, 还没核实)。`);
  }
  return out;
}

export function decodeAll(s: string): BpInfo[] {
  return flatten(decodeBlueprint(s)).map((b) => analyze(b.label, b.path, b.bp));
}

/** 中文报告 */
export function report(list: BpInfo[], zh: (n: string) => string): string {
  const lines: string[] = [];
  for (const b of list) {
    lines.push(`== ${b.path.trim()}: "${b.label}"  大小约 ${b.size.w}×${b.size.h} 格, 建筑 ${b.entities.length} 个, 地砖 ${b.tiles} 格, 电路线 ${b.wires} 根`);
    const top = Object.entries(b.counts).sort((a, c) => c[1] - a[1]);
    lines.push("  建筑: " + top.map(([n, k]) => `${zh(n)}×${k}`).join("、"));
    if (Object.keys(b.recipes).length) lines.push("  配方: " + Object.entries(b.recipes).map(([n, k]) => `${zh(n)}×${k}`).join("、"));
    if (b.stations.length) lines.push("  车站: " + b.stations.join("、"));
    for (const f of b.findings) lines.push("  " + f);
  }
  return lines.join("\n");
}
