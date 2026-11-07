// 清场 (库, 不直接运行): 让服务器角色 (AI2) 按固定步骤清掉挡路的树石, 不用大脑、不花大脑额度。
// 用户(截图: 炼油厂西边 17 个红叉): "这些挡住建筑位置的东西能不能先让 AI分身手动去拆了啊 然后把材料放到对应的存储箱？很难吗？"
// 步骤: 找标了红叉的树石 + 机器周围 3 格内的树石 → 按 16 格一片分组 → 每片 deconstruct (只标树石) + construct (走过去手砍, 等做完)
// → 木头 / 石头 / 煤放进附近已经存着同类东西的箱子, 没有就造一个木箱放在旁边。
// 动作全走 agent-harness 的玩家规则 (够得着、只用背包里的、真实时间); 只有"哪些要清""箱子在哪"用 RCON 只读查询。
import type { Harness, Reply } from "./harness.ts";

export type Spot = { x: number; y: number; name: string };
export type Area = { left_top: { x: number; y: number }; right_bottom: { x: number; y: number } };

/** 要清的树石: 标了拆除红叉的, 和机器 (组装机、炉子、研究中心、锅炉、采矿机、发电机) 周围 3 格内的 */
export const OBSTACLE_LUA = `local s = game.surfaces[1] local f = game.forces.player local out, seen = {}, {}
local function rock(e) if e.type == "tree" then return true end local ok, v = pcall(function() return e.prototype.count_as_rock_for_filtered_deconstruction end) return ok and v end
local function add(e) local k = string.format("%.2f,%.2f", e.position.x, e.position.y) if not seen[k] and rock(e) then seen[k] = true out[#out + 1] = {x = e.position.x, y = e.position.y, name = e.name} end end
for _, e in pairs(s.find_entities_filtered{type = {"tree", "simple-entity"}, to_be_deconstructed = true}) do add(e) end
for _, m in pairs(s.find_entities_filtered{force = f, type = {"assembling-machine", "furnace", "lab", "boiler", "mining-drill", "generator"}}) do
  local b = m.bounding_box
  for _, e in pairs(s.find_entities_filtered{area = {{b.left_top.x - 3, b.left_top.y - 3}, {b.right_bottom.x + 3, b.right_bottom.y + 3}}, type = {"tree", "simple-entity"}}) do add(e) end
end
return out`;

/** 某个角色背包里的木头、石头、煤, 和附近 (40 格内) 的箱子: 存着哪些东西、还有几格空 */
export const STORE_LUA = `local a = ... local c = game.get_entity_by_unit_number(a.unit) if not (c and c.valid) then return {} end
local inv = c.get_main_inventory() local held = {} for _, it in pairs(inv.get_contents()) do if it.name == "wood" or it.name == "stone" or it.name == "coal" then held[it.name] = (held[it.name] or 0) + it.count end end
local chests = {} for _, e in pairs(c.surface.find_entities_filtered{type = "container", force = c.force, position = c.position, radius = 40}) do
  local i = e.get_inventory(defines.inventory.chest) local has = {} for _, it in pairs(i.get_contents()) do has[it.name] = true end
  local feeds = false for _, ins in pairs(c.surface.find_entities_filtered{type = "inserter", position = e.position, radius = 2}) do if ins.pickup_target == e then feeds = true end end
  chests[#chests + 1] = {x = e.position.x, y = e.position.y, free = i.count_empty_stacks(), has = has, feeds = feeds, d = ((e.position.x - c.position.x) ^ 2 + (e.position.y - c.position.y) ^ 2) ^ 0.5}
end
return {x = c.position.x, y = c.position.y, held = held, chests = chests}`;

/** 空着、旁边 2 格没有机械臂的箱子 (用完的交接箱) */
export const EMPTY_CHEST_LUA = `local s = game.surfaces[1] local out = {}
for _, e in pairs(s.find_entities_filtered{type = "container", force = game.forces.player}) do
  if e.get_inventory(defines.inventory.chest).is_empty() and s.count_entities_filtered{type = "inserter", position = e.position, radius = 2} == 0 then out[#out + 1] = {x = e.position.x, y = e.position.y} end
end
return out`;

