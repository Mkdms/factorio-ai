#!/usr/bin/env node
// npm run play:seen [班次]: 这班每个角色实际看到 / 用到了哪些积累 (所有大脑的轮次记录都认, Codex 的命令也在里面)。
// : 说"给了"之前先看这张表。
// : 调了几次不算数, 加两个看效果的数: 蓝图放的 vs 手放的机器比例、查了 / 给了之后下一步用没用。
import fs from "node:fs";
import path from "node:path";
import { labRoot } from "../lab/gamedir.ts";

const brainRoot = () => process.env.BRAIN_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", "factorio-pilot-brain");
const lines = (f: string) => { try { return fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean); } catch { return []; } };

export type Seen = { know: number; study: number; view: number; check: number; build: number; plan: number; planBuild: number; calc: number; manuals: Record<string, number>; autoShown: number; lessonsShown: number };

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

/** 一个角色的轮次记录 → 用了什么 */
export function seenFromTurns(turnLogs: string[]): Seen {
  const u: Seen = { know: 0, study: 0, view: 0, check: 0, build: 0, plan: 0, planBuild: 0, calc: 0, manuals: {}, autoShown: 0, lessonsShown: 0 };
  for (const text of turnLogs) for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.includes("提示 (工具给的") || line.includes("真实的一段")) u.autoShown += count(line, /提示 \(工具给的|真实的一段/g);
    if (line.includes("lesson #")) u.lessonsShown += count(line, /lesson #\d+/g);
    if (!line.includes("tool_use")) continue;
    let d: { type?: string; message?: { content?: { type?: string; input?: Record<string, unknown> }[] } };
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "assistant" || !Array.isArray(d.message?.content)) continue;
    for (const b of d.message!.content) {
      if (b?.type !== "tool_use") continue;
      const i = b.input ?? {};
      const cmd = [i.command, i.file_path, i.path].filter(Boolean).map(String).join(" ");
      u.know += count(cmd, /\.[/\\]know(\.ps1)?\s/g);
      u.study += count(cmd, /\bbp(\.ps1)?\s+study\b/g);
      u.view += count(cmd, /\bbp(\.ps1)?\s+view\b/g);
      u.check += count(cmd, /\bbp(\.ps1)?\s+check\b/g);
      u.build += count(cmd, /\bbp(\.ps1)?\s+build\b/g);
      u.plan += count(cmd, /\.[/\\]plan(\.ps1)?\s/g);
      u.planBuild += count(cmd, /\.[/\\]plan(\.ps1)?\s[^;&|\n]*--build/g);
      u.calc += count(cmd, /\.[/\\]calc(\.ps1)?\s/g);
      for (const m of cmd.matchAll(/(?:help\s+|ref[/\\])(pilot-[\w-]+|research[/\\][\w-]+)/g)) u.manuals[m[1]] = (u.manuals[m[1]] ?? 0) + 1;
    }
  }
  return u;
}

/** 轮次记录 → 按顺序的 [命令, 回复] (所有大脑的记录都翻成了 Claude 形状; 只认 Bash 这种有 command 的) */
export function commandsOf(turnLogs: string[]): { cmd: string; out: string }[] {
  const rows: { cmd: string; out: string }[] = [];
  const open = new Map<string, number>();
  for (const text of turnLogs) for (const line of text.split(/\r?\n/)) {
    if (!line || !(line.includes("tool_use") || line.includes("tool_result"))) continue;
    let d: { message?: { content?: { type?: string; id?: string; tool_use_id?: string; input?: { command?: unknown }; content?: unknown }[] } };
    try { d = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(d.message?.content)) continue;
    for (const b of d.message!.content) {
      if (b?.type === "tool_use" && typeof b.input?.command === "string") { open.set(b.id ?? "", rows.length); rows.push({ cmd: b.input.command, out: "" }); }
      if (b?.type === "tool_result" && open.has(b.tool_use_id ?? "")) {
        const t = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as { text?: string }[]).map((x) => x.text ?? "").join("") : "";
        rows[open.get(b.tool_use_id ?? "")!].out = t;
      }
    }
  }
  return rows;
}

