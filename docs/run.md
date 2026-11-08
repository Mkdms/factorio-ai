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

## 我们自己生成并实测过的蓝图块 (红瓶组装机排、冶炼列、化工行…) 放哪 (2026-11-08 补)
`./plan` / `./bp` 从 `data/training-private/blueprints/generated/` 读 (`src/play/bp.ts GEN`); 第二版的这批块搬家时留在 `data/v2/generated/`, 没放到新位置, `./plan` 一直回"库里没有现成的块, 自己搭", `--build` 没东西可放, 模型只好手搬 (装模组连续班第 1~3 班一格传送带都没铺)。已复制过去 (17 个文件, 第二版那份原样留着); 之后 `./bp list 红瓶` 列出 6 / 12 台组装机1型、2型的红瓶排 (实测每分钟 36~108)。换电脑要带上这个目录 (只在本机, 不上传)。

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
- [x] 配置和物品 (`commands/actions.ts`): recover (走到自己的尸体挖) pickup (走过去按住拾取键) deliver (走过去放) rearm (背包里最好的弹匣补炮塔) upgrade / belt_upgrade (拿下一档放在原位快速替换; 下一档取原型的 next_upgrade; belt_upgrade 按半径, 不是整条线追) use_item (拿在手上左键点) clear_cliffs (悬崖炸药) equip (背包里 Shift+点进装备格) configure (这条路上只会设 recipe 和 requests, 别的设置明说还没翻译)
- [x] cancel_craft (背包窗口里手搓队列格子 CraftingQueueSlot: Shift+左键全取消, 左键一次一个) equipment {insert} (装备栏里穿着的护甲那一格右键打开网格, 再 Shift+点插件); 控件名是沙盘里读界面树读出来的 (`data/play/ui-tree-*.json`, 本机)
- [ ] 还差: turret_feeds (给炮塔配请求箱 + 机械臂, 要物流网; 等有机器人再接)、equipment 取下来
**沙盘核过 (2026-11-08 下午, `test/sandbox/actions.test.ts` "接线:" 一组, 不装模组的路, 每条都是角色在游戏里真做的)**: pole_route 放了 6 根; belt_route 带拐弯 21 格; pipe_route 15 件 (含地下管); place_ghosts 放了 2 台炉子; construct 按脚本造的 2 个虚影放了 2 个箱子; pickup 撒在地上的 20 块全捡回 (拾取键只捡身边一小圈, 要一件件走过去); rearm 炮塔 10 发; upgrade 3 格带子换成快速传送带; use_item 扔出 1 颗手雷 (用的是 use-item 键, 放建筑的 build 键扔不出去); equip 冲锋枪进枪格; configure 改配方; cancel_craft 队列 1 → 0; equipment 网格里装上 2 块太阳能板; ingredient_gap / ghosts / players 按角色身份读到; wait_ticks; queue_submit 空着 20 秒后放了箱子; order_set fuel_below 炉子没煤自动补到 5 个, 跑完进冷却
- [x] 等待: walk = move_to; wait_ticks wait_until 交给游戏外的模组按读数等 (和 sleep 一样, `AGENT_CALLS`)
- [x] 常驻命令和队列 (`commands/orders.ts`, 代理里 3 秒看一次): queue_submit (append / replace, on_fail abort / skip) queue_status queue_cancel queue_pause queue_resume queue_repeat (interval_ticks、times); order_set (最多 6 条 × 32 步、priority、cooldown_ticks、没有 when 的默认例行 interval_ticks、连败 3 次关掉) orders order_remove orders_pause orders_resume。照手册的规则: 角色空着 (模型最后一个自己的动作之后 20 秒) 才跑, 模型一动手跑完手上这一步就让出来 (模组是立刻停); 每一步和模型的动作过同一把身体锁。when 在游戏外按一小段只读 Lua 判断, 认 fuel_below ammo_below item_count ghosts_waiting damaged health_below health_above no_enemies (参数名照模组); 别的条件 (平台、火箭…) 单子照收、状态明说不认。没做: queue_edit (用 replace)、max_walk、guards、lane、assembler_batch。单元 `test/orders.test.ts` (含条件 Lua 在 Lua 5.2 里编译)
- [x] 太空那批里只读的: fleet demolishers gates platform_bom platform_digest → 按角色身份问 (`AGENT_CALLS`)
- [ ] 战斗和载具: kite spider_kite retreat_guard vehicle train train_stop rail_route attach detach → 玩家操作 (上车 = 走近按上下车键; 开车 / 火车时刻表 / 车站名要界面) —— 要先在活的客户端里读界面树
- [ ] 电路: wire circuit_set circuit_gate signal_watch → 玩家操作 (2.0 红绿线是快捷栏工具, 不是物品; 组合器设置要界面) —— 同上
- [ ] 太空: platform_* launch silo_stage load_silo pods shipment flight_watch min_payload → 玩家操作 (发射井 / 平台枢纽的界面) —— 同上, 到太空时代前做完

