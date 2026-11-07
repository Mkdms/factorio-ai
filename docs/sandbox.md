# 沙盘 (game/sandbox + game/mod/factorio-ai)

本机无界面服务器 + 我们的模组, 用来开发、测试、跑实验。不碰用户自己的游戏配置和存档; 不放到别人的服务器上。

## 怎么用
```
npm test                 # 不开游戏: 蓝图编解码、RCON 协议、回复解析
npm run test:sandbox     # 起本机服务器跑一遍 (约 2 分钟, 不开窗口)
npm run sandbox:demo     # 演示: 新图 → 放一条小产线 → 加速跑 10 分钟 → 读产量
```
`.env` 的 `FACTORIO_DIR` 指向本机游戏; `SANDBOX_VIEW=1` 时实验另开一个游戏窗口连进去看 (做完留 `SANDBOX_VIEW_LINGER` 秒, 默认 60), 回归测试不开。

## 代码
| 文件 | 做什么 |
|---|---|
| `game/sandbox/server.ts` | `SandboxServer`: 一个实例 = `data/sandbox/<名字>/` 下单独的配置、模组、存档和端口; 建图、导出原型数据 (`data/prototypes/`)、起停、接上在跑的 (换班不关游戏)、`rpc()` 调模组、`runTicks()` 精确跑 tick、`saveNow()` |
| `game/sandbox/rcon.ts` | RCON 客户端: 回复按包 id 认领 (有玩家时回复会乱序)、超时作废、只读命令重连重试、存活检测 |
| `game/sandbox/udp.ts` | UDP 快速通道 (游戏自带 `--enable-lua-udp`): 不经控制台命令, 游戏暂停时不通 |
| `game/sandbox/viewer.ts` | 观看窗口: `data/clients/<名字>/` 单独配置, 自动连进沙盘; 独立版能改名 (`FACTORIO_VIEWER_DIR`) |
| `game/sandbox/paths.ts` | 找游戏目录、数据目录 (`DATA_DIR` → `.env` → `data/`)、写一套游戏配置和模组列表 |
| `game/sandbox/running.ts` | 在跑的进程记录 (`running.json`), 下一班接上用 |
| `game/blueprint.ts` | 蓝图字符串编解码 |
| `game/mod/factorio-ai/` | 沙盘模组: 一个 remote 接口 `factorio-ai.rpc` (RCON 和 UDP 都走它), 方法: ping / exec / time / prepare_area / place_blueprint / inspect / score / power_area / power_fix / unpowered / audit / snapshot / power_networks / feed_setup / feed_stats / say / viewer / save; 实验用的摆放函数 `lab.place` / `lab.slots` / `lab.connections` (位置从碰撞盒算, 不手敲坐标) |

## 两条通道和成就
- RCON 发的是控制台命令 (`/silent-command`): 这张图从此不算 Steam 成就。沙盘不在乎。
- UDP 通道不经控制台; 但装了模组的图成就"独立另行记录", 同不同步 Steam 没测完 (docs/decisions.md)。

## 规矩 (旧项目踩过的坑, 测试守着)
- 回复为空不等于读到空: 玩家加入那一刻命令的回复会丢, 只读请求自动重试, 会改东西的照实报错。
- 每张图第一次发 Lua 命令游戏要确认一次, 第一条不执行: 起服后先发几条探针。
- 放东西用 `lab.place`, 位置从实体碰撞盒算; 供电只走 `power_area` / `power_fix`, 不手摆杆子 (旧项目手摆盖漏了五次)。
- 放完东西、读引擎算出来的关系 (机械臂目标、带子邻居) 之前先跑 2 个 tick。
- 2.1 把炉子 / 组装机 / 发射井的仓位合并成 crafter_*。
