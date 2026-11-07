#!/usr/bin/env python
"""进程外读游戏内存的公共层: 打开进程、读字节、从游戏自带的 factorio.pdb 现场取布局 (pdb-dump)、布局缓存; 顺带读 物品 / 品质原型的 名字 ↔ 数字 ID (只读, 不注入)。

  python -I game/memory/reader.py --pid <factorio.exe 的进程号> [--exe <factorio.exe>] [--pdb-dump <pdb-dump.exe>] [--kinds Item,Quality]

原理 (游戏 2.1.24, 布局来自 factorio.pdb, 由 pdb-dump 现场取, 不存偏移表):
  PrototypeList<X>::indexToPrototype 是静态的 std::vector<X*>, 下标 = 该原型的数字 ID (ItemStack.itemID / ClientItemStackLocation.itemID 用的就是它);
  X 继承 Prototype<ID<X>> → PrototypeBase, 名字是 PrototypeBase+8 的 std::string (MSVC: 16 字节短串缓冲 / 指针, +16 长度, +24 容量), 数字 ID 在 +456 (Prototype<ID> 的 id, 读出来和下标核对)。
输出 JSON: {"module_base": ..., "Item": {"count": n, "by_name": {名字: id}, "mismatch": [...]}, "Quality": {...}}
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import re
import struct
import subprocess
import sys

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
LIST_MODULES_64BIT = 0x02

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)
k32.OpenProcess.restype = wt.HANDLE
k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
k32.ReadProcessMemory.restype = wt.BOOL
k32.ReadProcessMemory.argtypes = [wt.HANDLE, wt.LPCVOID, wt.LPVOID, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
psapi.EnumProcessModulesEx.restype = wt.BOOL
psapi.EnumProcessModulesEx.argtypes = [wt.HANDLE, ctypes.POINTER(wt.HMODULE), wt.DWORD, ctypes.POINTER(wt.DWORD), wt.DWORD]
psapi.GetModuleFileNameExW.restype = wt.DWORD
psapi.GetModuleFileNameExW.argtypes = [wt.HANDLE, wt.HMODULE, wt.LPWSTR, wt.DWORD]


class Reader:
    def __init__(self, pid: int):
        self.h = k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
        if not self.h:
            raise OSError(f"OpenProcess({pid}) 失败: {ctypes.get_last_error()}")
        # 一次提问几十万次读: 每次新建缓冲占了读内存时间的四分之一 (2026-11-06 剖析联机服务器的存档副本), 小的共用一块。只在一个线程用
        self._small = ctypes.create_string_buffer(4096)
        self._got = ctypes.c_size_t(0)
        self._got_ref = ctypes.byref(self._got)

    def read(self, address: int, size: int) -> bytes:
        if size <= 4096:
            if not k32.ReadProcessMemory(self.h, address, self._small, size, self._got_ref) or self._got.value != size:
                raise OSError(f"读 {address:#x}+{size} 失败: {ctypes.get_last_error()}")
            return ctypes.string_at(self._small, size)
        buf = ctypes.create_string_buffer(size)
        got = ctypes.c_size_t(0)
        if not k32.ReadProcessMemory(self.h, ctypes.c_void_p(address), buf, size, ctypes.byref(got)) or got.value != size:
            raise OSError(f"读 {address:#x}+{size} 失败: {ctypes.get_last_error()}")
        return buf.raw

    def u64(self, address: int) -> int:
        return int.from_bytes(self.read(address, 8), "little")

    def u16(self, address: int) -> int:
        return int.from_bytes(self.read(address, 2), "little")

    def u8(self, address: int) -> int:
        return self.read(address, 1)[0]

    def u32(self, address: int) -> int:
        return int.from_bytes(self.read(address, 4), "little")

    def f32(self, address: int) -> float:
        return struct.unpack("<f", self.read(address, 4))[0]

    def f64(self, address: int) -> float:
        return struct.unpack("<d", self.read(address, 8))[0]

    def msvc_string(self, address: int) -> str:
        """MSVC std::string: +0 16 字节 (短串内容 / 长串指针), +16 size, +24 capacity (≥16 = 长串)"""
        raw = self.read(address, 32)
        size = int.from_bytes(raw[16:24], "little")
        cap = int.from_bytes(raw[24:32], "little")
        if size > 4096:
            raise ValueError(f"字符串长度不合理 {size}")
        if cap >= 16:
            ptr = int.from_bytes(raw[0:8], "little")
            return self.read(ptr, size).decode("utf-8", "replace")
        return raw[0:size].decode("utf-8", "replace")

    def module_base(self, name: str) -> int:
        count = 256
        while True:
            arr = (wt.HMODULE * count)()
            needed = wt.DWORD(0)
            if not psapi.EnumProcessModulesEx(self.h, arr, ctypes.sizeof(arr), ctypes.byref(needed), LIST_MODULES_64BIT):
                raise OSError(f"EnumProcessModulesEx 失败: {ctypes.get_last_error()}")
            n = needed.value // ctypes.sizeof(wt.HMODULE)
            if n <= count:
                break
            count = n
        for i in range(n):
            buf = ctypes.create_unicode_buffer(1024)
            psapi.GetModuleFileNameExW(self.h, arr[i], buf, 1024)
            if os.path.basename(buf.value).lower() == name.lower():
                return arr[i] if arr[i] >= 0 else arr[i] + (1 << 64)
        raise RuntimeError(f"进程里没有模块 {name}")


def rva(pdb_dump: str, exe: str, symbol: str) -> int:
    """用 pdb-dump 从 factorio.pdb 取符号的 RVA (每次现场取, 不存偏移表)"""
    out = subprocess.run([pdb_dump, exe, "sym", symbol], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    for line in out.stdout.splitlines():
        m = re.match(r"\+0x([0-9a-fA-F]+)\t(.+?)\t", line)
        if m and m.group(2) == symbol:
            return int(m.group(1), 16)
    raise RuntimeError(f"pdb 里没有符号 {symbol}: {out.stdout[:300]} {out.stderr[:300]}")


def member_offset(pdb_dump: str, exe: str, struct: str, member: str, type_prefix: str, depth: int = 1) -> int:
    """成员偏移: 按名字 + 类型前缀找 (嵌套里同名成员多, 比如 IDConnector 里也有 id); 只认基类在 +0 的那层"""
    out = subprocess.run([pdb_dump, exe, "struct", struct, str(depth)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    for line in out.stdout.splitlines():
        m = re.match(r"\s*\+(\d+)\t\S+\t(.+?)\t(\S+)$", line)
        if m and m.group(3) == member and m.group(2).startswith(type_prefix):
            return int(m.group(1))
    raise RuntimeError(f"{struct} 里没有成员 {member} ({type_prefix}): {out.stdout[:400]}")


ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def env_file_var(key: str) -> str | None:
    """仓库 .env 里的一个变量 (KEY=VALUE, 去掉两边引号; 和 game/sandbox/paths.ts envFileVar 同一条规则)。进程不一定带着 .env 的变量, 所以也读文件"""
    try:
        with open(os.path.join(ROOT, ".env"), encoding="utf-8") as f:
            for line in f:
                k, sep, val = line.strip().partition("=")
                if sep and k.strip() == key:
                    return val.strip().strip('"').strip("'") or None
    except OSError:
        pass
    return None


def data_root() -> str:
    """本机数据目录 (不上传): 环境变量 DATA_DIR → 仓库 .env 的 DATA_DIR → <仓库>/data (和 game/sandbox/paths.ts dataRoot 同一条规则)"""
    return os.path.abspath(os.environ.get("DATA_DIR") or env_file_var("DATA_DIR") or os.path.join(ROOT, "data"))


def default_exe() -> str:
    """要读的游戏 exe 的默认值 (布局按它的 pdb 取): FACTORIO_EXE → FACTORIO_DIR (环境变量或 .env) 下的 bin/x64/factorio.exe"""
    exe = os.environ.get("FACTORIO_EXE")
    if exe:
        return exe
    d = os.environ.get("FACTORIO_DIR") or env_file_var("FACTORIO_DIR")
    if not d:
        raise SystemExit("要 --exe, 或 .env 里的 FACTORIO_DIR")
    return os.path.join(d, "bin", "x64", "factorio.exe")


def default_pdb_dump() -> str:
    """pdb-dump.exe 放在数据目录的 tools 下 (npm run memory:setup 用本机的 Visual Studio 编)"""
    return os.path.join(data_root(), "tools", "pdb-dump.exe")


def layout_cache_path(exe: str) -> str:
    return os.path.join(data_root(), "memory", "layout-cache.json")


def cached_layout(pdb_dump: str, exe: str, key: str, compute):
    """布局缓存 (本机 data/, 不进仓库): 按 exe 的大小 + 修改时间分开存, 游戏一更新就自动失效 (pdb-dump 每次要加载 461MB 的 pdb, 约 1.3 秒一次)"""
    st = os.stat(exe)
    tag = f"{os.path.abspath(exe)}|{st.st_size}|{int(st.st_mtime)}"
    p = layout_cache_path(exe)
    data = {}
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    bucket = data.get(tag) or {}
    if key in bucket:
        return bucket[key]
    value = compute()
    bucket[key] = value
    # 留最近几份: Steam 版和独立版的 exe 不一样, 只留一份的话来回切换每次都要重算约 4 分钟 (2026-11-07 play:mk 量的)
    data.pop(tag, None)
    data[tag] = bucket
    data = dict(list(data.items())[-4:])
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    return value


def read_list(r: Reader, base: int, pdb_dump: str, exe: str, kind: str, id_size: int) -> dict:
    proto = f"{kind}Prototype"
    vec = base + cached_layout(pdb_dump, exe, f"rva:PrototypeList<{proto}>::indexToPrototype", lambda: rva(pdb_dump, exe, f"PrototypeList<{proto}>::indexToPrototype"))
    name_off = cached_layout(pdb_dump, exe, "off:PrototypeBase.name", lambda: member_offset(pdb_dump, exe, "PrototypeBase", "name", "std::basic_string"))
    id_off = cached_layout(pdb_dump, exe, f"off:{proto}.id", lambda: member_offset(pdb_dump, exe, proto, "id", f"ID<{proto}"))  # Prototype<ID<...>>::id, 在 +0 的基类里 (深度 1 就列出来)
    begin, end = r.u64(vec), r.u64(vec + 8)
    count = (end - begin) // 8
    if not (0 < count < 100000):
        raise RuntimeError(f"{proto} 表长度不合理 {count} (begin {begin:#x} end {end:#x})")
    by_name, by_id, mismatch, empty = {}, {}, [], 0
    for i in range(count):
        p = r.u64(begin + i * 8)
        if p == 0:
            empty += 1
            continue
        name = r.msvc_string(p + name_off)
        pid = r.u16(p + id_off) if id_size == 2 else r.u8(p + id_off)
        if pid != i:
            mismatch.append({"index": i, "id": pid, "name": name})
        by_name[name] = i
        by_id[i] = name
    return {"count": count, "empty_slots": empty, "by_name": by_name, "mismatch": mismatch, "vector_rva": hex(vec - base), "name_offset": name_off, "id_offset": id_off}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--exe", default=None)
    ap.add_argument("--pdb-dump", default=default_pdb_dump())
    ap.add_argument("--kinds", default="Item,Quality")
    args = ap.parse_args()
    args.exe = args.exe or default_exe()
    r = Reader(args.pid)
    base = r.module_base("factorio.exe")
    out = {"pid": args.pid, "module_base": hex(base)}
    for kind in args.kinds.split(","):
        out[kind] = read_list(r, base, args.pdb_dump, args.exe, kind, 2 if kind == "Item" else 1)
    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
