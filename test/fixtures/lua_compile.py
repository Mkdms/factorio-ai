"""标准输入给一个 JSON 字符串数组 (每个是一段 Lua 函数体), 在 lupa (Lua 5.2, 和游戏同版本) 里逐段编译 (不运行), 打印 JSON: 每段 null (编译过) 或错误原文。
test/orders.test.ts 用来核生成的条件 Lua 没有语法错。用法: python -I lua_compile.py < snippets.json"""
import json
import sys

from lupa.lua52 import LuaRuntime  # type: ignore

lua = LuaRuntime(unpack_returned_tuples=True, register_eval=False)
compile_one = lua.eval("function(src) local f, err = load('local function main() ' .. src .. ' end', 'cond', 't') return err end")
out = [compile_one(src) for src in json.loads(sys.stdin.buffer.read().decode("utf-8"))]  # 按 UTF-8 读: Windows 下标准输入默认 GBK, 中文会解坏
print(json.dumps(out, ensure_ascii=True))
