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
- 统计 getter (`get_item_production_statistics` 这类) 和 `LuaFlowStatistics` 的计数在统计为空时会创建同步状态 (上游 0.0.11 查出, 已从只读查询里去掉): 联机客户端里一条都不跑, 统计从内存读。
- 存档时注入的 Lua 读可能弄崩游戏: 存档前松开按键并停通信 (下一块接)。

## 升到上游 0.0.11 (提交 bc9ff88, 2026-11-09)
原来这份 = 上游 5489375 (0.0.10, 2026-11-02) + fork 的 6 个提交 (player_action、memory_read、两种 world_query 读法)。上游之后只有 bc9ff88 一个提交: 约 170 个文件, tools.md 从 1300 行到 1770 行。
**怎么合的**: 在 fork 历史上把 pilot 和上游合并 (12 个文件 20 处冲突, 都是 fork 碰过的地方), 再按我们的命名导出, 三方合并进 game/client (底 = fork pilot 导出、我们 = game/client、他们 = 合并结果导出; 导出的 fork pilot 和原来的 game/client 258 个文件一字不差, 只有 5 个文档 / 构建文件有我们加的头注)。合并后的 fork 历史打成包留在本机仓库外的历史包目录 (`factorio-mcp-2026-11-09-merged-0.0.11.bundle`, 分支 merge)。fork 的东西怎么留的:
- `player_action` 从操作号 13 改成 **14**: 上游把 13 拿去做"预留请求缓冲区", 不改的话发玩家动作会进错分支 (C++ 桥 resident.cpp、宿主 ResidentConnection.kt / Platform.kt 三处)。调试符号表里 fork 的 3 个类型信息符号排在上游新加的 `BadFunctionCall` 后面 (FmSymbol 枚举和 symbolPrefixes 按位置一一对应)。
- `get_wire_connector(s)` 只放行最后一个参数是 `false` 的读法: 加进上游的被动方法表, 检查挪到上游新的路径校验 (`ObservationRead.kt inspectionPath`); 单元测试 `ObjectInspectionTest.wireConnectorReadsRequireOrCreateFalse`。
- 阵营字段 `enemy_evolution` 去掉: 上游放行了 `LuaForce.get_evolution_factor`, 我们改用 inspect 读 (`commands/client-target.ts evolution`)。
**接口变了, 我们这边跟着改的**:
- `world_query` 的参数要包在 `query` 对象里 → `connect.ts toolArgs` 统一包 (commands/ 和假接口经代理转来的 Lua 读都走这里, 已经带 query 的原样发)。
- inspect 默认 values 模式不收 `limit` / `offset` → 去掉 10 处 (actions / body / online); 要表的条目和总数写 `mode: "entries"` (读物流请求的分组数 `query.ts readRequests`)。
- values 模式碰到表不再自动给条目, 给的是预览 (数字键过 JSON 变字符串键, 红绿线 `get_wire_connectors` 按编号取会落空) → 假接口问方法时同一次调用加一条相对读 `reads: [{mode: "entries"}]`, 是表就用带原始键的条目 (`game/offgame/fake_game.lua lua_inspect / lua_result`)。
- 区域查询"条数够不够"看 `selection_complete` (`truncated` 还包括嵌套值按深度省略) → `query.ts areaCut`, readArea / readEntities / walk.ts 用它。
- `ui_read` 没有 `max_nodes` 了 (按相对深度 `max_depth` 截), 未知参数一律拒 → 去掉 3 处; 带选择器时只回匹配到的子树 (匹配的根 `matched = true`, 我们都按类型或 matched 过滤, 不受影响)。
- 没变的 (核过源码): 背包 / 科技目录分页 (`truncated` + `next_offset`)、背包格子的 `valid_for_read` / `index`、`include: ["recipe"]`、`world_overview` 的 `viewport`、input 时间线写法 (`stop_previous` 默认 false 时有时间线在跑会拒, 我们的动作都等上一条做完)。
**证据 (2026-11-09, 游戏 2.1.24, 沙盘)**: 编译 1 分 47 秒; 客户端 Gradle 单元测试 263 条 + 新加 1 条全过 (含上游新加的 UiTree / WorldQuerySchema / CollectionPaging 和 fork 的 PlayerAction / MemoryRead); `test/sandbox/client.test.ts` 5/5 (挂上、只读查询对真值、读内存、聊天、摘下); `test/sandbox/actions.test.ts` 51/51 (8.6 分钟: transfer 取放走 player_action 14 号、红绿线只读接线点 + entries 相对读、物流网、流体、第二个客户端、服务器没有不同步); `test/sandbox/run.test.ts` 7/7 (开班链路; 第一次 6/7 是 11-08 加的"那格地块"让查法多了地块名, 和升级无关, `commands/hints.ts errorHint` 修了)。旧程序留在 `data/client-0.0.10/`。
上游 0.0.11 新增 / 改动的能力, 逐项对我们的代码 (2026-11-09 按 tools.md 新旧逐句对比 + 被动方法表新旧对比, 再 grep 我们的调用; 假接口里用内存实现的同名 Lua 函数不算"经注入客户端用了")。共 26 项: 用上 1 项、适配了没利用 2 项、没用 23 项。"价值"按模型玩得更好排: 高 = 现在的阶段就用得上。
**同日接上以后**: 模型经 `./fh call mcp` (只读直通, docs/commands.md) 能直接用全部只读的: 第 1~3、6~10、12~14、16~26 项; 行动层接了第 4 项 (belt_route 直线段拖着放); 第 3 项另做成 `./fh call belt_lanes`。还没接: 第 1 项给假接口自己用 (流体 / 红绿线 / 物流点现在一个实体问一次, 改按区域一次读)、第 5 项 (贴蓝图这条路上没有调用方)、第 4 项的 pole_route / pipe_route 拖动。下表"我们用了吗"一列是接之前的样子。

