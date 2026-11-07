// 本机 Steam 的成就缓存 (只读, 库): 这个账号在游戏上拿到了哪些成就。用来选还没拿过的目标, 和验证跑完多了哪个。
// 文件是 Valve 的二进制 KeyValues: 1 字节类型 + 以 0 结尾的键名 + 值, 8 结束一层。appcache/stats/UserGameStatsSchema_<游戏>.bin 是定义, UserGameStats_<账号>_<游戏>.bin 是这个账号的数据。
// 段的 data 是位图; schema 里带 bits 的段才是成就, 别的段是累计数字 (把数字当位图读会多出一堆假成就, 2026-11-07 第一版解析就这么错过)。
// 不打印账号 ID。Steam 通常在游戏退出时才写这个文件, 所以"多了哪个"要等客户端关了再比。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const FACTORIO_APP = 427520;

export type Vdf = { [k: string]: Vdf | string | number | bigint };

export function parseVdf(buf: Buffer, start = 0): { value: Vdf; next: number } {
  const out: Vdf = {};
  let i = start;
  while (i < buf.length) {
    const t = buf[i++];
    if (t === 8) return { value: out, next: i };
    const end = buf.indexOf(0, i);
    if (end < 0) throw new Error("键名没有结尾");
    const k = buf.toString("utf8", i, end);
    i = end + 1;
    if (t === 0) { const r = parseVdf(buf, i); out[k] = r.value; i = r.next; }
    else if (t === 1) { const e = buf.indexOf(0, i); out[k] = buf.toString("utf8", i, e); i = e + 1; }
    else if (t === 2 || t === 3 || t === 4 || t === 6) { out[k] = buf.readInt32LE(i); i += 4; }
    else if (t === 7) { out[k] = buf.readBigUInt64LE(i); i += 8; }
    else throw new Error(`不认识的类型 ${t}`);
  }
  return { value: out, next: i };
}

export type Achievements = { total: number; have: string[]; names: Record<string, string>; stats: Record<string, number> };

/** 定义 + 账号数据 → 已拿到的成就 id、中文名、累计数字 */
export function readAchievements(schemaBuf: Buffer, statsBuf: Buffer): Achievements {
  const schema = parseVdf(schemaBuf).value;
  const root = Object.values(schema)[0] as Vdf;
  const game = root.stats as Vdf;
  const stats = parseVdf(statsBuf).value;
  const only = Object.values(stats);
  const cache = (only.length === 1 && typeof only[0] === "object" ? only[0] : stats) as Vdf;
  const names: Record<string, string> = {};
  const have: string[] = [];
  const nums: Record<string, number> = {};
  let total = 0;
  for (const [sid, s] of Object.entries(game)) {
    if (typeof s !== "object" || s === null) continue;
    const seg = s as Vdf;
    const row = cache[sid] as Vdf | undefined;
    const bits = seg.bits as Vdf | undefined;
    if (!bits) {
      if (row && typeof row.data === "number") nums[String(seg.name ?? sid)] = row.data;
      continue;
    }
    const data = row && typeof row.data === "number" ? row.data >>> 0 : 0;
    for (const [bit, b] of Object.entries(bits)) {
      const a = b as Vdf;
      const id = String(a.name ?? "");
      const display = (a.display as Vdf | undefined)?.name;
      names[id] = typeof display === "object" && display ? String((display as Vdf).schinese ?? (display as Vdf).english ?? id) : String(display ?? id);
      total++;
      if (data & (1 << Number(bit))) have.push(id);
    }
  }
  return { total, have, names, stats: nums };
}

/** 跑之前和跑之后比: 多了哪些 */
export const newlyUnlocked = (before: string[], after: string[]) => after.filter((a) => !before.includes(a));

function steamDir(): string | null {
  if (process.env.STEAM_DIR) return process.env.STEAM_DIR;
  if (process.platform !== "win32") return null;
  try { return /SteamPath\s+REG_SZ\s+(.+)/.exec(execFileSync("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], { encoding: "utf8", windowsHide: true }))?.[1]?.trim() ?? null; } catch { return null; }
}

/** 读本机这个账号的成就; 文件不在 (没登录过、别的系统) 回 null */
export function localAchievements(app = FACTORIO_APP): Achievements | null {
  const steam = steamDir();
  if (!steam) return null;
  const dir = path.join(steam, "appcache", "stats");
  try {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("UserGameStats_") && f.endsWith(`_${app}.bin`)).map((f) => path.join(dir, f));
    if (!files.length) return null;
    const newest = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    return readAchievements(fs.readFileSync(path.join(dir, `UserGameStatsSchema_${app}.bin`)), fs.readFileSync(newest));
  } catch { return null; }
}
