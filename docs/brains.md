# 大脑驱动 (core/brains) 和递积累的那段 (core/run)

第二块 = 训练集 (`training/`, 树见 `training/README.md` 第 7 节) 和大脑驱动一起搬。验收: 本机沙盘 (干净的服务器, 不装模组) 上 `--brain claude` (订阅) 跑一班, 看三样 —— 模型用 `./fh` 真建了东西; 回复里自动带出了经验和要点 (班末统计 > 0); `./know` 查到训练集的条目。花额度, 用户说开才跑。

## 目录树 (草图, 2026-11-07; `←` 后面是旧项目 src/play 里的来源, 照搬改名)
```
core/brains/                     接模型: 一轮 = 提示词进、Claude 形状的事件流出; 会话续接、强度、压缩点
  driver.ts                      Driver 接口, 按家选驱动, 跑一轮 (turn-N.jsonl, 翻译过的另存 -raw)   ← online-brain.ts, run.ts turn()
  claude-code.ts                 Claude 订阅 (claude -p --output-format stream-json); 换接口版 = DeepSeek / 中转站 (只换环境变量)   ← cc-env.ts, run.ts ccArgs
  agent-sdk.ts, agent-sdk-runner.ts   Claude Console 密钥 (Agent SDK, 输出同形)             ← 同名
  codex.ts                       GPT 订阅 / 中转站的 Responses 协议 (codex exec --json, 事件翻译)   ← codex-events.ts
  grok.ts                        Grok Build 命令行 (参数 + 事件翻译)                         ← grok-args.ts, grok-events.ts
  gemini.ts                      Antigravity 命令行 (账号地区不符, 搁置, 代码留)              ← antigravity-events.ts
  relay.ts                       中转站: 按站标的协议分流、本机小代理去 metadata、每模型一条最小请求核实   ← relay-route.ts, relay-proxy.ts, relay-verify.ts
  lineup.ts                      阵容 家:模型@强度, 默认模型, 角色名 = 模型名规范写法          ← brains.ts, model-name.ts, roster.ts
  probe.ts                       开班前一句试通                                               ← run.ts probeBrain
  hooks/                         给模型会话的钩子 (PreToolUse / Stop)
    permit.ts                    命令白名单: 只放行 ./fh ./know ./calc ./bp ./plan 和自己目录    ← permit.ts
    read-guard.ts                读文件禁区 (仓库源码、积累的原文件不给读; 大文件要分页)        ← read-guard.ts
    context.ts                   压缩点和 token 记账                                           ← context.ts, context-hook.ts, tokens.ts

core/run/                        (已有: online.ts workspace.ts scan.ts online-lib.ts shell.ts ps1-wrap.ts)
  online.ts                      + 叫大脑: 每轮 提示词 → driver → 回复; --brain 不再只有 none
  brief.ts                       简报生成: manuals/brief.md + 世界真实值 + 用户目标 + knowledge/points.md   ← run.ts BRIEF / briefFor, ours-brief.ts
  deliver.ts                     递积累: 开班登记种子 → 动作成功时附经验 / 配比 / 蓝图候选 (每角色每种一次) → 班末并回 lessons/pending   ← lessons.ts, fh-shim.ts, fh-hints.ts, hints.ts, calc-brief.ts
  supervisor.ts                  监工: 闲置、瓶颈、产量播报、体检只报新问题、工具诉求、真人的话催回    ← observer.ts, health.ts, replies.ts, run.ts sample
  human-chat.ts                  真人聊天: 客户端 chat_read → 转给被点名的 / 全队, 紧急才打断; 不替模型说话   ← human-chat.ts, io/human-chat-bridge.ts
  watchdog.ts, research.ts, peace.ts   看门狗 / 研究自动续上 / 开班和平分钟                     ← 同名
  shifts.ts                      连续换班不关游戏                                              ← shifts.ts, live-shift.ts, shift-recover.ts

core/records/
  summary.ts, review.ts, stats.ts, seen.ts   班次总结 / 复盘 / 每模型统计 / 模型看到了什么        ← digest.ts, review-shift.ts, review.ts, stats.ts, seen.ts, token-profile.ts

commands/                        (已有 fh)
  know.ts                        ./know 关键词: 查训练集 (事实 / 思路 / 要点 / 教训 / 资料)        ← know.ts, ref-sections.ts
  calc/                          ./calc: 离线计算器 (原型数据 + 线性规划)                        ← src/calc/
  bp/                            ./bp: list / show / check / build / view                        ← bp.ts, src/blueprint/
  plan.ts                        ./plan 物品 每分钟                                              ← plan.ts
```

