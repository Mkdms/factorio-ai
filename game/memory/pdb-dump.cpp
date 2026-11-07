// pdb-dump: 查看游戏自带调试符号 (factorio.pdb) 里的枚举、结构成员偏移和函数符号 (只读)。读内存的 Python (reader.py) 用它现场取布局, 不存偏移表。
// 用 Windows 自带的 DbgHelp; 独立的命令行工具, 也用来在写代码前核布局、列枚举。
// 编译: npm run memory:setup (game/memory/setup.ts 找本机的 Visual Studio); 手动: vcvars64.bat 之后  cl /nologo /EHsc /O1 /std:c++17 /utf-8 pdb-dump.cpp /link dbghelp.lib
// 用法:
//   pdb-dump <factorio.exe> enum   <枚举名>              列出枚举的名字和数值 (例 InputActionType、InputActionType 的数据类型)
//   pdb-dump <factorio.exe> struct <类型名> [深度]       列出结构 / 类的成员: 偏移、大小、类型 (深度 >0 时把成员里的结构也展开)
//   pdb-dump <factorio.exe> sym    <通配符>              列出匹配的符号 (修饰名 + 还原名 + 相对地址), 例 "?sendToListeners@Player@@*"
//   pdb-dump <factorio.exe> size   <类型名>              只打印类型大小
// 符号文件要和 exe 同目录 (游戏 Steam 版自带 factorio.pdb)。输出是文本, 每行一条; 找不到就报错退出 2。
#include <windows.h>
#include <dbghelp.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#pragma comment(lib, "dbghelp.lib")
#pragma comment(lib, "oleaut32.lib")

static HANDLE process = GetCurrentProcess();
static DWORD64 base = 0;

static std::string narrow(const wchar_t *w) {
    if (!w) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    std::string s(n > 0 ? n - 1 : 0, '\0');
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
    return s;
}

static DWORD u32(ULONG type, IMAGEHLP_SYMBOL_TYPE_INFO what) {
    DWORD v = 0;
    SymGetTypeInfo(process, base, type, what, &v);
    return v;
}
static ULONG64 u64(ULONG type, IMAGEHLP_SYMBOL_TYPE_INFO what) {
    ULONG64 v = 0;
    SymGetTypeInfo(process, base, type, what, &v);
    return v;
}
static std::string symName(ULONG type) {
    WCHAR *name = nullptr;
    if (!SymGetTypeInfo(process, base, type, TI_GET_SYMNAME, &name) || !name) return "";
    std::string s = narrow(name);
    LocalFree(name);
    return s;
}
static std::vector<ULONG> children(ULONG type) {
    DWORD count = u32(type, TI_GET_CHILDRENCOUNT);
    std::vector<ULONG> out;
    if (!count) return out;
    std::vector<char> buf(sizeof(TI_FINDCHILDREN_PARAMS) + count * sizeof(ULONG));
    auto *p = reinterpret_cast<TI_FINDCHILDREN_PARAMS *>(buf.data());
    p->Count = count;
    p->Start = 0;
    if (!SymGetTypeInfo(process, base, type, TI_FINDCHILDREN, p)) return out;
    for (DWORD i = 0; i < count; ++i) out.push_back(p->ChildId[i]);
    return out;
}

// SymTag 值 (cvconst.h): 7 Data, 11 UDT, 12 Enum, 13 FunctionType, 14 PointerType, 15 ArrayType, 16 BaseType, 17 Typedef, 18 BaseClass
static std::string typeName(ULONG type, int depth = 0) {
    if (depth > 6) return "…";
    switch (u32(type, TI_GET_SYMTAG)) {
    case 14: return typeName(u32(type, TI_GET_TYPEID), depth + 1) + "*";
    case 15: return typeName(u32(type, TI_GET_TYPEID), depth + 1) + "[" + std::to_string(u32(type, TI_GET_COUNT)) + "]";
    case 13: return "function";
    case 16: {
        ULONG64 len = u64(type, TI_GET_LENGTH);
        switch (u32(type, TI_GET_BASETYPE)) {
        case 1: return "void";
        case 2: return "char";
        case 3: return "wchar_t";
        case 6: return "int" + std::to_string(len * 8);
        case 7: return "uint" + std::to_string(len * 8);
        case 8: return len == 4 ? "float" : "double";
        case 10: return "bool";
        case 13: return "long";
        case 14: return "unsigned long";
        default: return "base" + std::to_string(u32(type, TI_GET_BASETYPE)) + "/" + std::to_string(len);
        }
    }
    default: {
        std::string n = symName(type);
        return n.empty() ? "type#" + std::to_string(type) : n;
    }
    }
}

static ULONG findType(const char *name) {
    std::vector<char> buf(sizeof(SYMBOL_INFO) + MAX_SYM_NAME);
    auto *si = reinterpret_cast<SYMBOL_INFO *>(buf.data());
    si->SizeOfStruct = sizeof(SYMBOL_INFO);
    si->MaxNameLen = MAX_SYM_NAME;
    if (!SymGetTypeFromName(process, base, name, si)) {
        fprintf(stderr, "找不到类型: %s (错误 %lu)\n", name, GetLastError());
        exit(2);
    }
    return si->TypeIndex;
}

