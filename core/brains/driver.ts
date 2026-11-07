// 大脑驱动 (库, 不直接运行; core/run/online.ts 用): 一轮 = 提示词进、Claude 形状的事件流出 (turn-N.jsonl); 会话号一轮轮接力; 跑一轮、杀掉、一句试通。
// 各家 (每家的来历和本机实测在它自己的文件头):
//   claude      Claude Code 订阅登录                                                  claude-code.ts
//   claude-api  Claude Console 密钥: Agent SDK 跑器 (node agent-sdk-runner.ts, 输出同形)   agent-sdk.ts
//   deepseek    Claude Code 指向 DeepSeek 的 Anthropic 兼容接口 (只换环境变量)              claude-code.ts ccEndpoint
//   relay       中转站: 站标 Claude 格式 → Claude Code 经本机代理; Responses 协议 → Codex 指向站   relay.ts
//   codex       OpenAI Codex 命令行 (事件翻译)                                         codex.ts
//   grok        Grok Build 命令行 (事件翻译)                                           grok.ts
//   gemini      Antigravity 命令行 (事件翻译; 本机账号地区不符, 搁置)                      gemini.ts
//   none        不叫模型
// 密钥都从 data/accounts/keys.json 读 (keys.ts), 不进命令行。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { ccArgs, ccEndpoint, ccEnv, claudeBin } from "./claude-code.ts";
import { consoleEnv, runnerArgs } from "./agent-sdk.ts";
import { codexExecArgs, codexLauncher, codexTranslator } from "./codex.ts";
import { grokArgs, grokBin, grokEnv, grokTranslator } from "./grok.ts";
import { agyArgs, agyLauncher, agyTranslator } from "./gemini.ts";
import { bypassLocalProxy, relayRoute, startRelayProxy } from "./relay.ts";
import { defaultKeysFile, readKeys, readRelayFormats, relayConfig } from "./keys.ts";
import { DEFAULT_MODELS } from "./lineup.ts";
import { withGitBash } from "../run/shell.ts";

export const BRAINS = ["none", "claude", "claude-api", "deepseek", "relay", "codex", "grok", "gemini"] as const;

