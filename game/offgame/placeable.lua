-- 放置检查: 游戏 can_place_entity (手放) 的替身, 纯函数, 不碰内存。给原型的原始数据、位置、朝向和两个回调 (范围里的实体、某格的地块名), 答放得下不、不行的话为什么。
-- 看三样 (和游戏手放时的检查对得上的部分):
--   ① 占地框里有挡建造的实体 (树、石头、建筑都挡; 角色、矿、地上的物品、虚影、机器人不挡; 表和 commands/actions.ts 的 PASSABLE / WALK_THROUGH_BUT_BLOCKS 一致, 改要一起改);
--   ② 占地框盖到的地块的碰撞层和实体的碰撞层撞上 (大多数建筑没写碰撞层, 用游戏的默认层, 里面有 water_tile: 放不到水上; 抽水机自己写了层, 没有 water_tile, 所以它的框能伸到水上);
--   ③ 原型的地块规则 tile_buildability_rules (抽水机: 脚下那格陆地, 正面 3 宽 2 深全是水; 2.0.77 派对在湖边核过这个读法, shore.lua tile_rules 同一个算法)。
-- 地块没读到 (区块没生成、没开 --lua、额度用完) = 放不下并说清是没读到, 不编。
-- 2026-11-08 第四班: 19 次放不下里 17 次是抽水机放在不是岸边的格子, 而 nearest_water / placements 找抽水机位置靠的 can_place_entity 在游戏外一直是空的。
local M = {}

-- 不挡建造的类型 (= actions.ts PASSABLE 减去 WALK_THROUGH_BUT_BLOCKS)
M.NOT_BLOCKING = {}
for _, t in ipairs({"character", "resource", "item-entity", "corpse", "character-corpse", "rail-remnants", "fish", "entity-ghost", "tile-ghost", "item-request-proxy", "deconstructible-tile-proxy",
  "highlight-box", "speech-bubble", "flying-text", "smoke-with-trigger", "fire", "sticker", "projectile", "artillery-projectile", "artillery-flare", "explosion", "particle-source", "beam",
  "elevated-straight-rail", "elevated-curved-rail-a", "elevated-curved-rail-b", "elevated-half-diagonal-rail",
  "logistic-robot", "construction-robot", "combat-robot", "capture-robot", "spider-vehicle", "spider-unit", "cargo-pod", "rocket-silo-rocket", "rocket-silo-rocket-shadow"}) do M.NOT_BLOCKING[t] = true end

-- 没写 collision_mask 的实体用游戏的默认层 (lua-api.factorio.com EntityPrototype collision_mask 默认值)
M.DEFAULT_MASK = {item = true, meltable = true, object = true, player = true, water_tile = true, is_object = true, is_lower_object = true}

local EPS = 0.001
-- 地块格子的边界: 框压到一格的面积 ≥ 0.05 才算盖到 (shore.lua tile_rules 同一个阈值)
local TILE_EPS = 0.05

local function xy(v) if v == nil then return nil end return v.x or v[1], v.y or v[2] end

-- 原型里的框 ({{x0,y0},{x1,y1}} 或 {left_top=, right_bottom=}, 朝北) 转到朝向 dir (0/4/8/12), 回绝对坐标 x0,y0,x1,y1
function M.rot_box(box, cx, cy, dir)
  local lt, rb = box[1] or box.left_top, box[2] or box.right_bottom
  local ax0, ay0 = xy(lt)
  local ax1, ay1 = xy(rb)
  dir = math.floor((tonumber(dir) or 0) / 4) * 4 % 16
  if dir == 4 then return cx - ay1, cy + ax0, cx - ay0, cy + ax1 end
  if dir == 8 then return cx - ax1, cy - ay1, cx - ax0, cy - ay0 end
  if dir == 12 then return cx + ay0, cy - ax1, cx + ay1, cy - ax0 end
  return cx + ax0, cy + ay0, cx + ax1, cy + ay1
end

-- 框盖到的格子 (整数格坐标范围)
function M.tiles_of(x0, y0, x1, y1)
  return math.floor(x0 + TILE_EPS), math.floor(y0 + TILE_EPS), math.ceil(x1 - TILE_EPS) - 1, math.ceil(y1 - TILE_EPS) - 1
end

local function mask_of(proto)
  local m = proto.collision_mask
  local layers = m and m.layers
  if layers and next(layers) ~= nil then return layers, m end
  return M.DEFAULT_MASK, m
end

-- a = {proto = 原型 (原始字段: collision_box / collision_mask / tile_buildability_rules / type), name =, x =, y =, direction = 0/4/8/12,
--      entities = function(x0, y0, x1, y1) -> {{name=, type=, x0=, y0=, x1=, y1=}, ...}  (范围里的实体和它们的占地框),
--      tile = function(tx, ty) -> 地块名 或 nil (没读到), tile_layers = function(name) -> {层 = true}}
-- 回 ok, why (why: 中文一句, 放得下时 nil)
function M.check(a)
  local proto = a.proto
  if not proto then return false, "没有这个原型: " .. tostring(a.name) end
  local box = proto.collision_box
  if not box then return false, tostring(a.name) .. " 没有占地框, 不是能放的建筑" end
  local x0, y0, x1, y1 = M.rot_box(box, a.x, a.y, a.direction)
  -- ① 实体
  for _, e in ipairs(a.entities(x0, y0, x1, y1) or {}) do
    if not M.NOT_BLOCKING[e.type or ""] and e.x1 > x0 + EPS and e.x0 < x1 - EPS and e.y1 > y0 + EPS and e.y0 < y1 - EPS then
      return false, string.format("%s (%g,%g) 挡着", e.name, (e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2)
    end
  end
  -- ② 脚下的地块和碰撞层
  local layers, raw_mask = mask_of(proto)
  local tx0, ty0, tx1, ty1 = M.tiles_of(x0, y0, x1, y1)
  for ty = ty0, ty1 do
    for tx = tx0, tx1 do
      local name = a.tile(tx, ty)
      if name == nil then return false, string.format("地块 (%d,%d) 没读到 (区块没生成或没开 --lua)", tx, ty) end
      for layer in pairs(a.tile_layers(name) or {}) do
        if layers[layer] then return false, string.format("脚下 (%d,%d) 是 %s, 放不上", tx, ty, name) end
      end
    end
  end
  -- ③ 地块规则
  for _, rule in ipairs(proto.tile_buildability_rules or {}) do
    local need = rule.required_tiles and rule.required_tiles.layers or {}
    local bar = rule.colliding_tiles and rule.colliding_tiles.layers or {}
    if rule.area and (next(need) ~= nil or next(bar) ~= nil) then
      local rx0, ry0, rx1, ry1 = M.rot_box(rule.area, a.x, a.y, a.direction)
      local ux0, uy0, ux1, uy1 = M.tiles_of(rx0, ry0, rx1, ry1)
      for ty = uy0, uy1 do
        for tx = ux0, ux1 do
          local name = a.tile(tx, ty)
          if name == nil then return false, string.format("地块 (%d,%d) 没读到 (区块没生成或没开 --lua)", tx, ty) end
          local tl = a.tile_layers(name) or {}
          for layer in pairs(need) do
            if not tl[layer] then return false, string.format("(%d,%d) 是 %s, 这格要 %s", tx, ty, name, layer == "water_tile" and "水" or layer == "ground_tile" and "陆地" or layer) end
          end
          for layer in pairs(bar) do
            if tl[layer] then return false, string.format("(%d,%d) 是 %s, 这格不能是 %s", tx, ty, name, layer == "water_tile" and "水" or layer) end
          end
        end
      end
    end
  end
  return true, nil
end

return M
