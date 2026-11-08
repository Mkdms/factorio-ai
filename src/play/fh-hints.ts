// ./fh 回复后面附的东西 (库, 不直接运行; fh-shim 调): 放机器时当场给算好坐标的命令, 查东西和报错时接上相关积累, 队友用块的事实。
// : 班次 10-16-30 第 42 分钟, 经验随回复带出约 1600 条次,
// 但 ./plan ./bp ./calc 要模型自己想起来, 6 个角色只有 Gpt 用。简报写了也没用 (11-05 之前已经写了), 所以在它正要放机器的那一刻给。
// : 接到他们已经在查的地方 (describe 75、technologies 21、recipes 19、./fh help), 给能直接跑的命令, 不是资料; 列几种摆法, 不只推一种。
// 只给候选、命令和事实, 用不用模型定 (架构 2b); 不拒绝手放。不刷屏: 每种东西有间隔, 压缩后重新给。
import fs from "node:fs";

const MACHINE = /^(assembling-machine-\d|stone-furnace|steel-furnace|electric-furnace|chemical-plant|oil-refinery|lab)$/;
const EVERY_KIND_MS = 10 * 60_000, EVERY_ANY_MS = 3 * 60_000;
/** 字符图、配比、经验隔多久重新给一次: 3 小时一班模型会压缩很多次, 压缩后就没了 (Claude Code 的压缩钩子会直接清 forgetShown; Codex、Grok 看不到压缩, 靠这个) */
const REPEAT_MS = 45 * 60_000;
const LOOKUP_ANY_MS = 60_000, LOOKUP_SAME_MS = 20 * 60_000, ERROR_SAME_MS = 10 * 60_000, TEAM_EVERY_MS = 5 * 60_000, TEAM_FRESH_MS = 20 * 60_000;
export type HintState = Record<string, number>;

/** 这次 ./fh call build 放的机器 (item)、配方、位置、台数; 不是放机器返回 null。JSON 读不了也返回 null, 不影响命令本身 */
export function builtMachine(args: string[]): { item: string; recipe?: string; position?: { x: number; y: number }; count?: number } | null {
  const i = args.indexOf("--args");
  if (i < 0 || !args[i + 1]) return null;
  let o: { item?: unknown; recipe?: unknown; position?: unknown; builds?: { item?: unknown; recipe?: unknown; position?: unknown }[] };
  try { o = JSON.parse(args[i + 1]); } catch { return null; }
  const rows = [o, ...(Array.isArray(o?.builds) ? o.builds : [])];
  const hits = rows.filter((r) => typeof r?.item === "string" && MACHINE.test(r.item));
  if (!hits.length) return null;
  const hit = hits[0];
  const recipe = rows.map((r) => r?.recipe).find((x) => typeof x === "string") as string | undefined;
  const p = hit.position as { x?: unknown; y?: unknown } | undefined;
  return { item: hit.item as string, ...(recipe ? { recipe } : {}), ...(typeof p?.x === "number" && typeof p?.y === "number" ? { position: { x: p.x, y: p.y } } : {}), count: hits.length };
}

/** 现在该不该说这一种; 该说就记上时间 */
export function dueHint(state: HintState, key: string, now: number): boolean {
  if (now - (state.__any ?? 0) < EVERY_ANY_MS || now - (state[key] ?? 0) < EVERY_KIND_MS) return false;
  state.__any = now;
  state[key] = now;
  return true;
}

export type Layout = { no: number; size: number; shape: string; tier: string; w: number; h: number; rate: string; text: string };

/** ./bp list 的一行 → 摆法 (读不出来就 null; 只有 组装机排 / 化工厂排 / 冶炼列 有这个格式) */
export function parseLayout(row: string): Layout | null {
  const m = /^(\d+)\.\s*\[[^\]]*\]\s*(.+?)\s*\|\s*(\d+)x(\d+)\s*\|(.*)$/.exec(row);
  if (!m) return null;
  const label = m[2], size = /× (\d+)/.exec(label)?.[1];
  if (!size) return null;
  return { no: Number(m[1]), size: Number(size), shape: /单排|双排/.exec(label)?.[0] ?? "", tier: /组装机\d型/.exec(label)?.[0] ?? /(stone|steel|electric)-furnace/.exec(label)?.[0] ?? "", w: Number(m[3]), h: Number(m[4]), rate: /实测出 [^,|]+/.exec(m[5])?.[0] ?? "", text: label };
}

