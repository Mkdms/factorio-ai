#!/usr/bin/env node
// token 账本 (脚本): npm run play:tokens [-- <班次id>...] (不给 = 最近 3 个有 turn 记录的班); 读 lab-data/play/runs/<班次>/turn-*.jsonl 和 summary.json, 每个角色一段结论
// 库在 src/play/token-profile.ts (有单元测试); 用法见 CLAUDE.md "大脑实跑"。 → 先量后改, 不换模型。
import fs from "node:fs";
import path from "node:path";
import { labRoot } from "../lab/gamedir.ts";
import { profileLines, profileTurns } from "./token-profile.ts";

const runs = path.join(labRoot(), "play", "runs");
const want = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const all = fs.readdirSync(runs).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort();
const withTurns = (id: string) => fs.readdirSync(path.join(runs, id)).some((f) => /^turn-.*\.jsonl$/.test(f) && !f.endsWith("-raw.jsonl"));
const ids = want.length ? want : all.filter(withTurns).slice(-3);
for (const id of ids) {
  const dir = path.join(runs, id);
  if (!fs.existsSync(dir)) { console.log(`${id}: 没有这一班`); continue; }
  let summary: any = {};
  try { summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8")); } catch { /* 没收尾 */ }
  const minutes = Number(summary.realMinutes) || 0;
  const lineup = Array.isArray(summary.lineup) ? summary.lineup : [];
  const files = fs.readdirSync(dir).filter((f) => /^turn-.*\.jsonl$/.test(f) && !f.endsWith("-raw.jsonl"));
  // turn-N.jsonl (一个角色) 或 turn-<角色>-N.jsonl (多角色)
  const byAgent = new Map<string, string[]>();
  for (const f of files) { const m = /^turn-(?:([a-z])-)?(\d+)\.jsonl$/.exec(f); if (!m) continue; const a = m[1] ?? "a"; (byAgent.get(a) ?? byAgent.set(a, []).get(a)!).push(f); }
  console.log(`\n=== ${id}  ${minutes ? `${minutes.toFixed(0)} 分钟` : "(没收尾)"}  ${summary.usage?.costUsd !== undefined ? `Claude Code 估价 $${Number(summary.usage.costUsd).toFixed(2)}` : ""} ===`);
  for (const [a, fs2] of [...byAgent.entries()].sort()) {
    const sorted = fs2.sort((x, y) => Number(/(\d+)\.jsonl$/.exec(x)![1]) - Number(/(\d+)\.jsonl$/.exec(y)![1]));
    const p = profileTurns(sorted.map((f) => fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/)));
    const seat = lineup.find((s: any) => s.id === a) ?? lineup[a.charCodeAt(0) - 97];
    console.log(`-- 角色 ${a}${seat ? ` (${seat.brain ?? ""} ${seat.model ?? ""})` : ""}`);
    for (const l of profileLines(p, minutes)) console.log("   " + l);
  }
}