static void dumpEnum(const char *name) {
    ULONG t = findType(name);
    if (u32(t, TI_GET_SYMTAG) != 12) { fprintf(stderr, "%s 不是枚举\n", name); exit(2); }
    printf("enum %s : %s (%llu 字节)\n", name, typeName(u32(t, TI_GET_TYPEID)).c_str(), u64(t, TI_GET_LENGTH));
    for (ULONG c : children(t)) {
        VARIANT v;
        VariantInit(&v);
        long long value = 0;
        if (SymGetTypeInfo(process, base, c, TI_GET_VALUE, &v)) {
            switch (v.vt) {
            case VT_I1: value = v.cVal; break;
            case VT_UI1: value = v.bVal; break;
            case VT_I2: value = v.iVal; break;
            case VT_UI2: value = v.uiVal; break;
            case VT_I4: value = v.lVal; break;
            case VT_UI4: value = v.ulVal; break;
            case VT_I8: value = v.llVal; break;
            case VT_UI8: value = (long long)v.ullVal; break;
            default: value = -1;
            }
        }
        printf("%lld\t%s\n", value, symName(c).c_str());
    }
}

static void dumpStruct(const char *name, int depth, int indent = 0, ULONG known = 0) {
    ULONG t = known ? known : findType(name);
    // typedef → 实际类型
    while (u32(t, TI_GET_SYMTAG) == 17) t = u32(t, TI_GET_TYPEID);
    if (indent == 0) printf("struct %s (%llu 字节)\n", symName(t).c_str(), u64(t, TI_GET_LENGTH));
    for (ULONG c : children(t)) {
        DWORD tag = u32(c, TI_GET_SYMTAG);
        if (tag == 18) { // 基类
            printf("%*s+%lu\tbase\t%s (%llu 字节)\n", indent, "", u32(c, TI_GET_OFFSET), symName(c).c_str(), u64(c, TI_GET_LENGTH));
            if (depth > 0) dumpStruct(nullptr, depth - 1, indent + 2, u32(c, TI_GET_TYPEID));
            continue;
        }
        if (tag != 7) continue; // 只要数据成员 (函数、嵌套类型跳过)
        DWORD kind = u32(c, TI_GET_DATAKIND); // 7 = DataIsMember, 8 = DataIsStaticMember
        ULONG mt = u32(c, TI_GET_TYPEID);
        if (kind == 8) { printf("%*sstatic\t%s\t%s\n", indent, "", typeName(mt).c_str(), symName(c).c_str()); continue; }
        printf("%*s+%lu\t%llu\t%s\t%s\n", indent, "", u32(c, TI_GET_OFFSET), u64(mt, TI_GET_LENGTH), typeName(mt).c_str(), symName(c).c_str());
        ULONG inner = mt;
        while (u32(inner, TI_GET_SYMTAG) == 17) inner = u32(inner, TI_GET_TYPEID);
        if (depth > 0 && u32(inner, TI_GET_SYMTAG) == 11) dumpStruct(nullptr, depth - 1, indent + 2, inner);
    }
}

static BOOL CALLBACK onSymbol(PSYMBOL_INFO si, ULONG, PVOID) {
    char plain[2048] = {};
    UnDecorateSymbolName(si->Name, plain, sizeof plain, UNDNAME_COMPLETE);
    printf("+0x%llx\t%s\t%s\n", (unsigned long long)(si->Address - base), si->Name, plain);
    return TRUE;
}

int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "用法: pdb-dump <factorio.exe> enum|struct|sym|size <名字> [深度]\n"); return 1; }
    SymSetOptions(SYMOPT_LOAD_LINES * 0 | SYMOPT_CASE_INSENSITIVE * 0 | SYMOPT_EXACT_SYMBOLS);
    std::string exe = argv[1];
    std::string dir = exe.substr(0, exe.find_last_of("\\/"));
    if (!SymInitialize(process, dir.c_str(), FALSE)) { fprintf(stderr, "SymInitialize 失败 %lu\n", GetLastError()); return 2; }
    base = SymLoadModuleEx(process, nullptr, exe.c_str(), nullptr, 0, 0, nullptr, 0);
    if (!base) { fprintf(stderr, "读不到符号 (pdb 要和 exe 同目录) %lu\n", GetLastError()); return 2; }
    IMAGEHLP_MODULE64 mi = {};
    mi.SizeOfStruct = sizeof mi;
    if (SymGetModuleInfo64(process, base, &mi) && mi.SymType != SymPdb) { fprintf(stderr, "没有加载 pdb (SymType=%d)\n", (int)mi.SymType); return 2; }
    std::string cmd = argv[2];
    if (cmd == "enum") dumpEnum(argv[3]);
    else if (cmd == "struct") dumpStruct(argv[3], argc > 4 ? atoi(argv[4]) : 0);
    else if (cmd == "size") printf("%llu\n", u64(findType(argv[3]), TI_GET_LENGTH));
    else if (cmd == "sym") { if (!SymEnumSymbols(process, base, argv[3], onSymbol, nullptr)) { fprintf(stderr, "枚举符号失败 %lu\n", GetLastError()); return 2; } }
    else { fprintf(stderr, "不认识的命令 %s\n", cmd.c_str()); return 1; }
    SymCleanup(process);
    return 0;
}
