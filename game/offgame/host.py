#!/usr/bin/env python
"""游戏外的模组宿主: 把 harness 模组 (game/mod/factorio-ai-harness) 的 Lua 原样放在游戏外面跑。

Lua 5.2 (和游戏同版本) 用 lupa; 游戏接口是假的 (fake_game.lua), 数据来自 game/memory/live.py: 读活内存 (--pid) 或回放快照 (--snapshot)。
缺的接口全部记下来 (__missing), 不瞎编。只读: 动作类假接口都没做, 动作由外面翻译成玩家操作。

  python -I game/offgame/host.py --defines defines.json --proto data-raw-dump.json --pid <进程号> --exe <它的 exe> --ask 'status' --ask 'observe:{"radius":8}'
  ... --snapshot 快照.json --ask ...    回放
  ... --pid .. --exe .. --dump 快照.json   只把内存读成快照 (不跑模组)
  ... --pid .. --exe .. --serve         常驻: 标准输入一行一个 {"cmd": "status", "args": {}}, 标准输出一行一个回复
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)  # python -I 不把脚本目录放进搜索路径
sys.path.insert(0, os.path.join(ROOT, "game", "memory"))  # 读内存 (live / entities / world / reader)
MOD = os.path.join(ROOT, "game", "mod", "factorio-ai-harness")
LUA_TTL = 3.0  # 秒
LUA_BUDGET = {"fluid": 24, "other": 32, "tile": 400}  # 一次提问最多问几条 (每条约 30 毫秒); 分开算: 流体多, 不能把物流网和别的玩家的份吃光 (2026-11-06 核对时 status 的物流网就这么读成了"没有"); 地块按区块问, fake_game 自己缓存, 只有第一次看一片地才多


def to_lua(lua, v):
    if isinstance(v, dict):
        t = lua.table()
        for k, x in v.items():
            t[k] = to_lua(lua, x)
        return t
    if isinstance(v, (list, tuple)):
        t = lua.table()
        for i, x in enumerate(v):
            t[i + 1] = to_lua(lua, x)
        return t
    return v


def from_lua(lua, v, depth=0):
    tname = lua.globals().type(v) if not isinstance(v, (int, float, str, bool, type(None))) else None
    if tname == "table" and depth < 32:
        keys = list(v.keys())
        if keys and all(isinstance(k, (int, float)) for k in keys) and sorted(keys) == list(range(1, len(keys) + 1)):
            return [from_lua(lua, v[k], depth + 1) for k in range(1, len(keys) + 1)]
        return {str(k): from_lua(lua, v[k], depth + 1) for k in keys}
    if tname is not None:
        return f"<{tname}>"
    return v


def open_source(args, raw_proto_text: str):
    from live import LiveSource, SnapshotSource, proto_types_of, use_raw
    if args.pid:
        if not args.exe:
            raise SystemExit("--pid 要配 --exe")
        raw = json.loads(raw_proto_text)
        return use_raw(LiveSource(args.pid, args.exe, proto_types_of(raw), args.surface), raw)
    return SnapshotSource(json.load(open(args.snapshot, encoding="utf-8")) if args.snapshot else {})


def dump(source, path: str) -> dict:
    """把内存读成一份快照 (核对时留底; 回放用)"""
    t0 = time.perf_counter()
    source.begin()
    tick = source.tick()
    if hasattr(source, "scan"):
        source.scan.eager = True  # 留底要带细节, 回放时读不了内存
    entities = source.rows_all()
    t1 = time.perf_counter()
    snap = {"tick": tick, "entities": entities, "world": source.world(), "player": source.player(), "dropped": source.dropped}
    t2 = time.perf_counter()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False)
    return {"count": len(entities), "dropped": source.dropped, "entities_ms": round((t1 - t0) * 1000), "world_ms": round((t2 - t1) * 1000)}


def main() -> int:
    # 管道里默认是系统代码页 (中文 Windows 是 GBK), 中文一出来 Node 那边就解不开 (2026-11-06 查出)
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", help="回放: 留底的快照")
    ap.add_argument("--pid", type=int, help="读活内存: 游戏进程号")
    ap.add_argument("--exe", help="读活内存: 它的 factorio.exe (布局从同目录的 pdb 现场取)")
    ap.add_argument("--surface", default="nauvis")
    ap.add_argument("--defines", required=True)
    ap.add_argument("--proto", required=True, help="data-raw-dump.json")
    ap.add_argument("--dump", help="只把内存读成快照写到这里, 不跑模组")
    ap.add_argument("--ask", action="append", default=[], help='要问的命令, 形如 inventory 或 observe:{"radius":8}')
    ap.add_argument("--serve", action="store_true", help="常驻: 标准输入一行一个请求")
    ap.add_argument("--bench-ticks", type=int, help="量后台任务: 连跑这么多 tick, 打印耗时和缺的接口")
    ap.add_argument("--tick-interval", type=float, default=1.0, help="--serve 时多久跑一批后台任务 (秒); 0 = 不跑")
    ap.add_argument("--reveal", action="store_true", help="没探过的区块也当看得见 (群的 revealUncharted); 默认关, 和真人玩家看到的一样")
    ap.add_argument("--lua", action="store_true", help="--serve 时内存读不到的 (流体、红绿线、物流网、别的玩家) 经代理问注入客户端的 Lua; 不给就和原来一样记缺")
    ap.add_argument("--read-only", action="store_true", help="只读: 世界的变化一件都不算在本地玩家头上")
    ap.add_argument("--state", help="账本文件 (模组的 storage): 启动时读, 定时写, 退出时写; 一个世界 + 一个玩家一份")
    ap.add_argument("--save-every", type=float, default=60.0, help="账本多久写一次盘 (秒)")
    ap.add_argument("--out")
    args = ap.parse_args()
    proto_text = open(args.proto, encoding="utf-8").read()
    t0 = time.perf_counter()
    source = open_source(args, proto_text)
    if args.dump:
        print(json.dumps(dump(source, args.dump), ensure_ascii=False))
        return 0
    from lupa.lua52 import LuaRuntime
    lua = LuaRuntime(unpack_returned_tuples=True, register_eval=False, attribute_filter=None)
    g = lua.globals()
    out = {"lua": lua.eval("_VERSION")}
    g["__py_json_decode"] = lambda s: to_lua(lua, json.loads(s))
    g["__py_json_encode"] = lambda t: json.dumps(from_lua(lua, t), ensure_ascii=False, separators=(",", ":"))
    g["__py_read_mod"] = lambda name: open(os.path.join(MOD, name + ".lua"), encoding="utf-8").read() if os.path.exists(os.path.join(MOD, name + ".lua")) else None
    # 游戏外自己的 Lua 库 (placeable.lua 放置检查): 和 fake_game.lua 同目录, 不在模组目录里
    g["__py_read_offgame"] = lambda name: open(os.path.join(HERE, name + ".lua"), encoding="utf-8").read()
    g["__py_log"] = lambda s: None
    g["__defines_json"] = open(args.defines, encoding="utf-8").read()
    g["__proto_json"] = proto_text
    g["__reveal"] = bool(args.reveal)
    g["__read_only"] = bool(args.read_only)

    def begin():
        source.begin()
        # paused 在世界数据里; 读活内存时这一项很便宜, 单独取
        out = {"tick": source.tick(), "paused": source.paused() if hasattr(source, "paused") else bool((source.world() or {}).get("paused"))}
        if hasattr(source, "surface_meta"):  # 回放的快照只有一个地表
            meta = source.surface_meta()
            out["surface_name"], out["surface_index"] = meta["name"], meta["index"]
        return to_lua(lua, out)

    g["__py_begin"] = begin
    g["__py_rows_all"] = lambda: to_lua(lua, source.rows_all())
    g["__py_rows_owned"] = lambda: to_lua(lua, source.rows_owned())
    g["__py_rows_natural"] = lambda: to_lua(lua, source.rows_natural())
    g["__py_row_details"] = lambda addr: to_lua(lua, source.row_details(int(addr)))
    from live import OWNERLESS_TYPES
    g["__ownerless"] = to_lua(lua, sorted(OWNERLESS_TYPES))
    g["__py_rows_chunks"] = lambda t: to_lua(lua, source.rows_chunks([[t[i][1], t[i][2]] for i in range(1, len(t) + 1)]))
    g["__py_row"] = lambda addr: to_lua(lua, source.row(int(addr)))
    g["__py_world"] = lambda: to_lua(lua, source.world())
    g["__py_player"] = lambda: to_lua(lua, source.player())
    recent_events: list = []

    def py_events():
        evs = source.events()
        for ev in evs:
            recent_events.append({k: (v if k != "row" else {"name": v["name"], "x": v["x"], "y": v["y"]}) for k, v in ev.items() if k != "at"})
        del recent_events[:-200]
        return to_lua(lua, evs)

    g["__py_events"] = py_events

    # 注入客户端的 Lua 补内存读不到的 (--lua): 假接口要的时候, 经标准输出问代理, 代理调注入客户端的只读查询 world_query (只开放被动查询) 再写回标准输入。
    # 一次约 30 毫秒, 要挡一点游戏帧, 所以: 3 秒内同样的问题不再问; 一次提问最多问 LUA_BUDGET 条; 后台任务只看缓存, 不发新查询。
    lua_state = {"budget": {}, "background": False, "seq": 0, "cache": {}, "reads": 0, "hits": 0, "over": 0, "ms": 0.0, "errors": 0, "last_error": None, "top": {}}
    q = None  # --serve 时才有 (标准输入的队列)
    deferred: list = []  # 等回复时读到的别的请求

    def py_lua(req: str, kind: str = "other"):
        if not args.lua or q is None:
            return None
        now = time.perf_counter()
        hit = lua_state["cache"].get(req)
        if hit and now - hit[0] < LUA_TTL:
            lua_state["hits"] += 1
            return to_lua(lua, hit[1])
        if lua_state["background"] or lua_state["budget"].get(kind, 0) <= 0:
            lua_state["over"] += 1
            return None
        lua_state["budget"][kind] -= 1
        lua_state["reads"] += 1
        parsed = json.loads(req)
        sel = parsed.get("selection") or {}
        step = (sel.get("path") or [{}])[-1]
        label = str(step.get("method") or step.get("property") or ",".join(parsed.get("fields") or []) or sel.get("kind"))
        lua_state["top"][label] = lua_state["top"].get(label, 0) + 1
        lua_state["seq"] += 1
        seq = lua_state["seq"]
        print(json.dumps({"lua_read": json.loads(req), "seq": seq}, ensure_ascii=False), flush=True)
        import queue as queue_mod
        deadline = now + 15.0
        reply = None
        while True:
            try:
                line = q.get(timeout=max(0.01, deadline - time.perf_counter()))
            except queue_mod.Empty:
                lua_state["errors"] += 1
                lua_state["last_error"] = "15 秒没回"
                return None
            if line is None:
                q.put(None)
                return None
            if '"lua_reply"' in line:
                got = json.loads(line)
                if got.get("lua_reply") == seq:
                    reply = got
                    break
                continue  # 早就超时不要了的回复
            deferred.append(line)
        lua_state["ms"] += (time.perf_counter() - now) * 1000
        if not reply.get("ok"):
            lua_state["errors"] += 1
            lua_state["last_error"] = str(reply.get("error"))[:300]
            return None
        if kind != "tile":  # 一个区块 1024 格, fake_game 按区块缓存了, 这里再存一份白占内存
            lua_state["cache"][req] = (now, reply.get("data"))
        if len(lua_state["cache"]) > 2000:
            lua_state["cache"].clear()
        return to_lua(lua, reply.get("data"))

    g["__py_lua"] = py_lua
    lua.execute(open(os.path.join(HERE, "fake_game.lua"), encoding="utf-8").read())
    t1 = time.perf_counter()
    state_src, saved_tick = None, None
    if args.state and os.path.exists(args.state):
        with open(args.state, encoding="utf-8") as f:
            head = f.readline()
            state_src = f.read()
        saved_tick = json.loads(head).get("tick")
    loaded = lua.eval("__load_control")(state_src, saved_tick)
    t2 = time.perf_counter()
    out["load"] = {"ok": bool(loaded[0]), "error": str(loaded[1])[:800] if loaded[1] else None, "restored": bool(loaded[2]), "setup_ms": round((t1 - t0) * 1000), "load_ms": round((t2 - t1) * 1000), "modules": lua.eval("__module_count")}

    def save_state() -> dict | None:
        """账本写盘 (先写临时文件再改名, 写一半崩了不坏旧的): 第一行是 JSON 头, 后面是 Lua 源码"""
        if not args.state:
            return None
        t = time.perf_counter()
        src, dropped = lua.eval("__save_state")()
        tmp = args.state + ".tmp"
        os.makedirs(os.path.dirname(os.path.abspath(args.state)), exist_ok=True)
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps({"tick": lua.eval("__tick_now")(), "saved_at": time.time()}) + "\n")
            f.write(src)
        os.replace(tmp, args.state)
        return {"bytes": len(src), "dropped": dropped, "ms": round((time.perf_counter() - t) * 1000)}

    ask_fn = lua.eval("__ask")
    ticks_fn = lua.eval("__run_ticks")
    fault_fn = lua.eval("__runtime_fault")

    def answer(cmd: str, raw: str) -> dict:
        t = time.perf_counter()
        res = ask_fn(cmd, raw or "{}")
        reply = json.loads(res) if isinstance(res, str) else str(res)
        row = {"ms": round((time.perf_counter() - t) * 1000), "reply": reply}
        if isinstance(reply, dict) and not reply.get("ok"):
            row["traceback"] = str(g["__last_traceback"])[:1500]
        return row

    if args.bench_ticks:
        # 量后台任务: 回放时世界不动, 只看每 tick 多久、缺什么接口、模组有没有把自己隔离
        t = time.perf_counter()
        ran = ticks_fn(args.bench_ticks)
        ms = (time.perf_counter() - t) * 1000
        report = {"ticks": ran, "ms": round(ms), "ms_per_tick": round(ms / max(1, ran), 3), "fault": fault_fn() and str(fault_fn())[:1500], "traceback": str(g["__last_traceback"])[:1500], "missing": from_lua(lua, lua.eval("__missing"))}
        if args.ask:
            report["answers"] = {a: answer(a.partition(":")[0], a.partition(":")[2]) for a in args.ask}
        print(json.dumps(report, ensure_ascii=False))
        return 0

    if args.serve:
        import queue
        import threading
        dispatch_fn = lua.eval("__dispatch")
        print(json.dumps({"ready": True, "load": out["load"]}, ensure_ascii=False), flush=True)
        # 读请求在别的线程, Lua 只在这个线程跑; 没请求时跑模组的后台任务
        q = queue.Queue()

        def read_stdin():
            for ln in sys.stdin:
                q.put(ln)
            q.put(None)

        threading.Thread(target=read_stdin, daemon=True).start()
        interval = args.tick_interval
        bg = {"batches": 0, "ticks": 0, "ms": 0.0, "max_ms": 0.0, "errors": 0, "last_error": None, "saved": None}
        next_tick = time.perf_counter() + interval
        next_save = time.perf_counter() + args.save_every
        while True:
            wait = max(0.0, next_tick - time.perf_counter()) if interval > 0 else None
            try:
                line = deferred.pop(0) if deferred else q.get(timeout=wait)
            except queue.Empty:
                t = time.perf_counter()
                try:
                    lua_state["background"] = True
                    bg["ticks"] += int(ticks_fn())
                    bg["batches"] += 1
                    if args.state and time.perf_counter() >= next_save:
                        bg["saved"] = save_state()
                        next_save = time.perf_counter() + args.save_every
                except Exception as e:  # noqa: BLE001 后台出错不能把常驻进程带倒, 记下来
                    bg["errors"] += 1
                    bg["last_error"] = str(e)[:800]
                finally:
                    lua_state["background"] = False
                ms = (time.perf_counter() - t) * 1000
                bg["ms"] += ms
                bg["max_ms"] = max(bg["max_ms"], ms)
                # 世界大了一批就慢: 至少留两倍的空给回答问题 (后台最多占一个核的三分之一; 落后太多模组只补最近 240 tick)
                next_tick = time.perf_counter() + max(interval, ms / 1000 * 2)
                continue
            if line is None:
                save_state()  # 正常退出存一次
                break
            line = line.strip()
            if not line:
                continue
            if '"lua_reply"' in line:
                continue  # 早就超时不要了的回复
            try:
                req = json.loads(line)
                t = time.perf_counter()
                lua_state["budget"] = dict(LUA_BUDGET)
                if "raw" in req:  # ./fh 经代理来的整条请求, 回复原样给回去 (src/io/mod-broker.ts)
                    res = dispatch_fn(req["raw"], bool(req.get("act")))
                    row = {"ms": round((time.perf_counter() - t) * 1000), "text": res if isinstance(res, str) else str(res), "missing": from_lua(lua, lua.eval("__missing")) if req.get("missing") else None}
                elif "eval" in req:  # 在假接口上跑一段只读 Lua, 回 JSON (开班扫描, src/play/online-scan.ts)
                    row = {"text": str(lua.eval("__eval")(req["eval"]))}
                elif req.get("where"):  # 本地玩家在哪、世界有哪些地表 (src/io/mod-broker.ts where)
                    row = source.where()
                elif req.get("tick"):
                    row = {"tick": source.tick()}
                elif req.get("stats"):  # 后台任务跑得怎么样 (核对用)
                    row = {"background": {**bg, "ms": round(bg["ms"]), "max_ms": round(bg["max_ms"])}, "fault": fault_fn() and str(fault_fn())[:1500], "missing": from_lua(lua, lua.eval("__missing")), "events": recent_events[-100:], "lua": {k: (round(v) if k == "ms" else v) for k, v in lua_state.items() if k in ("reads", "hits", "over", "ms", "errors", "last_error", "top")}}
                else:
                    row = answer(req["cmd"], json.dumps(req.get("args") or {}))
            except Exception as e:  # noqa: BLE001 一条请求出错不能把常驻进程带倒
                row = {"exception": str(e)[:1200]}
            print(json.dumps(row, ensure_ascii=False), flush=True)
        return 0

    answers = {}
    for ask in args.ask:
        cmd, _, raw = ask.partition(":")
        try:
            answers[ask] = answer(cmd, raw)
        except Exception as e:  # noqa: BLE001 这是试验: 报什么错就记什么
            answers[ask] = {"exception": str(e)[:1200]}
    out["answers"] = answers
    try:
        out["self_check"] = json.loads(lua.eval("__self_check")())
    except Exception as e:  # noqa: BLE001 自查出错就记着, 不影响上面的回答
        out["self_check_error"] = str(e)[:800]
    out["missing"] = from_lua(lua, lua.eval("__missing"))
    print(json.dumps({k: v for k, v in out.items() if k not in ("answers", "self_check")}, ensure_ascii=False))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
