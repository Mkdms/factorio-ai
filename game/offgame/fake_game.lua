-- 模组在游戏外面跑时的假游戏接口 (game/offgame/host.py 加载)。
-- 数据来自 game/memory/live.py 的数据来源: 读活内存, 或核对时回放留底的快照; 每次提问 (__ask) 各读各的, 用到才读。
-- 读得到的给真值, 读不到的记进 __missing 然后回 nil, 不编数字。动作类一律报错: 这里只验证读。
-- Python 给的函数: __py_begin() → {tick, paused}; __py_rows_all(); __py_rows_chunks(列表); __py_row(地址); __py_world(); __py_player()
__missing = {}
local function note(path) __missing[path] = (__missing[path] or 0) + 1 end
-- 排查用: 模组自己 pcall 吞掉的错, 留最后一条的调用栈
__last_traceback = nil
do
  local raw_pcall = pcall
  -- 留第一条: 模组里一层层 pcall 再 error, 最后一条的调用栈只剩 error 那一行
  pcall = function(f, ...) return xpcall(f, function(e) if not __last_traceback then __last_traceback = debug.traceback(tostring(e), 2) end return e end, ...) end
  _G.__raw_pcall = raw_pcall
end
__module_count = 0

-- 记账的代理: 访问没实现的成员就记下来
local function tracked(name, known)
  return setmetatable(known or {}, {__index = function(_, k) note(name .. "." .. tostring(k)); return nil end})
end
-- 这几个成员真值就是 nil (不是我们没读), 不记缺
local function tracked_nil(name, known, nils)
  return setmetatable(known or {}, {__index = function(_, k) if nils[k] then return nil end note(name .. "." .. tostring(k)); return nil end})
end

-- ---------- 注入客户端的 Lua 补内存读不到的 (modhost_probe.py --lua) ----------
-- 注入客户端的只读查询 (world_query): 只开放被动查询, 任意 Lua 和会改状态的方法不收; 只在这一个客户端读, 不发给服务器。和 RCON 的 /silent-command 不是一回事。
-- 没开 --lua、这次提问的额度用完、或后台任务 → 回 nil, 调用方和原来一样记缺, 不编数字
local lua_entity_ref, lua_other_players -- 后面才定义: 按引用找实体、别的玩家
local lua_kind = "other" -- 算哪一份额度: 流体多, 分开算, 不抢物流网和别的玩家的份
local function lua_ask(req) return __py_lua and __py_lua(__py_json_encode(req), lua_kind) or nil end
local function as_fluid(f, ...)
  lua_kind = "fluid"
  local a, b = f(...)
  lua_kind = "other"
  return a, b
