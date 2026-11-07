# 通读 factorio-ai-party (2026-11-03)

起因:。之前只搬了模组、读了架构, 没读他们怎么用工具; 第八~十轮效果下降。
读法: 本机克隆 factorio-ai-party (e98eb874, 2026-11-02, MIT), 分 7 份由只读子代理逐个文件读完, 结论由我汇总。仓库约 57 万行: agent 4K、tools 22 万、docs 3.5 万、site 3.9 万 (618 个是游戏图标)、mod 15 万、tests 9 万。

## 最重要的结论
1. **差距不在模型**: 他们 9 个玩家里有 3 个 Claude (Opus / Sonnet / Haiku); 3 个模型前 30 分钟追平 9 个 (docs/studies/shake4.md:556-561)。差距在工具怎么用、简报写什么、复盘循环。
2. **Claude 的空闲来自"一步一个动作"**, 不是想太久 (每步只想 1.5~4 秒, shake1-transcripts.md:43-47)。会用队列 / 常驻命令的角色空闲 0~6%, 一次一条请求的 43~85% (docs/STANDING-ORDERS.md:8-21)。
3. **睡眠失控**: Opus 睡眠占比从 14% 涨到 96% (docs/studies/sleep.md:9-13); 病根是没有"等到某件事就醒"的等待, 以及 wait_until 会暂停队列。
4. **功能不写进简报就没人用**: 团队计划写进简报前一班 0 次、之后 43 次 (shake11.md:20-22, shake12.md:32-33)。
5. **泛泛的监工提醒几乎无效** (15 条 2 条有回应); 队友点名一个具体故障 11 秒就动 (studies/2026-10-13-agent-minds.md:27-29, 110-111)。
6. **他们的监工是普通脚本** (idle_nudge.py、supervise.sh), 另有一个长期运行的 Claude Code 会话当操作员 (换班、读需求、写简报、合并、部署)。我们: 监工 = run.ts, 操作员 = 开发会话。
7. **猜参数**: 70% 是重犯自己的错, 61% 照抄文档示例 (agent-minds:125, 138); 压缩之后最集中。手册 + describe.json + 报错里写合法参数是他们的解法。
8. **他们没有"接手别人的乱基地"的做法**, 世界一直是自己的; 这部分要我们自己做 (清场脚本、体检、接班先修)。

## 搬了什么 (状态以提交和核对为准)
| 做法 | 出处 | 我们 | 核对 |
|---|---|---|---|
| 整套简报 + 400KB 手册 + `./fh` | agent/、tools/brief.py、vendor host | src/play/partykit.ts、fh-shim.ts (ce4fcf2) | 新地图干跑 A/B 全过 |
| 简报译成中文 | — (他们没有这个问题) | src/play/brief-zh.md (c178a91) | 第十二轮前 5 分钟英文 0 句 (第十一轮一半) |
| Bash 超时 20 分钟、关自动记忆 | tools/clean-profile.py:63-76 | context.ts (4b13963) | 干跑设置文件已有 |
| 截止前 2 分钟不压缩 | tools/context.py:635-646 | context-hook.ts (4b13963) | 钩子实测: 1 分钟拦、60 分钟放 |
| 换班笔记加"上一班实测" | tools/handover.py carry | run.ts (7cc5049) | 用第十轮数据实测 |
| 监工发操作员私信 | tools/idle_nudge.py:819-898 | run.ts tellAgent (c7b1e7e) | play:check 通过; 第十二轮实跑无失败 |
| 开班 shift_start | tools/start-team.sh:279-287 | run.ts (c7b1e7e) | play:check + 实跑日志 |
| 常驻命令写进简报 | docs/STANDING-ORDERS.md:96-98 | brief-zh.md | play:check 常驻补燃料 13.8 秒补完 |
| 等待规矩 (睡觉不算玩、--until、动作暂停队列、≤60 秒) | docs/studies/sleep.md:253-288 | brief-zh.md (5d02bd8) | 待第十三轮看睡眠占比 |
| 分工: 不用先问, 做完告诉负责人 | agent/team.md:22-25 | partykit.ts (5d02bd8) | 待实跑 |
| 截止后写总结 | sleep.md 第 10 条、supervise.sh | run.ts (5d02bd8) | 待实跑 |
| 中文聊天截断导致整条回复失败 | (他们不说中文, 没碰到) | 模组 control.lua 出口去坏字节 (7dafaef) | play:check 通过 |

11-03 19:1x 核对远端: 比本机多 8 个提交 (到 73e5dec7, 11-03 01:55 PST), 只改 site/content/operator-updates.json (第 126、127 班换班通知), 代码没变; 他们已跑到第 127 班。

