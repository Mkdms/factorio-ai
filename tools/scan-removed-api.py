"""扫一个 Lua 模组目录里用到的、在 2.1 被删 / 改名的接口 (搬 2.0 模组用; docs/lab.md #67 #68)。
依据: 游戏自带 data/changelog.txt 里 2.1.x 各版 "Removed" / "Renamed" / "Replaced" 的 Lua 条目 (Replaced 2026-11-03 补: fuel_category 漏了)。
另外单独报按字符串拼的物品栏名 (defines.inventory[...] 和旧名字字符串), 那类 grep 接口名扫不到 (#68)。
用法: python -I tools/scan-removed-api.py <Lua 目录> [--changelog <游戏目录>/data/changelog.txt]
"""
import io
import os
import re
import sys


def removed_ids(changelog):
    lines = io.open(changelog, encoding="utf-8", errors="replace").read().split("\n")
    end = next(i for i, l in enumerate(lines) if re.match(r"Version: 2\.0\.", l))
    out = {}
    for l in lines[:end]:
        if not (re.search(r"\b(Removed|Renamed)\b", l) and ("Lua" in l or "defines" in l)):
            continue
        if "write" in l and "read" not in l and re.search(r"Removed Lua\w+::\w+ write", l):
            continue  # 只删了写, 读还在
        for m in re.finditer(r"(Lua\w+)::(\w+)", l):
            out.setdefault(m.group(2), l.strip())
        m = re.search(r"defines\.(\w+)\.(\w+)((?:,\s*(?:and\s+)?\w+)*)", l)
        if m:
            out.setdefault(m.group(2), l.strip())
            for w in re.findall(r"\w+", m.group(3)):
                if w != "and":
                    out.setdefault(w, l.strip())
    for k in ("name", "type", "index", "position", "count", "valid", "and", "Use", "instead", "get", "set", "active", "minable"):
        out.pop(k, None)
    return out


def main(root, changelog):
    ids = removed_ids(changelog)
    files = []
    for d, _, fs in os.walk(root):
        files += [os.path.join(d, f) for f in fs if f.endswith(".lua")]
    print(f"{len(files)} 个 Lua 文件; 2.1 删 / 改名的接口名 {len(ids)} 个")
    hits = {}
    for f in files:
        s = io.open(f, encoding="utf-8", errors="replace").read()
        for i in ids:
            for m in re.finditer(r"[.:]" + re.escape(i) + r"\b", s):
                line = s.count("\n", 0, m.start()) + 1
                hits.setdefault(i, []).append(f"{os.path.relpath(f, root)}:{line}")
        for m in re.finditer(r"defines\.inventory\[", s):
            hits.setdefault("defines.inventory[ 按名字查", []).append(f"{os.path.relpath(f, root)}:{s.count(chr(10), 0, m.start()) + 1}")
        for m in re.finditer(r"['\"](furnace_source|furnace_result|assembling_machine_input|assembling_machine_output|rocket_silo_input|rocket_silo_output|furnace_modules|assembling_machine_modules)['\"]", s):
            hits.setdefault("旧物品栏名字符串", []).append(f"{os.path.relpath(f, root)}:{s.count(chr(10), 0, m.start()) + 1}")
    for i, where in sorted(hits.items(), key=lambda kv: -len(kv[1])):
        print(f"\n{i}: {len(where)} 处  ({ids.get(i, '')[:110]})")
        print("  " + "  ".join(where[:12]) + (" …" if len(where) > 12 else ""))


if __name__ == "__main__":
    args = sys.argv[1:]
    cl = None
    if "--changelog" in args:
        cl = args[args.index("--changelog") + 1]
    else:
        env = io.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"), encoding="utf-8").read()
        d = re.search(r"^FACTORIO_DIR=(.*)$", env, re.M).group(1).strip().strip('"')
        cl = os.path.join(d, "data", "changelog.txt")
    main(args[0], cl)
