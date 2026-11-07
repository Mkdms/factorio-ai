# 注入客户端的程序 (game/client)

注入一个正在跑的游戏客户端 (Windows 版), 经 MCP 协议给我们的程序这些工具: `world_query` 只读查询 (在安全点里读, 不发给服务器)、`input` 键鼠时间线、`player_action` 直接发玩家动作 (取放、开关窗口…, 构造游戏自己的 InputAction)、`ui_read` / `ui_action` 界面、`chat_read` / `chat_send`、`memory_read` 读内存 (宿主进程读, 不进游戏)、`screenshot`。服务器只看到普通玩家; 不装模组、不碰 RCON, 不影响成就 (本机新图实测拿到过)。这是模型"不装模组"那条路的手; 眼睛是 `game/memory` (大批量读) 加这里的只读查询 (流体、线路、物流网这类内存读不到的)。

搬自 factorio-mcp (Windows + 通用部分, 见 NOTICE; 上游的设计理由在 `game/client/AGENTS.md`, 工具契约在 `game/client/tools.md`, 构建在 `game/client/development.md`, 名字已换)。**它的取舍多半有意**: 改之前先看 AGENTS.md 里的理由。

## 怎么用
```
npm run client:setup [-- --debug]      # 生成 game/client/local.properties (MSVC / Windows SDK / CMake / Ninja 路径, 从本机 VS 找), Gradle 编 Windows 版, 拷到 data/client/
npm run test:sandbox                   # 含 test/sandbox/client.test.ts: 开一个游戏窗口, 挂上, 查询 / 读内存 / 聊天对 RCON 真值, 摘下来
```
要: JDK (Gradle wrapper 能用的版本, 本机 25)、Visual Studio 的 C++ 桌面开发组件 + Windows SDK + "适用于 Windows 的 C++ CMake 工具"; Kotlin/Native、LLVM、Gradle 发行包第一次由 wrapper 下载 (本机走 `~/.gradle/gradle.properties` 里的代理)。编出来的 `factorio-ai-client.exe` + `factorio_ai_bridge.dll` 要放在一起。

TypeScript 里用 `game/client/connect.ts` 的 `GameClient`: `start()` 起程序 (只开 HTTP), `call("attach", {pid})` 挂上, `call(工具, 参数)` 调用 (只读工具断线后重连重试一次, 动作类绝不重放), `stop()` 摘下来并关程序。

## 代码
| 目录 / 文件 | 做什么 |
|---|---|
| `src/commonMain` | 通用 Kotlin: MCP 服务、工具契约、查询 / 输入 / 界面的数据模型 |
| `src/mingwX64Main/kotlin` | Windows 宿主: 注入 (CreateRemoteThread)、共享内存通信、调试符号 (DbgHelp 读 factorio.pdb 现场取布局, 不存偏移表)、读内存 (`memory_read`) |
| `src/mingwX64Main/native` | 注入进游戏的 C++ 桥 (`factorio_ai_bridge.dll`): 安全点钩子、只读 Lua 查询、键鼠、界面读写、聊天、直接发玩家动作、截图 |
| `src/nativeMain` | 两边共用的原生代码 (输入时间线) |
| `src/*Test` | 上游的单元 / 验收测试 (验收测试要真游戏, 默认不跑) |
| `connect.ts` | 我们这边的连接 (MCP TypeScript 库) |
| `setup.ts` | 生成 local.properties、编、装 |

## 规矩 (上游的, 测试守着)
- 工具不设超时, 只许测试用的看门狗; 动作只报"已发出", 效果要读回来核对。
- 只读查询只开放被动查询: 任意 Lua、会改状态的方法 (`can_insert` 这类探测也会改状态) 不收。
- 注入过一条选中 (`SelectedEntityChanged`) 之后客户端自己的鼠标选中会失灵: 选中用真鼠标悬停, 不注入。
- `player_action` 的格子要带那格当时的物品 ID + 品质 ID (`memory_read` 的 ID 表), 无效 ID 会把客户端弄掉线, 绝不猜。
- 存档时注入的 Lua 读可能弄崩游戏: 存档前松开按键并停通信 (下一块接)。

## 证据 (游戏 2.1.24, 2026-11-07, 沙盘新图)
`test/sandbox/client.test.ts` 5/5: 起程序 + 挂上观看窗口 (status attached / in_game); 暂停着 `world_query` 玩家周围 16 格 23 个实体名字 + 位置 = RCON 真值, 玩家位置 = 角色位置; `memory_read` 位置和主背包 = 真值 (读 2 次稳定, 45 毫秒), 物品 ID 342 条; `chat_send` 的话 `chat_read` 读回来, 游戏照常走; `detach` 后窗口还连着, 程序日志没报错。旧项目在同一套代码上核过的更多: 键鼠时间线放建筑 / 取放、直接发玩家动作 (取放 1 秒级)、界面、只读查询 9 项、联机服务器上只读进世界 5 分钟不掉线 (搬动作层时在新项目重核)。
编译: 本机 VS 18 (MSVC 14.51, SDK 10.0.28000) + JDK 25 + Kotlin/Native 2.4.10, 第一次约 1 分 16 秒 (工具链已缓存)。踩过的坑 (setup.ts 都自动处理了): Gradle 起 cmake 用的是它自己的 PATH; CMake 探测 lib.exe 要 MSVC 的 bin 在编译子进程 PATH 上, 而且探测结果记在缓存里, 路径变了要删 build/native 重来。
