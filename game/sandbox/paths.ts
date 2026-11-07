// 本机游戏目录和数据目录 (沙盘服务器、观看窗口、记录都从这里找)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function findFactorioDir(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.FACTORIO_DIR,
    "C:/Program Files (x86)/Steam/steamapps/common/Factorio",
    "C:/Program Files/Factorio",
    path.join(process.env.HOME ?? "", ".steam/steam/steamapps/common/Factorio"),
  ].filter((d): d is string => !!d);
  const dir = candidates.find((d) => fs.existsSync(path.join(d, "data", "base", "info.json")));
  if (!dir) throw new Error("找不到 Factorio 安装目录: 在 .env 里设 FACTORIO_DIR");
  return dir;
}

export function factorioExe(dir: string): string {
  const win = path.join(dir, "bin", "x64", "factorio.exe");
  return fs.existsSync(win) ? win : path.join(dir, "bin", "x64", "factorio");
}

/** 仓库 .env 里的一个变量 (KEY=VALUE, 去掉两边的引号, 不解释 $; 没有或空就 undefined)。
 *  进程不一定带着 .env 的变量 (模型的命令行有时不带), 所以找数据目录时也读文件 */
export function envFileVar(key: string, file = path.join(ROOT, ".env")): string | undefined {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return undefined; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === key) return m[2].replace(/^(["'])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}

/** 本机数据目录 (不上传): 环境变量 DATA_DIR → .env 的 DATA_DIR → <仓库>/data */
export function dataRoot(): string {
  return path.resolve(process.env.DATA_DIR ?? envFileVar("DATA_DIR") ?? path.join(ROOT, "data"));
}

/** 记录里写的相对路径 → 真路径: "data/..." 开头的落在数据目录下, 其他的相对仓库 */
export function dataPath(rel: string): string {
  const r = rel.replace(/\\/g, "/");
  return r.startsWith("data/") ? path.join(dataRoot(), r.slice("data/".length)) : path.join(ROOT, r);
}

/** 真路径 → 记录里写的相对路径 (dataPath 的反过来); 换机器、搬数据目录都还能用 */
export function dataRel(abs: string): string {
  const r = path.relative(dataRoot(), abs);
  if (r && !r.startsWith("..") && !path.isAbsolute(r)) return `data/${r.replace(/\\/g, "/")}`;
  return path.relative(ROOT, abs).replace(/\\/g, "/");
}

/** 本机游戏自带的模组 (base、space-age...), 来自 data/<名字>/info.json */
export function builtinMods(dir: string): { name: string; version: string }[] {
  return fs
    .readdirSync(path.join(dir, "data"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "core" && fs.existsSync(path.join(dir, "data", d.name, "info.json")))
    .map((d) => {
      const info = JSON.parse(fs.readFileSync(path.join(dir, "data", d.name, "info.json"), "utf8"));
      return { name: info.name as string, version: info.version as string };
    });
}

/** 我们自己的模组所在目录 (仓库 game/mod/<名字>) */
export const MOD_ROOT = path.join(ROOT, "game", "mod");
/** 沙盘用的模组名 */
export const SANDBOX_MOD = "factorio-ai";

/**
 * 在 dir 里写一套单独的游戏配置 (config.ini + mods/mod-list.json + 我们的模组)。
 * 沙盘服务器和观看窗口都用它, 所以两边模组完全一致; 用户自己的配置和存档不碰。
 * mods: 要装的我们的模组 (默认只装沙盘模组); noMod: 一个都不装 (连别人的服务器时客户端要干净)
 */
export function writeGameDir(dir: string, factorioDir: string, opts: { dlc: boolean; locale: string; extra?: string[]; mods?: string[]; noMod?: boolean }) {
  for (const d of ["", "mods", "saves", "script-output"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.ini"),
    [
      "; factorio-ai 的单独配置, 不是用户自己的设置",
      "[path]",
      "read-data=__PATH__executable__/../../data",
      `write-data=${dir.replaceAll("\\", "/")}`,
      "[general]",
      `locale=${opts.locale}`,
      "[other]",
      "check-updates=false",
      ...(opts.extra ?? []),
      "",
    ].join("\n"),
  );
  const ours = opts.noMod ? [] : [...new Set([SANDBOX_MOD, ...(opts.mods ?? [])])];
  const mods = [
    ...builtinMods(factorioDir).map((m) => ({ name: m.name, enabled: m.name === "base" || opts.dlc })),
    ...ours.map((name) => ({ name, enabled: true })),
  ];
  // 我们的模组里没选中的也写进列表并关掉, 目录清掉: 不在列表里的模组游戏默认启用
  const all = fs.existsSync(MOD_ROOT) ? fs.readdirSync(MOD_ROOT).filter((n) => fs.existsSync(path.join(MOD_ROOT, n, "info.json"))) : [];
  for (const name of all) if (!mods.some((m) => m.name === name)) mods.push({ name, enabled: false });
  fs.writeFileSync(path.join(dir, "mods", "mod-list.json"), JSON.stringify({ mods }, null, 2));
  for (const name of all) fs.rmSync(path.join(dir, "mods", name), { recursive: true, force: true });
  for (const name of ours) {
    if (!fs.existsSync(path.join(MOD_ROOT, name, "info.json"))) throw new Error(`没有模组 ${name} (${MOD_ROOT})`);
    fs.cpSync(path.join(MOD_ROOT, name), path.join(dir, "mods", name), { recursive: true });
  }
}
