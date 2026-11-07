-- 角色: 没有玩家、没有客户端的 character, 由模型的命令驱动, 按玩家的规矩玩 (够得着、只用背包里的东西、花真实时间)。
-- 模型的每条命令是一个请求 {id, who, action, args}, 经 dispatch 执行, 回 {id, ok, tick, result | error}。
-- 会改东西的请求按 id 记住回复: 断线重发同一个 id 拿到同一个回复, 不会做两次。
-- 管理操作 (建角色、收角色、给角色留言) 不在这里的动作表里, 在 control.lua 的 rpc 方法里, 模型的命令行连不到。
local A = {}

local RESPAWN_TICKS = 600          -- 死后多少 tick 重生 (和玩家一样 10 秒)
local SIGHT, SIGHT_TICKS = 48, 60  -- 角色周围保持探图的范围 (玩家的角色自动探, 没玩家的要我们探), 每秒一次
local CACHE_MAX = 256
local CHAT_MAX = 200
local FALLBACK_ITEMS = { ["iron-plate"] = 8, wood = 1, pistol = 1, ["firearm-magazine"] = 10, ["burner-mining-drill"] = 1, ["stone-furnace"] = 1 }

local function S()
  storage.agents = storage.agents or { by_name = {}, next = 1 }
  storage.agent_cache = storage.agent_cache or { order = {}, by_id = {} }
  storage.chat = storage.chat or {}
  return storage.agents
end

local function alive(a) return a.character ~= nil and a.character.valid end
local function force_of(a) return game.forces[a.force or "player"] end
local function surface_of(a) return game.get_surface(a.surface or "nauvis") or game.get_surface(1) end

---------------------------------------------------------------- 身体
local function starting_items()
  local ok, list = pcall(function()
    if remote.interfaces.freeplay and remote.interfaces.freeplay.get_created_items then return remote.call("freeplay", "get_created_items") end
  end)
  if ok and type(list) == "table" then return list end
  return FALLBACK_ITEMS
end

local function look(c)
  local p = c.position
  c.force.chart(c.surface, { { p.x - SIGHT, p.y - SIGHT }, { p.x + SIGHT, p.y + SIGHT } })
end

-- 出生点周围一圈一个位置 (12 个一圈, 离出生点 4 格, 每圈再远 3 格), 角色不叠在一起
local function slot_pos(origin, slot)
  local ring = math.floor((slot - 1) / 12)
  local angle = ((slot - 1) % 12) * 2 * math.pi / 12 + ring * math.pi / 12
  local r = 4 + ring * 3
  return { x = origin.x + r * math.cos(angle), y = origin.y + r * math.sin(angle) }
end

local function spawn(a, with_items)
  local force, surface = force_of(a), surface_of(a)
  local want = slot_pos(force.get_spawn_position(surface), a.slot or 1)
  local pos = surface.find_non_colliding_position("character", want, 32, 0.5) or want
  local c = surface.create_entity { name = "character", position = pos, force = force }
  if not c then error("造不出角色 " .. a.name, 0) end
  if with_items then
    for name, count in pairs(starting_items()) do if count > 0 then c.insert { name = name, count = count } end end
  end
  a.character = c
  a.position = c.position
  a.dead_until_tick = nil
  look(c)
  return c
end

function A.create(name)
  if type(name) ~= "string" or not name:match("^[A-Za-z][A-Za-z0-9._-]*$") or #name > 32 then error("角色名只能是字母开头的字母数字 ._- (最长 32)", 0) end
  local s = S()
  if s.by_name[name] then error("已经有角色 " .. name, 0) end
  for _, p in pairs(game.players) do if p.name == name then error("有玩家叫 " .. name, 0) end end
  local a = { name = name, slot = s.next, force = "player", surface = "nauvis", created_tick = game.tick, deaths = 0, mail = {} }
  spawn(a, true)
  s.next = s.next + 1
  s.by_name[name] = a
  return { name = name, unit = a.character.unit_number, position = a.character.position }