/** 从候选里挑 2 种不一样的摆法 (小的单排、大的双排); 同一档机器优先 (他手里放的那种) */
export function pickLayouts(rows: string[], tier = "", n = 2): Layout[] {
  const all = rows.map(parseLayout).filter((x): x is Layout => !!x);
  const bySize = (a: Layout, b: Layout) => a.size - b.size;
  const out: Layout[] = [];
  // 同档的排前面; 同档不够再补别的档 (标着是几型, 没研究的模型自己知道)
  for (const l of [...all.filter((x) => tier && x.tier === tier).sort(bySize), ...all.filter((x) => !tier || x.tier !== tier).sort(bySize)]) {
    if (out.some((o) => o.shape === l.shape && o.tier === l.tier)) continue;
    out.push(l);
    if (out.length >= n) break;
  }
  return out;
}

/** 发给模型的提示: 几种摆法 + 能跑的命令; 坐标查过放得下才写真坐标, 查不了就写 x,y */
export function hintText(name: string, rows: string[], product = name, opts: { tier?: string; spots?: Map<number, { x: number; y: number } | null>; study?: string } = {}): string {
  const layouts = pickLayouts(rows, opts.tier);
  const plan = `算要几台、找空地: ./plan ${product} 每分钟 (加 --build 算完直接放)`;
  if (!layouts.length) {
    const cands = rows.slice(0, 2).map((r) => r.replace(/\s+/g, " ").slice(0, 70)).join(" / ");
    const no = /^(\d+)\./.exec(rows[0] ?? "")?.[1] ?? "编号";
    return `提示 (工具给的, 用不用你定): ${name} 有实测过的整块蓝图, 一条命令放好还带备料和清场。${plan}; 直接放: ./bp build ${no} --at x,y。候选: ${cands}`;
  }
  const lines = layouts.map((l, i) => {
    const at = opts.spots?.get(l.no);
    return `${"ABC"[i]}. ./bp build ${l.no} --at ${at ? `${at.x},${at.y}` : "x,y"}  (${[l.tier, l.shape, `${l.size} 台`, `${l.w}x${l.h}`, l.rate].filter(Boolean).join(" ")}${at ? ", 这个坐标现在是空的" : ""})`;
  });
  if (opts.study) lines.push(`${"ABC"[layouts.length]}. 看真实基地怎么摆再自己设计: ./bp study ${opts.study}`);
  return `提示 (工具给的, 用不用你定): ${name} 有这几种摆法, 一条命令放好还带备料和清场:\n${lines.join("\n")}\n${plan}`;
}

export type HintDeps = { list: (kw: string) => string[]; zh: (id: string) => string | undefined; stateFile: string; now: number;
  /** 真实基地这条线的字符图 */ study?: (key: string) => string | null;
  /** 计算器算好的配比 */ calc?: (key: string) => string | null;
  /** 相关的思路 / 事实 / 教训, 几行 */ know?: (name: string) => string[];
  /** near 附近放得下 w×h 的地方 (游戏里查); 没给就写 x,y */ site?: (near: [number, number], w: number, h: number) => Promise<{ x: number; y: number } | null>;
  /** 这个产物按 30/分要几台、场上几台 */ gap?: (key: string) => Promise<{ need: number; have: number } | null>;
};

const readState = (f: string): HintState => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const writeState = (f: string, s: HintState) => { try { fs.writeFileSync(f, JSON.stringify(s)); } catch { /* 写不上: 下次多提醒一次 */ } };

/** 上下文压缩后调: 模型已经不记得了, 之前"给过"的都当没给过; 手放计数留着 (context-hook 的 session-compact) */
export function forgetShown(stateFile: string): void {
  const s = readState(stateFile);
  for (const k of Object.keys(s)) if (k.startsWith("pic:") || k.startsWith("q:")) delete s[k];
  writeState(stateFile, s);
}

