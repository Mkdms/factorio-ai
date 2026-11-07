# 大脑驱动 (core/brains) 和递积累的那段 (core/run)

第二块 = 训练集 (`training/`, 树见 `training/README.md` 第 7 节) 和大脑驱动一起搬。验收: 本机沙盘 (干净的服务器, 不装模组) 上 `--brain claude` (订阅) 跑一班, 看三样 —— 模型用 `./fh` 真建了东西; 回复里自动带出了经验和要点 (班末统计 > 0); `./know` 查到训练集的条目。花额度, 用户说开才跑。

## 目录树 (草图, 2026-11-07; `←` 后面是旧项目 src/play 里的来源, 照搬改名)
```
core/brains/                     接模型: 一轮 = 提示词进、Claude 形状的事件流出; 会话续接、强度、压缩点
  driver.ts                      Driver 接口, 按家选驱动, 跑一轮 (turn-N.jsonl, 翻译过的另存 -raw)   ← online-brain.ts, run.ts turn()
  claude-code.ts                 Claude 订阅 (claude -p --output-format stream-json); 换接口版 = DeepSeek / 中转站 (只换环境变量)   ← cc-env.ts, run.ts ccArgs
  agent-sdk.ts, agent-sdk-runner.ts   Claude Console 密钥 (Agent SDK, 输出同形)             ← 同名
  codex.ts                       GPT 订阅 / 中转站的 Responses 协议 (codex exec --json, 事件翻译)   ← codex-events.ts
  grok.ts                        Grok Build 命令行 (参数 + 事件翻译)                         ← grok-args.ts, grok-events.ts
  gemini.ts                      Antigravity 命令行 (账号地区不符, 搁置, 代码留)              ← antigravity-events.ts
  relay.ts                       中转站: 按站标的协议分流、本机小代理去 metadata、每模型一条最小请求核实   ← relay-route.ts, relay-proxy.ts, relay-verify.ts
  lineup.ts                      阵容 家:模型@强度, 默认模型, 角色名 = 模型名规范写法          ← brains.ts, model-name.ts, roster.ts
  probe.ts                       开班前一句试通                                               ← run.ts probeBrain
  hooks/                         给模型会话的钩子 (PreToolUse / Stop)
    permit.ts                    命令白名单: 只放行 ./fh ./know ./calc ./bp ./plan 和自己目录    ← permit.ts
    read-guard.ts                读文件禁区 (仓库源码、积累的原文件不给读; 大文件要分页)        ← read-guard.ts
    context.ts                   压缩点和 token 记账                                           ← context.ts, context-hook.ts, tokens.ts

core/run/                        (已有: online.ts workspace.ts scan.ts online-lib.ts shell.ts ps1-wrap.ts)
  online.ts                      + 叫大脑: 每轮 提示词 → driver → 回复; --brain 不再只有 none
  brief.ts                       简报生成: manuals/brief.md + 世界真实值 + 用户目标 + knowledge/points.md   ← run.ts BRIEF / briefFor, ours-brief.ts
  deliver.ts                     递积累: 开班登记种子 → 动作成功时附经验 / 配比 / 蓝图候选 (每角色每种一次) → 班末并回 lessons/pending   ← lessons.ts, fh-shim.ts, fh-hints.ts, hints.ts, calc-brief.ts
  supervisor.ts                  监工: 闲置、瓶颈、产量播报、体检只报新问题、工具诉求、真人的话催回    ← observer.ts, health.ts, replies.ts, run.ts sample
  human-chat.ts                  真人聊天: 客户端 chat_read → 转给被点名的 / 全队, 紧急才打断; 不替模型说话   ← human-chat.ts, io/human-chat-bridge.ts
  watchdog.ts, research.ts, peace.ts   看门狗 / 研究自动续上 / 开班和平分钟                     ← 同名
  shifts.ts                      连续换班不关游戏                                              ← shifts.ts, live-shift.ts, shift-recover.ts

core/records/
  summary.ts, review.ts, stats.ts, seen.ts   班次总结 / 复盘 / 每模型统计 / 模型看到了什么        ← digest.ts, review-shift.ts, review.ts, stats.ts, seen.ts, token-profile.ts

commands/                        (已有 fh)
  know.ts                        ./know 关键词: 查训练集 (事实 / 思路 / 要点 / 教训 / 资料)        ← know.ts, ref-sections.ts
  calc/                          ./calc: 离线计算器 (原型数据 + 线性规划)                        ← src/calc/
  bp/                            ./bp: list / show / check / build / view                        ← bp.ts, src/blueprint/
  plan.ts                        ./plan 物品 每分钟                                              ← plan.ts
```

## 搬的顺序
1. `core/brains/driver.ts` + `claude-code.ts` + `hooks/`, `online.ts` 叫大脑 → 沙盘 `--brain claude` 一句试通 (几分钱)。
2. `training/` 按树原样放进去 (复制改名, 不改格式), `brief.ts` + `deliver.ts` + `./know` 接上 → 真模型一班验收 (上面三样)。
3. 其余驱动 (codex / grok / relay / agent-sdk / deepseek)、`supervisor.ts`、`human-chat.ts`、`core/records/`。
4. `./calc` `./bp` `./plan` (连 src/calc、src/blueprint 一起)。
条目格式 (training/README.md 第 3 节) 边搬边定, 搬完再统一; 每步有测试, 旧项目对应文件搬完就删。

## 证据
(待填)
