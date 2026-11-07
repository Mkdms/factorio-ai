# 游戏外的模组宿主 (game/offgame + game/mod/factorio-ai-harness)

harness 模组 (factorio-ai-party 的 agent-harness, MIT, 见 NOTICE; 306 个 Lua 文件) 原样放在游戏外面跑: 读世界 = `game/memory` 进程外读内存接进假的游戏接口 (`fake_game.lua`); 账本 (队列、消息、教训、看板) = 本机文件; 模组每 tick 的后台任务 (工厂摘要、探图、燃料和电网采样、报警) 在外面逐 tick 跑; 没有游戏事件就隔几秒读一遍全图和上一遍比, 合成建 / 毁 / 拆 / 打 / 聊天。游戏里不跑任何代码, 服务器只看到普通玩家, 不会不同步, 不碰成就。

这是模型"不装模组"那条路的大脑接口的一半: 读命令和账本由它答; 动作 (走、建、取放、挖、手搓…) 不在这里, 由外面翻译成玩家操作 (下一块 commands/)。模组本身只在沙盘测试里装进游戏当真值。

## 怎么用
```
npm run offgame:setup                                   # data/venv + lupa (真正的 Lua 5.2, 和游戏同版本)
<venv python> -I game/offgame/host.py --defines <原型目录>/defines.json --proto <原型目录>/data-raw-dump.json --pid <客户端进程号> --exe <它的 exe> --ask status --ask 'observe:{"radius":8}'
   ... --serve [--state 账本.lua] [--lua] [--read-only] [--reveal]      常驻: 标准输入一行一个 {"cmd","args"} / {"raw", "act"} / {"eval"} / {"where"} / {"stats"}
   ... --snapshot 快照.json --ask ...                                     回放 (不开游戏)
npm run test:sandbox                                    # 含 test/sandbox/offgame.test.ts: 开一个游戏窗口, 外面答的和游戏里的模组逐字段比
```
TypeScript 里用 `game/offgame/host.ts` (`hostArgs` / `runHost` / `startHost`); 游戏里的模组经 RCON 调用 (测试当真值) 用 `ingame.ts`。defines.json 由 `SandboxServer.dumpDefines()` 导出。

## 代码
| 文件 | 做什么 |
|---|---|
| `game/mod/factorio-ai-harness/` | harness 模组 (2.1 移植版; 改动见 NOTICE): 游戏外的宿主加载它的 Lua, 沙盘测试装进游戏当真值 |
| `host.py` | 宿主: lupa 起 Lua 5.2, 装假接口, 加载模组; `--ask` 一次性回答, `--serve` 常驻 (读请求在别的线程, Lua 只在主线程; 没请求时跑后台任务, 每批一次现读); 账本 `--state` 60 秒写一次盘 (先写临时文件再改名), 重启读回; `--lua` 时内存读不到的 (流体、红绿线、物流网、别的玩家、地块) 经标准输出问代理, 代理调注入客户端的只读查询再写回 (3 秒缓存, 每次提问限 流体 24 / 其他 32 / 地块 400 条; 后台任务只看缓存) |
| `fake_game.lua` | 假的游戏接口: `game` / `script` / `remote` / `storage` / 实体、玩家、势力、地表、科技、统计…; 读得到的给真值, 读不到的记进 `__missing` 回 nil, 不编数字; 动作类一律报错 |
| `host.ts` | 起宿主、一问一答 (TypeScript 侧) |
| `ingame.ts` | 游戏里的 harness 经 RCON 调 (测试真值; 协议照上游 host/harness.ts) |
| `setup.ts` | data/venv + lupa |

## 规矩 (旧项目核出来的, 测试守着)
- 实体对象一个地址一张表, 字段每次提问重新取; 模组存下来下次用时 `valid` 会变 false。游戏重启后实体地址变了, 账本里存的实体引用等于没了。
- 后台任务按 `game.tick % N` 分相位, 要逐个 tick 调不能跳; 一批现读一次内存, 落后太多只补最近 240 tick; 一批的耗时 × 2 之后才跑下一批 (最多占一个核的三分之一)。
- 事件靠两遍扫描比出来: 只算玩家势力的建造 (虫子生成、角色重生不算), 自己会消失的类型 (机器人、货舱、虚影) 不算建拆; 只读模式一件都不算在本地玩家头上; 动手时离身体 20 格内才算自己的 (近似, 没读 `last_user`)。比不出来的: 谁打的、什么伤害、5 秒内生了又没了的。
- `game.surfaces` 按名字和编号都存, `pairs` 时要去重 (旧项目全地表统计翻倍过)。管道默认系统代码页, 宿主把标准输入输出都设成 UTF-8。
- 读数跟着身体换地表 (坐火箭、传送); 开地图 (远程视图) 时身体在 physicalController 上。

## 证据 (旧项目, 游戏 2.1.24, 真实基地存档)
| 核对 | 结果 |
|---|---|
| 模组 Lua 原样加载 | 300 个模块一行不改, 180 毫秒 |
| 外面答的 inventory / observe / inspect / status 对游戏里的模组 | 1936 项差 7 项 (那台醒着的矿机 3 项 + 污染云 4 项), 另有模组自己记的账 40 项 |
| 假接口答的科技和统计 | 2303 项 0 差; 带子和机械臂关系 3773 项 0 差; 世界数据 393 项 0 差 |
| 后台任务在外面跑 90 秒 | 67 批 5351 tick, 占一个核 27%, 0 出错; 建 / 毁 / 拆 / 打 / 聊天事件全对, 晚约 5 秒; 账本落盘重启接上 |
| 跑着常驻连问 8 轮 | status brief 平均 4 毫秒, inventory 1 毫秒, observe 半径 16 147 毫秒, status 180 毫秒, 0 失败 |
| 大地图 (联机服务器存档副本, 26.7 万实体) | status 1~3 秒 (细节按需读、野外区块 60 秒重读之后) |

新项目里的回归: `test/sandbox/offgame.test.ts` (新图 + 现摆的一组机器)。

## 还没做
别的玩家 (`Map.players`)、`last_user`、太空平台、控制行为 (红绿线条件); 流体、红绿线、物流网、地块只能靠 `--lua` 问注入客户端 (下一块接上; 没开时地块名回 "unknown", 不编)。机械臂 `inspect` 的 `electricity` (引擎现算的功率上限) 没搬, 外面不给这个字段。受攻击的警告 (`warnings`) 来自战斗事件, 外面看不到。**待查**: 游戏跑着时 `status` 的 `chart.visible_chunks` 对不上 (新图核出来的: 游戏里角色视野内的区块一直算可见 221, 外面按"10 秒内探过"算只剩 25; 暂停着比是对的)。
