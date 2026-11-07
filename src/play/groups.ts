// 群 = 一个对话 = 一个世界 (库, 不直接运行):
// 界面里"新建对话"建一个群 (名字、类型: 新地图 / 接着某个存档 / 联机服务器、时长、成员名单), 存 <lab-data>/play/groups/<id>.json;
// 群里点"开班"= 控制接口起一班 run.ts (--group <id>: 世界就是这个群, 名单就是群成员, 接着这个群最近一班的 end.zip); 以后每班都归在这个群下面。
// 命令行开的班 (没给 --group) 还按原来的规则归世界 (src/play/worlds.ts)。联机服务器的群现在能只读连接 (src/play/online.ts --group), 真模型的班还开不了。
import fs from "node:fs";
import path from "node:path";
import { cleanSeat, rosterToBrains, type RosterSeat } from "./roster.ts";
import { readWorld, type World } from "./worlds.ts";
import { cleanBackendPref, type BackendPref } from "../io/backend.ts";

/** mine = 用户的账号玩本机自己的图 (mk-world.ts): 全程玩家操作, 能拿成就; 只有一席, 第 1 席选模型 */
export type GroupKind = "new" | "save" | "server" | "mine";
export type Group = {
  id: string; name: string; createdAt: string; kind: GroupKind;
  /** kind = save: 接着哪个存档开第一班 (.zip 路径; 之后的班接这个群自己最近一班的 end.zip) */
  save?: string;
  /** kind = server: 走哪条路 (没写 = 自动, src/io/backend.ts)。服务器地址和密码不在这里: 群文件进备份, 它们只在 keys.json (accounts.ts saveGroupServer) */
  backend?: BackendPref;
  /** kind = server: 走内存外挂时, 没探过的区块也当看得见 (内存里本来就有整张图, 虫巢和矿都读得到)。默认关, 要有选项; 关着 = 和真人看到的一样 */
  revealUncharted?: boolean;
  /** kind = mine: 这一局要模型做什么 (没写就让它自己玩) */
  goal?: string;
  /** 群成员 = 阵容: 第 1 个是管理员 (操控用户的账号) */
  seats: RosterSeat[];
  /** 一班多少分钟 */
  minutes: number;
  /** false = 这个世界关和平模式, 虫子真的会来打 (联机服务器前要在沙盘里核防御); 没写 = 开着和平 */
  peaceful?: boolean;
  /** peaceful: false 时开班先留多少分钟和平, 到点自动关 (src/play/peace.ts); 用完 run.ts 清掉, 没用完记剩下的 */
  peacefulMinutes?: number;
};
export const GROUP_NAME_MAX = 40;
export const GROUP_GOAL_MAX = 2000;
export const groupsDir = (playDir: string) => path.join(playDir, "groups");
const file = (playDir: string, id: string) => path.join(groupsDir(playDir), `${id}.json`);
const isGroupId = (id: string) => /^g-[a-z0-9]{4,20}$/.test(id);

function cleanGroup(raw: unknown): Group | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !isGroupId(r.id) || typeof r.name !== "string" || !r.name.trim()) return null;
  const kind: GroupKind = r.kind === "save" || r.kind === "server" || r.kind === "mine" ? r.kind : "new";
  const seats = (Array.isArray(r.seats) ? r.seats : []).map(cleanSeat).filter((s): s is RosterSeat => !!s);
  // 默认每班 180 分钟; 开班 = 连跑到停班, 换班不关游戏 (control.ts 起 shifts.ts --shifts 0 --live)
  const minutes = typeof r.minutes === "number" && Number.isFinite(r.minutes) ? Math.min(600, Math.max(5, Math.round(r.minutes))) : 180;
  return { id: r.id, name: r.name.trim().slice(0, GROUP_NAME_MAX), createdAt: typeof r.createdAt === "string" ? r.createdAt : "", kind,
    ...(kind === "save" && typeof r.save === "string" ? { save: r.save } : {}),
    ...(kind === "server" && cleanBackendPref(r.backend) !== "auto" ? { backend: cleanBackendPref(r.backend) } : {}),
    ...(kind === "server" && r.revealUncharted === true ? { revealUncharted: true } : {}),
    ...(kind === "mine" && typeof r.goal === "string" && r.goal.trim() ? { goal: r.goal.trim().slice(0, GROUP_GOAL_MAX) } : {}),
    seats: seats.length ? (kind === "mine" ? seats.slice(0, 1) : seats) : [{ brain: "claude", model: "opus" }], minutes, ...(r.peaceful === false ? { peaceful: false } : {}),
    ...(r.peaceful === false && typeof r.peacefulMinutes === "number" && r.peacefulMinutes > 0 ? { peacefulMinutes: Math.min(120, Math.ceil(r.peacefulMinutes)) } : {}) };
}

