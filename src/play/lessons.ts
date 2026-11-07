// 教训库 (库, 不直接运行)。派对的教训库 (mods/agent-harness-party/board.lua: lesson_add / lessons / lesson_verify, 存在存档里, 全队共享,
// 大脑做对应动作时回复里自动带 2 条) 是"被动推送"; 我们的经验以前只能主动查 (./fh help pilot-*), 18 班里只查了 2 次
// ("积累是地板不是天花板, 可以更上一层楼")。所以:
//   ① 开班把 knowledge/lessons-seed.json 登记进教训库 (已有的 lesson_verify 刷新, 不重复加; src/play/run.ts);
//   ③ 班末把各角色 notes.md 的 "## Lessons" 合并进教训库 (推断 action / item / recipe 键; 一班班往下传)。
// 规则文字按字节 ≤160 (board.lua fits 用 #text), 中文约 53 字; 名字键要是游戏内部名 (模组按原型表校验)。
import fs from "node:fs";

export type LessonKeys = { action?: string; entity?: string; item?: string; recipe?: string };
/** unverified: 往届大脑笔记带来的, 没核实过: 不刷"已核实", 库满时不挤别的 */
export type Seed = { rule: string; keys: LessonKeys; impact?: number; fix?: string; cause?: string; source?: string; unverified?: boolean };
/** score: 模组算的分 (lessonbook.lua: 重要度 ×2 + 适用范围 + 核实次数 + 新旧) */
export type ExistingLesson = { id: number; rule: string; keys?: LessonKeys; status?: string; score?: number };
export type Reply = { ok: boolean; result?: any; error?: { code?: string; message?: string } };
/** 以某个角色的身份发动作 (run.ts 用 Harness.request; 测试用假的) */
export type Call = (action: string, args: Record<string, unknown>) => Promise<Reply>;

export const RULE_BYTES = 160;
export const TEXT_BYTES = 240;
/** 模组上限 150 条活的; 留几条给大脑自己记 */
export const MAX_LESSONS = 150;
export const KEY_NAMES = ["action", "entity", "item", "recipe"] as const;

export const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** 压成一行并截到 ≤max 字节 (不切坏多字节字符); 切了就在末尾加 … */
export function fitBytes(s: string, max = RULE_BYTES): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (bytes(t) <= max) return t;
  let out = "";
  for (const ch of t) { if (bytes(out + ch + "…") > max) break; out += ch; }
  return out.replace(/[,，;；:：、 ]+$/, "") + "…";
}

export function validateSeed(s: unknown, where = "教训"): Seed {
  const o = (s ?? {}) as Partial<Seed>;
  if (typeof o.rule !== "string" || !o.rule.trim()) throw new Error(`${where}: rule 要是非空文字`);
  if (bytes(o.rule) > RULE_BYTES) throw new Error(`${where}: rule 超过 ${RULE_BYTES} 字节 (${bytes(o.rule)}): ${o.rule.slice(0, 30)}…`);
  const keys: LessonKeys = {};
  for (const k of KEY_NAMES) {
    const v = (o.keys ?? {})[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(v)) throw new Error(`${where}: 键 ${k} 要是内部名 (小写、短横线), 不是 ${JSON.stringify(v)}`);
    keys[k] = v;
  }
  if (!Object.keys(keys).length) throw new Error(`${where}: 至少一个键 (action / entity / item / recipe)`);
  if (o.impact !== undefined && (!Number.isInteger(o.impact) || o.impact < 0 || o.impact > 5)) throw new Error(`${where}: impact 要是 0..5 的整数`);
  for (const f of ["fix", "cause"] as const) if (o[f] !== undefined && (typeof o[f] !== "string" || bytes(o[f]!) > TEXT_BYTES)) throw new Error(`${where}: ${f} 要是 ≤${TEXT_BYTES} 字节的文字`);
  return { rule: o.rule.trim(), keys, impact: o.impact, fix: o.fix, cause: o.cause, source: typeof o.source === "string" ? o.source : undefined };
}

