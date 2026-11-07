"""把 Factory Planner (ClaudeMetz/FactoryPlanner, MIT) 的模组复制到 mods/factoryplanner 并加一个 remote 接口 solve_packed,
让我们能不开它的界面、直接把一份打包好的工厂交给它的求解器算。
用途: 给我们自己的计算器 (src/calc) 当对照答案 (src/calc/fp-crosscheck.ts)。只在沙盘里能用 (游戏内模组, 要有玩家); 朋友服务器装不了。
mods/factoryplanner 不进仓库 (.gitignore; 别人的代码, 这个脚本随时能重新生成); 用法:
  python -I tools/patch-fp.py --src I:/fn/refs/FactoryPlanner --dst mods/factoryplanner
"""
import argparse
import shutil
import sys
from pathlib import Path

MARK = "-- Factorio Pilot patch: solve_packed"

PATCH = r'''
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
'''


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="FactoryPlanner 仓库目录 (含 modfiles/)")
    ap.add_argument("--dst", required=True, help="写到哪 (例: mods/factoryplanner)")
    a = ap.parse_args()
    src = Path(a.src) / "modfiles"
    dst = Path(a.dst)
    if not (src / "info.json").exists():
        print(f"没有 {src}/info.json")
        return 1
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))
    iface = dst / "backend" / "handlers" / "interface.lua"
    text = iface.read_text(encoding="utf-8")
    anchor = 'remote.add_interface("fp-interface", {'
    if anchor not in text:
        print("interface.lua 里找不到 fp-interface 的注册, Factory Planner 版本变了?")
        return 1
    if MARK not in text:
        text = text.replace(anchor, PATCH + "\n" + anchor + "\n    solve_packed = solve_packed,", 1)
        iface.write_text(text, encoding="utf-8")
    (dst / "FACTORIO-PILOT-PATCH.md").write_text(
        "本目录是 Factory Planner (https://github.com/ClaudeMetz/FactoryPlanner, MIT) 的副本, 由 tools/patch-fp.py 生成, "
        "只加了 remote 接口 fp-interface.solve_packed (backend/handlers/interface.lua)。不进仓库。\n", encoding="utf-8")
    print(f"写好了 {dst} (版本见 info.json), 接口 fp-interface.solve_packed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