| # | 能力 | 我们用了吗 | 价值 / 用在哪 |
|---|---|---|---|
| 1 | 批量相对读 `query.reads`: 对选中的每个实体 / 玩家 / 背包格 / 目录项跟一串相对路径, 同一个安全点, 一条错不影响其余 (例: 一个区域一万台机器的配方 + 输出箱 + 插件一次读完) | 没用 (只在假接口里拿它兜底表的条目) | 高: 假接口补内存读不到的 (流体、红绿线、物流点) 现在一个实体一次往返 (约 30 毫秒, 20 处), 改成按区域一次读; 配方 / 箱子内容这些内存已经读得到, 不靠它 |
| 2 | 原生实体过滤 `selection.filters` (EntitySearchFilters: 虚影名、待拆除、品质、装着某物品、势力…) | 没用 | 低: 不装模组那条路找实体走读内存 (假接口自己实现 find_entities_filtered), 经注入客户端的实体查询只有寻路读障碍、开枪找敌人几处, 用不上 |
| 3 | 传送带每条道上每个物品的位置 (`get_detailed_contents` / `get_item_position` / `get_line_item_position`) | 没用 | 高: 模型要过"一条命令看某条带子某道上有什么", 查堵带 / 混带 |
| 4 | 一条输入时间线做组合键、按住拖多段带拐弯、每格停留 (`per_point_ticks`、`snap: tile_center`) | 适配了没利用 (Timeline 有拖动写法, 行动层没调; 铺带一格一格放) | 高: belt_route / pole_route 一次拖完一段 |
| 5 | `set_text` 上限 1024 → 16384 字 | 没用 (还按 1024 切, 超了走剪贴板) | 现在为零: 不装模组那条路的贴蓝图 (`importBlueprint` / `importModes`) 没有调用方 (./bp build 没接进这条路); 接上时把门槛改到 16384, 基本不碰用户的剪贴板 |
| 6 | 按品质的原型数值 (机器 `get_crafting_speed` / `get_max_energy_usage` / `get_inventory_size` / `get_mining_drill_radius` / `get_researching_speed` / `get_supply_area_distance`; 物品 `get_spoil_ticks` / `get_module_effects` / `get_ammo_type`; 配方 `get_product_amount` / `get_product_quality`) | 没用 (按导出的原型数据算, 没有品质) | 中: 计算器 / 配比用到品质时 |
| 7 | 地表方法 (`get_tile` / `get_hidden_tile` / `count_entities_filtered` / `count_tiles_filtered` / `get_property` 星球属性 / `get_chunks` / `is_chunk_generated` / 按位置找物流网) | 没用 | 中: 数矿、数水、找物流网, 去别的星球读重力 / 气压 |
| 8 | 火车 (`game.train_manager` 的列车 / 车站, 时刻表的记录 / 等待条件 / 中断) | 没用 | 中: 火车那批 (还没接) 先能读 |
| 9 | 蓝图物品的内容 (`get_blueprint_entities` / `get_blueprint_tiles` / 标签) | 没用 | 中: 核对手上 / 箱子里的蓝图是哪张 |
| 10 | 势力的太空 / 品质状态 (`is_space_location_unlocked` / `is_space_platforms_unlocked` / `get_space_platforms` / `is_quality_unlocked` / `get_logistic_groups` / `get_friend` / `get_cease_fire` / `get_entity_count` / `get_spawn_position`) | 没用 | 中 (太空时代): 能去哪颗星、有几个平台 |
| 11 | 进化度 `LuaForce.get_evolution_factor` (按星球) | 用了 (这次合并时改过去的) | — |
| 12 | `inspect members` 加 `search`: 列任何对象能读的属性 / 方法 / 签名 / 说明 | 假接口用 members (旧版就有), search 没用 | 低: 工具开发时自己查能读什么 |
| 13 | 全局根 `prototypes` / `defines`, 任意原型目录 (装备、地块、虚拟信号、太空地点) | 没用 (原型数据走导出) | 低: 游戏更新后不用重导就能读新原型 |
| 14 | 长字符串切片 `slice`、迭代器条目 (`get_chunks`) | 没用 | 低 |
| 15 | 回复不再有 16 MiB 上限 | 区域读已开到 10 万条, 但没配合批量读 | 跟第 1 项一起 |
| 16 | `world_overview` 实体模式带 `fields` / `reads` / `include` / `filters` | 没用 (只拿它取画面范围) | 中: 画面里的机器一次读状态 + 配方 |
| 17 | `world_overview` 网格分页 (`start_cell` / `next_cell`、`cell_limit`) | 没用 | 低: 大地图概况 |
| 18 | 折线图原始序列 (标签 + 每个采样点, 可分页; 例: 星图上点星球之间连线弹出的陨石密度图) | 没用 | 中 (太空时代): 按航线算平台火力。生产统计窗口里的曲线是不是同一种组件待核, 是的话多一条不碰统计 getter 读产量的路 |
| 19 | 成就卡的原生状态 | 没用 | 中: 核 MK 的成就不用看 Steam 缓存 |
| 20 | 星图连线控件带连线原型 (再用原型目录读两端和距离) | 没用 | 中 (太空时代) |
| 21 | 图片控件的静态 sprite; 场景模拟组件 (提示里的小动画) 只回类型不展开帧 | 没用 | 低 |
| 22 | 脚本 GUI 属性 (`gui` / `gui_fields` / `gui_depth`、选择器 `match.gui`) | 没用 | 中 (只在装模组那条路): 读 Factory Planner 这类模组界面 |
| 23 | 单个控件取值 `collection`: 下拉选项分页 (不用打开下拉)、文字 / 提示切片、gui 表 | 没用 | 中: 选配方的下拉、读长提示 |
| 24 | 子树选择器 + 相对深度 `max_depth` + `sibling_index` | 适配了没利用 (还是读整棵树再过滤) | 低: 读界面更快、更省 |
| 25 | 聊天长消息切片 + 水位续读 | 没用 | 低 (聊天一般短) |
| 26 | 键位默认全量 + 按 ID / 子串查 | 没用 (带 limit 1024 读全量) | 低 |