## 还没搬的 (按影响排)
1. **移植漏改的 2.1 问题** (模组本体通读核出, 读代码推断, 待沙盘核实): upstream.lua:563/625、thrust.lua:189/365 把 `e.fluidbox` 当参数传 → trace upstream 报错; PipeConnection.target 在 2.1 是实体不是流体盒 (thrust.lua:56/67/370、conflicts.lua:60、endurance.lua:298、libareas.lua:101); runtime.lua:16992 配方 `.category`; 次要: flameroil.lua:38、circuits.lua 改名、craftrate.lua 品质除两次 10。端口脚本加自检。
2. **复盘脚本组** (tools/analysis/: journal_gaps、journal_errors、transcript_steps、sleep_share; idle_report.py; shift14_friction 的分组方法): 每轮自动出摩擦表, 修损失时间最多的前三。他们的研究报告格式: P1 (下一班前必须修, 带证据和源码行) → 结论 → P2/P3, 下一份先复核上一份 P1。
3. **工厂摘要私信** (tools/factory_digest.py:157/215/307 + stream/hauling.py): 按认领范围只发新出现或变化的阻塞, 附"你这一班最常手搬的一条"。模组读数已有, 只缺监工端。
4. ~~**permit.py 钩子**~~ (他们给 Claude 的 PreToolUse): 只含白名单程序的循环 / 管道直接放行。**2026-11-03 已搬** (分支 party-port, `src/play/permit.ts` + `test/play-permit.test.ts`): 比他们紧 (他们有 Claude Code 沙箱兜底, 我们 Windows 上没有); 用他们自己的 `permit.py --check` 核出三处会放行危险命令 (`echo a#; rm -rf .`、`./fh call status |& rm -rf .`、`for f in /etc/x; do echo hi > $f; done`), 我们的切词不再放过。拿 11-02~11-03 实跑里 92 条被 dontAsk 拒的命令算: 换上后放行 36 条, 2 条是循环里 sleep (等待规则照拒); 剩下的主要是 heredoc 写笔记 (23)、sed (12)、`${p%,*}` 参数展开和变量赋值 (派对也不放)。还没在实跑里看过效果 (要花额度)。
5. **每 2 分钟计分** (tools/pog.py:69 SCORE_LUA) + 科技路径和用时 (tools/analyst/kb.py) + 跨轮同游戏分钟对比 (history.py)。
6. **完整工作区** (tools/full_tools.py:451): 自用 tools/、共享 team-tools/、只读 gamedata/。
7. **看板**: 实时状态格式 (site/live/state.example.json、push_live.py:737-817)、角色卡 (live.js:909-925)、地图 16 图层 (mapview.js)、变更记录格式 (site/updates.py)。游戏图标不能搬 (Wube 只授权给他们非商业网站)。
8. **测试**: 478 个 Lua 假引擎测试, 和我们毛病相关的约 30 个 (燃料、清树、堵塞、混装、采空、研究、空闲); 2026-11-03 挑了 25 个试跑过, 评估和计划见下一节。
9. **开跑探针** (agent/grok-probe-prompt.txt): 开跑前让大脑报告工具、规则文件、会不会被拒。

## Lua 假引擎测试: 评估和搬的计划 (2026-11-03, 还没搬)
**他们怎么测**: `vendor/factorio-harness/tests/` 下 478 个 `.lua`, 另有 94 个 `.test.ts` 逐个调 `lua tests/X.lua` (`LUA_BIN`, 他们用 Lua 5.4)。每个测试是纯 Lua 脚本: 自己造 `game` / `defines` / `prototypes` 和假实体 (只填被测函数会读的字段), `dofile('mod/agent-harness_0.1.0/<模块>.lua')` 拿到模块, 调函数, 对回复原文做字符串断言。不开游戏, 单模块的一个一两百毫秒。按加载的模块数, 大约三分之二是太空平台、货运、火箭、腐坏 (runtime 120 个、conditions 51、scheduler 42、freight 34、space 27…), 和我们现在的毛病无关。

**试跑** (本机没装 Lua, 用 fengari —— npm 上纯 JS 写的 Lua 5.3 —— 装在仓库外的临时目录; 把测试里的模组路径换成 `mods/agent-harness-party/` 跑我们的移植版, 同时跑上游原版对照):