/** 按 size 格一片分组, 每片取包住它的范围 (外扩 1 格) */
export function clusters(spots: Spot[], size = 16): Area[] {
  const by = new Map<string, Spot[]>();
  for (const s of spots) { const k = `${Math.floor(s.x / size)},${Math.floor(s.y / size)}`; by.set(k, [...(by.get(k) ?? []), s]); }
  return [...by.values()].map((g) => ({
    left_top: { x: Math.floor(Math.min(...g.map((s) => s.x))) - 1, y: Math.floor(Math.min(...g.map((s) => s.y))) - 1 },
    right_bottom: { x: Math.ceil(Math.max(...g.map((s) => s.x))) + 1, y: Math.ceil(Math.max(...g.map((s) => s.y))) + 1 },
  }));
}

/** 选箱子: 先挑已经存着这种东西、有空格的最近的; 再挑有空格的最近的 */
// 有机械臂从里面取料的是供料箱, 不往里塞别的 (第一次实跑: 254 个木头塞进了给化工厂供煤的箱子)
export function pickChest(item: string, chests: { x: number; y: number; free: number; has: Record<string, boolean>; d: number; feeds?: boolean }[]) {
  const ok = chests.filter((c) => c.free > 0 && !c.feeds).sort((a, b) => a.d - b.d);
  return ok.find((c) => c.has?.[item]) ?? ok[0];
}

type Exec = (lua: string, args?: unknown) => Promise<any>;
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? x : []);
const why = (r: Reply) => (r.ok ? JSON.stringify(r.result?.completion ?? r.result ?? {}).slice(0, 200) : `${r.error?.code}: ${r.error?.message?.slice(0, 200)}`);

/** 清一遍; unit = 这个角色的实体编号 (查背包和附近箱子用) */
export async function cleanup(h: Harness, exec: Exec, unit: number, log: (s: string) => void): Promise<{ before: number; after: number; stored: Record<string, number> }> {
  const spots = arr<Spot>(await exec(OBSTACLE_LUA));
  log(`要清的树石 ${spots.length} 个, 分 ${clusters(spots).length} 片`);
  for (const area of clusters(spots)) {
    const d = await h.call("deconstruct", { area, entity_types: ["tree", "simple-entity"] });
    const c = await h.call("construct", { area }, { wait: true, timeoutMs: 240_000 });
    log(`  (${area.left_top.x},${area.left_top.y})~(${area.right_bottom.x},${area.right_bottom.y}): 标记 ${d.ok ? "ok" : why(d)}; 手砍 ${why(c)}`);
  }
  const after = arr<Spot>(await exec(OBSTACLE_LUA)).length;
  // 用完没收的空箱子 (第八轮的交接箱 62.5,42.5: 抽水机拿走后一直空着): 空的、旁边 2 格没有机械臂的收回
  for (const c of arr<{ x: number; y: number }>(await exec(EMPTY_CHEST_LUA))) {
    const m = await h.call("mine", { position: c, walk: true }, { wait: true, timeoutMs: 180_000 }); // 默认最多走 32 格 (第一次实跑 5 个太远没收)
    log(`  收回空箱子 (${c.x},${c.y}): ${why(m)}`);
  }
  // 材料进箱子
  const stored: Record<string, number> = {};
  let st = await exec(STORE_LUA, { unit });
  for (const item of Object.keys(st.held ?? {})) {
    let chest = pickChest(item, arr(st.chests));
    if (!chest) {
      // 附近没有空箱子: 用木头造一个木箱放在旁边
      await h.call("craft", { recipe: "wooden-chest", count: 1 });
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 3]]) {
        const b = await h.call("build", { item: "wooden-chest", position: { x: Math.floor(st.x) + dx + 0.5, y: Math.floor(st.y) + dy + 0.5 } }, { wait: true });
        if (b.ok) break;
      }
      st = await exec(STORE_LUA, { unit });
      chest = pickChest(item, arr(st.chests));
      if (!chest) { log(`  ${item}: 附近没有箱子, 也没造成, 留在背包里`); continue; }
    }
    const n = st.held?.[item] ?? 0;
    const t = await h.call("transfer", { position: { x: chest.x, y: chest.y }, item, count: n }, { wait: true });
    if (t.ok) stored[item] = n;
    log(`  ${item} ${n} 个 → 箱子 (${chest.x},${chest.y})${chest.has?.[item] ? " (原来就存着这种)" : ""}: ${t.ok ? "ok" : why(t)}`);
    st = await exec(STORE_LUA, { unit });
  }
  return { before: spots.length, after, stored };
}