/** ./fh 动作类命令记一笔 (手放事实里的"这条线用了几条命令"); 查东西不算 */
const COUNTED = new Set(["build", "transfer", "belt_route", "build_path", "place_ghosts", "construct", "configure", "rotate", "wire", "pole_route", "craft", "collect", "mine", "move_to", "feed", "refuel", "deconstruct"]);
export function countAction(cmd: string | undefined, stateFile: string): void {
  if (!cmd || !COUNTED.has(cmd)) return;
  const s = readState(stateFile);
  s.__cmds = (s.__cmds ?? 0) + 1;
  writeState(stateFile, s);
}

/** 手放的事实: 第 3 台起, 每多 3 台最多说一次; 决定还是模型的 */
export function handFact(a: { machine: string; recipe?: string; n: number; cmds: number; gap: { need: number; have: number } | null; layout: Layout | null; at: { x: number; y: number } | null; perMin?: number }): string {
  const parts = [`事实 (工具数的): 这是你手放的第 ${a.n} 台${a.machine}${a.recipe ? ` (${a.recipe})` : ""}, 从第 1 台到现在 ${a.cmds} 条命令`];
  if (a.gap) parts.push(`按 ${a.perMin ?? 30}/分要 ${a.gap.need} 台, 场上 ${a.gap.have} 台`);
  if (a.layout) parts.push(`块 ${a.layout.no} 一条命令放 ${a.layout.size} 台: ./bp build ${a.layout.no} --at ${a.at ? `${a.at.x},${a.at.y}` : "x,y"}`);
  return `${parts.join("; ")}。`;
}

/** ./fh call build 成功后追加的提示; 没有就 null。字符图、配比、经验每个角色每种东西隔一段时间才给一次 (放机器正是想怎么摆、要几台的时候) */
export async function buildHint(args: string[], d: HintDeps): Promise<string | null> {
  const m = builtMachine(args);
  if (!m) return null;
  const name = (m.recipe && d.zh(m.recipe)) || d.zh(m.item) || m.item;
  const direct = d.list(name);
  const rows = direct.length ? direct : d.list(m.item);
  const state = readState(d.stateFile);
  const key = m.recipe ?? m.item;
  const parts: string[] = [];
  const tier = /assembling-machine/.test(m.item) ? d.zh(m.item) : m.item;
  const near = m.position ? [m.position.x, m.position.y] as [number, number] : null;
  // 手放计数: 这一种第几台、从第 1 台起多少条命令
  const nKey = `n:${key}`, cmdKey = `cmd0:${key}`;
  if (state[cmdKey] === undefined) state[cmdKey] = state.__cmds ?? 0;
  const before = state[nKey] ?? 0;
  state[nKey] = before + (m.count ?? 1);
  const spotsFor = async (ls: Layout[]) => {
    const spots = new Map<number, { x: number; y: number } | null>();
    if (near && d.site) for (const l of ls) { try { spots.set(l.no, await d.site(near, l.w, l.h)); } catch { spots.set(l.no, null); } }
    return spots;
  };
  if (rows.length && dueHint(state, key, d.now)) {
    const layouts = pickLayouts(rows, tier);
    parts.push(hintText(name, rows, m.recipe ? name : "要的产物", { tier, spots: await spotsFor(layouts), study: m.recipe ?? (/furnace/.test(m.item) ? m.item : undefined) }));
  } else if (rows.length && state[nKey] >= 3 && state[nKey] - (state[`fact:${key}`] ?? 0) >= 3 && (d.now - (state[`factAt:${key}`] ?? 0)) >= EVERY_KIND_MS) {
    const layout = pickLayouts(rows, tier, 1)[0] ?? null;
    const spots = layout ? await spotsFor([layout]) : new Map();
    let gap: { need: number; have: number } | null = null;
    if (m.recipe && d.gap) { try { gap = await d.gap(m.recipe); } catch { /* 算不出来就不说 */ } }
    state[`fact:${key}`] = state[nKey];
    state[`factAt:${key}`] = d.now;
    parts.push(handFact({ machine: d.zh(m.item) ?? m.item, recipe: m.recipe ? name : undefined, n: state[nKey], cmds: (state.__cmds ?? 0) - state[cmdKey], gap, layout, at: layout ? spots.get(layout.no) ?? null : null }));
  }
  if (d.now - (state[`pic:${key}`] ?? 0) >= REPEAT_MS && (d.study || d.calc || d.know)) {
    state[`pic:${key}`] = d.now;
    // 只有带配方才算配比: 放一台石炉不是想每分钟产 30 个石炉 (2026-11-06 真跑: 回了 "石炉 1 台 (组装机2型)", 是做石炉这个物品的配比)
    const calc = m.recipe ? d.calc?.(key) : null;
    if (calc) parts.push(calc);
    const notes = d.know?.(name) ?? [];
    if (notes.length) parts.push(`相关经验 (./know ${name} 看更多):\n${notes.join("\n")}`);
    const pic = d.study?.(key);
    if (pic) parts.push(pic);
  }
  writeState(d.stateFile, state);
  return parts.length ? parts.join("\n") : null;
}