export function loadSeeds(file: string): Seed[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { lessons?: unknown };
  if (!Array.isArray(raw.lessons)) throw new Error(`${file}: 要有 lessons 数组`);
  const seeds = raw.lessons.map((s, n) => validateSeed(s, `${file} 第 ${n + 1} 条`));
  const seen = new Set<string>();
  for (const s of seeds) {
    const sig = `${norm(s.rule)}|${KEY_NAMES.map((k) => s.keys[k] ?? "").join("|")}`;
    if (seen.has(sig)) throw new Error(`${file}: 重复 (同文字同键): ${s.rule.slice(0, 30)}…`);
    seen.add(sig);
  }
  return seeds;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const sameKeys = (a: LessonKeys = {}, b: LessonKeys = {}) => KEY_NAMES.every((k) => (a[k] ?? "") === (b[k] ?? ""));

/** 已有的不重复加: 文字和键都一样的 → 复核 (lesson_verify, 刷掉 stale); 其余 → 新加。往届笔记带来的 (unverified) 已经在库里就不动: 没人核实过, 不能刷"已核实", 不然分数年年涨、永远退不掉 */
export function seedPlan(seeds: Seed[], existing: ExistingLesson[]): { add: Seed[]; verify: ExistingLesson[] } {
  const add: Seed[] = [], verify: ExistingLesson[] = [];
  for (const s of seeds) {
    const hit = existing.find((e) => norm(e.rule) === norm(s.rule) && sameKeys(e.keys, s.keys));
    if (!hit) add.push(s);
    else if (!s.unverified) verify.push(hit);
  }
  return { add, verify };
}

/** 教训库里活的教训, 全部 (模组上限 150; lessons 原来一次最多 64 条, 移植时放到 256。2026-11-06: 只读 64 条去重, 库里已有的被当成新的再加一遍, 这就是"开班 71 条登记失败") */
export async function readLessons(call: Call): Promise<ExistingLesson[]> {
  const r = await call("lessons", { limit: 256 });
  if (!r.ok) throw new Error(r.error?.message ?? "lessons 读不到");
  const rows: unknown[] = Array.isArray(r.result?.lessons) ? r.result.lessons : [];
  return rows.filter((x): x is Record<string, any> => !!x && typeof (x as any).rule === "string")
    .map((x) => ({ id: Number(x.id), rule: String(x.rule), keys: (x.keys ?? {}) as LessonKeys, status: typeof x.status === "string" ? x.status : undefined, score: typeof x.score === "number" ? x.score : undefined }));
}

export type SeedResult = { added: number; verified: number; failed: string[]; total: number; /** 库满时给种子让位退掉的 */ dropped?: number; /** 往届笔记带来的, 库满没进 (不挤别的, 不算失败) */ skippedFull?: number };

/** 库满时退一条, 腾出位置; 没得退回 false。退掉的记进 dropped, 不重复退 */
async function makeRoom(call: Call, existing: ExistingLesson[], protect: Seed[], dropped: Set<number>, maxScore = Infinity): Promise<boolean> {
  const victim = dropCandidates(existing, protect).find((e) => !dropped.has(e.id) && (e.score ?? 0) <= maxScore);
  if (!victim) return false;
  dropped.add(victim.id);
  return (await call("lesson_edit", { id: victim.id, status: "dropped" })).ok;
}

/** ① 开班: 种子登记进教训库 (以第 1 个角色的身份); 已有的复核。满了: 核实过的种子挤掉分最低的; 往届笔记带来的不挤 */
export async function seedLessons(call: Call, seeds: Seed[]): Promise<SeedResult> {
  const existing = await readLessons(call);
  const plan = seedPlan(seeds, existing);
  const out: SeedResult = { added: 0, verified: 0, failed: [], total: existing.length };
  const dropped = new Set<number>();
  const protect = seeds.filter((s) => !s.unverified);
  for (const e of plan.verify) {
    const r = await call("lesson_verify", { id: e.id });
    if (r.ok) out.verified++; else out.failed.push(`#${e.id} 复核: ${r.error?.message ?? "?"}`.slice(0, 120));
  }
  // 核实过的先进, 位置不够时往届笔记才让路
  for (const s of [...plan.add.filter((x) => !x.unverified), ...plan.add.filter((x) => x.unverified)]) {
    const args: Record<string, unknown> = { rule: s.rule, ...s.keys };
    if (s.impact !== undefined) args.impact = s.impact;
    if (s.fix) args.fix = s.fix;
    if (s.cause) args.cause = s.cause;
    if (out.total >= MAX_LESSONS) {
      if (s.unverified) { out.skippedFull = (out.skippedFull ?? 0) + 1; continue; }
      if (await makeRoom(call, existing, protect, dropped)) { out.dropped = (out.dropped ?? 0) + 1; out.total--; }
    }
    let r = await call("lesson_add", args);
    // 库里其实已经满了 (比如 limit 没读全, 或别的角色刚加): 再让一次位
    if (!r.ok && /holds at most/.test(r.error?.message ?? "")) {
      if (s.unverified) { out.skippedFull = (out.skippedFull ?? 0) + 1; continue; }
      if (await makeRoom(call, existing, protect, dropped)) { out.dropped = (out.dropped ?? 0) + 1; r = await call("lesson_add", args); }
    }
    if (r.ok) { out.added++; out.total++; } else out.failed.push(`${s.rule.slice(0, 24)}…: ${r.error?.message ?? "?"}`.slice(0, 160));
  }
  return out;
}

/** 库满时可以退掉的: 活的、不是核实过的种子; 分最低的在前 (派对的分: lessonbook.lua; 派对从没撞过上限, 7 班才 26 条, 是我们自动灌的才满), 同分先退带坐标的 (换了地方就是错的), 再退旧的 */
export function dropCandidates(existing: ExistingLesson[], protect: Seed[]): ExistingLesson[] {
  const keep = new Set(protect.map((s) => norm(s.rule)));
  const coord = (e: ExistingLesson) => (/-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?|gps=/.test(e.rule) ? 0 : 1);
  return existing.filter((e) => e.status !== "dropped" && e.status !== "done" && !keep.has(norm(e.rule))).sort((a, b) => (a.score ?? 0) - (b.score ?? 0) || coord(a) - coord(b) || a.id - b.id);
}

/** notes.md 的 "## Lessons" (派对骨架) 或 "## 教训" 一节, 一行一条; 去掉列表符号; 跳过空的和占位 */
export function parseNotesLessons(md: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const l of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^#{1,3}\s/.test(l)) { inside = /^#{1,3}\s*(Lessons|教训)/i.test(l); continue; }
    if (!inside) continue;
    const t = l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\*\*/g, "").trim();
    if (!t || /^[(（]?(none|无|暂无|没有|空|待补)[)）]?[.。]?$/i.test(t) || t.startsWith("<!--")) continue;
    out.push(t);
  }
  return out;
}