## 搬的顺序
1. ✅ `core/brains/driver.ts` + `claude-code.ts` + `loop.ts` + `hooks/` (permit / read-guard / context / hook), `online.ts` 叫大脑 → 一句试通 `npm run brains:probe` (证据见下)。
2. ✅ 代码部分 (2026-11-08): `training/` 按树放进去 (training/README.md 第 7 节), `brief.ts` (模板 + 世界真实值 + 手册目录)、`deliver.ts` (开班读教训 → 行动层带出 → 扫描附要点 → 班末收笔记)、`./know`、`./fh` 包装 (手册分段、聊天标签、封顶、附经验) 接上; 单元 27/27, 沙盘 (见证据)。**真模型一班验收还没跑 (花额度, 等用户说开)**。
3. 监工 `supervisor.ts` + 递话 `tell.ts` + 体检 / 研究 / 产量 + 真人聊天 `human-chat.ts` + 班末总结 `core/records/summary.ts` ✅ (2026-11-08: 单元 `test/supervisor.test.ts` 8/8、`test/summary.test.ts` 3/3; 沙盘 run.test.ts 7/7: 0.9 分体检递"缺燃料 1 台: 石炉(0,0)", 2.4 分催闲 (门槛调到 20 秒), 话经模组账本进 `./fh call status` 的回复, 收工写 summary.json / review.md)。**其余驱动 ✅ (2026-11-08 02:3x)**: `driver.ts` 八家都接 (claude / claude-api / deepseek / relay 按站标协议分流 / codex / grok / gemini / none), 翻译器登记, `online.ts` 的 `--brain` 放开、角色名默认 = 模型名 (`lineup.ts botName`), codex / gemini / 中转站 Responses 模型没有命令白名单钩子所以 `--server` 直接拒; 单元 `test/brains*.test.ts` 43/43 (接线用临时 keys.json: 程序 / 参数 / 环境 / 翻译 / 代理起停; Codex 形状的一轮翻成 Claude 形状并接 thread_id; Grok 形状的试通从 assistant 取正文); `online.ts` 四种参数错都在开游戏前退出码 2 (不认识的家 / 中转站没模型 / 联机拒 codex / 密钥没填报在哪填)。**各家真跑 (一句试通) 还没在新项目做** (旧项目 11-04 ~ 11-05 的实测见各文件头): `npm run brains:probe -- --brain codex|grok|deepseek|relay|claude-api` 花一点额度, 用户说开才跑。"问题"表里的两个修法 ✅ 02e57d1 (下面)。
4. `./calc` `./bp` `./plan` ✅ 代码部分 (2026-11-08 03:xx; 用户要求整目录复制、不改名): 第二版的 `src/calc`、`src/blueprint`、`src/play/{bp,bp-fit,bp-gather,bp-online,bp-study,plan,plan-lib,calc-brief,layout-study,expand,format,harness}.ts`、`src/dataset/feed.ts`、`src/lab/names.ts` 原样放在本项目 `src/` 下 (路径、文件名都没动), 第二版里被它们 import 的 lab / io / play 模块在新项目里已另有家, 用 `src/lab/*.ts`、`src/io/*.ts`、`src/play/{argv-file,chattags}.ts` 几行转接; 本机数据路径改成 `data/training-private/blueprints/` (bp.ts BP_DATA / datasetDir)。角色目录多了 `./calc` `./bp` `./plan` (sh + ps1, `core/run/workspace.ts`); `./plan` 不再连 RCON, 场上读数和找空地经同一条管道的 `plan_read` (只认 existing / site 两段固定 Lua, `commands/broker.ts` 在游戏外的假接口上跑), `./bp build` 走 bp-online.ts (玩家操作)。证据: 搬来的单元 52/52 (6 个按条件跳过); `./calc '{"targets":{"automation-science-pack":30}}'` 算出 4 台红瓶机 + 4 铁炉 + 2 铜炉; `./bp list` 列出数据集、`./bp show 1` 读出物品清单; 没管道时 `./plan` 报在哪能用。**验证班 (2026-11-08 04:0x, 沙盘新图, 不叫模型, 班次 verify-tools-2026-11-08)**: 角色目录里 `./plan 红瓶 30` 算出差 5 石炉 / 5 组装机 / 7 采矿机并附朋友基地红瓶线的字符图 (场上读数经 plan_read 在游戏外的假接口上跑通); `./calc` 出表; `./bp build 一台石炉的.json --at 4,4` 真放下 (回复 "新放 1 件", 并查好下一块的位置); `./fh call build` 热能采矿机 (走过去放到铁矿上) 的回复后面附了教训 2 条 + "整块建 ./plan automation-science-pack 30 --build" + 相关经验 2 条。查出并修了一个环引用 (bp.ts ↔ bp-study.ts, `./bp build` 顶层 await 卡死)。
   **真模型第二班 (04:0x 前, Haiku 中强度 30 分钟, 班次 haiku-2026-11-08b, $0.08)**: 和第一班一样全程手挖 + 热能采矿机 + 石炉, `./calc` `./bp` `./plan` 一次没用 (简报里写了也不用; `./know` 2 次), 红瓶 0, 23 分钟就说"快到截止"然后 sleep 到点。→ 按第二版的做法把积累硬塞 (346145f): 放机器时回复附配比 + `./plan` 命令 + 库里的块 (`commands/hints.ts` buildHint, fh.ts 递 calc / blocks), 开班扫描多一段"规划: 下一档 + 命令" (`scan.ts`), 开场提示先跑 `./plan automation-science-pack 30` (`online.ts`), 监工开班 8 分钟红瓶还是 0 就递命令 (`supervisor.ts` toolTells)。效果要下一班真模型看。
   **真模型第三班 (04:3x, Sonnet 中强度 30 分钟, 班次 sonnet-2026-11-08, Claude Code 估价 $14.60 / 订阅额度)**: 第一条命令就是 `./plan automation-science-pack 30` (开场提示起作用), 班中又跑了一次 (plan_read ×2), 照它的清单建了 3 条铁线 + 2 条铜线 (热能采矿机直塞石炉; 机器 1 → 14 台), 没电、没组装机、红瓶 0; 请求 489 次 (observe 287), 失败 3%; 中文规矩管不住短句 (30 句小结里 10 句英文); **17 轮里 12 轮不到 1 分钟就收** ("继续"提示被当成"汇报一下": 查状态、补一次煤、写小结, 每轮重起进程重读上下文, 缓存读 555 万 token)。管理员经 tell.txt 说的话它收到并回了 (operator ×2)。**结论**: 三班都从空手开新图, 30 分钟永远停在烧煤阶段, 比不出工具的用处 → 改了三处 (提交见 git): 收工存 end.zip + `--notes` 接上一班笔记 (同一个世界连续跑), "继续"提示改成"接着干到截止, 不用汇报", 提示里再写一遍全程中文。
   **真模型第四班 (06:3x, Sonnet 中强度 30 分钟, 班次 sonnet-2026-11-08b, 估价 $11.77)**: 硬塞 + 新提示词之后第一班。`./plan` ×2 (开局和第 2 轮开头, 第 2 次自己降到 10/分), 放建筑 46 次 (上一班 21): 热能采矿机 9、石炉 7、抽取泵 + 蒸汽机 + 电线杆 (通电了)、研究中心 1、组装机 1 → **机器做出红瓶, 整班平均 0.7/分, 研究 0 → 4 项** (前三班都是 0); 英文句 5/25 (上一班 10/30); 失败 12% (19 次放不下: 位置被别的东西挡), 没用 `./bp` (库里没有开局档的块); 第 3 轮起仍每轮几十秒就收 (提示词只管住了前两轮)。收工存了 end.zip, 下一班 `--save 它 --notes 它的角色目录` 接着玩。
   **第五班 (10:1x, Sonnet 接第四班存档, 班次 sonnet-2026-11-08c)**: 接档成功 (开班扫描读到红瓶 2.0/分、研究中心 1 台), 但 9.6 分客户端窗口被关 (日志: 客户端这边退出, 不是服务器踢的; 用户那会儿在开界面 / 游戏), 班提前收工, 仍存了 end.zip (服务器还在, 世界没丢; summary 里 "18 → 0 台" 是掉线后读的空值, 不是真的拆了)。下一班接 sonnet-2026-11-08c/end.zip。