/** 全部群, 新建的在前 */
export function readGroups(playDir: string): Group[] {
  let names: string[] = [];
  try { names = fs.readdirSync(groupsDir(playDir)).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out: Group[] = [];
  for (const f of names) { try { const g = cleanGroup(JSON.parse(fs.readFileSync(path.join(groupsDir(playDir), f), "utf8"))); if (g) out.push(g); } catch { /* 坏文件跳过 */ } }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export const readGroup = (playDir: string, id: string): Group | null => (isGroupId(id) ? readGroups(playDir).find((g) => g.id === id) ?? null : null);

function writeGroup(playDir: string, g: Group): Group {
  fs.mkdirSync(groupsDir(playDir), { recursive: true });
  fs.writeFileSync(file(playDir, g.id), JSON.stringify(g, null, 1));
  return g;
}

/** 新建一个群 (界面 "新建对话"): 名字 1~40 字; 接存档要给存在的 .zip; 联机要有地址 (本次填的, 或本机已存的 savedServer), 但地址不写进群文件, 由调用方存 keys.json; 成员默认管理员 Claude Opus */
export function createGroup(playDir: string, input: { name: string; kind: GroupKind; save?: string; server?: { address?: string }; savedServer?: boolean; seats?: unknown[]; minutes?: number; revealUncharted?: boolean; backend?: unknown; goal?: unknown }, now = new Date()): Group {
  const name = (input.name ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > GROUP_NAME_MAX) throw new Error(`群的名字要 1~${GROUP_NAME_MAX} 个字`);
  if (!["new", "save", "server", "mine"].includes(input.kind)) throw new Error("类型要是 new (新地图) / save (接着存档) / server (联机服务器) / mine (我的账号)");
  if (input.kind === "save") {
    const s = (input.save ?? "").trim();
    if (!s || !/\.zip$/i.test(s) || !fs.existsSync(s)) throw new Error("接着存档: 要给一个存在的 .zip 存档路径 (例: 某一班目录里的 end.zip)");
  }
  if (input.kind === "server" && !(input.server?.address ?? "").trim() && !input.savedServer) throw new Error("联机服务器: 要给地址 (主机:端口)");
  const seats = (input.seats ?? []).map(cleanSeat);
  if (seats.some((s) => !s)) throw new Error("成员里有不认识的家或模型名");
  const id = `g-${now.getTime().toString(36)}${Math.floor(Math.random() * 36).toString(36)}`;
  const g: Group = { id, name, createdAt: now.toISOString(), kind: input.kind, seats: seats.length ? (input.kind === "mine" ? (seats as RosterSeat[]).slice(0, 1) : (seats as RosterSeat[])) : [{ brain: "claude", model: "opus" }],
    minutes: typeof input.minutes === "number" && Number.isFinite(input.minutes) ? Math.min(600, Math.max(5, Math.round(input.minutes))) : 180,
    ...(input.kind === "save" ? { save: path.resolve(input.save!.trim()) } : {}), ...(input.kind === "server" ? { ...(cleanBackendPref(input.backend) !== "auto" ? { backend: cleanBackendPref(input.backend) } : {}), ...(input.revealUncharted === true ? { revealUncharted: true } : {}) } : {}),
    ...(input.kind === "mine" && typeof input.goal === "string" && input.goal.trim() ? { goal: input.goal.trim().slice(0, GROUP_GOAL_MAX) } : {}) };
  return writeGroup(playDir, g);
}

/** 改"我的账号"这一局要做什么 (下一次开局生效) */
export function setGroupGoal(playDir: string, id: string, goal: unknown): Group {
  const g = readGroup(playDir, id);
  if (!g) throw new Error(`没有这个群: ${id}`);
  if (g.kind !== "mine") throw new Error("只有\"我的账号\"的群有目标");
  const { goal: _old, ...rest } = g; void _old;
  const v = typeof goal === "string" ? goal.trim().slice(0, GROUP_GOAL_MAX) : "";
  return writeGroup(playDir, v ? { ...rest, goal: v } : rest);
}

/** 改联机服务器走哪条路 (自动 / 内存外挂 / RCON); 别的类型的群没这个选项 */
export function setBackend(playDir: string, id: string, backend: unknown): Group {
  const g = readGroup(playDir, id);
  if (!g) throw new Error(`没有这个群: ${id}`);
  if (g.kind !== "server") throw new Error("这个选项只给联机服务器的群 (本地的班走 RCON + 模组)");
  const { backend: _old, ...rest } = g; void _old;
  const v = cleanBackendPref(backend);
  return writeGroup(playDir, v === "auto" ? rest : { ...rest, backend: v });
}

/** 只读连一次联机服务器的 play:online 参数 (界面"只读连接"; 不叫模型) */
export function connectArgs(g: Group): string[] {
  if (g.kind !== "server") throw new Error("只有联机服务器的群能只读连接");
  return ["--group", g.id, "--read-only", "--minutes", "5"];
}

/** 改联机服务器的"读没探过的区块" (默认关); 别的类型的群没这个选项 */
export function setRevealUncharted(playDir: string, id: string, on: boolean): Group {
  const g = readGroup(playDir, id);
  if (!g) throw new Error(`没有这个群: ${id}`);
  if (g.kind !== "server") throw new Error("这个选项只给联机服务器的群 (本地的班走 RCON + 模组)");
  const { revealUncharted: _old, ...rest } = g; void _old;
  return writeGroup(playDir, on ? { ...rest, revealUncharted: true } : rest);
}

/** 改群的成员 (群里拉人 / 移出 / 换管理员的模型) */
export function saveGroupSeats(playDir: string, id: string, seats: unknown): Group {
  const g = readGroup(playDir, id);
  if (!g) throw new Error(`没有这个群: ${id}`);
  if (!Array.isArray(seats) || !seats.length) throw new Error("群里至少留一个角色");
  if (seats.length > 26) throw new Error("最多 26 个角色");
  const out = seats.map(cleanSeat);
  if (out.some((s) => !s)) throw new Error("成员里有不认识的家或模型名");
  // 我的账号只有一个身体: 只留第 1 席 (online.ts 一次只跑一个模型)
  return writeGroup(playDir, { ...g, seats: g.kind === "mine" ? (out as RosterSeat[]).slice(0, 1) : (out as RosterSeat[]) });
}

/** 开班和平还剩多少分钟: 0 = 用完了, 这个群以后开班直接有虫子 */
export function setPeacefulMinutes(playDir: string, id: string, minutes: number): Group | null {
  const g = readGroup(playDir, id);
  if (!g) return null;
  const { peacefulMinutes: _old, ...rest } = g; void _old;
  return writeGroup(playDir, minutes > 0 ? { ...rest, peacefulMinutes: Math.ceil(minutes) } : rest);
}

/** 群就是世界: run.ts --group 时写进 world.json 的 */
export const groupWorld = (g: Group): World => ({ id: g.id, name: g.name, kind: g.kind === "server" ? "server" : "sandbox", createdAt: g.createdAt, firstRun: "" });

/** 这个群最近一班的结束存档 (接着跑用) 和那一班的大脑目录 (笔记交接用); 没有 → null */
export function latestRunOfGroup(playDir: string, id: string): { runId: string; endZip: string; brainDir: string | null } | null {
  let ids: string[] = [];
  try { ids = fs.readdirSync(path.join(playDir, "runs")).filter((d) => /^\d{4}-\d\d-\d\dT/.test(d)).sort(); } catch { return null; }
  for (const runId of ids.reverse()) {
    const dir = path.join(playDir, "runs", runId);
    if (readWorld(dir)?.id !== id) continue;
    const endZip = path.join(dir, "end.zip");
    if (!fs.existsSync(endZip)) continue;
    let brainDir: string | null = null;
    let s: { brainDir?: unknown; lineup?: { brain?: unknown }[] } | null = null;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8")); } catch { /* 没写完 */ }
    // 不叫大脑的验证班接着存档跑也归这个世界, 但不进接力 (2026-11-05 查出: 开虫子验证班丢了 28% 建筑, 真班点开班会接它的存档和空笔记)
    if (Array.isArray(s?.lineup) && s.lineup.length && s.lineup.every((l) => l?.brain === "none")) continue;
    if (typeof s?.brainDir === "string" && fs.existsSync(s.brainDir)) brainDir = s.brainDir;
    return { runId, endZip, brainDir };
  }
  return null;
}

/** 命令行明确说了不叫大脑 (--brain none / --brains none,none): 这条永远赢过群名单 (2026-11-06 我给 --group --brain none 想核一下教训库, 名单还是读群文件, 真叫了 5 个模型) */
export function noBrainRequested(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(brain|brains)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    const v = m[2] ?? argv[i + 1] ?? "";
    if (v.split(",").every((x) => x.trim() === "none")) return true;
  }
  return false;
}

/** 按群开班有没有问题 (纯函数; 回错误文字或 null): 群里已经有班次却没给 --save → 会悄悄开张新图, 下一班还会接到它 (2026-11-06 就这么开了一张); 界面开班 startArgs 总会带 --save */
export function groupStartProblem(g: Group, save: string | undefined, last: { runId: string } | null): string | null {
  if (last && !save) return `群 "${g.name}" 已经有班次 (最近 ${last.runId}), 没给 --save 会开一张新图盖掉接力; 要接着玩走界面开班, 要验证用 --save 存档 --brains none,none, 不给 --group`;
  return null;
}

/** 按群开一班的 run.ts 参数 (控制接口 POST /api/group/start 用): 派对配置, 世界 = 群, 名单 = 群成员, 接这个群最近一班 (或群里指定的存档) */
export function startArgs(playDir: string, g: Group): string[] {
  if (g.kind === "server") throw new Error("联机服务器的群还开不了班: 真模型没上过真服, 现在只能只读连接");
  if (g.kind === "mine") throw new Error("我的账号的群不走班次, 走 mk-world.ts");
  const args = ["--kit", "party", "--mod", "agent-harness-party", "--minutes", String(g.minutes), "--group", g.id, "--brains", rosterToBrains(g.seats)];
  const last = latestRunOfGroup(playDir, g.id);
  if (last) { args.push("--save", last.endZip); if (last.brainDir) args.push("--notes", last.brainDir); }
  else if (g.kind === "save" && g.save) {
    args.push("--save", g.save);
    // 存档是我们某一班的 end.zip 时, 把那一班的大脑笔记也接过来
    const dir = path.dirname(g.save);
    try { const s = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8")); if (typeof s.brainDir === "string" && fs.existsSync(s.brainDir)) args.push("--notes", s.brainDir); } catch { /* 不是我们的班 */ }
  }
  return args;
}