## 第二版 → 新项目逐项对照 (2026-11-08 晚; 用脚本比, 不靠记忆)
基准: 第二版第三次重构前最后一个完整提交 d006640 (历史包 factorio-pilot-final-2026-11-08.bundle)。

**1. 本机数据** (data/v2 每个文件 → 代码读的位置 data/…, 按大小比): 蓝图块 17、班次记录 86 班 (553 个文件)、gamedata 251、renders、search 都在。代码会读但缺的三样, 已不覆盖地复制: `play/online/` 第二版 100 局 (含"我的账号"那几局, 界面"我的账号"那栏读这里)、`play/groups/` 旧群、`play/mk-current.json` (runDir 改成新位置)。没代码读、留在 data/v2 当存档的: io-probe、io-suite、scratch、shots、team、calc-crosscheck、play 根下 check-*.jsonl / requests.jsonl / last-run.void*。keys.json 只差 relay_formats (站点协议缓存), lineup.json 是后来重选的。全图布局 + 联机世界副本在 `data/training-private/blueprints/friend/world/` (./bp study 读这里)。第二版各班角色目录 (笔记、journal) 都在仓库外的角色目录根里 (有 28 个 summary 里记的是旧路径, 内容在)。界面接口只列 7 个世界 18 班: 其余是第二版界面里当时点的"收起 / 删了对话记录" (第二版就有 86 / 81 个标记), 不是搬丢; 统计页算进 58 班。
**2. 代码文件** (第二版 803 个文件按内容找): 原样或搬了位置 630、同名改过 87、找不到 86 (1.2 万行): 第二版不装模组路的旧 io 23 个和它的测试 (已由 game/ commands/ 重写)、src/play 的 online / online-brain / online-scan / context-hook / fh-hints / read-guard / output-cap / ref-sections (搬进 core/ commands/ 改了名)、测试 46 个。
**3. 搬家后静默断掉的 (路径没跟着改, 已修, 装模组那条路)**:
- Claude Code 钩子 6 个全指向不存在的 `src/play/context-hook.ts` (连续班 summary 里 hooksSeen 为空): 放行循环 / 管道 (连续班 9 条组合命令被 dontAsk 拒)、拦串联 sleep、读文件禁区、收件箱、快满提醒、压缩前后存笔记都没生效 → 转接到 `core/brains/hooks/hook.ts`; 实测: 串联 sleep 拒 (退出码 2)、`./fh help collect | head -20` 放行、读 game/ 下的模组源码被拦。
- Console 密钥大脑 (claude-api) 的跑器 `src/play/agent-sdk-runner.ts` 没了 → 转接 `core/brains/agent-sdk-runner.ts`。
- `./fh` 包装被换成不装模组路的 commands/fh.ts, 丢了第二版的: 贴蓝图先干跑、只有树石挡路就 forced (lab #85); 放机器时经 RCON 查好能放的坐标、数还缺几台、"手放第 N 台"的事实、几种摆法 (第二版专门对付手搬的) → `src/play/fh-shim.ts` + `fh-hints.ts` 恢复第二版原文 (只去掉 FH_BACKEND=io 分支), output-cap / ref-sections 转接; 压缩后清"给过"的记录 (两条路共用 hook.ts)。
- 开班扫描判断"有没有全图布局"看旧位置 `data/friend-world`, "./bp study --map"提示一直不出 → 对到 friend/world; `play:world-export` 输出也改到那里。
- 沙盘实验核实的事实写 `<仓库>/knowledge/facts.*` (不存在) → `training/knowledge/verified/facts.*` (`knowledgeFile`)。
- 界面"只读连接联机服务器"起的是不存在的 `src/play/online.ts` → `core/run/online.ts --server …` (`groups.ts connectArgs`, 带群的路线和读没探过的区块); 排练脚本 rehearse-server 同改。没实跑 (上真服要用户在场)。
**4. 在代码里但一班里到不了的 (装模组路)**: 群开的连续班一班 10 分钟, 而配比提醒 (开班 15 / 35 分)、不扩产点名 (20 分)、产量播报 (30 分一次)、工具诉求 (90 分)、催闲 (闲满 10 分) 都按本班算 → 配比提醒 / 不扩产点名 / 工具诉求按**世界累计时间** (`worlds.ts worldPlayedMs`: 同一世界之前各班 summary 的 realMinutes 相加), 播报间隔按班长缩 (10 分钟班 5 分钟一次), 催闲门槛按班长四成 (10 分钟班 4 分钟)。
**5. 英文**: 英文提醒两条路都在 (不装模组路原来没有), 改成按句判断 (中英混在一段里的英文句也算)、5 分钟 2 段就提醒、隔 3 分钟、提醒后不清零 (原来一班 5/21 句英文只提醒 1 次); 两条路的角色目录 `.claude/settings.json` 加 Claude Code 的 `language` 设置 (进系统提示)。
**6. 不装模组路补的**: 开班把上一班复盘"先修这几条"放到笔记最前、拿上一班整班平均产量给监工播报和复盘比 (每班硬指标); 两条路教训互通 (不装模组路也读 `data/play/lessons-learned.jsonl`), 挑 70 条时几份文件从最新的轮流取 (原来本机那份 456 条排前, 训练集待核区的一条都轮不到)。
**7. 常驻命令 78 格失败**: 不是退回, 第二版就有: 模组规矩是队列里的取放补料步骤自动加 `walk: true`, 常驻命令不加, 不写时目标超过 64 格整步拒 (`autowalk.lua TOUR_RANGE`、`scheduler.lua`)。→ 教训进待核区 (做 order_set 时带出, 两条路都核过载入), 手册 waits-queues 那句更正, 装模组路简报补第二版那三句 (`--wait`、去想事情前先挂常驻命令、动作会暂停队列要 queue resume) 和这条。
**8. 测试**: 第二版测试搬回 30 个 (装模组路用的体检、要点、教训、放行、摘要、复盘、产量、研究、扫描、上下文、真人聊天、经验检索、提示 …; 路径改到新项目), 和新项目重复的 lab-unit 不搬, 测第二版旧 io 的不搬。全量单元 642: 过 630、失败 0、跳过 12。
**9. 备份**: 角色目录 (笔记) 原来在家目录两处, 不在备份里 → 本机 `.env` 设 `BRAIN_DIR` 到备份脚本备的那个目录 (仓库外), 已有的 21 个复制过去; 补回 `PILOT_BACKUP_CMD` (装模组路班末备份)。
**第二轮 (同晚, 换角度再查)**:
- **npm 命令**: 第二版 39 个、新项目 13 个。程序还在、命令没搬的 19 个已搬回 (play:shifts / review / seen / tokens / quota / check / world-export / online、fp、verify、coverage、lab:demo / watch / dump、dataset、calc:crosscheck、search、io:rehearse、api-catalog) + `test:sandbox-v2`; 不搬: `setup` (要下载派对工程和别人的 MCP)、`party:check` (要派对仓库)、io:* 11 个 (第二版旧读内存工具, 已由 game/ 取代)。
- **知识覆盖盘点** (`coverage`) 还按 knowledge/ 找, 盘出来全是空白 → 改读训练集; 现在实体 123 (核实 70、思路 49、只有检索 4、空白 0)、科技 277 (空白 114)。知识本身没少: 已核实事实 121、教训种子 68、思路 9 篇条数行数和第二版一样; 私有备份里第二版本机数据的最后快照 (数据集 / 蓝图 / 班次 / 群) 在新位置 0 缺 (只有换行符不同)。
- **模型实际拿到的角色目录** (第二版最后一个装模组班 vs 11-08 的班): 装模组路的简报换成了给不装模组路写的通用简报, 少了: 自己写工具 (tools/ + Python + fhlib)、describe.json 查参数、notes.md 固定标题、`lesson_add`、少占上下文的规矩、operator 用法和"工具诉求"格式、截止后写总结、整节"合作"、整节"压缩时保留什么" → 没有派对仓库时也用第二版中文模板 `src/play/brief-zh.md` (手册主题表由我们的 ref 生成), describe.json 自己转 (`partykit.ts describeLines`, 联机那条也是); 离线生成核过 14 节齐、没漏填占位符。只本机的思路 (联机服务器基地的实例分析, 待核区) 两条路都没拷进 ref → 拷上。
- **用户定的规矩 7 条只在装模组路的简报里** → 抽成 `ours-brief.ts USER_RULES`, 不装模组路的简报也放。
- **不装模组路的工具诉求两头对不上**: 简报叫模型写进笔记、以"工具:"开头, 监工只收 operator 里"工具诉求"开头的 → 班末也从笔记收 (认"工具: / 工具问题: / 工具诉求:")。所有角色目录里模型报过、没人收的工具问题 16 条, 列在下面"还差"。
- **仓库开发规则**: 第二版仓库根的 CLAUDE.md (约定、写实验的硬规矩、大脑实跑、工具坑、记录去哪) 整份没搬, 新仓库里启动的会话读不到 → 新写 `CLAUDE.md`, 路径对到新项目, 不写原话和人。其中一条: 查语法要先去类型再 `node --check` (直接查不算数), 已按这个重查改过的 59 个文件, 0 个有问题。
- **第二版沙盘测试实跑** (无窗口, 不叫模型): 研究自动续 2/2 过; 看门狗 2/2 过 (服务器被杀 → 用最新自动存档重启、端口密码不变、读的是存档; 原来失败只是查的字段名 io_lab, 新沙盘模组回 mod); `./bp build` 备料 3 条要开窗口 (没有客户端时 `force.chart` 不生效, 2.1.24 实测 tick 在走、10 秒后 (0,0) 仍没探过; 11-06 起贴之前先试放, 第二版那时这两条就已过时)。事实回归 / 实验防线 / 喂料 3 个没跑成: 本机内存满 (用户在用电脑), 改天再跑。
**第三轮 (逐个比第二版改过的 76 个代码文件)**: 46 个只是路径适配, 24 个变成转接或搬家改写, 6 个真删了东西。修了:
- **群走默认路线 (不装模组) 开班只跑一班就停**: 第二版群开班一律连跑到停班; 默认路线改成不装模组后控制接口只起一次 online.ts → 新写接力 `core/run/relay.ts` (控制接口路线 memory 起它): 到点接着同一个世界开下一班 (存档 + 笔记 + 复盘), 停班 / 关游戏窗口 / STOP_AFTER 才停, 一班异常退出接上一份完好的 end.zip 再开、连续 3 次异常才停; 两班之间控制接口看 `play/relay.json` 不让再开一个。单元 `test/relay.test.ts` 5 条 (假的一班代替游戏)。没实跑过真游戏。
- **默认路线建新图不管群的和平 / 敌人设置** (界面开关不起作用) → 写进建图参数 `peaceful_mode` (游戏自带 map-gen-settings 的字段, 不是控制台)。"先留几分钟和平再关"这条路做不了。
- **不装模组路没有完整工具** (tools/、team-tools/、fhlib.py、拆好的游戏数据; 第二版这条路有) → 接上, 跨班带 (上一班 tools/ + data/play/team-tools-keep), 简报补那句。
- **`./know` 只剩 `./fh help 动作`**: 第二版查到物品会给 `./plan 物品 每分钟 (加 --build)`、`./bp list`、`./bp study` → 搬回 (`commands/know.ts nextCommands`), 动作名单加上角色目录 describe.json 里的; 角色目录实跑 `./know 红瓶` 第一行就是这三条。
- `npm run verify / lab:demo / lab:watch / lab:dump` 一启动就找不到模块 (src/lab 的 demo / defines 搬走没留转接) → 演示恢复第二版原文、常量转接; 全仓静态导入扫描 0 处断。
- `npm run bp` 被换成模型用的 ./bp, 代码里写的 `npm run bp -- inspect / check / render / link` 跑错程序 → 指回开发用的 `src/blueprint/cli.ts`, 模型那个叫 `play:bp`。
- 界面冒烟脚本还设 LAB_DATA_DIR (新项目认 DATA_DIR): 冒烟会在真数据里建群、关窗口时给真在跑的班写 STOP → 改用 DATA_DIR。
- PowerShell 版 `./calc` 丢了和游戏里 Factory Planner 对照的会话参数 → 恢复; 放行规则认回 `./fp` (装模组路 fp 配置) 和 `./fp sleep`; 只读连接联机服务器按群取 keys.json 的服务器 (原来一律连默认 server); `.env.example` 补 BRAIN_DIR / FBE / 备份命令; 装模组路角色分工那句英文改中文。
**还差 (没做)**:
- 每班笔记顶部的"上一班实测" (站着的比例、白干的动作、失败前三; 超长笔记归档) 靠派对的 handover.py, 没有派对仓库每班静默失败 → 要用自己的代码重写 (两条路共用)。
- `--keep-map` (只读连联机服务器时留一份地图, 刷新全图布局) 没搬; 带模组试连别人服务器时多带了沙盘模组 (联机服务器都不装模组, 影响低); 第二版基础版 harness 被对到派对版, ./fp 配置是否完全兼容没核。
- 不装模组路: 接力一班异常时丢这一班进度 (没有自动存档可接); 只用群的第 1 席。
- 模型报过、一直没人收的工具问题 (角色笔记里捞出, 去重 16 条, 多数是不装模组路的): transfer 往格子里放约 8% 报"放了 4 轮还不对: 手上只少了 N 个" (77 次里 6 次, 有时其实放进去了; `commands/body.ts`)、transfer 偶尔"窗口没打开"要重试、`./fh call sleep` 不认 `--until`、`research` 不能查询或取消、不带参数的 `technologies` 太长、抽水机放不下时原因不明 (62ed1ad 已部分修)、手搓面板不显示解锁条件、`inspect` 对刚放的木箱显示 placed unknown、`./fh view` 报 `find_tiles_filtered` 是 nil (11-07 前的, 假接口现在有这个函数, 待核); 想要的新工具: 一条命令看某条带子某条道上的东西、按 fuel_below 给一群燃烧机从最近的箱子补煤。都要在沙盘里核 (开窗口), 先问。
- 不装模组路没有 (第二版这条路也没有, 装模组路有): 看门狗 / 掉线重连 / 换班不关游戏、扩产提案、手搬统计、带子和布局检查、真人的话没回就催、研究队列空了自动排、每 90 分钟问工具诉求、截止后写总结、队列步骤自动加 walk。
- 放机器时查坐标 / 缺几台 / 手放第 N 台只在装模组路 (经 RCON); 不装模组路的 commands/hints.ts 要经代理查, 还没做。
- 装模组路: 截止前 10 / 3 分钟提醒没有 (不装模组路有); "上一班实测" (派对 handover.py) 没有派对仓库, 每班报没写成; 角色分工那句仍是英文 (run.ts 角色说明)。
- 这些改动都没在沙盘真跑一班核 (要开窗口 / 花额度, 先问用户)。

## 证据
`test/sandbox/run.test.ts` 5/5 (2026-11-07, 38 秒, 开一个游戏窗口): 干净的沙盘服务器 (mod-list 里只有 base / space-age 那几个) + 独立版客户端不带模组 20 秒进世界 → 注入 → 游戏外的模组起来 (`where.json`: RunCheck 在 nauvis, 有身体) → 开班扫描写出 world-scan.md / .json → 角色目录的 `./fh` (sh 版) 读背包、status、`build wooden-chest` 真放下 (背包 4 → 3) 并记 journal → `fh.ps1` 的 JSON 参数 `{"radius": 8}` 不拆坏 → 放 STOP 收工 `end.json why=STOP`, 服务器日志 `[JOIN] RunCheck` 且没有 desync, 游戏进程全关。第一次 0/5 的原因: 客户端带着沙盘模组连干净服务器被拒 (客户端日志只有 Connection refused), 改成按"连别人的服务器"的方式连 (不带任何模组)。

沙盘这条路一条控制台命令都不发 (2026-11-08 起; 之前开班用 RCON 发过一条退出开场动画 + 给料的命令, 用户看到成就页"因为使用了控制台指令"后改掉): 坠机过场按游戏提示的"确认消息"键跳过 (没跳也 12.5 秒自己结束), 起始物资就是游戏给的; `defines.json` 要先由沙盘测试 / 演示导出好, 缺了报错不经控制台读。`console_command_used` 读的是 false (沙盘测试核)。