/** 推断键用的名字表: 动作名 (describe.json) + 内部名 + 官方中文名 → 内部名 (最长优先) */
export type NameIndex = { actions: Set<string>; internal: Set<string>; byZh: Map<string, string>; re: RegExp | null };
export function nameIndex(zh: Map<string, string>, actions: Iterable<string>): NameIndex {
  const byZh = new Map<string, string>();
  for (const [k, v] of zh) if (typeof v === "string" && v.length >= 2 && !byZh.has(v)) byZh.set(v, k);
  const names = [...byZh.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return { actions: new Set(actions), internal: new Set(zh.keys()), byZh, re: names.length ? new RegExp(names.join("|")) : null };
}

/** 派对 describe.json (一行一个动作) 里的动作名; 不够 10 个就用内置清单 (文件缺了或格式变了) */
export const KNOWN_ACTIONS = ["build", "build_path", "construct", "place_ghosts", "blueprint_place", "paste", "craft", "transfer", "collect", "feed", "refuel", "rearm", "repair",
  "mine", "move_to", "walk", "research", "configure", "wire", "bottleneck", "trace", "inspect", "stock", "rates", "power", "pole_route", "belt_route", "pipe_route",
  "order_set", "queue_submit", "wait_until", "launch", "load_silo", "platform_schedule", "lesson_add", "lessons", "board_post"];
export function describeActions(json: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const l of (json ?? "").split(/\r?\n/)) { const m = l.match(/^\s*\{\s*"name"\s*:\s*"([a-z][a-z0-9_]*)"/); if (m) out.add(m[1]); }
  return out.size >= 10 ? [...out] : KNOWN_ACTIONS;
}

/** 只读 / 聊天类动作不当键 (键在这些上会在每次查看时都弹出来) */
const GENERIC = new Set(["status", "chat", "say", "tell", "help", "observe", "map", "scan", "describe", "inventory", "nearest", "clock", "board", "notes", "lessons", "lesson_add", "science", "labs", "sleep_check"]);

/** 俗名 → 内部名 (先长后短) */
const ALIASES: [RegExp, string][] = [[/地下管|地下水管/, "pipe-to-ground"], [/机械臂/, "inserter"], [/水管|管道/, "pipe"], [/电线杆|电杆/, "small-electric-pole"], [/传送带|带子|主带/, "transport-belt"], [/炉子|炉组/, "stone-furnace"], [/采矿机|矿机/, "electric-mining-drill"], [/研究中心|实验室/, "lab"], [/组装机/, "assembling-machine-1"], [/箱子/, "wooden-chest"]];

/** 一行教训 → 键: 动作 (./fh call X / 正文里的动作名) + 名字 (内部名或官方中文名; 手搓类当配方, 其余当物品); 认不出就 null */
export function inferKeys(line: string, idx: NameIndex): LessonKeys | null {
  const keys: LessonKeys = {};
  const low = line.toLowerCase();
  const m = low.match(/(?:\.\/fh\s+(?:call\s+)?|\bfh\s+(?:call\s+)?)([a-z][a-z0-9_]*)/);
  let action = m && idx.actions.has(m[1]) && !GENERIC.has(m[1]) ? m[1] : undefined;
  if (!action) for (const w of low.match(/[a-z][a-z0-9_]{2,}/g) ?? []) if (idx.actions.has(w) && !GENERIC.has(w)) { action = w; break; }
  if (action) keys.action = action;
  let name: string | undefined;
  for (const w of low.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g) ?? []) if (idx.internal.has(w)) { name = w; break; }
  if (!name && idx.re) { const z = line.match(idx.re); if (z) name = idx.byZh.get(z[0]); }
  // 大脑写的是俗名: "机械臂 direction 是抓取侧" 只认官方名时被丢了 (2026-11-05 Grok 的教训就这么没的)
  if (!name) for (const [re, id] of ALIASES) if (re.test(line) && idx.internal.has(id)) { name = id; break; }
  if (name) { if (action === "craft" || /手搓|craft/.test(low)) keys.recipe = name; else keys.item = name; }
  return Object.keys(keys).length ? keys : null;
}

