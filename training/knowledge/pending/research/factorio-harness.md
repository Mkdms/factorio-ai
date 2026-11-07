# 研究: factorio-harness 和 factorio-ai-party

> 2026-11-02 读了上游 [CarsonBurke/factorio-harness](https://github.com/CarsonBurke/factorio-harness) (提交 bcc2e9d, 2026-09-26, MIT) 和 [nwinter/factorio-ai-party](https://github.com/nwinter/factorio-ai-party) (提交 1f71bdac, 2026-11-02, MIT; 里面带一份 factorio-harness 的分支版 `vendor/factorio-harness/`)。只读代码和文档, 没有运行。下文路径: 上游的相对 factorio-harness 仓库, 派对的相对 factorio-ai-party 仓库。
> 起因: Claude 玩 Factorio 效果差, 要核项目方向; 派对用这个 harness 让 9 个模型在太空时代玩到钷素科技包 (docs/references.md)。用户定: 先细读它, 再在沙盘做大脑的完整链路 (roadmap M4 行)。

## 一句话
大模型跑在现成的编程助手里 (Claude Code、Codex…), 每个动作发一条 `fh` 命令, 经 RCON 交给服务器端 Lua 模组按"生存规则"逐 tick 执行, 回一段压缩过的短文字。**和我们沙盘那条路是同一个做法**; 它多做了"像玩家一样"的规则和大量高层动作, 我们多做了联机身体 (io-client) 和知识核实。

## 1. 上游 factorio-harness (Lua 7100 行 + TypeScript 2300 行)
- **结构** (`docs/architecture.md`): `fh` 命令行 (TypeScript, 没有生产依赖) → RCON `/silent-command remote.call("agent_harness","dispatch",json)` → 模组。请求 `{id, action, player, args}`, 回复 `{id, ok, tick, result}` 或 `{ok:false, error:{code,message}}`。理由: 要逐 tick 做的事 (走路、寻路、采矿、战斗) 必须在游戏里跑, RCON 只传粗命令和有上限的观察; 选命令行不选 MCP, 因为模型本来就有 shell 工具 ("MCP 以后可以加, 协议不用改")。
- **约 48 个动作** (`runtime.lua` handlers): 读 (describe、status、map、nearest、scan、observe、inspect、power、grid、rates、bottleneck、stock、recipes、technologies、platforms、craftable、screenshot); 移动 (walk、move_to 寻路、kite 边走边打); 采集 (mine、pickup、collect); 手搓 (craft、cancel_craft); 建造 (build、build_path 连续铺带子、construct 按虚影实建、place_ghosts、revive_ghost、rotate、configure、wire); **路线规划** (belt_route、pipe_route: 绕障碍、自动用地下带 / 地下管、可侧向汇入指定道; 只出方案, 调用方放虚影); 补给 (refuel、rearm、transfer、repair、equip、equipment); 研究 (research、research_next); 战斗 (shoot)。动作参数按 describe 校验, 拼错的键直接拒绝。
- **生存规则** (`docs/usage.md` Rules): 东西必须在自己背包里、够得着、花真实游戏时间; 不生成物品、不瞬移、不揭地图。远程视图能做的 (configure、请求、发射; 已探索区的虚影和拆除标记) 允许远距离做。不支持: 载具、铁轨、电路编辑、流体转移。
- **只给玩家看得到的**: 威胁 (`threat.lua`: 进化度、污染云碰到哪些虫巢、受攻击告警) 只读已探索区的建筑、可见区的虫群; 工厂概况 (`survey.lua`: 科技包和板材速率、研究剩余时间、机器状态、缺燃料 / 缺电、"还有多少靠手搓") 只给生产面板、状态图标、背包里有的数。
- **反射写在游戏里** (`safety.lua`、`kite.lua`): 走路时盯着敌人和血量, 危险就退回路上最后一个安全点并还击, 以 `threat` 结束; 用装了弹的最好的枪。
- **速率** (`rates.lua`): 按 RateCalculator v3.3.8 (raiguard, MIT) 的公式算每台机器的最大速率 (配方、插件、插件塔、品质、燃料), `bottleneck` 在上面找瓶颈; `stock.lua`: 自己工厂里哪儿已经有这个物品 (别手搓机器已经做好的)。
- **时间**: 定时动作马上回"已接受 + 预计结束 tick", `--wait` 等结果; 完成记录分清"时间到了"和"目标没了 / 够不着 / 工具耗尽" ("走够时间不等于到了")。**游戏内队列** (`scheduler.lua`): 多步计划在游戏里按 tick 跑, 步骤可重叠 (边走边打), 失败暂停, `on_fail` / guards, 改队列要带版本号 (乐观锁), 人直接动角色就暂停队列。
- **可靠性**: 请求带 id 可安全重试 (同 id 返回缓存结果, 存最近 256 个); 断线报 `outcome_unknown`, 绝不自动重放 (和 factorio-mcp 一致, io-client.md 9b); Lua 热更新 (`fh deploy`: 校验后替换, 出错隔离 tick 循环、读照常); 状态只放 `storage.agent_harness`。
- **给模型的文字** (`host/format.ts`): JSON 给程序, 给模型的是压缩表格: 成功不打 ok/id, 空和 false 省略, 坐标写 `x,y`, 物品写 `名字*数量`, 同类记录打成共用表头的表, 数字留 2 位 —— "只在信息上花 token"。
- **测试** (`docs/testing.md`): 单元测试 (假引擎跑 Lua 规则) + 真游戏冒烟 (无界面 2.0.72: 初始化、RCON、id 去重、热更新、坏 Lua 被拒、存读档) + **连真客户端的玩法测试** (2.0.77 + 太空时代, Xvfb 单独显示: 手搓 / 建造扣料、部分转移、挡住的建造不吞物品、蓝图导出导入、虚影实建扣料、边走边打、队列冲突、截图、角色死亡后队列暂停)。夹具用控制台造空地和给背包, 动作本身 `cheat_mode=false`。无界面服务器不能用 Lua 造 LuaPlayer, 角色要有连着的客户端才存在 (和我们 lab.md 观看窗口的经验一致)。
- **客户端桥** (`docs/bridge.md`): **在别人的服务器上** 通过自己的客户端玩, 服务器不用模组和 RCON —— 就是我们 io-client 里"直接发玩家动作"那条路 (io-client.md 第 9 节第 4 条): 注入库替换 `PlayerInputSource` 虚表的两格, 在 tick 之间读状态 (只用不改状态的访问函数, 例: 自己遍历区块表, 不调会生成区块的函数), 动作用游戏自己的网络加载函数 `InputAction::loadConstructActionData` 从字节流构造; **人一按移动键或点挖就让出** (我们 T15 要的)。2.0.77 Linux 上核实: 走路、手搓、采矿、建燃烧采矿机, 服务器状态一致; 2 分钟随机 120 条命令不掉同步; 客户端被杀后重连状态正常。限制: 只认那一个版本 (偏移从反汇编推出来)、只有 Linux、动作少 (observe、scan、walk、mine、build、craft、stop), 不能和实体交换物品。
- 运行环境: Linux, Factorio 2.0.72 / 2.0.77, 太空时代可选; 启动器按 Steam 路径找游戏、可放进嵌套合成器不抢焦点。

## 2. 派对里的分支版 (`vendor/factorio-harness/`)
2026-11-02 子任务读、我抽查核对过的结论 (路径相对 `vendor/factorio-harness/`, `mod/` = `mod/agent-harness_0.1.0/`):
- **规模**: 模组 304 个文件, `runtime.lua` 单个文件 2.2 万行 (接近 Lua 200 个局部变量的上限); 约 230 个动作, 其中约四分之一是直播和社交 (看板、投票…); 测试 475 个 Lua 文件 (手写假引擎 + `lua` 解释器跑) + 94 个 TypeScript; 真游戏只有冒烟测试。
- **比上游多的、值得要的**: ① `bots.lua` (717 行): 服务器上用脚本直接造角色, **不需要客户端**, 规则和玩家角色一样 (真实走路 / 采矿 / 手搓时间、够得着、只用背包里的) —— 补上"无界面服务器造不出玩家"这块; ② `clock.lua` (89 行) 回合模式: 没有角色动作时暂停游戏, 发动作就恢复 (`advance` 原地空跑); ③ 高层动作: `feed` 按配方给附近机器喂料、`pole_route` 按电线距离排杆子并报缺几根、`construct` 按虚影亲手建 (顺带清树)、`wait_until` 30 多种条件; ④ **失败原因写得很具体** (`mod/tests/runtime_test.lua`): "被 tree-02 (2.1,0.3) 挡住, 角色站在占地上 (先走开), 要先砍树 (mine 或 place_ghosts…)"、"被水挡住 (要填海料)"; 够不着时报离边缘几格、给一个够得着的站位; 拼错的参数名自动纠正; ⑤ 回复最后一行固定 `error:` / `warning:`, 超过 10KB 分页。
- **生存规则的做法**: 够得着用引擎的 `can_reach_entity` (建筑 10 格, 矿和树 2.7 格); 建造走 `build_from_cursor`; 手搓用引擎 `begin_crafting`; 采矿按 `mining_time×60/采矿速度` 算 tick 到点才 `mine_entity`; 只放行可见区块和雾区里的自家建筑 / 敌巢; 违规回 `{ok:false, error:{code:'action_failed'}}` 并停掉这个角色正在做的动作。
- **2.1 断点 (对照本机 2.1.24 更新日志核实)**: 2.1 删了 `LuaEntity::neighbours` (改成 `underground_belt_neighbour` 等)、`LuaEntity::fluidbox` (流体直接走 LuaEntity)、`LuaRecipe(Prototype)::category` (改成 `categories`)、`circuit_exclusive_mode_of_operation`。分支版和**上游都直接调用了这些** (上游约 15 处: `runtime.lua` 297 / 1305 / 1371 / 1427 / 1532 / 1806 / 1810、`pipes.lua`、`rates.lua`、`survey.lua`), 范围里有一条地下带, 整次 observe 就会失败。`info.json` 写 `factorio_version "2.0"`, 2.1 加不加载要实测。
- **平台**: 模组 Lua、RCON、`format.ts`、`view.ts` 和平台无关; Linux 依赖都在宿主端 (会话启动器、客户端桥、Xvfb)。

## 3. 派对的组织方式 (`agent/`、`tools/`、`docs/`、`site/`)
- **给模型的指令**: 核心简报 `AGENTS.md` 限 20KB (超了测试失败): 目标 ("到雷神星, 里程碑自己定")、节奏 ("你思考时角色站着, 时钟不停")、规则 (只准用 `./fh`, 不准控制台 / Lua / RCON / 改模组)、记忆、停止条件、团队; 约 120KB 参考按需 `./fh help 主题`。**只给事实不给打法** (没有配方建议、布局、里程碑清单; 禁止导入网上蓝图; 可以上网查事实) —— 是为了公平表演。
- **怎么跑**: 每个 Claude 是一个**交互式** Claude Code 会话 (不是 `-p`), 在终端复用器的窗格里: `--effort low --permission-mode dontAsk`、只开 Bash/Read/Edit/Write/Grep/Glob、关斜杠命令和 MCP; 启动时清掉 API 密钥, 用各自登录目录 → **用订阅** ("没有美元数字"); 开班前按实测消耗推 5 小时窗口和周窗口, 不够不开班。班次 4 小时, 一条命令换班 (暂停 → 存档 → 读档 → 部署 → 9 个代理 25 秒起来)。
- **上下文和记忆**: 每个模型单独设压缩点 (Opus 25 万、Sonnet 20 万、Haiku 14 万); 快到时钩子提醒先更新笔记, 压缩后注入 ≤3KB 恢复简报; `notes.md` 固定 7 节 (现在、认领和坐标、约定、看板、里程碑、教训、日志), 换班时脚本从**请求日志算出"上班实测"**放顶部 ("惯例比理由活得久, 因为没人测量")。
- **防跑飞**: 窗格空闲就自动敲"离截止还有 N 分钟, 继续"; 角色站着超过 10 分钟发一条纯事实私信; sleep 截到 60 秒。
- **用量**: token 从各工具本地会话日志算 (Claude 读 `projects/*.jsonl` 的 usage, 按消息 id 去重)。**token 跟回合数走, 不跟回复大小走** (拆小简报没降总量); 子代理很费 (一个模型 1.53 亿输入里子代理占 1.04 亿)。
- **失败和改法**: 角色死 161 次 (走进虫巢 / 虫子射程、自己关掉避让、被自家火车撞) → 在工具层补 (走路避巢避虫、看见敌群停下找炮塔、过铁轨等车), 不写进提示词; 平台丢 15 个 (炮少弹少、减速晚; 读数里看不到平台血量和弹药) → 加告警和读数; Claude 越跑越爱睡 (Opus 睡眠占比 14% → 96%), Sonnet 把输出丢进 /dev/null 漏消息; 探针把服务器卡 15 秒 → 定"单条命令 < 20ms"。
- **运营**: 一个长跑的 Claude Code "操作员"换班、写简报、合并、部署, 原则"不替代理做规划, 只修工具"; 需求来自代理提的 911 条请求和"摩擦扫描" (失败和重做按损失时间排序, 先修前三); 工程师各一个 worktree, 合并前跑全部测试。
- **看板**: 每 3 秒只读查一次, 10 秒推一份 JSON; 地图图层 (建筑、虫巢、炮塔射程和状态、战斗); 每个 AI 一页 (动作数、死亡、行动时间占比、失败率、手搬 / 机器搬占比、token 和缓存率); 时间线 (研究、火箭、平台建成 / 被毁、到达星球、死亡)。**没读到的显示"未读", 不显示成 0**。

## 4. 对我们
1. **方向被证实**: 大模型 + 好 harness 能玩到太空时代后期; 他们的路 = 我们沙盘那条路。我们的差异 (联机身体、知识核实、老玩家思路库、单个 Claude 省 token) 保留。
2. **搬上游当底子, 不搬分支版**: 上游 7100 行、约 48 个动作、结构干净; 分支版是 2.2 万行单体、四分之一是直播社交。从分支版只挑 `bots.lua`、`clock.lua`、失败原因的写法、`feed` / `pole_route` / `wait_until` 等少数几块。MIT, 保留署名 (NOTICE)。
3. **先修 2.1 断点, 每个要用的动作在真 2.1.24 引擎里测** (沙盘回归, 不用它们的假引擎)。
4. **高层动作和架构 2b 对得上**: 带子 / 管道 / 电线杆路线是"给定两端只有一个对的答案"的机械计算 (= 给真相), 可以默认给; 喂料、常驻补给这类带策略的, 作为候选。
5. **安全问题在工具层补** (避巢、遇敌退回、告警读数), 不靠提示词; 回复格式 (结果在前、最后一行 error/warning、给最接近的合法名称、自动纠正参数) 直接学。
6. **用量**: 回合数决定 token → 游戏内队列、事件唤醒、确定性步骤都是在减回合; 记账从会话日志算。
7. **客户端桥** = io-client 的"直接发玩家动作", 他们在 2.0.77 Linux 上核实可行 (不掉同步、人一动就让出); 我们 Windows 2.1.24 + factorio-mcp 注入, 做法照搬思路, M4 再做。
8. 不学: 九个模型并发 + 子代理 (烧 token); 往终端窗格敲字当监工 (脆; 我们用会话接口); 单体巨型文件。
