// 世界 (库, 不直接运行; run.ts 开班时写, 控制接口读):
// → 选了"按世界分": 同一张图连续跑的几班算一个世界, 每个联机服务器各算一个。开班时写 <班次目录>/world.json;
// 接着上一班的存档跑 (--save <上一班>/end.zip) 就继承上一班的世界。11-03 以前的班次没记, 归"旧记录"。
// "收起": 班次目录里放一个 hidden 标记, 不删任何记录 (复盘、下一班的"先修这几条"、接着跑都要用)。
import fs from "node:fs";
import path from "node:path";

export type World = { id: string; name: string; kind: "sandbox" | "server"; createdAt: string; firstRun: string };
export const LEGACY: World = { id: "legacy", name: "旧记录 (11-03 以前没记属于哪个世界)", kind: "sandbox", createdAt: "", firstRun: "" };

/** 班次目录名 (开班的 UTC 时间, 2026-11-03T11-17-28) → 本机时间 "11月3日 19:17" */
export function runLabelZh(runId: string, tzOffsetMin = -new Date().getTimezoneOffset()): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(runId);
  if (!m) return runId;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + tzOffsetMin * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function readWorld(runDir: string): World | null {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(runDir, "world.json"), "utf8"));
    return w && typeof w.id === "string" && typeof w.name === "string" ? w as World : null;
  } catch { return null; }
}
export const writeWorld = (runDir: string, w: World) => fs.writeFileSync(path.join(runDir, "world.json"), JSON.stringify(w, null, 1));

/**
 * 新开的一班属于哪个世界: 新地图 = 新世界; 接着某一班的存档 = 那一班的世界。
 * 接着的那一班是旧记录 (没有 world.json) 时: 以它为起点新建一个世界, 并把 world.json 补写给它 (更早的几班仍算旧记录)。
 */
export function worldForNewRun(runId: string, saveFile: string | undefined, now = new Date()): { world: World; backfill: string | null } {
  if (saveFile) {
    const prevDir = path.dirname(saveFile), prevId = path.basename(prevDir);
    const prev = /^\d{4}-\d\d-\d\dT/.test(prevId) ? readWorld(prevDir) : null;
    if (prev) return { world: prev, backfill: null };
    const w: World = { id: `sandbox-${prevId}`, name: `沙盘 · 从 ${runLabelZh(prevId)} 那班的存档接着跑`, kind: "sandbox", createdAt: now.toISOString(), firstRun: prevId };
    return { world: w, backfill: /^\d{4}-\d\d-\d\dT/.test(prevId) && fs.existsSync(prevDir) ? prevDir : null };
  }
  return { world: { id: `sandbox-${runId}`, name: `沙盘 · ${runLabelZh(runId)} 开的新图`, kind: "sandbox", createdAt: now.toISOString(), firstRun: runId }, backfill: null };
}

const HIDDEN = "hidden";
export const isHidden = (runDir: string) => fs.existsSync(path.join(runDir, HIDDEN));
/** 收起 / 放出来 (只是一个标记文件) */
export function setHidden(runDir: string, hidden: boolean) {
  const f = path.join(runDir, HIDDEN);
  if (hidden) fs.writeFileSync(f, `界面里收起 ${new Date().toISOString()}\n`);
  else fs.rmSync(f, { force: true });
}

// 世界标题自己改: 改的名字存在 <play>/world-names.json {世界 id: 名字},
// 不动任何一班的 world.json (旧记录 id = legacy 也能改); 读世界时套上去。名字 1~40 个字, 不含换行。
const NAMES = "world-names.json";
export const WORLD_NAME_MAX = 40;
export function worldNames(playDir: string): Record<string, string> {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(playDir, NAMES), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "string")) as Record<string, string> : {};
  } catch { return {}; }
}
/** 改名 (空名 = 恢复原名); 返回现在显示的名字 */
export function setWorldName(playDir: string, id: string, name: string, fallback: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length > WORLD_NAME_MAX) throw new Error(`名字最多 ${WORLD_NAME_MAX} 个字`);
  const all = worldNames(playDir);
  if (clean) all[id] = clean; else delete all[id];
  fs.mkdirSync(playDir, { recursive: true });
  fs.writeFileSync(path.join(playDir, NAMES), JSON.stringify(all, null, 1));
  return clean || fallback;
}
/** 套上改过的名字 */
export function applyWorldName<T extends { id: string; name: string }>(playDir: string, w: T): T & { renamed: boolean } {
  const n = worldNames(playDir)[w.id];
  return n ? { ...w, name: n, renamed: true } : { ...w, renamed: false };
}

/**
 * 这个世界之前各班一共跑了多久 (毫秒; 各班 summary.json 的 realMinutes 相加, 不算 exceptRunId, 没收工的班不算)。
 * 群开的连续班一班只有 10 分钟 (2026-11-08), 监工里"开班 15 / 20 / 35 分钟"这类门槛按本班算一次都到不了: 按世界累计算。
 */
export function worldPlayedMs(playDir: string, worldId: string, exceptRunId?: string): number {
  const root = path.join(playDir, "runs");
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return 0; }
  let ms = 0;
  for (const d of dirs) {
    if (d === exceptRunId || readWorld(path.join(root, d))?.id !== worldId) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(root, d, "summary.json"), "utf8")) as { realMinutes?: unknown };
      if (typeof s.realMinutes === "number" && s.realMinutes > 0) ms += s.realMinutes * 60_000;
    } catch { /* 没收工的班不算 */ }
  }
  return ms;
}
