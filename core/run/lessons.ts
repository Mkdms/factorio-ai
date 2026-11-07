// 教训 (库, 不直接运行): 种子文件的合规、模型各班自己记的 (待核区)、做对应动作时挑哪几条带出、班末从笔记里收教训。
// 模型的手脚不装模组, 教训不进游戏里的教训库: 开班从训练集读进内存, 行动层 (commands/actions.ts 的 lessons 依赖) 做对应动作时回复里带 2 条; 班末笔记里的教训写进 training/lessons/pending/learned.jsonl。
import fs from "node:fs";

export type LessonKeys = { action?: string; entity?: string; item?: string; recipe?: string };
/** unverified: 往届模型笔记带来的, 没核实过 */
export type Seed = { rule: string; keys: LessonKeys; impact?: number; fix?: string; cause?: string; source?: string; unverified?: boolean };

export const RULE_BYTES = 160;
export const TEXT_BYTES = 240;
export const KEY_NAMES = ["action", "entity", "item", "recipe"] as const;
export const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** 压成一行并截到 ≤max 字节 (不切坏多字节字符); 切了就在末尾加 … */
export function fitBytes(s: string, max = RULE_BYTES): string {
  const t = norm(s);
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

/** 种子文件 {lessons: [...]}: 每条合规、不重复 */
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

// ---- 模型自己记的 (待核区 learned.jsonl, 一行一条 {rule, keys, who, run}) ----
export type Learned = { rule: string; keys: LessonKeys; who?: string; run?: string };
/** 通用的才跨世界带: 带坐标的只对那个世界有用; 只对那一局有用的; 工具当时的毛病修好就过期 */
export const isGeneralLesson = (line: string): boolean =>
  !/[(（]\s*-?\d+(\.\d+)?\s*[,，]\s*-?\d+/.test(line) && !/\b[xy]\s*[=≈><]\s*-?\d/i.test(line) && !/-?\d+\.\d+\s*,\s*-?\d+/.test(line)
  && !/(这班|这局|这个世界|上一班|本班|西边|东边|南边|北边|\d+\+? ?格外)/.test(line)
  && !/(TypeError|坏了|报障|已修|已向管理员|工具报|旧笔记|^旧:)/.test(line);
export function readLearned(file: string): Learned[] {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out: Learned[] = [];
  for (const l of text.split(/\r?\n/)) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (typeof o.rule === "string" && o.keys) out.push(o); } catch { /* 坏行跳过 */ } }
  return out;
}
/** 记下来: 通用的、文件里还没有的才记; 回记了几条 */
export function appendLearned(file: string, rows: Learned[]): number {
  const seen = new Set(readLearned(file).map((x) => norm(x.rule)));
  const fresh = rows.filter((x) => { const k = norm(x.rule); if (!isGeneralLesson(x.rule) || seen.has(k)) return false; seen.add(k); return true; }); // 同一批里重复的也只记一条
  if (fresh.length) fs.appendFileSync(file, fresh.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return fresh.length;
}
/** 开班带上: 最新记的优先, 和种子文字相同的不要, 最多 max 条; 键非法的跳过; 标 unverified, impact 低于核实过的种子 */
export function learnedSeeds(files: string[], seeds: Seed[], max = 70): Seed[] {
  const have = new Set(seeds.map((s) => norm(s.rule)));
  const out: Seed[] = [];
  for (const x of files.flatMap((f) => readLearned(f)).reverse()) {
    if (out.length >= max) break;
    if (have.has(norm(x.rule)) || !isGeneralLesson(x.rule)) continue;
    try { const s = validateSeed({ rule: x.rule, keys: x.keys, impact: 1, source: `模型笔记 ${x.who ?? ""} ${x.run ?? ""}, 没核实` }); have.add(norm(s.rule)); out.push({ ...s, unverified: true }); } catch { /* 不合格的不带 */ }
  }
  return out;
}

// ---- 做动作时带出 ----
/** 这条动作碰到的名字: 单个的 item / name / recipe, 批量 builds 里的每一行 */
function namesIn(args: Record<string, unknown>): { entity: Set<string>; recipe: Set<string> } {
  const entity = new Set<string>(), recipe = new Set<string>();
  const add = (o: Record<string, unknown>) => {
    for (const k of ["item", "name", "entity"]) if (typeof o[k] === "string") entity.add(o[k] as string);
    if (typeof o.recipe === "string") recipe.add(o.recipe);
  };
  add(args);
  if (Array.isArray(args.builds)) for (const r of args.builds) add(r as Record<string, unknown>);
  return { entity, recipe };
}
/** 这条种子对不对得上: 带 action 时动作要对上, 带名字时名字也要对上 */
export function lessonMatches(s: Seed, action: string, args: Record<string, unknown>): boolean {
  const k = s.keys;
  if (k.action && k.action !== action) return false;
  const { entity, recipe } = namesIn(args);
  const named = k.entity !== undefined || k.item !== undefined || k.recipe !== undefined;
  if (!named) return !!k.action;
  return (!!k.entity && entity.has(k.entity)) || (!!k.item && entity.has(k.item)) || (!!k.recipe && recipe.has(k.recipe));
}
/** 回复里带哪几条: 一次最多 perReply 条, 影响大的先; 同一条一班最多带 perLesson 次 (占上下文); 记带出了多少次 */
export function lessonPicker(seeds: Seed[], perReply = 2, perLesson = 2): { pick: (action: string, args: Record<string, unknown>) => string[]; stats: () => { shown: number; distinct: number } } {
  const shown = new Map<string, number>();
  let total = 0;
  return {
    pick: (action, args) => {
      const hits = seeds.filter((s) => (shown.get(s.rule) ?? 0) < perLesson && lessonMatches(s, action, args));
      hits.sort((a, b) => (b.impact ?? 1) - (a.impact ?? 1));
      return hits.slice(0, perReply).map((s) => {
        shown.set(s.rule, (shown.get(s.rule) ?? 0) + 1);
        total++;
        return `${s.fix ? `${s.rule} 做法: ${s.fix}` : s.rule}${s.unverified ? " (之前的模型记的, 没核实)" : ""}`;
      });
    },
    stats: () => ({ shown: total, distinct: shown.size }),
  };
}

// ---- 班末从笔记里收 ----
/** notes.md 的 "## 教训" (或 "## Lessons") 一节, 一行一条; 去掉列表符号; 跳过空的和占位 */
export function parseNotesLessons(md: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const l of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^#{1,3}\s/.test(l)) { inside = /^#{1,3}\s*(Lessons|教训)/i.test(l); continue; }
    if (!inside) continue;
    const t = l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\*\*/g, "").trim();
    if (!t || /^[(（]?(none|无|暂无|没有|空|待补)[)）]?[.。]?$/i.test(t) || t.startsWith("<!--") || /^[(（].*[)）]$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

/** 推断键用的名字表: 动作名 + 内部名 + 官方中文名 → 内部名 (最长优先) */
export type NameIndex = { actions: Set<string>; internal: Set<string>; byZh: Map<string, string>; re: RegExp | null };
export function nameIndex(zh: Map<string, string>, actions: Iterable<string>): NameIndex {
  const byZh = new Map<string, string>();
  for (const [k, v] of zh) if (typeof v === "string" && v.length >= 2 && !byZh.has(v)) byZh.set(v, k);
  const names = [...byZh.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return { actions: new Set(actions), internal: new Set(zh.keys()), byZh, re: names.length ? new RegExp(names.join("|")) : null };
}
/** 我们的命令 (commands/actions.ts) 和读数命令 */
export const KNOWN_ACTIONS = ["move_to", "build", "transfer", "craft", "mine", "rotate", "research", "say", "build_path", "collect", "refuel", "feed", "shoot", "retreat",
  "inspect", "stock", "nearest", "nearest_water", "observe", "status", "inventory", "recipes", "technologies", "map", "scan"];
/** 只读 / 聊天类动作不当键 (键在这些上会在每次查看时都弹出来) */
const GENERIC = new Set(["status", "chat", "say", "tell", "help", "observe", "map", "scan", "describe", "inventory", "nearest", "nearest_water", "clock", "board", "notes", "lessons", "lesson_add", "science", "labs", "sleep", "sleep_check", "recipes", "technologies", "stock", "inspect"]);
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
  if (!name) for (const [re, id] of ALIASES) if (re.test(line) && idx.internal.has(id)) { name = id; break; }
  if (name) { if (action === "craft" || /手搓|craft/.test(low)) keys.recipe = name; else keys.item = name; }
  return Object.keys(keys).length ? keys : null;
}

export type MergeCandidate = { rule: string; keys: LessonKeys; line: string };
/** 班末的计划: 每行推断键、截到上限、和已有的去重 (同文字或一条是另一条的开头), 每人每班最多 max 条 */
export function mergePlan(lines: string[], existing: { rule: string }[], idx: NameIndex, max = 8): { add: MergeCandidate[]; skipped: { line: string; why: string }[] } {
  const seen = existing.map((e) => norm(e.rule));
  const add: MergeCandidate[] = [], skipped: { line: string; why: string }[] = [];
  for (const line of lines) {
    if (add.length >= max) { skipped.push({ line, why: `每人每班最多 ${max} 条` }); continue; }
    const keys = inferKeys(line, idx);
    if (!keys) { skipped.push({ line, why: "认不出键 (没提到动作名或物品 / 建筑的官方名)" }); continue; }
    const rule = fitBytes(line);
    const r = norm(rule), chars = (x: string) => [...x].length;
    if (seen.some((s) => s === r || (Math.min(chars(s), chars(r)) >= 10 && (s.startsWith(r) || r.startsWith(s))))) { skipped.push({ line, why: "库里已有" }); continue; }
    seen.push(norm(rule));
    add.push({ rule, keys, line });
  }
  return { add, skipped };
}
