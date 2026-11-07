// 下一班阵容 (库, 不直接运行): 账号页里给每个角色选模型, 存 <lab-data>/accounts/lineup.json; run.ts 没给 --brains / --brain / --agents 时按它开班。
// : "这个中转不是给大脑用的啊。是给角色用。" → 模型是按角色分的 (一个角色一个模型, 游戏里角色名 = 模型),
// 中转站、DeepSeek、Grok、Claude 订阅都只是模型的来源; 所以选模型的地方是"阵容", 不在某一家的卡里。
import fs from "node:fs";
import path from "node:path";
import { KNOWN_BRAINS, MAX_AGENTS } from "./brains.ts";

/** 一个角色: brain = 哪家接的 (claude / grok / deepseek / relay / codex / none), model = 模型名 (空 = 这家的默认), effort = 思考强度 (空 = run.ts 的 --effort 默认) */
export type RosterSeat = { brain: string; model: string; effort?: string };
/** 强度档 (Claude Code --effort 的值, 2026-11-04 读 2.1.317 的 --help; Grok --reasoning-effort、Codex model_reasoning_effort 同名) */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** 上限同 brains.ts (26, 角色 id 一个字母) */
export const MAX_SEATS = MAX_AGENTS;

/** 一行阵容的清理: 家不认识 / 模型名有怪字符 → null */
export function cleanSeat(x: unknown): RosterSeat | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const brain = typeof r.brain === "string" ? r.brain.trim().toLowerCase() : "";
  const model = typeof r.model === "string" ? r.model.trim() : "";
  if (!KNOWN_BRAINS.includes(brain)) return null;
  if (model && !/^[\x21-\x7e]{1,120}$/.test(model)) return null;
  const effort = typeof r.effort === "string" ? r.effort.trim().toLowerCase() : "";
  if (effort && !EFFORTS.includes(effort)) return null;
  return effort ? { brain, model, effort } : { brain, model };
}

/** 读阵容文件; 没有 / 坏了 → [] (= 不用阵容, 按命令行默认) */
export function readRoster(file: string): RosterSeat[] {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    const seats = Array.isArray(o?.seats) ? o.seats : [];
    return seats.map(cleanSeat).filter((s: RosterSeat | null): s is RosterSeat => !!s).slice(0, MAX_SEATS);
  } catch { return []; }
}

/** 存阵容: 1~4 个角色, 每个都要合格 (不合格抛错, 文件不动); 空数组 = 删掉文件 (回到命令行默认) */
export function saveRoster(file: string, seats: unknown): RosterSeat[] {
  if (!Array.isArray(seats)) throw new Error("阵容要是一个数组");
  if (seats.length > MAX_SEATS) throw new Error(`最多 ${MAX_SEATS} 个角色`);
  const out: RosterSeat[] = [];
  for (const [i, x] of seats.entries()) {
    const s = cleanSeat(x);
    if (!s) throw new Error(`第 ${i + 1} 个角色不合格: 家要是 ${KNOWN_BRAINS.join(" / ")} 之一, 模型名不能有空格或中文`);
    out.push(s);
  }
  if (!out.length) { try { fs.unlinkSync(file); } catch { /* 本来就没有 */ } return out; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ seats: out }, null, 1));
  return out;
}

/** 阵容 → --brains 的写法: claude:opus,relay:glm-5.3@high (模型空就只写家, 用这家的默认; 强度用 @ 接在后面, 空就不写) */
export const rosterToBrains = (seats: RosterSeat[]): string => seats.map((s) => `${s.model ? `${s.brain}:${s.model}` : s.brain}${s.effort ? `@${s.effort}` : ""}`).join(",");