条目格式 (training/README.md 第 3 节) 边搬边定, 搬完再统一; 每步有测试, 旧项目对应文件搬完就删。

## 怎么用
```
npm run brains:probe -- [--brain claude] [--model claude-haiku-5-5] [--effort low]   一句试通 (不开游戏, 花几厘钱): 命令行、登录、钩子
npm run run:online -- --lab --brain claude --model opus --effort low --minutes 30   沙盘真模型一班 (花额度, 用户说开才跑)
```
角色目录里: `.claude/settings.json` (压缩点、钩子; 只对这个目录生效)、`.context-hooks` (钩子只在有这个标记的目录起作用)、`context.log` (钩子日志: 放行 / 拒绝 / 提醒 / 压缩)、`.context-state.json` (hooksSeen = 钩子装上了的证明)、`compactions.md` (每次压缩的摘要)、`.inbox.md` (监工的话, 下次工具调用后塞给模型)。记录目录里: `turn-N.jsonl` (每轮的事件, Claude 形状)、`brain-stderr.txt`。

模型手里的工具: Bash (只放行 ./fh ./know ./calc ./bp ./plan 开头的, 循环 / 管道 / cd 自己目录由 permit 钩子放行, 别的拒并说明原因)、Read / Grep / Glob (只读自己目录和上一层; 源码 / 模组 / 本机数据不给读; > 30KB 要分页; 简报不重读)、Edit / Write。

