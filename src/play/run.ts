#!/usr/bin/env node
// 大脑链路第 4 步 (docs/brain-run.md): 让 Claude 从空手开局玩到自动化红瓶。
// 沙盘服务器 (io-lab + agent-harness) + 游戏窗口 (连着的玩家 = 大脑的角色, 用户看着) + Claude Code (`claude -p`, 用订阅登录)。
// 大脑目录在 I:\fn 之外 (Claude Code 会往上找 CLAUDE.md, 不能读到开发规则和私人规则); 只开文件工具和 Bash(./fp *), 不接 MCP、不读用户设置。
// 每次 claude -p 结束 (大脑这一轮做完) 就带着最新事实叫它继续, 直到达标或到截止。后台每 30 秒记一次指标。
//   npm run play:run [-- --minutes 180 --model opus --effort medium --seed 7]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { LabInstance } from "../lab/instance.ts";
import { ViewerClient } from "../lab/viewer.ts";
import { labRoot, REPO } from "../lab/gamedir.ts";
import { Harness, luaString } from "./harness.ts";
import type { Session } from "./fp.ts";
import { modelDisplayName } from "./model-name.ts";
import { lineup, DEFAULT_MODELS } from "./brains.ts";
import { grokArgs, grokEnv } from "./grok-args.ts";
import { formatCompact } from "./format.ts";
import { reviewBase } from "./review.ts";
import { brainSettings, compactAt, COMPACT_INSTRUCTIONS } from "./context.ts";
import { parseRateLimit, probeQuota, readPlanUsage, describeQuota, maxUtilization, type Quota } from "./quota.ts";
import { worldForNewRun, writeWorld, setHidden } from "./worlds.ts";
import { ClaudeStream, STREAM_ARGS } from "./claude-stream.ts";
import { EnglishWatch } from "./lang.ts";
import { labLine, ratesFrom, ratesLine } from "./science.ts";
import { loadShift, reviewShift, reviewNotes, reviewMarkdown } from "./review-shift.ts";
import { briefPoints, calcReminderDue } from "./knowledge-use.ts";
import { grokState, normalizeGrokLine } from "./grok-events.ts";
import { argvFilePs1 as argvFilePs1Text, calcPs1 as calcPs1Text } from "./ps1-wrap.ts";
import { defaultKeysFile, readKeys, readRelayFormats, relayConfig } from "./accounts.ts";
import { bashExe, withGitBash } from "./shell.ts";
import { workSinceFile } from "./turn-activity.ts";
import { MILESTONE_LUA, dueMilestones, normalizeMilestone } from "./milestones.ts";
import { readRoster, rosterToBrains } from "./roster.ts";
import { readGroup, groupStartProblem, groupWorld, latestRunOfGroup, noBrainRequested, setPeacefulMinutes } from "./groups.ts";
import { beginPeace, makePeace, minutesLeft, peaceActive, peaceLeftMs, peaceText, peaceTick } from "./peace.ts";
import { OBSERVER_LUA, OBSERVER_NAME, handoverText, normalizeHandover } from "./observer.ts";
import { currentFacts, factsFromHealth, delta, shiftHauls, haulLine, digestText, list, type Claim, type Fact, type HaulAgent, type Report } from "./digest.ts";
import { HEALTH_LUA, healthLines, normalizeHealth, StuckHealth, healthCategory, healthOwner, type Health } from "./health.ts";
import { BOT_LABEL_LUA } from "./botlabel.ts";
import { loadZhNames } from "./chattags.ts";
import { newWatchState, observe, recovered, recoverLab, downtimeMs, type RecoverResult } from "./watchdog.ts";
import { RESEARCH_LUA, normalizeResearch, pickResearch, triggerText } from "./research.ts";
import { writeCurrentRun } from "./shift-recover.ts";
import { propose, normalizeExisting, EXISTING_LUA, type Rung } from "./expand.ts";
import { SCAN_LUA, composeScan, normalizeScan } from "./world-scan.ts";
import { AlertDedupe, appendAlert, isApiFailure } from "./alerts.ts";
import { loadGameData, type GameData } from "../calc/data.ts";
import { copyTools, ensureGamedata, setupFullTools, setupPartyWorkspace, journalToRequests, haulCounts, PARTY_NOTES } from "./partykit.ts";
import { defaultDumpPath } from "../blueprint/rules.ts";
import { hintLine, hintsForLines } from "./hints.ts";
import { entries as bpEntries, listLines as bpListLines } from "./bp.ts";
import { placementSteps, siteLua } from "./plan-lib.ts";
import { appendLearned, describeActions, learnedSeeds, loadSeeds, mergeNotesLessons, nameIndex, seedLessons, type MergeResult, type Seed, type SeedResult } from "./lessons.ts";
import { LAYOUT_LUA, atKey, edgeKey, freshItems, labNote, layoutNote, normalizeLayout, stuckNote } from "./layout-lint.ts";
import { mentionNudges, newMentionState, readTells, unansweredTells, type MentionCount } from "./replies.ts";
import { chunks, isUrgent, markEnd, mentioned, parseChatLine, readNewLines, tellText } from "./human-chat.ts";
import { ccEnv, ccEndpoint } from "./cc-env.ts";
import { bypassLocalProxy, startRelayProxy } from "./relay-proxy.ts";
import { relayRoute } from "./relay-route.ts";
import { consoleEnv, runnerArgs } from "./agent-sdk.ts";
import { codexExecArgs, codexLauncher, codexState, normalizeCodexLine } from "./codex-events.ts";
import { agyArgs, agyLauncher, agyState, normalizeAgyLine } from "./antigravity-events.ts";
import { BELT_JOGS_LUA, jogNote, newJogs, normalizeJogs } from "./belt-lint.ts";
import { TOOL_POLL, oursBrief, toolRequests } from "./ours-brief.ts";
import { ROSTER_FILE as ROSTER_OPS, isSafeBotName, nextAgentId, normalizeSalvage, nthBotName, readRosterOps, salvageLua, salvageText, type RosterOp } from "./roster-live.ts";

const { values } = parseArgs({ options: {
  minutes: { type: "string", default: "180" }, model: { type: "string", default: "opus" }, effort: { type: "string", default: "low" }, // 派对 9 个里 7 个 low、2 个 medium (agent/team-nine.tsv): 思考时角色站着, 想久了亏 (2026-11-05 对源码时改; 原来 medium)
  seed: { type: "string", default: "7" }, linger: { type: "string", default: "60" }, goalMinutes: { type: "string" }, dry: { type: "boolean", default: false },
  goal: { type: "string", default: "red" }, save: { type: "string" }, notes: { type: "string" }, brain: { type: "string", default: "claude" },
  mod: { type: "string", default: "agent-harness" }, // agent-harness-party = factorio-ai-party 的分支版
  kit: { type: "string", default: "fp" }, // party = factorio-ai-party 整套代理配置 (简报 + 参考手册 + ./fh), 要 --mod agent-harness-party 和 .env 的 PARTY_REPO
  agents: { type: "string", default: "1" }, // 几个角色同时玩 (第 2 个起是分支版 harness 的服务器角色 bot); 先 2 个试一轮
  brains: { type: "string" }, // 一个角色一个大脑: --brains claude,grok,deepseek (个数就是角色数; src/play/brains.ts);
  // 换班不关游戏 (src/play/live-shift.ts): --keep-game 班末只存档不关服务器和窗口 (点了停班 / STOP_AFTER / 额度用完 / 看门狗放弃还是关); --attach 开班接上在跑的游戏 (接不上就照 --save 正常开)
  "keep-game": { type: "boolean", default: false }, attach: { type: "boolean", default: false },
  "keep-bots": { type: "boolean", default: false }, // 开班时不收回前几班留下、不在这班名单里的服务器角色 (默认收回)
  enemies: { type: "boolean", default: false }, // 关和平, 虫子真的来打 (群文件 peaceful: false 同样效果)
  "peace-minutes": { type: "string" }, // 有虫子的世界开班先留几分钟和平, 到点自动关 (群文件 peacefulMinutes 同样效果; src/play/peace.ts)
  "with-fp": { type: "boolean", default: false }, // 沙盘加装补丁版 Factory Planner, ./calc 自动对照 (真服装不了, ./calc 已和它对过 0% 差)
  group: { type: "string" }, // 界面里的群 (= 对话 = 世界; src/play/groups.ts): 世界 id / 名字就是这个群, 没给 --brains 时名单 = 群成员
  quotaMax: { type: "string", default: "0.9" }, force: { type: "boolean", default: false }, // 开跑前最紧的额度窗口已用到这个比例就不开 (--force 强开)
  speed: { type: "string", default: "1" }, // 游戏倍速 (联机只能 1 倍)
  compactAt: { type: "string" }, // 大脑上下文到多少 token 压缩 (默认按模型: Opus 25 万, 派对 agent/context.tsv)
  // 常驻会话: claude 进程一直开着, 每轮写一条消息; 监工的插话进正在跑的一轮,
  // 出错隔离 / 闲 10 分钟不再杀进程重开。只有 claude; 默认关, 实跑核过再改成默认
  stream: { type: "boolean", default: false },
} });
// 目标: red = 第一轮 (机器红瓶连续研究 10 分钟); belts = 第二轮 (原料全走传送带和机械臂、角色不往机器里放东西, 连续 30 分钟)
// grow = 第三轮 (开放式扩产, 没有终点, 跑到截止; 对齐 factorio-ai-party 的开放目标 + 监工)
const SPEED = Math.max(0.1, Math.min(10, Number(values.speed) || 1));
// --goal 没给时派对配置 (--kit party) 默认 grow (开放式, 跑到截止): 2026-11-04 17:36 那班没给 --goal, 第 26 分钟 "红瓶连续研究 10 分钟" 达标把 4 个大脑全杀了收尾, 用户要的是 60 分钟
const goalGiven = process.argv.some((a) => /^--goal(=|$)/.test(a));
const GOAL = values.goal === "belts" ? "belts" : values.goal === "grow" || (!goalGiven && values.kit === "party") ? "grow" : "red";
const goalMinutes = Number(values.goalMinutes ?? (GOAL === "belts" ? 30 : 10));
const t0 = Date.now();
const deadline = t0 + Number(values.minutes) * 60_000;
const log = (s: string) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} 分] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 默认不装 Factory Planner: 模组进不了真服, 模型用的 ./calc 不靠它, 结果和它对过 (docs/calc.md 18 条配方 0% 差); --with-fp 才装, ./calc 经它的 remote 接口自动对照 (src/calc/fp-live.ts)
const MODS = [values.mod!, ...(values["with-fp"] && fs.existsSync(path.join(REPO, "mods", "factoryplanner", "info.json")) ? ["factoryplanner"] : [])];
const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(labRoot(), "play", "runs", runId);
const brainDir = path.join(process.env.BRAIN_DIR ?? path.join(os.homedir(), "factorio-pilot-brain"), runId);
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(brainDir, { recursive: true });
// 这一班属于哪个世界 (界面按世界分对话; src/play/worlds.ts): 新地图新世界, 接着存档跑就继承那一班的; 界面里按群开的 (--group) 世界就是那个群
const GROUP = values.group ? readGroup(path.join(labRoot(), "play"), values.group) : null;
if (values.group && !GROUP) throw new Error(`没有这个群: ${values.group} (界面里"新建对话"建的, 在 lab-data/play/groups/)`);
if (GROUP) { const problem = groupStartProblem(GROUP, values.save, latestRunOfGroup(path.join(labRoot(), "play"), GROUP.id)); if (problem) { fs.rmdirSync(runDir); throw new Error(problem); } }
/** 这个世界开不开和平: 群文件 peaceful: false 就关 (虫子真的来打); 简报按这个写, 不写死 (2026-11-05 简报写死"和平模式, 不研究军事类科技", 模型照做) */
const PEACEFUL = GROUP?.peaceful !== false && !values.enemies;
/** 有虫子的世界开班先留的和平 (src/play/peace.ts): 世界设成有虫子, 这段时间还开着和平 */
const PEACE = makePeace(PEACEFUL ? 0 : Number(values["peace-minutes"] ?? GROUP?.peacefulMinutes ?? 0));
{ const { world, backfill } = GROUP ? { world: groupWorld(GROUP), backfill: null } : worldForNewRun(runId, values.save); writeWorld(runDir, world); if (backfill) writeWorld(backfill, world); }
/** 中转站 (relay): 站点 / 令牌在账号页填进 keys.json; relay_model (若有) 当 relay 没指定模型时的默认 */
const RELAY = relayConfig(readKeys(defaultKeysFile()));
// 界面账号页存的"下一班阵容": 命令行没给 --brains / --brain / --agents 时按它; 给了命令行优先
const ROSTER_FILE = path.join(labRoot(), "accounts", "lineup.json");
// 按群开的班名单永远读群文件: 界面开班时 startArgs 把 --brains 写进了连班的启动参数, 每班都一样, 用户在界面改的"下一班名单"一直不生效 (2026-11-05 查出)
// 例外: 命令行明确说不叫大脑, 永远听它 (noBrainRequested)
const ROSTER = noBrainRequested(process.argv) ? [] : GROUP?.seats.length ? GROUP.seats : process.argv.some((a) => /^--(brains?|agents)(=|$)/.test(a)) || GROUP ? [] : readRoster(ROSTER_FILE);
if (ROSTER.length) values.brains = rosterToBrains(ROSTER);
/** 角色阵容: 每个角色的大脑 / 模型 / 游戏里的名字 (--brains 一人一个大脑, 每项可带模型 家:模型; 不给就都用 --brain; src/play/brains.ts) */
// 派对配置: 全部角色都是服务器角色, 窗口只看 (src/play/observer.ts)
const ALL_BOTS = values.kit === "party";
const LINEUP = lineup({ brain: values.brain!, model: values.model!, brains: values.brains, agents: values.agents, allBots: ALL_BOTS }, { ...DEFAULT_MODELS, ...(RELAY.model ? { relay: RELAY.model } : {}) });
values.model = LINEUP[0].model; // 主大脑没指定 --model 时的默认 (grok-4.7 / deepseek-flash[1m] / 中转站里选的)
if (ROSTER.length) console.log(`阵容来自${GROUP ? `群 "${GROUP.name}" 的成员` : `界面账号页 (${ROSTER_FILE})`}: ${values.brains}; 要用命令行的就给 --brains / --brain / --agents`);
if (LINEUP.every((s) => s.brain === "none")) setHidden(runDir, true); // 不叫大脑的验证班 (看门狗 / 窗口): 界面里直接收起, 统计表也不算 (fpCalls < 10)
// 中转站本机代理 (src/play/relay-proxy.ts): 阵容里有走中转站的角色就在本进程起一个, 走中转的 Claude Code 都指向它,
// 它去掉请求里的 metadata 字段 (GPT 渠道上游不收) 再经系统代理转给站; 班末关掉并记转发次数
// 中转站按站标的协议分流 (2026-11-04 晚站长 "去模型广场看看这些模型都是什么协议的"; src/play/relay-route.ts): Claude 格式 → Claude Code (经代理), Responses → Codex 指向站, 只有 Chat → 开不了班
const RELAY_FORMATS = readRelayFormats(defaultKeysFile());
for (const s of LINEUP) if (s.brain === "relay") {
  const r = relayRoute(s.model, RELAY_FORMATS[s.model]);
  if (r.route === "none") throw new Error(`中转站模型 ${s.model} 用不了: ${r.why}; 换一个站里标了 Claude 格式或 Responses 协议的模型 (账号页中转站卡会分组列出)`);
  console.log(`中转站 ${s.model}: ${r.why}`);
}
const RELAY_PROXY = LINEUP.some((s) => s.brain === "relay" && relayRoute(s.model, RELAY_FORMATS[s.model]).route === "claude") && RELAY.url ? await startRelayProxy(RELAY.url, { log }) : null;
if (RELAY_PROXY) log(`中转站本机代理: ${RELAY_PROXY.url} → ${RELAY_PROXY.target} (去掉请求里的 metadata 字段, 其余原样)`);
const fwd = (p: string) => p.replaceAll("\\", "/");

const GROW_GOAL = `接着上一班的基地干 (上一班的笔记在 notes.md)。这一班的目标是 **持续扩大科研产能, 没有终点**: 先把自动化科技包（红瓶）提到每分钟 ≥ 30 个 (全部机器做、原料走传送带), 再把物流科技包（绿瓶）也自动化, 之后做你判断最该做的。**红瓶 + 绿瓶能研究的科技做完以后 (第七轮已做完), 下一个目标是化工科技包（蓝瓶）自动化**: 石油 (抽油机 → 炼油厂) → 石油气 → 塑料 / 硫 → 高级电路板 + 引擎 → 蓝瓶, 用计算器算配比。**这些数只是起点, 不是终点**: 达到了就把目标翻倍, 同时为下一阶段做准备 (燃料和矿能不能长期供上、钢、石油和化工科技包（蓝瓶）); 截止之前不要以"目标达到了"结束这一轮 (第六轮报完"达到了"就收工, 还剩 20 分钟)。**不要停下来干等**: 角色闲着就是浪费, 闲了就去扩产、修瓶颈、备料; 监工看到角色闲着会打断你并告诉你瓶颈在哪。`;
const TOOLS = `
## 工具 (除了 ./fp)
- \`./fp bottleneck '{"area":{"left_top":{"x":..,"y":..},"right_bottom":{"x":..,"y":..}}}'\`: 哪台机器缺什么、哪个机械臂太慢; \`./fp rates\` 同样的区域: 每分钟产 / 耗。
- \`./calc '{"targets":{"automation-science-pack":30},"recipes":{"automation-science-pack":{"machine":"assembling-machine-1"},"iron-gear-wheel":{"machine":"assembling-machine-1"},"iron-plate":{"machine":"stone-furnace"},"copper-plate":{"machine":"stone-furnace"}}}'\`: 按目标产量算每个配方要几台、吃多少 (没列的配方当作从外面进)。
- **建之前先清场**: \`./fp build\` / \`./fp place_ghosts\` 加 \`"clear_obstacles": true\` → 先把占地范围里的树和石头标成拆除、亲手砍掉, 清完再建; 贴蓝图后 \`construct\` 会顺手砍掉虚影下面的。各星球的树、石头、废墟、冰山、叠层石它都认 (2.1.24 沙盘实测); **悬崖砍不掉**, 要悬崖炸药 (\`clear_cliffs\`)。
- **建完查通不通**: \`./fp belt_gaps '{"line":{"x":..,"y":..}}'\` (给一条带子的任意一格, 前后整条查) 或 \`{"from":..,"to":..}\`; 每建完一条带子都查一次; 带子上有没有货、货到哪去了用 \`./fp trace '{"position":{..}}'\`。第六轮停电不是带子断了 (中间是地下带, 整条是通的), 是**送煤带那头的煤矿采完了, 带子是空的**, 没人发现: 主要的矿 (尤其是锅炉用的煤) 隔一阵 \`trace\` 看一眼带子上有没有货。
- **蓝图库只作参考**: \`./bp list 关键词\` 找现成的块 (冶炼列、组装机排, 带沙盘实测产量; 社区 CC0 蓝图), \`./bp show 编号\` 看要哪些物品、多大, 备好料后 **\`./bp build 编号 --at x,y [--dir east]\`** —— 一条命令: 查材料 → 整片清场 (占地外加 2 格的树石全砍) → 贴虚影 → 角色亲手建完 → 回报剩多少虚影、缺什么 (2026-11-03 沙盘实测: 16 炉冶炼列 114 个实体一次建完)。建什么、放哪你定; 你只管选块、选位置、接料。比一格一格 build 快得多, 而且排得整齐。
- **自己的块存起来复制** (派对的做法: 手搭一次跑通, 存进队伍蓝图库, 以后整块复制): 跑通的一块用 \`./fp blueprint_save '{"name":"..","area":{..}}'\` 存, 以后 \`./fp blueprint_place\` 或 paste 复制。
- **排进队列就等, 别反复查**: \`queue_submit\` 后用 \`--wait\` 或一条 \`wait_until\` 等它做完 (第六轮 queue_status 查了 312 次, 每查一次就是一个回合, 角色还是站着)。
`;
// 老玩家的开局路线: 直接写进简报 (第三轮实测: 写成"需要时查", 93 条命令里知识库、计算器、蓝图一次都没用)
const OPENING = `
## 老玩家的开局路线 (知识库 P-prog-01: B 站专栏、官方论坛的老玩家总结; 数字是沙盘核实过的)
1. 电 + 红瓶段: 研究电力采矿机; 冶炼按"48 个石炉 = 一条基础传送带的铁板"的规模建, 不要一个个炉子往上加。
2. 冶炼列可参考蓝图库 (先 ./calc 算要多少, 库里的块合适就用, 不合适照思路自己搭): \`./bp list 冶炼\` → \`./bp show 编号\` 看要哪些物品 → 备料 → \`./bp build 编号 --at x,y\` (清场、贴、建一条命令做完)。
3. 机器台数按计算器算, 不估: 例 每分钟 30 个红瓶 = 5 台组装机1型 + 1 台齿轮机 + 4 个炼铁炉 + 2 个炼铜炉。
4. 绿瓶 + 超市段: 边用边建"超市" —— 组装机自动造传送带、机械臂、电线杆、石炉, 不再全靠手搓 (手搓是早期最大的瓶颈)。
5. 思考时角色站着不动: 先把计划写进 notes.md, 再一口气执行; 长动作用 --wait 或计划队列。
`;
const BRIEF = `# 你在玩 Factorio 2.1 (太空时代), 新地星 (Nauvis), ${PEACEFUL ? "现在开着和平模式 (敌人不主动打)" : "有敌人, 污染碰到它们的基地就会来打"}

**所有输出一律用简体中文**: 你说的每一句话 (包括一两个词的短句、思考后的小结)、笔记、team.md 留言、游戏聊天。用户看不懂英文 (第五、六轮还在说 "Use Edit for notes" 这种英文短句)。**建筑、物品、科技一律用游戏官方中文名**, 不要自己起名: 查 \`ref/names.tsv\` (例: 说"地下管道"不说"地下管", 说"军备科技包（灰瓶）"不说"军事瓶", 说"基础传送带"不说"黄带")。

## 目标
${GOAL === "grow" ? GROW_GOAL : GOAL === "belts"
    ? `接着上一班的基地干 (上一班的笔记在 notes.md)。这一班的目标: **红瓶生产线的原料全部由传送带和机械臂供应 (矿 → 炉 → 组装机 → 实验室, 燃料也一样), 实验室用机器做的红瓶连续研究 ≥ ${goalMinutes} 游戏分钟, 这段时间里你不往任何机器或箱子里放东西, 也不用箱子囤料喂机器** (transfer 放进去、refuel、rearm 都算放, 写在计划队列里的也算; 从机器里拿东西出来、建造、手搓不算)。往里放一次, 计时就从那一刻重新开始。中间怎么走你自己定。`
    : `从开局的背包出发, 建到 **组装机自动生产自动化科技包（红瓶）, 实验室用机器做的红瓶连续研究 ≥ ${goalMinutes} 游戏分钟** (不靠手搓供瓶)。中间怎么走你自己定。`}

## 规则
- 只能用 \`./fp\` 操作游戏, 像真人玩家一样: 够得着才能操作、只用背包里的东西、走路 / 采矿 / 手搓都花真实游戏时间。不要读或改 \`./fp\` 以外的程序, 不要找别的办法连游戏。
- 游戏是实时的${SPEED !== 1 ? ` (这一轮 ${SPEED} 倍速: 机器、走路、采矿、手搓都快 ${SPEED} 倍, 你思考时游戏也走得快 ${SPEED} 倍, 手加的燃料烧得快 ${SPEED} 倍)` : ""}: 你思考时角色站着不动, 时间照走。定时动作 (走路、采矿、按虚影建造…) 用 \`--wait\`; 能一次排好的多步计划就一次排好 (看 \`./fp describe\` 里的 queue 类动作)。
- 先 \`./fp help\`、\`./fp describe\`、\`./fp describe 动作名\`。报错会写清缺什么、挡着什么、怎么改, 照着改, 不要盲目重试同一条。

${GOAL === "grow" ? OPENING : ""}
## 布局规矩 (用户的硬要求: 摆放要规范, 线路要设计好, 不能乱放)
- 先分区再建: 冶炼、组装、科研各占一块, 块与块之间留 2~4 格通道; 后面要扩的方向留空地。
- 传送带走直线、平行排, 少拐弯; 需要穿过别的线时用地下传送带, 不绕弯; 管道同理用地下管道。
- 电线杆沿带子或机器排按固定间距放 (能用 \`pole_route\` 就用), 不东一根西一根。
- 成块的产线可参考现成蓝图 (合适才用; \`./bp\`): 蓝图里的机器、带子、电线杆本来就排好了; 放之前先想好整块的位置和朝向。
- 换了做法后, 旧设施 (没人加燃料的炉子、不再用的箱子、斜拉的电线杆) 拆掉回收, 不要留着 (用户看到第一轮的旧炉子没燃料、旧箱子没用)。
- 扩产时把料分到新机器: 新建的那块缺料而老线堆满, 就是分配没接好 (\`./fp bottleneck\` 看)。
- **一条道只放一种料, 带子尽头要有出口** (老玩家的基本规矩): 主带一边铁一边铜 (或分成两条), 煤走单独的带; 一条带上不要混三种料; 带子尽头必须有东西吃掉 (用不完的接回去或进箱子)。混装 + 尽头没出口, 没人吃的那种料堆满两条道, 其他料就挤不上去, 整条线连带上游全停 (第七轮: 主带混了铜和煤, 尽头堵死, 25 个炉子出口堵满, 研究中心 0/16)。监工体检会报"带子尽头堵死"。
- **管道 (用户定的)**: 能走直线就用普通管道连成一条, 少拐弯 (一个 L 形够了就别拐两次); 地下管道只在要穿过传送带、路或别的管道时用, 用就用满 (一对隔 10 格), 不要一段一段露头 (第九轮原油管线就是这样)。
- **建之前先清场**: 新建一片先把那片和周围 2 格的树、石头清掉 (build 加 clear_obstacles, 或 deconstruct + construct 那一块); 我们没有建设机器人, 标了红叉的树不会自己消失。
- **满着不用管, 缺料的先修**: 上游堆满等着是正常的, 不浪费 (ref/patterns/production.md P-prod-22); 研究中心、科技包机器缺料才是要先修的。小基地用总线分料, 好懂、好预测 (ref/patterns/mindset.md P-mind-17)。

## 知识
\`ref/facts.md\` 是在 2.1.24 沙盘里核实过的游戏事实, \`ref/patterns/\` 是老玩家的思路。需要时用 Grep 查, 不用全读。
${GOAL === "grow" ? TOOLS : ""}
## 笔记
说话和笔记都用中文 (用户看得懂)。\`notes.md\` 固定 5 节 (现在在做 / 坐标和设施 / 计划 / 教训 / 日志), 每做完一步就更新; 日志只留最近 10 行左右。上下文被压缩后先读它 (会自动贴给你)。每一轮结束前在"现在在做"里写下一步。上下文快满时会提醒你先更新笔记。
${COMPACT_INSTRUCTIONS}`;
/** ./calc '<方案 JSON>' (两种配置共用): 写进 .calc-plan.json 再跑计算器 (src/calc/cli.ts, 中文表格) */
const calcScript = (session?: string) => `#!/bin/sh\ndate +%s >> .calc.log\nprintf '%s' "$1" > .calc-plan.json && ${session ? `FP_SESSION='${fwd(session)}' ` : ""}CALC_IDS=1 exec '${fwd(process.execPath)}' --env-file-if-exists='${fwd(path.join(REPO, ".env"))}' '${fwd(path.join(REPO, "src", "calc", "cli.ts"))}' .calc-plan.json\n`;
const NOTES = "# 笔记\n\n## 现在在做\n(开局)\n\n## 坐标和设施\n\n## 计划\n\n## 教训\n\n## 日志\n";