end

-- 收回: 角色原地倒下, 背包留在尸体里
function A.remove(name)
  local s = S()
  local a = s.by_name[name]
  if not a then error("没有角色 " .. tostring(name), 0) end
  local died = false
  if alive(a) then
    local c = a.character
    a.character = nil
    died = c.die() and true or false
    if c.valid then c.destroy() end
  end
  s.by_name[name] = nil
  return { name = name, removed = true, died = died }
end

function A.list()
  local out = {}
  for _, a in pairs(S().by_name) do
    out[#out + 1] = { name = a.name, alive = alive(a), position = alive(a) and a.character.position or a.position, unit = alive(a) and a.character.unit_number or nil, deaths = a.deaths, mail = #a.mail }
  end
  table.sort(out, function(x, y) return x.name < y.name end)
  return out
end

-- 管理员给角色留言 (模型下一次查状态会看到有几条, inbox 拿走)
function A.tell(name, text)
  local a = S().by_name[name]
  if not a then error("没有角色 " .. tostring(name), 0) end
  a.mail[#a.mail + 1] = { tick = game.tick, text = tostring(text) }
  return { queued = #a.mail }
end

function A.tick(tick)
  for _, a in pairs(S().by_name) do
    if alive(a) then
      if tick % 30 == 0 then a.position = a.character.position; a.surface = a.character.surface.name end
      if (tick + (a.slot or 0)) % SIGHT_TICKS == 0 then look(a.character) end
    elseif not a.dead_until_tick then
      a.character = nil
      a.dead_until_tick = tick + RESPAWN_TICKS
      a.deaths = (a.deaths or 0) + 1
    elseif tick >= a.dead_until_tick then
      pcall(spawn, a, false)
    end
  end
end

---------------------------------------------------------------- 聊天记录
local function push_chat(who, text)
  S()
  local chat = storage.chat
  chat[#chat + 1] = { tick = game.tick, who = who, text = text }
  while #chat > CHAT_MAX do table.remove(chat, 1) end
end

function A.on_console_chat(e)
  local p = e.player_index and game.get_player(e.player_index)
  push_chat(p and p.name or "server", tostring(e.message))
end

---------------------------------------------------------------- 动作 (模型能用的)
local status_names
local function status_name(v)
  if not status_names then
    status_names = {}
    for k, n in pairs(defines.entity_status) do status_names[n] = k end
  end
  return v and (status_names[v] or tostring(v)) or nil
end

local function dist(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end
local function r1(x) return math.floor(x * 10 + 0.5) / 10 end
local function xy(p) return { x = r1(p.x), y = r1(p.y) } end

local function body(a)
  if not alive(a) then error(string.format("角色 %s 没有身体 (死了, tick %s 重生); 先查 status", a.name, tostring(a.dead_until_tick)), 0) end
  return a.character
end

local ACTIONS = {}
local DOCS = {}

DOCS.describe = { doc = "列出全部动作和参数", args = {} }
function ACTIONS.describe() return { actions = DOCS } end

DOCS.status = { doc = "自己的状态: 位置、血量、在走 / 在挖、手搓队列、背包件数、留言数、死没死", args = {} }
function ACTIONS.status(a)
  local c = alive(a) and a.character or nil
  local inv = 0
  if c then for _, it in pairs(c.get_main_inventory().get_contents()) do inv = inv + it.count end end
  return {
    name = a.name, alive = c ~= nil, tick = game.tick, game_minutes = r1(game.tick / 3600),
    surface = c and c.surface.name or a.surface, position = c and xy(c.position) or (a.position and xy(a.position) or nil),
    health = c and r1(c.health) or nil, walking = c and c.walking_state.walking or false, mining = c and c.mining_state.mining or false,
    crafting_queue = c and c.crafting_queue_size or 0, inventory_items = inv, mail = #a.mail, deaths = a.deaths, dead_until_tick = a.dead_until_tick,
  }
end

DOCS.inventory = { doc = "背包里有什么、空格子数、手上拿着什么", args = {} }
function ACTIONS.inventory(a)
  local c = body(a)
  local inv = c.get_main_inventory()
  local items = {}
  for _, it in pairs(inv.get_contents()) do
    items[#items + 1] = { name = it.name, count = it.count, quality = (it.quality ~= "normal") and it.quality or nil }
  end
  table.sort(items, function(x, y) return x.count > y.count end)
  local hand = c.cursor_stack
  return { items = items, count = #items, free_slots = inv.count_empty_stacks(), hand = (hand and hand.valid_for_read) and { name = hand.name, count = hand.count } or nil }
end

DOCS.observe = { doc = "周围有什么: 矿 (按种类: 格数、总量、最近一处)、水、树、石头、敌人、我方建筑 (按距离, 带状态)、地上的东西", args = { radius = "数字, 默认 24, 最大 64", limit = "建筑最多列几个, 默认 40" } }
function ACTIONS.observe(a, args)
  local c = body(a)
  local radius = math.min(tonumber(args.radius) or 24, 64)
  local limit = tonumber(args.limit) or 40
  local me, surface = c.position, c.surface
  local resources, trees, rocks, enemies, buildings, ground = {}, { count = 0 }, { count = 0 }, { count = 0, spawners = 0 }, {}, {}
  for _, e in pairs(surface.find_entities_filtered { position = me, radius = radius }) do
    if e.valid and e ~= c then
      local d = dist(e.position, me)
      local t = e.type
      if t == "resource" then
        local r = resources[e.name]
        if not r then r = { tiles = 0, amount = 0, nearest = nil, dist = math.huge }; resources[e.name] = r end
        r.tiles = r.tiles + 1
        r.amount = r.amount + (e.amount or 0)
        if d < r.dist then r.dist = d; r.nearest = xy(e.position) end
      elseif t == "tree" then
        trees.count = trees.count + 1
        if not trees.dist or d < trees.dist then trees.dist = d; trees.nearest = xy(e.position) end
      elseif t == "simple-entity" then
        rocks.count = rocks.count + 1
        if not rocks.dist or d < rocks.dist then rocks.dist = d; rocks.nearest = xy(e.position) end
      elseif e.force.name == "enemy" then
        enemies.count = enemies.count + 1
        if t == "unit-spawner" then enemies.spawners = enemies.spawners + 1 end
        if not enemies.dist or d < enemies.dist then enemies.dist = d; enemies.nearest = xy(e.position); enemies.nearest_name = e.name end
      elseif t == "item-entity" then
        local st = e.stack
        if st and st.valid_for_read then ground[st.name] = (ground[st.name] or 0) + st.count end
      elseif e.force == c.force and t ~= "character" and t ~= "character-corpse" then
        buildings[#buildings + 1] = { name = e.name, position = xy(e.position), dist = r1(d), direction = e.supports_direction and e.direction or nil, status = status_name(e.status) }
      end
    end
  end
  table.sort(buildings, function(x, y) return x.dist < y.dist end)
  local total = #buildings
  while #buildings > limit do table.remove(buildings) end
  for _, r in pairs(resources) do r.dist = r1(r.dist) end
  if trees.dist then trees.dist = r1(trees.dist) end
  if rocks.dist then rocks.dist = r1(rocks.dist) end
  if enemies.dist then enemies.dist = r1(enemies.dist) end
  -- 最近的水 (找地砖, 不找实体)
  local water
  for _, tile in pairs(surface.find_tiles_filtered { position = me, radius = radius, name = { "water", "deepwater", "water-green", "deepwater-green", "water-shallow", "water-mud" }, limit = 400 }) do
    local p = { x = tile.position.x + 0.5, y = tile.position.y + 0.5 }
    local d = dist(p, me)
    if not water or d < water.dist then water = { position = xy(p), dist = r1(d) } end
  end
  return { position = xy(me), radius = radius, resources = resources, water = water, trees = trees, rocks = rocks, enemies = enemies, buildings = buildings, buildings_total = total, ground_items = ground }
end

DOCS.say = { doc = "在游戏聊天里说一句 (全队都看得到)", args = { text = "要说的话" } }
function ACTIONS.say(a, args)
  if type(args.text) ~= "string" or args.text == "" then error("缺少 text", 0) end
  local line = string.format("[%s] %s", a.name, args.text)
  game.print(line, { color = { 0.6, 0.9, 1 } })
  push_chat(a.name, args.text)
  return { said = args.text }
end

DOCS.chat = { doc = "最近的聊天 (玩家和角色说的)", args = { since = "只要这个 tick 之后的 (可选)", limit = "最多几条, 默认 20" } }
function ACTIONS.chat(_, args)
  S()
  local since, limit = tonumber(args.since) or -1, tonumber(args.limit) or 20
  local out = {}
  for i = #storage.chat, 1, -1 do
    local m = storage.chat[i]
    if m.tick <= since then break end
    table.insert(out, 1, m)
    if #out >= limit then break end
  end
  return { messages = out, count = #out, tick = game.tick } -- count: 空表回到程序里是 {} 不是 [], 用它判空
end

DOCS.inbox = { doc = "管理员给你的留言 (拿走后清空)", args = { keep = "true = 看了不清" } }
function ACTIONS.inbox(a, args)
  local out = a.mail
  if not args.keep then a.mail = {} end
  return { messages = out, count = #out }
end

-- 只读的不记回复缓存
local READ_ONLY = { describe = true, status = true, inventory = true, observe = true, chat = true, inbox = true }

---------------------------------------------------------------- 分发
local function remember(id, request_json, reply)
  local cache = storage.agent_cache
  cache.by_id[id] = { request = request_json, reply = reply }
  cache.order[#cache.order + 1] = id
  while #cache.order > CACHE_MAX do
    local old = table.remove(cache.order, 1)
    cache.by_id[old] = nil
  end
end

-- req: 已解析的表 {id, who, action, args}; 返回回复表 (由 rpc 再包一层)
function A.dispatch(req)
  S()
  if type(req) ~= "table" then return { ok = false, error = { code = "invalid_request", message = "请求不是对象" } } end
  local id = req.id
  if type(id) ~= "string" or #id < 1 or #id > 128 then return { ok = false, error = { code = "invalid_request", message = "id 要是 1~128 字符的字符串" } } end
  if type(req.action) ~= "string" then return { id = id, ok = false, error = { code = "invalid_request", message = "缺少 action" } } end
  local fn = ACTIONS[req.action]
  if not fn then
    local names = {}
    for k in pairs(ACTIONS) do names[#names + 1] = k end
    table.sort(names)
    return { id = id, ok = false, error = { code = "unknown_action", message = "没有动作 " .. req.action .. "; 有: " .. table.concat(names, " ") } }
  end
  local a = S().by_name[req.who]
  if not a then return { id = id, ok = false, error = { code = "unknown_agent", message = "没有角色 " .. tostring(req.who) } } end
  local args = req.args
  if args ~= nil and type(args) ~= "table" then return { id = id, ok = false, error = { code = "invalid_request", message = "args 要是对象" } } end
  args = args or {}
  local request_json = helpers.table_to_json(req)
  local prev = storage.agent_cache.by_id[id]
  if prev then
    if prev.request ~= request_json then return { id = id, ok = false, error = { code = "id_reused", message = "同一个 id 换了内容" } } end
    return prev.reply
  end
  local ok, result = pcall(fn, a, args)
  local reply = { id = id, ok = ok, tick = game.tick }
  if ok then reply.result = result else reply.error = { code = "action_failed", message = tostring(result) } end
  if not READ_ONLY[req.action] then remember(id, request_json, reply) end
  return reply
end

function A.actions()
  local names = {}
  for k in pairs(ACTIONS) do names[#names + 1] = k end
  table.sort(names)
  return names
end

return A
