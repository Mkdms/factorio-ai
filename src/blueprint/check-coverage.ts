// 覆盖检查 (2026-11-01): 机器人指令平台的物流范围和建设范围、炮塔射程覆盖墙、机枪炮塔有没有机械臂补弹。
// 范围从原型读 (rules.ts: roboport logistics/construction radius、turret attack_parameters.range / min_range)。
// 沙盘核实过的: 物流范围半边长 25 (logistics.roboport.logistics-range-25)、建设范围半边长 55 (logistics.roboport.construction-range-55)、
// 两个平台物流范围不重叠就是两张网 (logistics.network.separate-when-ranges-dont-overlap), 边界刚好相接 (相距 50) 也连成一张网 (logistics.network.touching-ranges-connect)。
// 设计取舍 (不是游戏规则): 墙算"有炮塔护着"要求墙外 WALL_MARGIN 格也在射程内 (来拆墙的虫站在墙外)。
import { rotate } from "./rules.ts";
import { type Finding, type Placed, Layout, Union } from "./placed.ts";

export const WALL_MARGIN = 2;

const inSquare = (p: Placed, c: Placed, r: number) => Math.abs(p.e.position.x - c.e.position.x) <= r && Math.abs(p.e.position.y - c.e.position.y) <= r;
const pos = (p: Placed) => `(${p.e.position.x},${p.e.position.y})`;

export function checkCoverage(L: Layout, zh: (n: string) => string): Finding[] {
  const out: Finding[] = [];
  const { placed } = L;
  const roboports = placed.filter((p) => p.r.roboport);
  const chests = placed.filter((p) => p.r.type === "logistic-container");
  const turrets = placed.filter((p) => p.r.turret);
  const walls = placed.filter((p) => p.r.wall);

  // 1. 物流箱在不在机器人网里
  if (chests.length && !roboports.length) {
    out.push({ level: "info", kind: "logistic-no-roboport", msg: `有 ${chests.length} 个物流箱但蓝图里没有机器人指令平台 (要靠放下后外面的机器人网)` });
  } else if (chests.length) {
    const outside = chests.filter((c) => !roboports.some((rp) => inSquare(c, rp, rp.r.roboport!.logistics)));
    for (const c of outside.slice(0, 10)) out.push({ level: "warn", kind: "logistic-chest-outside-network", msg: `${zh(c.e.name)} ${pos(c)} 不在任何${zh("roboport")}的物流范围里 (机器人不来)`, at: c.e.position, entity: c.e.name });
    if (outside.length > 10) out.push({ level: "warn", kind: "logistic-chest-outside-network", msg: `…还有 ${outside.length - 10} 个物流箱不在物流范围里` });
  }

  // 2. 机器人网分几张: 物流范围 (半边长 r 的方块) 重叠或边界相接就连成一张 (沙盘: 相距 50 一张网, 52 两张)
  if (roboports.length > 1) {
    const u = new Union();
    for (const rp of roboports) u.add(rp.e.entity_number);
    for (let i = 0; i < roboports.length; i++) for (let j = i + 1; j < roboports.length; j++) {
      const a = roboports[i], b = roboports[j];
      const reach = a.r.roboport!.logistics + b.r.roboport!.logistics;
      const dx = Math.abs(a.e.position.x - b.e.position.x), dy = Math.abs(a.e.position.y - b.e.position.y);
      if (dx <= reach && dy <= reach) u.join(a.e.entity_number, b.e.entity_number);
    }
    const nets = new Set(roboports.map((rp) => u.find(rp.e.entity_number))).size;
    if (nets > 1) out.push({ level: "info", kind: "roboport-networks", msg: `${roboports.length} 个${zh("roboport")}分成 ${nets} 张机器人网 (物流范围既不重叠也不相接)`, data: { nets } });
  }

  // 3. 炮塔和墙在不在建设范围里 (坏了机器人来修、被毁了机器人重建)
  if (roboports.length && (turrets.length || walls.length)) {
    const reachable = (p: Placed) => roboports.some((rp) => inSquare(p, rp, rp.r.roboport!.construction));
    const tOut = turrets.filter((t) => !reachable(t));
    for (const t of tOut.slice(0, 10)) out.push({ level: "warn", kind: "turret-no-repair", msg: `${zh(t.e.name)} ${pos(t)} 不在任何${zh("roboport")}的建设范围里 (坏了没机器人修)`, at: t.e.position, entity: t.e.name });
    if (tOut.length > 10) out.push({ level: "warn", kind: "turret-no-repair", msg: `…还有 ${tOut.length - 10} 座炮塔不在建设范围里` });
    const wOut = walls.filter((w) => !reachable(w)).length;
    if (wOut) out.push({ level: "info", kind: "wall-no-repair", msg: `${wOut} 段墙 / 闸门不在建设范围里 (坏了没机器人修)` });
  }

  // 4. 墙有没有炮塔护着 (重炮不算: 打不了贴墙的虫)
  const guards = turrets.filter((t) => t.r.turret!.kind !== "artillery");
  if (walls.length && !guards.length) {
    out.push({ level: "info", kind: "wall-no-turrets-at-all", msg: `有 ${walls.length} 段墙 / 闸门但蓝图里没有炮塔` });
  } else if (walls.length) {
    const covered = (w: Placed) => guards.some((t) => {
      const d = Math.hypot(w.e.position.x - t.e.position.x, w.e.position.y - t.e.position.y);
      return d + WALL_MARGIN <= t.r.turret!.range && d >= t.r.turret!.minRange;
    });
    const bare = walls.filter((w) => !covered(w));
    for (const w of bare.slice(0, 10)) out.push({ level: "warn", kind: "wall-no-turret", msg: `${zh(w.e.name)} ${pos(w)} 墙外 ${WALL_MARGIN} 格不在任何炮塔射程里`, at: w.e.position, entity: w.e.name });
    if (bare.length > 10) out.push({ level: "warn", kind: "wall-no-turret", msg: `…还有 ${bare.length - 10} 段墙没有炮塔护着 (共 ${bare.length} / ${walls.length})` });
  }

  // 5. 机枪炮塔 (吃弹药的) 有没有机械臂往里放
  const ammo = turrets.filter((t) => t.r.turret!.kind === "ammo");
  if (ammo.length) {
    const fed = new Set<Placed>();
    for (const p of placed) {
      if (!p.r.inserter) continue;
      const [rx, ry] = rotate(p.r.inserter.drop[0], p.r.inserter.drop[1], p.dir);
      for (const q of L.at(p.e.position.x + rx, p.e.position.y + ry)) if (q.r.turret?.kind === "ammo") fed.add(q);
    }
    const unfed = ammo.filter((t) => !fed.has(t));
    if (unfed.length) out.push({ level: "info", kind: "turret-no-ammo-feed", msg: `${unfed.length} / ${ammo.length} 座吃弹药的炮塔没有机械臂补弹 (要靠机器人或手补)`, at: unfed[0].e.position, entity: unfed[0].e.name });
  }
  return out;
}