export type Normalize = "codex" | "gemini" | "grok";
export type Driver = {
  bin: string;
  args: (n: number, sessionId: string, prompt: string) => string[];
  env: (e: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /** 事件不是 Claude 形状的: 用哪家的翻译 */
  normalize?: Normalize;
  /** 这家没有我们的命令白名单钩子 (hooks/permit.ts), 模型手里是整台电脑: 只能用在本机的图上, 联机前要补 */
  unguarded?: string;
  /** 走的哪条路 (日志用) */
  note: string;
  close?: () => Promise<void>;
};
export type BrainOpts = {
  brain: string; model: string; effort: string; allow: string[]; tools: string[]; system: string;
  keysFile?: string; log?: (s: string) => void;
  /** 试通查出接口不收强度参数 (deepseek / relay 的个别模型): 这一班不发 */
  noEffort?: boolean;
  /** Grok 开联网 (默认关) */
  web?: boolean;
};

/** DeepSeek 官方的 Anthropic 兼容接口 (api-docs.deepseek.com/quick_start/agent_integrations/claude_code, 2026-11-04 读) */
export const DEEPSEEK_ANTHROPIC_URL = "https://api.deepseek.com/anthropic";
/** 中转站的令牌给 Codex 用的环境变量名 (codexProviderArgs env_key) */
export const RELAY_KEY_ENV = "FA_RELAY_KEY";
const UNGUARDED = "没有命令白名单钩子, 模型手里是整台电脑 (只能在本机的图上用; 联机前要补)";

/** 没给 --model 时用哪个: 中转站用 keys.json 里选的 relay_model, 别家见 lineup.ts */
export function defaultModel(brain: string, keysFile = defaultKeysFile()): string {
  if (brain === "relay") return relayConfig(readKeys(keysFile)).model;
  return DEFAULT_MODELS[brain] ?? "";
}

/** 能不能开: 回原因, 能开回 null。开游戏之前查, 别进了世界才发现 */
export function brainProblem(brain: string, model: string): string | null {
  if (!(BRAINS as readonly string[]).includes(brain)) return `不认识的大脑 ${brain}, 只能是 ${BRAINS.join(" / ")}`;
  if (brain === "none" || brain === "gemini") return null; // gemini 不给模型 = 用账号的默认模型
  if (!model) return brain === "relay" ? "中转站没选模型: 给 --model <站里的模型名>, 或写进 keys.json 的 relay_model" : "要给 --model";
  return null;
}

/** Codex 的环境: Git Bash 在 PATH 上; 走订阅登录, 开发会话的 OPENAI_API_KEY 不混进去 */
const codexEnv = (e: NodeJS.ProcessEnv): NodeJS.ProcessEnv => { const env = { ...withGitBash(e) }; for (const k of Object.keys(env)) if (k.startsWith("OPENAI_API_KEY")) delete env[k]; return env; };

export async function brainDriver(o: BrainOpts): Promise<Driver> {
  const problem = brainProblem(o.brain, o.model);
  if (problem) throw new Error(problem);
  const keysFile = o.keysFile ?? defaultKeysFile();
  const cc = { model: o.model, effort: o.effort, allow: o.allow, tools: o.tools, system: o.system };
  switch (o.brain) {
    case "claude":
      return { bin: claudeBin(), args: ccArgs(cc), env: (e) => ccEnv(e), note: "Claude Code (订阅登录)" };
    case "claude-api": {
      const k = readKeys(keysFile);
      if (!k.anthropic) throw new Error(`Claude 的 Console 密钥没填: 写进 ${keysFile} 的 anthropic (用户级密钥 sk-ant-usr 还要 anthropic_workspace)`);
      const runner = path.join(import.meta.dirname, "agent-sdk-runner.ts");
      return {
        bin: process.execPath,
        args: (n, sessionId, prompt) => [runner, ...runnerArgs({ n, sessionId, prompt, model: o.model, effort: o.effort, allow: o.allow, tools: o.tools, appendSystemPrompt: o.system })],
        env: (e) => ({ ...ccEnv(e), ...consoleEnv(k.anthropic, k.anthropic_workspace) }),
        note: "Claude (Console API 密钥, Agent SDK 跑器; 按 token 扣 Console 的余额)",
      };
    }
    case "deepseek": {
      const key = readKeys(keysFile).deepseek;
      if (!key) throw new Error(`DeepSeek 密钥没填: 写进 ${keysFile} 的 deepseek`);
      return { bin: claudeBin(), args: ccArgs(cc), env: (e) => ({ ...ccEnv(e), ...ccEndpoint(DEEPSEEK_ANTHROPIC_URL, key, o.model, "deepseek-flash", { effort: !o.noEffort }) }), note: "DeepSeek (Claude Code 指向它的 Anthropic 兼容接口)" };
    }
    case "relay": {
      const { url, key } = relayConfig(readKeys(keysFile));
      if (!url || !key) throw new Error(`中转站没配好: 写进 ${keysFile} 的 relay_url (站点) 和 relay (令牌)`);
      const r = relayRoute(o.model, readRelayFormats(keysFile)[o.model]);
      if (r.route === "none") throw new Error(`中转站模型 ${o.model} 用不了: ${r.why}`);
      o.log?.(`中转站 ${o.model}: ${r.why}`);
      if (r.route === "codex") {
        const l = codexLauncher();
        return {
          bin: l.bin,
          args: (n, sessionId, prompt) => [...l.args, ...codexExecArgs({ n, threadId: sessionId, prompt, model: o.model, effort: o.effort, provider: { id: "relay", baseUrl: `${url}/v1`, envKey: RELAY_KEY_ENV } })],
          env: (e) => ({ ...codexEnv(e), [RELAY_KEY_ENV]: key }),
          normalize: "codex", unguarded: UNGUARDED, note: `中转站 (${r.why}; Codex 命令行指向站)`,
        };
      }
      const proxy = await startRelayProxy(url, { log: o.log });
      o.log?.(`中转站本机代理 ${proxy.url} → ${proxy.target} (去掉请求里的 metadata 字段, 其余原样)`);
      return {
        bin: claudeBin(), args: ccArgs(cc),
        env: (e) => ({ ...ccEnv(e), ...ccEndpoint(proxy.url, key, o.model, o.model, { effort: !o.noEffort }), ...bypassLocalProxy(e) }),
        close: () => proxy.close(), note: `中转站 (${r.why}; Claude Code 经本机代理)`,
      };
    }
    case "codex": {
      const l = codexLauncher();
      return { bin: l.bin, args: (n, sessionId, prompt) => [...l.args, ...codexExecArgs({ n, threadId: sessionId, prompt, model: o.model, effort: o.effort })], env: codexEnv, normalize: "codex", unguarded: UNGUARDED, note: "OpenAI Codex 命令行 (ChatGPT 订阅登录)" };
    }
    case "grok":
      return { bin: grokBin(), args: (n, sessionId, prompt) => grokArgs({ n, sessionId, prompt, model: o.model, effort: o.effort, allow: o.allow, web: !!o.web }), env: (e) => grokEnv(e, !!o.web), normalize: "grok", note: "Grok Build 命令行 (grok login 登录)" };
    case "gemini": {
      const l = agyLauncher();
      return {
        bin: l.bin, args: (n, sessionId, prompt) => [...l.args, ...agyArgs({ n, conversationId: sessionId, prompt, model: o.model, effort: o.effort })],
        env: (e) => { const env = { ...e }; for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"]) delete env[k]; return env; }, // 有密钥它会走 API 计费而不是订阅
        normalize: "gemini", unguarded: UNGUARDED, note: "Gemini (Antigravity 命令行, Google 账号登录)",
      };
    }
    default:
      throw new Error(`大脑 ${o.brain} 不用驱动`);
  }
}

/** 事件翻译: 一行原始输出 → 零到多个 Claude 形状的事件; sessionId = 那家自己发的会话号 (Codex / Antigravity 第一轮才给, 我们生成的它们不认; Grok 认我们的, 回 null) */
export type Translator = { line: (l: string) => unknown[]; sessionId: () => string | null };
export const translators: Record<Normalize, (model: string) => Translator> = { codex: codexTranslator, grok: () => grokTranslator(), gemini: agyTranslator };

/**
 * 跑一轮, 输出写进 runDir/turn-N.jsonl (要翻译的: 原始行另存 -raw, 日志是 Claude 形状)。回退出码和下一轮要用的会话号。
 * 命令行没装不抛错, 当这一轮失败 (brain-stderr.txt 里有原因)。
 */
export function runBrainTurn(d: Driver, o: { n: number; sessionId: string; prompt: string; cwd: string; runDir: string; model: string; onChild?: (c: ChildProcess | null) => void; onEvent?: (ev: unknown) => void }): Promise<{ code: number; sessionId: string }> {
  const file = path.join(o.runDir, `turn-${o.n}.jsonl`);
  const out = fs.createWriteStream(file);
  const tr = d.normalize ? translators[d.normalize](o.model) : null;
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

/** 这段报错像是接口不认参数 (只有这种才值得去掉强度参数再试一次; 旧项目 2026-11-05 中转站的个别模型) */
export const looksLikeParamError = (text: string): boolean => /\b400\b|unsupported|unknown (field|param)|extra (input|field)|invalid.*(param|field|effort)|output_config|effort/i.test(text);

/**
 * 一句试通: 在 cwd 里跑一轮 "只回复两个字: 收到", 看命令行能不能起、登录对不对、接口通不通 (花一点额度)。
 * stdin 要关 (和轮次一样): Codex 看到 stdin 是管道会等它读完, 90 秒被杀报假警报。Grok 的 result 不带正文, 正文在 assistant 事件里: 两个都看。
 */
export function probeBrain(d: Driver, o: { cwd: string; model: string; prompt?: string; timeoutMs?: number; /** Claude Code 的 --max-turns (默认 1; 提示词里要跑工具的给 3) */ maxTurns?: number }): Promise<{ ok: boolean; text: string; ms: number; costUsd: number | null }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let env: NodeJS.ProcessEnv;
    try { env = d.env(process.env); } catch (e) { return resolve({ ok: false, text: (e as Error).message, ms: 0, costUsd: null }); }
    const tr = d.normalize ? translators[d.normalize](o.model) : null;
    const base = d.args(1, randomUUID(), o.prompt ?? "只回复两个字: 收到");
    const args = d.normalize ? base : [...base, "--max-turns", String(o.maxTurns ?? 1)]; // --max-turns 是 Claude Code 的参数 (Agent SDK 跑器也认)
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
