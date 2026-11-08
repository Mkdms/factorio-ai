# 开班主循环 (core/run)

一个 AI = 一个干净的真客户端 (独立版, 不装模组) + 游戏外的模组 (`game/offgame`) + 玩家操作 (`commands/`) + 大脑。沙盘和联机走同一条路: 沙盘里是本机起的"干净的服务器" (`SandboxServer({ clean: true })`, 一个我们的模组都不装, 当联机服务器的替身), 联机就是别人的服务器。

```
npm run run:online -- --lab [--save 存档.zip] --minutes 5       沙盘: 开一张新图 (或存档), 不叫模型, 等到点 / STOP; 这段时间可以在角色目录里跑 ./fh
npm run run:online -- --server --read-only --minutes 5          连 data/accounts/keys.json 的 server, 只读 (上真服要用户在场)
```
同一个世界连续跑: 沙盘班收工存 `data/play/online/<runId>/end.zip` (2026-11-08 起; `/server-save` 是服务器命令不是 Lua), 下一班 `--save 那个 end.zip --notes 上一班的角色目录` (笔记接着传)。
选项: `--name 角色名` (= 模型名规范写法), `--notes 上一班角色目录或 notes.md`, `--steam-pid 进程号` (挂到用户的 Steam 客户端; 用户自己在玩时不许用), `--own-world`, `--backend auto|memory|rcon`, `--reveal`, `--lua`, `--goal-file`, `--run-id`。大脑: `--brain none|claude|claude-api|deepseek|relay|codex|grok|gemini --model 模型 --effort low|medium|high --compact-at token数` (`core/brains/driver.ts`; 密钥在 `data/accounts/keys.json`; codex / gemini / 中转站的 Responses 模型没有命令白名单钩子, `--server` 直接拒; docs/brains.md)。

## 一班的流程
1. 客户端: 开独立版连服务器 (沙盘 / 别人的), 看客户端日志等它进世界 (`online-lib.ts clientPhase`; 连不上报原因, 密码错和模组不一样客户端日志都只有 "refused"); 联机 `--backend auto` 时先用干净客户端试进, 进得去 = 服务器没装模组 → 走外挂, 一条 Lua 都不跑。
2. 注入客户端 (`game/client`, 只读默认不注入), 读玩家、退出远程视图, 读 `game.console_command_used`。
3. 起代理 (`commands/broker.ts`) 和游戏外的模组宿主 (账本 `ledger.lua` 在记录目录); 读 `where` 写 `where.json`。
4. 角色目录 (`workspace.ts`): 简报 AGENTS.md / CLAUDE.md (`brief.ts`: 训练集 manuals/brief.md 模板 + 世界真实值 + 用户目标 + 手册目录)、notes.md (训练集的模板)、ref/ (手册主题 + 思路 pattern-*.md + facts.md + names.tsv)、deadline.txt、`./fh` / `./know` 各两版 (脚本里只有管道名, 没有 RCON 密码)。教训从训练集读进内存 (`deliver.ts`), 行动层做对应动作时在回复里带 2 条。
5. 开班扫描 (`scan.ts`): 现状写 world-scan.md, 后面附对得上的要点 (`hints.ts`); 判断 / 规划等计算器那块接上再有。
6. 监工 + 真人聊天 (`supervisor.ts`, `human-chat.ts`; 能动手就开, 不叫模型的验证班也开): 30 秒一采样记 `monitor.jsonl`; 闲了 (没发动作、没走; 出生点 3 分钟 / 别处 5 分钟, 开局宽限 3 分钟, 隔 15 分钟) 就催; 5 分钟一次体检 (`health.ts`: 缺燃料 / 采空 / 研究中心停 / 缺料和堵满 / 缺电 / 带子尽头堵死), 只递新出现的和连 3 次没修的; 研究队列空了说能排什么 (`research.ts`, 不替它排); 30 分钟播报产量 (`science.ts`); 截止前 10 / 3 分钟提醒; journal 里的"工具诉求"记 `tool-requests.md`。真人的话: 5 秒一看自己客户端的聊天 (chat_read) 和记录目录的 `tell.txt` (管理员), 原话进模型下一条回复 (`tell.ts`: 经代理的 operator 通道进模组账本 tell, 能叫醒 sleep; 递不进就写 `.inbox.md`), 说"紧急"才打断这一轮; 全部记 `tells.jsonl`、`chat.jsonl`。
7. 大脑 (`--brain claude`): 角色目录写 `.claude/settings.json` (压缩点 + 钩子) 和 `.context-hooks`; 一轮一个 Claude Code 进程, 第 1 轮开场提示词 (先读简报、笔记、world-scan.md, 再看 status / observe, 然后动手), 之后"继续"; 会话号接力 (`--resume`); 一轮很快结束就等满 30 秒再叫; 到点 / STOP / DONE / 客户端关了 / 掉线就连子进程一起杀。`--brain none`: 只等到点 / STOP。
8. 收工: 笔记里的教训收进待核区; 班末总结 `summary.json` + 复盘 `review.md` (`core/records/summary.ts`: 轮次用量和估价、请求按动作、失败按原因、放下的建筑、经验带出次数、闲着的时间、体检比例; 下一班先修最多 3 条); `end.json`、`probe-stats.json`; 联机时抹掉客户端日志里的地址和密码。