/** recipe 不是配方名 → 当物品; 物品不是物品名 (流体、只有实体) → 当实体; 都不行只留动作 */
export function keyFallbacks(k: LessonKeys): LessonKeys[] {
  const name = k.recipe ?? k.item ?? k.entity;
  const base: LessonKeys = k.action ? { action: k.action } : {};
  const out: LessonKeys[] = [k];
  if (name) {
    if (k.recipe) out.push({ ...base, item: name });
    if (!k.entity) out.push({ ...base, entity: name });
    if (k.action) out.push({ ...base });
  }
  return out;
}

export type MergeCandidate = { rule: string; keys: LessonKeys; line: string };
/** ③ 的计划: 每行推断键、截到上限、和库里已有的去重 (同文字或前 24 字相同), 每人每班最多 max 条 */
export function mergePlan(lines: string[], existing: ExistingLesson[], idx: NameIndex, max = 8): { add: MergeCandidate[]; skipped: { line: string; why: string }[] } {
  const seen = existing.map((e) => norm(e.rule));
  const add: MergeCandidate[] = [], skipped: { line: string; why: string }[] = [];
  for (const line of lines) {
    if (add.length >= max) { skipped.push({ line, why: `每人每班最多 ${max} 条` }); continue; }
    const keys = inferKeys(line, idx);
    if (!keys) { skipped.push({ line, why: "认不出键 (没提到动作名或物品 / 建筑的官方名)" }); continue; }
    const rule = fitBytes(line);
    // 同文字, 或一条是另一条的开头 (短的那条至少 10 个字: "铁板要走带子, 别手搬" 和它加个括号的版本算同一条)
    const r = norm(rule), chars = (x: string) => [...x].length;
    if (seen.some((s) => s === r || (Math.min(chars(s), chars(r)) >= 10 && (s.startsWith(r) || r.startsWith(s))))) { skipped.push({ line, why: "库里已有" }); continue; }
    seen.push(norm(rule));
    add.push({ rule, keys, line });
  }
  return { add, skipped };
}

/**
 * 跨世界带经验: 教训库存在存档里, 笔记在每班大脑目录里, 开新图时只有手写的种子,
 * 之前 14 班笔记里 280 条教训一条都没带过来 (41 条在讲机械臂方向)。所以大脑记的通用教训同时存一份到本机 lessons-learned.jsonl, 开新图时和种子一起登记。
 * 带坐标的只对那个世界有用, 不带; 大脑自己写的没核实过, impact 低于我们核实过的种子, 同一个动作优先显示种子。
 */
