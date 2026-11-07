// ./fh 回复后面附的东西 (库, 不直接运行; commands/fh.ts 调): 放机器时、查东西时、报错时接上相关积累 (./know 的那几条)。
// 旧项目量过: 经验随回复带出约 1600 条次, 但要模型自己想起来查的几乎没人查; 所以在它正要做那件事的那一刻给。
// 只给事实和能跑的命令, 用不用模型定; 不拒绝手放。不刷屏: 每种东西有间隔, 压缩后重新给。计算器配比、蓝图候选、真实基地的图等 ./calc ./bp 那块接上再加。
import fs from "node:fs";

const MACHINE = /^(assembling-machine-\d|stone-furnace|steel-furnace|electric-furnace|chemical-plant|oil-refinery|lab|electric-mining-drill|burner-mining-drill)$/;
/** 经验隔多久重新给一次: 3 小时一班模型会压缩很多次, 压缩后就没了 (Claude Code 的压缩钩子会清 forgetShown; 别家看不到压缩, 靠这个) */
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

const readState = (f: string): HintState => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const writeState = (f: string, s: HintState) => { try { fs.writeFileSync(f, JSON.stringify(s)); } catch { /* 写不上: 下次多提醒一次 */ } };

/** 上下文压缩后调: 模型已经不记得了, 之前"给过"的都当没给过; 动作计数留着 */
export function forgetShown(stateFile: string): void {
  const s = readState(stateFile);
  for (const k of Object.keys(s)) if (k.startsWith("pic:") || k.startsWith("q:")) delete s[k];
  writeState(stateFile, s);
}

/** ./fh 动作类命令记一笔; 查东西不算 */
const COUNTED = new Set(["build", "transfer", "build_path", "craft", "collect", "mine", "move_to", "feed", "refuel", "rotate", "research", "shoot"]);
export function countAction(cmd: string | undefined, stateFile: string): void {
  if (!cmd || !COUNTED.has(cmd)) return;
  const s = readState(stateFile);
  s.__cmds = (s.__cmds ?? 0) + 1;
  writeState(stateFile, s);
}

export type HintDeps = { zh: (id: string) => string | undefined; stateFile: string; now: number; /** 相关的思路 / 事实 / 教训, 几行 */ know: (name: string) => string[];
  /** 这个产物按 30/分 的配比 (src/play/calc-brief.ts calcBrief); 给了才附 ./plan / ./bp 那几行 */ calc?: (item: string) => string | null;
  /** 蓝图库里和这个词相关的块, 每行 "编号. 名字 | 大小" (src/play/bp.ts entries) */ blocks?: (keyword: string) => string[] };

/** ./fh call build 成功后追加的提示; 没有就 null。每个角色每种东西隔一段时间才给一次 (放机器正是想怎么摆、要几台的时候)。
 *  第二版量过 (2026-11-05 ~ 11-08 四班): 简报里写着的 ./calc ./plan ./bp 没人用, 手放到底; 所以放下第一台机器时把配比、能直接跑的 ./plan 命令、库里现成的块一起递到眼前。只给事实和命令, 手放也行 */
export function buildHint(args: string[], d: HintDeps): string | null {
  const m = builtMachine(args);
  if (!m) return null;
  const name = (m.recipe && d.zh(m.recipe)) || d.zh(m.item) || m.item;
  const state = readState(d.stateFile);
  const key = m.recipe ?? m.item;
  const nKey = `n:${key}`;
  state[nKey] = (state[nKey] ?? 0) + (m.count ?? 1);
  const parts: string[] = [];
  if (d.now - (state[`pic:${key}`] ?? 0) >= REPEAT_MS) {
    state[`pic:${key}`] = d.now;
    if (d.calc || d.blocks) {
      const calc = m.recipe && d.calc ? d.calc(m.recipe) : null;
      if (calc) parts.push(calc);
      const target = m.recipe ?? "automation-science-pack";
      parts.push(`整块建 (一条命令: 算全链 → 减场上已有 → 挑蓝图块 → 找空地 → 备料 → 放): ./plan ${target} 30 --build; 只看方案不放: ./plan ${target} 30; 自己算配比: ./calc '{"targets":{"${target}":30}}'`);
      const blocks = d.blocks?.(name) ?? [];
      if (blocks.length) parts.push(`库里现成的块 (./bp show 编号 看要什么料; ./bp build 编号 --at x,y 整块建): ${blocks.slice(0, 3).join("; ")}`);
    }
    const notes = d.know(name);
    if (notes.length) parts.push(`相关经验 (工具附的; ./know ${name} 看更多):\n${notes.join("\n")}`);
  }
  writeState(d.stateFile, state);
  return parts.length ? parts.join("\n") : null;
}