end
local function path_plus(path, step)
  local out = {}
  for i, s in ipairs(path or {}) do out[i] = s end
  out[#out + 1] = step
  return out
end
local function inspect_selection(target, path)
  local sel = {kind = "inspect", target = target}
  if path and #path > 0 then sel.path = path end
  return sel
end
-- 注入客户端的程序 0.0.11 起: values 模式 (默认) 不收 limit; 表在 values 里是预览 (数字键过 JSON 会变成字符串键),
-- 所以不给 fields 时同一次调用里再要一条相对读 entries (带原始键, 和原来一样); 结果不是表的话那一条单独报错, 不影响主结果
local function lua_inspect(target, path, fields)
  local req = {selection = inspect_selection(target, path)}
  if fields then req.fields = fields else req.reads = {{mode = "entries", limit = 256}} end
  local r = lua_ask(req)
  return r and r.objects and r.objects[1] or nil
end
local remote_object
-- 回复里的一个值 → Lua 值: 对象引用包成远程对象, 实体引用找回内存里的实体, 表逐项包
local function lua_wrap(v, target, path)
  if type(v) ~= "table" then return v end
  if v.object_name == "LuaEntity" then
    if v.position and v.unit_number then return lua_entity_ref(v) end
    -- 浅引用 (线路对方的 owner 这些) 不带位置: 再问一次, 才能对回内存里的实体
    local o = lua_inspect(target, path, {"name", "type", "unit_number", "position"})
    return lua_entity_ref(o and o.attributes or v)
  end
  if v.observation == "reference" and v.object_name then
    -- 引用里自带的身份字段 (注入客户端 0.0.11: name / index / id / unit_number / valid) 直接放上, 读名字不用再问一次
    local o = remote_object(target, path, v.object_name)
    for _, k in ipairs({"name", "index", "id", "unit_number"}) do if v[k] ~= nil then rawset(o, k, v[k]) end end
    return o
  end
  local out = {}
  for k, x in pairs(v) do out[k] = lua_wrap(x, target, path_plus(path, {index = k})) end
  return out
end
-- 条目 (entries 模式的回复) → Lua 表, 键保留原来的类型
local function lua_entries(en, target, path)
  local out = {}
  for _, x in ipairs(en) do if x.key ~= nil then out[x.key] = lua_wrap(x.value, target, path_plus(path, {index = x.key})) end end
  return out
end
-- 一次查询的结果: 单值 value、表 (相对读 reads[1] 的 entries)、对象 userdata、空 availability = nil
local function lua_result(o, target, path)
  if not o or o.availability == "nil" then return nil end
  local first = o.reads and o.reads[1]
  local en = first and first.entries
  if o.value_type == "userdata" and o.object_name then
    if en and o.object_name == "LuaCustomTable" then return lua_entries(en, target, path) end
    return remote_object(target, path, o.object_name)
  end
  if en then return lua_entries(en, target, path) end
  if o.value ~= nil then
    if type(o.value) == "table" then return lua_wrap(o.value, target, path) end
    return o.value
  end
  if o.entries then return lua_entries(o.entries, target, path) end
  return nil
end
-- 物流网、线路网络这些对象: 模组读哪个成员就问哪个 (每类的成员名只问一次)。对象每次提问都新造, 不跨提问留
local class_members = {}
local function members_of(class, target, path)
  local m = class_members[class]
  if m then return m end
  local r = lua_ask({selection = inspect_selection(target, path), mode = "members", limit = 500})
  local o = r and r.objects and r.objects[1]
  if not (o and o.members) then return nil end
  m = {}
  for _, x in ipairs(o.members) do m[x.name] = x.kind end
  class_members[class] = m
  return m
end
remote_object = function(target, path, class)
  local seen = {}
  return setmetatable({object_name = class, valid = true}, {__index = function(_, k)
    if seen[k] ~= nil then return seen[k] end
    local kind = (members_of(class, target, path) or {})[k]
    if kind == "method" then
      local f = function(...)
        local step = {method = k}
        if select("#", ...) > 0 then step.arguments = {...} end
        local p = path_plus(path, step)
        return lua_result(lua_inspect(target, p), target, p)
      end
      seen[k] = f
      return f
    end
    if kind == "attribute" then
      local o = lua_inspect(target, path, {k})
      local v = o and o.attributes and o.attributes[k]
      if v == nil then return nil end
      v = lua_wrap(v, target, path_plus(path, {property = k}))
      seen[k] = v
      return v
    end
    note(class .. "." .. tostring(k))
    return nil
  end})
end

-- ---------- 文件级全局 ----------
defines = __py_json_decode(__defines_json)
-- 嵌套的 defines (导出时只留了平表): 用到的再补
setmetatable(defines, {__index = function(t, k) note("defines." .. tostring(k)); local v = setmetatable({}, {__index = function(_, kk) note("defines." .. tostring(k) .. "." .. tostring(kk)); return kk end}); rawset(t, k, v); return v end})
storage = {}
function log(s) end
function localised_print(s) end
serpent = {line = function(v) return tostring(v) end, block = function(v) return tostring(v) end}
function table_size(t) local n = 0 for _ in pairs(t) do n = n + 1 end return n end

local handlers = {}
script = tracked("script", {
  -- ev 可以是一个事件或一串 (control.lua 的 forwarded 是一串)
  on_event = function(ev, f) if type(ev) == "table" then for _, e in ipairs(ev) do handlers[e] = f end else handlers[ev] = f end end, on_init = function(f) handlers.init = f end, on_load = function(f) handlers.load = f end,
  on_configuration_changed = function(f) handlers.cfg = f end, on_nth_tick = function(n, f) handlers["nth" .. tostring(n)] = f end,
  generate_event_name = function() return 90000 end, register_on_object_destroyed = function() return 1 end, active_mods = {base = "2.1.24", ["space-age"] = "2.1.24", quality = "2.1.24"}, level = {level_name = "freeplay", mod_name = nil}, mod_name = "agent-harness-party", raise_event = function() end,
  get_event_handler = function(ev) return handlers[ev] end, get_event_order = function() return {} end,
})
local interfaces = {}
remote = tracked("remote", {add_interface = function(name, t) interfaces[name] = t end, remove_interface = function(name) interfaces[name] = nil end, interfaces = interfaces, call = function(name, fn, ...) return interfaces[name][fn](...) end})
commands = tracked("commands", {add_command = function() end, remove_command = function() end, commands = {}, game_commands = {}})
rendering = tracked("rendering", {})
settings = tracked("settings", {global = {}, startup = {}, player = {}})
helpers = tracked("helpers", {
  table_to_json = function(t) return __py_json_encode(t) end, json_to_table = function(s) return __py_json_decode(s) end,
  is_valid_sound_path = function() return false end, is_valid_sprite_path = function() return false end, compare_versions = function() return 0 end,
  evaluate_expression = function() return 0 end, create_profiler = function() return tracked("profiler", {stop = function() end, restart = function() end, reset = function() end}) end, write_file = function() end,
})

local raw_proto = __py_json_decode(__proto_json)

-- ---------- 这一次提问读到的东西: 都是用到才读 ----------
local gen = 0            -- 第几次提问; 实体对象靠它知道自己的数据过期了
local now = {tick = 0, paused = false}
local world              -- 世界数据 (约 25 毫秒), 用到才读
local me                 -- 本地玩家
local rows_by_addr = {}  -- 这次读到的实体
local grid = {}          -- [cx][cy] = 中心在这个区块的实体
local loaded = {}        -- [cx][cy] = 这个区块读过了
local all_loaded = false
local names_index = {}
local ordered = {}       -- 读到的顺序 (按区块); 没范围的查询按这个顺序答, 和引擎的顺序一样 (2026-11-06 对真值)
local function W() if not world then world = __py_world() end return world end

local CHUNK = 32
local MARGIN = 16  -- 最大实体半边长 (中心在区块外也可能压进范围); 火箭发射井半边 < 16
-- 细节 (背包、状态、带子上的货) 用到才读: 全新地星几十万件, 一次提问真用到的只有几千件 (2026-11-06 剖析联机服务器的存档副本: 细节占读内存七成)
local ROW_MT = {__index = function(t, k)
  if (k == "d" or k == "status" or k == "d_error") and rawget(t, "__details") == nil then
    rawset(t, "__details", true)
    local addr = rawget(t, "addr")
    if addr and not rawget(t, "__dead") then
      local o = __py_row_details(addr)
      if o then for key, v in pairs(o) do rawset(t, key, v) end end
    end
    return rawget(t, k)
  end
  return nil
end}
local function add_to_index(row)
  if not getmetatable(row) then setmetatable(row, ROW_MT) end
  local cx, cy = math.floor(row.x / CHUNK), math.floor(row.y / CHUNK)
  local col = grid[cx]
  if not col then col = {}; grid[cx] = col end
  local cell = col[cy]
  if not cell then cell = {}; col[cy] = cell end
  cell[#cell + 1] = row
  local list = names_index[row.name]
  if not list then list = {}; names_index[row.name] = list end
  list[#list + 1] = row
  ordered[#ordered + 1] = row
end
local function add_rows(rows)
  for _, row in ipairs(rows) do
    local old = row.addr and rows_by_addr[row.addr]
    if old then
      -- 之前按地址单独读过 (不在索引里), 这次区块也读到了: 用老的那份进索引, 表还是同一张
      if old.__single then old.__single = nil add_to_index(old) end
    else
      if row.addr then rows_by_addr[row.addr] = row end
      add_to_index(row)
    end
  end
end
local owned_loaded = false
-- 只要有主的 (建筑、虫子): 树石矿占了大半, 转给 Lua 也要时间; 查询要它们才给
local function ensure_owned()
  if all_loaded or owned_loaded then return end
  add_rows(__py_rows_owned())
  owned_loaded = true
end
local function ensure_all()
  if all_loaded then return end
  if owned_loaded then add_rows(__py_rows_natural()) else add_rows(__py_rows_all()) end
  all_loaded = true
end
local function ensure_chunks(cx0, cx1, cy0, cy1)
  if all_loaded then return end
  local want = {}
  for cx = cx0, cx1 do
    local col = loaded[cx]
    if not col then col = {}; loaded[cx] = col end
    for cy = cy0, cy1 do
      if not col[cy] then col[cy] = true; want[#want + 1] = {cx, cy} end
    end
  end
  if #want > 0 then add_rows(__py_rows_chunks(want)) end
end
local function row_at(addr)
  if not addr or addr == 0 then return nil end
  local r = rows_by_addr[addr]
  if r then return r end
  r = __py_row(addr)
  if r then setmetatable(r, ROW_MT); r.__single = true; rows_by_addr[addr] = r end
  return r
end

-- 内存里效果值是 int32, 乘这个才是比例 (常量, pdb 没符号; 2026-11-06 对真值: 速度 + 产能插件, 原始 1500 = 研究中心读数 0.15)
local EFFECT_SCALE = 0.0001

-- ---------- 原型: 名字 → 类型来自游戏导出的数据; 字段名和 LuaXxxPrototype 不一样的在 PROTO_GET 里转 ----------
-- "60kW" → 每 tick 焦耳 (原型数据里是带单位的字符串; 引擎内部和 Lua 的 energy_usage 都是 焦耳 / tick)
local UNIT = {[""] = 1, k = 1e3, K = 1e3, M = 1e6, G = 1e9, T = 1e12, P = 1e15, E = 1e18}
local function joules_per_tick(s)
  if type(s) ~= "string" then return s end
  local n, u, kind = s:match("^([%d%.]+)([kKMGTPE]?)([WJ])$")
  if not n then return nil end
  local v = tonumber(n) * UNIT[u]
  if kind == "W" then v = v / 60 end
  return v
end
local PROTO_GET = {}
-- 导出数据里无限科技写 "infinite", 运行时是 uint32 上限; 不分级的是 1 (2.1.24 RCON 真值)
function PROTO_GET.max_level(p) if p.max_level == "infinite" then return 4294967295 end return p.max_level or 1 end
function PROTO_GET.level(p) return p.level or tonumber((p.name or ""):match("%-(%d+)$")) or 1 end
function PROTO_GET.max_health(p) return p.max_health end
function PROTO_GET.get_max_health(p) return function() return p.max_health end end
function PROTO_GET.get_researching_speed(p) return function() return p.researching_speed or 1 end end
function PROTO_GET.get_max_energy_usage(p) return function() return joules_per_tick(p.energy_usage) end end
function PROTO_GET.max_energy_usage(p) return joules_per_tick(p.energy_usage) end
function PROTO_GET.energy_usage(p) return joules_per_tick(p.energy_usage) end
-- 机器人的: 导出数据是 "5kJ" 这样的字符串, 运行时是数字; powercause.lua 拿来算术 (2026-11-06 真服 ./fh call power by_cause 崩)
function PROTO_GET.energy_per_move(p) return joules_per_tick(p.energy_per_move) end
function PROTO_GET.energy_per_tick(p) return joules_per_tick(p.energy_per_tick) end
function PROTO_GET.heating_energy(p) return joules_per_tick(p.heating_energy) or 0 end
function PROTO_GET.fuel_value(p) return joules_per_tick(p.fuel_value) or 0 end
function PROTO_GET.fuel_category(p) return p.fuel_category end
function PROTO_GET.max_underground_distance(p) return p.max_distance end
function PROTO_GET.filter_count(p) return p.filter_count or 0 end
function PROTO_GET.module_inventory_size(p) return p.module_slots or 0 end
function PROTO_GET.science_pack_drain_rate_percent(p) return p.science_pack_drain_rate_percent or 100 end
function PROTO_GET.products(p) local out = {} for i, r in ipairs(p.results or {}) do out[i] = {type = r.type or "item", name = r.name or r[1], amount = r.amount or r[2] or 1, probability = r.probability} end return out end
local function tile_size(p, axis)
  local box = p.collision_box
  if not box then return 0 end
  local lt, rb = box[1] or box.left_top, box[2] or box.right_bottom
  local a = axis == "x" and ((rb[1] or rb.x) - (lt[1] or lt.x)) or ((rb[2] or rb.y) - (lt[2] or lt.y))
  return math.ceil(a)
end
function PROTO_GET.tile_width(p) return p.tile_width or tile_size(p, "x") end
function PROTO_GET.tile_height(p) return p.tile_height or tile_size(p, "y") end
function PROTO_GET.get_max_power_output() return function() return nil end end
function PROTO_GET.get_max_energy_production() return function() return nil end end
function PROTO_GET.hidden(p) return p.hidden or false end
function PROTO_GET.bulk(p) return p.bulk or false end
function PROTO_GET.uses_inserter_stack_size_bonus(p) return p.uses_inserter_stack_size_bonus ~= false end
function PROTO_GET.inserter_stack_size_bonus(p) return p.stack_size_bonus or 0 end
function PROTO_GET.get_spoil_ticks(p) return function() return p.spoil_ticks or 0 end end
-- 机械臂的转速 / 伸缩速度 (圈 / tick, 原型的 rotation_speed / extension_speed; 快速机械臂 0.04 × 3600 = 每分钟 144 圈, 2.1.24 对真值)。
-- 品质对机械臂速度的加成没核: 普通品质照原型给, 别的品质记缺、也照原型给 (不编加成)
local function per_quality(field)
  return function(p) return function(q) if q and q.name and q.name ~= "normal" then note("prototype:inserter." .. field .. "(quality)") end return p[field] end end
end
PROTO_GET.get_inserter_rotation_speed = per_quality("rotation_speed")
PROTO_GET.get_inserter_extension_speed = per_quality("extension_speed")
function PROTO_GET.inserter_rotation_speed(p) return p.rotation_speed end
function PROTO_GET.inserter_extension_speed(p) return p.extension_speed end
function PROTO_GET.selectable_in_game(p) for _, f in ipairs(p.flags or {}) do if f == "not-selectable-in-game" then return false end end return true end
function PROTO_GET.flags(p) local out = {} for _, f in ipairs(p.flags or {}) do out[f] = true end return out end
-- 流体口 (LuaFluidBoxPrototype): 导出数据的 fluid_box / fluid_boxes / input_fluid_box / output_fluid_box 原样转成运行时的形状 (pipe_connections 的 direction 已是 0/4/8/12)。
-- 以前一律回空表, 模组的 pipe_route 报 "pipe-to-ground has no straight underground connection" (2026-11-08 核出来: 不装模组的路上铺不了水管)
local function fluid_box_proto(b, i)
  local conns = {}
  for j, c in ipairs(b.pipe_connections or {}) do
    conns[j] = {direction = c.direction or 0, connection_type = c.connection_type or "normal", flow_direction = c.flow_direction or "input-output", position = c.position and {x = c.position[1] or c.position.x, y = c.position[2] or c.position.y} or nil,
      positions = c.positions and (function() local t = {} for k, q in ipairs(c.positions) do t[k] = {x = q[1] or q.x, y = q[2] or q.y} end return t end)() or nil, max_underground_distance = c.max_underground_distance}
  end
  return {index = i, volume = b.volume, production_type = b.production_type or "none", pipe_connections = conns, filter = b.filter, object_name = "LuaFluidBoxPrototype", valid = true}
end
function PROTO_GET.fluidbox_prototypes(p)
  local out = {}
  local function add(b) if type(b) == "table" and b.pipe_connections then out[#out + 1] = fluid_box_proto(b, #out + 1) end end
  add(p.fluid_box); add(p.input_fluid_box); add(p.output_fluid_box)
  for _, b in ipairs(p.fluid_boxes or {}) do add(b) end
  return out
end
-- 占地框 / 选择框: 导出数据是 {{x0,y0},{x1,y1}}, 运行时是 {left_top={x,y}, right_bottom={x,y}} (模组的 construction.box 按后者读; 以前给数组, belt_route 报 "index field 'left_top'")
local function bbox(b)
  if type(b) ~= "table" then return nil end
  local lt, rb = b[1] or b.left_top, b[2] or b.right_bottom
  if not lt or not rb then return nil end
  return {left_top = {x = lt[1] or lt.x, y = lt[2] or lt.y}, right_bottom = {x = rb[1] or rb.x, y = rb[2] or rb.y}}
end
function PROTO_GET.collision_box(p) return bbox(p.collision_box) end
function PROTO_GET.selection_box(p) return bbox(p.selection_box) end
-- 碰撞层: 原型没写就是游戏按类型给的默认层 (utility-constants 的 default_collision_masks; 运行时的 collision_mask 也是这个)
function PROTO_GET.collision_mask(p)
  if p.collision_mask then return p.collision_mask end
  local u = raw_proto["utility-constants"] and raw_proto["utility-constants"].default or {}
  return u.default_collision_masks and u.default_collision_masks[p.type] or nil
end
-- 物品放出来的实体 (导出数据是名字, 运行时是实体原型); 电线杆的接线距离 / 供电范围 (按品质的函数, 品质加成没搬: 普通以外记缺)
function PROTO_GET.place_result(p) return type(p.place_result) == "string" and prototypes.entity[p.place_result] or nil end
function PROTO_GET.max_wire_distance(p) return p.maximum_wire_distance end
function PROTO_GET.get_max_wire_distance(p) return function(q) if q and q ~= "normal" and (type(q) ~= "table" or q.name ~= "normal") then note("prototype:pole.wire(quality)") end return p.maximum_wire_distance end end
function PROTO_GET.get_supply_area_distance(p) return function(q) if q and q ~= "normal" and (type(q) ~= "table" or q.name ~= "normal") then note("prototype:pole.supply(quality)") end return p.supply_area_distance end end
local function energy_proto(kind) return function(p) local s = p.energy_source if s and s.type == kind then return setmetatable({}, {__index = function(_, k) return s[k] end}) end return nil end end
PROTO_GET.electric_energy_source_prototype = energy_proto("electric")
PROTO_GET.burner_prototype = energy_proto("burner")
PROTO_GET.heat_energy_source_prototype = energy_proto("heat")
PROTO_GET.fluid_energy_source_prototype = energy_proto("fluid")
PROTO_GET.void_energy_source_prototype = energy_proto("void")
function PROTO_GET.heat_buffer_prototype(p) return nil end

local function proto_object(label, name, kind, p)
  local o = {name = name, type = p.type or kind, valid = true, object_name = "Lua" .. label .. "Prototype"}
  return setmetatable(o, {__index = function(t, k)
    local g = PROTO_GET[k]
    local v
    if g then v = g(p) else v = p[k] end
    if v == nil then if not g then note("prototype:" .. label .. "." .. tostring(k)) end return nil end
    rawset(t, k, v)
    return v
  end})
end
local function proto_table(kinds, label)
  return setmetatable({}, {__index = function(t, name)
    for _, kind in ipairs(kinds) do
      local p = raw_proto[kind] and raw_proto[kind][name]
      if p then
        local o = proto_object(label, name, kind, p)
        rawset(t, name, o)
        return o
      end
    end
    return nil
  end, __pairs = function(t)
    local names = {}
    for _, kind in ipairs(kinds) do for name in pairs(raw_proto[kind] or {}) do names[#names + 1] = name end end
    local i = 0
    return function() i = i + 1; local n = names[i]; if n then return n, t[n] end end
  end})
end
-- 实体种类: 导出的原始数据按种类分表, 有占地框的才算实体 (物品、配方这些表也有同名条目, 比如 lab 既是物品也是实体)
local ENTITY_KINDS = {}
for kind, rows in pairs(raw_proto) do
  for _, p in pairs(rows) do
    if type(p) == "table" and (p.selection_box or p.collision_box) then ENTITY_KINDS[#ENTITY_KINDS + 1] = kind end
    break
  end
end
local utility = raw_proto["utility-constants"] and raw_proto["utility-constants"].default or {}
-- prototypes.get_xxx_filtered: 只认 type (和实体的 crafting-category), 够模组用; 别的过滤条件记缺, 回空表, 不瞎猜
local function filtered(kinds, label)
  return function(filters)
    local out = {}
    for _, f in ipairs(filters or {}) do
      if f.filter == "type" then
        local want = {}
        if type(f.type) == "table" then for _, t in ipairs(f.type) do want[t] = true end else want[f.type] = true end
        for _, kind in ipairs(kinds) do
          for name, p in pairs(raw_proto[kind] or {}) do
            if want[p.type or kind] then out[name] = prototypes[label][name] end
          end
        end
      elseif f.filter == "crafting-category" and label == "entity" then
        for _, kind in ipairs(kinds) do
          for name, p in pairs(raw_proto[kind] or {}) do
            for _, c in ipairs(p.crafting_categories or {}) do if c == f.crafting_category then out[name] = prototypes.entity[name] end end
          end
        end
      else note("prototypes.get_" .. label .. "_filtered." .. tostring(f.filter)) end
    end
    return out
  end
end
prototypes = tracked("prototypes", {utility_constants = utility, item = proto_table({"item", "ammo", "gun", "armor", "capsule", "tool", "module", "rail-planner", "repair-tool", "item-with-entity-data", "blueprint", "deconstruction-item", "upgrade-item", "selection-tool", "space-platform-starter-pack"}, "item"), entity = proto_table(ENTITY_KINDS, "entity"), recipe = proto_table({"recipe"}, "recipe"), fluid = proto_table({"fluid"}, "fluid"), technology = proto_table({"technology"}, "technology"), quality = proto_table({"quality"}, "quality"), tile = proto_table({"tile"}, "tile"), space_location = proto_table({"planet", "space-location"}, "space_location"), mod_data = {}, surface_property = {}})

rawset(prototypes, "get_entity_filtered", filtered(ENTITY_KINDS, "entity"))
rawset(prototypes, "get_item_filtered", filtered({"item", "ammo", "gun", "armor", "capsule", "tool", "module", "rail-planner", "repair-tool", "item-with-entity-data", "blueprint", "deconstruction-item", "upgrade-item", "selection-tool", "space-platform-starter-pack"}, "item"))
rawset(prototypes, "get_recipe_filtered", function() note("prototypes.get_recipe_filtered") return {} end)

-- ---------- 背包 ----------
local function inventory(name, list, size, slots, index)
  list = list or {}
  local inv = {valid = true, name = name, index = index or 1}
  local used = #list
  if slots then used = 0 for _, s in ipairs(slots) do if s ~= 0 then used = used + 1 end end end
  function inv.get_contents() local out = {} for i, s in ipairs(list) do out[i] = {name = s.name, quality = s.quality or "normal", count = s.count} end return out end
  function inv.get_item_count(n) local c = 0 for _, s in ipairs(list) do if not n or s.name == n or (type(n) == "table" and s.name == n.name) then c = c + s.count end end return c end
  function inv.is_empty() return #list == 0 end
  function inv.count_empty_stacks() return (size or used) - used end
  function inv.is_full() return used >= (size or used) end
  function inv.get_bar() return (size or used) + 1 end
  return setmetatable(inv, {__index = function(_, k)
    if type(k) == "number" then
      local s
      if slots then s = slots[k]; if s == 0 then s = nil end else s = list[k] end
      if s then return {valid = true, valid_for_read = true, name = s.name, count = s.count, quality = {name = s.quality or "normal"}, prototype = prototypes.item[s.name]} end
      return {valid = true, valid_for_read = false}
    end
    note("LuaInventory." .. tostring(k))
    return nil
  end, __len = function() return size or used end})
end

-- ---------- 统计: 内存里是采样 (world.py); get_flow_count 的公式对过真值 (2026-11-06, 五种统计 2303 项 0 差) ----------
-- 窗口正好 300 个间隔: 当前没满的采样 + 最近 299 个 + 第 300 个按相位折算; 平均值 = 窗口内总数 / 窗口分钟数
local function flow_sum(el, interval, tick)
  if not el then return 0 end
  return (el.cur or 0) + (el.recent or 0) + (1 - ((tick - 1) % interval) / interval) * (el.oldest or 0)
end
local function flow_key(id)
  if type(id) ~= "table" then return id end
  local n, q = id.name, id.quality
  if type(n) == "table" then n = n.name end
  if type(q) == "table" then q = q.name end
  if q and q ~= "normal" then return n .. "@" .. q end
  return n
end
local function by_name_total(t)
  local out = {}
  for k, v in pairs(t or {}) do local base = tostring(k):gsub("@.*$", ""); out[base] = (out[base] or 0) + v end
  return out
end
-- 电网统计 (network 给的话): 平均值是每 tick (2026-11-06 对真值: 研究中心 491.2 kW = 平均 × 60 / 1000), 别的统计是每分钟; count = true 是接着的机器台数
local function flow_object(f, network)
  f = f or {}
  local o = {valid = true, object_name = "LuaFlowStatistics", input_counts = by_name_total(f.input), output_counts = by_name_total(f.output), storage_counts = by_name_total(f.storage)}
  local function count_of(cat, id) return (f[cat] or {})[flow_key(id)] or 0 end
  function o.get_input_count(id) return count_of("input", id) end
  function o.get_output_count(id) return count_of("output", id) end
  function o.get_storage_count(id) return count_of("storage", id) end
  function o.get_flow_count(a)
    if a.sample_index ~= nil then note("get_flow_count.sample_index") return 0 end
    local row = (f.precisions or {})[(a.precision_index or 0) + 1]
    if not row then return 0 end
    local sum = flow_sum((row[a.category or "input"] or {})[flow_key(a.name)], row.interval, now.tick)
    if network then
      if a.count then return (network.counts or {})[flow_key(a.name)] or 0 end
      return sum / (row.interval * 300)
    end
    if a.count then return sum end
    return sum / (row.interval * 300 / 3600)
  end
  return tracked("LuaFlowStatistics", o)
end

-- ---------- 势力和科技: 每次提问重新从世界数据取 ----------
local player  -- 下面"玩家"一节才建; 势力要用
local generated_chunks  -- 下面"地表"一节才建; 势力要用
local forces_by_id = {}
local forces_by_name = {}
local surface
local function tech_level(name) local n = name:match("%-(%d+)$"); return n and tonumber(n) or 1 end
local function force_object(name)
  local function FS() return (W().forces or {})[name] or {} end
  local force = {name = name, valid = true, object_name = "LuaForce"}
  local tech_gen, tech_cache, stat_cache = -1, {}, {}
  local function fresh() if tech_gen ~= gen then tech_gen = gen; tech_cache = {}; stat_cache = {} end end
  local techs = setmetatable({}, {__index = function(_, tname)
    fresh()
    local t = tech_cache[tname]
    if t then return t end
    local raw = raw_proto.technology and raw_proto.technology[tname]
    if not raw then return nil end
    local m = (FS().technologies or {})[tname] or {}
    local unit = raw.unit or {}
    local ingredients = {}
    for i, ing in ipairs(unit.ingredients or {}) do ingredients[i] = {name = ing[1] or ing.name, type = "item", amount = ing[2] or ing.amount} end
    -- 无限科技 (2026-11-06 联机服务器的存档副本, 沙盘没玩到这里): 等级 = 基础 + 研究过几次, 永远不算研究完, 花费按公式 (RCON 真值: physical-projectile-damage-7 L=11 16000 份, asteroid-productivity L=5 7593 份)
    local endless = raw.max_level == "infinite"
    local level = tech_level(tname) + (endless and (m.count or 0) or 0)
    local units = unit.count
    if not units and unit.count_formula then
      local f = load("return " .. unit.count_formula:gsub("L", tostring(level)))
      units = f and math.floor(f()) or nil
    end
    local tech = {name = tname, valid = true, object_name = "LuaTechnology", force = force, researched = not endless and (m.count or 0) > 0, enabled = m.enabled, level = level, prototype = prototypes.technology[tname], research_unit_count = units, research_unit_energy = unit.time and unit.time * 60, research_unit_ingredients = ingredients, upgrade = raw.upgrade or false}
    tech.prerequisites = setmetatable({}, {__index = function(_, pn) for _, q in ipairs(raw.prerequisites or {}) do if q == pn then return force.technologies[pn] end end return nil end, __pairs = function() local names, i = raw.prerequisites or {}, 0; return function() i = i + 1; local q = names[i]; if q then return q, force.technologies[q] end end end})
    tech = tracked("LuaTechnology", tech)
    tech_cache[tname] = tech
    return tech
  end, __pairs = function(t)
    local names = {}
    for n in pairs(raw_proto.technology or {}) do names[#names + 1] = n end
    local i = 0
    return function() i = i + 1; local n = names[i]; if n then return n, t[n] end end
  end})
  force.technologies = techs
  force.recipes = setmetatable({}, {__index = function() note("LuaForce.recipes") return nil end})
  function force.get_evolution_factor() return (FS().evolution or {}).factor or 0 end
  function force.get_evolution_factor_by_time() return (FS().evolution or {}).by_time or 0 end
  function force.get_evolution_factor_by_pollution() return (FS().evolution or {}).by_pollution or 0 end
  function force.get_evolution_factor_by_killing_spawners() return (FS().evolution or {}).by_spawners or 0 end
  local function stat(label) return function() fresh() local c = stat_cache[label]; if not c then c = flow_object(FS()[label]); stat_cache[label] = c end return c end end
  force.get_item_production_statistics = stat("items")
  force.get_fluid_production_statistics = stat("fluids")
  force.get_kill_count_statistics = stat("kills")
  force.get_entity_build_count_statistics = stat("builds")
  -- 已探: 有 SubChart; 可见: 探图时间还在迷雾时间内 (对过真值)
  local chart_gen, charted = -1, {}
  local function chart()
    if chart_gen ~= gen then
      chart_gen = gen
      charted = {}
      for _, c in ipairs((FS().chart or {}).charted or {}) do charted[c[1] .. "," .. c[2]] = c[3] end
    end
    return charted
  end
  local function chunk_key(c) return (c.x or c[1]) .. "," .. (c.y or c[2]) end
  -- --reveal: 内存里有整张图, 打开后生成过的区块都当看得见; 默认关, 和真人玩家看到的一样
  function force.is_chunk_visible(_, c)
    if __reveal then return generated_chunks()[chunk_key(c)] == true end
    local at = chart()[chunk_key(c)]
    return at ~= nil and now.tick - at < ((FS().chart or {}).fog_timeout or 0)
  end
  function force.is_chunk_charted(_, c)
    if __reveal then return generated_chunks()[chunk_key(c)] == true end
    return chart()[chunk_key(c)] ~= nil
  end
  function force.get_spawn_position() note("读不到:出生点") return {x = 0, y = 0} end
  function force.is_enemy(other) local o = type(other) == "table" and other.name or other return (name == "enemy") ~= (o == "enemy") and name ~= "neutral" and o ~= "neutral" end
  function force.is_friend(other) local o = type(other) == "table" and other.name or other return o == name end
  function force.get_entity_count() note("LuaForce.get_entity_count") return 0 end
  local DYN = {
    current_research = function() local c = (FS().research or {}).current return c and techs[c] or nil end,
    research_progress = function() return (FS().research or {}).progress or 0 end,
    research_queue = function() local out = {} for i, n in ipairs((FS().research or {}).queue or {}) do out[i] = techs[n] end return out end,
    rockets_launched = function() return FS().rockets or 0 end,
    index = function() return FS().id end,
    -- 这个势力的玩家: 本地玩家 + 注入 Lua 读到的别的玩家 (没开 --lua 就只有本地玩家); 太空平台还没读
    players = function()
      local out = name == "player" and {player} or {}
      for _, o in ipairs(lua_other_players()) do if rawget(o, "__force_name") == name then out[#out + 1] = o end end
      return out
    end,
    connected_players = function()
      local out = name == "player" and {player} or {}
      for _, o in ipairs(lua_other_players()) do if rawget(o, "__force_name") == name and rawget(o, "connected") then out[#out + 1] = o end end
      return out
    end,
    platforms = function() note("读不到:太空平台") return {} end,
    -- {地表名 = {物流网, ...}}; world_query 的 force 是本地玩家的势力
    logistic_networks = function()
      if name ~= "player" then return {} end
      local t, p = {kind = "force"}, {{property = "logistic_networks"}}
      local o = lua_inspect(t, p)
      if not o then note("读不到:物流网") return {} end
      return lua_result(o, t, p) or {}
    end,
  }
  setmetatable(force, {__index = function(_, k)
    local g = DYN[k]
    if g then return g() end
    local m = FS().modifiers
    if m and m[k] ~= nil then return m[k] end
    note("LuaForce." .. tostring(k))
    return nil
  end})
  forces_by_name[name] = force
  return force
end
local force_player = force_object("player")
local force_enemy = force_object("enemy")
local force_neutral = force_object("neutral")
-- 势力编号不变, 第一次用到时读一次世界数据, 之后不用为了 e.force 再读
local function force_of_id(fid)
  if not next(forces_by_id) then
    for name, fs in pairs(W().forces or {}) do
      if fs.id then forces_by_id[fs.id] = forces_by_name[name] or force_object(name) end
    end
  end
  return forces_by_id[fid] or force_neutral
end

-- ---------- 实体: 一个地址一张表 (模组用 == 比, 还可能存下来下次用); 字段每次提问重新取 ----------
local by_addr = {}
local entity_of

-- 占地框一半的长宽 (朝东西的把长宽对调)
local half_cache = {}
local function half_box(name)
  local h = half_cache[name]
  if h == nil then
    local p = prototypes.entity[name]
    local box = p and p.collision_box
    if box then
      local lt, rb = box[1] or box.left_top, box[2] or box.right_bottom
      h = {lt[1] or lt.x, lt[2] or lt.y, rb[1] or rb.x, rb[2] or rb.y}
    else h = false end
    half_cache[name] = h
  end
  return h
end
local function box_of(row)
  local h = half_box(row.name)
  if not h then return row.x, row.y, row.x, row.y end
  local dir = row.d and row.d.direction or 0
  if dir == 4 then return row.x - h[4], row.y + h[1], row.x - h[2], row.y + h[3] end
  if dir == 8 then return row.x - h[3], row.y - h[4], row.x - h[1], row.y - h[2] end
  if dir == 12 then return row.x + h[2], row.y - h[3], row.x + h[4], row.y - h[1] end
  return row.x + h[1], row.y + h[2], row.x + h[3], row.y + h[4]
end
-- 取放向量在引擎里是定点数 (1/256 格), 向量先向零取整再加位置: 1.2 → 1.19921875 (2026-11-06 对真值)
local function fixed(v)
  local n = v * 256
  if n >= 0 then return math.floor(n) / 256 end
  return math.ceil(n) / 256
end
-- 矿机的落点: 原型的 vector_to_place_result 按朝向转
local function rotate(v, dir)
  local x, y = v[1] or v.x, v[2] or v.y
  if dir == 4 then return -y, x end
  if dir == 8 then return -x, -y end
  if dir == 12 then return y, -x end
  return x, y
end
local function target(addr) local r = row_at(addr) if r then return entity_of(r) end return nil end

-- 注入 Lua 读实体: 指这个实体要编号 + 位置 (没编号的读不了)
local function lua_target(r) if r.unit then return {kind = "entities", unit_number = r.unit, position = {x = r.x, y = r.y}} end return nil end
local function lua_attr(r, name)
  local t = lua_target(r)
  local o = t and lua_inspect(t, nil, {name})
  local v = o and o.attributes and o.attributes[name]
  if v == nil then return nil end
  return lua_wrap(v, t, {{property = name}})
end
-- 回两个值: 结果, 问到了没有 (没问到 = 没开 --lua 或额度用完, 调用方记缺)
local function lua_call(r, method, ...)
  local t = lua_target(r)
  if not t then return nil, false end
  local step = {method = method}
  if select("#", ...) > 0 then step.arguments = {...} end
  local path = {step}
  local o = lua_inspect(t, path)
  if not o then return nil, false end
  return lua_result(o, t, path), true
end
-- 原型里有流体盒才值得问 (一次查询约 30 毫秒; 带子、箱子不问)
local fluid_kinds = {}
local function may_have_fluid(e, r)
  local known = fluid_kinds[r.name]
  if known ~= nil then return known end
  local t = e.type
  local p = t and raw_proto[t] and raw_proto[t][r.name]
  known = false
  for k in pairs(p or {}) do if type(k) == "string" and k:find("fluid_box") then known = true break end end
  if p and type(p.energy_source) == "table" and p.energy_source.fluid_box then known = true end
  fluid_kinds[r.name] = known
  return known
end
-- 靠流体工作的机器, 状态内存算不出 (锅炉没水): 按 64 格一块批量问真的状态
local FLUID_STATUS_TYPES = {"boiler", "generator", "pump", "offshore-pump", "fluid-turret"}
local FLUID_STATUS = {}
for _, t in ipairs(FLUID_STATUS_TYPES) do FLUID_STATUS[t] = true end
local status_gen, status_cells = -1, {}
local function lua_status(r)
  if status_gen ~= gen then status_gen = gen; status_cells = {} end
  local cx, cy = math.floor(r.x / 64), math.floor(r.y / 64)
  local key = cx .. "," .. cy
  local cell = status_cells[key]
  if cell == nil then
    cell = false
    local q = lua_ask({selection = {kind = "entities", area = {left_top = {x = cx * 64, y = cy * 64}, right_bottom = {x = cx * 64 + 64, y = cy * 64 + 64}}, type = FLUID_STATUS_TYPES}, fields = {"unit_number", "status"}, limit = 256})
    if q and q.objects then
      cell = {}
      for _, o in ipairs(q.objects) do local a = o.attributes or {} if a.unit_number then cell[a.unit_number] = a.status end end
    end
    status_cells[key] = cell
  end
  return cell and cell[r.unit] or nil
end

local G = {}
function G.position(e, r) return {x = r.x, y = r.y} end
function G.prototype(e, r) return prototypes.entity[r.name] end
-- 机器的制作速度: 原型的基础速度, 插件和分享塔没算 (内存里还没读; 开班扫描折算机器数用, 2026-11-06)
function G.crafting_speed(e, r)
  for _, kind in ipairs({"assembling-machine", "furnace", "rocket-silo"}) do
    local p = raw_proto[kind] and raw_proto[kind][r.name]
    if p then return p.crafting_speed or 1 end
  end
  return nil
end
function G.type(e, r) local p = e.prototype return p and p.type or nil end
function G.force(e, r) return force_of_id(r.force or (r.d and r.d.force)) end
function G.health(e, r) return r.d and r.d.health end
function G.max_health(e, r) local p = e.prototype return p and p.max_health end
function G.direction(e, r) return r.d and r.d.direction or 0 end
function G.quality(e, r) return {name = r.d and r.d.quality or "normal"} end
-- 这些类游戏里 status 本来就是 nil (2026-11-06 对真值: 电线杆、地下带); 别的类读到 nil 是我们还没算
local NO_STATUS = {ElectricPole = true, UndergroundBelt = true, Character = true}
function G.status(e, r)
  if r.unit and FLUID_STATUS[e.type] then local s = lua_status(r) if s ~= nil then return s end end
  if r.status == nil and not NO_STATUS[r.d and r.d.cls or ""] then note("LuaEntity.status@" .. tostring(r.d and r.d.cls or r.name)) end return r.status end
-- 发热: 这个地表不用发热 (太空时代的玄冥星才要), 冻不了; 上了别的星球要读 Freezable, 现在没读
function G.frozen() return false end
function G.is_freezable(e) local p = e.prototype return p ~= nil and (p.heating_energy or 0) > 0 end
-- 机械臂
local SPOIL = {[0] = "none", "fresh-first", "spoiled-first"}
function G.inserter_spoil_priority(e, r) local d = r.d return d and SPOIL[d.spoil or 0] or "none" end
function G.inserter_stack_size_override(e, r) local d = r.d local v = d and d.handOverride return (v and v ~= 255) and v or 0 end
function G.held_stack(e, r)
  local h = r.d and r.d.held
  if h then return {valid = true, valid_for_read = true, name = h.name, count = h.count, quality = {name = "normal"}, prototype = prototypes.item[h.name]} end
  return {valid = true, valid_for_read = false}
end
function G.amount(e, r) return r.d and r.d.amount end
function G.products_finished(e, r) return r.d and r.d.done end
function G.energy(e, r) return r.d and r.d.power and r.d.power.energy end
function G.surface() return surface end
function G.bounding_box(e, r) local x0, y0, x1, y1 = box_of(r) return {left_top = {x = x0, y = y0}, right_bottom = {x = x1, y = y1}} end
function G.selection_box(e, r) return e.bounding_box end
function G.supports_direction(e, r) return r.d ~= nil and r.d.direction ~= nil end
function G.active() return true end
function G.operable() return true end
function G.rotatable() return true end
function G.destructible() return true end
function G.minable() return true end
-- 谁最后动过它 (游戏自己记的 last_user): 内存没读, 问注入客户端 (只读属性)。不装模组那条路上放东西的是我们的行动层, harness 自己的放置记录里没有,
-- 原来这里回 nil, inspect 自己刚放的木箱显示 "placed unknown" (模型 11-06 笔记报过, 2026-11-09 沙盘复现)
function G.last_user(e, r) local v = lua_attr(r, "last_user") if v == nil then note("读不到:last_user") end return v end
-- 流体盒个数只看原型和配方, 同一种问一次就记住 (不然 status 一轮几十条查询)
local fluid_counts = {}
function G.fluids_count(e, r)
  if not may_have_fluid(e, r) then return 0 end
  local key = r.name .. "|" .. tostring(r.d and r.d.recipe or "")
  local n = fluid_counts[key]
  if n ~= nil then return n end
  n = as_fluid(lua_attr, r, "fluids_count")
  if n == nil then note("读不到:流体") return 0 end
  fluid_counts[key] = n
  return n
end
-- 物流: 机器人指令平台这些有 logistic_network / logistic_cell; 引用包成远程对象
function G.logistic_network(e, r) local v = lua_attr(r, "logistic_network") if v == nil then note("读不到:物流网") end return v end
function G.logistic_cell(e, r) local v = lua_attr(r, "logistic_cell") if v == nil then note("读不到:物流网") end return v end
function G.filter_slot_count(e, r) local p = e.prototype return p and p.filter_count or 0 end
function G.electric_network_id(e, r) local d = r.d if not d then return nil end return d.netId or (d.power and d.power.netId) end
local net_gen, net_stats = -1, {}
function G.electric_network_statistics(e, r)
  local id = e.electric_network_id
  if not id then return nil end
  if net_gen ~= gen then net_gen = gen; net_stats = {} end
  local key = tostring(id)
  local o = net_stats[key]
  if o == nil then
    local n = (W().networks or {})[key]
    if not n then return nil end
    o = flow_object(n.flow, n)
    net_stats[key] = o
  end
  return o
end
function G.mirroring(e, r) return r.d and r.d.mirroring or false end
function G.use_filters(e, r) local d = r.d return d ~= nil and d.cls == "Inserter" and (math.floor((d.flags or 0) / 256) % 2) == 1 end
function G.inserter_filter_mode(e, r) local d = r.d if not d or d.cls ~= "Inserter" then return nil end return (math.floor((d.flags or 0) / 2) % 2) == 1 and "whitelist" or "blacklist" end
function G.item_request_proxy() note("读不到:item_request_proxy") return nil end
function G.speed_bonus(e, r) local eff = r.d and r.d.effect return eff and eff.speed * EFFECT_SCALE or 0 end
function G.productivity_bonus(e, r) local eff = r.d and r.d.effect return eff and eff.productivity * EFFECT_SCALE or 0 end
function G.consumption_bonus(e, r) local eff = r.d and r.d.effect return eff and eff.consumption * EFFECT_SCALE or 0 end
function G.pollution_bonus(e, r) local eff = r.d and r.d.effect return eff and eff.pollution * EFFECT_SCALE or 0 end
function G.effects(e, r)
  local eff = r.d and r.d.effect
  if not eff then return nil end
  return {consumption = eff.consumption * EFFECT_SCALE, speed = eff.speed * EFFECT_SCALE, productivity = eff.productivity * EFFECT_SCALE, pollution = eff.pollution * EFFECT_SCALE, quality = eff.quality * EFFECT_SCALE}
end
function G.belt_shape(e, r) local s = r.d and r.d.shape return s == 0 and "straight" or s == 1 and "left" or s == 2 and "right" or nil end
function G.belt_to_ground_type(e, r) local t = r.d and r.d.ugType return t == 0 and "input" or t == 1 and "output" or nil end
function G.underground_belt_neighbour(e, r) return target(r.d and r.d.ugPair) end
-- 内存里 connections 是四个方向贴着的带子, 不等于真连着 (2026-11-06 对真值, 3773 项): 朝向那格只要不是迎头撞就是下游; 别的方向要对方的下游正好是我才算上游。分离器有两份 (conn2)
local function belt_fronts(d)
  local f = (d.direction or 0) / 4 + 1
  local out = {d.conn[f]}
  if d.conn2 then out[2] = d.conn2[f] end
  return out
end
local function belt_outputs(r)
  local d = r.d
  local out = {}
  for _, a in ipairs(belt_fronts(d)) do
    local o = a ~= 0 and a ~= r.addr and row_at(a)
    if o and o.d and o.d.conn and (o.d.direction - d.direction) % 16 ~= 8 then out[#out + 1] = o end
  end
  return out
end
function G.belt_neighbours(e, r)
  local d = r.d
  local out = {inputs = {}, outputs = {}}
  if not d or not d.conn then return out end
  for _, o in ipairs(belt_outputs(r)) do out.outputs[#out.outputs + 1] = entity_of(o) end
  local seen = {}
  local function scan(list)
    local f = (d.direction or 0) / 4 + 1
    for i = 1, 4 do
      local a = list[i]
      local o = i ~= f and a ~= 0 and a ~= r.addr and row_at(a)
      if o and o.d and o.d.conn and not seen[a] then
        for _, back in ipairs(belt_outputs(o)) do
          if back == r then seen[a] = true out.inputs[#out.inputs + 1] = entity_of(o) break end
        end
      end
    end
  end
  scan(d.conn)
  if d.conn2 then scan(d.conn2) end
  return out
end
function G.drop_target(e, r) return target(r.d and r.d.dropTarget) end
function G.pickup_target(e, r) return target(r.d and r.d.pickTarget) end
function G.drop_position(e, r)
  local d = r.d
  if not d then return nil end
  if d.dropVec then return {x = r.x + fixed(d.dropVec[1]), y = r.y + fixed(d.dropVec[2])} end
  local p = e.prototype
  local v = p and p.vector_to_place_result
  if v then local x, y = rotate(v, d.direction or 0) return {x = r.x + fixed(x), y = r.y + fixed(y)} end
  return nil
end
function G.pickup_position(e, r) local d = r.d if d and d.pickVec then return {x = r.x + fixed(d.pickVec[1]), y = r.y + fixed(d.pickVec[2])} end return nil end
function G.burner(e, r)
  local power = r.d and r.d.power
  if not power or power.src ~= "burner" then return nil end
  local source = e.prototype and e.prototype.energy_source or {}
  local cats = {}
  for _, c in ipairs(source.fuel_categories or {"chemical"}) do cats[c] = true end
  return tracked_nil("LuaBurner", {valid = true, inventory = e.get_fuel_inventory(), burnt_result_inventory = e.get_burnt_result_inventory(), heat = power.energy, remaining_burning_fuel = power.remaining, currently_burning = power.burning and {name = {name = power.burning}, quality = {name = "normal"}} or nil, fuel_categories = cats}, {currently_burning = true})
end
function G.mining_target(e, r) return target(r.d and r.d.miningTarget) end
function G.previous_recipe() return nil end
-- 2.1 删了 LuaEntity.fluidbox, 游戏里读它就报错 (compat21.lua 靠这个判断); 假接口也报错
function G.fluidbox() error("LuaEntity doesn't contain key fluidbox.") end
function G.electric_buffer_size(e, r) local power = r.d and r.d.power return power and power.capacity end
-- 地上的物品 (item-on-ground)
function G.stack(e, r)
  local s = r.d and r.d.stack
  if s then return {valid = true, valid_for_read = true, name = s.name, count = s.count, quality = {name = s.quality or "normal"}, prototype = prototypes.item[s.name]} end
  return {valid = true, valid_for_read = false}
end
function G.neighbours() error("LuaEntity doesn't contain key neighbours.") end
function G.grid() return nil end
-- 角色: 下面这些内存还没读, 给的是没动作时的值, 记缺
function G.selected_gun_index(e, r) note("读不到:选中的枪") return 1 end
function G.walking_state(e, r) note("读不到:走路状态") return {walking = false, direction = 0} end
function G.crafting_queue_size(e, r) note("读不到:手搓队列") return 0 end

-- 背包编号按实体种类分: lab_input 和 crafter_input 同是 2, lab_modules 和 crafter_output 同是 3 (defines.inventory)
local function inventories_of(d, name)
  local power = d.power or {}
  local di = defines.inventory
  local invs = {}
  if d.cls == "Lab" then
    invs[di.lab_input] = inventory("input", d.input, nil, nil, di.lab_input)
    invs[di.lab_modules] = inventory("modules", d.modules, d.moduleSlots, nil, di.lab_modules)
  elseif d.cls == "AssemblingMachine" or d.cls == "Furnace" then
    invs[di.crafter_input] = inventory("input", d.input, nil, nil, di.crafter_input)
    invs[di.crafter_output] = inventory("output", d.output, nil, nil, di.crafter_output)
    if d.moduleSlots and d.moduleSlots > 0 then invs[di.crafter_modules] = inventory("modules", d.modules, d.moduleSlots, nil, di.crafter_modules) end
  elseif d.cls == "MiningDrill" then
    if d.moduleSlots and d.moduleSlots > 0 then invs[di.mining_drill_modules] = inventory("modules", d.modules, d.moduleSlots, nil, di.mining_drill_modules) end
  elseif d.cls == "Character" then
    invs[di.character_main] = inventory("main", d.main, #(d.mainSlots or {}), d.mainSlots, di.character_main)
    invs[di.character_guns] = inventory("guns", d.guns, 3, nil, di.character_guns)
    invs[di.character_ammo] = inventory("ammo", d.ammo, 3, nil, di.character_ammo)
    invs[di.character_armor] = inventory("armor", d.armor, 1, nil, di.character_armor)
    invs[di.character_trash] = inventory("trash", {}, 0, nil, di.character_trash)
  end
  -- 箱子的格数: 原型的 inventory_size; 原来没给, 木箱读成 "1 of 1 slots" 还报满了 (2026-11-06 真服第三班)
  if d.chest then
    local proto = name and raw_proto and (raw_proto.container and raw_proto.container[name] or raw_proto["logistic-container"] and raw_proto["logistic-container"][name])
    invs[di.chest] = inventory("chest", d.chest, proto and proto.inventory_size or nil, nil, di.chest)
  end
  if d.cls == "AmmoTurret" then invs[di.turret_ammo] = inventory("ammo", d.ammo, nil, nil, di.turret_ammo) end
  if power.src == "burner" then invs[di.fuel] = inventory("fuel", power.fuel, 1, nil, di.fuel) invs[di.burnt_result] = inventory("burnt", power.burnt, 1, nil, di.burnt_result) end
  return invs
end
-- 方法: 模组用 e.xxx(...) 调, 第一次取时绑上这个实体
local M = {}
function M.get_inventory(e, r)
  local invs
  return function(id)
    invs = invs or inventories_of(r.d or {}, r.name)
    return invs[id]
  end
end
function M.get_main_inventory(e) return function() return e.get_inventory(defines.inventory.character_main) end end
function M.get_fuel_inventory(e, r) return function() return e.get_inventory(defines.inventory.fuel) end end
function M.get_burnt_result_inventory(e, r) return function() return e.get_inventory(defines.inventory.burnt_result) end end
-- 研究中心的 get_output_inventory 是它的瓶子格 (2026-11-06 对真值: inspect 的 pickup_wait 读的就是它)
function M.get_output_inventory(e, r) return function() local d = r.d or {} return e.get_inventory(d.cls == "Lab" and defines.inventory.lab_input or defines.inventory.crafter_output) end end
function M.get_module_inventory(e, r)
  return function()
    local d = r.d or {}
    local di = defines.inventory
    if not d.moduleSlots or d.moduleSlots == 0 then return nil end
    return e.get_inventory(d.cls == "Lab" and di.lab_modules or d.cls == "MiningDrill" and di.mining_drill_modules or di.crafter_modules)
  end
end
function M.get_filter(e, r) return function(i) local d = r.d local n = d and d.filters and d.filters[i] if n and n ~= false then return {name = n, quality = "normal", comparator = "="} end return nil end end
-- 模组的 get_item_count: 这个实体里所有背包 + 带子 + 手上的物品总数
function M.get_item_count(e, r)
  return function(n)
    local d = r.d or {}
    local want = type(n) == "table" and n.name or n
    local sum = 0
    local function add(list) for _, s in ipairs(list or {}) do if not want or s.name == want then sum = sum + s.count end end end
    add(d.input) add(d.output) add(d.chest) add(d.ammo) add(d.modules) add(d.main) add(d.guns) add(d.armor)
    for _, l in ipairs(d.lines or {}) do add(l) end
    local power = d.power or {}
    add(power.fuel) add(power.burnt)
    if d.held and (not want or d.held.name == want) then sum = sum + d.held.count end
    return sum
  end
end
function M.get_recipe(e, r) return function() local n = r.d and r.d.recipe if n then return prototypes.recipe[n], {name = "normal"} end return nil end end
-- 流体和物流点: 问注入的 Lua; zero: 问不到或空时回什么。原型里没有流体盒的不问
local function lua_method(name, miss, zero)
  return function(e, r)
    return function(...)
      local fluid = miss == "读不到:流体"
      if fluid and not may_have_fluid(e, r) then return zero and zero() or nil end
      local v, ok
      if fluid then v, ok = as_fluid(lua_call, r, name, ...) else v, ok = lua_call(r, name, ...) end
      if not ok then note(miss) end
      if v == nil and zero then return zero() end
      return v
    end
  end
end
local empty = function() return {} end
M.get_fluid_contents = lua_method("get_fluid_contents", "读不到:流体", empty)
M.get_fluid = lua_method("get_fluid", "读不到:流体")
M.get_fluid_filter = lua_method("get_fluid_filter", "读不到:流体")
M.get_fluid_capacity = lua_method("get_fluid_capacity", "读不到:流体")
M.get_fluid_count = lua_method("get_fluid_count", "读不到:流体")
M.get_fluid_box_neighbours = lua_method("get_fluid_box_neighbours", "读不到:流体", empty)
M.get_fluid_box_pipe_connections = lua_method("get_fluid_box_pipe_connections", "读不到:流体", empty)
M.get_fluid_segment_id = lua_method("get_fluid_segment_id", "读不到:流体")
M.has_fluid_segment = lua_method("has_fluid_segment", "读不到:流体")
M.get_fluid_segment_capacity = lua_method("get_fluid_segment_capacity", "读不到:流体")
M.get_fluid_segment_filter = lua_method("get_fluid_segment_filter", "读不到:流体")
M.get_fluid_segment_fluid = lua_method("get_fluid_segment_fluid", "读不到:流体")
M.get_fluid_segment_extent_bounding_box = lua_method("get_fluid_segment_extent_bounding_box", "读不到:流体")
function M.is_connected_to_electric_network(e, r) return function() local d = r.d return d ~= nil and d.power ~= nil and d.power.network == 1 end end
function M.has_flag() return function() return false end end
function M.to_be_deconstructed(e, r) return function() local d = r.d return ((d and d.usage or 0) % 32768) >= 16384 end end
function M.to_be_upgraded() return function() return false end end
function M.get_control_behavior() return function() return nil end end
function M.get_max_transport_line_index(e, r) return function() return r.d and r.d.lines and 2 or 0 end end
function M.get_transport_line(e, r)
  return function(i)
    local l = r.d and r.d.lines and r.d.lines[i] or {}
    return tracked("LuaTransportLine", {valid = true, get_contents = function() local out = {} for k, s in ipairs(l) do out[k] = {name = s.name, quality = s.quality or "normal", count = s.count} end return out end, get_item_count = function() local n = 0 for _, s in ipairs(l) do n = n + s.count end return n end})
  end
end
-- 电线: 电线杆的铜线读内存 (connections → 对方实体); 红绿线问注入的 Lua (我们 pilot 分支的 MCP 放行 or_create = false 的读法)
local function pole_connector(e, r)
  local d = r.d
  if not d or not d.wires then return nil end
  local id = defines.wire_connector_id.pole_copper
  local c = rawget(e, "__cache").pole_connector
  if c then return c end
  c = {valid = true, object_name = "LuaWireConnector", owner = e, wire_connector_id = id, wire_type = defines.wire_type.copper, is_ghost = false, network_id = d.netId}
  rawget(e, "__cache").pole_connector = c
  local conns = {}
  for i, w in ipairs(d.wires) do
    local other = target(w.addr)
    if other then conns[#conns + 1] = {origin = w.origin, target = setmetatable({}, {__index = function(_, k) local oc = other.get_wire_connector(id) return oc and oc[k] end})} end
  end
  c.connections, c.real_connections = conns, conns
  c.connection_count, c.real_connection_count = #conns, #conns
  return c
end
function M.get_wire_connectors(e, r)
  return function()
    local v, ok = lua_call(r, "get_wire_connectors", false)
    if not ok then note("读不到:红绿线") end
    local out = v or {}
    local c = pole_connector(e, r)
    if c then out[c.wire_connector_id] = c end
    return out
  end
end
function M.get_wire_connector(e, r)
  return function(id)
    local c = pole_connector(e, r)
    if c and c.wire_connector_id == id then return c end
    local v, ok = lua_call(r, "get_wire_connector", id, false)
    if not ok then note("读不到:红绿线") end
    return v
  end
end
M.get_circuit_network = lua_method("get_circuit_network", "读不到:红绿线")
M.get_logistic_point = lua_method("get_logistic_point", "读不到:物流网")

-- 这个实体这次提问的数据: 过期就重新取; 取不到或地址上已经换了东西 → nil (valid = false)
local function fresh_row(e)
  if rawget(e, "__gen") == gen then return rawget(e, "__row") end
  local addr = rawget(e, "__addr")
  local r = row_at(addr)
  if r and (r.name ~= rawget(e, "name") or r.unit ~= rawget(e, "unit_number")) then r = nil end
  rawset(e, "__gen", gen)
  rawset(e, "__row", r)
  rawset(e, "__cache", {})
  if not r then by_addr[addr] = nil end
  return r
end
local ENT_MT = {__index = function(e, k)
  local r = fresh_row(e)
  if k == "valid" then return r ~= nil end
  if not r then error("LuaEntity API call when LuaEntity was invalid.", 2) end
  local cache = rawget(e, "__cache")
  local v = cache[k]
  if v ~= nil then return v end
  local g = G[k]
  if g then
    v = g(e, r)
    if v ~= nil then cache[k] = v end
    return v
  end
  local m = M[k]
  if m then
    local f = m(e, r)
    cache[k] = f
    return f
  end
  note("LuaEntity." .. tostring(k))
  return nil
end}
function entity_of(row)
  local key = row.addr
  local e = by_addr[key]
  if e and rawget(e, "name") == row.name and rawget(e, "unit_number") == row.unit then return e end
  e = setmetatable({__addr = key, name = row.name, object_name = "LuaEntity", unit_number = row.unit}, ENT_MT)
  by_addr[key] = e
  return e
end

-- ---------- 地表: 按区块索引, 有范围的只读相交的区块 ----------
local function set_of(v)
  if v == nil then return nil end
  local out = {}
  if type(v) == "table" and not rawget(v, "name") then for _, x in ipairs(v) do out[type(x) == "table" and x.name or x] = true end
  else out[type(v) == "table" and v.name or v] = true end
  return out
end
local function force_ok(row, want)
  if not want then return true end
  return want[force_of_id(row.force or (row.d and row.d.force)).name] == true
end
local KNOWN_FILTERS = {area = true, position = true, radius = true, name = true, type = true, force = true, limit = true, invert = true}
local function matcher(a)
  for k in pairs(a) do if not KNOWN_FILTERS[k] then note("find_entities_filtered." .. tostring(k)) end end
  local names, types, forces = set_of(a.name), set_of(a.type), set_of(a.force)
  local x0, y0, x1, y1
  if a.area then
    local lt, rb = a.area.left_top or a.area[1], a.area.right_bottom or a.area[2]
    x0, y0, x1, y1 = lt.x or lt[1], lt.y or lt[2], rb.x or rb[1], rb.y or rb[2]
  end
  local px, py, r2
  if a.position then
    px, py = a.position.x or a.position[1], a.position.y or a.position[2]
    if a.radius then r2 = a.radius * a.radius end
  end
  local invert = a.invert == true
  return function(row)
    local ok = true
    if names and not names[row.name] then ok = false end
    if ok and types then local p = prototypes.entity[row.name]; if not (p and types[p.type]) then ok = false end end
    if ok and forces and not force_ok(row, forces) then ok = false end
    if invert then ok = not ok end
    if not ok then return false end
    if x0 then
      local bx0, by0, bx1, by1 = box_of(row)
      if bx1 < x0 or bx0 > x1 or by1 < y0 or by0 > y1 then return false end
    end
    if px then
      if r2 then
        local dx, dy = row.x - px, row.y - py
        if dx * dx + dy * dy > r2 then return false end
      else
        local bx0, by0, bx1, by1 = box_of(row)
        if px < bx0 or px > bx1 or py < by0 or py > by1 then return false end
      end
    end
    return true
  end, x0, y0, x1, y1, px, py
end
-- 这个查询可能要树石矿吗 (没范围的查询才问): 指明了类型 / 名字 / 我方势力就看得出来
local OWNERLESS = {}
for _, t in ipairs(__ownerless or {}) do OWNERLESS[t] = true end
local function wants_natural(a)
  if a.invert == true then return true end
  local types, names = set_of(a.type), set_of(a.name)
  if types then
    for t in pairs(types) do if OWNERLESS[t] then return true end end
    return false
  end
  if names then
    for n in pairs(names) do
      local p = prototypes.entity[n]
      if not p or OWNERLESS[p.type] then return true end
    end
    return false
  end
  local forces = set_of(a.force)
  return not (forces and not forces.neutral)
end
-- 候选: 有范围的只看相交的区块; 没范围的读全图, 有名字的再走名字索引
local function each_candidate(a, x0, y0, x1, y1, px, py, f)
  local rx0, ry0, rx1, ry1 = x0, y0, x1, y1
  if px then
    local r = a.radius or 0
    if rx0 then rx0, ry0, rx1, ry1 = math.max(rx0, px - r), math.max(ry0, py - r), math.min(rx1, px + r), math.min(ry1, py + r)
    else rx0, ry0, rx1, ry1 = px - r, py - r, px + r, py + r end
  end
  if rx0 then
    local cx0, cx1 = math.floor((rx0 - MARGIN) / CHUNK), math.floor((rx1 + MARGIN) / CHUNK)
    local cy0, cy1 = math.floor((ry0 - MARGIN) / CHUNK), math.floor((ry1 + MARGIN) / CHUNK)
    ensure_chunks(cx0, cx1, cy0, cy1)
    for cx = cx0, cx1 do
      local col = grid[cx]
      if col then
        for cy = cy0, cy1 do
          local cell = col[cy]
          if cell then for _, row in ipairs(cell) do if f(row) then return end end end
        end
      end
    end
    return
  end
  if wants_natural(a) then ensure_all() else ensure_owned() end
  local names = a.invert ~= true and a.name and ((type(a.name) == "table" and not rawget(a.name, "name")) and a.name or {type(a.name) == "table" and a.name.name or a.name})
  if names then
    for _, n in ipairs(names) do
      local list = names_index[type(n) == "table" and n.name or n]
      if list then for _, row in ipairs(list) do if f(row) then return end end end
    end
    return
  end
  for _, row in ipairs(ordered) do if f(row) then return end end
end
local generated_gen, generated = -1, {}
function generated_chunks()
  if generated_gen ~= gen then
    generated_gen = gen
    generated = {}
    for _, c in ipairs((W().pollution or {}).all or {}) do generated[c[1] .. "," .. c[2]] = true end
  end
  return generated
end
-- 这个位置归哪个物流网: 按位置找网不在只读查询放行的方法里, 改成在内存里找盖住它的机器人指令平台, 再问它的网 (盖不盖按原型的半径, 方形; 角色身上的不算)
-- ---------- 地块: 内存没读, 问注入客户端的 world_query kind=tiles (2026-11-07 Steam 版实跑: 模型找不到水, 发不了电, 研究不了炮塔) ----------
-- 一次一个区块 (1024 格, 约 30 毫秒), 按区块缓存: 地形基本不变, 只有第一次看一片地才问得多; 没开 --lua 或额度用完就算没读到 (complete = false), 不编
local TILE_TTL = 36000 -- tick, 10 分钟: 填海、铺地砖最多晚这么久才看到
local tile_chunks = {}
local function chunk_tiles(cx, cy)
  local key = surface.name .. ":" .. cx .. ":" .. cy
  local now = game.tick
  local c = tile_chunks[key]
  if c and now - c.at < TILE_TTL then return c end
  lua_kind = "tile"
  local r = lua_ask({selection = {kind = "tiles", area = {left_top = {x = cx * CHUNK, y = cy * CHUNK}, right_bottom = {x = cx * CHUNK + CHUNK, y = cy * CHUNK + CHUNK}}}, fields = {"name"}, limit = CHUNK * CHUNK})
  lua_kind = "other"
  if not r or not r.objects then return c end -- 问不到时过期的也比没有强
  local names = {}
  for i, o in ipairs(r.objects) do names[i] = o.attributes and o.attributes.name or false end -- 没生成的区块那格是 false
  c = {at = now, cx = cx, cy = cy, names = names}
  tile_chunks[key] = c
  return c
end
-- 工具手册: 地块按行排 (row-major)
local function tile_name_at(c, x, y)
  return c.names[(y - c.cy * CHUNK) * CHUNK + (x - c.cx * CHUNK) + 1] or nil
end
local function tile_layers(name)
  local t = raw_proto.tile and raw_proto.tile[name]
  return t and t.collision_mask and t.collision_mask.layers or {}
end
local function tile_object(name, x, y)
  return tracked_nil("LuaTile", {name = name, position = {x = x, y = y}, valid = true, prototype = prototypes.tile[name],
    collides_with = function(layer) return tile_layers(name)[layer] == true end}, {hidden_tile = true, double_hidden_tile = true})
end
-- 过滤条件: name、collision_mask (都可以是一个或一串), invert; 范围: area 或 position + radius
local function tile_test(f)
  local function set(v)
    if v == nil then return nil end
    local out = {}
    if type(v) == "string" then out[v] = true else for _, x in pairs(v) do out[x] = true end end
    return out
  end
  local names, masks = set(f.name), set(f.collision_mask)
  return function(name)
    local ok = true
    if names and not names[name] then ok = false end
    if ok and masks then
      local hit, layers = false, tile_layers(name)
      for m in pairs(masks) do if layers[m] then hit = true end end
      ok = hit
    end
    if f.invert then return not ok end
    return ok
  end
end
local function tile_bounds(f)
  if f.position and f.radius then
    local x, y = f.position.x or f.position[1], f.position.y or f.position[2]
    return math.floor(x - f.radius), math.floor(y - f.radius), math.ceil(x + f.radius), math.ceil(y + f.radius), x, y, f.radius
  end
  local a = f.area
  if not a then return nil end
  local lt, rb = a.left_top or a[1], a.right_bottom or a[2]
  return math.floor(lt.x or lt[1]), math.floor(lt.y or lt[2]), math.ceil(rb.x or rb[1]), math.ceil(rb.y or rb[2])
end
-- 返回: 数量, 行 (want_rows 时), 这片地都读到了没有
local function scan_tiles(f, want_rows)
  local x0, y0, x1, y1, px, py, radius = tile_bounds(f)
  if not x0 then return 0, {}, false end -- 整个地表: 没有这种读法
  local test, limit = tile_test(f), f.limit
  local n, rows, complete = 0, {}, true
  for cx = math.floor(x0 / CHUNK), math.floor((x1 - 1) / CHUNK) do
    for cy = math.floor(y0 / CHUNK), math.floor((y1 - 1) / CHUNK) do
      local c = chunk_tiles(cx, cy)
      if not c then
        complete = false
      else
        for y = math.max(y0, cy * CHUNK), math.min(y1, cy * CHUNK + CHUNK) - 1 do
          for x = math.max(x0, cx * CHUNK), math.min(x1, cx * CHUNK + CHUNK) - 1 do
            local name = tile_name_at(c, x, y)
            if name and test(name) and (not radius or (x + 0.5 - px) ^ 2 + (y + 0.5 - py) ^ 2 <= radius * radius) then
              n = n + 1
              if want_rows then rows[#rows + 1] = tile_object(name, x, y) end
              if limit and n >= limit then return n, rows, complete end
            end
          end
        end
      end
    end
  end
  return n, rows, complete
end

local function roboports_covering(pos, radius_key)
  local x, y = pos.x or pos[1], pos.y or pos[2]
  local out = {}
  for _, e in ipairs(surface.find_entities_filtered{area = {{x - 128, y - 128}, {x + 128, y + 128}}, type = "roboport"}) do
    local p = raw_proto.roboport and raw_proto.roboport[e.name]
    local radius = p and p[radius_key] or 0
    local at = e.position
    if math.abs(at.x - x) <= radius and math.abs(at.y - y) <= radius then out[#out + 1] = e end
  end
  return out
end
local function lua_network_at(pos)
  local found = roboports_covering(pos, "logistics_radius") -- 原型里叫 logistics_radius (运行时的 LuaLogisticCell 才叫 logistic_radius)
  if not found[1] then return nil end
  return found[1].logistic_network
end
local function lua_networks_building(pos)
  local seen, out = {}, {}
  for _, e in ipairs(roboports_covering(pos, "construction_radius")) do
    local n = e.logistic_network
    if n and not seen[n.network_id] then seen[n.network_id] = true; out[#out + 1] = n end
  end
  return out
end
-- 放置检查 (placeable.lua, 纯函数): 占地框里挡建造的实体、脚下的地块、原型的地块规则 (抽水机: 脚下陆地 + 正面 3x2 水); 地块没读到 = 放不下并记缺。
-- placements / nearest_water 的抽水机位置、drill_sites 都靠它; 以前游戏外没有这个接口, 它们一律报 "can_place_entity (a nil value)" (2026-11-08 第四班: 17 次抽水机放不下)
local placeable = load(__py_read_offgame("placeable"), "@placeable.lua", "t", _ENV)()
local last_place_why = nil
local function can_place(a)
  local name = type(a.name) == "table" and a.name.name or a.name
  local proto = prototypes.entity[name]
  local x, y = (a.position or {}).x or (a.position or {})[1], (a.position or {}).y or (a.position or {})[2]
  if not proto or x == nil then last_place_why = "缺原型或位置"; return false end
  local ok, why = placeable.check{proto = proto, name = name, x = x, y = y, direction = a.direction or 0,
    entities = function(x0, y0, x1, y1)
      local out = {}
      for _, e in ipairs(surface.find_entities_filtered{area = {{x0, y0}, {x1, y1}}}) do
        local bb = e.bounding_box
        out[#out + 1] = {name = e.name, type = e.type, x0 = bb.left_top.x, y0 = bb.left_top.y, x1 = bb.right_bottom.x, y1 = bb.right_bottom.y}
      end
      return out
    end,
    tile = function(tx, ty)
      local c = chunk_tiles(math.floor(tx / CHUNK), math.floor(ty / CHUNK))
      return c and tile_name_at(c, tx, ty) or nil
    end,
    tile_layers = tile_layers}
  if why and why:find("没读到", 1, true) then note("读不到:地块") end
  last_place_why = why
  return ok
end
-- 上一次放置检查为什么不行 (给 placements 的 blocked 文案和调试用; 游戏里没有这个, 只在外面有)
function __place_why() return last_place_why end
surface = tracked_nil("LuaSurface", {name = "nauvis", index = 1, valid = true, object_name = "LuaSurface",
  can_place_entity = can_place,
  find_entities_filtered = function(a)
    local out = {}
    local limit = a.limit
    local ok, x0, y0, x1, y1, px, py = matcher(a)
    each_candidate(a, x0, y0, x1, y1, px, py, function(row)
      if ok(row) then out[#out + 1] = entity_of(row); if limit and #out >= limit then return true end end
      return false
    end)
    return out
  end,
  count_entities_filtered = function(a)
    local n = 0
    local limit = a.limit
    local ok, x0, y0, x1, y1, px, py = matcher(a)
    each_candidate(a, x0, y0, x1, y1, px, py, function(row)
      if ok(row) then n = n + 1; if limit and n >= limit then return true end end
      return false
    end)
    return n
  end,
  find_entity = function(name, pos)
    local x, y = pos.x or pos[1], pos.y or pos[2]
    local want = type(name) == "table" and name.name or name
    local cx, cy = math.floor(x / CHUNK), math.floor(y / CHUNK)
    ensure_chunks(cx - 1, cx + 1, cy - 1, cy + 1)
    for dx = cx - 1, cx + 1 do
      local col = grid[dx]
      if col then
        for dy = cy - 1, cy + 1 do
          for _, row in ipairs(col[dy] or {}) do
            if row.name == want then
              local bx0, by0, bx1, by1 = box_of(row)
              if x >= bx0 and x <= bx1 and y >= by0 and y <= by1 then return entity_of(row) end
            end
          end
        end
      end
    end
    return nil
  end,
  get_closest = function(pos, list)
    local x, y = pos.x or pos[1], pos.y or pos[2]
    local best, best_d
    for _, e in ipairs(list or {}) do
      local p = e.position
      local dx, dy = p.x - x, p.y - y
      local dd = dx * dx + dy * dy
      if not best_d or dd < best_d then best, best_d = e, dd end
    end
    return best
  end,
  find_logistic_network_by_position = function(pos) return lua_network_at(pos) end,
  find_logistic_networks_by_construction_area = function(pos) return lua_networks_building(pos) end,
  get_pollution = function(pos)
    local x, y = pos.x or pos[1], pos.y or pos[2]
    return ((W().pollution or {}).chunks or {})[math.floor(x / CHUNK) .. "," .. math.floor(y / CHUNK)] or 0
  end,
  get_total_pollution = function() return (W().pollution or {}).total or 0 end,
  is_chunk_generated = function(pos) local x, y = pos.x or pos[1], pos.y or pos[2] return generated_chunks()[x .. "," .. y] == true end,
  get_chunks = function()
    local i = 0
    local list = (W().pollution or {}).all or {}
    return function()
      i = i + 1
      local c = list[i]
      if not c then return nil end
      return {x = c[1], y = c[2], area = {left_top = {x = c[1] * CHUNK, y = c[2] * CHUNK}, right_bottom = {x = (c[1] + 1) * CHUNK, y = (c[2] + 1) * CHUNK}}}
    end
  end,
  get_tile = function(x, y)
    if type(x) == "table" then x, y = x.x or x[1], x.y or x[2] end
    local tx, ty = math.floor(x), math.floor(y)
    local c = chunk_tiles(math.floor(tx / CHUNK), math.floor(ty / CHUNK))
    local name = c and tile_name_at(c, tx, ty)
    if name then return tile_object(name, tx, ty) end
    note("读不到:地块") -- 没开 --lua、额度用完、或区块没生成: 不编一个地块名, 明说不知道
    return tracked("LuaTile", {name = "unknown", valid = true})
  end,
  count_tiles_filtered = function(f)
    local n, _, complete = scan_tiles(f, false)
    if not complete then note("读不到:地块") end
    return n
  end,
  find_tiles_filtered = function(f)
    local _, rows, complete = scan_tiles(f, true)
    if not complete then note("读不到:地块") end
    return rows
  end,
}, {platform = true, planet = true, pollutant_type = true})
setmetatable(surface, {__index = function(_, k)
  if k == "platform" or k == "planet" or k == "pollutant_type" then return nil end
  if k == "has_global_electric_network" then return W().has_global_network or false end
  note("LuaSurface." .. tostring(k))
  return nil
end})

-- ---------- 玩家: 本地玩家, 身体就是普通实体 (观战没有身体, character 是 nil) ----------
do
  local function body()
    if me and me.addr then local r = row_at(me.addr) if r then return entity_of(r) end end
    return nil
  end
  local function pos() return me and me.position or {x = 0, y = 0} end
  local DYN = {
    index = function() return me and me.index or 1 end,
    name = function() return me and me.name or "Admin" end,
    admin = function() return me and me.admin or false end,
    character = body,
    position = pos,
    physical_position = pos,
    cursor_ghost = function() return nil end,
    vehicle = function() return nil end,
  }
  player = setmetatable({valid = true, connected = true, surface = surface, physical_surface = surface, force = force_player, object_name = "LuaPlayer", physical_controller_type = defines.controllers and defines.controllers.character or 1, controller_type = defines.controllers and defines.controllers.character or 1, cheat_mode = false, driving = false, crafting_queue = {}, crafting_queue_size = 0, walking_state = {walking = false, direction = 0}, mining_state = {mining = false}, cursor_stack = {valid = true, valid_for_read = false},
    get_main_inventory = function() local b = body() return b and b.get_main_inventory() end, get_inventory = function(id) local b = body() return b and b.get_inventory(id) end,
    can_place_entity = can_place,
    -- 够得着: 角色到实体占地框的距离 (够得着 10 格, 2.1.24 实测); 原来一律 true, 真服上离 200 格也报 in_reach (2026-11-06)
    can_reach_entity = function(e)
      local p, c, box = pos(), e.position, e.bounding_box
      local dx, dy = p.x - c.x, p.y - c.y
      if box and box.left_top then dx = math.max(box.left_top.x - p.x, 0, p.x - box.right_bottom.x) dy = math.max(box.left_top.y - p.y, 0, p.y - box.right_bottom.y) end
      return math.sqrt(dx * dx + dy * dy) <= 10
    end, is_cursor_empty = function() return true end, print = function() end, clear_cursor = function() end, get_associated_characters = function() return {} end, get_alerts = function() note("读不到:游戏报警") return {} end},
    {__index = function(_, k) local g = DYN[k] if g then return g() end note("LuaPlayer." .. tostring(k)) return nil end})
end

-- 实体引用 (注入 Lua 回的, 带名字、编号、位置) → 内存里的同一个实体; 在别的地表找不到就回只带这几样的表
lua_entity_ref = function(v)
  if v.position and v.unit_number then
    for _, e in ipairs(surface.find_entities_filtered{position = v.position, radius = 1.5, name = v.name}) do
      if e.unit_number == v.unit_number then return e end
    end
  end
  return setmetatable({object_name = "LuaEntity", valid = true, name = v.name, type = v.type, unit_number = v.unit_number, position = v.position}, {__index = function(_, k) note("读不到:别的地表的实体." .. tostring(k)) return nil end})
end

-- 别的玩家 (真人队友): 注入 Lua 的 players 查询, 3 秒缓存; 没开 --lua 就是空的, 只有本地玩家。只能看, 动不了
local others_gen, others = -1, {}
local function make_other(a)
  local pos = a.physical_position or a.position or {x = 0, y = 0}
  local where = a.physical_surface or a.surface or {}
  local same = where.name == surface.name
  local there = same and surface or setmetatable({object_name = "LuaSurface", valid = true, name = where.name, index = where.index}, {__index = function(_, k) note("读不到:别的地表." .. tostring(k)) return nil end})
  local force_name = a.force and a.force.name or "player"
  local no_op = function() end
  return setmetatable({object_name = "LuaPlayer", valid = true, __other = true, __force_name = force_name, index = a.index, name = a.name, connected = a.connected == true, position = a.position or pos, physical_position = pos, surface = there, physical_surface = there, force = forces_by_name[force_name] or force_player, afk_time = a.afk_time or 0, last_online = a.last_online or 0, admin = false, cheat_mode = false, driving = false, crafting_queue_size = 0, cursor_stack = {valid = true, valid_for_read = false}, print = no_op, play_sound = no_op, is_cursor_empty = function() return true end, can_reach_entity = function() return false end, get_alerts = function() return {} end, get_main_inventory = function() return nil end, get_inventory = function() return nil end, get_associated_characters = function() return {} end},
    {__index = function(t, k)
      if k == "character" then
        local c = a.character and lua_entity_ref(a.character) or nil
        rawset(t, k, c or false)
        return c
      end
      if k == "vehicle" or k == "cursor_ghost" then return nil end
      note("LuaPlayer(别的玩家)." .. tostring(k))
      return nil
    end})
end
lua_other_players = function()
  if others_gen == gen then return others end
  others_gen, others = gen, {}
  local r = lua_ask({selection = {kind = "players"}, fields = {"index", "name", "connected", "position", "surface", "physical_position", "physical_surface", "character", "force", "afk_time", "last_online"}, limit = 256})
  for _, o in ipairs(r and r.objects or {}) do
    local a = o.attributes or {}
    if a.name and a.name ~= player.name then others[#others + 1] = make_other(a) end
  end
  return others
end

local pollution_gen, pollution_stats = -1, nil
game = setmetatable({ticks_played = 0, speed = 1,
  players = setmetatable({}, {__index = function(_, k)
    if k == player.index or k == player.name then return player end
    for _, o in ipairs(lua_other_players()) do if k == rawget(o, "index") or k == rawget(o, "name") then return o end end
    return nil
  end, __pairs = function()
    local list = {player}
    for _, o in ipairs(lua_other_players()) do list[#list + 1] = o end
    local i = 0
    return function() i = i + 1 local p = list[i] if p then return p.index, p end end
  end}),
  -- 按名字存, 编号走 __index: 真的 game.surfaces 遍历时一个地表只出现一次 (两种键都存时模组遍历全地表的统计翻倍, 2026-11-06 对真值 221 vs 442)
  surfaces = setmetatable({nauvis = surface}, {__index = function(_, k) if k == surface.index then return surface end note("game.surfaces." .. tostring(k)) return nil end}),
  forces = {player = force_player, enemy = force_enemy, neutral = force_neutral},
  get_player = function(i)
    if i == player.index or i == player.name then return player end
    for _, o in ipairs(lua_other_players()) do if i == rawget(o, "index") or i == rawget(o, "name") then return o end end
    return nil
  end, get_surface = function(i) if i == surface.index or i == surface.name then return surface end return nil end,
  get_pollution_statistics = function() if pollution_gen ~= gen then pollution_gen = gen; pollution_stats = flow_object((W().pollution or {}).stats) end return pollution_stats end,
  print = function() end, permissions = tracked("permissions", {get_group = function() note("读不到:权限组") return nil end, create_group = function() return nil end}), map_settings = tracked("map_settings", {}), difficulty_settings = tracked("difficulty_settings", {}), is_multiplayer = function() return true end},
  {__index = function(_, k)
    if k == "tick" then return now.tick end
    if k == "tick_paused" then return now.paused end
    if k == "connected_players" then
      local out = {player}
      for _, o in ipairs(lua_other_players()) do if rawget(o, "connected") then out[#out + 1] = o end end
      return out
    end
    note("game." .. tostring(k))
    return nil
  end})

-- ---------- require: 从模组目录读 ----------
local cache = {}
function require(name)
  if cache[name] ~= nil then return cache[name] end
  local src = __py_read_mod(name)
  if src == nil then error("module not found: " .. tostring(name)) end
  local chunk, err = load(src, "@" .. name .. ".lua", "t", _ENV)
  if not chunk then error(err) end
  __module_count = __module_count + 1
  local v = chunk()
  if v == nil then v = true end
  cache[name] = v
  return v
end

-- ---------- 账本落盘 (--state): 模组的 storage 写成一段 Lua, 重启接着用。游戏里的存档负责这件事, 外面要自己来 ----------
-- 共享引用和环都保留 (先给每张表编号); 游戏对象写成怎么找回它: 实体按地址 + 编号 (游戏重启后地址变了就 valid = false, 和实体没了一样), 势力、地表、玩家、科技、原型按名字; 找不回的 (统计对象这些) 丢掉, 模组下次会重新要
local function object_ref(v)
  local kind = rawget(v, "object_name")
  if kind == "LuaEntity" then return string.format("E(%.0f,%s,%q)", rawget(v, "__addr") or 0, rawget(v, "unit_number") and string.format("%.0f", rawget(v, "unit_number")) or "nil", rawget(v, "name") or "") end
  if kind == "LuaForce" then return string.format("F(%q)", rawget(v, "name")) end
  if kind == "LuaSurface" then return "S()" end
  if kind == "LuaPlayer" then if rawget(v, "__other") then return nil end return "P()" end
  if kind == "LuaTechnology" then return string.format("TECH(%q)", rawget(v, "name")) end
  if kind and kind:match("Prototype$") then return string.format("PROTO(%q,%q)", (kind:gsub("^Lua", ""):gsub("Prototype$", ""):lower()), rawget(v, "name")) end
  return nil -- 别的游戏对象存不了
end
local function scalar(v)
  local t = type(v)
  if t == "number" then
    if v ~= v then return "0/0" end
    if v == math.huge then return "1/0" end
    if v == -math.huge then return "-1/0" end
    if v == math.floor(v) and math.abs(v) < 1e15 then return string.format("%.0f", v) end
    return string.format("%.17g", v)
  end
  if t == "string" then return string.format("%q", v) end
  if t == "boolean" then return tostring(v) end
  return nil
end
function __save_state()
  local ids, order, dropped = {}, {}, 0
  local function visit(t)
    if ids[t] then return end
    if rawget(t, "object_name") then return end
    ids[t] = #order + 1
    order[#order + 1] = t
    for k, v in next, t do
      if type(k) == "table" then dropped = dropped + 1 end
      if type(v) == "table" then visit(v) end
    end
  end
  visit(storage)
  local out = {string.format("local E,F,S,P,TECH,PROTO=...\nlocal T={} for i=1,%d do T[i]={} end", #order)}
  local function ref(v)
    if type(v) == "table" then
      local o = rawget(v, "object_name") and object_ref(v)
      if o then return o end
      if ids[v] then return "T[" .. ids[v] .. "]" end
      return nil
    end
    return scalar(v)
  end
  for i, t in ipairs(order) do
    for k, v in next, t do
      local kr, vr = (type(k) ~= "table") and scalar(k) or nil, ref(v)
      if kr and vr then out[#out + 1] = "T[" .. i .. "][" .. kr .. "]=" .. vr else dropped = dropped + 1 end
    end
  end
  out[#out + 1] = "return T[1]"
  return table.concat(out, "\n"), dropped
end
-- 把存的账本读回来; 换了世界的 (存的 tick 比现在还大) 不要
local function load_state(src)
  local chunk, err = load(src, "=state", "t", _ENV)
  if not chunk then return nil, err end
  local E = function(addr, unit, name) return setmetatable({__addr = addr, name = name, object_name = "LuaEntity", unit_number = unit}, nil) end
  return chunk(function(addr, unit, name)
    local e = E(addr, unit, name)
    local mt = getmetatable(entity_of({addr = addr, name = name, unit = unit}))
    return setmetatable(e, mt)
  end, function(name) return forces_by_name[name] or force_neutral end, function() return surface end, function() return player end,
  function(name) return force_player.technologies[name] end, function(label, name) local t = prototypes[label] return t and t[name] end)
end

-- 身体换了地表 (live.py follow_body 已经把实体和世界数据跟过去了): 这里只改名字和编号。只有一个 LuaSurface 对象, 模组拿着的还是它; 别的地表模组看不到, 见 io-client.md 11j
local function follow_surface(name, index)
  if not name or name == surface.name then return end
  rawset(game.surfaces, surface.name, nil)
  surface.name, surface.index = name, index
  rawset(game.surfaces, name, surface)
end

-- 一次提问开始: 上一次读到的都作废 (实体对象留着, 下次取字段时重新读)
local function begin_ask()
  gen = gen + 1
  lua_kind = "other"
  now = __py_begin()
  follow_surface(now.surface_name, now.surface_index)
  world = nil
  me = __py_player()
  rows_by_addr, grid, loaded, names_index, ordered = {}, {}, {}, {}, {}
  all_loaded = false
  owned_loaded = false
end

-- state: 上次存的账本 (Lua 源码), saved_tick: 存的时候的 tick。回: 成功?, 错误, 账本接上了吗
function __load_control(state, saved_tick)
  begin_ask()
  local restored = false
  if state and (not saved_tick or saved_tick <= now.tick) then
    local got = load_state(state)
    if type(got) == "table" then storage = got; restored = true end
  end
  local ok, err = xpcall(function() return require("control") end, debug.traceback)
  if not ok then return false, tostring(err), restored end
  local first = restored and handlers.load or handlers.init
  if first then
    local okk, e2 = xpcall(first, debug.traceback)
    if not okk then return false, "on_init: " .. tostring(e2), restored end
  end
  return true, nil, restored
end
function __tick_now() return now.tick end

local seq = 0
function __ask(cmd, raw)
  seq = seq + 1
  __last_traceback = nil
  begin_ask()
  local args = __py_json_decode(raw)
  local body = helpers.table_to_json({id = "probe-" .. seq, action = cmd, player = player.index, args = args, reader = "probe"})
  return interfaces.agent_harness.dispatch(body)
end

-- 模组的后台任务 (runtime.lua M.tick_body): 很多按 game.tick % N 分相位, 要逐个 tick 调, 跳着调会漏。
-- 一批现读一次内存, 这一批里 tick 往前走; 落后太多只补最近的 (后台任务都是"过一会儿再看一次", 少跑几轮不算错)。回: 跑了几个 tick
local MAX_TICK_BATCH = 240
local last_tick
-- 把内存比出来的变化发成事件 (live.py EventWatch / ChatReader)。事件字段按 runtime-api 的 on_built_entity 等; 比不出来的 (谁打的、伤害种类) 不写, 模组读到 nil
local function fire(name, event)
  local id = defines.events[name]
  local h = id and handlers[id]
  if not h then return end
  event.name, event.tick = id, now.tick
  h(event)
end
-- 已经不在内存里的实体: 用上一遍读到的那行当它最后的样子, 只在这个事件里有效
local function last_seen_entity(row)
  rawset(row, "__dead", true) -- 已经不在内存里, 细节不能再读 (ROW_MT)
  rows_by_addr[row.addr] = row
  local e = entity_of(row)
  rawset(e, "__gen", gen)
  rawset(e, "__row", row)
  rawset(e, "__cache", {})
  return e
end
-- 谁干的: 内存里没读 last_user, 只看得到东西多了少了。动手模式下离身体够得着的才算自己, 别的 (真人、机器人) 走 script_raised_*, 模组不记到谁头上;
-- 只读时一件都不算自己 (2026-11-06 真服只读: 别人拆东西, 提示写成 "Claude-Opus removed 20 of the team's entities")
local MY_REACH = 20
local function by_me(row)
  if __read_only or not (me and me.addr and me.position) then return false end
  local dx, dy = row.x - me.position.x, row.y - me.position.y
  return dx * dx + dy * dy <= MY_REACH * MY_REACH
end
local function dispatch_events()
  for _, ev in ipairs(__py_events()) do
    if ev.kind == "chat" then
      -- 真人的话 mode 是字面 (0), 正文开头带 ": " (docs/io-client.md 11h); 系统通知这些 player 是空的, 不算聊天
      if ev.player and ev.player ~= "" and ev.player ~= "<server>" and ev.index and ev.index ~= 65535 then
        fire("on_console_chat", {player_index = ev.index + 1, message = (ev.text or ""):gsub("^: ", "")})
      end
    elseif ev.kind == "research" then
      local tech = force_player.technologies[ev.name]
      if tech then fire("on_research_finished", {research = tech, by_script = false}) end
    elseif ev.kind == "built" then
      add_rows({ev.row})
      local built = entity_of(rows_by_addr[ev.row.addr] or ev.row)
      if by_me(ev.row) then fire("on_built_entity", {entity = built, player_index = player.index}) else fire("script_raised_built", {entity = built}) end
    elseif ev.kind == "damaged" then
      add_rows({ev.row})
      local row = rows_by_addr[ev.row.addr] or ev.row
      fire("on_entity_damaged", {entity = entity_of(row), final_damage_amount = ev.amount, original_damage_amount = ev.amount, final_health = row.d and row.d.health})
    elseif ev.kind == "died" then
      fire("on_entity_died", {entity = last_seen_entity(ev.row)})
    elseif ev.kind == "mined" then
      if by_me(ev.row) then fire("on_player_mined_entity", {entity = last_seen_entity(ev.row), player_index = player.index}) else fire("script_raised_destroy", {entity = last_seen_entity(ev.row)}) end
    end
  end
end

function __run_ticks(extra)
  begin_ask()
  if not extra then local ok, err = xpcall(dispatch_events, debug.traceback) if not ok then __event_error = tostring(err) end end
  local target = now.tick
  local from = last_tick or (target - (extra or 0) - 1)
  -- 量的时候 (extra) 不限批量
  if not extra and target - from > MAX_TICK_BATCH then from = target - MAX_TICK_BATCH end
  local on_tick = handlers[defines.events.on_tick]
  if not on_tick then return 0 end
  local n = 0
  for t = from + 1, target do
    now.tick = t
    on_tick({name = defines.events.on_tick, tick = t})
    n = n + 1
  end
  now.tick = target
  last_tick = target
  return n
end
-- 模组把自己隔离了吗 (后台出错时 runtime_fault 记在 storage 里, 之后 tick 全不跑): 假接口缺东西时第一时间看到
function __runtime_fault()
  for _, v in pairs(storage) do
    if type(v) == "table" and rawget(v, "runtime_fault") then return tostring(rawget(v, "runtime_fault")) end
  end
  return nil
end

-- ./fh 经代理来的请求 (src/io/mod-broker.ts): 原样的 JSON, id 不动 (命令行要核对); 身份换成本地玩家, 只读 (动作被模组的闸门拒掉, 代理再决定转发还是拒绝)
-- act = true: 模组自己账本上的命令 (sleep、tell、chat_ack…; src/io/mod-broker.ts LEDGER), 不碰游戏, 要占角色的消息和计时, 所以不走只读
function __dispatch(raw, act)
  __last_traceback = nil
  begin_ask()
  local request = __py_json_decode(raw)
  -- operator 请求不带玩家身份 (模组: "Operator tools (RCON, never fh)"), 只有代理的 operatorCall 走 act 这条路来 (递真人的话给模型); 别的路上来的当普通请求
  if act and request.operator == true then return interfaces.agent_harness.dispatch(helpers.table_to_json(request)) end
  request.operator = nil
  request.bot = nil
  request.player = player.index
  if not act then request.reader = "ext" end
  return interfaces.agent_harness.dispatch(helpers.table_to_json(request))
end

-- 跑一段和 RCON 上写法一样的只读 Lua, 回 JSON (开班扫描; 这里是游戏外的假接口, 服务器上一条都不跑)
function __eval(code)
  __last_traceback = nil
  begin_ask()
  local f, err = load("local function main() " .. code .. " end return helpers.table_to_json(main())")
  if not f then error(err) end
  return f()
end

-- 假接口自查: 统计和科技的回答, 形状和 world-compare.ts 的真值一样, 由 modhost-check 比
-- 坐标写成字符串时要和游戏一样: 整数不带 .0 (Lua 5.2 全是 double, tostring(3) 是 "3", 这里只防 -0)
function __num(v) if v == 0 then return "0" end return tostring(v) end
local PRECISIONS = {"five_seconds", "one_minute", "ten_minutes", "one_hour", "ten_hours", "fifty_hours", "two_hundred_fifty_hours", "one_thousand_hours"}
function __self_check()
  begin_ask()
  local out = {techs = {}, flows = {}, relations = {}}
  for name, t in pairs(force_player.technologies) do out.techs[name] = {researched = t.researched, enabled = t.enabled, level = t.level} end
  local function at(e) return e and (__num(e.position.x) .. "," .. __num(e.position.y)) or false end
  local function ats(list) local o = {} for i, e in ipairs(list or {}) do o[i] = at(e) end table.sort(o) return o end
  for _, e in ipairs(surface.find_entities_filtered{force = "player", type = {"transport-belt", "underground-belt", "splitter", "inserter", "mining-drill"}}) do
    local r = {}
    if e.type == "inserter" then r.pick = at(e.pickup_target) r.drop = at(e.drop_target) r.px = e.pickup_position.x r.py = e.pickup_position.y r.dx = e.drop_position.x r.dy = e.drop_position.y r.filters = e.use_filters r.mode = e.inserter_filter_mode
    elseif e.type == "mining-drill" then r.drop = at(e.drop_target) local dp = e.drop_position r.dx = dp and dp.x r.dy = dp and dp.y
    else local n = e.belt_neighbours r.ins = ats(n.inputs) r.outs = ats(n.outputs) if e.type == "transport-belt" then r.shape = e.belt_shape end if e.type == "underground-belt" then r.ug = e.belt_to_ground_type r.pair = at(e.underground_belt_neighbour) end end
    out.relations[at(e)] = r
  end
  local stats = {items = force_player.get_item_production_statistics(), fluids = force_player.get_fluid_production_statistics(), kills = force_player.get_kill_count_statistics(), builds = force_player.get_entity_build_count_statistics(), pollution = game.get_pollution_statistics()}
  local biggest, most = nil, -1
  for _, n in pairs(W().networks or {}) do
    local c = 0
    for _ in pairs(n.flow and n.flow.input or {}) do c = c + 1 end
    if c > most then biggest, most = n, c end
  end
  if biggest and biggest.flow then stats.electric = flow_object(biggest.flow, biggest) end
  for label, st in pairs(stats) do
    local rows = {}
    for _, pname in ipairs(PRECISIONS) do
      local row = {}
      for _, cat in ipairs({"input", "output"}) do
        for k in pairs(cat == "input" and st.input_counts or st.output_counts) do
          row[cat .. ":" .. k] = {avg = st.get_flow_count{name = k, category = cat, precision_index = defines.flow_precision_index[pname]}, count = st.get_flow_count{name = k, category = cat, precision_index = defines.flow_precision_index[pname], count = true}}
        end
      end
      rows[pname] = row
    end
    out.flows[label] = rows
  end
  return __py_json_encode(out)
end
