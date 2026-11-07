// 带子的 Z 字弯检查 (库, 不直接运行):
// 带子走 a 方向 → 侧移 ≤ 3 格 → 又走回 a 方向。拐弯那格正前方是空地 (矿不算挡路) = 本来可以直着走。
// 作废那个世界 (2026-11-05T02-13-24 的存档) 2168 格带子里 36 处, 至少 14 处前方是空的。可能有合理的 (为了对准机械臂的落点), 所以只报事实和坐标, 改不改大脑定。
export const BELT_JOGS_LUA = `local s = game.surfaces[1]
  local at = {}
  local belts = s.find_entities_filtered{type = "transport-belt", force = "player"}
  for _, b in pairs(belts) do at[math.floor(b.position.x) .. "," .. math.floor(b.position.y)] = b end
  local D = {[0] = {0, -1}, [4] = {1, 0}, [8] = {0, 1}, [12] = {-1, 0}}
  local function nx(b) local v = D[b.direction] if not v then return nil end return at[(math.floor(b.position.x) + v[1]) .. "," .. (math.floor(b.position.y) + v[2])] end
  local out, n, free = {}, 0, 0
  for _, b in pairs(belts) do
    local a = b.direction
    local c1 = nx(b)
    if c1 and D[a] and c1.direction ~= a and (c1.direction - a) % 8 ~= 0 then
      local d2, run, cur = c1.direction, 1, c1
      while run <= 3 do
        local nn = nx(cur)
        if not nn then cur = nil break end
        if nn.direction ~= d2 then cur = nn break end
        cur = nn run = run + 1
      end
      if cur and run <= 3 and cur.direction == a then
        n = n + 1
        local v = D[a]
        local px, py = math.floor(c1.position.x) + v[1], math.floor(c1.position.y) + v[2]
        local blocked = false
        for _, e in pairs(s.find_entities_filtered{area = {{px + 0.1, py + 0.1}, {px + 0.9, py + 0.9}}}) do
          if e.type ~= "resource" and e.type ~= "item-entity" and e.type ~= "corpse" and e.type ~= "character" then blocked = true end
        end
        if not blocked then free = free + 1 if #out < 60 then out[#out + 1] = {x = c1.position.x, y = c1.position.y, run = run} end end
      end
    end
  end
  return {belts = #belts, jogs = n, free = free, list = out}`;

export type Jog = { x: number; y: number; run: number };
export type JogScan = { belts: number; jogs: number; free: number; list: Jog[] };

/** lab.exec 的回复 → 结构 (Lua 空表回来是 {}; 坏数据当没有) */
export function normalizeJogs(raw: unknown): JogScan {
  let o: any = raw;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { o = null; } }
  const list: Jog[] = (Array.isArray(o?.list) ? o.list : []).filter((j: any) => Number.isFinite(j?.x) && Number.isFinite(j?.y)).map((j: any) => ({ x: j.x, y: j.y, run: Number(j.run) || 1 }));
  return { belts: Number(o?.belts) || 0, jogs: Number(o?.jogs) || 0, free: Number(o?.free) || 0, list };
}

/** 这次新出现的 (seen 记着报过的坐标, 拆掉的从 seen 里去掉, 以后再出现还报) */
export function newJogs(list: Jog[], seen: Set<string>): Jog[] {
  const key = (j: Jog) => `${j.x},${j.y}`;
  const now = new Set(list.map(key));
  for (const k of [...seen]) if (!now.has(k)) seen.delete(k);
  const fresh = list.filter((j) => !seen.has(key(j)));
  for (const j of fresh) seen.add(key(j));
  return fresh;
}

/** 监工发给大脑的一句 (只给事实) */
export function jogNote(fresh: Jog[], max = 5): string {
  const where = fresh.slice(0, max).map((j) => `(${j.x}, ${j.y})`).join("、");
  return `新出现 ${fresh.length} 处带子 Z 字弯, 拐弯那格正前方是空地: ${where}${fresh.length > max ? " 等" : ""}。不是为了对准机械臂就把那一段改直 (拆了用 belt_route 重铺), 用户看着难受, 也多占地方。`;
}