const ROUND = { red: ["play-run", "第一轮"], belts: ["play-run2", "第二轮"], grow: ["play-run3", "第三轮"] }[GOAL];
// 实例和窗口目录按目标 + 角色数 + 是否干跑分开 (同时跑两份时不能共用一个服务器目录或窗口目录)
const instName = `${ROUND[0]}${(Number(values.agents) || 1) > 1 ? `-x${Number(values.agents)}` : ""}${values.dry ? "-dry" : ""}`;
// 自动存档每 3 分钟 3 份 (沙盘默认 10 分钟): 崩溃恢复 (看门狗) 最多丢 3 分钟的进度; 无界面服务器存一次不到 2 秒 (2026-11-04 M6)
const lab = new LabInstance({ name: instName, view: false, label: `大脑链路 ${ROUND[1]}`, repoMods: MODS, serverSettings: { autosave_interval: 3, autosave_slots: 3 } });
// 换班程序的兜底 (src/play/shift-recover.ts): 这一班没正常结束时, 它按这个文件找实例里最新的自动存档接着开
writeCurrentRun(path.join(labRoot(), "play"), { runId, runDir, brainDir, instanceDir: lab.dir, startedAt: new Date().toISOString() });
const viewer = new ViewerClient(instName, undefined, ALL_BOTS ? { playerName: OBSERVER_NAME } : {});
/** 一个角色 = 一个大脑 (自己的目录、会话、监工计数); 派对配置全是服务器角色 (bot), 窗口只看; 别的配置第 1 个是连着窗口的玩家 */
type Agent = { id: string; dir: string; who: number | string; /** 这个角色的大脑 (claude / grok / deepseek / codex / relay / none) 和模型 (一班可以混, src/play/brains.ts) */ brain: string; model: string; /** 思考强度 (阵容里按角色定, 没定就 --effort) */ effort: string; label: string; child: ChildProcess | null; idle: number; lastNudge: number; nudge: string | null; quick: number; sessionId: string; turns: number; unit?: number; prev?: { x: number; y: number; inv: number };
  /** 回复 id → 用量 (被停掉的一轮没有 result 行, 按回复累加; 派对同样按 id 去重); 收尾时汇总 */
  msgs: Map<string, Record<string, number>>;
  /** 当前进程报过的累计花费 (常驻会话的 total_cost_usd 是累计数, 只加差值) */
  costBase: number;
  /** --stream: 常驻会话、这一轮的记录文件、闲 10 分钟已插过话 */
  stream?: ClaudeStream | null; out?: fs.WriteStream | null; idleSteered?: boolean;
  /** 说英文的计数和提醒节奏 (src/play/lang.ts) */
  lang: EnglishWatch;
  /** 中途被移出 (界面"移出", src/play/roster-live.ts): 轮次循环停, 游戏角色已收回; 中途加入的: 第一句提示不同, 不接上一班同字母角色的笔记 */
  left?: boolean; joined?: boolean;
  /** 这个角色每轮 result 报的花费合计 (Claude Code 的估价; 统计表按它算, 不再按轮次份额分: 2026-11-05 Gpt 空转 186 轮被分到 $179, 实际 0) */
  costUsd?: number };
