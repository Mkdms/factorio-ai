#!/usr/bin/env node
// 注入客户端程序的准备: 生成 local.properties (MSVC 头文件、库、CMake / Ninja 的位置, 从本机 Visual Studio 和 Windows SDK 找), 用 Gradle 编 Windows 版,
// 把 factorio-ai-client.exe + factorio_ai_bridge.dll 拷到 data/client/。
//   npm run client:setup [-- --debug] [-- --skip-build]
// 要: JDK (Gradle wrapper 能用的版本)、Visual Studio 的 C++ 桌面开发组件和 Windows SDK (CMake、Ninja 跟着 VS 装); Kotlin/Native 和 Gradle 发行包第一次由 wrapper 下载。
// 构建说明照 game/client/development.md (上游的, 名字已换)。
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { dataRoot } from "../sandbox/paths.ts";
import { BRIDGE_DLL_NAME, CLIENT_DIR, CLIENT_EXE_NAME } from "./connect.ts";

const fwd = (p: string) => p.replace(/\\/g, "/");
const newest = (dir: string) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^\d/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) : undefined;

/** 本机的 MSVC + Windows SDK + CMake / Ninja 路径 (vswhere 找 VS; SDK 在 Windows Kits) */
export function findToolchain(): { include: string[]; lib: string[]; tools: string[]; vs: string; msvc: string; sdk: string } {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!fs.existsSync(vswhere)) throw new Error("没找到 Visual Studio (vswhere.exe)");
  const vs = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
  if (!vs) throw new Error("Visual Studio 没装 C++ 桌面开发组件");
  const msvcVer = newest(path.join(vs, "VC", "Tools", "MSVC"));
  if (!msvcVer) throw new Error("VS 里没有 MSVC 工具集");
  const msvc = path.join(vs, "VC", "Tools", "MSVC", msvcVer);
  const kits = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10");
  const sdkVer = newest(path.join(kits, "Include"));
  if (!sdkVer) throw new Error("没找到 Windows SDK (Windows Kits/10/Include)");
  const cmakeDir = path.join(vs, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin");
  const ninjaDir = path.join(vs, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "Ninja");
  for (const [f, what] of [[path.join(cmakeDir, "cmake.exe"), "CMake"], [path.join(ninjaDir, "ninja.exe"), "Ninja"]]) if (!fs.existsSync(f)) throw new Error(`VS 里没有 ${what} (${f}): 装 "适用于 Windows 的 C++ CMake 工具"`);
  const inc = path.join(kits, "Include", sdkVer), lib = path.join(kits, "Lib", sdkVer);
  return {
    vs, msvc, sdk: sdkVer,
    include: [path.join(msvc, "include"), path.join(inc, "ucrt"), path.join(inc, "um"), path.join(inc, "shared"), path.join(inc, "winrt")].map(fwd),
    lib: [path.join(msvc, "lib", "x64"), path.join(lib, "ucrt", "x64"), path.join(lib, "um", "x64")].map(fwd),
    // MSVC 的 bin (lib.exe 打静态库: CMake 找不到就 CMAKE_AR-NOTFOUND) 和 SDK 的 bin (rc.exe / mt.exe) 也要在编译子进程的 PATH 上
    tools: [cmakeDir, ninjaDir, path.join(msvc, "bin", "Hostx64", "x64"), path.join(kits, "bin", sdkVer, "x64")].map(fwd),
  };
}

/** 写 game/client/local.properties (不进仓库) */
export function writeLocalProperties(): string {
  const t = findToolchain();
  const file = path.join(CLIENT_DIR, "local.properties");
  fs.writeFileSync(file, [
    "# 由 game/client/setup.ts 生成, 本机路径, 不进仓库",
    `windows.native.includeDirectories=${t.include.join(";")}`,
    `windows.native.libraryDirectories=${t.lib.join(";")}`,
    `windows.native.toolDirectories=${t.tools.join(";")}`,
    "",
  ].join("\n"));
  return file;
}

/** Gradle 编 Windows 版 (release), 返回 exe 路径。Gradle 起 cmake 用的是它自己进程的 PATH (local.properties 的 toolDirectories 只传给编译子进程), 所以这里把 CMake / Ninja 放进 PATH */
export function build(debug = false): string {
  const kind = debug ? "Debug" : "Release";
  const t = findToolchain();
  const env = { ...process.env, PATH: [...t.tools.map((p) => p.replace(/\//g, "\\")), process.env.PATH ?? ""].join(";") };
  // CMake 把探测到的工具 (lib.exe 等) 记在缓存里, 工具路径变了也不重探 (出现过 CMAKE_AR-NOTFOUND): C++ 那部分每次重新 configure, 只多二十几秒
  fs.rmSync(path.join(CLIENT_DIR, "build", "native"), { recursive: true, force: true });
  const r = spawnSync("cmd.exe", ["/d", "/c", path.join(CLIENT_DIR, "gradlew.bat"), `link${kind}ExecutableMingwX64`, "--no-daemon"], { cwd: CLIENT_DIR, stdio: "inherit", windowsHide: true, timeout: 3600_000, env });
  if (r.status !== 0) throw new Error(`gradle 退出码 ${r.status}`);
  const exe = path.join(CLIENT_DIR, "build", "bin", "mingwX64", `${kind.toLowerCase()}Executable`, CLIENT_EXE_NAME);
  if (!fs.existsSync(exe)) throw new Error(`编完没找到 ${exe}`);
  if (!fs.existsSync(path.join(path.dirname(exe), BRIDGE_DLL_NAME))) throw new Error(`编完没找到 ${BRIDGE_DLL_NAME}`);
  return exe;
}

/** 拷到 data/client/ */
export function install(exe: string): string {
  const dst = path.join(dataRoot(), "client");
  fs.mkdirSync(dst, { recursive: true });
  for (const n of [CLIENT_EXE_NAME, BRIDGE_DLL_NAME]) fs.copyFileSync(path.join(path.dirname(exe), n), path.join(dst, n));
  return path.join(dst, CLIENT_EXE_NAME);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    console.log(`local.properties: ${writeLocalProperties()}`);
    if (!process.argv.includes("--skip-build")) {
      const exe = build(process.argv.includes("--debug"));
      console.log(`装到: ${install(exe)}`);
    }
  } catch (e) {
    console.error(`客户端程序没准备好: ${(e as Error).message}`);
    process.exit(1);
  }
}
