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

## 7. 目录树 (草图, 2026-11-07; `←` 后面是旧项目里的来源, 原样复制改名, 条目格式边搬边定, 不先写条目程序)
```
training/                        递给模型的全部积累; 独立一块, 界面里可换目录
  README.md                      本规范
  knowledge/                     游戏事实
    verified/
      facts.json                 沙盘实验写入的事实, 每条带出处和版本            ← knowledge/facts.json
      facts.md                   同一份给人和模型读 (由 .json 生成)              ← knowledge/facts.md
      points.md                  简报要点, 每条带 facts 出处                     ← knowledge/brief-points.md
      names.json                 建筑 / 物品 / 科技的官方中文名                   ← 游戏导出 (lab-data/prototypes)
    pending/
      research/                  检索来的资料, 每篇带出处、日期、版本             ← docs/research/ 3 篇, 以后的检索
      v1/                        第一版的主题 / 手册 / 目录, 一律待核             ← I:\fn\knowledge (topics 24, manuals 6, catalogs 10)
  patterns/                      老玩家思路: 情况 → 做法 → 为什么 → 代价 → 关联 → 流派
    verified/                    mindset production logistics layout defense combat planets progression (.md)   ← knowledge/patterns/
    pending/
  lessons/                       做动作时自动带出的提醒 (触发键 action / entity / item / recipe)
    verified/seed.json           核过的种子                                        ← knowledge/lessons-seed.json
    pending/learned.jsonl        各班模型自己记的, 每条带班次编号                   ← lab-data/play/lessons-learned.jsonl + knowledge/lessons-learned.jsonl
  blueprints/                    蓝图 + 实测读数
    verified/
      <名字>.txt                 蓝图字符串
      <名字>.json                说明 + 实测 (产量 / 吃料 / 电, 哪次实验)          ← knowledge/blueprints/ (自己的 5 个积木 + 社区 7 份)
      index.jsonl                索引 (程序读)
    pending/
    LICENSES.md                  社区蓝图各自的许可
  tools/                         模型写的、验证过有用的脚本
    verified/fhlib.py                                                             ← lab-data/play/team-tools-keep/
    pending/
  manuals/                       给模型的
    brief.md                     简报模板 (世界 / 规矩 / 工具三节; 和平、星球、目标等真实值由程序填)   ← src/play/brief-zh.md + ours-brief.ts + run.ts BRIEF
    notes.md                     笔记模板 (现在在做 / 坐标 / 计划 / 教训 / 日志)   ← run.ts NOTES
    commands.md                  命令手册索引 (正文 = commands/cli 的 fh help)     ← 派对手册 (MIT, NOTICE)

data/training-private/           只本机 (不上传), 结构同 training/, 程序合并读
  blueprints/pending/            社区蓝图数据集 660 份 + 预览图 + 索引 (许可没逐份查)   ← lab-data/datasets/
  blueprints/friend/             朋友的基地蓝图和世界导出 (要他点头才公开)          ← lab-data/blueprints/, friend-world/
  patterns/pending/case-friend-nauvis.md                                            ← knowledge/patterns/
```
不进训练集: 第一版 `I:\fn\data\` (作废的目标文件、界面导出, 删)、游戏导出数据 (归 `data/`)。大脑驱动的树见 `docs/brains.md`, 两者一起搬 (第二块)。
