# Factorio AI

让 AI 模型像玩家一样玩 Factorio 2.x + 太空时代: 程序负责开游戏、把模型接进去、把工具和训练集递给它, 桌面界面里看和管。

第二次重构 (2026-11-07 起), 从空目录开始, 旧项目只当参考逐块搬, 每块搬完能跑才搬下一块。

## 原则
- 和游戏打交道的代码全部自己写, 用自己的名字和结构; 不下载别的游戏相关项目来调用。通用库 (React、Tauri、测试框架) 照常安装。蓝图编辑器例外, 用现成的。
- 文档、注释、提交说明只写规则和事实: 不写人名、不写用户原话; 别的项目只写项目名。
- 本机数据 (密钥、班次记录、存档) 在 `data\`, 不上传; 模型的工作目录放在仓库外。
- 训练集是独立的一块 (`training\`), 有规范, 界面里可以换成别的训练集目录。
- 说"完成"要有证据: 测试 + 游戏里的读数。

## 目录
```
app\        桌面界面 (Tauri + React): 群 / 对话 / 账号 / 选训练集目录
core\       程序本体: run (开班、监工) brains (接模型) control (界面接口) records (记录、复盘、统计)
game\       和游戏打交道: mod (沙盘模组; 测试用的 harness 模组) client (注入客户端: 键鼠、只读查询、界面) memory (进程外读内存) offgame (harness 的 Lua 在游戏外跑) sandbox (本机服务器、窗口、导数据)
commands\   给模型用的命令: fh 命令行 (cli/) → 代理 (broker) → 读走游戏外的模组宿主, 动作翻译成玩家操作 (actions / body / walk / gui)
training\   训练集 (规范见 training\README.md)
docs\       开发文档
test\       测试
data\       本机数据, 不上传
```

## 模型手里有什么、请求怎么走 (默认路线: 不装模组, 沙盘和联机一样)
```
模型 (Claude Code / Codex / …; 角色目录在仓库外, 钩子只放行白名单命令)
 ├ 读: 简报 AGENTS.md / CLAUDE.md、notes.md (上一班实测 + 复盘)、ref/ 手册和思路、world-scan.md (开班扫描 + 要点)
 ├ ./fh call 读命令 ───────→ 代理 (commands/broker) → 游戏外的模组宿主 (harness Lua 跑在假接口上, 数据: 读内存 game/memory + 注入客户端补)
 ├ ./fh call 动作 ─────────→ 代理 → 行动层 (commands/actions → body / walk / gui) → 注入客户端 (键鼠时间线、直接发玩家动作、界面) → 游戏
 ├ ./fh call mcp / belt_lanes → 代理 → 注入客户端的只读工具 (world_query / world_overview / ui_read …, 上游 factorio-mcp; 只读, 不发给服务器)
 ├ ./calc ./plan ./bp ────→ 计算器、规划、蓝图库 (data/training-private/blueprints) → 经管道调 ./fh 的动作一件件放
 └ ./know ───────────────→ 训练集检索 (思路 / 核实的事实 / 教训 / 资料)
递到手上的 (不等模型想起来): 放机器时附配比和现成的块、报错附查法、做某个动作时带出对应教训、开班扫描附要点。
程序这边: 监工 (闲了催、体检、产量播报、英文提醒)、接力换班 (存档 + 笔记 + 上一班实测 + 复盘)、记录 / 统计、界面 (app/)。
```
另一条路 (装模组 + RCON, `src/play/run.ts`) 是后期不要成就时的全性能备用路: harness 模组装在游戏里, 没有注入客户端, 也就没有 `./fh call mcp`。

## 怎么跑
```
npm test                 # 单元测试 (不开游戏)
npm run test:sandbox     # 沙盘集成测试 (起本机服务器, 约 2 分钟)
npm run sandbox:demo     # 沙盘演示
```
`.env` 照 `.env.example` 填 `FACTORIO_DIR`。

搬的顺序: 沙盘里模型能开一班 (进行中: 沙盘 ✅, 读内存 ✅, 游戏外跑模组 Lua ✅, 注入客户端 ✅, 命令 / 动作 / 开班 ⬜) → 训练集 → 界面 → 联机。各块文档在 `docs/`。

模型的手脚只走"不装模组"的路 (读内存 + 注入客户端发玩家操作), 沙盘和联机一样; 沙盘模组只在测试里读真值。要用读内存先 `npm run memory:setup` (编 pdb-dump, 要 Visual Studio C++)。