## 证据
- 第 ① 步 (2026-11-07): 单元 `test/brains.test.ts` 6/6 (拦截、参数、跑一轮的会话号接力和假命令行、轮次循环的间隔 / 停 / 打断、试通判定、设置指向真实的 hook.ts)、`test/permit.test.ts` 5/5 (派对的例子 + 旧项目实跑被拒的命令都放行, 派对版的 3 个漏洞和 22 种绕法都拒, 钩子进程真跑)、`test/context.test.ts` 5/5 (压缩点换算、提醒、日志裁剪、会话日志读数、钩子进程: 收件箱 / 压缩后贴笔记 / 截止前 2 分钟拦自动压缩)、`test/read-guard.test.ts` 3/3。
- 一句试通 `npm run brains:probe` (Claude Code 2.1.319 订阅, claude-haiku-5-5, low): 通, 8.5 秒, $0.0035; 模型跑了 `echo 收到` (echo 不在 --allowedTools 里, 是 permit 钩子放行的: context.log 有 permitted), post-tool 钩子记了 hooksSeen; 记录在 data/play/probe/2026-11-07T15-24-05。
- `online.ts` 的参数检查: 无参数 / `--brain codex` / `--effort 坏` 各报对应的话退出码 2 (模块能加载)。
- 第 ② 步代码部分 (2026-11-08): 单元 `test/lessons.test.ts` 8/8、`knowledge.test.ts` 3/3、`hints.test.ts` 8/8、`chattags.test.ts` 3/3、`ref-sections.test.ts` 3/3、`brief.test.ts` 3/3、`fh-wrapper.test.ts` 1/1; 沙盘 `test/sandbox/run.test.ts` 6/6 (44 秒, 不叫模型): 开班读到种子 68 条 + 之前各班的 70 条; 放木箱的回复带出 2 条教训 (建造前先清场 + 一条之前模型记的标"没核实"), 放石炉后面附"相关经验 (./know 石炉 看更多)"; 开班扫描后面附要点 (刚开局对得上); `./know 研究中心` (sh) 和 `know.ps1 地下管道 方向` 都查到; `./fh help building` 回目录, `./fh help pattern-production P-prod-01` 回那一段并记 journal; 简报模板填满, ref/ 有 building / pattern-production / facts / names.tsv。**真模型一班 (验收)**: 2026-11-08 01:0x, 沙盘新图, Claude Code 订阅 claude-haiku-5-5 低强度 30 分钟 (班次 data/play/online/2026-11-07T15-53-30, 日志 turn-1~4.jsonl)。三样里两样过: ① 模型用 ./fh 建了东西: 10 台热能采矿机、5 石炉、6 箱 (铁 / 铜 / 煤 / 石各有矿在出), 铁板 365、铜板 88、手搓红瓶 10, 没接电没研究 (附近没树做不了电线杆); 动作: 走路 31、放建筑 26、取放 107、手搓 15、说话 7 (聊天带 gps 和图标标签), 请求 4 轮共 112 个 Claude 回合; ② 回复里带出经验 74 次 (40 条不同的), 班末笔记 11 条教训收进待核区 8 条 (training/lessons/pending/learned.jsonl 末 8 行); ③ `./know` 一次没用 (查过 `./fh help facts / build / transfer` 3 次)。钩子: 放行 94 条 (循环 / 管道 / 重定向), 拒 1 条 heredoc 写笔记、拦 1 条 sleep 写法。Claude Code 估价 $0.10 (订阅额度; 第 1 轮 1707 秒 103 回合, 缓存读 515 万 token、输出 4.3 万)。
  发现的问题 (要修的记在下面"问题"): 行动层取放不稳 (18 条失败里 7 条: "放了 4 轮还不对" ×5、"窗口没打开" ×2); 模型把自己放的采矿机当成别人的 (放第二台被挡时回复只说 blocked by burner-mining-drill); 24.7 分就宣布班末然后 sleep 200 + 240 到截止 (没监工催); `./know` 没人用 (简报里有, 模型习惯 ./fh help)。