| 毛病 | 测试 (测的是什么) | 上游版 | 我们的移植版 |
|---|---|---|---|
| 燃料 | burnt (燃烧残渣格满了把燃烧室卡停)、boilerfeed (锅炉燃料少时说出喂它的机械臂和那条带子的断口)、orders (常驻命令: 炉子缺燃料自己补)、conditions (fuel_below 等条件)、round0320b2 (补燃料一圈 fuelround + 带子断口)、round0150c (补料前先清掉燃烧残渣和废料)、d17_batch14 (常驻命令的走路上限、睡觉时不启动命令)、d16_batch10、d20_batch52 | 过 | 过 |
| 清树 | d25_batch207b (排队的建造等清障做完再算完成)、construction (连续建造: 拒放时给出续建位置、不覆盖方向冲突的带子) | 过 | 过 |
| 清树 | d18_batch36 C1 (build {clear_obstacles}) | 过 | **挂**: 上游断言"够不着的 1 棵留给建设机器人", 我们第八轮有意改成没有建设机器人覆盖就走过去手砍 —— 测试正好抓到这处行为差异 |
| 堵塞 | trace (带子尽头满了没人取、长臂读的箱子不对)、beltflow (带子尽头下一格站着什么)、d24_batch157 (fullchest: 箱子满、谁的产物在等它)、d17_batch17 C1 (带子被实体挡住) | 过 | 过 (d17_batch17 前几段) |
| 堵塞 | outputstop (产物满了停机, 按产物说哪一样到了上限)、d17_batch17 后段 (管道断开) | 过 | **挂**: 假实体是 2.0 形状的 `fluidbox` 字段, 我们的 `compat21.fluidbox` 只走 2.1 的 `fluids_count` / `get_fluid(i)` —— 测试要垫片, 不是模组错 |
| 混装 | trace 2b (矿石侧装进板材主带: 说出"你的矿会混进去"和侧装进来的那条带)、sidefeed (地下带入口侧面喂料进哪一道)、beltpick (从带子某一道手拿物品)、beltsample (按物品采样每段带子)、batch381 (原生连接认出两道并成一道的合流, 两道同一物品或空的也认) | 过 | 过 |
| 跑不了 | idle (闲置报告; 带整个 runtime, fengari 下两边都 120 秒没跑完)、d15_batch3 (fengari 没有 `io.tmpfile`)、d15_batch4 (上游在 fengari 下也挂, 数值对不上, 应是 Lua 5.3 / 5.4 或 pairs 顺序差异) | — | — |

**结论**: 能搬, 值得搬。试跑的 25 个 (另有 1 个太空平台改名的顺带跑了) 里: 19 个原样在移植版上通过, 3 个挂 (2 个是流体缺 2.1 垫片, 1 个是我们有意改过的清树), 3 个 fengari 跑不了; 改移植脚本 (流体、清树、UTF-8、运行时隔离、下次再拉上游) 之后拿它们做回归, 比开游戏 play:check 便宜得多 (不开游戏、一个零点几秒), 而且能看出行为变了没有。fengari 只能当参考: 慢 (带整个 runtime.lua 的测试要一两分钟, idle 跑满 120 秒没完), 也不是他们的解释器。

**计划** (不开游戏, 不花额度):
1. 解释器用 Lua 5.4 (和他们一样)。本机 Windows 要装一个 (winget 上的 Lua 5.4 包, 装前跟用户说); CI 用 ubuntu 的 `lua5.4`。没装就跳过, 不让 `npm test` 失败。
2. `tools/port-party-tests.py`: 从 `PARTY_REPO` 把挑出的测试复制到 `test/party-lua/` (MIT, NOTICE 署名), 改模组路径、开头补 `package.path`、先加载垫片 `test/party-lua/shim21.lua`: 给带 `fluidbox` 字段的假实体补 2.1 的 `fluids_count`、`get_fluid`、`get_fluid_capacity`、`get_fluid_filter`、`get_fluid_box_pipe_connections` (PipeConnection.target 给实体), `defines.inventory` 的新旧名字都给。
3. 我们有意改的行为写成补丁表 (照移植脚本的 `FLUID_FIXES`): d18_batch36 的清树断言改成"走过去手砍", 再加一段"有空闲建设机器人覆盖时留给机器人"。补丁对不上就报错 (上游改了要人看)。
4. `test/party-lua.test.ts`: 每个 `.lua` 一个 `node:test` (照他们的 `*.test.ts`), 进 `npm test`。
5. `party-upstream.ts` 的 PORTS 登记这些测试文件, `party:check` 上游改了就提示重新复制。
6. 以后改移植脚本的补丁 (第八、九、十轮那种), 先照他们的写法补一个假引擎测试, 再进沙盘 play:check。

## 不搬的和原因
- 开班暂停世界 (start-team.sh:153-181): 用户定不要, 联机服务器是别人的。
- bridge/ (客户端桥, 用于不装模组的服务器): LD_PRELOAD 注入 Linux 客户端、只认 2.0.77、二进制逆向, 和"不用 IDA"冲突。只把协议语义写进 io-client 文档: 回复只代表"已提交"; 断线报 outcome_unknown 不重放; 人按键时把控制权还给人。
- 直播、配音、美术、观众、投票、YouTube (tools/stream/ 359 个文件等): 和玩法无关。
- 交互式窗格 (Herdr): 我们 `claude -p --resume` + 钩子功能上等价 (钩子在 -p 下也生效)。

## 别家模型
他们用各家官方命令行 + 账号登录, 不用 API 密钥 (docs/PLAN.md:34 "subscription CLIs"): GPT 跑在 OpenAI Codex (agent/harness-codex.md, Codex 0.162.1), Grok 跑在 xAI Grok Build (grok-4.7, `~/.grok/auth.json`, tools/grok-home.py 刷新登录), Gemini 跑在 agy。各家的超时、压缩、钩子写法见 docs/CONTEXT-NOTES.md、LAUNCH4-NOTES.md、tools/launch-agent.sh 各分支。哪一档订阅包含命令行工具、Windows 能不能跑, 他们仓库没写, 买前要核实。
