// 查全部积累 (库, 不直接运行; commands/know.ts 和 ./fh 回复附的经验用): 老玩家思路 (patterns)、核实过的事实 (facts.md)、要点 (points.md)、教训 (seed.json)、检索资料 (knowledge/pending/research)。
// 文字只有一个家 (training/ 里的文件), 这里只读不抄, 每次现读 (几十毫秒)。
import fs from "node:fs";
import path from "node:path";
import { trainingRoots } from "./training.ts";

export type KnowItem = { id: string; source: "思路" | "事实" | "要点" | "教训" | "资料"; where: string; title: string; text: string };

const read = (f: string) => { try { return fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n"); } catch { return ""; } };
const clean = (s: string) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

/** patterns/*.md: "### P-xxx 标题" + "- 情况 / 做法 / 为什么 / 代价 / 状态" */
export function parsePatterns(md: string, where: string): KnowItem[] {
  const out: KnowItem[] = [];
  for (const m of md.matchAll(/^### (P-[\w-]+) +(.+)\n([\s\S]*?)(?=^### |^## |(?![\s\S]))/gm)) {
    const body = m[3];
    const field = (k: string) => clean(new RegExp(`^- ${k}[^:：]*[:：](.*)$`, "m").exec(body)?.[1] ?? "");
    const parts = [field("做法"), field("为什么") && `为什么: ${field("为什么")}`, field("代价") && `代价: ${field("代价")}`].filter(Boolean);
    out.push({ id: m[1], source: "思路", where, title: clean(m[2]), text: parts.join(" ") || clean(body) });
  }
  return out;
}

/** facts.md 的表: | 编号 | 说法 | 结果 | 实测 | 关联 | 版本 | */
export function parseFacts(md: string, where: string): KnowItem[] {
  const out: KnowItem[] = [];
  for (const l of md.split("\n")) {
    if (!l.startsWith("|") || l.startsWith("| 编号") || l.startsWith("|---")) continue;
    const c = l.split("|").map((x) => x.trim());
    if (c.length < 5 || !c[1]) continue;
    out.push({ id: c[1], source: "事实", where, title: clean(c[2]), text: `${c[3]}; 实测: ${clean(c[4] ?? "")}` });
  }
  return out;
}

/** 检索资料的表: 第 1 列是编号, 其余合成一句; 没有编号的行不要 */
export function parseResearch(md: string, where: string): KnowItem[] {
  const out: KnowItem[] = [];
  for (const l of md.split("\n")) {
    if (!l.startsWith("|") || l.startsWith("|---")) continue;
    const c = l.split("|").map((x) => x.trim());
    if (c.length < 4 || !/^[A-Za-z]{1,6}-?\d/.test(c[1] ?? "")) continue;
    out.push({ id: c[1], source: "资料", where, title: clean(c[2]), text: clean(c.slice(3).join(" ")).replace(/https?:\/\/\S+/g, "").slice(0, 400) });
  }
  return out;
}

export function parsePoints(md: string, where: string): KnowItem[] {
  return md.split("\n").filter((l) => l.startsWith("- ")).map((l, i) => {
    const t = clean(l.slice(2));
    return { id: /\((P-[\w-]+|facts[^)]*)/.exec(t)?.[1] ?? `要点${i + 1}`, source: "要点" as const, where, title: t.slice(0, 40), text: t };
  });
}

export function parseSeeds(json: string, where: string): KnowItem[] {
  const seen = new Set<string>();
  try {
    return ((JSON.parse(json) as { lessons?: { rule?: string; source?: string }[] }).lessons ?? []).flatMap((l, i) => {
      const r = clean(l.rule ?? "");
      if (!r || seen.has(r)) return [];
      seen.add(r);
      return [{ id: l.source ?? `教训${i + 1}`, source: "教训" as const, where, title: r.slice(0, 40), text: r }];
    });
  } catch { return []; }
}

/** 全部积累 (公开 + 只本机的两份训练集); where 写成角色目录里能看到的路径 (思路在 ref/pattern-*.md 里) */
export function loadKnowledge(roots = trainingRoots()): KnowItem[] {
  const out: KnowItem[] = [];
  for (const root of roots) {
    for (const area of ["verified", "pending"] as const) {
      const pdir = path.join(root, "patterns", area);
      // 正式区的思路在角色目录 ref/pattern-*.md 里有全文 (workspace.ts setupRef); 待核区的没有
      for (const f of fs.existsSync(pdir) ? fs.readdirSync(pdir).sort() : []) if (f.endsWith(".md") && f !== "README.md") out.push(...parsePatterns(read(path.join(pdir, f)), area === "verified" ? `ref/pattern-${f}` : `待核 ${f}`));
    }
    out.push(...parseFacts(read(path.join(root, "knowledge", "verified", "facts.md")), "ref/facts.md"));
    out.push(...parsePoints(read(path.join(root, "knowledge", "verified", "points.md")), "要点"));
    out.push(...parseSeeds(read(path.join(root, "lessons", "verified", "seed.json")), "教训库"));
    const rdir = path.join(root, "knowledge", "pending", "research");
    for (const f of fs.existsSync(rdir) ? fs.readdirSync(rdir).sort() : []) if (f.endsWith(".md") && f !== "README.md") out.push(...parseResearch(read(path.join(rdir, f)), `资料 ${f}`));
  }
  return out;
}

const WEIGHT: Record<KnowItem["source"], number> = { 教训: 1.2, 事实: 1.2, 要点: 1.1, 思路: 1, 资料: 0.7 };

/** 词 → 词 + 官方名 / 内部名 (查"研究中心"也命中写着 lab 的); 中文长串再拆成两字词兜底 */
export function expandTerms(query: string, names: Map<string, string>): { term: string; weight: number; raw: number }[] {
  const out = new Map<string, { weight: number; raw: number }>();
  let rawNo = 0;
  const add = (t: string, w: number) => { if (t && (out.get(t)?.weight ?? 0) < w) out.set(t, { weight: w, raw: rawNo }); };
  for (const raw of query.split(/[\s,，、]+/).filter(Boolean)) {
    rawNo++;
    const t = raw.toLowerCase();
    add(t, 1);
    for (const [id, zh] of names) {
      if (id === t) add(zh, 1);
      else if (zh === raw) add(id, 0.8);
      else if (raw.length >= 2 && zh.includes(raw) && zh.length <= raw.length + 6) { add(zh, 0.7); add(id, 0.5); }
    }
    if (/^[一-鿿]{4,}$/.test(raw)) for (let i = 0; i + 2 <= raw.length; i++) add(raw.slice(i, i + 2), 0.3);
  }
  return [...out].map(([term, v]) => ({ term, ...v }));
}

const count = (hay: string, needle: string) => { let n = 0, i = hay.indexOf(needle); while (i >= 0 && n < 3) { n++; i = hay.indexOf(needle, i + needle.length); } return n; };

/** 按词打分, 命中的词越全越靠前 */
export function searchKnowledge(items: KnowItem[], query: string, names: Map<string, string> = new Map(), limit = 6): KnowItem[] {
  const terms = expandTerms(query, names);
  if (!terms.length) return [];
  const rawCount = query.split(/[\s,，、]+/).filter(Boolean).length;
  const scored = items.map((it) => {
    const title = it.title.toLowerCase(), text = it.text.toLowerCase();
    let s = 0;
    for (const { term, weight } of terms) s += (count(title, term) * 3 + count(text, term)) * weight;
    const hits = new Set(terms.filter((t) => t.weight >= 0.5 && (title.includes(t.term) || text.includes(t.term))).map((t) => t.raw)).size;
    return { it, s: s * WEIGHT[it.source] * (rawCount > 1 ? (hits / rawCount) ** 2 : 1) };
  }).filter((x) => x.s > 0.4);
  scored.sort((a, b) => b.s - a.s);
  const seen = new Set<string>(), out: KnowItem[] = [];
  for (const { it } of scored) {
    const k = it.text.slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

/** 全文在哪: 思路在 ref/pattern-*.md 里有自己的标题 (./fh help pattern-x P-xxx 只回这一段, commands/ref-sections.ts) */
const fullRef = (it: KnowItem) => {
  const m = /^ref\/(pattern-[\w-]+)\.md$/.exec(it.where);
  if (m && it.source === "思路") return ` (全文: ./fh help ${m[1]} ${it.id})`;
  return it.where.startsWith("ref/") ? ` (全文 ${it.where})` : "";
};

export const knowLine = (it: KnowItem, max = 280) => `[${it.source} ${it.id}] ${it.title === it.text.slice(0, 40) ? "" : `${it.title}: `}${it.text.slice(0, max)}${it.text.length > max ? "…" : ""}${fullRef(it)}`;

/** 工具回复自动附: 只要思路、事实、要点、教训 (资料只在主动查时给), 每条短。titleOnly: 查的词要在标题里 (查铁齿轮配方附了"限产"和"品质插件", 只是顺带提到, 不如不附) */
export function knowHint(query: string, names: Map<string, string>, n = 2, max = 180, titleOnly = false, items = loadKnowledge()): string[] {
  const hits = searchKnowledge(items.filter((x) => x.source !== "资料"), query, names, titleOnly ? 30 : n);
  const terms = titleOnly ? expandTerms(query, names).filter((t) => t.weight >= 0.5).map((t) => t.term) : [];
  return (titleOnly ? hits.filter((it) => terms.some((t) => it.title.toLowerCase().includes(t))).slice(0, n) : hits).map((it) => knowLine(it, max));
}