记录在 `data/play/online/<runId>/`, 角色目录在 `BRAIN_DIR` (默认 `~/factorio-ai-brain`) 下 (必须在仓库外: 模型会往上读到开发规则)。

## 代码
| 文件 | 做什么 |
|---|---|
| `online.ts` | 主循环 (上面的流程) |
| `online-lib.ts` | 服务器地址 (keys.json 的 server)、客户端日志 → 阶段、抹地址密码、简报里联机这一节 |
| `workspace.ts` | 角色目录和 `./fh` 包装 (sh + ps1, `ps1-wrap.ts` 把参数写成文件交给 `commands/fh.ts`) |
| `scan.ts` | 开班扫描 (SCAN_LUA 跑在游戏外的假接口上) |
| `brief.ts` | 简报组装 (模板占位符 WORLD / PLAYER / GOAL / REF_INDEX) |
| `deliver.ts` / `lessons.ts` / `hints.ts` / `knowledge.ts` / `training.ts` | 递积累: 教训 (种子 + 待核区; 挑选、键推断、班末收笔记)、要点、查全部积累、训练集在哪 (公开 + 只本机两份合并读) |
| `supervisor.ts` / `tell.ts` / `health.ts` / `research.ts` / `science.ts` / `human-chat.ts` | 监工 (采样、催闲、体检、研究、播报、截止、工具诉求)、递话 (模组账本 tell / 收件箱)、体检 Lua 和清单、研究队列空了能排什么、产量读数、真人聊天 (客户端 chat_read、tell.txt、紧急判定、@ 点名) |
| `../records/summary.ts` | 班末总结和复盘 |
| `shell.ts` | 找 Git for Windows 的 bash (PATH 上的 bash 可能是 WSL 的) |
| `../brains/driver.ts` + `claude-code.ts` / `agent-sdk.ts` (+ `agent-sdk-runner.ts`) / `codex.ts` / `grok.ts` / `gemini.ts` / `relay.ts` / `keys.ts` / `lineup.ts` / `probe.ts` | 大脑驱动: 八家按家起进程、事件翻成 Claude 形状、中转站分流和本机代理、密钥文件、角色名 = 模型名、一句试通 (docs/brains.md) |

| `../../src/` (calc / blueprint / play / dataset / lab / io) | 第二版整目录搬来的 `./calc` `./bp` `./plan` (docs/brains.md 第 ④ 步; 文件名路径照旧, 几个转接文件指向新项目的家) |

