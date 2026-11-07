-- Factorio 2.1 compatibility for the upstream 2.0 code (Factorio Pilot port, 2026-11-02).
-- 2.1 removed LuaEntity::fluidbox / LuaFluidBox, LuaEntity::neighbours and
-- LuaRecipe(Prototype)::category (2.1.24 data/changelog.txt "Removed LuaEntity::fluidbox ...",
-- "Removed LuaEntity::neighbors read ...", "Removed LuaRecipe::category ..."; replacements per
-- doc-html/runtime-api.json 2.1.24). These helpers keep the upstream call sites unchanged in shape.
local M={}

-- A stand-in for the old LuaFluidBox: #fb, fb[i] and the per-index methods the upstream code
-- calls without self (pcall(fb.get_pipe_connections,i)), backed by the 2.1 LuaEntity methods.
function M.fluidbox(e)
  local n=e.fluids_count
  local fb={
    owner=e, -- 2.0 LuaFluidBox.owner (2.1: the entity itself)
    get_pipe_connections=function(i) return e.get_fluid_box_pipe_connections(i) end,
    get_capacity=function(i) return e.get_fluid_capacity(i) end,
    get_filter=function(i) return e.get_fluid_filter(i) end,
    -- No 2.1 equivalent of the old locked-fluid read; callers fall back to nil.
    get_locked_fluid=function(i) return nil end,
    get_fluid_segment_id=function(i) return e.get_fluid_segment_id(i) end,
    get_fluid_segment_extent_bounding_box=function(i) return e.get_fluid_segment_extent_bounding_box(i) end,
  }
  return setmetatable(fb,{
    __len=function() return n end,
    __index=function(_,i) if type(i)=='number' then return e.get_fluid(i) end end,
  })
end

-- Partner of an underground belt (was LuaEntity::neighbours for underground belts).
function M.underground_partner(e) return e.underground_belt_neighbour end

-- x.fuel_category for an item prototype: the old read where it still exists, else the first of 2.1's fuel_categories
-- (2.1 changelog, after 2.1.19: "Replaced LuaItemPrototype::fuel_category read with fuel_categories read"; round 6: refuel
-- failed with "LuaItemPrototype doesn't contain key fuel_category"). The list may come as an array or as a {name=true} set.
function M.fuel_category(x)
  local ok, v = pcall(function() return x.fuel_category end)
  if ok and v ~= nil then return v end
  local okl, l = pcall(function() return x.fuel_categories end)
  if not okl or type(l) ~= 'table' then return nil end
  if l[1] ~= nil then return type(l[1]) == 'table' and l[1].name or l[1] end
  local k = next(l)
  return k
end

-- x.neighbours for any object: the old field where it still exists (plain tables, older objects), else the 2.1 read
-- for the entity's type. 2.1 changelog: "Removed LuaEntity::neighbors read. Added LuaEntity::fluidbox_neighbours,
-- underground_belt_neighbour, wall_neighbours, cliff_neighbours ... Use those and belt_neighbours, heat_neighbours".
-- nil for anything else (electric poles lost neighbours back in 2.0; their wires are get_wire_connectors).
function M.neighbours(x)
  local ok, v = pcall(function() return x.neighbours end)
  if ok and v ~= nil then return v end
  local okt, t = pcall(function() return x.type end)
  if not okt or not t then return nil end
  local read = ({['underground-belt']='underground_belt_neighbour', ['linked-belt']='linked_belt_neighbour', wall='wall_neighbours',
    gate='wall_neighbours', cliff='cliff_neighbours', ['heat-pipe']='heat_neighbours', reactor='heat_neighbours', ['heat-interface']='heat_neighbours'})[t]
    or 'fluidbox_neighbours'
  local okr, r = pcall(function() return x[read] end)
  return okr and r or nil
end

-- Whether a recipe fits a set of crafting categories ({[name]=true}); 2.1 recipes have a list.
function M.recipe_fits(categories,recipe)
  for _,c in ipairs(recipe.categories or {}) do if categories[c] then return true end end
  return false
end

-- x.category / x.additional_categories for any object: the old field where the object still has it (other
-- prototypes, plain tables), else from the 2.1 recipe list (categories[1] is the primary one).
function M.category(x)
  local ok, c = pcall(function() return x.category end)
  if ok and c ~= nil then return c end
  local ok2, cs = pcall(function() return x.categories end)
  if ok2 and type(cs) == 'table' then return cs[1] end
  return nil
end
function M.additional_categories(x)
  local ok, c = pcall(function() return x.additional_categories end)
  if ok and c ~= nil then return c end
  local ok2, cs = pcall(function() return x.categories end)
  local out = {}
  if ok2 and type(cs) == 'table' then for i = 2, #cs do out[#out + 1] = cs[i] end end
  return out
end

-- Inventory by its 2.0 name: 2.1 merged the furnace / assembling machine / rocket silo inventories into
-- crafter_* ("Removed defines.inventory.assembling_machine_input, furnace_source, and rocket_silo_input.
-- Use defines.inventory.crafter_input instead", and the same for output, modules, trash). The action
-- arguments keep the familiar names; this maps them.
local CRAFTER={
  furnace_source='crafter_input', assembling_machine_input='crafter_input', rocket_silo_input='crafter_input',
  furnace_result='crafter_output', assembling_machine_output='crafter_output', rocket_silo_output='crafter_output',
  furnace_modules='crafter_modules', assembling_machine_modules='crafter_modules', rocket_silo_modules='crafter_modules',
  furnace_trash='crafter_trash', assembling_machine_trash='crafter_trash',
}
function M.inventory(name) return defines.inventory[name] or defines.inventory[CRAFTER[name] or ''] end

-- 2.1: PipeConnection.target is the connected entity (2.0: its LuaFluidBox). The box to walk on from it, for either
-- (factorio-ai-party mod read 2026-11-03: thrust / conflicts / libareas / endurance read target.owner, nil in 2.1).
function M.conn_box(t)
  if t == nil then return nil end
  local ok, on = pcall(function() return t.object_name end)
  if ok and on == 'LuaEntity' then return M.fluidbox(t) end
  return t
end

return M