## 问题 (实跑查出, 待修)
| 发现 | 班次 | 要改的 |
|---|---|---|
| transfer 给燃料 / 取东西 "放了 4 轮还不对: 那格 N 个 (要 M)" ×5、"背包窗口没打开" ×2 | 11-08 Haiku | ✅ 02e57d1: 按手上减少的数算成功, 不再数目标格 (在烧的炉子燃料格会被烧掉); 一组不够就取最大的一组再来 (`commands/body.ts` #splitUntil / takeExactDirect); 沙盘用例 `test/sandbox/actions.test.ts` "相邻两台在烧的炉子" (单跑过; 全量跑时和前面用例的组装机重叠, 坐标已挪到 +28 列, 全量还没重跑) |
| 自己放的建筑在第二次 build 被挡时, 回复不说是谁的, 模型当成别人的、绕着走 | 同上 | ✅ 02e57d1: 放不下的回复带上是谁放的 (自己的就说"你自己放的") |
| 模型闲了就 sleep 到截止 | 同上 | 第 ③ 步监工: 闲 3 分钟就催 + 报瓶颈 |
| `./know` 零次 | 同上 | 回复附经验已经在做 (74 次); 简报里把 ./know 放到"看"那一行最前面再看下一班 |
| 放建筑失败 19 次 (12%): 17 次是抽水机放在不是岸边的格子, 回复只说"那格是空的", 模型换个格子再试一直错; `./fh call nearest_water` 的 `pump_note` 报 "can_place_entity (a nil value)" (游戏外的假接口没有放置检查, placements / drill_sites 也都用不了) | 11-08 Sonnet 第四班 | ✅ 本次提交: ① 假接口补 `can_place_entity` (`game/offgame/placeable.lua` 纯函数: 占地框里挡建造的实体 + 脚下地块的碰撞层 + 原型的 tile_buildability_rules, 抽水机 = 脚下陆地 + 正面 3x2 水, 和 shore.lua 同一个读法; 地块没读到明说不编) → `placements` / `nearest_water` 的抽水机位置在不装模组的路上能算了; ② 行动层放不下时多说几句 (`commands/actions.ts` placeWhy): 那格地块、离多远 (够不着)、抽水机的岸边规则、附近真放得下的位置 (问模组 placements, 12 / 6 格内 3 个) 或 "换一片水: ./fh call nearest_water"; dry_run 单件被挡也带 `spots`; `commands/broker.ts` 多一个 `read()` 给行动层问模组。单元 `test/placeable.test.ts` (lupa 里 17 个用例) + `test/actions.test.ts` 3 条; 回放快照上 placements / nearest_water 跑通不报错。**沙盘里真放抽水机还没核** (要开窗口; 现有用例 test/sandbox/actions.test.ts "抽水机放得上" 跑一次就行) |