## 第二版剩下的整目录搬来了, 但没接进这条路 (2026-11-08)
用户要求整目录原样复制、不改名: 第二版 `src/play/` 其余 46 个文件 (界面控制接口 control.ts、群 groups.ts、看门狗 watchdog.ts、换班 shifts.ts / live-shift.ts / shift-recover.ts、多角色 roster*.ts、账号页 accounts.ts、统计 stats.ts、催回话 replies.ts、第二版主循环 run.ts 等)、`src/lab` `src/io` `src/dataset` `src/search` `src/verify`、`experiments/` (第二版沙盘实验)、`tools/`、`app/` (Tauri 界面)、`docs/v2/` (第二版文档)、`plans/`、第二版的 48 个测试 (重名的 test/brains.test.ts 存成 v2-brains.test.ts; 第二版沙盘测试在 test/sandbox-v2/, 不在 `npm run test:sandbox` 的范围) 都在本项目里, 文件名路径照旧; 第二版里已被前几块搬走改名的模块用 `src/{play,lab,io}/*.ts` 里几行的转接文件指回新家 (shell / science / lessons / permit / model-name / viewer / running / backend / relay-route …)。全量单元 479/479。
**两条路都保留 (docs/decisions.md 2026-11-08)**: 第二版的主循环 `src/play/run.ts` (装模组 + RCON, 贴蓝图瞬间建好) 是后期不要成就时全性能的备用路, 整个搬来了: 旧项目 `mods/` 也在 (`mods/agent-harness` 上游原版、`mods/factoryplanner` 补丁版 Factory Planner → 也放进 `game/mod/factoryplanner`), 它用的第二版模块 (digest / research / world-scan / hints / human-chat / health / lessons / cc-env / relay-proxy / agent-sdk / codex-events / grok-* / online-lib) 原文从旧项目历史恢复在 `src/play/` (和新项目 core/ 里改过的同名模块并存, 互不引用); 沙盘实例 `src/lab/instance.ts` 是转接 (LabInstance = SandboxServer, 第二版模组名 io-lab / agent-harness-party 对到 game/mod/ 的 factorio-ai / factorio-ai-harness)。`test/v2-run-path.test.ts` 静态核 run.ts 的 import 图完整 (不执行它)。**真跑过一班 (2026-11-08 06:0x)**: `npm run play:run -- --brain none --minutes 2` → 沙盘 (装 factorio-ai 沙盘模组 + factorio-ai-harness) 起来、游戏窗口连上、2.1 分就绪 (大脑目录 ~/factorio-pilot-brain/<班次>, 记录 data/play/runs/<班次>)、开班扫描、到点复盘收工, 游戏进程全关。第一次跑在建角色目录时找 `<仓库>/knowledge/facts.md` 失败 (第二版的位置), 加了 `src/lab/gamedir.ts knowledgeFile` 对到 training/ 下。
**开班选路线 (2026-11-08 接上)**: 群文件多一个 `route` (memory 默认 / mods; `src/play/groups.ts`), 界面"新建对话"里沙盘的群 (新地图 / 接着存档) 多一组"走哪条路"的选项 (`app/src/components/Modals.tsx`); 控制接口 `POST /api/group/start` 按它起: memory → `core/run/online.ts --lab --group <id> --brain/--model/--effort (第 1 席) --minutes [--save 上一班 end.zip --notes 上一班角色目录]`, mods → 原来的 `shifts.ts --shifts 0 --live` + `run.ts` 参数; 两条路接同一条存档链 (`latestRunOfGroup`)。online.ts 带 `--group` 时记录放 `play/runs/<runId>` 并写 world.json, 收工把 brainDir / lineup 补进 summary.json, 下一班接得上。单元 `test/group-route.test.ts`。**接口层核过 (2026-11-08 05:5x, 不叫模型)**: `npm run play:control` 起控制接口 → `POST /api/groups` 建群 (kind new, route memory, 席位 none) → `POST /api/group/start` 回 `route: memory` 并起了 online.ts (`--lab --minutes 5 --group … --brain none`) → 0.6 分进世界, 记录在 `play/runs/<runId>` 带 world.json → `GET /api/worlds` 把它列在这个群下 (running), `GET /api/state` 有 run / game (tick、分钟) / quota / world → `POST /api/stop` 写 STOP → 1.1 分收工存 end.zip, summary.json 带 brainDir + lineup → state 变 running: false, 游戏进程 0。界面壳 (Tauri exe) 要在 PowerShell 里编 (Git Bash 的 /usr/bin/link 挡住 MSVC 的 link.exe, vswhom-sys 编不过)。**界面对不装模组那条路的记录 (2026-11-08 午后核过)**: 拿 Sonnet 第四班的真记录放进临时数据目录, 起控制接口逐个端点取数, 再开编好的界面截图。原来缺的和修法: ① 角色列表空、输入框没处跑 → 开班写 `session.json` (游戏名、模型显示名、席位、角色目录 dir、route、account; `src/play/control.ts agentInfo` 优先用会话里的 dir); ② 群公告"先修这几条"空 → 收工多写 `review.json`; ③ 统计卡一班都不算 → `summary.json` 多写第二版的字段 (realMinutes / gameMinutes / idleShare / fpCalls / perMin10Total / usage / agents; `core/records/summary.ts guiFields`), 请求数没有 requests.jsonl 时按 journal 计 (`src/play/stats.ts`), 工具次数认 `turn-N.jsonl` (`src/play/knowledge-use.ts`); ④ **点开那一班界面整页变白** (右栏"开班扫描"读 judgement / plan, 新扫描没写) → 扫描写全 (`core/run/scan.ts`), 控制接口给旧记录补空数组, 界面这节字段缺了也不崩; ⑤ 在线成员把沙盘的独立版角色标成"控制你的账号" → 会话文件写 `account` (挂在用户 Steam 客户端上 `--steam-pid` 才是), 界面 `controlsAccount` 优先看它; ⑥ 对它说话走 RCON (这条路没有) → 会话文件没有 rconPort 时写记录目录的 `tell.txt` (online.ts 5 秒内转给模型), 收工了的班报"递不到"。核后的读数: 左栏角色 "Claude Sonnet 5.5 · 游戏里 Claude-Sonnet-5.5", 中栏对话 (干了 N 步 + 说的话), 右栏开班扫描 / 群公告 2 条 / 游戏读数 (29 分、研究 4 项、红瓶 2.1/分) / 体检 3 行 / 统计 (1 班 0.5 小时、建造 46、规划 2、$11.77), 页面 0 报错。看门狗 / 换班不关游戏仍只在 mods 路有。没核: "我 · 管理员"那行选模型点开局 (走 mk-world, 会开你的 Steam 版游戏, 要你不在玩的时候)。