const jsonArgs = (args: string[]): Record<string, unknown> => { const i = args.indexOf("--args"); if (i < 0 || !args[i + 1]) return {}; try { return JSON.parse(args[i + 1]); } catch { return {}; } };

/** 他们已经在查的命令 → 要接上什么 (真班 10-16-30: describe 75、technologies 21、recipes 19; 还有 ./fh help): recipes X → 物品; describe / help X → 动作或主题; technologies → 科技 */
export function lookupQuery(args: string[]): { query: string; item?: string } | null {
  const cmd = args[0] === "call" ? args[1] : args[0];
  // 只认紧跟在命令后面的那个词: 后面的开关带值 (--format json、--bot 名字), 当成查询词会查 "json"
  const next = args[0] === "call" ? args[2] : args[1];
  const pos = next && !next.startsWith("-") && !next.startsWith("{") ? next : undefined;
  const o = jsonArgs(args);
  if (cmd === "recipes") { const n = typeof o.name === "string" ? o.name : pos; return n ? { query: n, item: n } : null; }
  if (cmd === "describe" || cmd === "help") { const n = typeof o.action === "string" ? o.action : pos; return n && !/^(pilot-|index$)/.test(n) ? { query: n } : null; }
  if (cmd === "technologies") { const n = typeof o.name === "string" ? o.name : pos; return { query: n ?? "研究 科技 顺序" }; }
  return null;
}

/** 查东西的回复后面接几行: 相关经验 + 能跑的命令; 同一个词 20 分钟一次, 一个角色 1 分钟最多一条 */
export function lookupHint(args: string[], state: HintState, d: { now: number; know: (q: string, n?: number) => string[]; zh: (id: string) => string | undefined; hasBlock?: (name: string) => boolean }): string | null {
  const q = lookupQuery(args);
  if (!q) return null;
  const k = `q:${q.query}`;
  if (d.now - (state.__lookup ?? 0) < LOOKUP_ANY_MS || d.now - (state[k] ?? 0) < LOOKUP_SAME_MS) return null;
  const lines = d.know(q.query, 2);
  const name = q.item ? d.zh(q.item) ?? q.item : null;
  // 联机没有 ./plan (靠模组和 RCON); ./bp build 有 (拆成一件件放, src/play/bp-online.ts)
  const cmds = name ? (process.env.FH_ONLINE ? [...(d.hasBlock?.(name) ? [`./bp list ${name}`] : []), `./bp study ${name}`] : [`./plan ${name} 每分钟 (算配比、挑块、找空地; 加 --build 直接放)`, ...(d.hasBlock?.(name) ? [`./bp list ${name}`] : []), `./bp study ${name}`]) : [];
  if (!lines.length && !cmds.length) return null;
  state.__lookup = d.now;
  state[k] = d.now;
  return [lines.length ? `相关经验 (工具附的; ./know ${q.query} 看更多):\n${lines.join("\n")}` : "", cmds.length ? `能跑的: ${cmds.join("; ")}` : ""].filter(Boolean).join("\n");
}