const norm = (c: string) => c.replace(/\.ps1\b/g, "").replace(/\s+/g, " ");
const LOOKUP = /\.[/\\]know(\.ps1)?\s|\.[/\\]calc(\.ps1)?\s|\bbp(\.ps1)?\s+(list|show|study|view)\b|\.[/\\]plan(\.ps1)?\s(?![^;&|\n]*--build)|\bhelp\s+(pilot-|index\b)|ref[/\\]pilot-/;
const APPLIED = /\bbp(\.ps1)?\s+build\b|\.[/\\]plan(\.ps1)?\s[^;&|\n]*--build|\bbelt_route\b|\bpole_route\b/;
const OFFER = /提示 \(工具给的|能跑的:|下一步 \(用不用你定\)|最近放得下:|一条命令按上面全放下|事实 \(工具数的\)|查法:/;
const WINDOW = 5;

/** 工具回复里给的命令: 只认我们附的那几段里的, 手册正文里的例子不算 */
export function offeredCommands(out: string): string[] {
  const m = OFFER.exec(out);
  if (!m) return [];
  const seen = new Set<string>();
  for (const c of out.slice(m.index, m.index + 1200).matchAll(/\.\/(?:bp|plan|know|calc|fh(?: call)?)\s+[^\s;，。、)'"]+/g)) {
    if (/\b(x,y|编号|每分钟|物品|关键词)\b/.test(c[0])) continue;
    seen.add(c[0]);
  }
  return [...seen];
}

/** 查了之后下一步用没用: 查东西后面 5 条命令里有没有动手 (放块、接线); 给的命令后面 5 条里有没有照跑 */
export function followThrough(rows: { cmd: string; out: string }[], window = WINDOW): { lookups: number; applied: number; offered: number; ran: number } {
  const r = { lookups: 0, applied: 0, offered: 0, ran: 0 };
  rows.forEach((row, i) => {
    const next = rows.slice(i + 1, i + 1 + window).map((x) => norm(x.cmd));
    if (LOOKUP.test(row.cmd)) { r.lookups++; if (next.some((c) => APPLIED.test(c))) r.applied++; }
    for (const c of offeredCommands(row.out)) { r.offered++; if (next.some((n) => n.includes(c))) r.ran++; }
  });
  return r;
}

const MACHINE = /^(assembling-machine-\d|stone-furnace|steel-furnace|electric-furnace|chemical-plant|oil-refinery|lab|centrifuge|foundry|electromagnetic-plant|cryogenic-plant|biochamber|recycler)$/;

/** 手放的机器: journal 里成功的 build (单个和 builds 批量); bp build 不走 ./fh, 不在这里 */
export function handMachines(journal: string[]): number {
  const req = new Map<string, Record<string, any>>();
  let n = 0;
  for (const l of journal) {
    let e: { event?: string; request?: { id?: string; action?: string; args?: Record<string, any> }; response?: { id?: string; ok?: boolean } };
    try { e = JSON.parse(l); } catch { continue; }
    if (e.event === "request" && e.request?.action === "build" && e.request.id) req.set(e.request.id, e.request.args ?? {});
    else if (e.event === "response" && e.response?.ok && e.response.id && req.has(e.response.id)) {
      const a = req.get(e.response.id)!;
      for (const r of [a, ...(Array.isArray(a.builds) ? a.builds : [])]) if (typeof r?.item === "string" && MACHINE.test(r.item)) n++;
    }
  }
  return n;
}

/** 蓝图放的机器: bp build 建完 (剩 0 个虚影) 的回复 → 蓝图编号 → 台数; 编号查不到的 (自己的蓝图) 按回复里的件数不算机器 */
export function blueprintMachines(rows: { cmd: string; out: string }[], machinesOf: (no: number) => number): { blocks: number; machines: number } {
  let blocks = 0, machines = 0;
  for (const r of rows) for (const m of r.out.matchAll(/蓝图 (\d+) \([^\n]*?\) 贴在[\s\S]*?建造: (\w+), 建了 (\d+), 剩 (\d+) 个虚影/g)) {
    if (Number(m[4]) !== 0 || Number(m[3]) === 0) continue;
    blocks++;
    machines += machinesOf(Number(m[1]));
  }
  return { blocks, machines };
}

async function main(): Promise<number> {
  const runs = path.join(labRoot(), "play", "runs");
  const run = process.argv[2] ?? fs.readdirSync(runs).sort().at(-1);
  if (!run) { console.log("没有班次"); return 1; }
  const dir = path.join(runs, run);
  const seats = [...new Set(fs.readdirSync(dir).flatMap((f) => /^turn-([a-z])-\d+\.jsonl$/.exec(f)?.[1] ?? []))].sort();
  let machinesOf = (_no: number) => 0;
  try { const { entries, machineCount } = await import("./bp.ts"); const all = entries(); machinesOf = (no) => { const e = all.find((x) => x.no === no); return e ? machineCount(e.counts) : 0; }; } catch { /* 没有蓝图库: 蓝图放的按 0 算 */ }
  console.log(`班次 ${run}\n角色 | know | study | view | check | build | plan (--build) | calc | 自动附图 | 带出教训 | 蓝图放的机器 (块) | 手放的机器 | 蓝图占比 | 查了→5 条内动手 | 工具给的命令→照跑 | 读过的手册`);
  for (const k of seats) {
    const logs = fs.readdirSync(dir).filter((f) => new RegExp(`^turn-${k}-\\d+\\.jsonl$`).test(f)).map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
    const u = seenFromTurns(logs);
    const rows = commandsOf(logs);
    const hints = lines(path.join(brainRoot(), run, k, ".know.log")).length;
    const errs = lines(path.join(brainRoot(), run, k, ".fh-hints.err"));
    const bp = blueprintMachines(rows, machinesOf), hand = handMachines(lines(path.join(brainRoot(), run, k, "journal.jsonl")));
    const f = followThrough(rows);
    const ratio = bp.machines + hand ? `${Math.round((bp.machines / (bp.machines + hand)) * 100)}%` : "-";
    console.log(`${k.toUpperCase()} | ${Math.max(u.know, hints)} | ${u.study} | ${u.view} | ${u.check} | ${u.build} | ${u.plan} (${u.planBuild}) | ${u.calc} | ${u.autoShown} | ${u.lessonsShown} | ${bp.machines} (${bp.blocks}) | ${hand} | ${ratio} | ${f.lookups}→${f.applied} | ${f.offered}→${f.ran} | ${Object.entries(u.manuals).map(([m, n]) => `${m} ${n}`).join(" ") || "无"}${errs.length ? ` | 提示出错 ${errs.length} 次, 最后: ${errs.at(-1)}` : ""}`);
  }
  return 0;
}

if ((import.meta as { main?: boolean }).main) process.exitCode = await main();
