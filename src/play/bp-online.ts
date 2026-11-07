// 联机的 ./bp build (docs/io-client.md 11j): 服务器上没有模组, 贴不了虚影再亲手建, 改成把蓝图拆成一件件玩家放置 (./fh call build), 放不完回下一条命令。
// 只给 ./bp build 用; 红绿线、过滤器、模块不带过去 (回复里说)。沙盘那条路在 bp.ts build(), 不动。
import path from "node:path";
import { Harness } from "./harness.ts";
import { PipeRcon } from "../io/pipe-client.ts";
import { loadRules, rotate } from "../blueprint/rules.ts";
import { absBox } from "../blueprint/placed.ts";
import { NAME_BY_DIR } from "../io/fh-actions.ts";

export type BpRowIn = { name: string; position: { x: number; y: number }; direction?: number; recipe?: string };
export type Row = { item: string; position: { x: number; y: number }; direction?: string; recipe?: string; box: { left: number; top: number; right: number; bottom: number } };
const TURN: Record<string, number> = { north: 0, east: 4, south: 8, west: 12 };

/**
 * 蓝图实体 → 要放的每一件。整张图按 --dir 转, 再整体平移到 at 附近: 平移量是整数, 所以 2×2 的机器还在整数格点、3×3 的还在 .5 上。
 * sizeOf 给实体朝北时的占地 [左, 上, 右, 下] (相对中心); 不认识的按 1×1。
 */
export function placeRows(entities: BpRowIn[], at: { x: number; y: number }, dir: string | undefined, sizeOf: (e: BpRowIn) => [number, number, number, number]): Row[] {
  const turn = TURN[dir ?? "north"] ?? 0;
  const turned = entities.map((e) => {
    const [x, y] = rotate(e.position.x, e.position.y, turn);
    const d = ((e.direction ?? 0) + turn) % 16;
    const [a, b, c, f] = sizeOf({ ...e, position: { x, y }, direction: d });
    return { e, x, y, d, box: { left: a, top: b, right: c, bottom: f } };
  });
  if (!turned.length) return [];
  const minX = Math.min(...turned.map((t) => t.box.left)), maxX = Math.max(...turned.map((t) => t.box.right));
  const minY = Math.min(...turned.map((t) => t.box.top)), maxY = Math.max(...turned.map((t) => t.box.bottom));
  const sx = Math.round(at.x - (minX + maxX) / 2), sy = Math.round(at.y - (minY + maxY) / 2);
  return turned.map(({ e, x, y, d, box }) => ({
    item: e.name,
    position: { x: x + sx, y: y + sy },
    ...(NAME_BY_DIR[d] ? { direction: NAME_BY_DIR[d] } : {}),
    ...(e.recipe ? { recipe: e.recipe } : {}),
    box: { left: box.left + sx, top: box.top + sy, right: box.right + sx, bottom: box.bottom + sy },
  }));
}

