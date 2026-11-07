# 读内存 (game/memory)

游戏里不跑任何代码, 从游戏外面读一个客户端进程的内存: 只有 `OpenProcess(VM_READ)` + `ReadProcessMemory`, 不注入、不写, 存档时也能读, 不挡游戏帧。这是模型"不装模组"那条路的眼睛 (沙盘和联机都走它); 沙盘模组只在测试里给真值。

## 怎么用
```
npm run memory:setup                                   # 编 data/tools/pdb-dump.exe (要 Visual Studio C++ 桌面开发组件), 一次
python -I game/memory/entities.py --pid <客户端进程号> --exe <它的 factorio.exe> [--details] [--owned 类型列表.json]
python -I game/memory/player.py   --pid ... --names     # 本地玩家位置 + 主背包
python -I game/memory/world.py    --pid ... --surface nauvis
python -I game/memory/reader.py   --pid ...             # 物品 / 品质的数字 ID 表
npm run test:sandbox                                    # 含 test/sandbox/memory.test.ts: 开一个游戏窗口, 读它, 和 RCON 真值逐项比
```
TypeScript 里用 `game/memory/read.ts` (`readEntities` / `readPlayer` / `readWorld` / `readProtoIds`)。`--exe` 给被读进程的 exe (Steam 版和独立版不一样), 布局缓存按 exe 的大小 + 修改时间分开存在 `data/memory/layout-cache.json`, 游戏一更新自动失效 (第一次取布局要加载 461MB 的 pdb, 几分钟; 之后毫秒级)。

## 代码
| 文件 | 做什么 |
|---|---|
| `pdb-dump.cpp` | 命令行工具: 从游戏自带的 `factorio.pdb` 列枚举、结构成员偏移、符号地址 (DbgHelp); `setup.ts` 编它 |
| `reader.py` | 公共层: 打开进程、读字节、取符号 RVA / 成员偏移 (每次现场取, 不存偏移表)、布局缓存、原型 ID 表; 数据目录和 exe 的默认值 (和 `game/sandbox/paths.ts` 同一条规则) |
| `entities.py` | 一个地表的全部实体: `global → game → map → surfaces → 区块表 → Chunk.advancedTiles → EntityConnector 链表 → Entity`; `--details` 按虚表认类读细节 (背包、配方、燃料、能量、带上物品、矿量…) 并推算状态 |
| `status.py` / `status.ts` | 从原始字段推算机器状态 (游戏的 `getStatus` 规则: 每个条件一个候选, 取编号最大的); 两份规则必须一样, `test/memory.test.ts` 拿 3000 多组输入比 |
| `player.py` | 本地玩家: `localPlayer → controllerManager → (physicalController) → character` 的位置和主背包; 开地图 (远程视图) 时身体在 physicalController 上 |
| `world.py` | 研究和队列、科技、势力修正、进化度、污染、四种产量统计 + 污染和电网统计 (FlowStatistics 的采样和累计)、已探区块 |
| `live.py` | 游戏外的模组宿主的数据来源 (常驻、按区块读、事件比对、跟着身体换地表); 下一块 (游戏外跑模组 Lua) 用 |
| `read.ts` | TypeScript 包装: 起 Python 读, 回 JSON |
| `compare.ts`、`world-compare.ts` | 核对用: RCON 真值怎么读、逐项怎么比 (沙盘测试和下一块的核对共用) |

## 规矩 (旧项目核出来的, 测试守着)
- 每个节点都校验 (连接器回指这一格、实体指回这个地表、原型指针读得出名字), 不合格的跳过并计数 (`dropped`), 不瞎猜; 暂停着读 `dropped` 必须是 0。
- `global` 是对象还是指针 pdb 不说: 两种读法都试, 取 `game.map.game` 指回自己的那条; 只看指针像不像会选错。
- 取成员偏移用深度 0: 深度 1 会撞上嵌套里的同名成员 (`Game.map` 读成 +8)。
- 状态只算核对过的类, 别的类回 null; 一台醒着、缓冲里有东西、目标没满的矿机推算不准 (游戏要调目标的 `canInsert`, 进程外调不了), 只能近似。
- 组装机堵料不能只看 `CraftingMachineFlags::FULL` (机械臂碰过才置上, 刚读完地图时大多没有): 空闲时产物 ≥ 每次产量 × (1 + ⌈1.166 × 机器速度 / 配方秒数⌉) 也算堵料 (2.1.24 对真值: 1573 台里 1484 台一致)。
- 流体读不到 (锅炉没水这种状态读不出); 靠流体的状态在联机时由注入客户端的只读查询补 (下一块)。
- 无限科技 `max_level` 运行时是 4294967295; 等级 = 基础 + 研究过几次。`electric_network_id` = 子网 index + 1; `get_flow_count` 窗口正好 300 个间隔。

## 证据 (游戏 2.1.24)
| 核对 | 结果 |
|---|---|
| 全地表实体 (真实基地存档, 独立版客户端, 暂停) | RCON 17582 个 = 内存 17582 个, 名字 + 位置逐个相等, 编号 1492 个全对, 丢弃 0, 242 毫秒; 跑着连读 5 次丢弃 0, 只有 20 条鱼位置不同 |
| 实体细节 + 机器状态 (真实基地 + 现摆的一组特殊状态) | 12794 项, 不一样 1 项 (那台醒着的矿机) |
| 世界数据 (暂停, 同一 tick) | 393 项 0 差; 科技和统计 2303 项 0 差 |
| 玩家位置 + 背包 (联机服务器上用户自己的客户端, 没注入) | 背包数量和游戏里一致, 每次读 1.4~2.6 毫秒 |
| 大地图 (联机服务器存档副本, 26.7 万实体) | `status` 一次 1~3 秒 (按需读细节、野外区块 60 秒重读之后) |

新项目里的回归: `test/sandbox/memory.test.ts` (新图 + 现摆的特殊状态; `MEMORY_TEST_SAVE=存档.zip` 可换大基地)。

## 还没读
电线连接、物流网、流体、太空平台、别的玩家 (`Map.players`)、`last_user`、地块 (联机时这些由注入客户端的只读 Lua 补)。
