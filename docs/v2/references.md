# 参考项目 (2026-10-31 在 GitHub 按星数检索)

星数和更新日期是检索当天的数。复用任何代码之前, 先逐个确认它的许可证。

## 和"AI 玩 Factorio"直接相关
| 项目 | 星 | 是什么 | 对我们的用处 |
|---|---|---|---|
| [JackHopkins/factorio-learning-environment](https://github.com/JackHopkins/factorio-learning-environment) | 1209 | 评测大模型玩 Factorio 的环境 (FLE): 模型写代码调用工具建工厂, 按产量打分; MIT; 只支持 2.0 基础版, 不支持太空时代 | 已研究, 见 [research/fle.md](research/fle.md): 学它的评测判分、工具手册、沙盘工程教训 |
| [nwinter/factorio-ai-party](https://github.com/nwinter/factorio-ai-party) | 3 | 九个 AI 模型一起玩同一个太空时代世界, 直播; MIT。**2026-11-02 补查**: 模型跑在各家的编程助手里 (Claude Code 里的 Opus / Sonnet / Haiku、Codex 等), 每个动作发一条 `fh` 命令, 服务器端 Lua 模组按生存规则逐 tick 执行 (只用自己背包里的东西、手够得着、真实走路和手搓时间、只看得到队伍看得到的), 回一段短文字; 动作 186 个、Lua 7.8 万行、测试 323 个 (10-10 起 7 天写成, 也是 AI 写的); 界面是网站 (实时画面、每个 AI 的页面、时间线) + 直播叠加层, 不是桌面程序。10-17 快照: 游戏 105.5 小时、211 项科技、做到钷素科技包（黑瓶）、2365 枚火箭、5 颗星球都去了; 角色死 161 次、平台被小行星打掉至少 15 个; 226 亿 token (97% 读缓存) (出处 factorio.nickwinter.net/how/) | **证明「大模型 + 好的 harness」能玩到太空时代后期**; 它的做法 = 我们沙盘那条路 (服务器端模组 + RCON 高层动作); 动作清单、测试、协作板要细读, 能搬就搬。 → Windows 看板 (实时局势、每个 AI 一页、时间线) 的参考 |
| [CarsonBurke/factorio-harness](https://github.com/CarsonBurke/factorio-harness) | 1 | 上面那个的上游: `fh` 命令行 (TypeScript) + Lua 模组 + RCON; 走路、寻路、挖矿、战斗在 Lua 里逐 tick 跑; 没有界面, 只有示意地图图片 (`fh view`) 和 JSON 流 (`fh stream`); 2.0, 太空时代可选; MIT | 行动层 (M5) 的动作划分参考 |
| [lveillard/factorio-ai-companion](https://github.com/lveillard/factorio-ai-companion) | 14 | 通过 MCP 的 AI 同伴, 51 个 RCON 命令 | RCON 工具集设计, 可供沙盘身体参考 |
| [sbarisic/FactorioMCP](https://github.com/sbarisic/FactorioMCP) | 14 | 让大模型玩游戏的 MCP | MCP 工具设计 |
| [alecraso/factorio-mcp-server](https://github.com/alecraso/factorio-mcp-server) | 3 | 提供准确、最新游戏数据的 MCP (配方等) | knowledge MCP 的参考 |
| [xdDenden/FactorioGNN](https://github.com/xdDenden/FactorioGNN) | 9 | 用图神经网络挑战 FLE 上的大模型 | 非大模型路线的思路 |
| [lvshrd/factorio-agent](https://github.com/lvshrd/factorio-agent) | 17 | 自主分析游戏状态的 AI 智能体 | 智能体结构 |
| factorio-mcp | 4 | 注入游戏客户端、模拟键鼠的 MCP | io-client 的参考起点 (不默认最优) |

观察: 这些项目大多通过 RCON 或模组在服务器端直接改游戏 (上帝模式), 适合我们的沙盘身体; 像真人一样在别人的服务器上操作的很少, 这正是 io-client 要解决的。

## 通用 harness (模型外面那一圈: 循环、工具调用、上下文、子代理)
许可证来自二手对比文章, 用之前到仓库核对 LICENSE。
| 项目 | 许可证 | 备注 |
|---|---|---|
| Claude Agent SDK (Claude Code 的库版本) | Python 版 MIT (二手); TypeScript 版按 Anthropic 条款, 待核对 | 架构里总控 / 专家原计划用它; factorio-ai-party 里 Claude 就跑在 Claude Code 里 |
| OpenCode | MIT | 可换模型 |
| OpenAI Codex CLI | Apache 2.0 | Rust, 默认沙箱 |
| OpenHands | MIT | 自主程度高 |
| Goose | Apache 2.0 | |
| Aider、Cline | Apache 2.0 | |
| 游戏类: Voyager / Mindcraft (Minecraft)、lmgame GamingAgent、DeepMind Game Arena、Palisade ctfish (国际象棋, 记忆 / 计划 / 子目标槽位) | 多数待查 | 思路参考: 技能库、自动课程、长跑时的记忆槽位 |
结论: 模型那一层用现成的 (factorio-ai-party 也是), 我们只做游戏那一层 (动作、读局势、规则、测试)。

## 计算、布局、蓝图、数据
| 项目 | 星 | 是什么 | 对我们的用处 |
|---|---|---|---|
| [factoriolab/factoriolab](https://github.com/factoriolab/factoriolab) | 881 | 产量计算器, 支持太空时代 | calc MCP 的数据模型和算法参考 |
| [R-O-C-K-E-T/Factorio-SAT](https://github.com/R-O-C-K-E-T/Factorio-SAT) | 784 | 用 SAT 求解器生成传送带平衡器和布局 | layout MCP 的布局求解思路 |
| [KirkMcDonald/kirkmcdonald.github.io](https://github.com/KirkMcDonald/kirkmcdonald.github.io) | 754 | 网页产量计算器 | calc 参考 |
| [wube/factorio-data](https://github.com/wube/factorio-data) | 663 | 官方仓库, 记录每个版本原型定义的变化 | knowledge MCP 的版本对比 (哪个版本改了哪些配方和建筑) |
| [redruin1/factorio-draftsman](https://github.com/redruin1/factorio-draftsman) | 185 | 完整、测试充分的蓝图读写库 | layout MCP 的蓝图编解码和校验 |
| [teoxoy/factorio-blueprint-editor](https://github.com/teoxoy/factorio-blueprint-editor) | 428 | 网页蓝图编辑器 (已停止维护) | 蓝图可视化 |
| [FactoryGameFan/factorio-blueprint-editor](https://github.com/FactoryGameFan/factorio-blueprint-editor) | 23 | 网页蓝图编辑器, **支持 2.0 和太空时代, 活跃维护** (2026-11-01 还在更新; MIT; 和 teoxoy 的是两个项目), 在线版 fbe.factorygamefan.com | 给用户看 / 改我们生成的 2.x 设计; teoxoy 那个星多但已停更 |
| [piebro/factorio-blueprint-visualizer](https://github.com/piebro/factorio-blueprint-visualizer) | 587 | 把蓝图画成图片 (Python, MIT) | 给用户看设计、给模型看布局 (图片要守输出上限) |
| [bcwhite-code/brians-blueprints](https://github.com/bcwhite-code/brians-blueprints) | 152 | Brian's Blueprints, **CC0** (公共领域); 2.0 的 212 张 (火车、自建工厂、开局、反应堆) + 1.1 的 | 蓝图数据集第一批社区数据 (docs/blueprint-dataset.md); 自带 fatul 编解码 (拆出的 JSON 是相对坐标、没有实体编号, 要用 fatul 编回标准字符串) |
| [ShadowTheAge/yafc](https://github.com/ShadowTheAge/yafc) / [DanielKote/Foreman2](https://github.com/DanielKote/Foreman2) | 202 / 343 | 产线规划和分析工具 | 规划思路 |
| [clusterio/clusterio](https://github.com/clusterio/clusterio) | 383 | 多服务器互联, 大量 RCON 插件 | 沙盘多开和 RCON 管理 |
| [FactorioBlueprints/factorio-prints](https://github.com/FactorioBlueprints/factorio-prints) | 214 | factorioprints.com 蓝图站 | 社区布局参考 (只作参考, 不照抄) |
