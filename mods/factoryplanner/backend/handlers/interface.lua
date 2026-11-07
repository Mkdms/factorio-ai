-- ** MAIN **
---@param player_index PlayerIndex
---@return PackedFactory?
local function export_current_factory(player_index)
    local player = game.get_player(player_index)
    if not player then return nil end

    local player_table = lib.globals.player_table(player)
    if not player_table then return nil end

    local current_factory = lib.context.get(player, "Factory")  ---@as Factory
    if not current_factory then return nil end

    return current_factory:pack(true)
end

---@param player_index PlayerIndex
---@return table?
local function export_preferences(player_index)
    local player = game.get_player(player_index)
    if not player then return nil end

    local player_table = lib.globals.player_table(player)
    if not player_table then return nil end

    return lib.porter.unpack_export_string(lib.preferences.export(player))
end

---@param player_index PlayerIndex
---@param export_table table
---@return string | true | nil
local function import_preferences(player_index, export_table)
    local player = game.get_player(player_index)
    if not player then return nil end

    local player_table = lib.globals.player_table(player)
    if not player_table then return nil end

    local export_string = lib.porter.pack_export_string(export_table)
    local error = lib.preferences.import(player, export_string)
    if error then
        return error
    else
        lib.preferences.refresh_after_change(player, "all")
        return true
    end
end


-- Factorio Pilot patch: solve_packed (tools/patch-fp.py): solve a packed factory without the GUI, for cross-checking our own calculator.
-- Input: the same table shape as export_current_factory returns (PackedFactory: items with definitions, top_floor with lines).
-- The factory is inserted into the player's current district, validated / repaired, solved, packed (full) and removed again.
-- (require only works while control.lua is being parsed, so these two sit at file level, not inside the function)
local FP_PILOT_Factory = require("backend.data.Factory")
local function solve_packed(player_index, packed_factory)
    local player = game.get_player(player_index)
    if not player then return {error = "no player " .. tostring(player_index)} end
    local player_table = lib.globals.player_table(player)
    if not player_table then return {error = "no player table"} end
    local district = lib.context.get(player, "District")
    if not district then return {error = "no district"} end
    local Factory = FP_PILOT_Factory
    -- solver is one of Factory Planner's globals (backend/calculation/solver.lua: `solver = {...}`), not a require result
    if not (solver and solver.update) then return {error = "no global solver"} end
    local ok_unpack, factory = pcall(Factory.unpack, packed_factory)
    if not ok_unpack then return {error = "unpack: " .. tostring(factory)} end
    district:insert(factory)
    -- debug: what unpacked, what validation thought of each line, what repair kept (our packed tables may name things FP cannot find)
    local dbg = {lines_unpacked = factory.top_floor:count(), items_unpacked = factory:count(), lines = {}}
    local ok, err = pcall(function()
        factory:validate(player)
        dbg.valid_before = factory.valid
        for line in factory.top_floor:iterator() do
            if line.class == "Line" then
                dbg.lines[#dbg.lines + 1] = {recipe = line.recipe and line.recipe.proto and line.recipe.proto.name, recipe_valid = line.recipe and line.recipe.valid,
                    machine = line.machine and line.machine.proto and line.machine.proto.name, machine_valid = line.machine and line.machine.valid, valid = line.valid}
            end
        end
        for item in factory:iterator() do
            dbg.items = dbg.items or {}
            dbg.items[#dbg.items + 1] = {name = item.proto and item.proto.name, valid = item.valid, simplified = item.proto and item.proto.simplified}
        end
        if not factory.valid then factory:repair(player) end
        dbg.lines_after_repair = factory.top_floor:count()
        solver.update(player, factory, true)
    end)
    local result = ok and factory:pack(true) or {error = "solve: " .. tostring(err)}
    if ok then result.valid = factory.valid end
    result.debug = dbg
    district:remove(factory)
    return result
end

remote.add_interface("fp-interface", {
    solve_packed = solve_packed,
    export_current_factory = export_current_factory,
    export_preferences = export_preferences,
    import_preferences = import_preferences
})
