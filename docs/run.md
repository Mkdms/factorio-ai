# 开班主循环 (core/run)

一个 AI = 一个干净的真客户端 (独立版, 不装模组) + 游戏外的模组 (`game/offgame`) + 玩家操作 (`commands/`) + 大脑。沙盘和联机走同一条路: 沙盘里是本机起的"干净的服务器" (`SandboxServer({ clean: true })`, 一个我们的模组都不装, 当联机服务器的替身), 联机就是别人的服务器。

```
npm run run:online -- --lab [--save 存档.zip] --minutes 5       沙盘: 开一张新图 (或存档), 不叫模型, 等到点 / STOP; 这段时间可以在角色目录里跑 ./fh
npm run run:online -- --server --read-only --minutes 5          连 data/accounts/keys.json 的 server, 只读 (上真服要用户在场)
```
选项: `--name 角色名` (= 模型名规范写法), `--steam-pid 进程号` (挂到用户的 Steam 客户端; 用户自己在玩时不许用), `--own-world`, `--backend auto|memory|rcon`, `--reveal`, `--lua`, `--goal-file`, `--run-id`。大脑: `--brain none|claude --model 模型 --effort low|medium|high --compact-at token数` (别家第二块第 ③ 步搬; docs/brains.md)。

## 一班的流程
1. 客户端: 开独立版连服务器 (沙盘 / 别人的), 看客户端日志等它进世界 (`online-lib.ts clientPhase`; 连不上报原因, 密码错和模组不一样客户端日志都只有 "refused"); 联机 `--backend auto` 时先用干净客户端试进, 进得去 = 服务器没装模组 → 走外挂, 一条 Lua 都不跑。
2. 注入客户端 (`game/client`, 只读默认不注入), 读玩家、退出远程视图, 读 `game.console_command_used`。
3. 起代理 (`commands/broker.ts`) 和游戏外的模组宿主 (账本 `ledger.lua` 在记录目录); 读 `where` 写 `where.json`。
4. 角色目录 (`workspace.ts`): 简报 AGENTS.md / CLAUDE.md、notes.md、ref/、deadline.txt、`./fh` 和 `fh.ps1` (都经管道; 脚本里只有管道名, 没有 RCON 密码)。
5. 开班扫描 (`scan.ts`): 现状写 world-scan.md (判断 / 规划等计算器那块接上再有)。
6. 大脑 (`--brain claude`): 角色目录写 `.claude/settings.json` (压缩点 + 钩子) 和 `.context-hooks`; 一轮一个 Claude Code 进程, 第 1 轮开场提示词 (先读简报、笔记、world-scan.md, 再看 status / observe, 然后动手), 之后"继续"; 会话号接力 (`--resume`); 一轮很快结束就等满 30 秒再叫; 到点 / STOP / DONE / 客户端关了 / 掉线就连子进程一起杀。`--brain none`: 只等到点 / STOP。收工写 `end.json`、`probe-stats.json`, 联机时抹掉客户端日志里的地址和密码。

记录在 `data/play/online/<runId>/`, 角色目录在 `BRAIN_DIR` (默认 `~/factorio-ai-brain`) 下 (必须在仓库外: 模型会往上读到开发规则)。

## 代码
| 文件 | 做什么 |
|---|---|
| `online.ts` | 主循环 (上面的流程) |
| `online-lib.ts` | 服务器地址 (keys.json 的 server)、客户端日志 → 阶段、抹地址密码、简报里联机这一节 |
| `workspace.ts` | 角色目录和 `./fh` 包装 (sh + ps1, `ps1-wrap.ts` 把参数写成文件交给 `commands/fh.ts`) |
| `scan.ts` | 开班扫描 (SCAN_LUA 跑在游戏外的假接口上) |
| `shell.ts` | 找 Git for Windows 的 bash (PATH 上的 bash 可能是 WSL 的) |

## 还没搬 (旧项目有; 顺序见 docs/brains.md)
别家大脑 (Agent SDK / Codex / Grok / 中转站 / DeepSeek)、监工和体检、真人聊天进模型回复、教训自动带出、`./know` `./calc` `./bp`、换班不关游戏、看门狗、群和界面。

## 证据
`test/sandbox/run.test.ts` 5/5 (2026-11-07, 38 秒, 开一个游戏窗口): 干净的沙盘服务器 (mod-list 里只有 base / space-age 那几个) + 独立版客户端不带模组 20 秒进世界 → 注入 → 游戏外的模组起来 (`where.json`: RunCheck 在 nauvis, 有身体) → 开班扫描写出 world-scan.md / .json → 角色目录的 `./fh` (sh 版) 读背包、status、`build wooden-chest` 真放下 (背包 4 → 3) 并记 journal → `fh.ps1` 的 JSON 参数 `{"radius": 8}` 不拆坏 → 放 STOP 收工 `end.json why=STOP`, 服务器日志 `[JOIN] RunCheck` 且没有 desync, 游戏进程全关。第一次 0/5 的原因: 客户端带着沙盘模组连干净服务器被拒 (客户端日志只有 Connection refused), 改成按"连别人的服务器"的方式连 (不带任何模组)。

沙盘这一班 `game.console_command_used` 是 true: 进世界后用 RCON 发了一条退出开场动画 + 给起始物资的命令 (沙盘不在乎成就); 联机不发。
