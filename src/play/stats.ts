// 每个模型的统计和排行 (库, 不直接运行; 控制接口 GET /api/stats 读, 界面右栏"统计 · 排行"显示)。
//  —— 和 factorio.nickwinter.net 一样按模型看谁干得好。
// 数据全部来自每班的记录目录 (lab-data/play/runs/<班>/): summary.json (产量、时长、花费、空闲)、requests.jsonl (每次请求: 谁、什么动作、成没成)、
// turn-<角色>-1.jsonl 第一行 (这个角色用的模型)、world.json (哪个世界)。没有 summary.json 的班 (中断的) 不算。
// 排行按"每真实小时科技包产量增量" (班末每分钟产量 − 同一世界上一班的, 除以这一班的真实小时数): 奖励把产量推上去的, 不奖励只守着的。
import fs from "node:fs";
import path from "node:path";
import { worldOfRun } from "./control-lib.ts";
import { BUILDS, READS, loadShift } from "./review-shift.ts";
import { knowledgeUse } from "./knowledge-use.ts";

/** 班次目录名 (开班的 UTC 时间), 从早到晚 */
function listRuns(playDir: string): string[] {
  try { return fs.readdirSync(path.join(playDir, "runs")).filter((d) => /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d$/.test(d)).sort(); } catch { return []; }
}

/** 一个角色在一班里的统计 */
export type ShiftAgentStat = {
  run: string; world: string; worldName: string; agent: string;
  /** 这个角色用的模型 (turn-<角色>-1.jsonl 第一行的 model), 读不到 null */
  model: string | null; vendor: string;
  turns: number; requests: number; reads: number; builds: number; fails: number;
  /** 这个角色每轮 result 报的花费合计 (Claude Code 按官方价估的); 老记录没有逐轮数字才按轮次份额分 summary.usage.costUsd; 没记花费 null */
  costUsd: number | null;
  realMinutes: number; gameMinutes: number | null;
  /** 班末近 10 分钟科技包每分钟产量 (红 + 绿 + 蓝); 没记 null */
  science: number | null;
  /** 和同一世界上一班比的增量 (新世界第一班 = 从 0 起); 算不出 null */
  scienceGain: number | null;
  idleShare: number | null;
  /** 用了几次我们的知识和工具 (src/play/knowledge-use.ts): 计算器、蓝图库、经验主题 (fh help pilot-* + 直接读) */
  calc: number; bp: number; plan: number; python: number; knowledge: number;
  /** 回复里自动带出教训的次数 (被动推送) */
  lessons: number;
};

/** 一个模型的汇总 (跨班、跨角色) */
export type ModelStat = {
  model: string; vendor: string; shifts: number; agentShifts: number; realHours: number;
  scienceAvg: number | null; gainPerHour: number | null;
  builds: number; buildsPerHour: number; requests: number; readShare: number | null; fails: number;
  costUsd: number | null; costPerHour: number | null; idleShare: number | null;
  /** 用了几次我们的计算器 / 蓝图库 / 经验 (合计) */
  calc: number; bp: number; plan: number; python: number; knowledge: number;
  lessons: number;
};

/** 模型名 → 厂商 (界面上的名字); 认不出的用模型名本身 */
export function vendorOfModel(model: string | null): string {
  const m = (model ?? "").toLowerCase();
  if (!m) return "未知";
  if (m.includes("claude")) return "Claude";
  if (m.includes("grok")) return "Grok";
  if (m.includes("deepseek")) return "DeepSeek";
  if (m.includes("glm")) return "GLM";
  if (m.includes("gpt") || m.includes("codex") || /^o\d/.test(m)) return "GPT";
  if (m.includes("gemini")) return "Gemini";
  // 中转站里常见的几家 (2026-11-04 朋友的 New API 站价目表)
  if (m.includes("kimi")) return "Kimi";
  if (m.includes("minimax")) return "MiniMax";
  if (m.includes("doubao")) return "豆包";
  if (m.includes("qwen")) return "通义千问";
  return model!;
}

type Summary = {
  agents?: { id: string; turns?: number; brain?: string; model?: string; costUsd?: number }[];
  brain?: string; model?: string;
  lineup?: { id: string; brain?: string; model?: string }[];
  usage?: { costUsd?: number };
  /** 整班的 ./fp / ./fh 调用次数 (老记录没有) */
  fpCalls?: number;
  realMinutes?: number; gameMinutes?: number; idleShare?: number;
  perMin10Total?: { red?: number; green?: number; blue?: number };
  redPerMin10?: number; greenPerMin10?: number;
};

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}

/** 这个角色用的模型: 轮次日志第一行 (Claude Code 的 system/init 事件) 的 model */
export function modelOfAgent(runDir: string, agent: string): string | null {
  try {
    const first = fs.readFileSync(path.join(runDir, `turn-${agent}-1.jsonl`), "utf8").split(/\r?\n/, 1)[0];
    const d = JSON.parse(first) as { model?: unknown };
    return typeof d.model === "string" && d.model ? d.model : null;
  } catch { return null; }
}

