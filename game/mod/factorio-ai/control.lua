-- factorio-ai 沙盘模组: 沙盘身体的游戏内部分 (只用于本机沙盘, 不放到别人的服务器上)。
-- 规矩:
--   1. storage 只放数据 (不放函数、不放 LuaObject 的缓存);
--   2. 对外只有一个 remote 接口 "factorio-ai".rpc, RCON 和 UDP 快速通道都走它;
--   3. 事件统一由 on() 登记、一个分发函数调用, 不在运行时临时注册;
--   4. 每个回复都带 ok / error / tick, "没读到"和"读到空"分得清。

local production_score = require("production-score")
local agent = require("agent") -- 角色和模型的动作 (agent.lua)

local MOD_VERSION = script.active_mods["factorio-ai"]
local UDP_CHUNK = 60000 -- 单个 UDP 包的正文上限 (字节)
local COMPRESS_OVER = 4096 -- 回复超过这么长就压缩

---------------------------------------------------------------- 事件统一分发
local listeners = {}
local function on(event, fn)
  local list = listeners[event]
  if not list then
    list = {}
    listeners[event] = list
    script.on_event(event, function(e)
      for i = 1, #list do list[i](e) end
    end)
  end
  list[#list + 1] = fn
end

local function init_storage()
  if storage.udp == nil then storage.udp = false end
end
script.on_init(init_storage)
script.on_configuration_changed(init_storage)
on(defines.events.on_tick, function(e) agent.tick(e.tick) end)
on(defines.events.on_console_chat, agent.on_console_chat)

---------------------------------------------------------------- 小工具
local function surface_of(a)
  local s = game.surfaces[a.surface or "nauvis"]
  if not s then error("没有这个地表: " .. tostring(a.surface), 0) end
  return s
end

local function force_of(a)
  local f = game.forces[a.force or "player"]
  if not f then error("没有这个阵营: " .. tostring(a.force), 0) end
  return f
end

local function area_of(a)
  local ar = a.area
  if not ar then error("缺少 area: {{x1,y1},{x2,y2}}", 0) end
  local lt, rb = ar[1] or ar.left_top, ar[2] or ar.right_bottom
  return {
    left_top = { x = lt.x or lt[1], y = lt.y or lt[2] },
    right_bottom = { x = rb.x or rb[1], y = rb.y or rb[2] },
  }
end

-- 价格表只和原型有关, 不是存档状态, 放在本地变量里按需生成
local price_list

---------------------------------------------------------------- 给实验代码用的摆放函数 (exec 里直接用 lab.xxx)
-- 规矩: 位置一律从实体真实的碰撞盒算, 不手敲坐标 (2026-11-01: 3×3 的机器被游戏挪了半格、电线杆盖漏、管道丢在地上, 都是手算的错)。
lab = {}

-- 放一个实体; 放不下就报错 (带名字和位置), 不让 nil 往下传
function lab.place(p)
  local s = type(p.surface) == "string" and game.surfaces[p.surface] or p.surface
  if not p.allow_overlap and not s.can_place_entity { name = p.name, inner_name = p.inner_name, position = p.position, direction = p.direction, force = p.force or "player" } then
    local pos = p.position
    local px, py = pos.x or pos[1], pos.y or pos[2]
    local who = {}
    for _, o in pairs(s.find_entities_filtered { position = { px, py }, radius = 2 }) do if o.type ~= "character" then who[#who + 1] = o.name end end
    error(string.format("%s 放不下 (%s, %s): 和 %s 碰撞 (create_entity 默认不查碰撞, 这里替它查)", p.name, tostring(px), tostring(py), #who > 0 and table.concat(who, "、") or "地形"), 0)
  end
  local e = s.create_entity {
    name = p.name, position = p.position, direction = p.direction, force = p.force or "player",
    recipe = p.recipe, type = p.type, station = p.station, amount = p.amount, inner_name = p.inner_name, -- inner_name: 放虚影 (name = "entity-ghost")
    quality = p.quality, -- 品质名 (normal / uncommon / rare / epic / legendary)
  }
  if not e then
    local pos = p.position
    error(string.format("%s 放不下: (%s, %s)", p.name, tostring(pos.x or pos[1]), tostring(pos.y or pos[2])), 0)
  end
  return e
end

-- 往实体 (或它的某个格子) 里塞东西, 塞不全就报错 (inventory.insert 塞不下不报错, 只返回塞进去的数; 2026-11-01 塞 600 块铁板只进了 100)
function lab.insert(e, stack, inv_index)
  local target = inv_index and e.get_inventory(inv_index) or e
  local n = target.insert(stack)
  if n ~= stack.count then error(string.format("%s 只塞进 %d/%d 个 %s", e.name, n, stack.count, stack.name), 0) end
  return n
end

-- 找一个按网格对齐、放得下的位置: 偶数边长的中心在整数上, 奇数边长的在 .5 上; 由近到远一圈圈找, 每个点 can_place_entity 确认
-- (find_non_colliding_position 从不在网格上的中心步进, 返回的位置 create_entity 会再挪半格, 挪完可能压到别的东西; 2026-11-02 自动补杆压组装机)
function lab.find_spot(s, name, center, radius, force)
  local p = prototypes.entity[name]
  local ox = (p.tile_width % 2 == 0) and 0 or 0.5
  local oy = (p.tile_height % 2 == 0) and 0 or 0.5
  local cx = math.floor((center.x or center[1]) + 0.5 - ox) + ox
  local cy = math.floor((center.y or center[2]) + 0.5 - oy) + oy
  for r = 0, math.ceil(radius) do
    for dx = -r, r do
      for dy = -r, r do
        if math.max(math.abs(dx), math.abs(dy)) == r and s.can_place_entity { name = name, position = { cx + dx, cy + dy }, force = force or "player" } then
          return { cx + dx, cy + dy }
        end
      end
    end
  end
  return nil
end

-- 实体占的整格范围 (按碰撞盒取整): x1, y1 是左上格, x2, y2 是右下格 (含)
function lab.tiles(e)
  local b = e.bounding_box
  return { x1 = math.floor(b.left_top.x + 0.01), y1 = math.floor(b.left_top.y + 0.01), x2 = math.ceil(b.right_bottom.x - 0.01) - 1, y2 = math.ceil(b.right_bottom.y - 0.01) - 1 }
end

-- 某一侧紧挨着的那排格子的中心 (side = "north" / "south" / "west" / "east"); dist = 1 是贴着的一排, 2 是再外一排
function lab.slots(e, side, dist)
  dist = dist or 1
  local t = lab.tiles(e)
  local out = {}
  if side == "west" or side == "east" then
    local x = (side == "west") and (t.x1 - dist + 0.5) or (t.x2 + dist + 0.5)
    for y = t.y1, t.y2 do out[#out + 1] = { x = x, y = y + 0.5 } end
  else
    local y = (side == "north") and (t.y1 - dist + 0.5) or (t.y2 + dist + 0.5)
    for x = t.x1, t.x2 do out[#out + 1] = { x = x + 0.5, y = y } end
  end
  return out
end

-- 机械臂取货方向 = 它指向货源的方向: 货源在它的哪一边, direction 就是哪一边
lab.pickup_dir = { west = defines.direction.west, east = defines.direction.east, north = defines.direction.north, south = defines.direction.south }

-- 在实体头顶标一行字 (故意放错 / 对照组要标出来, 看窗口的人才分得清是设计还是 bug)
function lab.label(e, text, color)
  rendering.draw_text { text = text, surface = e.surface, target = { entity = e, offset = { 0, -1.6 } }, color = color or { 1, 0.85, 0.2 }, scale = 1.4, alignment = "center", use_rich_text = false }
  return e
end

-- 实体的流体接口连接点 (有配方的机器只有当前配方用到的接口有效, 逐个试到报错为止)
function lab.connections(e)
  local out = {}
  for i = 1, 8 do
    local ok, list = pcall(e.get_fluid_box_pipe_connections, i)
    if not ok then break end
    for _, c in pairs(list) do
      out[#out + 1] = { index = i, dir = c.flow_direction, x = c.position.x, y = c.position.y, tx = c.target_position and c.target_position.x, ty = c.target_position and c.target_position.y }
    end
  end
  return out
end

---------------------------------------------------------------- 方法
local methods = {}

function methods.ping()
  return {
    tick = game.tick,
    mod = MOD_VERSION,
    base = script.active_mods.base,
    space_age = script.active_mods["space-age"],
    speed = game.speed,
    paused = game.tick_paused,
    ticks_to_run = game.ticks_to_run,
    udp = storage.udp,
  }
end

-- 执行一段 Lua, 返回值要能转成 JSON。全局写入进一个私有表, 不污染模组。
function methods.exec(a)
  if type(a.code) ~= "string" then error("缺少 code", 0) end
  local env = setmetatable({}, { __index = _ENV })
  local chunk, err = load(a.code, "=lab", "t", env)
  if not chunk then error("编译失败: " .. tostring(err), 0) end
  return chunk(a.args)
end

-- 时间控制: speed (0.01 起), paused, run_ticks (暂停状态下精确跑 N 个 tick 再停)
function methods.time(a)
  if a.speed then game.speed = a.speed end
  if a.paused ~= nil then game.tick_paused = a.paused end
  if a.run_ticks then
    game.tick_paused = true
    game.ticks_to_run = a.run_ticks
  end
  return methods.ping()
end

-- 打开/关闭 UDP 轮询 (由宿主在确认 --enable-lua-udp 后打开)
function methods.udp(a)
  storage.udp = a.enabled and true or false
  return { udp = storage.udp }
end

-- 整理一块试验场: 生成区块、清空、铺地砖、可选铺矿、可选清掉整个地表的敌人
function methods.prepare_area(a)
  local surface, force, area = surface_of(a), force_of(a), area_of(a)
  local lt, rb = area.left_top, area.right_bottom
  local cx, cy = (lt.x + rb.x) / 2, (lt.y + rb.y) / 2
  local radius = math.ceil(math.max(rb.x - lt.x, rb.y - lt.y) / 64) + 1
  surface.request_to_generate_chunks({ cx, cy }, radius)
  surface.force_generate_chunk_requests()
  force.chart(surface, area)

  local removed = 0
  if a.clear ~= false then
    -- 铁轨上压着车时删不掉 (destroy 返回 false, 不报错): 先删车辆再删其他, 删完核对, 没删掉的直接报错
    -- (2026-11-01: 上一个实验的列车停在场地边上, 两段铁轨没删掉, 下一个实验铺轨撞上)
    local rolling = { locomotive = true, ["cargo-wagon"] = true, ["fluid-wagon"] = true, ["artillery-wagon"] = true }
    local list = surface.find_entities_filtered { area = area }
    for round = 1, 2 do
      for _, e in pairs(list) do
        if e.valid and e.type ~= "character" and (round == 2 or rolling[e.type]) then
          if e.destroy() then removed = removed + 1 end
        end
      end
    end
    local left = {}
    for _, e in pairs(list) do
      if e.valid and e.type ~= "character" then left[#left + 1] = string.format("%s (%s, %s)", e.name, e.position.x, e.position.y) end
    end
    if #left > 0 then error("清场没清干净, 删不掉: " .. table.concat(left, "、", 1, math.min(#left, 5)) .. (#left > 5 and (" 等 " .. #left .. " 个") or ""), 0) end
  end

  local tiles = {}
  if a.tile ~= false then
    local name = a.tile or "lab-dark-1"
    for x = math.floor(lt.x), math.ceil(rb.x) - 1 do
      for y = math.floor(lt.y), math.ceil(rb.y) - 1 do
        tiles[#tiles + 1] = { name = name, position = { x, y } }
      end
    end
    surface.set_tiles(tiles, true, true, true)
    surface.destroy_decoratives { area = area } -- 地砖铺好后把草之类的装饰物清掉, 看得清楚
  end

  local ore = 0
  if a.resource then
    local r = a.resource
    local rlt, rrb = lt, rb
    if r.area then
      local ra = area_of(r)
      rlt, rrb = ra.left_top, ra.right_bottom
    end
    for x = math.floor(rlt.x), math.ceil(rrb.x) - 1 do
      for y = math.floor(rlt.y), math.ceil(rrb.y) - 1 do
        surface.create_entity { name = r.name, position = { x + 0.5, y + 0.5 }, amount = r.amount or 100000 }
        ore = ore + 1
      end
    end
  end

  local enemies = 0
  if a.no_enemies then
    for _, e in pairs(surface.find_entities_filtered { force = "enemy" }) do
      e.destroy()
      enemies = enemies + 1
    end
    game.map_settings.enemy_expansion.enabled = false
  end
  return { removed = removed, tiles = #tiles, resource_tiles = ore, enemies_removed = enemies }
end

-- 放蓝图: 先拍幽灵, 再逐个复活成实体 (沙盘的上帝模式, 不耗物品)
function methods.place_blueprint(a)
  if type(a.string) ~= "string" then error("缺少蓝图字符串 string", 0) end
  local surface, force = surface_of(a), force_of(a)
  local inv = game.create_inventory(1)
  local ok, res = pcall(function()
    local stack = inv[1]
    stack.set_stack { name = "blueprint" }
    local code = stack.import_stack(a.string)
    if code == -1 then error("蓝图导入失败 (import_stack 返回 -1)", 0) end
    if not stack.is_blueprint_setup() then error("导入的不是可用的单张蓝图", 0) end
    local p = a.position or { 0, 0 }
    local target = { x = p.x or p[1], y = p.y or p[2] }
    local function build(pos)
      return stack.build_blueprint {
        surface = surface,
        force = force,
        position = pos,
        direction = a.direction,
        build_mode = defines.build_mode.forced,
        skip_fog_of_war = false,
        raise_built = false,
      }
    end
    -- 游戏按蓝图外框的中心对位; 默认 (anchor ~= "center") 改成"蓝图坐标原点落在 position":
    -- 先拍一次, 由幽灵位置反推偏移, 不对就拆掉按差值重拍
    local bp_ents = stack.get_blueprint_entities() or {}
    local function find_offset(ghosts)
      local have = {}
      for _, g in pairs(ghosts) do
        if g.valid then have[string.format("%s@%.2f,%.2f", g.ghost_name, g.position.x, g.position.y)] = true end
      end
      -- 大蓝图总有几十件放不下 (地形), 所以 90% 对上就算找到了偏移 (原来要求全部对上, 43125 件的基地对不上就没对齐)。
      -- 参照件要多试几件: 第一次拍下时游戏按外框中心对位, 整体平移过, 边上的件可能落在场地外没生成幽灵 (2026-11-01: 朋友基地的雷达 #1 就是这样, 反推失败后没重拍)
      local step = math.max(1, math.floor(#bp_ents / 16))
      for i = 1, #bp_ents, step do
        local b = bp_ents[i]
        for _, g in pairs(ghosts) do
          if g.valid and g.ghost_name == b.name then
            local dx, dy = g.position.x - b.position.x, g.position.y - b.position.y
            local hit = 0
            for _, e in pairs(bp_ents) do
              if have[string.format("%s@%.2f,%.2f", e.name, e.position.x + dx, e.position.y + dy)] then hit = hit + 1 end
            end
            if hit >= #bp_ents * 0.9 then return { x = dx, y = dy } end
          end
        end
      end
    end
    local ghosts = build(target)
    local offset
    if a.anchor ~= "center" and #bp_ents > 0 and not a.direction then
      offset = find_offset(ghosts)
      if offset and (offset.x ~= target.x or offset.y ~= target.y) then
        for _, g in pairs(ghosts) do if g.valid then g.destroy() end end
        ghosts = build { x = 2 * target.x - offset.x, y = 2 * target.y - offset.y }
        offset = find_offset(ghosts)
      end
    end
    local out = { import_warnings = (code == 1), ghosts = #ghosts, offset = offset, built = 0, failed = {}, failed_count = 0, entities = {}, moved_characters = 0 }
    if a.anchor ~= "center" and #bp_ents > 0 and not a.direction and not offset then out.align_error = "反推不出蓝图落点的偏移 (幽灵太少? 场地要盖住按外框中心对位的第一次落点)" end
    -- 游戏导入字符串时会把整张蓝图重新居中 (2026-11-01 实测: 朋友基地范围中心 (56,191), 坐标平移了 (-56,-190)), 还会重新编号 entity_number;
    -- 调用方把自己解码的第 index 件 (按顺序) 的名字和坐标传来当参照, 这里算出平移量
    if a.reference then
      local e = bp_ents[a.reference.index or 1]
      if e and e.name == a.reference.name then
        out.shift = { x = e.position.x - a.reference.x, y = e.position.y - a.reference.y }
      else
        out.shift_error = string.format("参照对不上: 游戏里第 %d 件是 %s", a.reference.index or 1, e and e.name or "nil")
      end
    end
    if a.revive ~= false then
      -- 角色站在幽灵上会让复活失败 (观看模式实测: 玩家刚连进来站在原点, 采矿机只剩幽灵), 先把角色挪到范围外的空地
      local box
      for _, g in pairs(ghosts) do
        if g.valid then
          local b = g.bounding_box
          if not box then
            box = { left_top = { x = b.left_top.x, y = b.left_top.y }, right_bottom = { x = b.right_bottom.x, y = b.right_bottom.y } }
          else
            box.left_top.x = math.min(box.left_top.x, b.left_top.x)
            box.left_top.y = math.min(box.left_top.y, b.left_top.y)
            box.right_bottom.x = math.max(box.right_bottom.x, b.right_bottom.x)
            box.right_bottom.y = math.max(box.right_bottom.y, b.right_bottom.y)
          end
        end
      end
      if box then
        for _, ch in pairs(surface.find_entities_filtered { area = box, type = "character" }) do
          local pos = surface.find_non_colliding_position("character", { box.right_bottom.x + 2, ch.position.y }, 20, 0.5)
          if pos and ch.teleport(pos) then out.moved_characters = out.moved_characters + 1 end
        end
      end
      for _, g in pairs(ghosts) do
        if g.valid then
          local name, pos = g.ghost_name, g.position
          local _, ent = g.revive { raise_revive = false }
          if ent and ent.valid then
            out.built = out.built + 1
            out.entities[#out.entities + 1] = { name = ent.name, x = ent.position.x, y = ent.position.y, direction = ent.direction, unit = ent.unit_number }
          elseif not g.valid then
            out.built = out.built + 1 -- 地砖幽灵复活后没有实体
          else
            out.failed[#out.failed + 1] = { name = name, x = pos.x, y = pos.y }
            out.failed_count = out.failed_count + 1
          end
        end
      end
    end
    return out
  end)
  inv.destroy()
  if not ok then error(res, 0) end
  return res
end

-- 统计一块区域里的实体和容器内物品
function methods.inspect(a)
  local surface, area = surface_of(a), area_of(a)
  local entities, items, status = {}, {}, {}
  local status_names = {}
  for k, v in pairs(defines.entity_status) do status_names[v] = k end
  for _, e in pairs(surface.find_entities_filtered { area = area, force = a.force or "player" }) do
    entities[e.name] = (entities[e.name] or 0) + 1
    if e.status then
      local s = status_names[e.status] or tostring(e.status)
      status[s] = (status[s] or 0) + 1
    end
    local inv = e.get_output_inventory and e.get_output_inventory()
    if e.type == "container" or e.type == "logistic-container" then inv = e.get_inventory(defines.inventory.chest) end
    if inv and inv.valid then
      for _, it in pairs(inv.get_contents()) do
        items[it.name] = (items[it.name] or 0) + it.count
      end
    end
  end
  return { entities = entities, status = status, items = items }
end

-- 产量: 游戏自带的 production-score (core/lualib), 加上逐个物品的产出和消耗
function methods.score(a)
  price_list = price_list or production_score.generate_price_list()
  local scores = production_score.get_production_scores(price_list)
  local force = force_of(a)
  local produced, consumed = {}, {}
  for _, surface in pairs(game.surfaces) do
    for _, stats in pairs { force.get_item_production_statistics(surface), force.get_fluid_production_statistics(surface) } do
      for name, n in pairs(stats.input_counts) do produced[name] = (produced[name] or 0) + n end
      for name, n in pairs(stats.output_counts) do consumed[name] = (consumed[name] or 0) + n end
    end
  end
  -- 自己再按"产出 - 消耗"全部算一遍, 用来和自带计分对照 (自带的只遍历消耗表, 只产不耗的物品可能不计入, 待沙盘核实)
  local net_value = 0
  for name, n in pairs(produced) do
    local p = price_list[name]
    if p then net_value = net_value + p * (n - (consumed[name] or 0)) end
  end
  for name, n in pairs(consumed) do
    if not produced[name] and price_list[name] then net_value = net_value - price_list[name] * n end
  end
  local prices = {}
  for name in pairs(produced) do prices[name] = price_list[name] end
  return {
    force = force.name,
    production_score = scores[force.name],
    all_net_value = math.floor(net_value),
    produced = produced,
    consumed = consumed,
    prices = prices,
  }
end

-- 给一块区域铺电网: 四角各一座广域配电站 (供电半边长 9, 40×40 的区域正好盖满) 互相连线, 再放一个供电的电力接口。
-- 这是实验里反复出错的地方 (靠心算摆电线杆, 四次盖漏了), 所以做成一键的; 返回配电站的位置, 方便读电网统计。
function methods.power_area(a)
  local surface, force, area = surface_of(a), force_of(a), area_of(a)
  local lt, rb = area.left_top, area.right_bottom
  local cx, cy = (lt.x + rb.x) / 2, (lt.y + rb.y) / 2
  -- 广域配电站的供电半边长和连线距离从原型读 (2.1.24: 9 / 18); 杆子间距 = 2 × 供电半边长 - 2, 既盖满又在连线距离内
  local proto = prototypes.entity["substation"]
  local supply = proto.get_supply_area_distance and proto.get_supply_area_distance() or 9
  local reach = proto.get_max_wire_distance and proto.get_max_wire_distance() or 18
  -- 标准 ±20 块的四角放在 ±supply: 供电方块正好拼满 (中间不留缝), 间距 2 × supply ≤ 连线距离才连得上
  -- (2026-11-01: 原来手写 ±10, 间距 20 > 18 连不上, 三根杆子成孤网, 被自动补杆盖住了好几轮; 数字一律从原型来)
  local inset = a.inset or math.min(supply, math.floor(reach / 2))
  local pitch = math.min(2 * supply - 2, reach)
  local function axis(lo, hi)
    local n = math.max(2, math.ceil((hi - lo) / pitch) + 1)
    if hi - lo <= 0 then return { (lo + hi) / 2 } end
    local out = {}
    for i = 0, n - 1 do out[#out + 1] = lo + (hi - lo) * i / (n - 1) end
    return out
  end
  -- 只有标准 ±20 实验区 (没传 inset、边长 ≤ 44) 保持原来的四角 (老实验的摆放依赖它); 其他区域一律按间距铺满 (2026-11-01: 炮塔走廊 33 格宽没铺满, 20 座炮塔靠 power_fix 补)
  local legacy = (a.inset == nil) and (rb.x - lt.x <= 44) and (rb.y - lt.y <= 44)
  local xs = (not legacy) and axis(lt.x + inset, rb.x - inset) or { cx - inset, cx + inset }
  local ys = (not legacy) and axis(lt.y + inset, rb.y - inset) or { cy - inset, cy + inset }
  if rb.y - lt.y <= 2 * inset then ys = { cy } end
  if rb.x - lt.x <= 2 * inset then xs = { cx } end
  local poles = {}
  for _, y in ipairs(ys) do
    for _, x in ipairs(xs) do
      local pos = surface.find_non_colliding_position("substation", { math.floor(x), math.floor(y) }, 4, 1)
      local e = pos and surface.create_entity { name = "substation", position = pos, force = force }
      if not e then error(string.format("配电站放不下: (%.1f, %.1f)", x, y), 0) end
      poles[#poles + 1] = e
    end
  end
  for i = 2, #poles do
    -- 连到离它最近的前一根 (间距按 pitch 排的, 都在连线距离内)
    local best, bd = nil, math.huge
    for j = 1, i - 1 do
      local d = math.abs(poles[j].position.x - poles[i].position.x) + math.abs(poles[j].position.y - poles[i].position.y)
      if d < bd then best, bd = poles[j], d end
    end
    local c1 = best.get_wire_connector(defines.wire_connector_id.pole_copper, true)
    local c2 = poles[i].get_wire_connector(defines.wire_connector_id.pole_copper, true)
    c1.connect_to(c2)
  end
  -- 电源放在第一根杆子 (左上角) 的外侧, 远离实验区中间 (四角改到 ±9 后电源跟着挪进了实验常用的位置, 和箱子撞上, 2026-11-01 回归)
  local epos = surface.find_non_colliding_position("electric-energy-interface", { poles[1].position.x - 3, poles[1].position.y }, 6, 1)
  local eei = epos and surface.create_entity { name = "electric-energy-interface", position = epos, force = force }
  if not eei then error("电力接口放不下", 0) end
  -- 连线失败不许静默: 所有杆子必须在同一张网
  local net = poles[1].electric_network_id
  for i = 2, #poles do
    if poles[i].electric_network_id ~= net then
      error(string.format("配电站没连成一张网: (%.0f,%.0f) 和 (%.0f,%.0f) 不同网, 间距 %.1f 超过连线距离?", poles[1].position.x, poles[1].position.y, poles[i].position.x, poles[i].position.y,
        math.sqrt((poles[1].position.x - poles[i].position.x) ^ 2 + (poles[1].position.y - poles[i].position.y) ^ 2)), 0)
    end
  end
  if eei.electric_network_id ~= net then error("电力接口没接到配电站的网上", 0) end
  local out = {}
  for _, e in ipairs(poles) do out[#out + 1] = { x = e.position.x, y = e.position.y } end
  return { poles = out, eei = { x = eei.position.x, y = eei.position.y }, network = poles[1].electric_network_id }
end

-- 检查一块区域里用电的东西是不是都有电: 返回没接上电网或状态是没电/电力不足的实体
function methods.unpowered(a)
  local surface, area = surface_of(a), area_of(a)
  local names = {}
  for k, v in pairs(defines.entity_status) do names[v] = k end
  local out = {}
  for _, e in pairs(surface.find_entities_filtered { area = area, force = a.force or "player" }) do
    -- 蓄电器 / 太阳能是发电侧, 它们的 no_power 是"没电可放", 不算没电 (朋友基地试放时 49 个蓄电器被算进去, 2026-11-01)
    if e.valid and e.type ~= "electric-pole" and e.type ~= "electric-energy-interface" and e.type ~= "accumulator" and e.type ~= "solar-panel" and e.prototype.electric_energy_source_prototype then
      local st = e.status and names[e.status]
      if e.electric_network_id == nil or st == "no_power" or st == "low_power" then
        out[#out + 1] = { name = e.name, x = e.position.x, y = e.position.y, status = st or "-", network = e.electric_network_id ~= nil }
      end
    end
  end
  return out
end

-- 引擎级核对 (蓝图检查的第三道关): 传送带邻居和形状、地下带配对、流体接口有没有接上、铁轨端点有没有接上、信号 / 车站有没有连到轨。
-- 每张清单最多 cap 条 (默认 50), 另给总数。静态检查器 (src/blueprint/check*.ts) 的每条规则在这里都有对应的引擎读数。
function methods.audit(a)
  local surface, area = surface_of(a), area_of(a)
  local cap = a.cap or 50
  -- 清单 = {n = 总数, items = {...前 cap 条}} (不能把计数写进数组表, 否则序列化成对象)
  local function list() return { n = 0, items = {} } end
  local function push(l, item) l.n = l.n + 1; if l.n <= cap then l.items[#l.items + 1] = item end end
  local function pos(e) return { name = e.name, x = e.position.x, y = e.position.y, dir = e.direction } end
  local belts = { total = 0, dead_end = list(), no_input = list(), shape = {}, ug_orphan = list(), curves = {}, dead_end_all = {} }
  local fluids = { entities = 0, connections = 0, linked = 0, open = list(), isolated = list(), boxes = list() }
  local rails = { total = 0, dead_end = list(), ends_connected = 0, ends_total = 0 }
  local signals = { total = 0, unconnected = list() }
  local stops = { total = 0, unconnected = list() }
  local belt_types = { ["transport-belt"] = true, ["underground-belt"] = true, ["splitter"] = true, ["lane-splitter"] = true, ["linked-belt"] = true, ["loader"] = true, ["loader-1x1"] = true }
  local want_boxes = {}
  for _, p in pairs(a.boxes or {}) do want_boxes[p[1] .. "," .. p[2]] = true end
  for _, e in pairs(surface.find_entities_filtered { area = area, force = a.force or "player" }) do
    if e.valid then
      local t = e.type
      if belt_types[t] then
        belts.total = belts.total + 1
        local nb = e.belt_neighbours
        if nb then
          if #nb.outputs == 0 and not (t == "underground-belt" and e.belt_to_ground_type == "input") then push(belts.dead_end, pos(e)); if a.shapes then belts.dead_end_all[#belts.dead_end_all + 1] = { e.position.x, e.position.y } end end
          if #nb.inputs == 0 and not (t == "underground-belt" and e.belt_to_ground_type == "output") then push(belts.no_input, pos(e)) end
        end
        if t == "transport-belt" then
          local sh = tostring(e.belt_shape)
          belts.shape[sh] = (belts.shape[sh] or 0) + 1
          if a.shapes and sh ~= "straight" then belts.curves[#belts.curves + 1] = { e.position.x, e.position.y } end
        end
        if t == "underground-belt" and e.underground_belt_neighbour == nil then push(belts.ug_orphan, pos(e)) end
      elseif t == "straight-rail" or t == "curved-rail-a" or t == "curved-rail-b" or t == "half-diagonal-rail" then
        rails.total = rails.total + 1
        for _, rd in pairs { defines.rail_direction.front, defines.rail_direction.back } do
          rails.ends_total = rails.ends_total + 1
          local connected = false
          for _, cd in pairs { defines.rail_connection_direction.left, defines.rail_connection_direction.straight, defines.rail_connection_direction.right } do
            if e.get_connected_rail { rail_direction = rd, rail_connection_direction = cd } then connected = true end
          end
          if connected then rails.ends_connected = rails.ends_connected + 1 else push(rails.dead_end, pos(e)) end
        end
      elseif t == "rail-signal" or t == "rail-chain-signal" then
        signals.total = signals.total + 1
        local ok, list = pcall(e.get_connected_rails)
        if not ok or not list or #list == 0 then push(signals.unconnected, pos(e)) end
      elseif t == "train-stop" then
        stops.total = stops.total + 1
        if not e.connected_rail then push(stops.unconnected, pos(e)) end
      end
      -- 流体接口 (2.1.24 没有 fluidbox 属性, 用 get_fluid_box_pipe_connections; 有配方的机器只有当前配方用到的箱子有效)
      if e.prototype.fluidbox_prototypes and #e.prototype.fluidbox_prototypes > 0 then
        fluids.entities = fluids.entities + 1
        local linked, total = 0, 0
        local mine = {}
        for i = 1, 8 do
          local ok, list = pcall(e.get_fluid_box_pipe_connections, i)
          if not ok then break end
          for _, c in pairs(list) do
            total = total + 1
            if c.target ~= nil then linked = linked + 1
            elseif c.connection_type ~= "underground" then push(fluids.open, { name = e.name, x = e.position.x, y = e.position.y, box = i, flow = c.flow_direction, cx = c.position.x, cy = c.position.y, tx = c.target_position and c.target_position.x, ty = c.target_position and c.target_position.y }) end
            mine[#mine + 1] = { box = i, flow = c.flow_direction, x = c.position.x, y = c.position.y, linked = c.target ~= nil }
          end
        end
        fluids.connections = fluids.connections + total
        fluids.linked = fluids.linked + linked
        if total > 0 and linked == 0 and t ~= "offshore-pump" then push(fluids.isolated, pos(e)) end
        if want_boxes[e.position.x .. "," .. e.position.y] then push(fluids.boxes, { name = e.name, x = e.position.x, y = e.position.y, recipe = (function() local ok, r = pcall(e.get_recipe); return ok and r and r.name or nil end)(), conns = mine }) end
      end
    end
  end
  local up = methods.unpowered(a)
  local unpowered = list()
  for _, u in ipairs(up) do push(unpowered, u) end
  return { belts = belts, fluids = fluids, rails = rails, signals = signals, stops = stops, unpowered = unpowered }
end

-- 给一批没电的实体补电: 每个实体旁边 (供电半边长以内) 放一座广域配电站 + 一个电力接口 (沙盘电是免费的); 位置用 find_non_colliding_position 找, 不手算
-- (2026-11-01: 实验里第五次手摆杆子盖漏后, ctx.powered() 改成发现没电就自动补并记录, 盖漏不再让结论作废)
function methods.power_fix(a)
  local surface, force = surface_of(a), force_of(a)
  local proto = prototypes.entity["substation"]
  local supply = proto.get_supply_area_distance and proto.get_supply_area_distance() or 9
  local fixed, failed = 0, {}
  for _, t in ipairs(a.targets or {}) do
    local e = surface.find_entities_filtered { position = { t.x, t.y }, radius = 0.5, force = force }[1]
    if e and e.valid and e.electric_network_id ~= nil and e.status ~= defines.entity_status.no_power then
      -- 已经有电了 (前一个补的杆子顺带盖到了)
    else
      local pos = lab.find_spot(surface, "substation", { t.x, t.y }, supply - 1.5, force)
      local sub = pos and surface.create_entity { name = "substation", position = pos, force = force }
      if sub then
        local ep = lab.find_spot(surface, "electric-energy-interface", { sub.position.x + 3, sub.position.y }, supply - 2, force)
        local eei = ep and surface.create_entity { name = "electric-energy-interface", position = ep, force = force }
        if not eei then failed[#failed + 1] = { x = t.x, y = t.y, why = "电力接口放不下" }
        elseif eei.electric_network_id ~= sub.electric_network_id then failed[#failed + 1] = { x = t.x, y = t.y, why = "电源没接到补的配电站上" }
        elseif e and e.valid and e.electric_network_id ~= sub.electric_network_id then failed[#failed + 1] = { x = t.x, y = t.y, why = "补了配电站目标还是不在它的网里" }
        else fixed = fixed + 1 end
      else
        failed[#failed + 1] = { x = t.x, y = t.y, why = "配电站放不下" }
      end
    end
  end
  return { fixed = fixed, failed = failed }
end

-- 把区域里玩家阵营的实体导成蓝图实体格式 (给静态检查器做布局核对; 不含角色、车辆、掉在地上的物品)
local SNAP_SKIP = { character = true, ["item-entity"] = true, locomotive = true, ["cargo-wagon"] = true, ["fluid-wagon"] = true, ["artillery-wagon"] = true, car = true, ["spider-vehicle"] = true,
  ["logistic-robot"] = true, ["construction-robot"] = true, ["entity-ghost"] = true, ["tile-ghost"] = true, ["electric-energy-interface"] = true, ["infinity-pipe"] = true } -- 永续箱不排除: 它是料源 (排除后机械臂被误报对着空地, 2026-11-01)
function methods.snapshot(a)
  local surface, area = surface_of(a), area_of(a)
  local out = {}
  for _, e in pairs(surface.find_entities_filtered { area = area, force = a.force or "player" }) do
    if e.valid and not SNAP_SKIP[e.type] then
      local rec = { entity_number = #out + 1, name = e.name, position = { x = e.position.x, y = e.position.y } }
      if e.supports_direction then rec.direction = e.direction end
      if e.type == "underground-belt" then rec.type = e.belt_to_ground_type end
      if e.type == "loader" or e.type == "loader-1x1" then rec.type = e.loader_type end
      if (e.type == "rail-signal" or e.type == "rail-chain-signal") and e.rail_layer == defines.rail_layer.elevated then rec.rail_layer = "elevated" end -- 高架上的信号 (蓝图格式同名字段) -- 装货 / 卸货 (原来没导, 检查器把带子→装卸机误报成顶错面)
      if e.type == "assembling-machine" or e.type == "furnace" then
        local ok, r = pcall(e.get_recipe)
        if ok and r then rec.recipe = r.name end
      end
      if e.type == "train-stop" then rec.station = e.backer_name end
      out[#out + 1] = rec
    end
  end
  return out
end

-- 给区域里每张电网接一个电力接口 (沙盘里试放别人的基地时没有燃料, 先把电供上, 剩下没电的才是覆盖问题)
function methods.power_networks(a)
  -- 给区域里每张电网接一个电力接口 (试放别人的蓝图时没燃料、没发电)。
  -- 2026-11-02 改: 原来在杆子供电范围内 find_non_colliding_position 找 2×2 空地, 排得密的蓝图 (冶炼列) 找不到, 失败不报错, 整张网没电;
  -- 现在 ① 按网格找 (lab.find_spot) ② 找不到就在连线距离内放一根中型电线杆接过去, 电力接口放它旁边 ③ 核对同网, 还不行就记进 failed。
  local surface, area = surface_of(a), area_of(a)
  local force = a.force or "player"
  local by_net = {}
  for _, pole in pairs(surface.find_entities_filtered { area = area, type = "electric-pole", force = force }) do
    local id = pole.valid and pole.electric_network_id
    if id then by_net[id] = by_net[id] or {}; table.insert(by_net[id], pole) end
  end
  local function supply(e) local ok, r = pcall(function() return e.prototype.get_supply_area_distance(e.quality) end) return ok and r or 2.5 end
  local function eei_near(center, radius, id)
    local pos = lab.find_spot(surface, "electric-energy-interface", center, radius, force)
    if not pos then return nil end
    local eei = surface.create_entity { name = "electric-energy-interface", position = pos, force = force }
    if eei and eei.electric_network_id == id then return eei end
    if eei then eei.destroy() end
    return nil
  end
  local networks, placed, bridged, failed = 0, 0, 0, {}
  for id, poles in pairs(by_net) do
    networks = networks + 1
    local done = false
    for _, pole in ipairs(poles) do
      if eei_near(pole.position, supply(pole) - 1, id) then done = true; placed = placed + 1; break end
    end
    if not done then
      local mp_proto = prototypes.entity["medium-electric-pole"]
      local reach = mp_proto.get_max_wire_distance and mp_proto.get_max_wire_distance() or 9
      for _, pole in ipairs(poles) do
        local pos = lab.find_spot(surface, "medium-electric-pole", pole.position, math.min(reach, pole.prototype.get_max_wire_distance and pole.prototype.get_max_wire_distance() or 7.5) - 1, force)
        if pos then
          local mp = surface.create_entity { name = "medium-electric-pole", position = pos, force = force }
          if mp then
            mp.get_wire_connector(defines.wire_connector_id.pole_copper, true).connect_to(pole.get_wire_connector(defines.wire_connector_id.pole_copper, true))
            if mp.electric_network_id == id and eei_near(mp.position, supply(mp) - 1, id) then done = true; placed = placed + 1; bridged = bridged + 1; break end
            mp.destroy()
          end
        end
      end
    end
    if not done then failed[#failed + 1] = { id = id, x = poles[1].position.x, y = poles[1].position.y } end
  end
  return { networks = networks, placed = placed, bridged = bridged, failed = { n = #failed, items = failed } }
end

-- 在游戏聊天框里说话 (观看模式的播报)
function methods.say(a)
  game.print(tostring(a.text), { color = a.color or { 0.45, 0.85, 1 } })
  return {}
end

-- 观看模式: 给已连进来的玩家开管理员、不会受伤、移到实验区、调缩放; 返回玩家名单
function methods.viewer(a)
  local names = {}
  for _, p in pairs(game.connected_players) do
    p.admin = true
    if p.character then p.character.destructible = false end
    -- 新档进来的玩家处在太空时代开场动画 (cutscene) 里, 传送和切远程视图都不生效 (2026-11-02 打出来是 MK@nauvis(cutscene)): 先退出
    if p.controller_type == defines.controllers.cutscene then pcall(p.exit_cutscene) end
    -- 观看用: 阵营解锁全部星球和航线 (只影响界面里能看到 / 选到哪, 不做研究、不改任何加成), 实验区周围标成已探索。
    --  —— 别的星球地表是脚本直接建的, 阵营没"发现"它们;
    -- 沙盘里没有雷达, 地图 / 远程视图里实验区是黑的
    local f = p.force
    for name in pairs(prototypes.space_location) do
      if not f.is_space_location_unlocked(name) then pcall(f.unlock_space_location, name) end
    end
    if a.position then
      local px, py = a.position.x or a.position[1], a.position.y or a.position[2]
      pcall(f.chart, a.surface or p.surface, { { px - 64, py - 64 }, { px + 64, py + 64 } })
    end
    if a.position then
      -- 实验在别的星球时, 角色传送过去可能失败 (只返回 false, 不报错); 失败就切成远程视图看那颗星球
      local ok = p.teleport(a.position, a.surface)
      if not ok or (a.surface and p.surface.name ~= (type(a.surface) == "string" and a.surface or a.surface.name)) then
        pcall(p.set_controller, { type = defines.controllers.remote, position = a.position, surface = a.surface })
      end
      if a.surface then p.print("[实验在 " .. (type(a.surface) == "string" and a.surface or a.surface.name) .. " 地表]") end
    end
    if a.zoom then p.zoom = a.zoom end
    local cn = {}
    for k, v in pairs(defines.controllers) do cn[v] = k end
    names[#names + 1] = p.name .. "@" .. p.surface.name .. "(" .. (cn[p.controller_type] or "?") .. ")"
  end
  local unlocked = 0
  for name in pairs(prototypes.space_location) do
    if game.forces.player.is_space_location_unlocked(name) then unlocked = unlocked + 1 end
  end
  return { players = names, count = #names, unlocked = unlocked }
end

-- 存档 (无界面服务器上 game.server_save 会写到 saves 目录)
function methods.save(a)
  game.server_save(a.name)
  return { saved = a.name or "(默认名)" }
end

---------------------------------------------------------------- 角色 (管理操作, 只有程序能调; 模型的命令行连不到这些)
function methods.agent_create(a) return agent.create(a.name) end
function methods.agent_remove(a) return agent.remove(a.name) end
function methods.agents() return { agents = agent.list() } end
function methods.agent_tell(a) return agent.tell(a.name, a.text) end
-- 模型的命令: 一个请求 {id, who, action, args} → 回复 {id, ok, tick, result | error} (agent.lua)
function methods.agent_dispatch(a) return agent.dispatch(a.request) end

---------------------------------------------------------------- 统一入口
local function rpc(request_json, compress)
  local reply
  local ok, req = pcall(helpers.json_to_table, request_json)
  if not ok or type(req) ~= "table" then
    reply = { ok = false, error = "请求不是 JSON 对象" }
  else
    local fn = methods[req.method]
    if not fn then
      reply = { ok = false, error = "没有这个方法: " .. tostring(req.method) }
    else
      local ok2, res = pcall(fn, req.args or {})
      if ok2 then
        reply = { ok = true, data = res }
      else
        reply = { ok = false, error = tostring(res) }
      end
    end
  end
  reply.tick = game.tick
  local s = helpers.table_to_json(reply)
  if compress == true or (compress == nil and #s > COMPRESS_OVER) then
    return "z:" .. helpers.encode_string(s)
  end
  return "j:" .. s
end

---------------------------------------------------------------- 喂料测产量 (数据集 measure 第二版, docs/blueprint-dataset.md)
-- feed_setup: 在引擎里追传送带 —— 每条带的起点往下游走, 看哪些机械臂从这条带取货、喂给什么配方, 就知道这条带该上什么料
-- (1 种两道都放, 2 种各占一道, 3 种以上不支持); 烧煤的机器加煤。带子尽头的上游有机械臂往上放东西的, 尽头收料计数。
-- 箱子: 只往里放的 = 收料箱 (定期清空计数), 只往外取的 = 料箱 (定期补满)。流体、采矿、实验室先不管, 记在 unsupported。
local FEED_CRAFTERS = { ["assembling-machine"] = true, ["furnace"] = true }
local FEED_CHESTS = { container = true, ["logistic-container"] = true }
local FEED_BELTS = { ["transport-belt"] = true, ["underground-belt"] = true, splitter = true, ["lane-splitter"] = true }

local function feed_recipe(e, hints)
  local ok, r = pcall(e.get_recipe)
  if ok and r then return r.prototype end
  if e.type == "furnace" then -- 炉子放下时没有配方: 按提示 (蓝图图标推出来的冶炼配方) 取第一个它能做的
    for _, name in ipairs(hints or {}) do
      local rp = prototypes.recipe[name]
      if rp then
        for _, c in pairs(rp.categories) do
          if e.prototype.crafting_categories[c] then return rp end
        end
      end
    end
  end
  return nil
end

local function feed_next(e)
  local out = {}
  if e.type == "underground-belt" and e.belt_to_ground_type == "input" and e.underground_belt_neighbour then out[1] = e.underground_belt_neighbour end
  local nb = e.belt_neighbours
  if nb then for _, o in pairs(nb.outputs) do out[#out + 1] = o end end
  return out
end

local function feed_prev(e)
  local out = {}
  if e.type == "underground-belt" and e.belt_to_ground_type == "output" and e.underground_belt_neighbour then out[1] = e.underground_belt_neighbour end
  local nb = e.belt_neighbours
  if nb then for _, o in pairs(nb.inputs) do out[#out + 1] = o end end
  return out
end

local function feed_reach(start, step)
  local seen, list, i = { [start.unit_number] = true }, { start }, 1
  while i <= #list do
    for _, n in ipairs(step(list[i])) do
      if n.valid and n.unit_number and not seen[n.unit_number] then
        seen[n.unit_number] = true
        list[#list + 1] = n
      end
    end
    i = i + 1
  end
  return list
end

local function feed_energy(poles)
  local total = 0
  for _, p in pairs(poles) do
    if p.valid then
      for _, v in pairs(p.electric_network_statistics.input_counts) do total = total + v end -- 电网统计: input = 耗电 (lab.md #14)
    end
  end
  return total
end

function methods.feed_setup(a)
  local surface, area = surface_of(a), area_of(a)
  local crafters, inserters, belts, chests, poles, others = {}, {}, {}, {}, {}, {}
  for _, e in pairs(surface.find_entities_filtered { area = area, force = a.force or "player" }) do
    local t = e.type
    if FEED_CRAFTERS[t] then crafters[#crafters + 1] = e
    elseif t == "inserter" then inserters[#inserters + 1] = e
    elseif FEED_BELTS[t] then belts[#belts + 1] = e
    elseif FEED_CHESTS[t] then chests[#chests + 1] = e
    elseif t == "electric-pole" then poles[e.electric_network_id or 0] = e
    elseif t == "mining-drill" or t == "lab" or t == "rocket-silo" or t == "boiler" then others[t] = (others[t] or 0) + 1 end
  end
  -- 沙盘阵营一开始很多配方没解锁 (第一次试跑 35% 的机器"配方没研究"); 只解锁配方, 不做研究 (研究会加机械臂容量等, 改变吞吐)
  local force = game.forces[a.force or "player"]
  force.enable_all_recipes()
  -- 按研究等级测 (a.research = "late"): 全部科技研究完 (机械臂抓取数 4 / 12 / 16、传送带堆叠、配方产能研究…); 不研究时后期设计被低估
  -- (数据集第三层: 电炉街区按车站卸货只有 65.7%, 集装机械臂没研究每手 1 个; facts inserter.hand-size-full-research)。整个阵营生效, 同一次运行里后面的蓝图都按这个测
  if a.research == "late" and not force.technologies["inserter-capacity-bonus-7"].researched then force.research_all_technologies() end
  local picks, drops = {}, {}
  for _, i in ipairs(inserters) do
    local pt, dt = i.pickup_target, i.drop_target
    if pt and pt.unit_number then picks[pt.unit_number] = picks[pt.unit_number] or {}; table.insert(picks[pt.unit_number], i) end
    if dt and dt.unit_number then drops[dt.unit_number] = drops[dt.unit_number] or {}; table.insert(drops[dt.unit_number], i) end
  end
  -- 炉子放下时没有配方, 要猜做什么: ① 看它的产物被下游谁要 (出料臂 → 带子往下游 / 机器 / 箱子再被取) ② 图标 ③ 铁板
  local smelt = {} -- 冶炼产物 → 配方名 (冶炼配方名和产物同名)
  for name, rp in pairs(prototypes.recipe) do
    for _, c in pairs(rp.categories) do
      if c == "smelting" then for _, p in pairs(rp.products) do if p.type == "item" and not smelt[p.name] then smelt[p.name] = name end end end
    end
  end
  local fixed = {} -- 已知配方的机器 (组装机等) 的原料
  for _, c in ipairs(crafters) do
    local ok, r = pcall(c.get_recipe)
    if ok and r then
      local need = {}
      for _, ing in pairs(r.prototype.ingredients) do if ing.type == "item" then need[ing.name] = true end end
      fixed[c.unit_number] = need
    end
  end
  local function downstream_needs(f)
    local acc = {}
    local function add_target(t)
      if not (t and t.valid and t.unit_number) then return end
      if fixed[t.unit_number] then for k in pairs(fixed[t.unit_number]) do acc[k] = true end
      elseif FEED_BELTS[t.type] then
        for _, x in ipairs(feed_reach(t, feed_next)) do
          for _, i in ipairs(picks[x.unit_number] or {}) do local d = i.drop_target if d and d.unit_number and fixed[d.unit_number] then for k in pairs(fixed[d.unit_number]) do acc[k] = true end end end
        end
      elseif FEED_CHESTS[t.type] then
        for _, i in ipairs(picks[t.unit_number] or {}) do local d = i.drop_target if d and d.unit_number and fixed[d.unit_number] then for k in pairs(fixed[d.unit_number]) do acc[k] = true end end end
      end
    end
    for _, i in ipairs(picks[f.unit_number] or {}) do add_target(i.drop_target) end
    local out = {}
    for k in pairs(acc) do if smelt[k] then out[#out + 1] = smelt[k] end end
    table.sort(out)
    return out
  end
  local icon_hints = {}
  for _, item in ipairs(a.icon_items or {}) do if smelt[item] then icon_hints[#icon_hints + 1] = smelt[item] end end
  icon_hints[#icon_hints + 1] = "iron-plate"
  local guessed = {}
  local unsupported = {}
  for t, n in pairs(others) do unsupported[t] = n end
  local info, produced, consumed, theory = {}, {}, {}, {}
  for _, c in ipairs(crafters) do
    local hints = icon_hints
    if not fixed[c.unit_number] and c.type == "furnace" then
      local d = downstream_needs(c)
      if #d > 0 then hints = d; guessed.by_downstream = (guessed.by_downstream or 0) + 1 else guessed.by_icon = (guessed.by_icon or 0) + 1 end
    end
    local rp = feed_recipe(c, hints)
    local need = {}
    if rp then
      for _, ing in pairs(rp.ingredients) do
        if ing.type == "item" then need[ing.name] = true; consumed[ing.name] = true end -- 流体在后面 (永续管道)
      end
      local crafts = 60 * c.crafting_speed / rp.energy -- 每分钟做几次 (crafting_speed 含插件和分享塔)
      for _, p in pairs(rp.products) do
        if p.type == "item" then
          produced[p.name] = true
          local amt = (p.amount or ((p.amount_min + p.amount_max) / 2)) * (p.probability or 1)
          local extra = math.max(0, amt - (p.ignored_by_productivity or 0)) * (c.productivity_bonus or 0)
          theory[p.name] = (theory[p.name] or 0) + crafts * (amt + extra)
        end
      end
    else
      unsupported.no_recipe = (unsupported.no_recipe or 0) + 1
    end
    local rates = {}
    if rp then
      local crafts = 60 * c.crafting_speed / rp.energy
      for _, ing in pairs(rp.ingredients) do if ing.type == "item" then rates[ing.name] = (rates[ing.name] or 0) + crafts * ing.amount end end
    end
    local bp = c.prototype.burner_prototype
    if bp and bp.fuel_categories["chemical"] then
      need["coal"] = true
      -- 燃料速度 = 满功率 (每 tick 焦耳 × 60) ÷ 煤的燃烧值 × 60 秒; 石炉 90kW / 4MJ ≈ 每分钟 1.35 个, 吃矿每分钟 18.75
      local ok, per_tick = pcall(function() return c.prototype.get_max_energy_usage(c.quality) end)
      if ok and per_tick then rates["coal"] = (rates["coal"] or 0) + per_tick * 60 * 60 / prototypes.item["coal"].fuel_value end
    end
    info[c.unit_number] = { need = need, rp = rp, rates = rates }
  end
  local function need_of_target(i, acc, w)
    local d = i.drop_target
    local inf = d and d.unit_number and info[d.unit_number]
    if inf then
      for k in pairs(inf.need) do acc[k] = true end
      if w then for k, r in pairs(inf.rates or {}) do w[k] = (w[k] or 0) + r end end
    end
  end
  -- 一条带 (从 b 往下游) 要上什么料: 下游机械臂喂的配方原料 - 往这条带上放的产物 - 蓝图里自己能做的
  local function belt_needs(b)
    local need, dropped, w = {}, {}, {}
    for _, x in ipairs(feed_reach(b, feed_next)) do
      for _, i in ipairs(picks[x.unit_number] or {}) do need_of_target(i, need, w) end
      for _, i in ipairs(drops[x.unit_number] or {}) do
        local p = i.pickup_target
        local inf = p and p.unit_number and info[p.unit_number]
        if inf and inf.rp then for _, pr in pairs(inf.rp.products) do if pr.type == "item" then dropped[pr.name] = true end end end
      end
    end
    local items = {}
    for k in pairs(need) do if not dropped[k] and not produced[k] then items[#items + 1] = k end end
    table.sort(items)
    return items, w
  end
  local feeds, sinks, starts = {}, {}, {}
  local function is_start(b)
    return #feed_prev(b) == 0 and not (b.type == "underground-belt" and b.belt_to_ground_type == "output") and b.type ~= "lane-splitter"
  end
  -- 设计自己有进料口 (下游有机械臂从箱子或车厢取货往这条带上放, 例: 车站 箱子 → 集装机械臂 → 带子): 起点不再额外喂, 不然一半运力被换成煤
  local function station_fed_of(b)
    for _, x in ipairs(feed_reach(b, feed_next)) do
      for _, i in ipairs(drops[x.unit_number] or {}) do
        local pt = i.pickup_target
        if pt == nil or (pt.valid and FEED_CHESTS[pt.type]) then return true end
      end
    end
    return false
  end
  -- 几条进料带要的料完全一样 (3 种以上、不含煤; 例: 组装机排的近带 + 长臂取的远带喂同一排机器): 分开放, 每道只放一种。
  -- 不分的话每条带每道轮流混放, 用量少的那种堆住整道 (2026-11-02 组装机排生成器)。用量大的先独占一条带, 其余两两一条
  local split, split_count = {}, 0
  do
    local groups = {}
    for _, b in ipairs(belts) do
      if is_start(b) and not station_fed_of(b) then
        local items, w = belt_needs(b)
        local coal = false
        for _, it in ipairs(items) do if it == "coal" then coal = true end end
        if #items >= 3 and not coal then
          local key = table.concat(items, ",")
          groups[key] = groups[key] or { items = items, w = w, members = {} }
          table.insert(groups[key].members, b)
        end
      end
    end
    for _, g in pairs(groups) do
      local n, k = #g.members, #g.items
      if n >= 2 and 2 * n >= k then
        local sorted = { table.unpack(g.items) }
        table.sort(sorted, function(x, y) return (g.w[x] or 0) > (g.w[y] or 0) end)
        table.sort(g.members, function(x, y) return x.unit_number < y.unit_number end)
        local solo, j = 2 * n - k, 1
        for m, b in ipairs(g.members) do
          local mine = {}
          if m <= solo then mine = { sorted[j] }; j = j + 1
          else
            mine = { sorted[j], sorted[j + 1] }; j = j + 2
          end
          table.sort(mine)
          split[b.unit_number] = mine
        end
        split_count = split_count + n
      end
    end
  end
  for _, b in ipairs(belts) do
    local is_ug = b.type == "underground-belt"
    if #feed_prev(b) == 0 and not (is_ug and b.belt_to_ground_type == "output") then
      if b.type == "lane-splitter" then
        unsupported.lane_splitter_start = (unsupported.lane_splitter_start or 0) + 1
      else
        local items = split[b.unit_number] or belt_needs(b)
        local station_fed = station_fed_of(b)
        if station_fed then unsupported.start_fed_by_design = (unsupported.start_fed_by_design or 0) + 1; items = {} end
        if #starts < 40 then starts[#starts + 1] = { x = b.position.x, y = b.position.y, type = b.type, items = items } end
        if #items >= 1 and #items <= 4 then
          -- 喂料口: 普通带子直接喂; 分流器 / 地下带在背后各接一格同级传送带当喂料口 (分流器的车道线从位置 0 插不进, 第二次试跑喂了 0 个)
          local ports = {}
          if b.type == "transport-belt" then ports = { b }
          else
            local v = ({ [defines.direction.north] = { 0, -1 }, [defines.direction.east] = { 1, 0 }, [defines.direction.south] = { 0, 1 }, [defines.direction.west] = { -1, 0 } })[b.direction]
            local belt_name = b.name:gsub("underground%-belt", "transport-belt"):gsub("splitter", "transport-belt")
            local spots = { { b.position.x - v[1], b.position.y - v[2] } }
            if b.type == "splitter" then
              local px, py = -v[2] * 0.5, v[1] * 0.5
              spots = { { b.position.x - v[1] + px, b.position.y - v[2] + py }, { b.position.x - v[1] - px, b.position.y - v[2] - py } }
            end
            if v and prototypes.entity[belt_name] then
              for _, sp in ipairs(spots) do
                if surface.can_place_entity { name = belt_name, position = sp, direction = b.direction, force = b.force } then
                  ports[#ports + 1] = surface.create_entity { name = belt_name, position = sp, direction = b.direction, force = b.force }
                end
              end
            end
            if #ports == 0 then unsupported.no_room_for_port = (unsupported.no_room_for_port or 0) + 1 end
          end
          -- 车道分配: 1~2 种: 两道各一种 (1 种两道一样); 3~4 种: 有煤就每个喂料口一道煤、另一道放矿 (分流器两半各分一半, 普通带子轮流), 没煤就轮流
          local fuel, rest = nil, {}
          for _, it in ipairs(items) do if it == "coal" and #items > 2 then fuel = it else rest[#rest + 1] = it end end
          for k, port in ipairs(ports) do
            local l1, l2
            if #items <= 2 then l1, l2 = { items[1] }, { items[2] or items[1] }
            elseif fuel then
              l1 = { fuel }
              if #ports > 1 then
                local mine = {}
                for j, it in ipairs(rest) do if (j - 1) % #ports == k - 1 then mine[#mine + 1] = it end end
                l2 = #mine > 0 and mine or rest
              else l2 = rest end
            else
              l1, l2 = {}, {}
              for j, it in ipairs(items) do if j % 2 == 1 then l1[#l1 + 1] = it else l2[#l2 + 1] = it end end
            end
            feeds[#feeds + 1] = { belt = port, lines = { { 1, l1 }, { 2, l2 } }, cursor = { 0, 0 } }
          end
        elseif #items > 4 then
          unsupported.start_over_4_items = (unsupported.start_over_4_items or 0) + 1
        end
      end
    end
    if #feed_next(b) == 0 and not (is_ug and b.belt_to_ground_type == "input") and b.type ~= "splitter" and b.type ~= "lane-splitter" then
      for _, x in ipairs(feed_reach(b, feed_prev)) do
        if drops[x.unit_number] then sinks[#sinks + 1] = b; break end
      end
    end
  end
  -- 装车臂: 从带子取货、却没有放货目标 (车厢不在蓝图里) 的机械臂 → 那条带也当出口, 收走做出来的东西 (城市街区的产物原本装火车)
  local seen_sink, wagon_taps = {}, 0
  for _, b in ipairs(sinks) do seen_sink[b.unit_number] = true end
  for _, i in ipairs(inserters) do
    local pt = i.pickup_target
    if pt and pt.valid and FEED_BELTS[pt.type] and pt.type ~= "splitter" and pt.type ~= "lane-splitter" and i.drop_target == nil and not seen_sink[pt.unit_number] then
      seen_sink[pt.unit_number] = true
      sinks[#sinks + 1] = pt
      wagon_taps = wagon_taps + 1
    end
  end
  local unloaders = {}
  for _, i in ipairs(inserters) do
    local d = i.drop_target
    if i.pickup_target == nil and d and d.valid then
      local items, w = {}, {}
      if FEED_BELTS[d.type] then items, w = belt_needs(d)
      elseif FEED_CHESTS[d.type] then
        -- 箱子再被机械臂取走: 放进机器的按机器原料, 放上带子的按带子往下游推 (车站: 车厢 → 机械臂 → 箱子 → 机械臂 → 带子)
        local need = {}
        for _, j in ipairs(picks[d.unit_number] or {}) do
          local t = j.drop_target
          if t and t.valid and FEED_BELTS[t.type] then
            local its, ws = belt_needs(t)
            for _, k in ipairs(its) do need[k] = true end
            for k, r in pairs(ws) do w[k] = (w[k] or 0) + r end
          else
            need_of_target(j, need, w)
          end
        end
        for k in pairs(need) do if not produced[k] then items[#items + 1] = k end end
        table.sort(items)
      end
      -- 按下游实际消耗的比例放 (第一次轮流放, 煤和矿各一半, 带子被煤堵满、炉子 84% 缺矿)
      local weights, given = {}, {}
      for _, k in ipairs(items) do weights[k] = math.max(w[k] or 0, 0.01); given[k] = 0 end
      if #items > 0 then unloaders[#unloaders + 1] = { ins = i, items = items, weights = weights, given = given } end
    end
  end
  local in_chests, out_chests = {}, {}
  for _, c in ipairs(chests) do
    -- 往箱子里放的里面不算卸车臂 (它们就是料的来源; 车站常见 车厢 → 机械臂 → 箱子 → 机械臂 → 带子)
    local d0, p = drops[c.unit_number], picks[c.unit_number]
    local d = nil
    for _, i in ipairs(d0 or {}) do if i.pickup_target ~= nil then d = d or {}; d[#d + 1] = i end end
    if d and not p then out_chests[#out_chests + 1] = c
    elseif p and not d then
      local need, items = {}, {}
      for _, i in ipairs(p) do need_of_target(i, need) end
      for k in pairs(need) do if not produced[k] then items[#items + 1] = k end end
      table.sort(items)
      if #items > 0 then in_chests[#in_chests + 1] = { chest = c, items = items } end
    end
  end
  -- 流体 (2026-11-05 化工厂类蓝图; docs/blueprint-dataset.md 下一步第 2 条): 配方要的流体从永续管道进, 流体产物流进永续管道并计数。
  -- 从机器的流体口沿管道找到整张管网, 在管网的空口接一节永续管道; 管网里要两种流体 = 蓝图接错了, 记 fluid_conflict。
  -- 2.1.24 探针: 配方只用一种流入流体时化工厂北面两个口通同一个箱 (fluids_count = 1); 硫磺 box 1 = 水 (西口)、box 2 = 石油气 (东口)
  local fluid_in, fluid_out = 0, 0
  local function fluid_conns(e, i) local ok, list = pcall(e.get_fluid_box_pipe_connections, i) return ok and list or {} end
  local claimed = {} -- 管网里的实体 unit_number → 流体名
  local function walk_net(first)
    local seen, list, open, i = { [first.unit_number] = true }, { first }, {}, 1
    while i <= #list do
      local e = list[i]
      for b = 1, e.fluids_count or 0 do
        for _, c in pairs(fluid_conns(e, b)) do
          if c.target and c.target.valid then
            if (c.target.type == "pipe" or c.target.type == "pipe-to-ground") and not seen[c.target.unit_number] then
              seen[c.target.unit_number] = true
              list[#list + 1] = c.target
            end
          elseif c.connection_type ~= "underground" and c.target_position then
            open[#open + 1] = c.target_position
          end
        end
      end
      i = i + 1
    end
    return list, open
  end
  local function plug(positions, name, percent)
    for _, p in ipairs(positions) do
      if surface.can_place_entity { name = "infinity-pipe", position = p, force = force } then
        local inf = surface.create_entity { name = "infinity-pipe", position = p, force = force }
        if inf then inf.set_infinity_pipe_filter { name = name, percentage = percent, mode = "exactly" } return true end
      end
    end
    return false
  end
  local function connect_box(c, i, name, is_input)
    local joined, open = false, {}
    for _, conn in pairs(fluid_conns(c, i)) do
      if conn.target and conn.target.valid and (conn.target.type == "pipe" or conn.target.type == "pipe-to-ground") then
        joined = true
        if claimed[conn.target.unit_number] then
          if claimed[conn.target.unit_number] ~= name then unsupported.fluid_conflict = (unsupported.fluid_conflict or 0) + 1 end
        else
          local net, ends = walk_net(conn.target)
          for _, e in ipairs(net) do claimed[e.unit_number] = name end
          if plug(ends, name, is_input and 1 or 0) then
            if is_input then fluid_in = fluid_in + 1 else fluid_out = fluid_out + 1 end
          else
            unsupported.fluid_no_room = (unsupported.fluid_no_room or 0) + 1
          end
        end
      elseif not (conn.target and conn.target.valid) and conn.target_position then
        open[#open + 1] = conn.target_position
      end
    end
    -- 没接管子的流体口 (蓝图只放了机器): 直接在口上接永续管道
    if not joined and plug(open, name, is_input and 1 or 0) then
      if is_input then fluid_in = fluid_in + 1 else fluid_out = fluid_out + 1 end
    end
  end
  local fluid_names = {}
  for _, c in ipairs(crafters) do
    local ok, r = pcall(c.get_recipe)
    local rp = ok and r and r.prototype
    if rp then
      local crafts = 60 * c.crafting_speed / rp.energy
      for _, ing in pairs(rp.ingredients) do if ing.type == "fluid" then consumed[ing.name] = true end end
      for _, p in pairs(rp.products) do
        if p.type == "fluid" then
          produced[p.name] = true
          fluid_names[p.name] = true
          theory[p.name] = (theory[p.name] or 0) + crafts * (p.amount or ((p.amount_min + p.amount_max) / 2)) * (p.probability or 1)
        end
      end
      for i = 1, c.fluids_count or 0 do
        local filt = c.get_fluid_filter(i)
        local conns = fluid_conns(c, i)
        if filt and conns[1] then connect_box(c, i, filt.name, conns[1].flow_direction ~= "output") end
      end
    end
  end
  local final = {}
  for k in pairs(produced) do if not consumed[k] then final[#final + 1] = k end end
  table.sort(final)
  storage.feed = { feeds = feeds, sinks = sinks, unloaders = unloaders, in_chests = in_chests, out_chests = out_chests, crafters = crafters, poles = poles,
    counts = {}, fed = {}, samples = {}, tick0 = game.tick, prod0 = {}, energy0 = feed_energy(poles), theory = theory, produced = produced, fluid_names = fluid_names, surface = surface.name }
  local fl = {}
  for _, f in ipairs(feeds) do fl[#fl + 1] = { x = f.belt.position.x, y = f.belt.position.y, type = f.belt.type } end
  local ic = {}
  for _, c in ipairs(in_chests) do ic[#ic + 1] = { x = c.chest.position.x, y = c.chest.position.y, items = c.items } end
  return { research = { inserter = force.inserter_stack_size_bonus, bulk = force.bulk_inserter_capacity_bonus, belt = force.belt_stack_size_bonus }, feeds = { n = #fl, items = fl }, sinks = #sinks, wagon_taps = wagon_taps, split_starts = split_count, unloaders = #unloaders, in_chests = { n = #ic, items = ic }, out_chests = #out_chests, crafters = #crafters, fluid_in = fluid_in, fluid_out = fluid_out,
    theory = theory, final = { n = #final, items = final }, unsupported = unsupported, furnace_guess = guessed, starts = { n = #starts, items = starts } }
end

-- 读数; reset = 从现在起重新计 (预热完调一次)
function methods.feed_stats(a)
  local F = storage.feed
  if not F then error("没有 feed_setup", 0) end
  local force_ = game.forces[a.force or "player"]
  local stats = force_.get_item_production_statistics(game.surfaces[F.surface])
  local fstats = force_.get_fluid_production_statistics(game.surfaces[F.surface])
  local function made(name) return ((F.fluid_names or {})[name] and fstats or stats).get_input_count(name) end
  if a.reset then
    F.counts, F.fed, F.samples, F.tick0 = {}, {}, {}, game.tick
    F.prod0 = {}
    for name in pairs(F.theory) do F.prod0[name] = made(name) end
    F.energy0 = feed_energy(F.poles)
    return { tick0 = F.tick0 }
  end
  local produced = {}
  for name in pairs(F.theory) do produced[name] = made(name) - (F.prod0[name] or 0) end
  return { ticks = game.tick - F.tick0, produced = produced, sink = F.counts, fed = F.fed, samples = F.samples, energy_j = feed_energy(F.poles) - F.energy0 }
end

function methods.feed_clear()
  storage.feed = nil
  return true
end

local status_names_feed
on(defines.events.on_tick, function(e)
  local F = storage.feed
  if not F then return end
  for _, f in ipairs(F.feeds) do
    if f.belt.valid then
      for k, li in ipairs(f.lines) do
        local line = f.belt.get_transport_line(li[1])
        local item = li[2][(f.cursor[k] % #li[2]) + 1]
        if line.can_insert_at(0) and line.insert_at(0, { name = item, count = 1 }) then
          F.fed[item] = (F.fed[item] or 0) + 1
          f.cursor[k] = f.cursor[k] + 1
        end
      end
    end
  end
  for _, u in ipairs(F.unloaders or {}) do
    local i = u.ins
    if i.valid and not i.held_stack.valid_for_read then
      local item, best = nil, nil
      for _, k in ipairs(u.items) do
        local score = u.given[k] / u.weights[k] -- 放得最"欠"的那种
        if not best or score < best then item, best = k, score end
      end
      local n = math.max(1, i.inserter_target_pickup_count or 1)
      if i.held_stack.set_stack { name = item, count = n } then
        F.fed[item] = (F.fed[item] or 0) + n
        u.given[item] = u.given[item] + n
      end
    end
  end
  if e.tick % 2 == 0 then
    for _, b in ipairs(F.sinks) do
      if b.valid then
        for i = 1, b.get_max_transport_line_index() do
          local line = b.get_transport_line(i)
          -- 只收里面做出来的东西; 原料留在带上 (第一次试跑尽头把喂进去的料全收走了, 机器反而缺料)
          for _, it in pairs(line.get_contents()) do
            if F.produced[it.name] then
              local n = line.remove_item { name = it.name, quality = it.quality, count = it.count }
              F.counts[it.name] = (F.counts[it.name] or 0) + n
            end
          end
        end
      end
    end
  end
  if e.tick % 60 == 0 then
    for _, c in ipairs(F.in_chests) do
      if c.chest.valid then
        for _, item in ipairs(c.items) do
          local want = prototypes.item[item].stack_size
          local have = c.chest.get_item_count(item)
          if have < want then c.chest.insert { name = item, count = want - have } end
        end
      end
    end
    for _, c in ipairs(F.out_chests) do
      if c.valid then
        local inv = c.get_inventory(defines.inventory.chest)
        for _, it in pairs(inv.get_contents()) do F.counts[it.name] = (F.counts[it.name] or 0) + it.count end
        inv.clear()
      end
    end
  end
  if e.tick % 300 == 0 then -- 每 5 秒抽一次机器状态
    if not status_names_feed then
      status_names_feed = {}
      for k, v in pairs(defines.entity_status) do status_names_feed[v] = k end
    end
    for _, c in ipairs(F.crafters) do
      if c.valid then
        local s = status_names_feed[c.status] or tostring(c.status)
        F.samples[s] = (F.samples[s] or 0) + 1
      end
    end
  end
end)

remote.add_interface("factorio-ai", { rpc = rpc })

---------------------------------------------------------------- UDP 快速通道
-- 请求: "<id>\n<json>"; 回复: "<id> <第几段> <共几段>\n<正文片段>", 正文和 RCON 回复同一格式。
-- 注意: 游戏暂停 (tick_paused) 时不跑 on_tick, UDP 不通, 宿主应退回 RCON。
on(defines.events.on_tick, function()
  if storage.udp then
    local ok = pcall(helpers.recv_udp)
    if not ok then storage.udp = false end -- 没加 --enable-lua-udp 就自动关掉, 不让每个 tick 报错
  end
end)

on(defines.events.on_udp_packet_received, function(e)
  local id, body = string.match(e.payload, "^(%S+)\n(.*)$")
  if not id then return end
  local reply = rpc(body, nil)
  local n = math.max(1, math.ceil(#reply / UDP_CHUNK))
  for i = 1, n do
    helpers.send_udp(e.source_port, id .. " " .. i .. " " .. n .. "\n" .. string.sub(reply, (i - 1) * UDP_CHUNK + 1, i * UDP_CHUNK))
  end
end)