## 装模组那条路 (run.ts --kit party) 在新项目里跑通全套 (2026-11-08)
第二版的 party 工具包要本机的派对仓库 (生成简报、手册和 ./fh), 重构后不下载别人的项目, 这一支从搬来就没跑过。补的: 没有派对仓库时简报和手册用训练集 (`src/play/partykit.ts ownWorkspace`, 和不装模组那条路同一份), 命令行用 `commands/cli/cli.js` (`src/play/fh-cli.ts`); `src/play/fh-shim.ts`、`src/play/know.ts` 两个转接 (./fh、./know 原来一启动就找不到模块); 检索资料路径对到 `training/knowledge/pending/research` (`src/lab/gamedir.ts knowledgeFile("research")`); 开窗口的 `repoMods` 对到新项目的模组名 (`src/lab/viewer.ts`; 原来客户端不带模组, 掉线重开时卡在"同步模组"确认框); `./plan` 没有管道时经 RCON (`FP_SESSION`); 本机 `.env` 补 `FBE_DIR` (基地俯视图); 停班先认 `current-run.json` (不叫模型的验证班在界面里收着, 原来会停到上一班)。
验证班 (界面接口开, 不叫模型, 接第六班存档): 2.1 分就绪, 教训库登记 137 条, 开班扫描; 角色目录里 `./fh call status`、`pole_route` 试算 (6 根杆)、`./calc`、`./bp list` 通。注意: 群开的班是**连续换班** (`shifts.ts --shifts 0`), 一班到点存档后接着开下一班, 要点"停班"才停 (第二版的设计)。

