// 大脑驱动 (库, 不直接运行; core/run/online.ts 用): 一轮 = 提示词进、Claude 形状的事件流出 (turn-N.jsonl); 会话号一轮轮接力; 跑一轮、杀掉、一句试通。
// 第二块第 ① 步只有 claude (订阅) 和 none (不叫模型); 别家 (claude-api / deepseek / relay / codex / grok / gemini) 第 ③ 步搬进来, 事件要翻译的 (codex / grok / gemini) 在 translators 里登记。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { ccArgs, ccEnv, claudeBin } from "./claude-code.ts";

export const BRAINS = ["none", "claude"] as const;
/** 旧项目有、还没搬进来的 */
export const BRAINS_LATER = ["claude-api", "deepseek", "relay", "codex", "grok", "gemini"] as const;

export type Normalize = "codex" | "gemini" | "grok";
export type Driver = {
  bin: string;
  args: (n: number, sessionId: string, prompt: string) => string[];
  env: (e: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /** 事件不是 Claude 形状的: 用哪家的翻译 */
  normalize?: Normalize;
  close?: () => Promise<void>;
};
export type BrainOpts = { brain: string; model: string; effort: string; allow: string[]; tools: string[]; system: string; keysFile?: string; log?: (s: string) => void };

/** 没给 --model 时用哪个 */
export function defaultModel(brain: string): string {
  return brain === "claude" ? "opus" : "";
}

/** 能不能开: 回原因, 能开回 null。开游戏之前查, 别进了世界才发现 */
export function brainProblem(brain: string, model: string): string | null {
  if ((BRAINS_LATER as readonly string[]).includes(brain)) return `大脑 ${brain} 还没搬进来 (第二块第 ③ 步), 现在只有 ${BRAINS.join(" / ")}`;
  if (!(BRAINS as readonly string[]).includes(brain)) return `不认识的大脑 ${brain}, 只能是 ${BRAINS.join(" / ")}`;
  if (brain !== "none" && !model) return "要给 --model";
  return null;
}

export async function brainDriver(o: BrainOpts): Promise<Driver> {
  const problem = brainProblem(o.brain, o.model);
  if (problem) throw new Error(problem);
  switch (o.brain) {
    case "claude":
      return { bin: claudeBin(), args: ccArgs(o), env: (e) => ccEnv(e) };
    default:
      throw new Error(`大脑 ${o.brain} 不用驱动`);
  }
}

/** 事件翻译: 一行原始输出 → 零到多个 Claude 形状的事件; 第 ③ 步登记 codex / grok / gemini */
export type Translator = { line: (l: string) => unknown[]; sessionId: () => string | null };
export const translators: Partial<Record<Normalize, (model: string) => Translator>> = {};

/**
 * 跑一轮, 输出写进 runDir/turn-N.jsonl (要翻译的: 原始行另存 -raw, 日志是 Claude 形状)。回退出码和下一轮要用的会话号
 * (Codex / Antigravity 第一轮才给 id, 我们生成的它们不认)。命令行没装不抛错, 当这一轮失败 (brain-stderr.txt 里有原因)。
 */
export function runBrainTurn(d: Driver, o: { n: number; sessionId: string; prompt: string; cwd: string; runDir: string; model: string; onChild?: (c: ChildProcess | null) => void; onEvent?: (ev: unknown) => void }): Promise<{ code: number; sessionId: string }> {
  const file = path.join(o.runDir, `turn-${o.n}.jsonl`);
  const out = fs.createWriteStream(file);
  const tr = d.normalize ? translators[d.normalize]?.(o.model) ?? null : null;
  if (d.normalize && !tr) throw new Error(`${d.normalize} 的事件翻译还没搬进来`);
  const raw = tr ? fs.createWriteStream(file.replace(/\.jsonl$/, "-raw.jsonl")) : null;
  return new Promise((resolve) => {
    const c = spawn(d.bin, d.args(o.n, o.sessionId, o.prompt), { cwd: o.cwd, env: d.env(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    o.onChild?.(c);
    let buf = "";
    c.stdout!.on("data", (x: Buffer) => {
      if (tr) raw!.write(x); else out.write(x);
      buf += x.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (tr) { for (const ev of tr.line(line)) { out.write(`${JSON.stringify(ev)}\n`); o.onEvent?.(ev); } continue; }
        if (o.onEvent) { try { o.onEvent(JSON.parse(line)); } catch { /* 不是整行 JSON */ } }
      }
    });
    c.stderr!.on("data", (x: Buffer) => fs.appendFileSync(path.join(o.runDir, "brain-stderr.txt"), x));
    c.on("error", (e) => { fs.appendFileSync(path.join(o.runDir, "brain-stderr.txt"), `起不来: ${e.message}\n`); });
    c.on("close", (code) => {
      o.onChild?.(null);
      out.end(); raw?.end();
      resolve({ code: code ?? -1, sessionId: tr?.sessionId() ?? o.sessionId });
    });
  });
}

/** 连子进程一起杀: Windows 上 child.kill 只杀命令行自己, 模型正在跑的 ./fh sleep 300 还活着, 占着管道让收尾卡住 (旧项目 2026-11-06 真服查出) */
export function killBrain(c: ChildProcess | null): void {
  if (!c?.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }); else c.kill();
}

/** 大脑输出的一行 Claude 形状事件里的正文 / 结果 */
export function noteEvent(ev: unknown, acc: { result: Record<string, unknown> | null; said: string }): void {
  const m = ev as { type?: string; message?: { content?: { type?: string; text?: string }[] } } | null;
  if (m?.type === "result") acc.result = m as Record<string, unknown>;
  else if (m?.type === "assistant") for (const b of m.message?.content ?? []) if (b?.type === "text" && b.text) acc.said = b.text;
}

/**
 * 一句试通: 在 cwd 里跑一轮 "只回复两个字: 收到", 看命令行能不能起、登录对不对、接口通不通 (花一点额度)。
 * stdin 要关 (和轮次一样): Codex 看到 stdin 是管道会等它读完, 90 秒被杀报假警报。
 */
export function probeBrain(d: Driver, o: { cwd: string; model: string; prompt?: string; timeoutMs?: number; /** Claude Code 的 --max-turns (默认 1; 提示词里要跑工具的给 3) */ maxTurns?: number }): Promise<{ ok: boolean; text: string; ms: number; costUsd: number | null }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let env: NodeJS.ProcessEnv;
    try { env = d.env(process.env); } catch (e) { return resolve({ ok: false, text: (e as Error).message, ms: 0, costUsd: null }); }
    const tr = d.normalize ? translators[d.normalize]?.(o.model) ?? null : null;
    const base = d.args(1, randomUUID(), o.prompt ?? "只回复两个字: 收到");
    const args = d.normalize ? base : [...base, "--max-turns", String(o.maxTurns ?? 1)]; // --max-turns 是 Claude Code 的参数
    const c = spawn(d.bin, args, { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    c.stdout.on("data", (x) => { out += x; });
    c.stderr.on("data", (x) => { out += x; });
    const timer = setTimeout(() => { killBrain(c); resolve({ ok: false, text: `${Math.round((o.timeoutMs ?? 90_000) / 1000)} 秒没回 (杀掉)`, ms: Date.now() - t0, costUsd: null }); }, o.timeoutMs ?? 90_000);
    c.on("error", (e) => { out += `起不来: ${e.message}\n`; });
    c.on("close", (code) => {
      clearTimeout(timer);
      const acc = { result: null as Record<string, unknown> | null, said: "" };
      for (const line of out.split(/\r?\n/)) {
        if (tr) { for (const ev of tr.line(line)) noteEvent(ev, acc); continue; }
        try { noteEvent(JSON.parse(line), acc); } catch { /* 不是 JSON 行 */ }
      }
      const text = String(acc.result?.result || acc.said || (acc.result ? "" : out)).replace(/\s+/g, " ").slice(0, 400);
      const cost = typeof acc.result?.total_cost_usd === "number" ? (acc.result.total_cost_usd as number) : null;
      resolve({ ok: code === 0 && !!acc.result && !acc.result.is_error, text, ms: Date.now() - t0, costUsd: cost });
    });
  });
}
