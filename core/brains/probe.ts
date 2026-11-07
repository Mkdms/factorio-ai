#!/usr/bin/env node
// 一句试通 (脚本, 不开游戏, 花一点额度): npm run brains:probe -- [--brain claude|claude-api|deepseek|relay|codex|grok|gemini] [--model …] [--effort low]
// 在 data/play/probe/<时间>/ 建一个最小的角色目录 (和开班一样的 .claude/settings.json + 钩子标记 + CLAUDE.md), 让大脑跑一条 echo 再回 "收到":
// 看命令行能不能起、登录对不对、接口通不通、钩子装没装 (echo 不在 --allowedTools 里, 只有 permit 钩子放行才跑得了; post-tool 钩子会在 .context-state.json 记 hooksSeen; codex / gemini 没有钩子)。
// deepseek / relay 带强度参数不通且像参数错: 去掉再试一次 (只多 1 条请求)。
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT, dataRoot } from "../../game/sandbox/paths.ts";
import { brainDriver, brainProblem, defaultModel, looksLikeParamError, probeBrain } from "./driver.ts";
import { brainSettings, compactAt } from "./hooks/context.ts";

const { values } = parseArgs({ options: { brain: { type: "string", default: "claude" }, model: { type: "string" }, effort: { type: "string", default: "low" }, prompt: { type: "string" } } });
const brain = values.brain!;
const model = values.model ?? (brain === "claude" || brain === "claude-api" ? "claude-haiku-5-5" : defaultModel(brain));
const bad = brainProblem(brain, model);
if (bad || brain === "none") { console.error(bad ?? "--brain none 没什么可试的"); process.exit(2); }

const dir = path.join(dataRoot(), "play", "probe", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
const fwd = (p: string) => p.replace(/\\/g, "/");
const hookCmd = (event: string, ...extra: string[]) => [`'${fwd(process.execPath)}'`, `'${fwd(path.join(ROOT, "core", "brains", "hooks", "hook.ts"))}'`, event, ...extra].join(" ");
fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify(brainSettings(compactAt(model), hookCmd), null, 2));
fs.writeFileSync(path.join(dir, ".context-hooks"), "");
fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# 试通\n这是一次连通测试, 不是游戏。照提示词做, 别的什么都不用做。\n");
fs.writeFileSync(path.join(dir, "AGENTS.md"), "# 试通\n这是一次连通测试, 不是游戏。照提示词做, 别的什么都不用做。\n"); // Codex / Grok 读这个名字

const ALLOW = ["Bash(./fh *)", "Read", "Grep", "Glob"];
const log = (s: string) => console.log(s);
const open = (noEffort: boolean) => brainDriver({ brain, model, effort: values.effort!, allow: ALLOW, tools: ["Bash", "Read", "Grep", "Glob"], system: "回复用简体中文。", log, noEffort });
let driver = await open(false);
const prompt = values.prompt ?? "用 Bash 跑一条命令: echo 收到 ; 然后只回复两个字: 收到";
console.log(`试通 ${brain} ${model} (强度 ${values.effort}); ${driver.note}; 目录 ${dir}`);
let r = await probeBrain(driver, { cwd: dir, model, prompt, maxTurns: 3 });
let noEffort = false;
if (!r.ok && (brain === "deepseek" || brain === "relay") && looksLikeParamError(r.text)) {
  console.log(`带强度参数不通 (${r.text.slice(0, 120)}), 去掉再试一次`);
  await driver.close?.();
  driver = await open(true);
  noEffort = true;
  r = await probeBrain(driver, { cwd: dir, model, prompt, maxTurns: 3 });
}
await driver.close?.();
let hooksSeen: string | null = null;
try { hooksSeen = (JSON.parse(fs.readFileSync(path.join(dir, ".context-state.json"), "utf8")) as { hooksSeen?: string }).hooksSeen ?? null; } catch { /* 没跑工具 */ }
let permitted = false;
try { permitted = /"permitted"/.test(fs.readFileSync(path.join(dir, "context.log"), "utf8")); } catch { /* 没有钩子日志 */ }
const report = { brain, model, effort: noEffort ? "(接口不收, 没发)" : values.effort, note: driver.note, ok: r.ok, text: r.text, seconds: Math.round(r.ms / 100) / 10, costUsd: r.costUsd, hooksSeen, permitted, dir };
fs.writeFileSync(path.join(dir, "probe.json"), JSON.stringify(report, null, 1));
console.log(`${r.ok ? "通" : "不通"}: ${r.text || "(没有正文)"}; ${report.seconds} 秒${r.costUsd !== null ? `, $${r.costUsd.toFixed(4)}` : ""}; ${driver.normalize ? `事件经 ${driver.normalize} 翻译` : `钩子${hooksSeen ? "装上了 (post-tool 记了 hooksSeen)" : "没见到 post-tool"}, 命令放行${permitted ? "走了 permit 钩子" : "没经过 permit 钩子"}`}`);
if (!r.ok) { console.error(`详情看 ${dir}`); process.exit(1); }
