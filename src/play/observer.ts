// 沙盘窗口只看 (库, 不直接运行):
// 全部角色都是服务器角色, 名字 = 模型名; 窗口是真人用户的只看身份 (观战控制器, 没有身体, 能看能说话), 名字另取。
// 新进来的玩家会带一个身体 (存档里还可能留着以前的身体), 背包交给指定角色, 放不下的进旁边的钢箱, 身体删掉, 不算死亡。

/** 窗口里真人用的名字 (局域网玩家名; 要独立版不登录才改得了, Steam 版名字取自 Steam 登录: docs/lab.md #61)。只能英文: 2026-11-05 实测写"管理员"进游戏名字是空的 (班次 2026-11-05T15-33-24) */
export const OBSERVER_NAME = "Admin";

/** 参数 a.unit = 接背包的角色实体编号 (没有就全进钢箱); 对全部玩家做: 在线的切只看, 不在线的只删身体 */
export const OBSERVER_LUA = `local a = ... local s = game.surfaces[1]
  local target
  if a and a.unit then for _, c in pairs(s.find_entities_filtered{name = "character", force = "player"}) do if c.unit_number == a.unit then target = c end end end
  local out = {bodies = 0, watching = 0, moved = 0, left = 0, chests = {}, names = {}}
  local chest
  local function newChest(at)
    local pos = s.find_non_colliding_position("steel-chest", at, 30, 1, true) if not pos then return nil end
    local c = s.create_entity{name = "steel-chest", position = pos, force = "player"}
    if c then out.chests[#out.chests + 1] = {x = c.position.x, y = c.position.y} end
    return c
  end
  local function take(st, at)
    if not st or not st.valid_for_read then return end
    local total = st.count
    local n = target and target.valid and target.insert(st) or 0
    local guard = 0
    while n < total and guard < 4 do
      guard = guard + 1
      if not chest then chest = newChest(at) if not chest then break end end
      st.count = total - n
      local m = chest.insert(st)
      n = n + m
      if n < total then chest = nil end
    end
    out.moved = out.moved + n
    out.left = out.left + (total - n)
    st.clear()
  end
  for _, p in pairs(game.players) do
    local c = p.character
    if c and c.valid then
      out.bodies = out.bodies + 1
      local at = c.position
      if p.connected then
        pcall(function() take(p.cursor_stack, at) end)
        if p.controller_type == defines.controllers.cutscene then pcall(p.exit_cutscene) end
      end
      pcall(function()
        local guard = 0
        while c.crafting_queue_size > 0 and guard < 200 do
          guard = guard + 1
          local q = c.crafting_queue[1]
          c.cancel_crafting{index = q.index, count = q.count}
        end
      end)
      for _, id in pairs({defines.inventory.character_main, defines.inventory.character_guns, defines.inventory.character_ammo, defines.inventory.character_armor, defines.inventory.character_trash}) do
        local inv = c.get_inventory(id)
        if inv then for i = 1, #inv do take(inv[i], at) end end
      end
      if p.connected then p.set_controller{type = defines.controllers.spectator} end
      if c.valid then c.destroy() end
    end
    if p.connected and p.controller_type ~= defines.controllers.spectator then p.set_controller{type = defines.controllers.spectator} end
    if p.connected then out.watching = out.watching + 1 out.names[#out.names + 1] = p.name end
  end
  return out`;

export type Handover = { bodies: number; watching: number; moved: number; left: number; chests: { x: number; y: number }[]; names: string[] };
/** lab.exec 的回复 → 结构 (字符串要再解一层; Lua 空表回来是 {}, 不是数组) */
export function normalizeHandover(raw: unknown): Handover {
  let o: any = raw;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { o = null; } }
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return { bodies: Number(o?.bodies) || 0, watching: Number(o?.watching) || 0, moved: Number(o?.moved) || 0, left: Number(o?.left) || 0, chests: arr(o?.chests), names: arr(o?.names).map(String) };
}
export function handoverText(h: Handover, to: string | null): string {
  const who = h.names.length ? `窗口 ${h.names.join("、")} 只看, 没有身体` : "窗口还没连上";
  if (!h.bodies) return who;
  const dest = h.chests.length ? `${to ? `交给 ${to}, ` : ""}放不下的进钢箱 ${h.chests.map((c) => `(${c.x}, ${c.y})`).join("、")}` : to ? `交给 ${to}` : "没有接的角色";
  return `${who}; 收了 ${h.bodies} 个身体, 物品 ${h.moved} 个${dest ? ` ${dest}` : ""}${h.left ? `, 还有 ${h.left} 个放不下丢了` : ""}`;
}