const jsonArgs = (args: string[]): Record<string, unknown> => { const i = args.indexOf("--args"); if (i < 0 || !args[i + 1]) return {}; try { return JSON.parse(args[i + 1]); } catch { return {}; } };

/** 他们已经在查的命令 → 要接上什么: recipes X → 物品; describe / help X → 动作或主题; technologies → 科技 */
export function lookupQuery(args: string[]): { query: string; item?: string } | null {
  const cmd = args[0] === "call" ? args[1] : args[0];
  const next = args[0] === "call" ? args[2] : args[1];
  const pos = next && !next.startsWith("-") && !next.startsWith("{") ? next : undefined;
  const o = jsonArgs(args);
  if (cmd === "recipes") { const n = typeof o.name === "string" ? o.name : pos; return n ? { query: n, item: n } : null; }
  if (cmd === "describe" || cmd === "help") { const n = typeof o.action === "string" ? o.action : pos; return n && !/^(pattern-|index$|facts$)/.test(n) ? { query: n } : null; }
  if (cmd === "technologies") { const n = typeof o.name === "string" ? o.name : pos; return { query: n ?? "研究 科技 顺序" }; }
  return null;
}

/** 查东西的回复后面接几行: 相关经验; 同一个词 20 分钟一次, 一个角色 1 分钟最多一条 */
export function lookupHint(args: string[], state: HintState, d: { now: number; know: (q: string, n?: number) => string[] }): string | null {
  const q = lookupQuery(args);
  if (!q) return null;
  const k = `q:${q.query}`;
  if (d.now - (state.__lookup ?? 0) < LOOKUP_ANY_MS || d.now - (state[k] ?? 0) < LOOKUP_SAME_MS) return null;
  const lines = d.know(q.query, 2);
  if (!lines.length) return null;
  state.__lookup = d.now;
  state[k] = d.now;
  return `相关经验 (工具附的; ./know ${q.query} 看更多):\n${lines.join("\n")}`;
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

/** 队友刚做了什么 (事实, 不是建议; 多角色时上一层的 team-events.jsonl); 5 分钟最多一条, 太旧的不说 */
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
  /** 用到时才加载 (知识库、游戏名单要几百毫秒, 大多数 ./fh 用不上) */ load: () => Promise<{ zh: (id: string) => string | undefined; know: (q: string, n?: number) => string[] }>;
  teamFile?: string;
  /** 放机器时递的配比和蓝图候选 (都是附带的; 没给就只附经验) */
  calc?: (item: string) => Promise<string | null>;
  blocks?: (keyword: string) => Promise<string[]>;
};

/** 一条 ./fh 回复后面附什么: 放机器 > 查东西 / 报错; 队友事实另算; 全部是附带的, 调用方兜住错误 */
export async function replyExtras(args: string[], out: string, status: number, d: ExtraDeps): Promise<string | null> {
  const cmd = args[0] === "call" ? args[1] : args[0];
  const parts: string[] = [];
  countAction(status === 0 ? cmd : undefined, d.stateFile);
  if (cmd === "build" && status === 0 && builtMachine(args)) {
    const deps = await d.load();
    // calc / blocks 是异步的, buildHint 是同步的: 先算好再给 (每种机器 45 分钟才给一次, 多算一次不碍事)
    const m = builtMachine(args)!;
    const calcText = d.calc && m.recipe ? await d.calc(m.recipe) : null;
    const blockList = d.blocks ? await d.blocks((m.recipe && deps.zh(m.recipe)) || deps.zh(m.item) || m.item) : [];
    const h = buildHint(args, { zh: deps.zh, know: (n) => deps.know(n, 2), stateFile: d.stateFile, now: d.now, ...(d.calc ? { calc: () => calcText } : {}), ...(d.blocks ? { blocks: () => blockList } : {}) });
    if (h) parts.push(h);
  }
  const state = readState(d.stateFile);
  const failed = status !== 0 || /^error:/m.test(out);
  const wantsLookup = !failed && lookupQuery(args) !== null;
  if (failed || wantsLookup) {
    const deps = await d.load();
    const extra = failed ? errorHint(args, out, status, state, { now: d.now, know: deps.know }) : lookupHint(args, state, { now: d.now, know: deps.know });
    if (extra) parts.push(extra);
  }
  if (d.teamFile) { const f = teamFact(state, d.now, d.me, () => fs.readFileSync(d.teamFile!, "utf8")); if (f) parts.push(f); }
  writeState(d.stateFile, state);
  return parts.length ? parts.join("\n") : null;
}