/** 11-04 之前只有 Claude 一家 (Grok / DeepSeek 驱动 11-04 才接; 总清单 #252), 对话记录删了、总结里也没记档位的老班归到这一行 */
export const LEGACY_CLAUDE = "claude (旧记录, 档位没记)";
const CLAUDE_ALIAS: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-1" };

/** 这个角色的模型: 轮次日志第一行 (真实用的) → 总结里记的 → 阵容 → 老班兜底; 都没有 null */
export function modelOfShiftAgent(runDir: string, runId: string, s: Summary, agent: string): string | null {
  const fromTurn = modelOfAgent(runDir, agent);
  if (fromTurn) return fromTurn;
  const row = s.agents?.find((a) => a.id === agent), seat = s.lineup?.find((a) => a.id === agent);
  const m = row?.model || seat?.model || (s.lineup ? null : s.model) || null;
  if (m) return CLAUDE_ALIAS[m.toLowerCase()] ?? m;
  return runId < "2026-11-04" ? LEGACY_CLAUDE : null;
}

/** 这个角色每轮 result 报的花费合计 (Claude Code 每轮一个进程, total_cost_usd 就是这一轮的); 没有轮次文件 → 0 */
export function agentCostFromTurns(runDir: string, agent: string): number {
  let files: string[] = [];
  try { files = fs.readdirSync(runDir).filter((f) => f.startsWith(`turn-${agent}-`) && f.endsWith(".jsonl") && !f.endsWith("-raw.jsonl")); } catch { return 0; }
  let cost = 0;
  for (const f of files) {
    let text = "";
    try { text = fs.readFileSync(path.join(runDir, f), "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"total_cost_usd"')) continue;
      try { const o = JSON.parse(line) as { type?: string; total_cost_usd?: unknown }; if (o.type === "result" && typeof o.total_cost_usd === "number") cost += o.total_cost_usd; } catch { /* 坏行 */ }
    }
  }
  return cost;
}

/** 收尾了的班不会再变: 读过的轮次文件结果留着 (统计表每分钟重读; 第 5 班一班就有 199 个轮次文件) */
const extrasCache = new Map<string, { use: ReturnType<typeof knowledgeUse>; cost: number }>();
function extrasOf(runDir: string, agent: string) {
  const k = `${runDir}|${agent}`;
  let v = extrasCache.get(k);
  if (!v) { v = { use: knowledgeUse(runDir, agent), cost: agentCostFromTurns(runDir, agent) }; extrasCache.set(k, v); }
  return v;
}

/** 班末科技包每分钟产量 (红 + 绿 + 蓝); 老记录只有红 / 绿两个字段 */
export function scienceOf(s: Summary): number | null {
  const t = s.perMin10Total;
  const two = (x: number) => Math.round(x * 100) / 100;
  if (t && (t.red !== undefined || t.green !== undefined || t.blue !== undefined)) return two((t.red ?? 0) + (t.green ?? 0) + (t.blue ?? 0));
  if (s.redPerMin10 !== undefined || s.greenPerMin10 !== undefined) return two((s.redPerMin10 ?? 0) + (s.greenPerMin10 ?? 0));
  return null;
}

/** 不到这么多真实分钟的班 (刚开就中断的) 不计, 也不作为下一班算增量的基准 (2026-11-04 真实记录里 13 个几分钟的中断班把增量算成了负的) */
export const MIN_SHIFT_MINUTES = 3;

/** 每个角色每一班的统计 (按班次从早到晚) */
export function shiftStats(playDir: string, minMinutes = MIN_SHIFT_MINUTES): ShiftAgentStat[] {
  const out: ShiftAgentStat[] = [];
  /** 每个世界最近一个有产量读数的班 (算增量用) */
  const lastScience = new Map<string, number>();
  for (const id of listRuns(playDir)) {
    const dir = path.join(playDir, "runs", id);
    const s = readJson<Summary>(path.join(dir, "summary.json"));
    // 刚开就中断的班不计: 太短, 或大脑根本没动过 (调用不到 10 次; 老记录没 fpCalls 字段就不按这条过滤)
    if (!s || (s.realMinutes ?? 0) < minMinutes || (s.fpCalls !== undefined && s.fpCalls < 10)) continue;
    if (s.brain === "none" && !(s.lineup ?? []).some((x) => x.brain && x.brain !== "none")) continue; // 不叫大脑的验证班
    const world = worldOfRun(dir);
    const science = scienceOf(s);
    const prev = lastScience.get(world.id);
    const gain = science === null ? null : Math.round((science - (prev ?? 0)) * 100) / 100;
    if (science !== null) lastScience.set(world.id, science);
    const requests = loadShift(dir).requests;
    const agents = (s.agents ?? []).filter((a) => a && typeof a.id === "string");
    const totalTurns = agents.reduce((n, a) => n + (a.turns ?? 0), 0);
    const cost = typeof s.usage?.costUsd === "number" ? s.usage.costUsd : null;
    // 花费归实际花的角色 (2026-11-05: 第 5 班 Gpt 空转 186 轮一条命令没发, 按轮次份额被分到 $179; 实际 A $106 / B $81 / Gpt $0); 老记录没有逐轮数字才按轮次分
    const perAgent = new Map(agents.map((a) => [a.id, typeof a.costUsd === "number" ? a.costUsd : extrasOf(dir, a.id).cost]));
    const direct = [...perAgent.values()].reduce((n, c) => n + c, 0) > 0;
    for (const a of agents) {
      const rs = requests.filter((r) => (r.agent ?? "?") === a.id);
      const share = totalTurns > 0 ? (a.turns ?? 0) / totalTurns : agents.length ? 1 / agents.length : 0;
      const model = modelOfShiftAgent(dir, id, s, a.id);
      const use = extrasOf(dir, a.id).use;
      out.push({
        calc: use.calc, bp: use.bp, plan: use.plan, python: use.python, knowledge: use.pilotHelp + use.pilotReads, lessons: use.lessonsShown,
        run: id, world: world.id, worldName: world.name, agent: a.id, model, vendor: vendorOfModel(model),
        turns: a.turns ?? 0, requests: rs.length, reads: rs.filter((r) => READS.has(r.action)).length, builds: rs.filter((r) => BUILDS.has(r.action)).length, fails: rs.filter((r) => !r.ok).length,
        costUsd: cost === null ? null : Math.round((direct ? perAgent.get(a.id) ?? 0 : cost * share) * 100) / 100,
        realMinutes: s.realMinutes ?? 0, gameMinutes: s.gameMinutes ?? null,
        science, scienceGain: gain, idleShare: typeof s.idleShare === "number" ? s.idleShare : null,
      });
    }
  }
  return out;
}

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** 按模型汇总并排行 (每真实小时产量增量高的在前; 算不出的排最后) */
export function modelStats(shifts: ShiftAgentStat[]): ModelStat[] {
  const by = new Map<string, ShiftAgentStat[]>();
  for (const s of shifts) { const k = s.model ?? "未知"; by.set(k, [...(by.get(k) ?? []), s]); }
  const out: ModelStat[] = [];
  for (const [model, rows] of by) {
    const runs = new Set(rows.map((r) => r.run));
    // 时长、产量、增量按班算 (同一班的两个角色共享这一班的数字), 每班只算一次
    const perRun = [...runs].map((run) => rows.find((r) => r.run === run)!);
    const hours = perRun.reduce((n, r) => n + r.realMinutes, 0) / 60;
    const withScience = perRun.filter((r) => r.science !== null);
    const withGain = perRun.filter((r) => r.scienceGain !== null && r.realMinutes > 0);
    const gainHours = withGain.reduce((n, r) => n + r.realMinutes, 0) / 60;
    const costs = rows.filter((r) => r.costUsd !== null);
    const idle = perRun.filter((r) => r.idleShare !== null);
    const requests = rows.reduce((n, r) => n + r.requests, 0);
    const reads = rows.reduce((n, r) => n + r.reads, 0);
    const builds = rows.reduce((n, r) => n + r.builds, 0);
    out.push({
      model, vendor: rows[0].vendor, shifts: runs.size, agentShifts: rows.length, realHours: round(hours, 2),
      scienceAvg: withScience.length ? round(withScience.reduce((n, r) => n + r.science!, 0) / withScience.length) : null,
      gainPerHour: gainHours > 0 ? round(withGain.reduce((n, r) => n + r.scienceGain!, 0) / gainHours) : null,
      builds, buildsPerHour: hours > 0 ? round(builds / hours) : 0, requests, readShare: requests ? round(reads / requests, 2) : null,
      fails: rows.reduce((n, r) => n + r.fails, 0),
      costUsd: costs.length ? round(costs.reduce((n, r) => n + r.costUsd!, 0), 2) : null,
      costPerHour: costs.length && hours > 0 ? round(costs.reduce((n, r) => n + r.costUsd!, 0) / hours, 2) : null,
      idleShare: idle.length ? round(idle.reduce((n, r) => n + r.idleShare!, 0) / idle.length, 2) : null,
      calc: rows.reduce((n, r) => n + r.calc, 0), bp: rows.reduce((n, r) => n + r.bp, 0), plan: rows.reduce((n, r) => n + r.plan, 0), python: rows.reduce((n, r) => n + r.python, 0), knowledge: rows.reduce((n, r) => n + r.knowledge, 0), lessons: rows.reduce((n, r) => n + r.lessons, 0),
    });
  }
  return out.sort((a, b) => (b.gainPerHour ?? -Infinity) - (a.gainPerHour ?? -Infinity) || b.shifts - a.shifts);
}
