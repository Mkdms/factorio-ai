-- 一次性测试模组: 只在玩家的角色出现后往背包放东西, 不发也不收任何控制台命令。
-- 太空时代开局有坠机动画, 进游戏那一刻角色还没生成, 所以每秒看一次, 角色在了才放, 每个玩家只放一次。
local function give(player)
  if not (player and player.valid and player.character) then return false end
  local inv = player.get_main_inventory()
  if not inv then return false end
  inv.insert({ name = "locomotive", count = 1 })
  inv.insert({ name = "rail", count = 20 })
  inv.insert({ name = "solar-panel", count = 1 })
  player.print("[成就测试] 背包里放了 1 辆内燃机车、20 节铁轨、1 块太阳能板。请先放下太阳能板, 再铺几节铁轨把机车放上去, 然后直接关掉游戏窗口。")
  return true
end

script.on_nth_tick(60, function()
  storage.given = storage.given or {}
  for _, p in pairs(game.connected_players) do
    if not storage.given[p.index] and give(p) then storage.given[p.index] = true end
  end
end)