const NAGENTS = LINEUP.length;
const agents: Agent[] = Array.from({ length: NAGENTS }, (_, i) => ({
  // 服务器角色的名字 = 模型名 (同模型第 2 个起 Claude-2…); who = 1 只有非派对配置的第 1 个: 观看窗口里的玩家
  id: String.fromCharCode(97 + i), dir: NAGENTS > 1 ? path.join(brainDir, String.fromCharCode(97 + i)) : brainDir, who: LINEUP[i].who, brain: LINEUP[i].brain, model: LINEUP[i].model, effort: LINEUP[i].effort ?? values.effort!, // 角色 id a~z (以前写死 "abcd" 只到 4 个)
  label: LINEUP[i].who === 1 ? "队员 A (玩家 MK 的角色, 用户的游戏窗口跟着的就是你)" : `队员 ${String.fromCharCode(65 + i)} (服务器角色 ${LINEUP[i].who})`,
  child: null, idle: 0, lastNudge: 0, nudge: null, quick: 0, sessionId: randomUUID(), turns: 0, msgs: new Map(), costBase: 0, lang: new EnglishWatch(),
}));
const killAll = () => { for (const a of agents) a.child?.kill(); };
/** 中途被移出的角色: 从 agents 拿掉 (监工、催促、私信都不再找它), 收尾时并回去写总结和统计 */
const gone: Agent[] = [];
const STREAM = values.stream === true;
if (STREAM && agents.some((a) => a.brain !== "claude")) throw new Error("--stream 只接了 claude");
/** 这一轮还在跑 (常驻会话: 进程一直在, 看有没有一轮在等 result) */
const running = (a: Agent) => (STREAM ? !!a.stream?.busy : !!a.child);
let playerName = "player";
// 监工的话怎么送到大脑: --kit party 走 harness 的操作员私信 (tells.lua; 派对 tools/idle_nudge.py:819-898): 进对方下一条回复,
// 还能叫醒正在 ./fh sleep / wait 的大脑; 收件箱 (.inbox.md) 要等下一次工具调用才塞进去, 睡着时收不到。每条 ≤ 500 字节 (他们的 TELL_MAX)
/** 操作员读数 (分支版模组的 dispatch, operator: true; 和私信同一个通道): factory_digest、board、hauling…; 出错返回 null */
async function opCall(action: string, args: object): Promise<unknown> {
  try {
    const body = JSON.stringify({ id: `pilot-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, operator: true, action, args });
    const r = JSON.parse(await lab.rcon!.exec(`/silent-command rcon.print(remote.call("agent_harness", "dispatch", ${luaString(body)}))`, { timeoutMs: 30_000 }));
    return r.ok ? r.result : null;
  } catch { return null; }
}
async function tellAgent(a: Agent, msg: string) {
  if (KIT === "party") {
    try {
      for (const part of chunks(msg)) {
        const body = JSON.stringify({ id: `pilot-${Date.now()}-${a.id}-${Math.random().toString(36).slice(2, 8)}`, operator: true, action: "tell", args: { to: typeof a.who === "string" ? a.who : playerName, text: part } });
        const raw = await lab.rcon!.exec(`/silent-command rcon.print(remote.call("agent_harness", "dispatch", ${luaString(body)}))`);
        const r = JSON.parse(raw);
        if (!r.ok) throw new Error(r.error?.message ?? raw.slice(0, 200));
      }
      return;
    } catch (e) { log(`私信没发成, 改写收件箱: ${(e as Error).message.slice(0, 160)}`); }
  }
  // --stream (不走私信时): 直接插进正在跑的一轮 (下一次调用模型前收下); 没在跑才写收件箱
  if (STREAM && a.stream?.steer(msg)) return;
  fs.appendFileSync(path.join(a.dir, ".inbox.md"), msg + "\n");
}
// --kit party: 加在派对简报最前面 (中文、用户定的规矩、接手玩到一半的世界、监工)
const oursFor = (_a: Agent) => oursBrief({ resume: !!values.save, multi: agents.length > 1, peaceful: PEACEFUL, peaceMinutes: minutesLeft(peaceLeftMs(PEACE, Date.now())), ...(ALL_BOTS ? { human: playerName } : {}) }); // 简报最前面一节 (src/play/ours-brief.ts)
const ZH = loadZhNames(path.join(labRoot(), "prototypes"));
const zh = (n: string) => ZH.get(n) ?? n;
// 要点被动推送 (src/play/hints.ts): 监工点名 / 开班扫描按情况从 knowledge/brief-points.md 挑要点附在后面, 要蓝图候选时查 ./bp list
const POINTS = briefPoints(path.join(REPO, "knowledge", "brief-points.md"));
const bpRows = (kw: string): string[] => { try { return bpListLines(kw, 3); } catch { return []; } };
const hint = (lines: string[], n = 2, withBp = false): string => { const h = hintLine(POINTS, lines, n, withBp ? bpRows : undefined); return h ? ` ${h}` : ""; };
// 用户不要任何 AI2 标识 ("你还是别标记了" / "说过的东西 你又没弄？？"): 开局只清掉以前加过的地图标记和头顶大字
async function unlabelBots() {
  for (const a of agents) if (typeof a.who === "string") await lab.exec(BOT_LABEL_LUA, { n: a.who.toUpperCase() }).catch(() => undefined);
}
const tag = (a: Agent) => (agents.length > 1 ? a.id.toUpperCase() : ""); // 按当时的角色数 (单角色班中途加人后也带字母)
function briefFor(a: Agent) {
  if (agents.length === 1) return BRIEF;
  const others = agents.filter((x) => x !== a).map((x) => x.label).join("、");
  return BRIEF + `
## 队友 (这一轮 ${agents.length} 个角色同时玩)
你是 ${a.label}。另外还有 ${others}, 每个由另一个 Claude 操作, 用的也是 ./fp, 在同一个世界里。
- 用 \`../team.md\` 协调: 开工前写下你认领的事 (做什么、在哪个坐标范围), 做完更新; 先看别人认领了什么, 不重复、不抢。
- 不拆、不改队友正在建的东西; 共用的设施 (电网、主带) 改之前先在 team.md 写一句。
- 建议分工 (你们可以商量着改): A 负责冶炼和采矿扩产 (铁、铜、石、煤), B 负责组装、科研和超市 (红瓶、绿瓶、自动造建材)。
`;
}
let stop = false;
const usage = { turns: 0, modelTurns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
type Sample = { busyBy?: Record<string, boolean>; thinkBy?: Record<string, boolean>; t: number; tick: number; /** 己方角色累计死亡数 (击杀统计里 character 的损失; 玩家和服务器角色都算) */ deaths?: number; redMachine: number; redTotal: number; greenMachine: number; greenTotal: number; blueTotal: number; machines?: number; labs: number; labsWorking: number; research: string; researched: number; entities: number; active: string | null; queue: number };
const samples: Sample[] = [];
let streakStart: number | null = null, streakRed0 = 0, success = false;
/** 角色最后一次往机器 / 箱子里放东西的 tick (第二轮的判定; fp 日志 + 计划队列历史) */
let lastCarry = 0, reqSeen = 0;
const CARRY = new Set(["transfer", "refuel", "rearm"]);
const isCarry = (action: string, dir?: string) => CARRY.has(action) && !(action === "transfer" && dir === "to_player");

async function sample(h: Harness): Promise<Sample> {
  const g = (await lab.exec(`local s = game.surfaces[1] local f = game.forces.player
    local red = 0 for _, m in pairs(s.find_entities_filtered{type = "assembling-machine", force = f}) do local r = m.get_recipe() if r and r.name == "automation-science-pack" then red = red + m.products_finished end end
    local labs, working = 0, 0 for _, l in pairs(s.find_entities_filtered{type = "lab", force = f}) do labs = labs + 1 if l.status == defines.entity_status.working then working = working + 1 end end
    local green = 0 for _, m in pairs(s.find_entities_filtered{type = "assembling-machine", force = f}) do local r = m.get_recipe() if r and r.name == "logistic-science-pack" then green = green + m.products_finished end end
    local n = 0 for _, t in pairs(f.technologies) do if t.researched then n = n + 1 end end
    local p = game.connected_players[1] local c = p and p.character -- 窗口只看时没有身体 (src/play/observer.ts), 下面玩家那几项都要先看 c
    local inv = 0 if c then for _, it in pairs(c.get_main_inventory().get_contents()) do inv = inv + it.count end end
    local stats = f.get_item_production_statistics(s)
    return {tick = game.tick, redMachine = red, redTotal = stats.get_input_count("automation-science-pack"), greenMachine = green, greenTotal = stats.get_input_count("logistic-science-pack"), blueTotal = stats.get_input_count("chemical-science-pack"), labs = labs, labsWorking = working,
      research = f.current_research and f.current_research.name or "", researched = n, entities = s.count_entities_filtered{force = f}, queue = c and p.crafting_queue_size or 0,
      deaths = f.get_kill_count_statistics(s).get_output_count("character"),
      machines = s.count_entities_filtered{force = f, type = {"assembling-machine", "furnace", "mining-drill", "lab", "rocket-silo"}},
      px = c and c.position.x or 0, py = c and c.position.y or 0, walking = c and c.walking_state.walking or false, mining = c and p.mining_state.mining or false, inv = inv,
      punit = c and c.unit_number or 0, chars = (function() local out = {} for _, ch in pairs(s.find_entities_filtered{name = "character", force = f}) do local n2 = 0 for _, it in pairs(ch.get_main_inventory().get_contents()) do n2 = n2 + it.count end out[#out + 1] = {unit = ch.unit_number, x = ch.position.x, y = ch.position.y, walking = ch.walking_state.walking, inv = n2, queue = ch.crafting_queue_size} end return out end)()}`)) as Omit<Sample, "t" | "active"> & { px: number; py: number; walking: boolean; mining: boolean; inv: number; punit: number; chars: { unit: number; x: number; y: number; walking: boolean; inv: number; queue: number }[] };
  // 闲不闲 (照派对的定义近似): 和上一次采样比, 没挪地方、没走、没采、没手搓、没建 / 拆、背包没变 → 闲。
  // 不调 harness 的 status: 那会重置大脑自己看到的"距上次请求"计时 (harness 按玩家记)。
  const prev = lastRaw;
  lastRaw = g;
  const busy = !prev || g.walking || g.mining || g.queue > 0 || Math.hypot(g.px - prev.px, g.py - prev.py) > 0.5 || g.entities !== prev.entities || g.inv !== prev.inv;
  void h;
  // 每个角色单独判断 (多角色时): 挪了地方、在走、在手搓、背包变了 → 忙
  const busyBy: Record<string, boolean> = {};
  for (const a of agents) {
    // 场上一个角色都没有时 Lua 的空表回来是 {} 不是数组 (lab.md #55; 2026-11-05 关掉游戏窗口后玩家角色没了, 这里抛错把监工整轮打断)
    const ch = (Array.isArray(g.chars) ? g.chars : []).find((x) => x.unit === (a.who === 1 ? g.punit : a.unit));
    if (!ch) { busyBy[a.id] = true; continue; }
    const pv = a.prev; a.prev = { x: ch.x, y: ch.y, inv: ch.inv };
    busyBy[a.id] = !pv || ch.walking || ch.queue > 0 || Math.hypot(ch.x - pv.x, ch.y - pv.y) > 0.5 || ch.inv !== pv.inv;
  }
  if (agents.length === 1 && agents[0].who === 1) busyBy[agents[0].id] = busy;
  const { chars: _c, ...rest } = g; void _c;
  // 大脑这一轮还在跑 (想或等命令), 身体没动: 界面写"在想", 不写"闲着"
  const thinkBy: Record<string, boolean> = {};
  for (const a of agents) thinkBy[a.id] = running(a);
  // 全是服务器角色时全队的忙闲看每个角色, 不看窗口 (窗口只看, 没有身体)
  if (agents.every((a) => typeof a.who === "string")) {
    const queue = (Array.isArray(g.chars) ? g.chars : []).reduce((n, x) => n + (x.queue || 0), 0);
    const teamBusy = !prev || g.entities !== prev.entities || Object.values(busyBy).some(Boolean);
    return { t: Date.now(), ...rest, queue, active: teamBusy ? "busy" : null, busyBy, thinkBy };
  }
  return { t: Date.now(), ...rest, active: busy ? "busy" : null, busyBy, thinkBy };
}
let lastRaw: { px: number; py: number; entities: number; inv: number } | null = null;

/** 第二轮: 给红瓶 / 齿轮组装机、实验室、锅炉送料的机械臂从哪取货; 从箱子取 = 囤料, 不算传送带供料 */
async function supplyCheck() {
  return (await lab.exec(`local s = game.surfaces[1] local f = game.forces.player local rows, bad = {}, {}
    local function feeds(m, what)
      for _, ins in pairs(s.find_entities_filtered{type = "inserter", force = f, area = {{m.position.x - 4, m.position.y - 4}, {m.position.x + 4, m.position.y + 4}}}) do
        if ins.drop_target == m then
          local src = ins.pickup_target local t = src and src.type or "无"
          rows[#rows + 1] = what .. " <- " .. t
          if t == "container" or t == "logistic-container" then bad[#bad + 1] = what .. " 从箱子取 (" .. src.position.x .. "," .. src.position.y .. ")" end
        end
      end
    end
    for _, m in pairs(s.find_entities_filtered{type = "assembling-machine", force = f}) do local r = m.get_recipe() if r and (r.name == "automation-science-pack" or r.name == "iron-gear-wheel") then feeds(m, r.name) end end
    for _, m in pairs(s.find_entities_filtered{type = {"lab", "boiler"}, force = f}) do feeds(m, m.type) end
    return {rows = rows, bad = bad}`)) as { rows: string[]; bad: string[] };
}
let supplyNote = "";
// 监工 (对齐 factorio-ai-party tools/idle_nudge.py: 只给事实; 开局宽限; 同一人隔一段时间才提醒一次)。
// 他们给正在跑的会话发私信; claude -p 收不了中途消息, 这里打断这一轮, 下一轮的提示里带上事实 (--stream 常驻会话: 插话, 不打断)。
let nudges = 0, stallSamples = 0, lastStall = 0, stalls = 0, lastFuel = 0, lastDepleted = 0, lastDepTime = 0, lastHealthText = "", lastHealthAt = 0;
/** 每个角色已经提醒到第几分钟 "还没算过配比" (src/play/knowledge-use.ts calcReminderDue) */
const calcReminded = new Map<string, number>();
let lastHealth: string[] = [];
/** 开班扫描做成了就在第一轮提示里让大脑先读 world-scan.md */
let scanNote = "";
/** 大脑接口警报去重 (同一角色同样的话 10 分钟一次) */
const alertDedupe = new AlertDedupe();

/** 试通时接口不收强度参数的模型 (cc-env.ts ccEndpoint 的 effort; 2026-11-05): 这一班不再发 */
const NO_EFFORT = new Set<string>();
/** 这段报错像是接口不认参数 (只有这种才值得去掉参数重试一次) */
export const looksLikeParamError = (text: string) => /\b400\b|unsupported|unknown (field|param)|extra (input|field)|invalid.*(param|field|effort)|output_config|effort/i.test(text);

/** 多角色时让大脑能改上一层的 team.md: Claude Code / agy 用 --add-dir (agy 1.5.0 的 --help 也有, 和 Claude Code 同形);
 *  Codex 由它自己的参数带 (resume 没有这个参数); Grok 1.0.70 不支持, 靠 --allow 规则 (src/play/grok-args.ts) */
const sharedDirArgs = (drv: Driver) => agents.length > 1 && drv.normalize !== "codex" && drv.normalize !== "grok" ? ["--add-dir", brainDir] : [];

/** 开班前给一个角色发一句试通 (deepseek / relay / gemini / claude-api / grok): 调不通就记警报, 不拦着开班 (大脑每轮还会再报) */
function probeBrain(a: Agent, drv: Driver): Promise<{ ok: boolean; text: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let env: NodeJS.ProcessEnv;
    try { env = drv.env ? drv.env(process.env, a.model) : process.env; } catch (e) { return resolve({ ok: false, text: (e as Error).message, ms: 0 }); }
    // Antigravity (agy) 没有 --max-turns, 输出要经 normalizeAgyLine 翻; 本机 11-04 实测它一句就回 "not eligible for Antigravity… not available in your location" (账号地区), 正好开班前报出来
    // 带上和轮次一样的共享目录参数: 2026-11-05 Grok 就是败在 --add-dir 上, 试通不带就试不出来
    const base = [...drv.args!(1, randomUUID(), "只回复两个字: 收到", a.model, a.effort), ...sharedDirArgs(drv)];
    const args = drv.normalize ? base : [...base, "--max-turns", "1"]; // --max-turns 是 Claude Code 的参数; 要翻译的驱动 (codex / gemini / grok) 没有
    const st = agyState(a.model), cs = codexState(a.model), gs = grokState();
    const norm = drv.normalize === "gemini" ? (l: string) => normalizeAgyLine(st, l) : drv.normalize === "codex" ? (l: string) => normalizeCodexLine(cs, l) : drv.normalize === "grok" ? (l: string) => normalizeGrokLine(gs, l) : null;
    // stdin 要关 (和轮次一样 "ignore"): Codex exec 看到 stdin 是管道就等它读完, 11-05 两班 relay-codex 的试通都因此 90 秒被杀报假警报 (轮次本身正常)
    const c = spawn(drv.bin!, args, { cwd: a.dir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { c.kill(); resolve({ ok: false, text: "90 秒没回 (杀掉)", ms: Date.now() - t0 }); }, 90_000);
    c.on("close", (code) => {
      clearTimeout(timer);
      let result: any = null, said = "";
      // Grok 的 result 事件不带正文 (11-05 试通回 ""), 正文在 assistant 事件里: 两个都看
      const note = (ev: any) => {
        if (ev?.type === "result") result = ev;
        else if (ev?.type === "assistant") for (const b of ev.message?.content ?? []) if (b?.type === "text" && b.text) said = b.text;
      };
      for (const line of out.split(/\r?\n/)) {
        if (norm) { for (const ev of norm(line) as any[]) note(ev); continue; }
        try { note(JSON.parse(line)); } catch { /* 不是 JSON 行 */ }
      }
      const text = String(result?.result || said || (result ? "" : out)).replace(/\s+/g, " ").slice(0, 400);
      resolve({ ok: code === 0 && !!result && !result.is_error, text, ms: Date.now() - t0 });
    });
  });
}
let offlineSince = 0, lastRelaunch = 0, viewerRelaunches = 0, lastGrowNudge = 0, growNudges = 0;
/** 带子 Z 字弯: 报过的坐标、基线记过没有 */
const jogSeen = new Set<string>();
let jogBaselined = false;
/** 中途加人 / 移出: roster.jsonl 读到的字节位置; 各角色的轮次循环 (中途加入的追加在后面) */
let rosterAt = 0;
/** 全队工具的长期存放处: 跨班、跨世界留着 (在 lab-data/play 下, 跟着备份走) */
const TEAM_TOOLS_KEEP = path.join(labRoot(), "play", "team-tools-keep");
/** 上次问工具诉求的时间、上次体检报过的问题种类 */
let lastToolPoll = Date.now(), healthCats = new Set<string>();
const loops: Promise<void>[] = [];
/** 看门狗 (M6, src/play/watchdog.ts): 服务器进程没了或 RCON 答不上 45 秒 → 用最新完整自动存档重启 (端口不变), 5 分钟内不重复, 一班最多 10 次; 每次记 recovery.jsonl, 停机占比进 summary */
const watch = newWatchState();
let recovering = false;
/** 研究自动续上 (M6, src/play/research.ts): 研究中心连续 2 次采样 (1 分钟) 没在研究且队列空 → 监工排一项, 5 分钟内不重复 */
let researchIdle = 0, lastAutoResearch = 0;
const autoResearch: { at: string; tech: string | null; ok: boolean; note?: string }[] = [];
/** 扩产提案 (M6 目标树的最小版, src/play/expand.ts): 开班 5 分钟后第一条, 之后每 15 分钟复核; 差额没补齐就 20 分钟重发进度 */
let gdCalc: GameData | null = null;
let proposal: { rung: Rung; done: boolean } | null = null, lastProposalAt = 0;
const expansions: { at: string; rung: Rung; now: { red: number; green: number; blue: number }; done: boolean; reached: boolean; deltas: unknown }[] = [];
/** 死亡计数 (M6; 用户: 界面顶部威胁警报记死亡次数): 开班时的累计数、上一次采样的累计数、本班最近一次 */
let deaths0: number | null = null, lastDeaths: number | null = null, lastDeathAt: string | null = null;
const deathsShift = () => (deaths0 === null || lastDeaths === null ? 0 : lastDeaths - deaths0);
/** 给界面看的看门狗 / 死亡现状 (<记录目录>/watchdog.json; 控制接口 /api/state 的 watchdog 字段): 每次采样、掉线等待中、恢复完都写 */
function writeWatchdogFile() {
  const now = Date.now();
  const dt = downtimeMs(watch, now);
  const w = { at: new Date(now).toISOString(), recoveries: recoveries.length, failed: watch.failed, downtimeS: Math.round(dt / 1000), downtimeShare: +(dt / Math.max(1, now - t0)).toFixed(4),
    down: !!watch.downSince, downS: watch.downSince ? Math.round((now - watch.downSince) / 1000) : 0, last: recoveries.at(-1) ?? null,
    deaths: deathsShift(), deathsTotal: lastDeaths ?? 0, lastDeathAt, autoResearch: autoResearch.length, ...(peaceActive(PEACE) ? { peaceLeftS: Math.ceil(peaceLeftMs(PEACE, now) / 1000) } : {}) };
  try { fs.writeFileSync(path.join(runDir, "watchdog.json"), JSON.stringify(w)); } catch { /* 写不上不影响跑 */ }
}
type RecoveryRecord = { at: string; reason: string; crashed: boolean; downS: number; ok: boolean; save?: string | null; saveAgeS?: number | null; fallback?: boolean; evidence?: string | null; error?: string };
const recoveries: RecoveryRecord[] = [];
/** 窗口只看 (src/play/observer.ts): 在线的玩家切观战, 所有玩家身上的身体收掉, 背包交给第一个还有身体的角色; 角色还没起来就先等 (开班时 ensureBot 之后再来一次) */
async function observeOnly() {
  if (!ALL_BOTS) return;
  const to = agents.find((a) => a.unit);
  if (!to) return;
  const h = normalizeHandover(await lab.exec(OBSERVER_LUA, { unit: to.unit }).catch((e: Error) => { log(`窗口切只看失败: ${e.message.slice(0, 160)}`); return null; }));
  if (h.bodies || !observerLogged) { observerLogged = true; log(handoverText(h, typeof to.who === "string" ? to.who : null)); }
}
let observerLogged = false;
/** 服务器起来之后的固定设置 (开班和崩溃重启后都要): 跳过开场动画、倍速、(重) 开观看窗口并等它连上、和平模式、解除上一轮的隔离标记 */
async function settleWorld(relaunchViewer = true) {
  await lab.exec(`remote.call("freeplay", "set_skip_intro", true) remote.call("freeplay", "set_disable_crashsite", true) return true`);
  await lab.rpc("time", { speed: SPEED, paused: false });
  // 接上在跑的游戏 (--attach): 上一班留下的窗口还在就认领它, 不重开; 重启后旧窗口连着死掉的服务器才先关再开
  if (!relaunchViewer && viewer.attach(lab.gamePort)) log(`观看窗口还在 (pid ${viewer.pid}), 接着用`);
  else {
    if (viewer.alive) { viewer.close(); await sleep(3000); }
    viewer.launch(lab.gamePort, { repoMods: MODS });
  }
  for (let i = 0; i < 60; i++) { await sleep(2000); if (((await lab.exec(`return #game.connected_players`)) as number) >= 1) break; }
  await lab.rpc("viewer", {}).catch(() => undefined); // 退出开场动画 (lab.md #58)
  await lab.exec(`game.surfaces[1].peaceful_mode = ${PEACEFUL || peaceActive(PEACE)} return true`);
  await lab.rpc("time", { speed: SPEED, paused: false });
  await observeOnly();
  // 存档里可能带着上一轮的"运行时已隔离"标记 (第五轮第一次: 读第四轮存档后造服务器角色被拒), 开跑前先解除
  await lab.exec(`if remote.interfaces["agent_harness_pilot"] then remote.call("agent_harness_pilot", "clear_fault") end return true`);
}
/** 看门狗判定要恢复时: 留证、用最新自动存档重启、重做固定设置、换新的 RCON 给监工, 再告诉大脑丢了多久的进度 */
async function recoverGame(reason: string, onRestarted: () => void) {
  const downS = Math.round((Date.now() - watch.downSince) / 1000);
  log(`看门狗: ${reason}, 已停 ${downS} 秒, 用最新自动存档重启 (第 ${watch.recoveries + 1} 次)`);
  const rec: RecoveryRecord = { at: new Date().toISOString(), reason, crashed: false, downS, ok: false };
  try {
    const r: RecoverResult = await recoverLab(lab, { startSave: "m", notBefore: t0, evidenceDir: runDir, log });
    await settleWorld();
    onRestarted();
    Object.assign(rec, { crashed: r.crashed, save: r.save, saveAgeS: r.saveAgeMs === null ? null : Math.round(r.saveAgeMs / 1000), fallback: r.fallback, evidence: r.evidence, ok: true });
    recovered(watch, Date.now(), true);
    recoveries.push(rec);
    writeWatchdogFile();
    const lost = r.fallback ? "开班时的存档" : `约 ${Math.max(1, Math.round((r.saveAgeMs ?? 0) / 60_000))} 分钟前的自动存档`;
    const msg = `游戏刚才${r.crashed ? "崩溃" : "没响应"}了, 已用${lost}重启: 这段时间做的事可能没了, 先 status / observe 核对现状再继续; 计划队列已清空, 需要的重新排。`;
    for (const a of agents) { if (running(a)) await tellAgent(a, msg); else a.nudge = (a.nudge ?? "") + msg; }
    log(`看门狗: 已重启 (${r.save ?? "开班存档 m.zip"}${r.crashed ? ", 日志有崩溃报告" : ""}), 停机 ${rec.downS} 秒, 已告诉大脑`);
  } catch (e) {
    rec.error = (e as Error).message.slice(0, 300);
    recovered(watch, Date.now(), false);
    recoveries.push(rec);
    writeWatchdogFile();
    log(`看门狗: 重启失败 (5 分钟后再试): ${rec.error}`);
  }
  fs.appendFileSync(path.join(runDir, "recovery.jsonl"), JSON.stringify(rec) + "\n");
}
/** 工厂摘要: 上一次的事实 (只发变化) 和开班时的手搬读数 (算这一班的) */
let digestPrev: Record<string, Fact> | null = null, haul0: HaulAgent[] = [], digestSource = "", healthObj: Health | null = null, digestSent = false;
// 教训库 (src/play/lessons.ts): 开班登记种子的结果、班末各角色笔记并进去的结果 (进 summary.json)
let lessonsSeeded: SeedResult | null = null;
/** 核实过的种子: 库满时不退 */
let lessonProtect: Seed[] = [];
const lessonsMerged: Record<string, MergeResult> = {};
// 真人的话要回 (src/play/replies.ts): 界面发的话每条催一次 (key = 时间|角色); 游戏聊天点名的计时; 催了几次进 summary.json
const tellNudged = new Set<string>();
const mentionState = newMentionState();
let replyNudges = 0;
// 真人说话 (src/play/human-chat.ts): 每 5 秒看一次
//   界面的话 (tells.jsonl, 话已经由 control.ts 发了): 紧急才打断; 游戏聊天 (服务器日志 [CHAT] = 真人打字, 大脑的 ./fh say 不进这里): 把话转给模型, 紧急才打断。工具不替模型说话 (human-chat.ts 开头)
const human = { tells: 0, chat: { off: -1 }, busy: false };
const milestonesSaid = new Set<string>();
const nameOfSeat = (a: Agent) => (typeof a.who === "string" ? a.who : playerName);
function interruptFor(a: Agent, msg: string) {
  a.nudge = (a.nudge ?? "") + msg;
  if (running(a)) { a.child?.kill(); log(`真人说紧急: 打断 ${tag(a) || "角色"} 这一轮`); }
}
async function pollHuman() {
  if (human.busy || stop || !lab.rcon) return;
  human.busy = true;
  try {
    const tellsFile = path.join(runDir, "tells.jsonl");
    const rows = readTells(tellsFile);
    for (const t of rows.slice(human.tells)) {
      const a = agents.find((x) => x.id === t.agent);
      if (a && !a.left && t.source !== "game" && isUrgent(t.text)) interruptFor(a, tellText("界面", "管理员", t.text, t.scope === "team" ? "team" : "direct", true));
    }
    human.tells = rows.length;
    const live = agents.filter((a) => !a.left);
    const seats = live.map((a) => ({ id: a.id, name: nameOfSeat(a) }));
    for (const line of readNewLines(path.join(lab.dir, "server.out"), human.chat)) {
      const msg = parseChatLine(line);
      if (!msg) continue;
      const urgent = isUrgent(msg.text);
      const named = mentioned(msg.text, seats);
      const targets = named.length ? live.filter((a) => named.some((s) => s.id === a.id)) : live;
      if (!targets.length) continue;
      const scope = named.length ? "direct" : "team";
      const at = new Date().toISOString();
      for (const a of targets) {
        const text = tellText("游戏聊天", msg.from, msg.text, scope, urgent);
        if (urgent) interruptFor(a, text); else await tellAgent(a, text);
        fs.appendFileSync(tellsFile, JSON.stringify({ at, agent: a.id, to: nameOfSeat(a), scope, text: msg.text, source: "game", from: msg.from }) + "\n");
      }
      human.tells += targets.length; // 上面这几行是自己写的, 不用再看一遍
      log(`真人 ${msg.from} 在游戏聊天说: ${msg.text.slice(0, 80)} → 转给 ${targets.map(nameOfSeat).join("、")}${urgent ? " (紧急, 打断)" : ""}`);
    }
  } catch (e) { log(`真人说话处理出错: ${(e as Error).message.slice(0, 160)}`); }
  finally { human.busy = false; }
}
// 教训: 各角色 notes.md 的 Lessons 并进教训库, 全队做对应动作时自动带出; 也存一份到本机, 开新图带上。
// 班中每 10 分钟并一次 (已有的按文字去重), 班末再并一次。
const LEARNED_FILE = path.join(labRoot(), "play", "lessons-learned.jsonl");
let lastLessonMerge = Date.now();
async function mergeLessonsNow(final: boolean) {
  for (const a of agents) {
    const notesFile = path.join(a.dir, "notes.md");
    if (!fs.existsSync(notesFile) || !lab.rcon) continue;
    try {
      const idx = nameIndex(ZH, describeActions((() => { try { return fs.readFileSync(path.join(a.dir, "describe.json"), "utf8"); } catch { return null; } })()));
      const ha = new Harness(lab.rcon, a.left ? agents[0].who : a.who); // 移出的角色已经没有身体, 用第 1 个角色的身份记
      const r = await mergeNotesLessons((action, args) => ha.request(action, args), fs.readFileSync(notesFile, "utf8"), idx, 8, lessonProtect);
      const prev = lessonsMerged[a.id];
      lessonsMerged[a.id] = { candidates: r.candidates, added: (prev?.added ?? 0) + r.added, skipped: r.skipped };
      appendLearned(LEARNED_FILE, (r.rows ?? []).map((x) => ({ ...x, who: a.model, run: runId })));
      if (r.added || (final && r.candidates)) log(`教训库: ${tag(a) || a.id} 笔记里 ${r.candidates} 条教训, 并进 ${r.added} 条${final && r.skipped.length ? `; 没并的 ${r.skipped.length}: ${r.skipped.slice(0, 3).map((s) => `${s.line.slice(0, 24)} (${s.why})`).join(" | ")}` : ""}`);
    } catch (e) { log(`教训库合并 ${tag(a) || a.id} 没做成: ${(e as Error).message.slice(0, 160)}`); }
  }
}
// 电线杆斜穿空地、地下管道没配上、锅炉没水 (src/play/layout-lint.ts): 和带子 Z 字弯一样只报新出现的, 写 layout-lint.json 给复盘
const layoutSeen = { poles: new Set<string>(), pipes: new Set<string>(), dry: new Set<string>(), stuck: new Set<string>() };
let lastLabNote = { key: "", at: 0 };
let layoutBaselined = false;
async function checkLayout() {
  const scan = normalizeLayout(await lab.exec(LAYOUT_LUA));
  fs.writeFileSync(path.join(runDir, "layout-lint.json"), JSON.stringify(scan));
  const note = layoutNote(freshItems(scan.diagonal, layoutSeen.poles, edgeKey), freshItems(scan.pipes, layoutSeen.pipes, atKey), freshItems(scan.dry, layoutSeen.dry, atKey));
  if (layoutBaselined && note) {
    for (const a of agents) if (!a.left) await tellAgent(a, `监工 (只给事实): ${note}`);
    log(`监工: ${note.slice(0, 160)}`);
  }
  layoutBaselined = true; // 第一次只记基线: 接手的老东西不算这班的账
  // 这两条接手时也要报: 炉子积着板没人取、研究中心和瓶子谁卡谁 (原来是我手动发的读数)
  const stuck = stuckNote(freshItems(scan.stuck, layoutSeen.stuck, atKey));
  if (stuck) { for (const a of agents) if (!a.left) await tellAgent(a, `监工 (只给事实): ${stuck}。`); log(`监工: ${stuck.slice(0, 160)}`); }
  const lab = labNote(scan.labs, zh);
  // 状态变了才报, 同一种 20 分钟内不重复
  if (lab && lab.key !== lastLabNote.key && Date.now() - lastLabNote.at >= 20 * 60_000) {
    lastLabNote = { key: lab.key, at: Date.now() };
    for (const a of agents) if (!a.left) await tellAgent(a, `监工 (只给事实): ${lab.text}`);
    log(`监工: ${lab.text.slice(0, 160)}`);
  }
}
// 工具诉求一来就报 (派对是工程师当场修): 写进 tool-requests.md + 日志 + 界面弹窗
const toolWatch = new Map<string, { off: number }>();
function scanToolRequests() {
  for (const a of agents) {
    let st = toolWatch.get(a.id);
    if (!st) { st = { off: -1 }; toolWatch.set(a.id, st); }
    for (const r of toolRequests(readNewLines(path.join(a.dir, "journal.jsonl"), st).join("\n"))) {
      const name = nameOfSeat(a);
      fs.appendFileSync(path.join(runDir, "tool-requests.md"), `- ${name} ${r.at}: ${r.text}\n`);
      appendAlert(runDir, { at: r.at, agent: a.id, name, brain: a.brain, model: a.model, kind: "tool", text: r.text });
      log(`工具诉求 ${tag(a) || name}: ${r.text.slice(0, 200)}`);
    }
  }
}
// 上一班的平均每分钟产量 (接存档时: 存档所在的记录目录里的 monitor.jsonl), 监工拿来和这一班比 (简报的硬指标)
const prevRates = (() => { try { return values.save ? ratesFrom(fs.readFileSync(path.join(path.dirname(values.save), "monitor.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l))) : null; } catch { return null; } })();
const nowRatesLine = () => ratesLine({ red: perMin("redTotal"), green: perMin("greenTotal"), blue: perMin("blueTotal") }, prevRates);
/** 研究中心停了时: 当前研究要哪几种瓶、研究中心里各剩多少 (src/play/science.ts labLine) */
async function labFacts() {
  try {
    const r = (await lab.exec(`local f = game.forces.player local res = f.current_research local need = {}
      if res then for _, i in pairs(res.research_unit_ingredients) do need[#need + 1] = i.name end end
      local have = {} for _, l in pairs(game.surfaces[1].find_entities_filtered{type = "lab", force = f}) do local inv = l.get_inventory(defines.inventory.lab_input)
        if inv then for _, it in pairs(inv.get_contents()) do have[it.name] = (have[it.name] or 0) + it.count end end end
      return {research = res and res.name or "", need = need, have = have}`)) as { research: string; need: string[] | Record<string, string>; have: Record<string, number> | [] };
    return labLine(r.research, Array.isArray(r.need) ? r.need : Object.values(r.need ?? {}), Array.isArray(r.have) ? {} : r.have ?? {}, zh);
  } catch { return ""; }
}
const ghostSeen = new Map<string, number>();
const stuckHealth = new StuckHealth();
const faults: { tick?: number; message?: string }[] = [];
const milestones: string[] = [];
const perMin = (key: "redMachine" | "redTotal" | "greenMachine" | "greenTotal" | "blueTotal", win = 10) => {
  const last = samples.at(-1); if (!last) return 0;
  const first = samples.find((x) => x.tick >= last.tick - win * 3600) ?? samples[0];
  const dm = (last.tick - first.tick) / 3600;
  return dm > 0.5 ? (last[key] - first[key]) / dm : 0;
};
async function bottleneckFacts(h: Harness) {
  try {
    const box = (await lab.exec(`local s = game.surfaces[1] local f = game.forces.player local x0, y0, x1, y1
      for _, e in pairs(s.find_entities_filtered{force = f, type = {"lab", "assembling-machine", "furnace"}}) do
        local p = e.position x0 = math.min(x0 or p.x, p.x) y0 = math.min(y0 or p.y, p.y) x1 = math.max(x1 or p.x, p.x) y1 = math.max(y1 or p.y, p.y) end
      if not x0 then return nil end return {x0 = x0, y0 = y0, x1 = x1, y1 = y1}`)) as { x0: number; y0: number; x1: number; y1: number } | null;
    if (!box) return "";
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2, hw = Math.min(96, (box.x1 - box.x0) / 2 + 6), hh = Math.min(96, (box.y1 - box.y0) / 2 + 6);
    const r = await h.request("bottleneck", { area: { left_top: { x: cx - hw, y: cy - hh }, right_bottom: { x: cx + hw, y: cy + hh } } });
    return r.ok ? ` harness 瓶颈读数 (机器所在区域): ${formatCompact(r.result).replace(/\s+/g, " ").slice(0, 1500)}` : "";
  } catch { return ""; }
}

function facts(s: Sample | undefined) {
  if (!s) return "";
  return `游戏时间 ${(s.tick / 3600).toFixed(1)} 分钟; 已研究 ${s.researched} 项, 当前研究 ${s.research || "无"}; 机器做出的红瓶 ${s.redMachine} 个 (红瓶总产量 ${s.redTotal}); 实验室 ${s.labs} 台, 在工作 ${s.labsWorking} 台。${GOAL === "belts" ? `距你上次往机器或箱子里放东西已过 ${((s.tick - lastCarry) / 3600).toFixed(1)} 游戏分钟。` : ""}`;
}

/**
 * 大脑跑在哪个编程助手里 (像 factorio-ai-party: 每个模型用自家的命令行助手, 共用同一套 ./fp ./calc ./bp 和同一份简报 AGENTS.md / CLAUDE.md)。
 * claude 接好并核实过 (订阅); grok (Grok Build 命令行)、deepseek、relay (都是 Claude Code 换接口地址 + 密钥) 做了最小连通, 整班实跑没核; codex 占位, 选了直接报"未接入",
 * 不猜参数 —— 接入时照派对 tools/launch-agent.sh、profile-flags.sh 的隔离开关做, 并在沙盘核实。
 */
/** args 的 prompt 不给 = 常驻会话 (--stream): 提示词走标准输入 */
/** normalize = 它的输出不是 Claude 的 stream-json, 要经 src/play/grok-events.ts 翻译后再记日志 / 解析 */
/** effort = 这个角色的思考强度 (阵容里每个角色可以不同, 2026-11-04; 没给就 --effort); normalize = 输出要翻成 Claude 形状 (grok-events.ts / codex-events.ts) */
type Driver = { ready: boolean; note: string; bin?: string; args?: (n: number, sessionId: string, prompt: string | undefined, model: string, effort: string) => string[]; env?: (e: NodeJS.ProcessEnv, model: string) => NodeJS.ProcessEnv; normalize?: "grok" | "codex" | "gemini" };
// grep / head / tail: 只读, 用来截短 fp 的输出 (第三轮: "带 grep 的管道被拦了", 只能看完整输出, 多费 token)
const KIT = values.kit === "party" ? "party" : "fp";
// 没指定 --model 时各家的默认 (grok-4.7 / deepseek-flash[1m]) 在 src/play/brains.ts 的 DEFAULT_MODELS, 开头算阵容 (LINEUP) 时已经定好
/** PowerShell 包装 (Grok 用): calc.ps1 / bp.ps1 的内容 (src/play/ps1-wrap.ts) */
const calcPs1 = (session?: string) => calcPs1Text(process.execPath, path.join(REPO, ".env"), path.join(REPO, "src", "calc", "cli.ts"), session);
const argvFilePs1 = (script: string, fixed: string[], env: Record<string, string>) => argvFilePs1Text(process.execPath, path.join(REPO, ".env"), script, fixed, env);
const PARTY_REPO = process.env.PARTY_REPO ?? ""; // 本机的派对仓库 (不进公开仓库)
if (KIT === "party" && (values.mod !== "agent-harness-party" || !fs.existsSync(path.join(PARTY_REPO, "tools", "brief.py")))) throw new Error("--kit party 要 --mod agent-harness-party, 并在 .env 设 PARTY_REPO=派对仓库目录");
// 派对简报: 别用 head / tail 截 ./fh 的输出 (会丢报错和队友消息), 所以只放行 ./fh
// ./calc: 我们的计算器 (src/calc, 游戏导出数据 + 线性规划); 换派对配置时漏了, 派对的 ./fh 没有算配比的命令
const ALLOW = KIT === "party" ? ["Bash(./fh *)", "Bash(./calc *)", "Bash(./bp *)", "Bash(./plan *)", "Bash(./know *)", "Bash(python *)", "Bash(python3 *)", "Read", "Edit", "Write", "Grep", "Glob", "WebSearch", "WebFetch"] : ["Bash(./fp *)", "Bash(./calc *)", "Bash(./bp *)", "Bash(grep *)", "Bash(head *)", "Bash(tail *)", "Read", "Edit", "Write", "Grep", "Glob"];
/** 中文规矩 (Claude Code 的 --append-system-prompt 和 Agent SDK 跑器的 systemPrompt.append 共用) */
const ZH_RULE = "语言: 你输出的每一句话 (包括一两个词的短句、做事前后的小结)、笔记、team.md、游戏聊天都用简体中文; 工具回复是英文也照样用中文说。建筑、物品、科技用游戏官方中文名 (ref/names.tsv); 命令和参数里的内部名照写。";
// WebSearch / WebFetch: 派对公开局开着 (POG_FULL_TOOLS, tools/profile-flags.sh); Agent (子代理) 没开: 他们 Astra 的子代理吃掉 153M 里的 104M, 后来也关了
const CC_TOOLS = KIT === "party" ? ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "WebSearch", "WebFetch"] : ["Bash", "Read", "Edit", "Write", "Grep", "Glob"];
/** Claude Code 的参数 (claude / deepseek / relay 三个驱动共用: 后两家只是换接口地址和密钥) */
const ccArgs: NonNullable<Driver["args"]> = (n, sessionId, prompt, model, effort) => ["-p", ...(prompt === undefined ? STREAM_ARGS : [prompt]), ...(n === 1 ? ["--session-id", sessionId] : ["--resume", sessionId]),
  "--output-format", "stream-json", "--verbose", "--model", model, "--effort", effort,
  "--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome", "--disable-slash-commands",
  "--tools", CC_TOOLS.join(","), "--allowedTools", ...ALLOW, "--permission-mode", "dontAsk",
  // 中文规矩放进系统提示 (第五~八轮: 只写在简报和每轮提示末尾, harness 回复是英文, 大脑还是会说 "Meanwhile craft…" 这种英文句)
  "--append-system-prompt", ZH_RULE];
// Claude Code 的环境 (ccEnv / ccEndpoint) 在 src/play/cc-env.ts (控制接口的中转站核实也用)
const codexBin = codexLauncher();
const agyBin = agyLauncher();
const DRIVERS: Record<string, Driver> = {
  claude: { ready: true, note: "Claude Code (订阅登录; 隔离开关照派对 profile-flags.sh)", bin: process.env.CLAUDE_BIN ?? "claude", args: ccArgs, env: (e) => ccEnv(e) },
  // Claude 的第二条路: Console 的 API 密钥: 大脑走 Agent SDK 跑器
  // (src/play/agent-sdk-runner.ts = Claude Code 打包成的库, 同一套工具 / 钩子 / 设置文件; 输出就是 stream-json 形状), 密钥从 keys.json anthropic 读 (账号页填), 用户级密钥还要 anthropic_workspace。
  // 多角色的 --add-dir 由 turn() 照常追加 (跑器认这个参数)。一句试通 / 整班都还没跑 (等用户给工作区 ID 或绑定工作区的密钥)。
  "claude-api": {
    ready: true, note: "Claude (Console API 密钥, Agent SDK; 按 token 扣 Console 的赠额 / 余额)", bin: process.execPath,
    args: (n, sessionId, prompt, model, effort) => [path.join(REPO, "src", "play", "agent-sdk-runner.ts"), ...runnerArgs({ n, sessionId, prompt: prompt ?? "", model, effort, allow: ALLOW, tools: CC_TOOLS, appendSystemPrompt: ZH_RULE })],
    env: (e) => {
      const keys = readKeys(defaultKeysFile());
      if (!keys.anthropic) throw new Error("Claude 的 Console 密钥没填: 在界面左下角 账号 · 设置 的 \"Claude (Console API 密钥)\" 卡里填, 或写进 lab-data/accounts/keys.json 的 anthropic");
      return { ...ccEnv(e), ...consoleEnv(keys.anthropic, keys.anthropic_workspace) };
    },
  },
  // OpenAI GPT: Codex 命令行非交互 `codex exec --json` (本机 codex-cli 0.166.0 试通: 事件 thread.started / item.* / turn.completed,
  // 命令经 pwsh.exe 跑 → 大脑目录里的 fh.ps1 / calc.ps1 / bp.ps1 能用); 事件翻成 Claude 形状 (src/play/codex-events.ts); 第 1 轮的 thread_id 当 sessionId, 之后 resume。
  // 沙箱 workspace-write + 放开本机网络 (./fh 连 RCON); 不读用户的 config.toml (桌面版的 MCP / 钩子会拖慢并报错), 模型和强度明确传。用量从 turn.completed 读, 额度账号页读 ~/.codex。
  codex: {
    ready: true, note: "OpenAI GPT (Codex 命令行, ChatGPT 订阅登录 codex login; 事件翻成 Claude 形状)", bin: codexBin.bin,
    args: (n, sessionId, prompt, model, effort) => [...codexBin.args, ...codexExecArgs({ n, threadId: sessionId, prompt, model, effort, addDir: n === 1 && agents.length > 1 ? brainDir : undefined })],
    env: (e) => { const env = { ...withGitBash(e) }; for (const k of Object.keys(env)) if (k.startsWith("OPENAI_API_KEY")) delete env[k]; return env; }, // 走订阅登录, 不让开发会话的 API 密钥混进去
    normalize: "codex",
  },
  // Google Gemini (Google AI Pro 订阅; 开源 Gemini CLI 个人账号 6-18 起登不了): Antigravity CLI 无界面
  // `agy -p … --output-format stream-json` (官方 headless 文档 2026-11-04 读), 事件翻成 Claude 形状 (src/play/antigravity-events.ts); 第 1 轮 init 的 conversation_id 当 sessionId, 之后 --conversation 接着;
  // 自动批准 --dangerously-skip-permissions (收紧成它 settings.json 的 permissions.allow 规则是待办); 登录靠终端里跑过一次 agy 的缓存凭据 (系统凭据管理器)。
  // 去掉 GEMINI_API_KEY / GOOGLE_API_KEY: 有的话它会走 API 密钥计费而不是订阅。**真样本还没抓** (agy 本机还没装), 字段名照文档。
  gemini: {
    ready: true, note: "Google Gemini (Antigravity CLI agy, Google 账号登录; 事件翻成 Claude 形状)", bin: agyBin.bin,
    args: (n, sessionId, prompt, model, effort) => [...agyBin.args, ...agyArgs({ n, conversationId: sessionId, prompt, model, effort })],
    env: (e) => { const env = { ...e }; for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"]) delete env[k]; return env; },
    normalize: "gemini",
  },
  // 不叫大脑: 只开游戏、窗口、监工和看门狗 (测崩溃恢复 / 窗口重开用, 不花额度; 2026-11-04 M6)。每"轮"只是等 30 秒; summary.brain = none, 统计排行不算这种班
  none: { ready: true, note: "不叫大脑 (只开游戏和监工, 测看门狗用)" },
  // xAI Grok: Grok Build 命令行 1.0.70 (2026-11-04 本机探测: 参数和 Claude Code 同形, -p 单轮、-s/-r 会话、--output-format streaming-json、--permission-mode dontAsk、--allow 规则)。
  // 隔离开关照派对 profile-flags.sh (关掉 Claude / Cursor 兼容的技能、规则、钩子、MCP、子代理、工作流、联网)。它在 Windows 上用 PowerShell 跑命令, 所以 fh / calc / bp 另有 .cmd 包装。
  // 输出事件翻成 Claude 形状 (src/play/grok-events.ts) 再记日志。只放行 ./fh ./calc ./bp 和写当前目录。
  grok: {
    ready: true, note: "Grok Build (grok login 登录; 隔离开关照派对 profile-flags.sh; 事件翻成 Claude 形状)", bin: process.env.GROK_BIN ?? path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok"),
    // 参数在 src/play/grok-args.ts: 不带 --add-dir (1.0.70 报 "additionalDirectories is not supported"), 共享目录靠 --allow 规则
    args: (n, sessionId, prompt, model, effort) => grokArgs({ n, sessionId, prompt: prompt ?? "", model, effort, allow: ALLOW, shared: agents.length > 1 ? brainDir : undefined, web: KIT === "party" }),
    env: (e) => grokEnv(e, KIT === "party"),
    normalize: "grok",
  },
  // DeepSeek: Claude Code 指向 DeepSeek 的 Anthropic 兼容接口 (官方 2026-11-04 读: api-docs.deepseek.com/quick_start/agent_integrations/claude_code —
  // ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic, ANTHROPIC_AUTH_TOKEN=密钥, ANTHROPIC_MODEL / DEFAULT_*_MODEL=deepseek-flash[1m], claude-opus* 映射到 deepseek-v4-pro)。
  // 密钥从本机 <lab-data>/accounts/keys.json 读 (界面账号页填的); 其余参数和 claude 驱动一样。
  deepseek: {
    ready: true, note: "DeepSeek (Claude Code + Anthropic 兼容接口, 密钥在账号页填)", bin: process.env.CLAUDE_BIN ?? "claude", args: ccArgs,
    env: (e, model) => {
      const key = readKeys(defaultKeysFile()).deepseek;
      if (!key) throw new Error("DeepSeek 密钥没填: 在界面左下角 账号 · 设置 里填, 或写进 lab-data/accounts/keys.json 的 deepseek");
      return { ...ccEnv(e), ...ccEndpoint("https://api.deepseek.com/anthropic", key, model, "deepseek-flash", { effort: !NO_EFFORT.has(model) }) };
    },
  },
  // 中转站 (New API): Claude Code 指向站点 (ANTHROPIC_BASE_URL = 站点根地址, 不带 /v1; ANTHROPIC_AUTH_TOKEN = 站里建的令牌;
  // New API 官方文档的一键脚本就只设这两个, 2026-11-04 读; Claude Code 官方 llm-gateway 文档: 有网关凭据时不再用订阅登录), 模型用站里的名字 (账号页选, 存 keys.json relay_model;
  // --model 可临时换)。站点 / 令牌从 keys.json 读 (relay_url / relay)。Claude Code 报的花费按它自己的价目估, 真实看站里的余额。
  relay: {
    ready: true, note: "中转站 (New API: Claude Code 换接口地址 + 令牌, 账号页填站点 / 令牌 / 选模型)", bin: process.env.CLAUDE_BIN ?? "claude", args: ccArgs,
    env: (e, model) => {
      const { url, key } = relayConfig(readKeys(defaultKeysFile()));
      if (!url || !key) throw new Error("中转站没配好: 在界面左下角 账号 · 设置 的中转站卡里填站点地址和令牌, 或写进 lab-data/accounts/keys.json 的 relay_url / relay");
      // 有本机代理就指向它 (relay-proxy.ts 去 metadata), 并让本机地址绕过系统代理
      return { ...ccEnv(e), ...ccEndpoint(RELAY_PROXY?.url ?? url, key, model, model, { effort: !NO_EFFORT.has(model) }), ...(RELAY_PROXY ? bypassLocalProxy(e) : {}) };
    },
  },
  // 中转站的 Responses 协议模型 (gpt 系列; 2026-11-04 晚站长 "去模型广场看看这些模型都是什么协议的", 11-04 实测站对这类模型只收 Responses + 流式 + input 列表):
  // Claude Code 发不了 Responses, 改用 Codex 命令行, 自定义 model_provider 指向站 (令牌经环境变量 FP_RELAY_KEY, 不进命令行); 事件翻译、线程续接和官方 Codex 一样。按模型分流见 driverOf()
  "relay-codex": {
    ready: true, note: "中转站 (Responses 协议的模型, Codex 命令行指向站)", bin: codexBin.bin,
    args: (n, sessionId, prompt, model, effort) => [...codexBin.args, ...codexExecArgs({ n, threadId: sessionId, prompt, model, effort, addDir: n === 1 && agents.length > 1 ? brainDir : undefined, provider: { id: "relay", baseUrl: `${RELAY.url}/v1`, envKey: "FP_RELAY_KEY" } })],
    env: (e) => {
      if (!RELAY.url || !RELAY.key) throw new Error("中转站没配好: 在界面左下角 账号 · 设置 的中转站卡里填站点地址和令牌, 或写进 lab-data/accounts/keys.json 的 relay_url / relay");
      const env = { ...withGitBash(e), FP_RELAY_KEY: RELAY.key };
      for (const k of Object.keys(env)) if (k.startsWith("OPENAI_API_KEY")) delete env[k];
      return env;
    },
    normalize: "codex",
  },
};
/** 角色用哪个驱动: 中转站按站标的协议分流 (relay-route.ts) —— Claude 格式 → relay (Claude Code 经代理), Responses 协议 → relay-codex (Codex 指向站); 别家按 brain */
const driverOf = (a: Agent): Driver | undefined => (a.brain === "relay" && relayRoute(a.model, RELAY_FORMATS[a.model]).route === "codex" ? DRIVERS["relay-codex"] : DRIVERS[a.brain]);

/** 大脑输出的一行 (两种跑法共用): 记日志、额度、用量 */
function onBrainLine(a: Agent, m: any) {
  if (m.type === "assistant" && m.message?.id) a.msgs.set(m.message.id, m.message.usage ?? {});
  if (m.type === "assistant") for (const b of m.message?.content ?? []) {
    if (b.type === "tool_use" && b.name === "Bash") log(`  大脑${tag(a)}: ${String(b.input?.command ?? "").slice(0, 140)}`);
    else if (b.type === "text" && b.text?.trim()) {
      log(`  大脑${tag(a)}说: ${b.text.trim().replace(/\s+/g, " ").slice(0, 160)}`);
      // 说英文 (用户: 全程中文; 第十三轮接续第 1 班头 10 分钟 9 句 8 句英文): 5 分钟内 3 句就私信提醒一次, 只给事实
      if (a.lang.note(b.text)) {
        void tellAgent(a, `监工: 你最近 5 分钟有 3 句话是英文 (例: "${b.text.trim().replace(/\s+/g, " ").slice(0, 60)}")。用户看不懂英文: 你说的每一句话, 包括做事前后的一两句, 都用简体中文。`).catch(() => undefined);
        log(`监工: ${tag(a) || "角色"} 说英文, 提醒 (本班英文 ${a.lang.english}/${a.lang.total} 句)`);
      }
    }
  }
  const q = parseRateLimit(m);
  if (q) {
    quota.last = q; quota.start ??= q;
    fs.appendFileSync(path.join(runDir, "quota.jsonl"), JSON.stringify({ agent: a.id, ...q }) + "\n");
    // 额度用完: 别让各轮一直失败, 存档收尾 (状态 allowed_warning 只记一句)
    if (q.status !== "allowed" && q.status !== "allowed_warning" && !stop) { stop = true; log(`额度被拒, 收尾: ${describeQuota(q)}`); killAll(); }
    else if (q.status === "allowed_warning" && !quota.warned) { quota.warned = true; log(`额度快到了: ${describeQuota(q)}`); }
  }
  if (m.type === "result") {
    // total_cost_usd 是这个进程的累计数: 一轮一进程时就是这一轮的, 常驻会话要减去上次的
    const c = m.total_cost_usd ?? 0;
    usage.costUsd += Math.max(0, c - a.costBase); a.costUsd = (a.costUsd ?? 0) + Math.max(0, c - a.costBase); a.costBase = c;
    if (m.is_error || m.subtype !== "success") {
      const text = String(m.result ?? "");
      log(`  这一轮结束: ${m.subtype} ${text.slice(0, 200)}`);
      // 接口层的失败 (中转站 / DeepSeek / 订阅 调不通) 记警报, 界面弹窗
      if (isApiFailure(text) && alertDedupe.should(a.id, text)) {
        appendAlert(runDir, { at: new Date().toISOString(), agent: a.id, name: typeof a.who === "string" ? a.who : playerName, brain: a.brain, model: a.model, kind: "api", text: text.slice(0, 400) });
        log(`警报: ${tag(a) || "角色"} (${a.brain} ${a.model}) 的大脑接口报错: ${text.slice(0, 160)}`);
      }
    }
  }
}

/** 跑一轮大脑, 输出写进 turn-N.jsonl; 返回 0 = 正常结束 */
function turn(a: Agent, n: number, prompt: string): Promise<number> {
  if (a.brain === "none") return sleep(30_000).then(() => 0); // 不叫大脑 (测看门狗 / 窗口): 一"轮" = 等 30 秒
  const drv = driverOf(a);
  if (!drv?.ready || !drv.args || !drv.bin) throw new Error(`大脑 ${a.brain} 还没接入: ${drv?.note ?? "不认识"}`);
  const file = path.join(runDir, `turn-${agents.length > 1 ? a.id + "-" : ""}${n}.jsonl`);
  const env = drv.env ? drv.env(process.env, a.model) : process.env;
  if (STREAM) {
    // 常驻会话: 进程不在 (第一轮、被截止 / 打断杀掉后) 才起, 接着同一个会话 (--resume); 这一轮的输出写进新文件 (一轮结束后才到的行也记进去)
    a.out?.end();
    a.out = fs.createWriteStream(file);
    if (!a.stream || a.stream.exited) {
      a.costBase = 0;
      const s: ClaudeStream = new ClaudeStream({
        bin: drv.bin, args: [...drv.args(n, a.sessionId, undefined, a.model, a.effort), ...(agents.length > 1 ? ["--add-dir", brainDir] : [])], cwd: a.dir, env,
        onLine: (m, raw) => { a.out?.write(raw + "\n"); onBrainLine(a, m); },
        onStderr: (d) => fs.appendFileSync(path.join(runDir, "claude-stderr.txt"), d),
        onSteerTaken: () => log(`  大脑${tag(a)}收下了插话`), // 监工的话进了正在跑的一轮
        onExit: (code) => { if (a.child === s.child) a.child = null; log(`${tag(a) ? tag(a) + " " : ""}常驻会话退出 (退出码 ${code})`); },
      });
      a.stream = s; a.child = s.child;
    }
    return a.stream.turn(prompt).then((r) => (r.ok ? 0 : r.exited ? (r.code ?? -1) : 1));
  }
  const args = [...drv.args(n, a.sessionId, prompt, a.model, a.effort), ...sharedDirArgs(drv)];
  const out = fs.createWriteStream(file);
  return new Promise((resolve) => {
    const c = spawn(drv.bin!, args, { cwd: a.dir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    a.child = c; a.costBase = 0;
    let buf = "";
    // 要翻译的驱动 (Grok / Codex): 原始行另存 *-raw.jsonl, 日志里写 Claude 形状的事件 (界面、统计都按这个形状读)
    const raw = drv.normalize ? fs.createWriteStream(file.replace(/\.jsonl$/, "-raw.jsonl")) : null;
    const gs = grokState(), cs = codexState(a.model), ags = agyState(a.model);
    const norm = drv.normalize === "codex" ? (l: string) => normalizeCodexLine(cs, l) : drv.normalize === "gemini" ? (l: string) => normalizeAgyLine(ags, l) : drv.normalize === "grok" ? (l: string) => normalizeGrokLine(gs, l) : null;
    c.stdout!.on("data", (d: Buffer) => {
      if (!norm) out.write(d); else raw!.write(d);
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (norm) { for (const ev of norm(line)) { out.write(JSON.stringify(ev) + "\n"); onBrainLine(a, ev); } continue; }
        try { onBrainLine(a, JSON.parse(line)); } catch { /* 不是整行 JSON */ }
      }
    });
    c.stderr!.on("data", (d: Buffer) => fs.appendFileSync(path.join(runDir, "claude-stderr.txt"), d));
    c.on("exit", (code) => {
      a.child = null; out.end(); raw?.end();
      // Codex: 第一轮拿到它的线程 id, 之后 resume 用 (我们生成的 UUID 它不认)
      if (drv.normalize === "codex" && cs.threadId && a.sessionId !== cs.threadId) { log(`  大脑${tag(a)} Codex 线程 ${cs.threadId}`); a.sessionId = cs.threadId; }
      // Antigravity 同理: 第一轮拿到它的 conversation_id, 之后 --conversation 接着
      if (drv.normalize === "gemini" && ags.conversationId && a.sessionId !== ags.conversationId) { log(`  大脑${tag(a)} Antigravity 会话 ${ags.conversationId}`); a.sessionId = ags.conversationId; }
      resolve(code ?? -1);
    });
  });
}

let monitor: NodeJS.Timeout | null = null;
const quota: { probe?: Quota | null; start?: Quota; last?: Quota; warned?: boolean } = {};
const AT = Number(values.compactAt ?? compactAt(values.model!));
// 钩子命令 (Claude Code 在 Git Bash 里跑): node 直接跑 .ts
const hookCmd = (event: string, ...extra: string[]) => [`'${fwd(process.execPath)}'`, `'${fwd(path.join(REPO, "src", "play", "context-hook.ts"))}'`, event, ...extra].join(" ");
try {
  // 开跑前查订阅额度: 最紧的窗口已用到 quotaMax 就不开。先读用量接口 (不花额度, quota.ts readPlanUsage);
  // 读不到再跑探针 (一条极小的 claude -p, 和大脑同样的登录和隔离)
  const claudeSeat = agents.find((a) => a.brain === "claude");
  const drv0 = DRIVERS.claude;
  if (claudeSeat && !values.dry && drv0?.bin) {
    const pu = await readPlanUsage();
    quota.probe = pu.q ?? await probeQuota(drv0.bin, drv0.env ? drv0.env(process.env, claudeSeat.model) : process.env, brainDir, claudeSeat.model);
    log(`开跑前 ${describeQuota(quota.probe)}${pu.q ? " (用量接口)" : ` (用量接口没读到: ${pu.why}; 用的探针)`}`);
    const u = maxUtilization(quota.probe ?? null);
    if (u !== null && u >= Number(values.quotaMax) && !values.force) throw new Error(`额度最紧的窗口已用 ${Math.round(u * 100)}% (上限 ${values.quotaMax}), 不开跑; 要强开加 --force`);
  }
  markEnd(path.join(lab.dir, "server.out"), human.chat); // server.out 跨班追加: 这之前的聊天是旧班的, 这之后真人说的都要回
  // 换班不关游戏: 上一班留下的服务器还在就接上 (不读档不重起; 世界一直在跑); 接不上就照旧读档开
  let attached = false;
  if (values.attach) {
    try { attached = await lab.attach(); } catch (e) { log(`接在跑的游戏失败: ${(e as Error).message.slice(0, 160)}`); }
    log(attached ? `接上在跑的游戏 (pid ${lab.pid}, RCON ${lab.rconPort}, 存档 ${lab.save}): 不读档, 接着玩` : "没有在跑的游戏可接, 改为读档开");
  }
  if (!attached) {
    if (values.save) { lab.prepare(); fs.copyFileSync(values.save, lab.savePath("m")); } // 接着上一轮的存档
    else await lab.createMap("m", { seed: Number(values.seed) });
    await lab.start("m");
  }
  await settleWorld(!attached);
  // 服务器角色 (第 2 个起): 分支版 harness 的 bot_create (只能走 RCON, 不经过 dispatch); 中途加人 (applyRosterOp) 也走这里
  async function ensureBot(a: Agent) {
    if (typeof a.who !== "string") return;
    // 接存档时角色可能已经在 (第六轮第一次: "a bot named ai2 already exists") → 接着用它 (背包是上一轮的); bots 只给位置, 按位置找回角色实体
    const listed = (await lab.exec(`return remote.call("agent_harness", "bots")`)) as string | { bots?: { name: string; alive?: boolean; position?: { x: number; y: number } }[] };
    const botList = (typeof listed === "string" ? JSON.parse(listed) : listed)?.bots;
    // 新地图还没有服务器角色: Lua 空表传回来是 {} 不是 [] (第十一轮开跑前干跑 "find is not a function")
    const old = (Array.isArray(botList) ? botList : []).find((b: { name: string }) => b.name === a.who);
    // 玩家身上的身体都不算 (在线的和不在线的; 2026-11-05 窗口分开后, 存档里还留着原来 mkdm 的身体)
    const r = old ? { bot: { unit_number: (await lab.exec(`local mine = {} for _, p in pairs(game.players) do if p.character then mine[p.character.unit_number] = true end end local best, bd
        for _, c in pairs(game.surfaces[1].find_entities_filtered{name = "character", force = "player"}) do
          local d = (c.position.x - ${old.position?.x ?? 0}) ^ 2 + (c.position.y - ${old.position?.y ?? 0}) ^ 2
          if not mine[c.unit_number] and (not bd or d < bd) then best, bd = c.unit_number, d end
        end return best`)) as number } }
      : (await lab.exec(`return remote.call("agent_harness", "bot_create", "${a.who}")`)) as { bot?: { unit_number?: number } } | string;
    const o = typeof r === "string" ? JSON.parse(r) : r;
    a.unit = o?.bot?.unit_number;
    if (old) log(`服务器角色 ${a.who} 存档里已有, 接着用 (实体 ${a.unit})`);
    if (!a.unit) throw new Error(`造服务器角色 ${a.who} 失败 (要 --mod agent-harness-party): ${JSON.stringify(r).slice(0, 200)}`);
    await unlabelBots();
  }
  type BotRow = { name: string; alive?: boolean; position?: { x: number; y: number } };
  const listBots = async (): Promise<BotRow[]> => {
    const listed = (await lab.exec(`return remote.call("agent_harness", "bots")`).catch(() => null)) as string | { bots?: BotRow[] } | null;
    const rows = (typeof listed === "string" ? JSON.parse(listed) : listed)?.bots;
    return Array.isArray(rows) ? rows : []; // Lua 空表回来是 {}
  };
  /** 收回一个服务器角色: 派对 bots.lua 的 bot_remove 停掉它的动作和常驻命令, 角色原地倒下, 背包在尸体里; 再把尸体里的东西搬进旁边的钢箱 (尸体到时间会消失) → 返回箱子坐标说明 */
  async function retireBot(name: string): Promise<string> {
    if (!isSafeBotName(name)) return `名字不合规, 没动: ${name}`;
    const row = (await listBots()).find((b) => b.name === name);
    const r = await lab.exec(`return remote.call("agent_harness", "bot_remove", "${name}")`).catch((e: Error) => `失败: ${e.message}`);
    if (typeof r === "string" && r.startsWith("失败")) return r;
    if (!row?.position) return "收回了 (当时没有身体, 没东西要搬)";
    const s = normalizeSalvage(await lab.exec(salvageLua(row.position.x, row.position.y)).catch(() => null));
    return salvageText(s);
  }
  // 开班时收回不在这班名单里的旧角色 (选了"自动收回"); --keep-bots 跳过
  async function collectOldBots() {
    if (values["keep-bots"]) return;
    const mine = new Set(agents.map((x) => (typeof x.who === "string" ? x.who : "")));
    for (const b of await listBots()) {
      if (!b?.name || mine.has(b.name)) continue;
      log(`收回旧角色 ${b.name} (不在这班名单里): ${await retireBot(b.name)}`);
    }
  }
  for (const a of agents) await ensureBot(a);
  await observeOnly(); // 角色都有身体了: 窗口的身体和背包这时才交得出去
  await collectOldBots();
  // --kit party: 开班 (派对 tools/start-team.sh:279-287): 关掉上一班遗留的事故, 记班号; 每个角色本班第一条回复带"班次块" (团队计划、研究完的科技…)
  if (KIT === "party") {
    const prevShift = values.notes ? Number((() => { try { return fs.readFileSync(path.join(values.notes, "shift.txt"), "utf8"); } catch { return "0"; } })()) || 0 : 0;
    const shiftN = values.save ? prevShift + 1 : 1;
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(path.join(brainDir, "shift.txt"), String(shiftN));
    const r = await lab.rcon!.exec(`/silent-command local ok, r = pcall(remote.call, "agent_harness", "shift_start", ${shiftN}, "") rcon.print(ok and (type(r) == "table" and helpers.table_to_json(r) or tostring(r)) or ("失败: " .. tostring(r)))`).catch((e: Error) => `失败: ${e.message}`);
    log(`开班: 第 ${shiftN} 班, shift_start ${String(r).slice(0, 160)}`);
    // ① 我们核实过的要点登记进教训库 (knowledge/lessons-seed.json → 模组 lesson_add, 以第 1 个角色的身份; 已有的 lesson_verify 刷新):
    //    大脑做对应动作时回复里自动带出, 不用它自己查
    try {
      const curated = loadSeeds(path.join(REPO, "knowledge", "lessons-seed.json"));
      // 之前各班大脑记下来的通用教训一起带上 (跨世界): 同一个存档再开已经在库里, 这里只会复核
      const learned = learnedSeeds(LEARNED_FILE, curated, 70, path.join(REPO, "knowledge", "lessons-learned.jsonl"));
      const seeds = [...curated, ...learned];
      lessonProtect = curated;
      const h0 = new Harness(lab.rcon!, agents[0].who);
      lessonsSeeded = await seedLessons((action, args) => h0.request(action, args), seeds);
      log(`教训库: 种子 ${curated.length} 条 + 之前各班的 ${learned.length} 条 → 新登记 ${lessonsSeeded.added}、复核 ${lessonsSeeded.verified}, 库里共 ${lessonsSeeded.total} 条${lessonsSeeded.failed.length ? `; 失败 ${lessonsSeeded.failed.length}: ${lessonsSeeded.failed.slice(0, 3).join(" | ")}` : ""}`);
    } catch (e) { log(`教训库登记没做成: ${(e as Error).message.slice(0, 200)}`); }
  }
  // --notes 可以是上一轮的大脑目录: 每个角色接回自己的 notes.md (多角色在 <目录>/<a|b>/), team.md 也接上
  const prevDir = values.notes && fs.statSync(values.notes).isDirectory() ? values.notes : null;
  const TEAM_MD_EMPTY = "# 队伍协调 (每个队员都能改)\n\n## 认领 (谁 / 做什么 / 坐标范围 / 状态)\n\n## 共用设施 (电网、主带、仓库的位置)\n\n## 留言\n";
  if (agents.length > 1 && prevDir && fs.existsSync(path.join(prevDir, "team.md"))) fs.copyFileSync(path.join(prevDir, "team.md"), path.join(brainDir, "team.md"));
  else if (agents.length > 1) fs.writeFileSync(path.join(brainDir, "team.md"), TEAM_MD_EMPTY);
  // 窗口里的人: 接老存档时 players[1] 是以前的 mkdm, 所以先认在线的
  playerName = String(await lab.exec(`local p = game.connected_players[1] or game.players[1] return p and p.name or "player"`).catch(() => "player"));
  // 一个角色的目录: 会话文件、简报、./fh、笔记…; 开班对每个角色跑一遍, 中途加人 (applyRosterOp) 也跑这里。multi 按当时的角色数算 (单角色班中途加人后就是多角色布局)
  function prepareAgent(a: Agent) {
    const multi = agents.length > 1;
    fs.mkdirSync(a.dir, { recursive: true });
    // name / model 给界面 (控制接口) 显示 "Claude Opus 5.5 · A" + 游戏里的名字; 游戏里的角色名不改; seat = 阵容里的那一席 (界面算名单差异、统计认模型用)
    const session: Session = { rconPort: lab.rconPort, password: lab.password, player: 1, ...(typeof a.who === "string" ? { bot: a.who } : {}), ...(multi ? { agent: a.id } : {}), logDir: runDir,
      name: typeof a.who === "string" ? a.who : playerName, model: modelDisplayName(a.brain, a.model), seat: { brain: a.brain, model: a.model } };
    const sessionPath = path.join(runDir, multi ? `session-${a.id}.json` : "session.json");
    fs.writeFileSync(sessionPath, JSON.stringify(session));
    if (a === agents[0] && multi) fs.writeFileSync(path.join(runDir, "session.json"), JSON.stringify(session)); // 复盘 / 窥看脚本用
    if (KIT === "party") {
      // 派对整套配置 (src/play/partykit.ts): AGENTS.md / CLAUDE.md、ref/ (./fh help 主题)、./fh、deadline.txt、describe.json
      const pw = path.join(runDir, "rcon.pw");
      fs.writeFileSync(pw, lab.password);
      const mate = agents.find((x) => x !== a);
      const kit = setupPartyWorkspace({
        team: agents.map((x) => `\`${typeof x.who === "string" ? x.who : playerName}\` (${modelDisplayName(x.brain, x.model)})`).join("、"),
        partyRepo: PARTY_REPO, dir: a.dir, name: typeof a.who === "string" ? a.who : playerName, who: a.who,
        teammate: mate ? { name: typeof mate.who === "string" ? mate.who : playerName, notes: `../${mate.id}/notes.md` } : undefined,
        role: a === agents[0] ? (values.save ? "keep the base running (fuel, power, depleted ore, blocked belts) and smelting" : "mining, smelting and power") : (values.save ? "science production (chemical science next)" : "the first science assemblers and research"),
        rconPort: lab.rconPort, passwordFile: pw, deadline, resume: !!values.save, ours: oursFor(a),
        nodeBin: process.execPath, shim: path.join(REPO, "src", "play", "fh-shim.ts"), protoRoot: path.join(labRoot(), "prototypes"),
      });
      if (kit.missed.length) log(`派对简报有几处没改到 (派对仓库更新过?): ${kit.missed.join("、")}`);
      // 完整工具 (派对 POG_FULL_TOOLS): 自己的 tools/、全队的 team-tools/、游戏数据; 全队的跨班跨世界都留着 (积累是地板)
      setupFullTools({ dir: a.dir, shared: path.join(brainDir, "team-tools"), prevTools: prevDir && !a.joined ? path.join(prevDir, agents.length > 1 ? a.id : "", "tools") : undefined, prevShared: TEAM_TOOLS_KEEP, gamedataDir: ensureGamedata(defaultDumpPath(), path.join(labRoot(), "gamedata", path.basename(path.dirname(defaultDumpPath())))) });
      fs.writeFileSync(path.join(a.dir, "plan"), `#!/bin/sh\nFP_SESSION='${fwd(sessionPath)}' exec '${fwd(process.execPath)}' --env-file-if-exists='${fwd(path.join(REPO, ".env"))}' '${fwd(path.join(REPO, "src", "play", "plan.ts"))}' "$@"\n`);
      fs.writeFileSync(path.join(a.dir, "plan.ps1"), argvFilePs1(path.join(REPO, "src", "play", "plan.ts"), [], { FP_SESSION: sessionPath }));
      // ./know 关键词: 查全部积累 (src/play/know.ts); FH_PROTO 给官方名和内部名互查
      fs.writeFileSync(path.join(a.dir, "know"), `#!/bin/sh\nFH_PROTO='${fwd(path.join(labRoot(), "prototypes"))}' exec '${fwd(process.execPath)}' --env-file-if-exists='${fwd(path.join(REPO, ".env"))}' '${fwd(path.join(REPO, "src", "play", "know.ts"))}' "$@"\n`);
      fs.writeFileSync(path.join(a.dir, "know.ps1"), argvFilePs1(path.join(REPO, "src", "play", "know.ts"), [], { FH_PROTO: path.join(labRoot(), "prototypes") }));
      fs.mkdirSync(path.join(a.dir, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(a.dir, ".claude", "settings.json"), JSON.stringify(brainSettings(AT, hookCmd), null, 2));
      fs.writeFileSync(path.join(a.dir, ".context-hooks"), "");
      // 中途加入的不接上一班同字母角色的笔记 (那是别的模型的)
      const prevNotes = a.joined ? "" : prevDir ? path.join(prevDir, agents.length > 1 ? a.id : "", "notes.md") : values.notes;
      const prevJournal = a.joined ? "" : prevDir ? path.join(prevDir, agents.length > 1 ? a.id : "", "journal.jsonl") : "";
      fs.writeFileSync(path.join(a.dir, "notes.md"), prevNotes && fs.existsSync(prevNotes) ? fs.readFileSync(prevNotes, "utf8") : PARTY_NOTES);
      if (prevNotes && fs.existsSync(prevNotes) && prevJournal && fs.existsSync(prevJournal)) {
        // 派对 tools/handover.py carry: 笔记顶部加 "## Last shift, measured" (上一班实测: 站着的比例、白干的动作、失败前三、Now 几班没变),
        // 超 16KB 按标题裁, 全文进 notes-archive.md (他们 docs: 惯例比理由活得久, 因为没人测量)
        try { execFileSync("python", ["-I", "-X", "utf8", path.join(PARTY_REPO, "tools", "handover.py"), "carry", prevNotes, prevJournal, path.join(a.dir, "notes.md"), runId, typeof a.who === "string" ? a.who : playerName], { stdio: "pipe" }); }
        catch (e) { log(`上一班实测没写成, 笔记原样带上: ${(e as Error).message.slice(0, 160)}`); }
      }
      // 上一班的自动复盘 (src/play/review-shift.ts, 上一班班末写的 review.json): "先修这几条"放在笔记最前面
      if (values.save && !a.joined) {
        try {
          const prevRun = path.dirname(values.save), rv = JSON.parse(fs.readFileSync(path.join(prevRun, "review.json"), "utf8")) as { fixes?: string[] };
          const head = reviewNotes(rv.fixes ?? [], path.basename(prevRun));
          if (head) fs.writeFileSync(path.join(a.dir, "notes.md"), head + fs.readFileSync(path.join(a.dir, "notes.md"), "utf8"));
        } catch { /* 上一班没有复盘 (旧版本跑的) */ }
      }
      if (ZH.size) fs.writeFileSync(path.join(a.dir, "ref", "names.tsv"), "内部名\t官方中文名\n" + [...ZH].map(([k, v]) => `${k}\t${v}`).join("\n") + "\n");
      // 我们的老玩家经验 (knowledge/patterns/, 已核实事实 facts.md): 换成派对配置时漏了 (派对简报只给事实不给打法)
      // → 放进 ref/ 当手册主题, ./fh help pilot-<主题> 能查
      for (const f of fs.readdirSync(path.join(REPO, "knowledge", "patterns"))) if (f.endsWith(".md") && f !== "README.md") fs.copyFileSync(path.join(REPO, "knowledge", "patterns", f), path.join(a.dir, "ref", `pilot-${f}`));
      fs.copyFileSync(path.join(REPO, "knowledge", "facts.md"), path.join(a.dir, "ref", "pilot-facts.md"));
      fs.copyFileSync(path.join(REPO, "knowledge", "ref-index.md"), path.join(a.dir, "ref", "index.md")); // 按情况查 (./fh help index)
      fs.copyFileSync(path.join(REPO, "docs", "research", "players", "game-tips.md"), path.join(a.dir, "ref", "pilot-game-tips.md")); // 游戏自带提示与技巧 81 条的转述 (之前只在仓库文档里, 模型看不到)
      // 全部检索资料也放进 ref/research/ (58 万字, 之前模型一个字都看不到): ./know 查到后能看全文, 不进手册主题免得占 ./fh help 列表
      fs.mkdirSync(path.join(a.dir, "ref", "research"), { recursive: true });
      for (const f of fs.readdirSync(path.join(REPO, "docs", "research", "players"))) if (f.endsWith(".md")) fs.copyFileSync(path.join(REPO, "docs", "research", "players", f), path.join(a.dir, "ref", "research", f));
      // 要点也追加到它真会查的派对主题末尾 (18 班里它查 building / analysis / moving-items, 不查 pilot-*; 2026-11-04 #251)
      const points = briefPoints(path.join(REPO, "knowledge", "brief-points.md"));
      if (points) for (const t of ["building.md", "analysis.md", "moving-items.md"]) { const f = path.join(a.dir, "ref", t); if (fs.existsSync(f)) fs.appendFileSync(f, `\n\n${points}\n`); }
      fs.writeFileSync(path.join(a.dir, "calc"), calcScript(sessionPath)); // 带会话: ./calc 自动和游戏里的 Factory Planner 对一遍 (src/calc/fp-live.ts)
      // PowerShell 包装 (Grok Build 在 Windows 上用 PowerShell 跑命令, ./calc ./bp 会落到同名 .ps1): 参数在 PowerShell 里是完整的,
      // 经 cmd / sh 转手会把 JSON 参数拆坏 (2026-11-04 实测), 所以 calc.ps1 直接把方案写进文件, bp.ps1 把参数写成 JSON 数组文件交给 node (src/play/argv-file.ts)
      fs.writeFileSync(path.join(a.dir, "calc.ps1"), calcPs1(sessionPath));
      fs.writeFileSync(path.join(a.dir, "bp.ps1"), argvFilePs1(path.join(REPO, "src", "play", "bp.ts"), [], { FP_SESSION: sessionPath }));
      // ./bp: 蓝图库 (整块贴实测过的冶炼列等, 一条命令清场 + 贴 + 建; play:check 的 "bp build" 项核过才放行)
      fs.writeFileSync(path.join(a.dir, "bp"), `#!/bin/sh\nFP_SESSION='${fwd(sessionPath)}' exec '${fwd(process.execPath)}' --env-file-if-exists='${fwd(path.join(REPO, ".env"))}' '${fwd(path.join(REPO, "src", "play", "bp.ts"))}' "$@"\n`);
      return;
    }
    fs.writeFileSync(path.join(a.dir, "CLAUDE.md"), briefFor(a));
    fs.writeFileSync(path.join(a.dir, "AGENTS.md"), briefFor(a)); // Codex 等别家助手读 AGENTS.md (派对的简报也叫这个)
    // 上下文: 在 AT token 处压缩、快满时提醒写笔记、压缩后贴回笔记 (src/play/context.ts; 钩子只在有标记的目录起作用)
    fs.mkdirSync(path.join(a.dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(a.dir, ".claude", "settings.json"), JSON.stringify(brainSettings(AT, hookCmd), null, 2));
    fs.writeFileSync(path.join(a.dir, ".context-hooks"), "");
    const prevNotes = a.joined ? "" : prevDir ? path.join(prevDir, agents.length > 1 ? a.id : "", "notes.md") : values.notes;
    fs.writeFileSync(path.join(a.dir, "notes.md"), prevNotes && fs.existsSync(prevNotes) ? fs.readFileSync(prevNotes, "utf8") : NOTES); // 接班: 带上一班的笔记
    fs.writeFileSync(path.join(a.dir, "fp"), `#!/bin/sh\nFP_SESSION='${fwd(sessionPath)}' exec '${fwd(process.execPath)}' '${fwd(path.join(REPO, "src", "play", "fp.ts"))}' "$@"\n`);
    // 计算器和蓝图库 (第三轮起): ./calc '<方案 JSON>'、./bp list|show|file
    fs.writeFileSync(path.join(a.dir, "calc"), calcScript());
    fs.writeFileSync(path.join(a.dir, "bp"), `#!/bin/sh\nFP_SESSION='${fwd(sessionPath)}' exec '${fwd(process.execPath)}' '${fwd(path.join(REPO, "src", "play", "bp.ts"))}' "$@"\n`); // bp build 要连游戏
    fs.mkdirSync(path.join(a.dir, "ref", "patterns"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "knowledge", "facts.md"), path.join(a.dir, "ref", "facts.md"));
    for (const f of fs.readdirSync(path.join(REPO, "knowledge", "patterns"))) if (f.endsWith(".md")) fs.copyFileSync(path.join(REPO, "knowledge", "patterns", f), path.join(a.dir, "ref", "patterns", f));
    // 官方中文名单 (第七轮: 聊天里说"地下管""军事瓶", 官方是"地下管道""军备科技包（灰瓶）"): 游戏导出的 zh-CN, 内部名 → 官方名
    if (ZH.size) fs.writeFileSync(path.join(a.dir, "ref", "names.tsv"), "内部名\t官方中文名\n" + [...ZH].map(([k, v]) => `${k}\t${v}`).join("\n") + "\n");
  }
  for (const a of agents) prepareAgent(a);
  fs.writeFileSync(path.join(runDir, ROSTER_OPS), ""); // 信箱开了 = 这一班支持中途加人 / 移出 (控制接口看有没有这个文件; 旧版本开的班没有)
  // 开班时的手搬读数 (工厂摘要按"这一班"算重复最多的手搬; 模组的读数是整局累计)
  if (KIT === "party") haul0 = list<HaulAgent>((await opCall("hauling", { top: 20 }) as { agents?: unknown } | null)?.agents);
  // 上一班的最后一次摘要 (派对: 和上一次摘要比, 含接着的那一班): 接存档时从它的记录目录读回
  if (KIT === "party" && values.save) { try { const last = JSON.parse(fs.readFileSync(path.join(path.dirname(values.save), "digest.jsonl"), "utf8").trim().split(/\r?\n/).at(-1)!); if (last.facts) { digestPrev = last.facts; digestSource = last.source ?? ""; } } catch { /* 上一班没有摘要 */ } }
  log(`就绪: 游戏窗口已连上; 大脑目录 ${brainDir}; 记录 ${runDir}; 截止 ${values.minutes} 分钟; 阵容 ${agents.map((a) => `${a.id.toUpperCase()}=${a.brain}/${a.model}`).join(" ")} 强度 ${values.effort}`);
  if (KIT === "party") setInterval(() => void pollHuman(), 5000).unref(); // 窗口一连上就开始听 (原来放在开班扫描之后, 这段真人说话要等半分钟)

  if (values.dry) {
    // 只核对 fp / fh 入口能在大脑目录里用 (Git Bash), 不叫大脑。每个角色的目录都试 (第十轮: 只试了 B 的目录, A 的 ./fh 每条都失败没发现)
    const { execFileSync } = await import("node:child_process");
    let bad = 0;
    for (const a of agents) for (const c of KIT === "party" ? ["./fh doctor", "./fh help building", "./fh call status", "./fh say '测试: 铁板放在 (10,-20)'"] : ["./fp status", "./fp describe move_to", "./fp observe '{\"radius\":8}'"]) {
      let out: string;
      try { out = execFileSync(bashExe(), ["-c", c], { cwd: a.dir, encoding: "utf8", timeout: 60_000 }); } catch (e) { bad++; out = `失败: ${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? (e as Error).message}`; }
      log(`${tag(a) || "角色"} $ ${c}
${out.slice(0, 600)}`);
    }
    log(`干跑: ${bad ? `${bad} 条命令失败` : "每个角色的命令都通过"}`);
    if (GOAL === "belts") log(`供料检查: ${JSON.stringify(await supplyCheck())}`);
    stop = true;
  }
  const hWho = () => agents[0]?.who ?? 1; // 第 1 个角色的身份 (派对配置下玩家没有身体, 不能用玩家 1)
  let h = new Harness(lab.rcon!, hWho());
  // 停班时角色也立刻停: 暂停常驻命令、停掉当前动作
  async function haltCharacters() {
    if (KIT !== "party" || !lab.rcon) return;
    for (const a of agents) {
      const ha = new Harness(lab.rcon, a.who);
      for (const [action, args] of [["orders_pause", {}], ["stop", {}]] as [string, Record<string, unknown>][]) await ha.request(action, args).catch(() => null);
    }
    log("停班: 各角色的常驻命令已暂停, 当前动作已停");
  }
  monitor = setInterval(async () => {
    try {
      // 中途要停 (例: harness 修好了要重开): 在记录目录放一个 STOP 文件 → 存档收尾 (Windows 上没法给后台 node 发 Ctrl+C, 强关会跳过存档和清理)
      if (fs.existsSync(path.join(runDir, "STOP")) && !stop) { stop = true; log("看到 STOP 文件, 收尾"); killAll(); await haltCharacters(); }
      // 科技到手就告诉模型该用了 (src/play/milestones.ts): 机器人这些模型自己想不起来, 用户也不用特意提醒
      if (!stop && KIT === "party" && lab.rcon) {
        try {
          for (const m of dueMilestones(normalizeMilestone(await lab.exec(MILESTONE_LUA)), milestonesSaid)) {
            log(`监工 (科技): ${m.text}`);
            for (const a of agents) if (!a.left) await tellAgent(a, `监工 (只给事实): ${m.text}`);
          }
        } catch (e) { log(`查科技进度失败: ${(e as Error).message.slice(0, 120)}`); }
      }
      // 中途加人 / 移出 (控制接口写 roster.jsonl, src/play/roster-live.ts); 轮次循环开起来之后才处理
      if (!stop && loops.length) {
        const r = readRosterOps(path.join(runDir, ROSTER_OPS), rosterAt);
        rosterAt = r.next;
        for (const op of r.ops) await applyRosterOp(op).catch((e) => log(`名单变更失败 (${op.op}): ${(e as Error).message.slice(0, 160)}`));
      }
      // 看门狗: 进程在且 10 秒内能 ping 通才算活; 死了就不采样 (下面每条都会报错), 到门槛就恢复 (恢复期间的采样跳过)
      if (recovering) return;
      const alive = lab.alive && await Promise.race([lab.rpc("ping", {}, { timeoutMs: 10_000 }).then(() => true), sleep(12_000).then(() => false)]).catch(() => false);
      const verdict = observe(watch, alive, Date.now());
      if (verdict !== "ok") {
        if (verdict === "recover" && !stop) { recovering = true; recoverGame(lab.alive ? "RCON 没响应" : "服务器进程退出", () => { h = new Harness(lab.rcon!, hWho()); }).finally(() => { recovering = false; }); }
        else if (verdict === "gave-up" && !stop) { stop = true; log("看门狗: 这一班恢复次数用完, 收尾"); killAll(); }
        else log(`看门狗: 服务器${lab.alive ? "没响应" : "不在"} ${Math.round((Date.now() - watch.downSince) / 1000)} 秒`);
        writeWatchdogFile();
        return;
      }
      // 游戏窗口的事放在采样之前 (2026-11-05 沙盘核实时发现: 窗口关掉后采样抛错, 后面的判断整轮跑不到, 窗口关了 / 崩了都没人管):
      // 窗口崩了: 窗口里的玩家 = 角色 A,
      // 掉线后 A 的动作全被拒、只能干等。掉线超过 60 秒就重开窗口 (旧进程还在先关, 配置目录同一个), 至少隔 3 分钟
      const online = Number(await lab.exec(`return #game.connected_players`).catch(() => 1));
      const quit = online >= 1 || values.dry || stop ? null : viewer.normalQuit();
      if (online >= 1 || values.dry) offlineSince = 0;
      else if (quit) {
        // 用户自己关了游戏窗口 (日志 "Quitting: window closed." / "user-quit.") = 要停班 (backlog #294):
        // 写 STOP 文件 (和界面"停班"一样: 存档收尾, 换班程序看到 stoppedBy STOP 不开下一班), 不重开窗口。崩掉的 (显卡挂了、进程被杀) 没有那一行, 仍走下面的重开
        log(`游戏窗口被关掉 (${quit}): 当作停班, 存档收尾, 不重开窗口`);
        fs.writeFileSync(path.join(runDir, "STOP"), `游戏窗口被关 (${quit})\n`);
        stop = true; killAll(); await haltCharacters();
      }
      else if (!offlineSince) offlineSince = Date.now();
      else if (Date.now() - offlineSince > 60_000 && Date.now() - lastRelaunch > 180_000 && !stop) {
        lastRelaunch = Date.now(); viewerRelaunches++;
        log(`游戏窗口掉线 ${Math.round((Date.now() - offlineSince) / 1000)} 秒 (A 的动作会被拒), 重开窗口 (第 ${viewerRelaunches} 次)`);
        if (viewer.alive) { viewer.close(); await sleep(3000); }
        viewer.launch(lab.gamePort, { repoMods: MODS });
      }
      const s = await sample(h);
      samples.push(s);
      // 窗口掉线重连、或用户重新加入后又带了身体: 收掉 (src/play/observer.ts)
      if (ALL_BOTS && lastRaw && (lastRaw as { punit?: number }).punit) await observeOnly();
      // 开班和平到点 (src/play/peace.ts): 关掉, 记下用完了, 告诉全队当时的读数; 快到了提醒一次
      const peaceEvent = peaceTick(PEACE, Date.now());
      if (peaceEvent) {
        if (peaceEvent === "end") {
          await lab.exec(`game.surfaces[1].peaceful_mode = false return true`);
          if (GROUP) setPeacefulMinutes(path.join(labRoot(), "play"), GROUP.id, 0);
        }
        const enemy = normalizeScan(await lab.exec(SCAN_LUA).catch(() => null)).enemy;
        const msg = peaceText(peaceEvent, peaceLeftMs(PEACE, Date.now()), enemy);
        log(`和平期: ${msg}`);
        for (const a of agents) { if (running(a)) await tellAgent(a, msg); else a.nudge = (a.nudge ?? "") + msg; }
      }
      // 死亡计数: 累计数涨了就记 deaths.jsonl、告诉大脑 (和平模式的沙盘不会涨; 联机 / 有虫的世界才有)
      if (typeof s.deaths === "number") {
        if (deaths0 === null) deaths0 = s.deaths;
        if (lastDeaths !== null && s.deaths > lastDeaths) {
          lastDeaths = s.deaths; lastDeathAt = new Date().toISOString();
          const n = deathsShift();
          fs.appendFileSync(path.join(runDir, "deaths.jsonl"), JSON.stringify({ at: lastDeathAt, tick: s.tick, total: s.deaths, shift: n }) + "\n");
          const msg = `有角色死了 (本班第 ${n} 次, 游戏时间 ${(s.tick / 3600).toFixed(0)} 分钟): 先弄清是什么杀的 (虫子 / 火车 / 自己的炮塔 / 没电的防线), 复活后回去捡尸体里的背包, 再决定要不要补防御。`;
          for (const a of agents) { if (running(a)) await tellAgent(a, msg); else a.nudge = (a.nudge ?? "") + msg; }
          log(`死亡: 本班第 ${n} 次 (累计 ${s.deaths})`);
        }
        lastDeaths = s.deaths;
      }
      writeWatchdogFile();
      // harness 运行时出错被隔离 (第四轮: 大脑动不了 5 分钟才发现): 记调用栈, 自动解除 (最多 5 次), 打断各角色这一轮并说明
      const fault = await lab.exec(`return remote.interfaces["agent_harness_pilot"] and remote.call("agent_harness_pilot", "fault") or nil`).catch(() => null) as { tick?: number; message?: string } | null;
      if (fault && fault.message) {
        faults.push(fault);
        fs.appendFileSync(path.join(runDir, "faults.jsonl"), JSON.stringify(fault) + "\n");
        log(`harness 出错被隔离 (第 ${faults.length} 次, tick ${fault.tick}): ${fault.message.split("\n")[0].slice(0, 160)}`);
        if (faults.length <= 5) {
          await lab.exec(`remote.call("agent_harness_pilot", "clear_fault") return true`);
          const msg = "操作通道刚才出错被隔离过, 现在已恢复, 可以继续 (出错时正在做的动作被停了, 需要的话重新发)。";
          // --stream: 插进正在跑的一轮, 不杀进程 (没在跑的留到下一轮提示); 一轮一进程时打断这一轮
          for (const a of agents) { if (STREAM) { if (!a.stream?.steer(`监工: ${msg}`)) a.nudge = (a.nudge ?? "") + msg; } else { a.nudge = (a.nudge ?? "") + msg; a.child?.kill(); } }
          log(STREAM ? "已自动解除隔离, 告诉大脑 (插话)" : "已自动解除隔离, 叫醒大脑");
        } else log("出错超过 5 次, 不再自动解除");
      }
      // 研究自动续上 (用户硬要求; M6): 研究中心空了 1 分钟且队列也空 → 按场上在产的瓶选最便宜的排上 (和平模式跳过军事类), 告诉大脑它随时可改; 没有能排的就说明缺哪种瓶
      researchIdle = s.research ? 0 : researchIdle + 1;
      if (researchIdle >= 2 && Date.now() - lastAutoResearch > 300_000 && !stop) {
        lastAutoResearch = Date.now();
        try {
          const st = normalizeResearch(await lab.exec(RESEARCH_LUA));
          if (!PEACEFUL) st.peaceful = false; // 开班和平那段时间读到和平开着, 但这个世界有虫子, 军事科技照排
          if (!st.current && st.queue === 0) {
            const { pick, usable, producing } = pickResearch(st);
            let msg: string;
            if (pick) {
              // 一次排最便宜的 3 项: 第三班验证时只排 1 项 (lamp), 研究完队列又空, 5 分钟冷却内不会再排
              const picks = usable.slice(0, 3);
              const okList: string[] = [];
              for (const p of picks) { const ok = (await lab.exec(`return game.forces.player.add_research(${luaString(p.name)})`)) === true; autoResearch.push({ at: new Date().toISOString(), tech: p.name, ok }); if (ok) okList.push(p.name); }
              msg = `研究中心空了约 ${Math.round(researchIdle / 2)} 分钟, 监工已排上 ${okList.map((n) => `${zh(n)} (要 ${picks.find((p) => p.name === n)!.packs.map(zh).join("、")})`).join("、")}; 想研究别的就自己改队列。`;
              log(`监工: 研究队列空, 自动排上 ${okList.join(", ")}${okList.length < picks.length ? ` (${picks.length - okList.length} 项失败)` : ""}`);
            } else {
              const trig = st.triggers.slice(0, 3).map((t) => triggerText(t, zh)).join("; ");
              autoResearch.push({ at: new Date().toISOString(), tech: null, ok: false, note: trig ? `下一步靠触发: ${st.triggers.map((t) => t.name).join(",")}` : `在产的瓶 ${producing.join(",")} 能研究的都研究完了` });
              msg = trig
                ? `研究中心空了: 现在没有能用研究中心研究的科技, 下一步科技靠做事触发 —— ${trig}。`
                : `研究中心空了: 用场上在产的瓶 (${producing.map(zh).join("、")}) 能研究的都研究完了, 要继续研究得先产下一种瓶。`;
              log(`监工: 研究队列空, 没有能排的 (${trig ? `触发型: ${st.triggers.map((t) => t.name).join(", ")}` : `在产: ${producing.join(", ")}`})`);
            }
            for (const a of agents) { if (running(a)) await tellAgent(a, msg); else a.nudge = (a.nudge ?? "") + msg; }
          }
        } catch (e) { log(`自动排研究失败: ${(e as Error).message.slice(0, 120)}`); }
      }
      // 扩产提案 (确定性步骤优先, 大脑只执行): 按产量读数定下一档, 计算器算差额, 减掉场上已有的, 派具体任务;
      // 机器齐了产量没到就说"瓶颈不在机器数"。开班 5 分钟后第一条 (要有 10 分钟产量读数才准, 第一条按 0 算也没错: 第一档就是 30/30); 之后每 15 分钟复核, 没补齐 20 分钟重发
      // 2026-11-05 降频 (原来没补齐 20 分钟重发、补齐 15 分钟复核; 第 5 班每个大脑收 48~66 条监工消息, 派对的摘要一班才一次)
      if (Date.now() - t0 >= 5 * 60_000 && Date.now() - lastProposalAt >= (proposal && !proposal.done ? 40 : 30) * 60_000 && !stop) {
        lastProposalAt = Date.now();
        try {
          gdCalc ??= loadGameData();
          const ex = normalizeExisting(await lab.exec(EXISTING_LUA));
          const now = { red: perMin("redTotal"), green: perMin("greenTotal"), blue: perMin("blueTotal") };
          const p = propose(gdCalc, ex, now, proposal && !(proposal.done && (expansions.at(-1)?.reached ?? false)) ? proposal.rung : null, lastHealth, zh);
          proposal = { rung: p.rung, done: p.done };
          const rec = { at: new Date().toISOString(), rung: p.rung, now, done: p.done, reached: p.reached, deltas: p.deltas };
          expansions.push(rec);
          fs.appendFileSync(path.join(runDir, "expand.jsonl"), JSON.stringify(rec) + "\n");
          // 算好的放置命令只给最闲的一个, 别人知道有人接了 (一起发就会抢着放同一块)
          const steps = p.done ? [] : await placementSteps(p.deltas, bpEntries(), zh, (w, h, taken) => lab.exec(siteLua(null, w, h, taken)) as Promise<{ found?: boolean; x?: number; y?: number } | null>).catch((e: Error) => { log(`放置命令没算成: ${e.message.slice(0, 120)}`); return [] as string[]; });
          const free = steps.length ? [...agents].filter((a) => !a.left).sort((x, y) => y.idle - x.idle)[0] : null;
          for (const a of agents) {
            const msg = !free ? p.message : a === free ? `${p.message}\n算好的放置命令 (从基地中心往外找的空地; 缺料它自己拿和手搓; 这几块归你, 用不用你定):\n${steps.join("\n")}` : `${p.message}\n放置命令已发给 ${nameOfSeat(free)}, 别重复放; 你手上的事接着做。`;
            if (running(a)) await tellAgent(a, msg); else a.nudge = (a.nudge ?? "") + msg;
          }
          if (free) log(`监工: 放置命令发给 ${nameOfSeat(free)}: ${steps.join(" ; ").slice(0, 200)}`);
          log(`监工: 扩产提案 (目标 红 ${p.rung.red} / 绿 ${p.rung.green} / 蓝 ${p.rung.blue}; ${p.done ? (p.reached ? "机器齐、产量到" : "机器齐但产量没到") : `差 ${p.deltas.filter((d) => d.add > 0).map((d) => `${d.key}+${d.add}`).join(" ")}`})`);
        } catch (e) { log(`扩产提案没算成: ${(e as Error).message.slice(0, 160)}`); }
      }
      // : 这段原来只在 --goal grow 开, 派对配置默认 goal 是 red, 所以 B / C / D 站在出生点分析了 10 分钟没人催 → 派对配置也开
      if (GOAL === "grow" || KIT === "party") {
        // 闲了 3 分钟 (6 次采样), 开局宽限 3 分钟, 同一角色两次提醒至少隔 5 分钟:
        // 大脑这一轮还在跑 → 写进收件箱, 它下一个动作时看到, 不打断 (第六轮: A 想了 3 分钟怎么铺带子, 被打断后想的全白费;
        // 派对是站着超过 10 分钟才发私信, 也不打断); 闲到 10 分钟还没动才打断; 这一轮已经结束 (防空转在等) → 由 nudge 马上叫醒
        for (const a of agents) {
          a.idle = s.busyBy?.[a.id] ? 0 : a.idle + 1;
          if (!a.idle) a.idleSteered = false;
          // 2026-11-05 照派对 (tools/idle_nudge.py:875-876): 站 10 分钟才提醒, 同一角色隔 20 分钟; 他们研究 15 条提醒里 5 条没进上下文、1 条只改变行为 2 分钟 (docs/studies/2026-10-13-agent-minds.md)。
          // 只有还站在出生点的 3 分钟就说 (服务器角色出生在 (0,0) 附近, 基地在别处; )
          const atSpawn = !!a.prev && Math.hypot(a.prev.x, a.prev.y) < 12;
          if (a.idle >= (atSpawn ? 6 : 20) && Date.now() - t0 > 180_000 && Date.now() - a.lastNudge > 20 * 60_000) {
            a.lastNudge = Date.now(); nudges++;
            const msg = `你的角色已经闲了约 ${Math.round(a.idle / 2)} 分钟 (没走、没手搓、背包没变)。思考时角色站着不动: 先把能一口气执行的步骤排进计划队列再想下一步。${atSpawn ? " 你还站在出生点 (0,0) 附近, 基地不在这里: 先 ./fh call map 看基地在哪, 走过去再动手; 光看读数不建东西没有产出。" : ""}${hint(["闲了"], 1)}`;
            if (running(a)) { await tellAgent(a, msg); log(`监工: ${tag(a) || "角色"} 闲了 ${Math.round(a.idle / 2)} 分钟, 写进收件箱`); }
            else { a.nudge = msg; log(`监工: ${tag(a) || "角色"} 闲了 ${Math.round(a.idle / 2)} 分钟, 叫醒`); }
          }
          // 打断这一轮从闲 10 分钟改到 30 分钟, 只防真卡死 (派对不杀; 它在想或在等长任务时打断会白费)
          if (a.idle >= 60 && running(a)) {
            // --stream: 先插话 (不打断, 想到一半的不丢); 插过话又闲了 5 分钟还没动才打断 (杀进程, 下一轮 --resume 接回会话)
            if (STREAM && !a.idleSteered) {
              a.idleSteered = !!a.stream?.steer(`监工 (只给事实): 你的角色已经闲了约 ${Math.round(a.idle / 2)} 分钟 (没走、没手搓、背包没变)。${facts(s)}`);
              if (a.idleSteered) log(`监工: ${tag(a) || "角色"} 闲了 ${Math.round(a.idle / 2)} 分钟, 插话 (不打断)`);
            } else if (!STREAM || a.idle >= 70) { log(`监工: ${tag(a) || "角色"} 闲了 ${Math.round(a.idle / 2)} 分钟, 打断这一轮`); a.nudge = `你的角色已经闲了约 ${Math.round(a.idle / 2)} 分钟。`; a.idle = 0; a.idleSteered = false; a.child?.kill(); }
          }
        }
        // 没算过配比 (2026-11-04 #251: 18 班里 ./calc 只有 14 次): 开班 15 分钟和 35 分钟各提醒一次 (写进收件箱, 不打断); ./calc 每次调用往角色目录的 .calc.log 记一行
        for (const a of agents) {
          const calls = (() => { try { return fs.readFileSync(path.join(a.dir, ".calc.log"), "utf8").split(/\r?\n/).filter(Boolean).length; } catch { return 0; } })();
          const due = calcReminderDue((Date.now() - t0) / 60_000, calls, calcReminded.get(a.id) ?? 0);
          if (due) {
            calcReminded.set(a.id, due);
            const msg = `开班 ${due} 分钟了, 你还没用 ./calc 算过配比。建线 / 扩产前先算要几台机器、吃多少料 (例: ./calc '{"targets":{"automation-science-pack":30}}'), 不算就铺是最常见的浪费; 要点在 AGENTS.md "开工前必记的要点"。`;
            if (running(a)) { await tellAgent(a, msg); log(`监工: ${tag(a) || "角色"} ${due} 分钟没算过配比, 写进收件箱`); }
            else { a.nudge = (a.nudge ?? "") + msg; log(`监工: ${tag(a) || "角色"} ${due} 分钟没算过配比, 下一轮提醒`); }
          }
        }
        // 真人的话要回 (src/play/replies.ts):
        // ① 界面发的话 (control.ts 记 tells.jsonl) 2 分钟没见回话 (operator / chat_ack) → 催被点名的那个, 每条一次;
        // ② 游戏聊天里的点名 / 没确认的私信 (模组 mention_counts) 持续 2 分钟没读 → 催, 5 分钟后还没读再催
        if (KIT === "party") {
          try { scanToolRequests(); } catch (e) { log(`查工具诉求出错: ${(e as Error).message.slice(0, 120)}`); }
          try {
            const tells = readTells(path.join(runDir, "tells.jsonl"));
            for (const u of unansweredTells(tells, (id) => { const x = agents.find((y) => y.id === id); return x ? journalToRequests(path.join(x.dir, "journal.jsonl"), id) : []; }, Date.now(), tellNudged)) {
              const a = agents.find((x) => x.id === u.agent);
              tellNudged.add(u.key);
              if (!a) continue;
              replyNudges++;
              const msg = u.source === "game"
                ? `玩家 ${u.from} ${u.ageMin} 分钟前在游戏聊天说的话还没人回: "${u.text}"。手上这步做完就回一句 (./fh say "@${u.from} …"): 做了什么 / 打算怎么做 / 做不了的原因。`
                : `管理员 ${u.ageMin} 分钟前说的话还没人回: "${u.text}"。手上这步做完就回一句 (./fh call operator --args '{"text":"…"}'): 做了什么 / 打算怎么做 / 做不了的原因。`;
              if (running(a)) { await tellAgent(a, msg); log(`监工: ${tag(a) || "角色"} ${u.ageMin} 分钟没回管理员的话, 写进收件箱`); }
              else { a.nudge = (a.nudge ?? "") + msg; log(`监工: ${tag(a) || "角色"} ${u.ageMin} 分钟没回管理员的话, 下一轮提醒`); }
            }
            const counts = list<MentionCount>(await opCall("mention_counts", {}));
            for (const m of mentionNudges(counts, s.tick, mentionState)) {
              const a = agents.find((x) => (typeof x.who === "string" ? x.who : playerName) === m.name);
              if (!a) continue;
              replyNudges++;
              const msg = `游戏聊天里有人点你的名 / 给你私信 (${m.mentions + m.unacked} 条, 最早约 ${m.waitedMin} 分钟前), 还没读没回: 手上这步做完就 ./fh chat 看, 回复点对方的名字 (./fh say "@名字 …")。`;
              if (running(a)) { await tellAgent(a, msg); log(`监工: ${tag(a) || "角色"} 聊天里被点名 ${m.waitedMin} 分钟没回, 写进收件箱`); }
              else { a.nudge = (a.nudge ?? "") + msg; log(`监工: ${tag(a) || "角色"} 聊天里被点名 ${m.waitedMin} 分钟没回, 下一轮提醒`); }
            }
          } catch (e) { log(`监工查"没回的话"出错: ${(e as Error).message.slice(0, 120)}`); }
        }
        // 产能停滞 (第五轮: 两个角色都在忙, 6 台研究中心只有 2 台在工作十几分钟, 监工只看闲置所以没提醒):
        // 研究中心一半以上停着 5 分钟 → 事实写进各角色收件箱 (钩子在它下一次工具调用后塞进去, 不打断这一轮), 至少隔 10 分钟
        stallSamples = s.labs > 0 && s.labsWorking * 2 < s.labs ? stallSamples + 1 : 0;
        if (stallSamples >= 10 && Date.now() - lastStall > 600_000) {
          lastStall = Date.now(); stalls++;
          // 点名管科研的人 (多角色时 B), 说清要哪几种瓶、研究中心里各剩多少、每分钟产量和上一班比
          const owner = agents.length > 1 ? agents[1] : agents[0];
          const msg = `监工点名 (研究中心停了, 归你管): ${s.labs} 台只有 ${s.labsWorking} 台在工作, 已约 ${Math.round(stallSamples / 2)} 分钟。${await labFacts()} ${nowRatesLine()}。先补缺的那种瓶: ./fh call bottleneck 圈住它那排看缺什么, ./calc 倒推要几台机器, 用机器做, 不手搓中间件。${await bottleneckFacts(h)}${hint(["研究中心停"])}`;
          await tellAgent(owner, msg);
          for (const a of agents) if (a !== owner) await tellAgent(a, `监工: 研究中心停了 (${s.labsWorking}/${s.labs}), 归 ${tag(owner) || "队友"} 修; 他要哪条板子带会叫你。`);
          log(`监工: 研究中心 ${s.labsWorking}/${s.labs} 在工作, 停滞约 ${Math.round(stallSamples / 2)} 分钟, 写进收件箱`);
        }
        // 缺燃料 (第六轮: 切 5 倍速后第二电站两台锅炉没煤、4 台蒸汽机停了, 用户看截图才发现): 锅炉缺燃料马上说, 别的 (炉子、燃烧采矿机) 够 3 台才说, 至少隔 5 分钟
        const noFuel = (await lab.exec(`local out = {} for _, e in pairs(game.surfaces[1].find_entities_filtered{type = {"boiler", "furnace", "mining-drill", "burner-generator"}, force = game.forces.player}) do
            if e.status == defines.entity_status.no_fuel then out[#out + 1] = {name = e.name, boiler = e.type == "boiler", at = string.format("%.1f,%.1f", e.position.x, e.position.y)} end
            if e.status == defines.entity_status.no_minable_resources then out[#out + 1] = {name = e.name, depleted = true, at = string.format("%.1f,%.1f", e.position.x, e.position.y)} end end return out`).catch(() => [])) as { name: string; boiler?: boolean; depleted?: boolean; at: string }[];
        const all = Array.isArray(noFuel) ? noFuel : Object.values(noFuel ?? {});
        // 采空的采矿机 (第六轮: 锅炉那条送煤带的煤矿采完了, 带子是空的, 没人发现): 比上次报的多了才说
        const dep = all.filter((e) => e.depleted);
        if (dep.length > lastDepleted && Date.now() - lastDepTime > 300_000) {
          lastDepleted = dep.length; lastDepTime = Date.now();
          const msg = `采矿机采空了 ${dep.length} 台 (脚下没矿, 它供的那条带子会变空): ${dep.slice(0, 8).map((e) => `(${e.at})`).join("、")}${dep.length > 8 ? " …" : ""}。挪到新矿上, 或者换矿区。${hint(["采空"], 1)}`;
          for (const a of agents) await tellAgent(a, msg);
          log(`监工: ${msg.slice(0, 120)}`);
        }
        // 变量不能叫 list: 会挡住下面摘要用的 digest.ts 的 list(); 2026-11-04 --brain none 整班验证时发现 "list is not a function", 半班摘要和手搬统计从没发出去过
        const short = all.filter((e) => !e.depleted);
        if ((short.some((e) => e.boiler) || short.length >= 3) && Date.now() - lastFuel > 300_000) {
          lastFuel = Date.now();
          const msg = `缺燃料 ${short.length} 台${short.some((e) => e.boiler) ? " (含锅炉 → 发电要停)" : ""}: ${short.slice(0, 8).map((e) => `${zh(e.name)} (${e.at})`).join("、")}${short.length > 8 ? " …" : ""}。${hint(["缺燃料"], 1)}`;
          for (const a of agents) await tellAgent(a, msg);
          log(`监工: ${msg.slice(0, 120)}`);
        }
        // --kit party: 每 10 分钟发手搬统计 (派对的"让手搬变成看得见的事实": 产量记到建造者名下后 84~95% 由机器运送; 第十三轮 0 条传送带、手搬 250 多次)
        // 11-03 起: 每 10 分钟只发产量一句 (每班硬指标); 按负责人发的工厂摘要 (src/play/digest.ts, 搬自派对 factory_digest.py) 照派对每班自动发一次
        // (他们在截止前 2 小时, 一班好几个小时; 我们一班 60 分钟 → 班中), 只发和上一次摘要 (含上一班的) 比有变化的、归你管的, 加你这一班重复最多的手搬。
        // 产量播报: 每 10 分钟 → 每 30 分钟 (2026-11-05 降频)
        const belts = KIT === "party" && (samples.length % 60 === 0 || (!digestSent && Date.now() - t0 >= (deadline - t0) / 2)) ? Number(await lab.exec(`local f = game.forces.player return game.surfaces[1].count_entities_filtered{force = f, type = {"transport-belt", "underground-belt", "splitter"}}`).catch(() => -1)) : -1;
        // 工具诉求 (派对每 90 分钟问一次: how/operations.md, 633 条诉求修出大半个 harness; 我们之前一条没收过): 大脑回 operator, 班末捞进 tool-requests.md
        if (KIT === "party" && Date.now() - lastToolPoll >= 90 * 60_000) {
          lastToolPoll = Date.now();
          for (const a of agents) await tellAgent(a, TOOL_POLL);
          log("监工: 问了一次工具诉求");
        }
        if (KIT === "party" && samples.length % 60 === 0) {
          // 扩产量化 (第 3 班两人 50 分钟只建了 44 次, 查询占 82%): 播报这一班新增了几台生产机器
          const m0 = samples[0]?.machines ?? 0, mNow = s.machines ?? 0;
          const ago = samples.find((x) => x.t >= Date.now() - 20 * 60_000);
          const grew20 = ago ? mNow - (ago.machines ?? mNow) : 1;
          for (const a of agents) await tellAgent(a, `监工 (只给事实): ${nowRatesLine()}; 这一班新增生产机器 ${mNow - m0} 台 (开班 ${m0} → 现在 ${mNow}); 场上传送带 ${belts} 个。`);
          log(`监工: 产量播报已发 (新增机器 ${mNow - m0}, 近 20 分钟 ${grew20}, 传送带 ${belts})`);
          // 不扩产就点名: 开班 20 分钟后, 近 20 分钟没新增一台生产机器, 而产量比上一班低或研究中心一半以上停着 → 两人各扩自己那块, 至少隔 20 分钟
          const nowR = { red: perMin("redTotal"), green: perMin("greenTotal"), blue: perMin("blueTotal") };
          const behind = s.labsWorking * 2 < s.labs || (prevRates ? (["red", "green", "blue"] as const).some((k) => prevRates[k] !== null && nowR[k] < prevRates[k]!) : false);
          if (Date.now() - t0 > 20 * 60_000 && grew20 <= 0 && behind && Date.now() - lastGrowNudge > 20 * 60_000) {
            lastGrowNudge = Date.now(); growNudges++;
            for (const a of agents) await tellAgent(a, `监工点名 (近 20 分钟没新增一台生产机器, 产量没达标): 先扩产再做别的。${a === agents[0] ? "你管冶炼和采矿: 按 ./calc 算出的板子量补炉子 (电炉) 和采矿机" : "你管科技包线: ./calc 按每分钟 30 个倒推最缺那种瓶 (现在看蓝瓶、红瓶) 还差几台组装机, 建上"}; 有建设机器人就整块贴蓝图让机器人建, 别手搓中间件、别连着查状态。${hint(a === agents[0] ? ["没扩产", "加炉子"] : ["没扩产", "加组装机"], 2, true)}`);
            log("监工点名: 近 20 分钟没扩产");
          }
        }
        if (KIT === "party" && !digestSent && Date.now() - t0 >= (deadline - t0) / 2) {
          digestSent = true;
          const report = (await opCall("factory_digest", {})) as Report | null;
          const claims = list<Claim>((await opCall("board", { kind: "claim", limit: 100 }) as { items?: unknown } | null)?.items);
          const nameOf = (a: Agent) => (typeof a.who === "string" ? a.who : playerName);
          const base = [nameOf(agents[0])], sci = [nameOf(agents.length > 1 ? agents[1] : agents[0])];
          const roleOf = (type: string) => (type === "assembling-machine" || type === "lab" ? sci : base);
          // 普查有数据用普查 (每种机器、带坐标); 过期了用最近一次体检 (factsFromHealth); 数据来源换了就当第一次 (不把"换来源"误报成"已解决")
          const fromSurvey = list(report?.surfaces).length > 0;
          const cur = fromSurvey ? currentFacts(report!, claims, roleOf, zh) : healthObj ? factsFromHealth(healthObj, claims, roleOf, zh) : null;
          const source = fromSurvey ? "普查" : "体检";
          if (source !== digestSource) digestPrev = null;
          const rows = cur ? delta(digestPrev, cur) : [];
          if (cur) { digestPrev = cur; digestSource = source; }
          const hauls = shiftHauls(haul0, list<HaulAgent>((await opCall("hauling", { top: 20 }) as { agents?: unknown } | null)?.agents));
          let sent = 0;
          for (const a of agents) {
            const text = digestText(nameOf(a), rows, haulLine(hauls.find((h) => h.name === nameOf(a)), zh), `监工摘要 (只发和上次比有变化的、归你管的${claims.length ? ", 按公告板认领区域" : "; 公告板上还没有认领, 按分工"}): ${nowRatesLine()}; 场上传送带 ${belts} 个。`);
            if (text) { await tellAgent(a, text); sent++; }
          }
          fs.appendFileSync(path.join(runDir, "digest.jsonl"), JSON.stringify({ t: Date.now(), tick: report?.tick, source: digestSource, claims: claims.length, facts: cur, rows, hauls: hauls.map((h) => ({ name: h.name, items: h.items, top: h.hauls?.[0] })) }) + "\n");
          log(`监工: 工厂摘要已发 ${sent} 人 (数据: ${digestSource}, 变化 ${rows.length} 条, 认领 ${claims.length} 个, 传送带 ${belts})`);
        }
        // 基地体检 (src/play/health.ts): 每 5 分钟一次,
        // 有问题写进收件箱 (内容变了才写, 至少隔 10 分钟重复一次), 记 health.jsonl; 放了 5 分钟以上还没建的虚影单独报
        if (samples.length % 10 === 0) {
          const raw = (await lab.exec(HEALTH_LUA).catch(() => null)) as Health | null;
          const hc = raw && normalizeHealth(raw);
          if (hc) healthObj = hc; // 工厂摘要的后备 (普查过期时)
          if (hc) {
            const now = Date.now();
            for (const g of hc.ghosts ?? []) if (!ghostSeen.has(g.key)) ghostSeen.set(g.key, now);
            const live = new Set((hc.ghosts ?? []).map((g) => g.key));
            for (const k of [...ghostSeen.keys()]) if (!live.has(k)) ghostSeen.delete(k);
            const old = (hc.ghosts ?? []).filter((g) => now - (ghostSeen.get(g.key) ?? now) >= 300_000);
            const lines = healthLines(hc, old, zh);
            lastHealth = lines;
            fs.appendFileSync(path.join(runDir, "health.jsonl"), JSON.stringify({ t: now, tick: hc.tick, lines }) + "\n");
            const text = lines.join("\n");
            // 派对配置: 只在内容变了才发 (摘要每 10 分钟按人发变化, 一直没修的由点名管; 不再每 10 分钟重发整张清单)
            // 派对配置: 只在出现新一类问题才发, 或 30 分钟发一次全貌 (原来内容一变就发, 第 5 班 36 次; 2026-11-05 降频)
            const cats = lines.map(healthCategory);
            const freshCat = cats.some((c) => !healthCats.has(c));
            healthCats = new Set(cats);
            if (lines.length && (KIT === "party" ? freshCat || now - lastHealthAt > 1_800_000 : text !== lastHealthText || now - lastHealthAt > 600_000)) {
              lastHealthText = text; lastHealthAt = now;
              for (const a of agents) await tellAgent(a, `监工体检 (只给事实, 5 分钟后再查):\n${text}`);
              log(`监工体检: ${lines.length} 类问题`);
            }
            try { await checkLayout(); } catch (e) { log(`电线杆 / 水管检查失败: ${(e as Error).message.slice(0, 160)}`); }
            if (Date.now() - lastLessonMerge >= 600_000) { lastLessonMerge = Date.now(); await mergeLessonsNow(false); }
            // 带子 Z 字弯 (src/play/belt-lint.ts): 第一次只记基线 (接手的老东西不算这班的账), 之后新出现、前方又是空地的报坐标; 写 belt-jogs.json 给复盘
            try {
              const jogs = normalizeJogs(await lab.exec(BELT_JOGS_LUA));
              fs.writeFileSync(path.join(runDir, "belt-jogs.json"), JSON.stringify(jogs));
              const fresh = newJogs(jogs.list, jogSeen);
              if (jogBaselined && fresh.length) {
                const note = jogNote(fresh);
                for (const a of agents) await tellAgent(a, `监工 (只给事实): ${note}`);
                log(`监工: ${note.slice(0, 120)}`);
              }
              jogBaselined = true;
            } catch (e) { log(`Z 字弯检查失败: ${(e as Error).message.slice(0, 120)}`); }
            // 一直没修的 (同一类连报 3 次 = 15 分钟):
            // 按分工点名负责的人 (燃料 / 采空 / 堵 / 电 → A, 研究中心 / 缺料 → B), 先修再扩
            const stuck = stuckHealth.update(lines, now);
            for (const own of ["base", "science"] as const) {
              const mine = stuck.filter((x) => healthOwner(x.line) === own);
              if (!mine.length) continue;
              const who = own === "science" && agents.length > 1 ? agents[1] : agents[0];
              await tellAgent(who, `监工点名 (这些已经连续 ${Math.max(...mine.map((x) => x.times)) * 5} 分钟没修, 归你管; 先修完再扩新线):\n${mine.map((x) => x.line).join("\n")}`);
              log(`监工点名 ${tag(who) || "角色"}: ${mine.map((x) => healthCategory(x.line)).join("、")}`);
            }
          }
        }
        const r10 = perMin("redMachine"), g10 = perMin("greenMachine");
        if (r10 >= 30 && !milestones.some((m) => m.startsWith("红瓶"))) { milestones.push(`红瓶 ≥30/分 (游戏 ${(s.tick / 3600).toFixed(1)} 分)`); log(`里程碑: 机器红瓶近 10 分钟 ${r10.toFixed(1)}/分`); }
        if (s.greenMachine > 0 && !milestones.some((m) => m.startsWith("绿瓶"))) { milestones.push(`绿瓶机器开始产出 (游戏 ${(s.tick / 3600).toFixed(1)} 分)`); log("里程碑: 绿瓶机器开始产出"); }
        if (g10 >= 30 && !milestones.some((m) => m.startsWith("绿瓶 ≥30"))) { milestones.push(`绿瓶 ≥30/分 (游戏 ${(s.tick / 3600).toFixed(1)} 分)`); log(`里程碑: 机器绿瓶近 10 分钟 ${g10.toFixed(1)}/分`); }
      }
      fs.appendFileSync(path.join(runDir, "monitor.jsonl"), JSON.stringify(s) + "\n");
      if (GOAL === "belts") {
        // 搬运: fp 日志里新的放入动作, 以及计划队列里执行过 / 正在执行的放入步骤
        const rf = path.join(runDir, "requests.jsonl");
        if (fs.existsSync(rf)) {
          const lines = fs.readFileSync(rf, "utf8").trim().split("\n").filter(Boolean);
          for (const l of lines.slice(reqSeen)) { const r = JSON.parse(l); if (r.ok && !r.wait && isCarry(r.action, r.dir)) lastCarry = Math.max(lastCarry, r.tick ?? s.tick); }
          reqSeen = lines.length;
        }
        const q = await h.request("queue_status").catch(() => null);
        for (const e of q?.result?.history ?? []) if (e.ok && isCarry(e.action, e.result?.direction)) lastCarry = Math.max(lastCarry, e.finished_tick ?? 0);
        if (q?.result?.active && isCarry(q.result.active.action)) lastCarry = s.tick;
      }
      if (s.labsWorking > 0 && s.redMachine > 0) { if (streakStart === null) { streakStart = s.tick; streakRed0 = s.redMachine; } }
      else streakStart = null;
      const from = streakStart === null ? null : Math.max(streakStart, lastCarry);
      const red0 = from === null ? 0 : (samples.find((x) => x.tick >= from)?.redMachine ?? streakRed0);
      let structureOk = true;
      if (GOAL === "belts" && from !== null && s.tick - from >= goalMinutes * 3600) {
        const sc = await supplyCheck();
        supplyNote = sc.rows.join("; ");
        if (sc.bad.length) { structureOk = false; log(`时间够了但不算: ${sc.bad.join("; ")}`); }
      }
      if (GOAL !== "grow" && structureOk && from !== null && s.tick - from >= goalMinutes * 3600 && s.redMachine - red0 >= (GOAL === "belts" ? goalMinutes : 1)) {
        success = true; stop = true; log(`达标: ${GOAL === "belts" ? `原料全走传送带, 角色 ${goalMinutes} 分钟没往机器里放东西, ` : ""}实验室用机器做的红瓶连续研究 ${goalMinutes} 游戏分钟`); killAll();
      }
    } catch (e) { log(`记指标失败: ${(e as Error).message.slice(0, 120)}`); }
  }, 30_000);
  process.on("SIGINT", () => { stop = true; log("收到 Ctrl+C, 收尾"); killAll(); });

  async function agentLoop(a: Agent) {
    for (let n = 1; !stop && !a.left && Date.now() < deadline; n++) {
      a.turns = n; usage.turns = agents.reduce((x, y) => x + y.turns, 0);
      const left = Math.round((deadline - Date.now()) / 60000);
      const first = KIT === "party"
        // 第一句用中文 (第十三轮: 照搬派对的英文开场白, 大脑前 6 分钟 7 句里 5 句英文; 第十二轮同样的中文简报只有 1/13)
        ? `${scanNote}${driverOf(a)?.normalize ? "读这个目录里的 AGENTS.md: 规则、接口、截止时间都在里面。" : "规则和接口已经在你的系统提示里 (AGENTS.md), 不用再读。" /* Claude Code 这边读它会被 read-guard 拦, 11-05 提示词让读又拦下, 每个角色开局白失败一次 */}然后一直玩到 deadline.txt 的截止时间, 随时更新 notes.md, 最后按 AGENTS.md 的要求写总结。${a.joined ? "你是这一班中途加入的新队友: 看 ../team.md 和队友的 notes.md, 接一块没人管的活, 在 team.md 写上你认领了什么。" : values.save ? "这是同一个世界的下一班: 你的角色和工厂保持上一班结束时的样子, notes.md 记着你停在哪。" : ""}${typeof a.who === "string" ? "你的角色出生在 (0,0) 附近, 基地不在这里: 看完扫描就走到基地动手, 别站在出生点分析。" : ""}离截止还有 ${left} 分钟。你说的每一句话都用简体中文。`
        : GOAL === "grow"
        ? `开始。${scanNote}先读 CLAUDE.md 和 notes.md${agents.length > 1 ? " 和 ../team.md (先认领再动手)" : ""}。第一步: 用 ./calc 算这一班的目标配比 (红瓶每分钟 30 个、绿瓶每分钟 30 个), 用 ./bp list 冶炼 看冶炼列; 把计划写进 notes.md 的"计划"一节, 再按计划用蓝图整块建。离截止还有 ${left} 分钟。`
        : `开始。${scanNote}先读 CLAUDE.md 和 notes.md, 再用 ./fp 开始玩。离截止还有 ${left} 分钟。`;
      let prompt = n === 1 ? first : `继续。${facts(samples.at(-1))}离截止还有 ${left} 分钟。`;
      if (n > 1 && a.nudge) { prompt = `监工 (只给事实): ${a.nudge}${await bottleneckFacts(h)} ${facts(samples.at(-1))}离截止还有 ${left} 分钟。继续。`; a.nudge = null; }
      prompt += " (说话和笔记用中文)"; // 简报里写了, 第二、三轮还是说英文
      log(`${tag(a) ? tag(a) + " " : ""}第 ${n} 轮开始`);
      // 截止后再给 3 分钟: 简报要大脑过了截止写最后的总结 (派对 supervise.sh 截止后还要一次总结; 我们以前截止那一刻就杀, 总结一次都没写成)
      const killer = setTimeout(() => a.child?.kill(), Math.max(1000, deadline - Date.now() + (KIT === "party" ? 180_000 : 0)));
      const began = Date.now();
      const code = await turn(a, n, prompt);
      clearTimeout(killer);
      log(`${tag(a) ? tag(a) + " " : ""}第 ${n} 轮结束 (退出码 ${code}, ${((Date.now() - began) / 1000).toFixed(0)} 秒)`);
      if (code !== 0 && !stop) await sleep(5000); // 出错 (例如额度) 时别连发
      // 防空转 (第二轮 2026-11-02: 大脑判断达不成后每轮几秒就结束, 循环马上又叫, 3 分钟空转 38 次): 一轮不到 90 秒就结束,
      // 不立刻再叫, 等监工发现闲置 (nudge) 或最多等 2 分钟 × 连续次数 (上限 10 分钟)
      // 这一轮干了活就不算空转, 马上接着 (2026-11-05 Claude Haiku 每轮干 20 秒活写段汇报就结束, 再白等 60 秒, 75% 的时间站着; 同模型另一个角色一次没停)
      a.quick = Date.now() - began < 90_000 && !a.nudge && workSinceFile(path.join(a.dir, "journal.jsonl"), began) === 0 ? a.quick + 1 : 0;
      if (a.quick > 0 && !stop) {
        // --kit party: 只等 1 分钟 (派对 supervise.sh 空闲满 1 分钟就叫"继续"; 读派对仓库时核出: 等 2~10 分钟本身在制造空闲)
        const waitMin = KIT === "party" ? 1 : Math.min(10, 2 * a.quick);
        const until = Date.now() + waitMin * 60_000;
        log(`${tag(a) ? tag(a) + " " : ""}这一轮很快就结束了 (连续 ${a.quick} 次), 等世界有变化或监工叫醒, 最多 ${waitMin} 分钟`);
        while (!stop && !a.left && !a.nudge && Date.now() < Math.min(until, deadline)) await sleep(5000);
      }
    }
    // --kit party: 截止后最后一轮只写总结 (派对 PLAYBOOK 的"结束"一节), 最多 3 分钟; 中途被移出的不写
    if (KIT === "party" && !stop && !a.left && a.turns > 0) {
      log(`${tag(a) ? tag(a) + " " : ""}截止已过, 最后一轮写总结`);
      const killer = setTimeout(() => a.child?.kill(), 180_000);
      await turn(a, a.turns + 1, "截止时间已过。停下游戏里的动作, 在 notes.md 写最后的总结: 里程碑和游戏时间、什么拖慢了你、碰到的 harness 问题、最有帮助的工具改动。用中文, 写完就结束。");
      clearTimeout(killer);
    }
  }
  // 开班前试通: 走 Claude Code 换接口的角色 (deepseek / relay) 和 Antigravity (gemini; 账号地区不合格一句就报) 各发一句,
  // 不通记警报 (界面弹窗), 照样开班 (每轮还会再报)。Grok 2026-11-05 加上: 那班它第 1 轮就因 --add-dir 起不来, 开工后才发现, 其他 4 个模型已经在花额度
  for (const a of agents) {
    const drv = driverOf(a);
    // claude 订阅、官方 codex 不试 (Codex 一句就是一万多 token 系统提示; claude 开工第一轮就看得见)
    if (!drv?.ready || !drv.args || !drv.bin || !["deepseek", "relay", "gemini", "claude-api", "grok"].includes(a.brain)) continue;
    let r = await probeBrain(a, drv);
    // 第一次发强度参数不通且像参数错: 去掉再试一次, 只多 1 条请求
    if (!r.ok && (a.brain === "deepseek" || a.brain === "relay") && !NO_EFFORT.has(a.model) && looksLikeParamError(r.text)) {
      log(`试通: ${tag(a) || "角色"} (${a.brain} ${a.model}) 带强度参数不通 (${r.text.slice(0, 120)}), 去掉再试`);
      NO_EFFORT.add(a.model);
      r = await probeBrain(a, drv);
    }
    if (r.ok) log(`试通: ${tag(a) || "角色"} (${a.brain} ${a.model}) ${(r.ms / 1000).toFixed(1)} 秒 回 "${r.text.slice(0, 40)}"`);
    else {
      appendAlert(runDir, { at: new Date().toISOString(), agent: a.id, name: typeof a.who === "string" ? a.who : playerName, brain: a.brain, model: a.model, kind: "probe", text: r.text });
      log(`警报: ${tag(a) || "角色"} (${a.brain} ${a.model}) 试通失败 (${(r.ms / 1000).toFixed(1)} 秒): ${r.text.slice(0, 200)}`);
    }
  }
  // 开班扫描 (src/play/world-scan.ts): 现状 / 判断 / 规划 写成 world-scan.md 给每个大脑, world-scan.json 给界面
  try {
    gdCalc ??= loadGameData();
    const raw = normalizeScan(await lab.exec(SCAN_LUA));
    const ex = normalizeExisting(await lab.exec(EXISTING_LUA));
    const health = healthLines(normalizeHealth((await lab.exec(HEALTH_LUA)) as Health), [], zh);
    const now = { red: raw.rates.red, green: raw.rates.green, blue: raw.rates.blue };
    const p = propose(gdCalc, ex, now, null, health, zh);
    // 相关要点 + 蓝图候选按扫描点出的问题挑 (src/play/hints.ts), 写进 world-scan.md 的"相关要点"一节
    const sc = composeScan({ raw, existing: ex, health, rung: p.rung, deltas: p.deltas, reached: p.reached, seats: agents.length, zh, peaceMinutes: minutesLeft(peaceLeftMs(PEACE, Date.now())), hintsFor: (ls) => hintsForLines(POINTS, ls, { bp: bpRows, max: 5 }), hasWorldMap: fs.existsSync(path.join(labRoot(), "friend-world", "index.json")) });
    // 接下来要建的东西, 真实基地怎么摆 (每个模型第一轮都读这份, 这班 6 个读了 7 次)
    let layouts = "";
    try {
      const { studyHint } = await import("./bp-study.ts");
      const keys = [...p.deltas.filter((d) => d.kind === "assembler" && d.add > 0).slice(0, 2).map((d) => d.key), "lab"];
      const pics = keys.map((k) => studyHint(k, 60, 16)).filter(Boolean);
      if (pics.length) layouts = `\n\n## 接下来要建的, 真实基地怎么摆 (参考, 不是让你抄; 经验 ./know 关键词)\n\n${pics.join("\n\n")}\n`;
    } catch (e) { log(`开班扫描的布局参考没写成: ${(e as Error).message.slice(0, 120)}`); }
    fs.writeFileSync(path.join(brainDir, "world-scan.md"), sc.md + layouts);
    for (const a of agents) if (a.dir !== brainDir) fs.writeFileSync(path.join(a.dir, "world-scan.md"), sc.md + layouts);
    const { md: _md, ...forUi } = sc; void _md;
    fs.writeFileSync(path.join(runDir, "world-scan.json"), JSON.stringify(forUi, null, 1));
    scanNote = "先读 world-scan.md (开班扫描: 现状 / 判断 / 规划, 按读数自动算的), ";
    log(`开班扫描: ${sc.summary}`);
  } catch (e) { log(`开班扫描没做成: ${(e as Error).message.slice(0, 160)}`); }
  // 中途加人 / 移出 (src/play/roster-live.ts): 控制接口写 <班次>/roster.jsonl, 监工每 30 秒读新行照做
  async function applyRosterOp(op: RosterOp) {
    if (op.op === "leave") {
      const a = agents.find((x) => x.id === op.agent);
      if (!a) { log(`移出: 这一班没有角色 ${op.agent} (或已经移出了)`); return; }
      if (typeof a.who !== "string") { log("移出: 第 1 个角色 (玩家的身体) 不能移出"); return; }
      if (agents.length <= 1) { log(`移出: ${a.who} 是最后一个角色, 不移 (要停就点停班)`); return; }
      const label = tag(a) || a.id;
      a.left = true; a.nudge = null;
      agents.splice(agents.indexOf(a), 1); gone.push(a);
      a.stream?.close(); a.child?.kill();
      const removed = await retireBot(a.who);
      // bot_remove 让角色倒下, 会算一次死亡: 基线跟着挪, 不报"有角色死了"
      const d = Number(await lab.exec(`return game.forces.player.get_kill_count_statistics(game.surfaces[1]).get_output_count("character")`).catch(() => NaN));
      if (Number.isFinite(d) && lastDeaths !== null && deaths0 !== null && d > lastDeaths) { deaths0 += d - lastDeaths; lastDeaths = d; }
      try { const f = path.join(runDir, `session-${a.id}.json`); const s = JSON.parse(fs.readFileSync(f, "utf8")); fs.writeFileSync(f, JSON.stringify({ ...s, left: true, leftAt: new Date().toISOString() })); } catch { /* 没有这个文件 */ }
      log(`移出 ${label} (${a.who}): 大脑已停, 游戏角色收回; ${removed}`);
      const msg = `队友 ${a.who} 被管理员移出了 (${removed}), 它的活没人接: 看 team.md 的认领, 该接的接上。`;
      for (const o of agents) { if (running(o)) await tellAgent(o, msg); else o.nudge = (o.nudge ?? "") + msg; }
      return;
    }
    if (Date.now() > deadline - 5 * 60_000) { log("加人: 离截止不到 5 分钟, 不加了 (下一班名单里有就下一班带上)"); return; }
    const id = nextAgentId([...agents, ...gone].map((x) => x.id)); // 移出过的字母不复用: 记录文件按字母命名
    if (!id) { log("加人: 角色已满 (26 个)"); return; }
    if (op.seat.brain === "relay" && !op.seat.model) { log("加人: 中转站角色没选模型, 不加"); return; }
    const who = nthBotName(op.seat.brain, op.seat.model, agents.map((x) => (typeof x.who === "string" ? x.who : "")));
    const a: Agent = { id, dir: path.join(brainDir, id), who, brain: op.seat.brain, model: op.seat.model, effort: op.seat.effort ?? values.effort!, label: `队员 ${id.toUpperCase()} (服务器角色 ${who}, 中途加入)`,
      child: null, idle: 0, lastNudge: 0, nudge: null, quick: 0, sessionId: randomUUID(), turns: 0, msgs: new Map(), costBase: 0, lang: new EnglishWatch(), joined: true };
    // 单角色班第一次加人: 第 1 个角色的会话文件补一份 session-a.json (控制接口按 session-<id>.json 列多角色), team.md 补上
    if (!fs.existsSync(path.join(runDir, "session-a.json")) && fs.existsSync(path.join(runDir, "session.json"))) fs.copyFileSync(path.join(runDir, "session.json"), path.join(runDir, "session-a.json"));
    if (!fs.existsSync(path.join(brainDir, "team.md"))) fs.writeFileSync(path.join(brainDir, "team.md"), TEAM_MD_EMPTY);
    agents.push(a);
    try { await ensureBot(a); prepareAgent(a); } catch (e) { agents.pop(); log(`加人失败 (${op.seat.brain}/${op.seat.model}): ${(e as Error).message.slice(0, 160)}`); return; }
    if (fs.existsSync(path.join(brainDir, "world-scan.md"))) fs.copyFileSync(path.join(brainDir, "world-scan.md"), path.join(a.dir, "world-scan.md"));
    log(`加人: ${tag(a) || id} = ${a.brain}/${a.model}, 游戏里叫 ${who}, 开它的轮次`);
    const msg = `新队友 ${who} (${modelDisplayName(a.brain, a.model)}) 刚加入, 在出生点附近; 在 team.md 给它分一块活。`;
    for (const o of agents) if (o !== a) { if (running(o)) await tellAgent(o, msg); else o.nudge = (o.nudge ?? "") + msg; }
    loops.push(agentLoop(a));
  }
  beginPeace(PEACE, Date.now()); // 开班和平从大脑开始干活起算
  if (peaceActive(PEACE)) log(`和平期: 还开着和平, ${PEACE.minutes} 分钟后自动关`);
  for (const [i, a] of agents.entries()) loops.push(sleep(i * 20_000).then(() => agentLoop(a))); // 错开 20 秒起, 先让 A 认领
  for (let i = 0; i < loops.length; i++) await loops[i]; // 中途加入的追加在后面, 一起等

} catch (e) {
  log(`出错: ${(e as Error).message.slice(0, 300)}`);
} finally {
  if (monitor) clearInterval(monitor);
  killAll();
  // 开班和平没用完就停了: 剩下的留给这个群的下一班
  if (GROUP && peaceActive(PEACE)) { const m = minutesLeft(peaceLeftMs(PEACE, Date.now())); setPeacefulMinutes(path.join(labRoot(), "play"), GROUP.id, m); log(`和平期没用完, 还剩 ${m} 分钟留给下一班`); }
  agents.push(...gone); // 中途移出的并回来: 用量、请求、统计都算上
  // 全队工具留到下一班 / 下一个世界; 工具诉求写给工程师看 (派对的反馈环; 2026-11-05 对源码时补)
  if (KIT === "party") {
    try {
      copyTools(path.join(brainDir, "team-tools"), TEAM_TOOLS_KEEP);
      const wants = agents.flatMap((a) => { try { return toolRequests(fs.readFileSync(path.join(a.dir, "journal.jsonl"), "utf8")).map((r) => `- ${nameOfSeat(a)} ${r.at}: ${r.text}`); } catch { return []; } });
      if (wants.length) { fs.writeFileSync(path.join(runDir, "tool-requests.md"), `# 大脑的工具诉求 ${runId}\n\n${wants.join("\n")}\n`); log(`工具诉求 ${wants.length} 条, 写进 tool-requests.md`); }
    } catch (e) { log(`收工具诉求失败: ${(e as Error).message.slice(0, 120)}`); }
  }
  for (const a of agents) {
    a.out?.end();
    for (const u of a.msgs.values()) { usage.modelTurns++; usage.input += u.input_tokens ?? 0; usage.output += u.output_tokens ?? 0; usage.cacheRead += u.cache_read_input_tokens ?? 0; usage.cacheWrite += u.cache_creation_input_tokens ?? 0; }
  }
  // 报告
  if (KIT === "party") fs.writeFileSync(path.join(runDir, "requests.jsonl"), agents.flatMap((a) => journalToRequests(path.join(a.dir, "journal.jsonl"), a.id)).sort((x, y) => x.t - y.t).map((r) => JSON.stringify(r)).join("\n") + "\n");
  const reqs = fs.existsSync(path.join(runDir, "requests.jsonl")) ? fs.readFileSync(path.join(runDir, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const own = reqs.filter((r: any) => !r.wait);
  const fails: Record<string, number> = {};
  for (const r of own.filter((r: any) => !r.ok)) { const k = String(r.error).replace(/\(.*?\)|\d+(\.\d+)?/g, "#").slice(0, 90); fails[k] = (fails[k] ?? 0) + 1; }
  // 摩擦扫描 (照派对: 失败和返工按损失的时间排序, 每轮修前三): 一次失败的损失 ≈ 到下一次成功调用之间的时间
  const friction: Record<string, { n: number; lostS: number }> = {};
  own.forEach((r: any, i: number) => {
    if (r.ok) return;
    const next = own.slice(i + 1).find((x: any) => x.ok);
    const k = `${r.action}: ${String(r.error).replace(/__agent-harness[\w-]*__\/\w+\.lua:\d+: /g, "").replace(/\(.*?\)|-?\d+(\.\d+)?/g, "#").slice(0, 100)}`;
    friction[k] = friction[k] ?? { n: 0, lostS: 0 };
    friction[k].n++; friction[k].lostS += next ? (next.t - r.t) / 1000 : 0;
  });
  const last = samples.at(-1);
  const idle = samples.length ? samples.filter((s) => !s.active && s.queue === 0).length / samples.length : null;
  // ③ 班末: 各角色 notes.md 的 "## Lessons" 并进教训库 (以它自己的身份 lesson_add, 推断 action / item / recipe 键; 一班班往下传, 下一班做动作时自动带出)
  if (KIT === "party" && lab.rcon) await mergeLessonsNow(true);
  // 基地复盘: 俯视图 + 规整度 (带子拐弯率、每台用电设备几根电线杆), 下一轮和这一轮比
  let review: Record<string, unknown> | null = null;
  const tReview = Date.now();
  try { if (lab.rcon) review = await reviewBase(lab, path.join(runDir, "base")); } catch (e) { review = { error: (e as Error).message.slice(0, 160) }; }
  log(`基地复盘 (指标 + 俯视图) 用了 ${Math.round((Date.now() - tReview) / 1000)} 秒${review?.image ? `: ${String(review.image).slice(0, 80)}` : ""}`);
  const summary = { runId, goal: GOAL, brain: values.brain, model: values.model, lineup: agents.map((a) => ({ id: a.id, brain: a.brain, model: a.model, effort: a.effort, who: a.who, ...(a.left ? { left: true } : {}) })), stream: STREAM, viewerRelaunches, growNudges, autoResearch, deaths: deathsShift(),
    // 教训库: 开班登记了几条种子、班末各角色笔记并进几条 (src/play/lessons.ts)
    lessons: { seeded: lessonsSeeded, merged: lessonsMerged },
    // 真人的话没回被催了几次 (src/play/replies.ts)
    replyNudges,
    // 扩产提案 (M6): 发了几条、最后一档、每条的差额
    expansion: { proposals: expansions.length, rung: proposal?.rung ?? null, records: expansions },
    // M6 指标: 停机占比 (看门狗记的: 从发现掉线到恢复完成) 要低于 5%
    watchdog: { recoveries: recoveries.length, failed: watch.failed, downtimeS: Math.round(downtimeMs(watch, Date.now()) / 1000), downtimeShare: +(downtimeMs(watch, Date.now()) / Math.max(1, Date.now() - t0)).toFixed(4), records: recoveries }, agents: agents.map((a) => ({ id: a.id, who: a.who, brain: a.brain, model: a.model, turns: a.turns, costUsd: a.costUsd ?? 0, ...(a.left ? { left: true } : {}), ...(a.joined ? { joined: true } : {}), english: `${a.lang.english}/${a.lang.total} 句英文` })), success, review, milestones, faults: faults.map((f) => `${f.tick}: ${String(f.message).slice(0, 600)}`), nudges, redPerMin10: +perMin("redMachine").toFixed(1), greenPerMin10: +perMin("greenMachine").toFixed(1), perMin10Total: { red: +perMin("redTotal").toFixed(1), green: +perMin("greenTotal").toFixed(1), blue: +perMin("blueTotal").toFixed(1) }, lastCarryTick: lastCarry, supply: supplyNote, realMinutes: +((Date.now() - t0) / 60000).toFixed(1), gameMinutes: last ? +(last.tick / 3600).toFixed(1) : null, usage, fpCalls: own.length, fpFailures: own.filter((r: any) => !r.ok).length,
    idleShare: idle, stalls, health: lastHealth, last, topFailures: Object.entries(fails).sort((a, b) => b[1] - a[1]).slice(0, 10),
    friction: Object.entries(friction).sort((a, b) => b[1].lostS - a[1].lostS).slice(0, 10).map(([k, v]) => `${v.lostS.toFixed(0)} 秒 / ${v.n} 次: ${k}`), brainDir, runDir };
  // 额度 (开跑前 / 第一次 / 最后一次读数) 和每个大脑的上下文事件 (钩子加载了没、提醒几次、压缩几次)
  const ctx = agents.map((a) => {
    const lines = fs.existsSync(path.join(a.dir, "context.log")) ? fs.readFileSync(path.join(a.dir, "context.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    let st: Record<string, unknown> = {}; try { st = JSON.parse(fs.readFileSync(path.join(a.dir, ".context-state.json"), "utf8")); } catch { /* 钩子没跑过 */ }
    return { id: a.id, hooksSeen: st.hooksSeen ?? null, nudges: lines.filter((l) => l.action === "nudge").length, compactions: lines.filter((l) => l.event === "post-compact").length };
  });
  Object.assign(summary, { compactAt: AT, context: ctx, quota: { probe: describeQuota(quota.probe ?? null), first: quota.start ?? null, last: quota.last ?? null, lastText: describeQuota(quota.last ?? null) } });
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("\n" + JSON.stringify(summary, null, 2));
  // 自动复盘 (src/play/review-shift.ts): review.md / review.json, 下一班开班时"先修这几条"进笔记
  try {
    const rv = reviewShift(loadShift(runDir), values.save ? loadShift(path.dirname(values.save)).monitor : null, zh);
    fs.writeFileSync(path.join(runDir, "review.md"), reviewMarkdown(rv, runId));
    fs.writeFileSync(path.join(runDir, "review.json"), JSON.stringify(rv, null, 2));
    log(`复盘: ${rv.lines.length} 行, 下一班先修 ${rv.fixes.length} 条 —— ${rv.fixes.map((f) => f.slice(0, 40)).join(" / ")}`);
  } catch (e) { log(`复盘没写成: ${(e as Error).message.slice(0, 160)}`); }
  // 换班不关游戏: --keep-game 且不是被停掉的 (STOP / 额度 / 看门狗放弃) 也没有 STOP_AFTER → 只让服务器存一次档, 服务器和窗口留给下一班 (--attach)
  const stopAfter = fs.existsSync(path.join(labRoot(), "play", "STOP_AFTER"));
  let gameKept = false;
  if (values["keep-game"] && !stop && !stopAfter && lab.rcon) {
    try { await lab.saveNow(); lab.release(); viewer.release(); gameKept = true; log("换班不关游戏: 已存档, 服务器和窗口留着给下一班接上"); }
    catch (e) { log(`班末存档没成 (${(e as Error).message.slice(0, 120)}), 改为正常关游戏`); }
  }
  if (!gameKept) {
    const linger = Number(values.linger);
    if (linger > 0) { log(`窗口留 ${linger} 秒再关`); await sleep(linger * 1000); }
    viewer.close();
    await lab.stop({ save: true });
  }
  // 连续换班 (src/play/shifts.ts) 读这个接下一班: 只在拿到这一班自己的结束存档时写
  // 服务器退出时才存档: 存完自己把最终存档复制进记录目录 (第六轮: 我在窗口停留的 60 秒里手动复制, 拿到的是开局的旧存档, 第七轮接着它跑, 第六轮的进度丢了)
  try { fs.copyFileSync(lab.savePath("m"), path.join(runDir, "end.zip")); log(`最终存档: ${path.join(runDir, "end.zip")}`); fs.writeFileSync(path.join(labRoot(), "play", "last-run.json"), JSON.stringify({ runId, runDir, brainDir, endZip: path.join(runDir, "end.zip"), stoppedBy: fs.existsSync(path.join(runDir, "STOP")) ? "STOP" : "deadline", gameKept, at: new Date().toISOString() })); } catch (e) { log(`复制最终存档失败: ${(e as Error).message.slice(0, 120)}`); }
  // 班末备份: .env 里的 PILOT_BACKUP_CMD 是本机自己的命令 (脚本和去向都在本机, 不进公开仓库), 没设就不做;
  // 放在记录和最终存档都写完之后, 脱离本进程跑, 失败不影响换班
  const backupCmd = process.env.PILOT_BACKUP_CMD?.trim();
  if (backupCmd) {
    try {
      const child = spawn(backupCmd, { shell: true, detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      log(`班末备份已启动: ${backupCmd}`);
    } catch (e) { log(`班末备份没起来: ${(e as Error).message.slice(0, 120)}`); }
  }
  if (RELAY_PROXY) {
    log(`中转站本机代理: 转发 ${RELAY_PROXY.requests} 次, 去掉 metadata ${RELAY_PROXY.stripped} 次, 连不上站 ${RELAY_PROXY.errors} 次`);
    await RELAY_PROXY.close();
  }
}
