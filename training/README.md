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
- 别人的蓝图没写许可、联机服务器玩家的基地没授权: 只本机, 放 `data\training-private\`, 结构和这里一样, 程序合并读 (`core/run/training.ts`)。

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

## 7. 目录树 (2026-11-07 搬进来的; `←` 后面是旧项目里的来源, 原样复制改名, 条目格式边搬边定)
```
training/                        递给模型的全部积累; 独立一块, 界面里可换目录 (环境变量 TRAINING_DIR)
  README.md                      本规范
  knowledge/                     游戏事实
    verified/
      facts.json                 沙盘实验写入的事实, 每条带出处和版本            ← 旧项目 knowledge/facts.json
      facts.md                   同一份给人和模型读                               ← knowledge/facts.md (以后由 .json 生成)
      points.md                  要点, 每条带出处标签; 开班扫描按情况挑 (core/run/hints.ts)   ← knowledge/brief-points.md
    pending/
      research/                  检索来的资料 (26 篇), 每篇带出处、日期、版本       ← docs/research/
  patterns/                      老玩家思路: 情况 → 做法 → 为什么 → 代价 → 关联 → 流派
    verified/                    mindset production logistics-choice layout-styles defense combat planets progression (.md)   ← knowledge/patterns/
    pending/
  lessons/                       做动作时自动带出的提醒 (触发键 action / entity / item / recipe; core/run/lessons.ts)
    verified/seed.json           核过的种子 (68 条)                                ← knowledge/lessons-seed.json
    pending/learned.jsonl        各班模型自己记的, 每条带模型名和班次; 班末自动追加   ← lessons-learned.jsonl 两份合一 (195 条)
  blueprints/                    蓝图 + 实测读数 (./bp 那块接上才递给模型)
    verified/
      community/                 社区蓝图 7 份 (各自的许可见 LICENSE)              ← knowledge/blueprints/community/
      generated/                 自己的积木 5 个 (.txt + .feed.json 实测)           ← knowledge/blueprints/generated/
      index.jsonl                索引 (程序读)
    pending/
  tools/                         模型写的、验证过有用的脚本 (还没有)
    verified/  pending/
  manuals/                       给模型的
    brief.md                     简报模板 (占位符 WORLD / PLAYER / GOAL / REF_INDEX 由 core/run/brief.ts 填)
    notes.md                     笔记模板 (现在在做 / 坐标和认领 / 约定 / 里程碑 / 教训 / 日志)
    ref/                         ./fh help 主题 的手册: 派对的 9 个主题 + index.md + topics.tsv (MIT, LICENSE 在里面)   ← factorio-ai-party agent/ref

data/training-private/           只本机 (不上传), 结构同 training/, 程序合并读
  blueprints/datasets/           社区蓝图数据集 660 份 + 预览图 + 索引 (许可没逐份查)
  blueprints/friend/             联机服务器玩家的基地蓝图和世界导出 (要他点头才公开)
  patterns/pending/、knowledge/pending/research/   联机服务器玩家基地的案例和问题
  v1/                            第一版的知识 (主题 24、手册 6、目录 10、日志、剧本): 有人名和服务器信息, 清过才能进公开区
```
角色目录里: `ref/` = manuals/ref + 正式区的思路 (pattern-*.md) + facts.md + names.tsv (游戏导出的官方中文名, 不进训练集); `./know` 查全部 (commands/know.ts); 做动作时带出教训 (core/run/deliver.ts)。
不进训练集: 游戏导出数据 (归 `data/`)、第一版 `I:\fn\data\` (作废)。大脑驱动的树见 `docs/brains.md`。