export type Learned = { rule: string; keys: LessonKeys; who?: string; run?: string };
export const isGeneralLesson = (line: string): boolean =>
  !/[(（]\s*-?\d+(\.\d+)?\s*[,，]\s*-?\d+/.test(line) && !/\b[xy]\s*[=≈><]\s*-?\d/i.test(line) && !/-?\d+\.\d+\s*,\s*-?\d+/.test(line) // 带坐标
  && !/(这班|这局|这个世界|上一班|本班|西边|东边|南边|北边|\d+\+? ?格外)/.test(line) // 只对那一局有用
  && !/(TypeError|坏了|报障|已修|已向管理员|工具报|旧笔记|^旧:)/.test(line); // 工具当时的毛病, 修好就过期了
export function readLearned(file: string): Learned[] {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out: Learned[] = [];
  for (const l of text.split(/\r?\n/)) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (typeof o.rule === "string" && o.keys) out.push(o); } catch { /* 坏行跳过 */ } }
  return out;
}
/** 记下来: 通用的、库里还没有的才记 */
export function appendLearned(file: string, rows: Learned[]): number {
  const seen = new Set(readLearned(file).map((x) => norm(x.rule)));
  const fresh = rows.filter((x) => isGeneralLesson(x.rule) && !seen.has(norm(x.rule)));
  if (fresh.length) fs.appendFileSync(file, fresh.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return fresh.length;
}
/** 开新图时带上: 新记的优先, 和种子文字相同的不要, 最多 max 条; 键非法的 (validateSeed) 跳过 */
export function learnedSeeds(file: string, seeds: Seed[], max = 70, /** 仓库里带的 (knowledge/lessons-learned.jsonl, 本机没积累时靠它), 排在本机新记的后面 */ shared?: string): Seed[] {
  const have = new Set(seeds.map((s) => norm(s.rule)));
  const out: Seed[] = [];
  for (const x of [...(shared ? readLearned(shared) : []), ...readLearned(file)].reverse()) {
    if (out.length >= max) break;
    if (have.has(norm(x.rule)) || !isGeneralLesson(x.rule)) continue;
    try { const s = validateSeed({ rule: x.rule, keys: x.keys, impact: 1, source: `大脑笔记 ${x.who ?? ""} ${x.run ?? ""}, 没核实` }); have.add(norm(s.rule)); out.push({ ...s, unverified: true }); } catch { /* 不合格的不带 */ }
  }
  return out;
}

export type MergeResult = { candidates: number; added: number; skipped: { line: string; why: string }[]; /** 这次新进库的 (记进 lessons-learned.jsonl) */ rows?: Learned[]; /** 库满时退掉的 */ retired?: number };
/** 刚记的新教训的分: 重要度 1 × 2 + 一个键 + 核实 1 次 + 刚写 3 = 7。库满时它只挤分不比它高的 (过期没人核实的), 不挤别人用过的 */
const NEW_LESSON_SCORE = 7;
/** ③ 班末: 一个角色 notes.md 的教训并进教训库 (以它自己的身份记, owner 就是它)。protect: 核实过的种子, 库满时不退 */
export async function mergeNotesLessons(call: Call, notesMd: string, idx: NameIndex, max = 8, protect: Seed[] = []): Promise<MergeResult> {
  const lines = parseNotesLessons(notesMd);
  const out: MergeResult = { candidates: lines.length, added: 0, skipped: [] };
  if (!lines.length) return out;
  const existing = await readLessons(call);
  const plan = mergePlan(lines, existing, idx, max);
  out.skipped = plan.skipped;
  let total = existing.length;
  const dropped = new Set<number>();
  for (const c of plan.add) {
    if (total >= MAX_LESSONS) {
      if (await makeRoom(call, existing, protect, dropped, NEW_LESSON_SCORE)) { total--; out.retired = (out.retired ?? 0) + 1; }
      else { out.skipped.push({ line: c.line, why: `库满 (${total} 条), 没有分不高于新教训的可退` }); continue; }
    }
    let ok = false, last = "", used: LessonKeys = c.keys;
    for (const k of keyFallbacks(c.keys)) {
      const r = await call("lesson_add", { rule: c.rule, ...k });
      if (r.ok) { ok = true; used = k; break; }
      last = r.error?.message ?? "?";
    }
    if (ok) { out.added++; total++; (out.rows ??= []).push({ rule: c.rule, keys: used }); } else out.skipped.push({ line: c.line, why: `lesson_add 拒绝: ${last.slice(0, 100)}` });
  }
  return out;
}