type Dry = { total: number; need: Record<string, number>; missing: Record<string, number>; blocked: string[]; clear: { x: number; y: number }[]; clear_count: number; existing: number };
const list = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k}*${v}`).join(" ");

export async function buildOnline(e: { no: number; label: string; io?: string; get: () => Record<string, unknown> }, rest: string[], spec: string): Promise<number> {
  const say = (t: string) => console.log(t);
  const opt = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const nums = (opt("--at") ?? "").split(",").map(Number);
  if (nums.length !== 2 || nums.some((v) => !Number.isFinite(v))) { say("error: 要 --at x,y (蓝图中心放在哪)"); return 1; }
  const pipe = process.env.FH_SOCKET;
  if (!pipe) { say("error: 没有 FH_SOCKET (这条路只在联机主循环的角色目录里能用)"); return 1; }
  const dir = opt("--dir");
  if (dir && TURN[dir] === undefined) { say("error: --dir 只能是 north / east / south / west"); return 1; }
  const at = { x: nums[0], y: nums[1] };
  const rules = loadRules();
  const bp = e.get() as { entities?: BpRowIn[] };
  const rows = placeRows(bp.entities ?? [], at, dir, (x) => {
    const r = rules.get(x.name);
    if (!r) return [x.position.x - 0.4, x.position.y - 0.4, x.position.x + 0.4, x.position.y + 0.4];
    return absBox(x as never, r);
  });
  if (!rows.length) { say("error: 蓝图里没有实体"); return 1; }
  const again = `./bp build ${spec} --at ${at.x},${at.y}${dir ? ` --dir ${dir}` : ""}`;
  const h = new Harness(new PipeRcon(pipe) as never, 1);
  const dry = async () => { const r = await h.request("build", { builds: rows, dry_run: true }); if (!r.ok) throw new Error(r.error?.message ?? "dry_run 失败"); return r.result as Dry; };
  let d = await dry();
  if (d.blocked.length) { say(`放不下 (${at.x},${at.y}): 挡着 ${d.blocked.slice(0, 8).join("、")}${d.blocked.length > 8 ? ` 等 ${d.blocked.length} 件` : ""}。什么都没放。换个地方: ./bp build ${spec} --at x,y`); return 1; }
  // 料: 先从附近的箱子和机器出口拿 (协助模式每样最多拿一半, 工具会拦), 还差就报
  if (Object.keys(d.missing).length) {
    for (const [item, count] of Object.entries(d.missing)) {
      const c = await h.request("collect", { item, count, radius: 128, chests: true });
      if (!c.ok) say(`备料: ${item} 没拿到: ${(c.error?.message ?? "").slice(0, 120)}`);
    }
    d = await dry();
    if (Object.keys(d.missing).length) { say(`料不够: 蓝图要 ${list(d.need)}; 还差 ${list(d.missing)}。什么都没放, 备好再跑: ${again}`); return 1; }
  }
  // 树和石头: 贴不进去就拆; 一次最多拆 20 秒, 放长命令不闷声等
  const t0 = Date.now();
  let cut = 0;
  for (const p of d.clear) {
    if (Date.now() - t0 > 20_000) { say(`清场: 拆了 ${cut} 个树石, 还有 ${d.clear_count - cut} 个, 同一条命令再跑接着清: ${again}`); return 2; }
    const m = await h.request("mine", { position: p, walk: true });
    if (!m.ok) { say(`清场: ${p.x},${p.y} 拆不了: ${(m.error?.message ?? "").slice(0, 160)}`); return 1; }
    cut++;
  }
  const start = Number(opt("--start") ?? 1);
  const r = await h.request("build", { builds: rows, start_index: Number.isFinite(start) && start > 0 ? start : 1, skip_existing: true, walk: true });
  if (!r.ok) { say(`放到一半停了: ${(r.error?.message ?? "").slice(0, 400)}\n已经放下的不用重放, 处理之后再跑: ${again}`); return 1; }
  const res = r.result as { built?: number; consumed?: number; total?: number; next_index?: number };
  const placed = res.built ?? res.consumed ?? 0;
  if (res.next_index) { say(`蓝图 ${e.no || path.basename(spec)} (${e.label}): 这次放了 ${placed} 件, 一共 ${rows.length} 件, 没放完。接着放: ${again} --start ${res.next_index}`); return 2; }
  say(`蓝图 ${e.no || path.basename(spec)} (${e.label}) 放好了, 在 (${at.x},${at.y})${dir ? ` 朝 ${dir}` : ""}: 新放 ${placed} 件, 本来就有 ${d.existing} 件${cut ? `, 拆了 ${cut} 个树石` : ""}。红绿线、过滤器、模块没带过去, 要的话自己补; 配方带上了。`);
  if (e.io) say(`这块 ${e.io}`);
  // 加产能 = 再贴一块: 把下一块的位置查好递上 (不靠模型去读这条经验)
  try {
    const w = Math.max(...rows.map((x) => x.box.right)) - Math.min(...rows.map((x) => x.box.left));
    const tall = Math.max(...rows.map((x) => x.box.bottom)) - Math.min(...rows.map((x) => x.box.top));
    for (const [dx, dy] of [[Math.ceil(w) + 1, 0], [0, Math.ceil(tall) + 1], [-Math.ceil(w) - 1, 0], [0, -Math.ceil(tall) - 1]]) {
      const moved = rows.map((x) => ({ ...x, position: { x: x.position.x + dx, y: x.position.y + dy }, box: { left: x.box.left + dx, right: x.box.right + dx, top: x.box.top + dy, bottom: x.box.bottom + dy } }));
      const c = await h.request("build", { builds: moved, dry_run: true });
      if (c.ok && !(c.result as Dry).blocked.length) { say(`再贴一块放得下 (查过): ./bp build ${spec} --at ${at.x + dx},${at.y + dy}${dir ? ` --dir ${dir}` : ""}`); break; }
    }
  } catch { /* 附带的, 不影响已经放好 */ }
  return 0;
}
