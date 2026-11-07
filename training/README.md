# 训练集规范 (初稿, 2026-11-07)

训练集 = 递给模型的全部积累。独立一块, 程序只认这份规范不认路径, 界面里可以换成别的训练集目录。

## 1. 分什么
| 目录 | 放什么 | 格式 |
|---|---|---|
| `knowledge\` | 游戏事实: 沙盘核实过的数值和行为、游戏内提示与技巧、从官方资料和老玩家帖子检索来的说法 | 每条一个条目 (见第 3 节) |
| `patterns\` | 老玩家思路: 什么情况下怎么选、为什么、代价、和什么牵连、属于哪个流派 | 每条一个条目 |
| `lessons\` | 经验教训: 做某个动作时自动带给模型的提醒 | 每条一个条目, 带触发键 (动作 / 建筑 / 物品) |
| `blueprints\` | 蓝图和实测读数 (产量、吃料、电) | 蓝图字符串 + 一条说明条目 |
| `tools\` | 模型自己写的、验证过有用的脚本 | 脚本 + 一条说明条目 |
| `manuals\` | 给模型的简报、命令手册 | Markdown |

## 2. 两层: 正式区和待核实区
- 每个目录下分 `verified\` (正式区) 和 `pending\` (待核实区)。
- 程序默认只把正式区递给模型; 待核实区的标"暂用"后也能递, 但低风险的才行 (联机服务器上的操作、拆东西、不可逆的大建设不算低风险)。
- 进正式区的条件: 沙盘实验核过, 或用户看过点头。
- 班次跑完自动产出的东西 (复盘里的教训、模型笔记里的经验、模型写的工具) 一律先进待核实区。

## 3. 每条条目必须有
```
id:        唯一编号
title:     一句话
body:      内容 (事实 / 做法 / 提醒)
source:    出处 (官方文档 / wiki / 沙盘实验编号 / 班次编号 / 用户要求), 不写人名
version:   对应的游戏版本
status:    verified | pending | provisional (暂用)
risk:      low | high  (用在待核实时能不能先用)
keys:      触发键 (lessons 用): action / entity / item / recipe
license:   蓝图和工具用: 可公开 / 只本机
```
格式: 给人和模型读的用 Markdown, 给程序读的用 JSON; 同一条两种都要能生成, 不手写两份。

## 4. 可公开 / 只本机
- 自己做的、核实过的: 可公开, 随训练集一起发布。
- 别人的蓝图没写许可、朋友的基地没授权: 只本机, 放 `data\training-private\`, 结构和这里一样, 程序合并读。

## 5. 班次怎么变成经验
```
一班跑完 → 复盘 + 各模型笔记里的教训 → 自动写进 lessons\pending\ (带班次编号)
         → 沙盘核过或用户点头 → 挪进 lessons\verified\ → 下一班开图时自动带上
```
待核实区会堆, 每次开班前界面提示有多少条等核。

## 6. 程序怎么用
- 开班: 读训练集根目录 (界面选的), 按正式区 + 标暂用的生成简报、经验种子、蓝图库索引。
- 模型动手时: 按触发键把对应的经验、配比、蓝图递上, 每个角色每种东西一次。
- 班末: 产出进待核实区, 写统计 (这班用了哪些条目、带出了多少次)。

## 7. 从旧项目和第一版搬什么 (草图, 2026-11-07, 待定后再动手)
第一步先做条目的程序 (`core/training/`: 读写条目、Markdown 和 JSON 互生成、正式区 + 暂用 + 私有区合并读、触发键查找), 有测试后再逐行搬; 搬一行, 旧项目对应的文件删一行。

| 来源 (旧项目 factorio-pilot / 第一版) | 去处 | 区 | 公开 | 备注 |
|---|---|---|---|---|
| `knowledge/facts.json` + `facts.md` (实验写入, 每条带出处和版本) | `knowledge/` | verified | 是 | 转成第 3 节的条目; `.md` 从 `.json` 生成 |
| `knowledge/brief-points.md` (要点, 每条带 P-xxx / facts 出处) | `knowledge/` | verified | 是 | 简报生成时引用, 不再手写进简报 |
| `knowledge/patterns/` 9 个主题 (心法、产线、物流、布局、防御、战斗、星球、进程) | `patterns/` | 用户看过的 verified, 其余 pending | 是 | 朋友基地的案例 `case-friend-nauvis.md` 只本机 |
| `knowledge/lessons-seed.json` (核过的种子, 按 action / entity / item / recipe 键) | `lessons/` | verified | 是 | 已经是条目形状 |
| `lab-data/play/lessons-learned.jsonl` + `knowledge/lessons-learned.jsonl` (模型各班自己记的) | `lessons/` | pending | 是 (去掉坐标) | 每条带班次编号 |
| `knowledge/blueprints/` (社区 7 份带 LICENSE + 自己的 5 个积木带 feed 实测) | `blueprints/` | verified (实测过产量) | 社区的按各自许可, 自己的是 | `index.jsonl` 转成说明条目 |
| `lab-data/datasets/` (社区 660 份 + 预览图 643 + 索引) | `data/training-private/blueprints/` | pending | 否 (许可没逐份查) | 程序合并读; 查清许可的才挪进公开 |
| `lab-data/blueprints/`、`lab-data/friend-world/` (朋友的基地和世界导出) | `data/training-private/` | — | 否 | 要他点头才公开 |
| `lab-data/play/team-tools-keep/` (模型写的跨班工具) | `tools/` | pending | 是 | 验证过有用的才 verified |
| `src/play/brief-zh.md` (简报模板: 世界 / 规矩 / 工具三节) + 派对的命令手册 (已在 `commands/` 里) | `manuals/` | — | 是 (派对 MIT, NOTICE 署名) | 简报由程序按世界真实值生成, 不写死 |
| `docs/research/` 3 篇 (派对、harness、FLE 的阅读笔记) | `knowledge/` | pending | 是 | 检索资料, 标出处和日期 |
| 第一版 `I:\fn\knowledge\` (topics 24 篇、manuals 6、catalogs 10、journal 5、playbook) | 按 `I:\fn\context\v1-knowledge-inventory.md` 清点, 仓库没有的 → `knowledge/` 或 `patterns/` | 一律 pending | 是 | 第一版的说法可能是错的 (ops.md 有几处被实测推翻) |
| 第一版 `I:\fn\data\` (作废的目标文件、界面导出)、`lab-data/gamedata`、`prototypes` (游戏导出数据) | 不进训练集 | — | — | 游戏数据归 `data/` 不上传; 作废的删 |