## 第二版给模型的命令在这条路上接了多少 (2026-11-08 盘点, 接完一项打勾; 全部接完再在沙盘里一起核)
盘法: 模组 (factorio-ai-harness) 的 206 条 ./fh 命令, 照它的读者闸门 (`runtime.lua M.keeps`: 读 / 试算 / 被动 / `queue_` / 说话类放行) 和行动层 (`commands/actions.ts ACTION_NAMES`)、账本 (`commands/broker.ts LEDGER`) 分。另外 `./calc` `./bp` `./plan` `./know` 是角色目录里的独立命令。
- 能用 (82): 读 63 (observe、status、power、placements、nearest_water、drill_sites、conflicts …)、行动层 13 (move_to build build_path transfer collect refuel feed craft mine rotate research say shoot)、账本 3 (sleep tell chat_ack)、试算 3 (construct / rearm / recover 带 dry_run)。
- [x] 简报写错: 说 `./calc` `./bp` "还没接上"、`./plan` `belt_route` "没有"、`nearest_water` "算不出抽水机能放哪" (`core/run/online-lib.ts onlineBrief`) → 改成照实写。模型因此一次都没用过 ./calc ./bp
- [x] 其实是读、被闸门当成动手的: ingredient_gap belt_flow ghosts checks dependency uptime heat_budget alerts_digest logistics_audit circuit_audit turret_tally players sight trace disclosure research_done → 代理按角色身份问游戏外的模组 (`commands/broker.ts AGENT_CALLS`)
- [x] 记账类按读者身份跑 (记不到角色头上): board_* reminder_* lesson_* vote confess(ions) chronicle clock profile harness_request mention_counts → 同上, 按角色身份
- [x] 铺线: pole_route belt_route pipe_route → 模组试算出逐格清单 (details), 行动层走过去一个个放 (`commands/actions.ts route / layTiles / routeTiles`; 游戏外的假接口补了放置检查、占地框、流体口、电线杆接线距离, 三个试算才算得出)。地下带出口端不转方向 (放在入口下游时游戏自动配成出口), 待沙盘核
- [x] 一组建筑: place_ghosts → 直接放实物; construct / rebuild → 范围里现有的虚影按名字一个个放实物 (协助模式下虚影不算别人的东西)。assembler_batch 是一串排队动作, 归到下面"常驻命令和队列"
- [ ] 配置和物品: configure (机械臂过滤 / 箱子限格 / 配方) pickup equip equipment use_item cancel_craft deliver upgrade belt_upgrade clear_cliffs rearm turret_feeds recover → 玩家操作 (界面点选 / 拿在手上点)
- [ ] 等待: wait_ticks wait_until walk → 行动层 (等 = 按 tick 轮询; walk = move_to)
- [ ] 常驻命令和队列: order_set orders order_remove orders_pause orders_resume queue_* → 闸门放行但游戏外跑不了 (要模组在游戏里替角色干活) → 游戏外的监工按单子用行动层执行
- [ ] 战斗和载具: kite spider_kite retreat_guard vehicle train train_stop rail_route attach detach → 玩家操作
- [ ] 电路: wire circuit_set circuit_gate signal_watch → 玩家操作 (拿红绿线点两头 / 界面)
- [ ] 太空: platform_* launch silo_stage load_silo pods shipment fleet gates demolishers flight_watch min_payload → 玩家操作 (到太空时代再做, 但要列着)

## 证据
`test/sandbox/run.test.ts` 5/5 (2026-11-07, 38 秒, 开一个游戏窗口): 干净的沙盘服务器 (mod-list 里只有 base / space-age 那几个) + 独立版客户端不带模组 20 秒进世界 → 注入 → 游戏外的模组起来 (`where.json`: RunCheck 在 nauvis, 有身体) → 开班扫描写出 world-scan.md / .json → 角色目录的 `./fh` (sh 版) 读背包、status、`build wooden-chest` 真放下 (背包 4 → 3) 并记 journal → `fh.ps1` 的 JSON 参数 `{"radius": 8}` 不拆坏 → 放 STOP 收工 `end.json why=STOP`, 服务器日志 `[JOIN] RunCheck` 且没有 desync, 游戏进程全关。第一次 0/5 的原因: 客户端带着沙盘模组连干净服务器被拒 (客户端日志只有 Connection refused), 改成按"连别人的服务器"的方式连 (不带任何模组)。

沙盘这条路一条控制台命令都不发 (2026-11-08 起; 之前开班用 RCON 发过一条退出开场动画 + 给料的命令, 用户看到成就页"因为使用了控制台指令"后改掉): 坠机过场按游戏提示的"确认消息"键跳过 (没跳也 12.5 秒自己结束), 起始物资就是游戏给的; `defines.json` 要先由沙盘测试 / 演示导出好, 缺了报错不经控制台读。`console_command_used` 读的是 false (沙盘测试核)。
