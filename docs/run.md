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

## 还没搬 (旧项目有; 顺序见 docs/brains.md)
真人的话没回就催 (旧 replies.ts)、换班不关游戏、看门狗、死亡计数、多角色 (team.md、按负责人发)、群和界面 (含账号页的中转站"核实全部模型"队列, 旧 relay-verify.ts VerifyJob)。

## 证据
`test/sandbox/run.test.ts` 5/5 (2026-11-07, 38 秒, 开一个游戏窗口): 干净的沙盘服务器 (mod-list 里只有 base / space-age 那几个) + 独立版客户端不带模组 20 秒进世界 → 注入 → 游戏外的模组起来 (`where.json`: RunCheck 在 nauvis, 有身体) → 开班扫描写出 world-scan.md / .json → 角色目录的 `./fh` (sh 版) 读背包、status、`build wooden-chest` 真放下 (背包 4 → 3) 并记 journal → `fh.ps1` 的 JSON 参数 `{"radius": 8}` 不拆坏 → 放 STOP 收工 `end.json why=STOP`, 服务器日志 `[JOIN] RunCheck` 且没有 desync, 游戏进程全关。第一次 0/5 的原因: 客户端带着沙盘模组连干净服务器被拒 (客户端日志只有 Connection refused), 改成按"连别人的服务器"的方式连 (不带任何模组)。

沙盘这条路一条控制台命令都不发 (2026-11-08 起; 之前开班用 RCON 发过一条退出开场动画 + 给料的命令, 用户看到成就页"因为使用了控制台指令"后改掉): 坠机过场按游戏提示的"确认消息"键跳过 (没跳也 12.5 秒自己结束), 起始物资就是游戏给的; `defines.json` 要先由沙盘测试 / 演示导出好, 缺了报错不经控制台读。`console_command_used` 读的是 false (沙盘测试核)。