上游同时去掉了 16 个方法, 对我们没影响: 统计类 (`get_item_production_statistics` / `get_flow_count` / `get_input_count` …, 会创建同步状态) 我们从内存读; 流体盒的 `get_capacity` / `get_connections` / `get_pipe_connections` / `get_locked_fluid` / `get_prototype` / `get_fluid_segment_contents` 在 2.1 里本来就读不到 (`LuaEntity.fluidbox` 没了, harness 走 compat21); `get_personal_logistic_slot` / `get_vehicle_logistic_point` 是 1.x 的旧接口。工具说明也改了 (给 agent 看的提示词, 例: 写明 input 能拖动、组合键); 我们的模型经 `./fh` 用行动层, 不直接看这些说明, 照着改的是行动层 (第 4 项)。

## 证据 (游戏 2.1.24, 2026-11-07, 沙盘新图)
`test/sandbox/client.test.ts` 5/5: 起程序 + 挂上观看窗口 (status attached / in_game); 暂停着 `world_query` 玩家周围 16 格 23 个实体名字 + 位置 = RCON 真值, 玩家位置 = 角色位置; `memory_read` 位置和主背包 = 真值 (读 2 次稳定, 45 毫秒), 物品 ID 342 条; `chat_send` 的话 `chat_read` 读回来, 游戏照常走; `detach` 后窗口还连着, 程序日志没报错。旧项目在同一套代码上核过的更多: 键鼠时间线放建筑 / 取放、直接发玩家动作 (取放 1 秒级)、界面、只读查询 9 项、联机服务器上只读进世界 5 分钟不掉线 (搬动作层时在新项目重核)。
编译: 本机 VS 18 (MSVC 14.51, SDK 10.0.28000) + JDK 25 + Kotlin/Native 2.4.10, 第一次约 1 分 16 秒 (工具链已缓存)。踩过的坑 (setup.ts 都自动处理了): Gradle 起 cmake 用的是它自己的 PATH; CMake 探测 lib.exe 要 MSVC 的 bin 在编译子进程 PATH 上, 而且探测结果记在缓存里, 路径变了要删 build/native 重来。