/** 失败回复后面接: 最相关的一条经验和查法; 同一个命令 10 分钟一次 */
export function errorHint(args: string[], out: string, status: number, state: HintState, d: { now: number; know: (q: string, n?: number) => string[] }): string | null {
  if (status === 0 && !/^error:/m.test(out)) return null;
  const cmd = args[0] === "call" ? args[1] : args[0];
  if (!cmd || /^(say|tell|chat|help)$/.test(cmd)) return null;
  if (/client_error/.test(out)) return null; // 命令行写错了: 它自己的报错已经说清楚了
  const k = `e:${cmd}`;
  if (d.now - (state[k] ?? 0) < ERROR_SAME_MS) return null;
  const err = /^error:(.*)$/m.exec(out)?.[1] ?? "";
  const items = [...new Set([...err.matchAll(/\b[a-z]+(?:-[a-z0-9]+)+\b/g)].map((m) => m[0]))].slice(0, 2);
  const q = [cmd, ...items].join(" ");
  const lines = d.know(q, 1);
  state[k] = d.now;
  return `${lines.length ? `相关经验 (工具附的): ${lines[0]}\n` : ""}查法: ./know ${q}; 参数: ./fh help ${cmd}`;
}

/** 队友刚用块放了什么 (事实, 不是建议; bp.ts 写 ../team-events.jsonl); 5 分钟最多一条, 太旧的不说 */
export function teamFact(state: HintState, now: number, me: string, read: () => string): string | null {
  if (now - (state.__team ?? 0) < TEAM_EVERY_MS) return null;
  let text = "";
  try { text = read(); } catch { return null; }
  const seen = state.__teamSeen ?? 0;
  const rows = text.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) as { at: number; who: string; text: string }; } catch { return null; } }).filter((x): x is { at: number; who: string; text: string } => !!x && x.at > seen && now - x.at < TEAM_FRESH_MS && x.who !== me);
  const last = rows.at(-1);
  if (!last) return null;
  state.__team = now;
  state.__teamSeen = last.at;
  return `队友: ${last.text}`;
}

export type ExtraDeps = { stateFile: string; now: number; me: string;
  /** 用到时才加载 (蓝图库、知识库、游戏数据要几百毫秒, 大多数 ./fh 用不上) */ load: () => Promise<HintDeps & { knowQ: (q: string, n?: number) => string[]; hasBlock: (name: string) => boolean }>;
  teamFile?: string;
};

/** 一条 ./fh 回复后面附什么: 放机器 > 查东西 / 报错; 队友事实另算; 全部是附带的, 调用方兜住错误 */
export async function replyExtras(args: string[], out: string, status: number, d: ExtraDeps): Promise<string | null> {
  const cmd = args[0] === "call" ? args[1] : args[0];
  const parts: string[] = [];
  countAction(status === 0 ? cmd : undefined, d.stateFile);
  if (cmd === "build" && status === 0 && builtMachine(args)) {
    const deps = await d.load();
    const h = await buildHint(args, { ...deps, stateFile: d.stateFile, now: d.now });
    if (h) parts.push(h);
  }
  const state = readState(d.stateFile);
  const failed = status !== 0 || /^error:/m.test(out);
  const wantsLookup = !failed && lookupQuery(args) !== null;
  if (failed || wantsLookup) {
    const deps = await d.load();
    const extra = failed ? errorHint(args, out, status, state, { now: d.now, know: deps.knowQ }) : lookupHint(args, state, { now: d.now, know: deps.knowQ, zh: deps.zh, hasBlock: deps.hasBlock });
    if (extra) parts.push(extra);
  }
  if (d.teamFile) { const f = teamFact(state, d.now, d.me, () => fs.readFileSync(d.teamFile!, "utf8")); if (f) parts.push(f); }
  writeState(d.stateFile, state);
  return parts.length ? parts.join("\n") : null;
}
