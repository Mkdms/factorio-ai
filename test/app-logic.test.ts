// 桌面界面 (app/) 的数据转换和折叠逻辑: app/src/logic.ts 是纯函数, 这里直接用 Node 跑
import test from "node:test";
import assert from "node:assert/strict";
import {
  TEAM, accountSeatFirst, agentTitle, askText, commandLabel, composerBlock, controlsAccount, fmtGameTime, fmtPct, fmtRate, foldLines, isOperatorAsk, localItems, mergeThread, needsReply, rosterDiff,
  groupEnemyLabel, parseComposer, pendingAsks, presence, teamPresence, preview, quotaDetail, runBanner, runLabel, runStart, staleMinutes, stepsMeta, timeMarks, trimLocals, LOCAL_MAX, watchdogLines,
  accountStatus, accountsLine, accountsBrief, accountQuota, SLASH_COMMANDS, SOURCES, askOptions, fmtBalance, landingBanner, nextViewRun, runBriefStatus, speakerStarts, vendorOf, askReply, downBanner, loginDone, relayModelGroups, remainPct, resetIn, tightest,
  lineupOptions, parseSeatValue, seatLabel, seatValue, seatDisplay, defaultInvite, seatGameName, prettyModel, mentionTargets, seatWord, effortLabel, verifyLine, relayKind, stopButton,
  type Account, type ControlProc, type Item, type Line, type Local, type State,
} from "../app/src/logic.ts";

const at = (s: number) => new Date(Date.UTC(2026, 10, 3, 11, 0, s)).toISOString();

test("群里 @ 成员: 游戏名 / 模型名 / 字母 / 唯一前缀都认, @全队 = 所有人, 认不出的列在 unknown, 没有 @ = 没点名", () => {
  const agents = [{ id: "a", name: "MK", busy: null, last: null, model: "Claude Opus 5.5" }, { id: "b", name: "MiniMax-M3.1-Flash", busy: null, last: null, model: "MiniMax-M3.1-Flash" }, { id: "c", name: "Glm-5.3", busy: null, last: null, model: "glm-5.3" }];
  assert.deepEqual(mentionTargets("@Glm-5.3 你在做什么", agents), { ids: ["c"], unknown: [], all: false });
  assert.deepEqual(mentionTargets("先 @mk 再 @minimax 一起修, @MK 别重复", agents).ids, ["a", "b"], "大小写不分、唯一前缀、不重复");
  assert.deepEqual(mentionTargets("@B 去补蓝瓶", agents).ids, ["b"], "字母也认");
  assert.deepEqual(mentionTargets("@全队 停下", agents), { ids: ["a", "b", "c"], unknown: [], all: true });
  assert.deepEqual(mentionTargets("@Gpt 你好 @Glm-5.3", agents), { ids: ["c"], unknown: ["Gpt"], all: false });
  assert.deepEqual(mentionTargets("没有点名, 邮箱 a@b.com 不算", agents), { ids: [], unknown: [], all: false });
});

test("连续的命令和结果折成一项, 结果按先后配给命令; 说的话把它们隔开", () => {
  const lines: Line[] = [
    { kind: "说", text: "先修铜列煤道", at: at(1) },
    { kind: "命令", text: `cd "C:/Users/x/brain/a" && ./fh call status`, desc: "看状态", at: at(2) },
    { kind: "命令", text: "./fh call labs", at: at(2) }, // 同一条回复里并行的两条
    { kind: "结果", text: "clock 3h", at: at(3) },
    { kind: "结果", text: "Exit code 1\nerror: x", error: true, at: at(4) },
    { kind: "说", text: "研究中心 9/11", at: at(5) },
    { kind: "命令", text: "./fh sleep 60", at: at(6) },
  ];
  const items = foldLines(lines, "a");
  assert.deepEqual(items.map((x) => x.type), ["say", "steps", "say", "steps"]);
  const s = items[1] as Item & { type: "steps" };
  assert.deepEqual(s.steps.map((x) => [x.cmd, x.desc ?? null, x.result ?? null, x.error ?? false]), [
    ["./fh call status", "看状态", "clock 3h", false],
    ["./fh call labs", null, "Exit code 1\nerror: x", true],
  ]);
  assert.equal(s.at, at(2));
  assert.equal(stepsMeta(s.steps), "干了 2 步 · 1 步失败");
  assert.equal((items[3] as Item & { type: "steps" }).steps[0].result, undefined); // 还在等结果
  assert.equal(preview(items), "干了 1 步 · ./fh sleep 60");
});

test("截取范围之前的命令的结果: 单独一步, 只有结果", () => {
  const items = foldLines([{ kind: "结果", text: "tick: 1" }, { kind: "说", text: "好" }], "b");
  assert.deepEqual((items[0] as Item & { type: "steps" }).steps, [{ cmd: "", result: "tick: 1", error: undefined, at: undefined }]);
});

test("找操作员的命令 = 等你: 取出它说的话, 它的结果不显示; 之后 fh 回复里有你的话就算回过", () => {
  // 真实样例 (2026-11-03T10-13-47 那一班, A)
  const ask = `cd "C:/Users/x/brain/a" && ./fh call operator --args '{"text":"MK 断线了 (disconnected players have no controllable character), 所有动作被拒, 请帮忙重连图形客户端。"}'`;
  assert.ok(isOperatorAsk(ask));
  assert.ok(!isOperatorAsk("./fh call operators_list") && !isOperatorAsk("echo call operator"));
  const lines: Line[] = [
    { kind: "命令", text: "./fh call status", at: at(1) },
    { kind: "命令", text: ask, at: at(2) },
    { kind: "结果", text: "ok", at: at(3) },
    { kind: "结果", text: "Exit code 1\nerror: action_failed", error: true, at: at(3) },
  ];
  const items = foldLines(lines, "a");
  assert.deepEqual(items.map((x) => x.type), ["steps", "ask"]);
  assert.equal((items[0] as Item & { type: "steps" }).steps[0].result, "ok");
  const a = items[1] as Item & { type: "ask" };
  assert.equal(a.text, "MK 断线了 (disconnected players have no controllable character), 所有动作被拒, 请帮忙重连图形客户端。");
  assert.equal(a.answered, false);
  assert.equal(pendingAsks(items), 1);
  assert.equal(preview(items), "等你: MK 断线了 (disconnected players have no controllable character), 所有动作被拒, 请帮忙重连图形客户端。");
  const later = foldLines([...lines, { kind: "命令", text: "./fh call status", at: at(9) }, { kind: "结果", text: "OPERATOR: 用户: 已经重连了\ntick: 5", at: at(10) }], "a");
  assert.equal(pendingAsks(later), 0);
});

test("找操作员的汇报 (\"收到, 我先修…\") 不是等你: 当它对你说的话, 不弹批准", () => {
  assert.equal(needsReply("收到，我先修科技包的原料和输送，已有生产科技包送入研究中心；正在接铁轨及成品自动供料。"), false);
  assert.equal(needsReply("铁轨带已实际供给生产科技包机；我继续修产能插件。"), false);
  assert.equal(needsReply("MK 断线了, 所有动作被拒, 请帮忙重连图形客户端。"), true, "请… = 要你做事");
  assert.equal(needsReply("要不要把蓝瓶线拆了重建?"), true);
  assert.equal(needsReply("两个方案:\n1. 先修电\n2. 先修矿"), true, "列了选项 (一行一个)");
  assert.equal(needsReply("可以用共享箱里的 500 块铁板吗"), true);
  const report = `./fh call operator --args '{"text":"收到，铁轨带已实际供给生产科技包机；我继续修产能插件。"}'`;
  const items = foldLines([{ kind: "命令", text: report, at: at(1) }, { kind: "结果", text: "ok", at: at(2) }, { kind: "命令", text: "./fh call status", at: at(3) }, { kind: "结果", text: "tick 1", at: at(4) }], "c");
  assert.deepEqual(items.map((x) => x.type), ["say", "steps"]);
  assert.equal((items[0] as Item & { type: "say" }).toYou, true);
  assert.equal(pendingAsks(items), 0);
  assert.equal((items[1] as Item & { type: "steps" }).steps[0].result, "tick 1", "汇报那条的结果不显示, 后面的命令照常配结果");
});

test("选谁控制账号: 排到名单第 1, 原来第 1 个变普通队员, 人数不变; 名单里没有就加到最前; 顺序变了不算有人进出", () => {
  const opus = { brain: "claude", model: "claude-opus-5-5" }, haiku = { brain: "claude-api", model: "claude-haiku-5-5" }, gpt = { brain: "codex", model: "gpt-6.1-sol" };
  assert.deepEqual(accountSeatFirst([opus, haiku, gpt], gpt), [gpt, opus, haiku]);
  assert.deepEqual(accountSeatFirst([opus, haiku], opus), [opus, haiku], "已经是它就不动");
  assert.deepEqual(accountSeatFirst([opus], gpt), [gpt, opus], "名单里没有: 加到最前");
  const live = [{ id: "a", name: "mkdm", busy: true, last: null, seat: haiku }, { id: "b", name: "Gpt", busy: true, last: null, seat: gpt }, { id: "c", name: "Opus", busy: true, last: null, seat: opus }];
  assert.deepEqual(rosterDiff(accountSeatFirst([haiku, gpt, opus], gpt), live), { join: [], leave: [] }, "这一班谁都不用进出");
  assert.deepEqual(rosterDiff([{ brain: "grok", model: "grok-4.7" }, gpt, opus], live), { join: [], leave: [] }, "下拉换了第 1 个: 下一班才换, 现在不加不移");
});

test("名单和在跑的角色比: 第 1 席不动, 同模型按个数对, 新勾的加、去掉的移出, 已移出和没记 seat 的不算", () => {
  const live = [
    { id: "a", name: "MK", busy: true, last: null, seat: { brain: "claude", model: "claude-opus-5-5" } },
    { id: "b", name: "Glm-5-Turbo", busy: true, last: null, seat: { brain: "relay", model: "glm-5-turbo" } },
    { id: "c", name: "Glm-5-Turbo-2", busy: true, last: null, seat: { brain: "relay", model: "glm-5-turbo" } },
    { id: "d", name: "Deepseek", busy: true, last: null, seat: { brain: "deepseek", model: "deepseek-v4-pro" } },
    { id: "e", name: "Old", busy: true, last: null, left: true, seat: { brain: "grok", model: "grok-4.7" } },
    { id: "f", name: "NoSeat", busy: true, last: null },
  ];
  const admin = { brain: "claude", model: "opus" };
  const glm = { brain: "relay", model: "glm-5-turbo" }, gpt = { brain: "codex", model: "gpt-6.1-sol" };
  assert.deepEqual(rosterDiff([admin, glm, gpt], live), { join: [gpt], leave: ["c", "d"] });
  assert.deepEqual(rosterDiff([admin, glm, glm, { brain: "deepseek", model: "deepseek-v4-pro" }], live), { join: [], leave: [] }, "一样就不动");
  assert.deepEqual(rosterDiff([{ brain: "codex", model: "gpt-6.1-sol" }], live).leave, ["b", "c", "d"], "第 1 席换了也不动玩家的身体");
});

test("沙盘全是服务器角色 (窗口只看): A 也能进出, 第 1 席换了就是一进一出", () => {
  const opus = { brain: "claude", model: "claude-opus-5-5" }, glm = { brain: "relay", model: "glm-5-turbo" }, gpt = { brain: "codex", model: "gpt-6.1-sol" };
  const live = [{ id: "a", name: "Claude-Opus-5.5", bot: "Claude-Opus-5.5", busy: true, last: null, seat: opus }, { id: "b", name: "Glm-5-Turbo", bot: "Glm-5-Turbo", busy: true, last: null, seat: glm }];
  assert.deepEqual(rosterDiff([opus, glm], live), { join: [], leave: [] });
  assert.deepEqual(rosterDiff([gpt, glm], live), { join: [gpt], leave: ["a"] });
  assert.deepEqual(rosterDiff([glm], live), { join: [], leave: ["a"] });
});

test("群卡写虫子和开班和平; 看门狗卡写和平还剩多久", () => {
  assert.equal(groupEnemyLabel({}), "");
  assert.equal(groupEnemyLabel({ peaceful: false }), " · 有虫子");
  assert.equal(groupEnemyLabel({ peaceful: false, peacefulMinutes: 10 }), " · 有虫子, 开班先和平 10 分钟");
  const wd = { at: "", recoveries: 0, failed: 0, downtimeS: 0, downtimeShare: 0, down: false, downS: 0, last: null, deaths: 0, deathsTotal: 0, lastDeathAt: null, autoResearch: 0 };
  assert.match(watchdogLines({ ...wd, peaceLeftS: 61 })[0], /和平还剩 2 分钟/);
  assert.doesNotMatch(watchdogLines(wd).join("\n"), /和平/);
});

test("回过的等你: 新前缀 \"管理员 (用户)\" 也认", () => {
  const ask = `./fh call operator --args '{"text":"要不要拆?"}'`;
  const items = foldLines([{ kind: "命令", text: ask, at: at(1) }, { kind: "结果", text: "ok", at: at(2) }, { kind: "命令", text: "./fh call status", at: at(3) }, { kind: "结果", text: "OPERATOR: 管理员 (用户) 在界面里对你说: 不拆", at: at(4) }], "c");
  assert.equal(pendingAsks(items), 0);
});

test("没带时间的等你 (Codex / Grok 翻译的行) 也能被之后送到的话算成已回复", () => {
  const brain: Item[] = [{ type: "say", agent: "c", text: "开工", at: at(1) }, { type: "ask", agent: "c", text: "要不要拆?", answered: false }];
  const you: Item[] = [{ type: "you", agent: "c", text: "批准", at: at(5), status: "已送到" }];
  const merged = mergeThread([brain, you]);
  assert.equal(pendingAsks(merged), 0, "等你继承了前一项的时间 (at(1)), 你 at(5) 说的话在它之后");
  const merged2 = mergeThread([[{ type: "ask", agent: "c", text: "要不要拆?", answered: false }], you]);
  assert.equal(pendingAsks(merged2), 1, "整路都没时间就没法比, 维持等你");
});

test("命令文字被截断 (控制接口只给 300 字) 时也能取出大半句; 去掉 cd 前缀不露本机路径", () => {
  assert.equal(askText(`./fh call operator --args '{"text":"缺一台研究中心\\n请看一下`), "缺一台研究中心\n请看一下");
  assert.equal(askText("./fh call operator"), "./fh call operator");
  assert.equal(commandLabel(`cd "C:/Users/x/brain/2026/a" && cd sub && ./fh call build`), "./fh call build");
});

test("按时间合并几路: 各路先后不变, 没时间的接在前一项后面; 你后来说过话 (已送到) 就算回过了", () => {
  const brain = foldLines([
    { kind: "说", text: "一", at: at(1) },
    { kind: "命令", text: `./fh call operator --args '{"text":"要不要拆旧炉子?"}'`, at: at(5) },
    { kind: "说", text: "三", at: at(20) },
  ], "a");
  const locals: Local[] = [
    { type: "tell", agent: "a", text: "拆", at: at(10), status: "已送到" },
    { type: "cmd", agent: "a", args: "call status", at: at(3), pending: false, out: "ok", code: 0 },
    { type: "tell", agent: "b", text: "给 B 的", at: at(4), status: "已送到" },
  ];
  const m = mergeThread([brain, localItems(locals, "a")]);
  assert.deepEqual(m.map((x) => x.type), ["say", "you-cmd", "ask", "you", "say"]);
  assert.equal(pendingAsks(m), 0);
  // 没送到的话不算回过
  const m2 = mergeThread([foldLines([{ kind: "命令", text: `./fh call operator --args '{"text":"?"}'`, at: at(5) }], "a"), localItems([{ type: "tell", agent: "a", text: "拆", at: at(10), status: "没送到" }], "a")]);
  assert.equal(pendingAsks(m2), 1);
  // 对全队说的话: 每个角色的对话流里都有, 也算回过
  const team: Local[] = [{ type: "tell", agent: TEAM, text: "都拆", at: at(10), status: "已送到" }];
  assert.equal(localItems(team, "b").length, 1);
  assert.equal(pendingAsks(mergeThread([foldLines([{ kind: "命令", text: `./fh call operator --args '{"text":"?"}'`, at: at(5) }], "b"), localItems(team, "b")])), 0);
  // 全队看所有本地记录
  assert.equal(localItems(locals, TEAM).length, 3);
  // 没有时间的项接在同一路前一项后面
  const noTime = mergeThread([[{ type: "say", agent: "a", text: "x", at: at(1) }, { type: "say", agent: "a", text: "y" }], [{ type: "say", agent: "b", text: "z", at: at(0) }]]);
  assert.deepEqual(noTime.map((x) => (x as { text: string }).text), ["z", "x", "y"]);
});

test("左栏圆点: 等你优先, 没在跑, 再看忙闲", () => {
  const a = { id: "a", name: "玩家 1", busy: true, last: null };
  assert.equal(presence(a, 1, true), "等你");
  assert.equal(presence(a, 0, true), "在干活");
  assert.equal(presence({ ...a, busy: false }, 0, true), "闲着");
  assert.equal(presence({ ...a, busy: null }, 0, true), "开班中", "还没有第一次读数");
  assert.equal(presence({ ...a, busy: false, thinking: true }, 0, true), "在想", "身体没动, 大脑这一轮还在跑");
  assert.equal(presence({ ...a, busy: true, thinking: true }, 0, true), "在干活");
  assert.equal(teamPresence(["闲着", "在想"]), "在干活");
  assert.equal(teamPresence(["开班中", "开班中"]), "开班中");
  assert.equal(teamPresence(["闲着", "等你"]), "等你");
  assert.equal(teamPresence(["闲着", "开班中"]), "闲着");
  assert.equal(presence(a, 2, false), "没在跑");
  assert.equal(preview([]), "还没有说过话");
  assert.equal(preview([{ type: "you", agent: "a", text: "\n  多造炉子\n第二行", at: at(1), status: "发送中" }]), "你: 多造炉子");
});

test("'控制你的账号': 会话文件写明的听它的 (不装模组那条路: 沙盘独立版角色不是, 挂在用户 Steam 客户端上的是); 老班按第 1 个角色没有服务器角色名", () => {
  assert.equal(controlsAccount("a", { account: false }), false, "沙盘里的独立版角色 (2026-11-08 界面上误标成控制你的账号)");
  assert.equal(controlsAccount("a", { account: true }), true);
  assert.equal(controlsAccount("a", {}), true, "第二版老班: 第 1 个没有 bot = 玩家的身体");
  assert.equal(controlsAccount("a", { bot: "claude" }), false);
  assert.equal(controlsAccount("b", {}), false);
});

test("界面上的角色名 = 模型名; 同模型两个带游戏名; 控制接口没给模型名时只写字母; 全队就是全队", () => {
  const agents = [{ id: "a", name: "MK", busy: true, last: null, model: "Claude Opus 5.5" }, { id: "b", name: "ai2", busy: false, last: null }];
  assert.equal(agentTitle("a", agents), "Claude Opus 5.5");
  assert.equal(agentTitle("b", agents), "B");
  assert.equal(agentTitle("c", agents), "C");
  assert.equal(agentTitle(TEAM, agents), "全队");
  const two = [{ id: "a", name: "MK", busy: true, last: null, model: "Claude Opus 5.5" }, { id: "b", name: "claude", busy: false, last: null, model: "Claude Opus 5.5" }];
  assert.deepEqual([agentTitle("a", two), agentTitle("b", two)], ["Claude Opus 5.5 (MK)", "Claude Opus 5.5 (claude)"]);
  // 头像认厂商
  assert.deepEqual(["MiniMax-M3.1-Flash", "kimi-k3.1-pro", "volcengine/doubao-seed-2.1-pro", "step-5-preview", "qwen3-max", "gemini-2.5-pro", "gpt-6.1-terra", "deepseek-v4-pro"].map(vendorOf),
    ["minimax", "kimi", "doubao", "stepfun", "qwen", "gemini", "openai", "deepseek"]);
  // 阵容里的游戏名 (同 brains.ts): 模型名规范写法, 同名 -2; 沙盘第 1 个也是服务器角色, 联机服务器的群第 1 个才是你的账号
  const seats = [{ brain: "claude", model: "opus" }, { brain: "relay", model: "MiniMax-M3.1-Flash" }, { brain: "relay", model: "deepseek-v4-pro" }, { brain: "deepseek", model: "deepseek-v4-pro" }];
  assert.deepEqual(seats.map((_, i) => seatGameName(seats, i)), ["Claude-Opus", "MiniMax-M3.1-Flash", "Deepseek-V4-Pro", "Deepseek-V4-Pro-2"], "游戏名 = 模型名规范写法");
  assert.deepEqual(seats.map((_, i) => seatGameName(seats, i, true)), [null, "MiniMax-M3.1-Flash", "Deepseek-V4-Pro", "Deepseek-V4-Pro-2"]);
  assert.equal(seatLabel(seats, 0), "服务器角色 · 游戏里叫 Claude-Opus");
  assert.equal(seatLabel(seats, 0, true), "控制你的账号, 游戏里名字不改");
  assert.equal(seatLabel(seats, 3), "服务器角色 · 游戏里叫 Deepseek-V4-Pro-2");
  assert.equal(prettyModel("gpt-6.1-terra"), "Gpt-6.1-Terra");
});

test("输入框: / 开头是游戏命令 (./fh 参数), 其他是说话", () => {
  assert.deepEqual(parseComposer("  多造几台炉子 "), { type: "tell", text: "多造几台炉子" });
  assert.deepEqual(parseComposer("/call status"), { type: "fh", args: "call status" });
  assert.deepEqual(parseComposer("/ ./fh call labs"), { type: "fh", args: "call labs" });
  assert.equal(parseComposer("/")!.type, "error");
  assert.equal(parseComposer("   "), null);
});

test("时间和数字的格式", () => {
  assert.equal(runStart("2026-11-03T11-17-28")!.toISOString(), "2026-11-03T11:17:28.000Z");
  assert.equal(runStart("最新"), null);
  const d = runStart("2026-11-03T11-17-28")!;
  assert.equal(runLabel("2026-11-03T11-17-28"), `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:17 开班`);
  assert.equal(fmtGameTime(807), "13 小时 27 分");
  assert.equal(fmtGameTime(42.9), "42 分");
  assert.equal(fmtGameTime(undefined), "—");
  assert.equal(fmtRate(1.8019), "1.8");
  assert.equal(fmtRate(12.013), "12");
  assert.equal(fmtRate(undefined), "—");
  assert.equal(fmtPct(0.42), "42%");
  assert.equal(quotaDetail("额度 (可用): 7 天窗口已用 43%, 3.9 天后重置"), "7 天窗口已用 43%, 3.9 天后重置");
  assert.equal(quotaDetail("额度: 没读到 (输出里没有 rate_limit_event)"), "额度: 没读到 (输出里没有 rate_limit_event)");
  assert.equal(quotaDetail(undefined), "还没读到");
  assert.equal(fmtPct(null), "—");
});

test("对话流上方的提示和输入框能不能发", () => {
  const now = Date.UTC(2026, 10, 3, 11, 50);
  const game = { tick: 1, gameMinutes: 1, at: now - 60_000 };
  const running: State = { run: { id: "2026-11-03T11-17-28", running: true, stopping: false }, agents: [{ id: "a", name: "玩家 1", busy: true, last: null }], game };
  assert.equal(runBanner(running, now), null);
  assert.equal(staleMinutes(game, now), 1);
  assert.match(runBanner({ ...running, game: { ...game, at: now - 10 * 60_000 } }, now)!.text, /已经 10 分钟没更新/);
  assert.match(runBanner({ ...running, run: { ...running.run!, stopping: true } }, now)!.text, /正在收尾/);
  // 威胁警报在顶部 (M6 2026-11-04): 掉线中 > 读数停更 > 本班死亡
  const wd = { at: at(0), recoveries: 1, failed: 0, downtimeS: 80, downtimeShare: 0.015, down: false, downS: 0, last: { at: at(5), reason: "服务器进程退出", save: "_autosave1", saveAgeS: 112, ok: true, downS: 60 }, deaths: 0, deathsTotal: 3, lastDeathAt: null, autoResearch: 2 };
  assert.equal(runBanner({ ...running, watchdog: wd }, now), null, "没掉线没死亡不报");
  assert.match(runBanner({ ...running, watchdog: { ...wd, down: true, downS: 30 } }, now)!.text, /掉线 30 秒.*在等/);
  assert.match(runBanner({ ...running, watchdog: { ...wd, down: true, downS: 50 } }, now)!.text, /掉线 50 秒.*重启/);
  assert.match(runBanner({ ...running, watchdog: { ...wd, deaths: 2, lastDeathAt: at(9) } }, now)!.text, /死亡 2 次/);
  assert.match(runBanner({ ...running, game: { ...game, at: now - 10 * 60_000 }, watchdog: { ...wd, deaths: 2 } }, now)!.text, /没更新/, "读数停更比死亡优先");
  const ended = runBanner({ ...running, run: { ...running.run!, running: false } }, now)!;
  assert.equal(ended.tone, "info");
  assert.match(ended.text, /^没有在跑 · 下面是最近一班 \(.+开班\) 的记录$/);
  assert.equal(runBanner({ run: null }, now)!.text, "还没有任何一班的记录");
  assert.equal(composerBlock(running, "a"), null);
  assert.equal(composerBlock(running, TEAM), null);
  assert.equal(composerBlock(running, "c"), "这一班没有这个角色");
  assert.equal(composerBlock({ ...running, run: { ...running.run!, running: false } }, "a"), "没有在跑, 不能发话");
  assert.equal(composerBlock(null, "a"), "还没有任何一班, 不能发话");
});

test("右栏看门狗卡的几行: 停机、恢复和最近一次、死亡、自动排研究", () => {
  const wd = { at: at(0), recoveries: 1, failed: 1, downtimeS: 80, downtimeShare: 0.015, down: true, downS: 20, last: { at: at(5), reason: "服务器进程退出", save: "_autosave1", saveAgeS: 112, ok: true, downS: 60 }, deaths: 2, deathsTotal: 5, lastDeathAt: at(9), autoResearch: 2 };
  const lines = watchdogLines(wd);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^停机 80 秒 \(2%\) · 现在掉线 20 秒$/);
  assert.match(lines[1], /^恢复 1 次 \(失败 1\) · 最近 .* 服务器进程退出 → _autosave1$/);
  assert.match(lines[2], /^死亡 2 次 \(最近 .*\) · 这个世界累计 5$/);
  assert.equal(lines[3], "自动排研究 2 次");
  assert.deepEqual(watchdogLines(null), []);
  assert.match(watchdogLines({ ...wd, down: false, failed: 0, last: { ...wd.last, ok: false, save: null } })[1], /→ 重启失败$/);
});

test("时间只在第一项和停顿 3 分钟以上之后写", () => {
  const say = (s?: number): Item => ({ type: "say", agent: "a", text: "x", at: s === undefined ? undefined : at(s) });
  assert.deepEqual(timeMarks([say(0), say(60), say(240), say(), say(250), say(429), say(610)]), [true, false, true, false, false, false, true]);
  assert.deepEqual(timeMarks([say(), say(0), say(181)]), [false, true, true]);
  assert.deepEqual(timeMarks([]), []);
});

test("本地记录只留最近的", () => {
  const many: Local[] = Array.from({ length: LOCAL_MAX + 5 }, (_, i) => ({ type: "tell", agent: "a", text: String(i), at: at(0), status: "已送到" }));
  const kept = trimLocals(many);
  assert.equal(kept.length, LOCAL_MAX);
  assert.equal((kept[0] as { text: string }).text, "5");
});

test("等你卡片的按钮: 一行一个的选项 (1. / A) / ①) 每项一个按钮, 要挨着数、2~6 项; 不像选项就是批准 / 不批", () => {
  assert.deepEqual(askOptions("拆不拆旧石炉?\n1. 拆, 换电炉\n2. 留着\n3) 先拆一半"), [{ key: "1", text: "拆, 换电炉" }, { key: "2", text: "留着" }, { key: "3", text: "先拆一半" }]);
  assert.deepEqual(askOptions("选哪种:\nA) 冶炼列\nb. 主带").map((o) => o.key), ["A", "B"]);
  assert.deepEqual(askOptions("①造机器人\n②先扩蓝瓶").map((o) => o.text), ["造机器人", "先扩蓝瓶"]);
  assert.deepEqual(askOptions("要不要拆掉旧的石炉?"), [], "没写选项");
  assert.deepEqual(askOptions("1. 只有一项"), [], "只有一项");
  assert.deepEqual(askOptions("2. 铁板\n3. 铜板"), [], "不从 1 开始 (像是在列数据)");
  assert.deepEqual(askOptions("1. 铁\n3. 铜").length, 0, "不挨着");
  assert.equal(askReply("要不要拆掉旧的石炉?", "批准"), '批准 (回你问的: "要不要拆掉旧的石炉?")');
  assert.equal(askReply("要不要拆", "不批"), '不批, 先别做 (回你问的: "要不要拆")');
  assert.equal(askReply(`${"很长".repeat(30)}\n1. 拆`, { key: "1", text: "拆" }), `选 1: 拆 (回你问的: "${"很长".repeat(20)}…")`);
});

test("账号页: 一句话状态、剩多少、最紧的窗口、重置时间、左下角那一行", () => {
  const base: Account = { id: "claude", label: "Claude Code", short: "Claude", installed: true, version: "2.1.314", signedIn: true, plan: "Max", usage: [], usageWhy: null, login: "claude auth login", install: "" };
  const claude: Account = { ...base, usage: [{ label: "5 小时", used: 10, resetsAt: null }, { label: "7 天", used: 44.4, resetsAt: "2026-11-07T11:00:00Z" }] };
  const grok: Account = { ...base, id: "grok", label: "Grok Build", short: "Grok", installed: false, signedIn: null, plan: null };
  const gpt: Account = { ...base, id: "codex", label: "Codex (GPT)", short: "GPT", signedIn: false, plan: null };
  assert.deepEqual([accountStatus(claude), accountStatus(grok), accountStatus(gpt), accountStatus({ ...gpt, signedIn: null })], ["已登录 · Max", "本机没装", "装了, 还没登录", "装了, 看不出登没登录"]);
  assert.equal(tightest(claude)!.label, "7 天");
  assert.equal(remainPct(tightest(claude)!), 56);
  assert.equal(remainPct({ label: "x", used: 130, resetsAt: null }), 0);
  const now = Date.parse("2026-11-03T13:00:00Z");
  assert.equal(resetIn("2026-11-07T11:00:00Z", now), "3.9 天后重置");
  assert.equal(resetIn("2026-11-03T17:12:00Z", now), "4.2 小时后重置");
  assert.equal(resetIn(null, now), "");
  assert.equal(accountsLine([claude, grok, gpt]), "Claude 剩 56% · Grok 没装 · GPT 没登录");
  assert.equal(accountsLine(null), null);
  assert.ok(loginDone([claude, gpt], "claude") && !loginDone([claude, gpt], "codex") && !loginDone(null, "claude"));
});

test("停班按钮: 连得上只在跑才能点; 连不上仍能点 (外壳直接写停班标记), 说明写在下面 (#294 用户点了停止游戏还开着)", () => {
  const run = (o: Partial<{ running: boolean; stopping: boolean }>) => ({ id: "2026-11-04T10-25-09", running: false, stopping: false, ...o });
  assert.deepEqual(stopButton(true, run({ running: true })), { disabled: false, label: "停班 (存档收尾)", note: "会先问你确认。直接关掉这个界面也等于停班" });
  assert.equal(stopButton(true, run({ running: true, stopping: true })).disabled, true);
  assert.equal(stopButton(true, run({ running: true, stopping: true })).label, "正在收尾…");
  assert.deepEqual(stopButton(true, run({})), { disabled: true, label: "停班 (存档收尾)", note: "没有在跑的一班" });
  assert.equal(stopButton(true, null).disabled, true, "还没有班次");
  const down = stopButton(false, null);
  assert.equal(down.disabled, false, "连不上也能点 (state 可能还是空的)");
  assert.match(down.note, /连不上控制接口.*直接写停班标记.*关掉游戏窗口也等于停班/);
  assert.equal(stopButton(false, run({ running: true, stopping: true })).disabled, false, "连不上时不信旧状态");
});

test("连不上控制接口时的提示: 浏览器里提示手动起; 界面起过就说它在干什么, 退出了 / 起不来给重试", () => {
  const p = (o: Partial<ControlProc>): ControlProc => ({ started: false, running: false, exit: null, error: null, log: "C:/tmp/factorio-pilot-control.log", ...o });
  assert.deepEqual(downBanner("fetch failed", null, "127.0.0.1:4330"), { text: "连不上控制接口 127.0.0.1:4330: 先在仓库目录运行 npm run play:control (fetch failed)", retry: false });
  assert.deepEqual(downBanner("x", p({ started: true, running: true }), "b"), { text: "界面正在起控制接口… (第一次要几秒)", retry: false });
  assert.match(downBanner("x", p({ started: true, exit: "退出码 1" }), "b").text, /退出了 \(退出码 1\); 它的输出在 C:\/tmp/);
  assert.equal(downBanner("x", p({ error: "找不到仓库目录" }), "b").retry, true);
  assert.equal(downBanner("x", p({}), "b").retry, true, "打开时别人起的, 后来停了");
});

test("聊天室: 模型名 / 账号 → 厂商 (头像 LOGO); 一段话从哪开始 (换人、你说的、停 3 分钟)", () => {
  assert.deepEqual(["Claude Opus 5.5", "claude-sonnet-5-5", "Grok 4.7", "GPT-5.5", "codex", "o4-mini", "DeepSeek V4", "GLM-5.3", "glm", "zhipu", "Llama", undefined].map(vendorOf),
    ["claude", "claude", "grok", "openai", "openai", "openai", "deepseek", "glm", "glm", "glm", null, null]);
  const at = (m: number) => new Date(Date.parse("2026-11-03T12:00:00Z") + m * 60_000).toISOString();
  const items: Item[] = [
    { type: "say", agent: "a", text: "1", at: at(0) },
    { type: "steps", agent: "a", steps: [], at: at(1) },
    { type: "say", agent: "b", text: "2", at: at(1) },
    { type: "you", agent: "b", text: "3", at: at(2), status: "已送到" },
    { type: "you-cmd", agent: "a", args: "call status", at: at(2), pending: false },
    { type: "say", agent: "b", text: "4", at: at(3) },
    { type: "say", agent: "b", text: "5", at: at(7) },
    { type: "say", agent: "b", text: "6" },
  ];
  assert.deepEqual(speakerStarts(items), [true, false, true, true, false, true, true, false]);
});

test("中断了的班 (没收尾、30 分钟没新记录): 顶上写中断了和最后一次记录的时间", () => {
  const s: State = { run: { id: "2026-11-03T11-17-28", running: false, stopping: false, interrupted: true, lastAt: Date.parse("2026-11-03T11:37:17Z") } };
  const b = runBanner(s, Date.now())!;
  assert.equal(b.tone, "warn");
  assert.match(b.text, /^最近一班 \(11月3日 \d\d:17 开班\) 中断了: 没存档收尾, 最后一次记录在 11月3日 \d\d:37 · 下面是它的记录$/);
});

test("看哪一班: 打开时在跑就看它、没在跑就空对话; 开了新班从空对话或上一班跳过去, 自己选的旧班不动", () => {
  const L = (id: string, running: boolean) => ({ id, running });
  assert.equal(nextViewRun(undefined, L("r2", true), null), "r2");
  assert.equal(nextViewRun(undefined, L("r2", false), null), null, "没在跑 → 空对话");
  assert.equal(nextViewRun(undefined, null, null), null, "还没有任何一班");
  assert.equal(nextViewRun(null, L("r3", true), "r2"), "r3", "空对话时开了新班");
  assert.equal(nextViewRun("r2", L("r3", true), "r2"), "r3", "在看的那班收尾了、开了下一班");
  assert.equal(nextViewRun("r1", L("r3", true), "r2"), "r1", "自己选的更早的班");
  assert.equal(nextViewRun("r2", L("r2", false), "r2"), "r2", "在看的那班收尾了: 留着看");
  assert.equal(runBriefStatus({ running: false, interrupted: true }), "中断了");
  const s: State = { run: { id: "2026-11-03T11-17-28", running: false, stopping: false, interrupted: true } };
  assert.match(landingBanner(s)!.text, /^没有在跑 · 上一班 \(11月3日 \d\d:17, 中断了\) 的记录$/);
  assert.equal(landingBanner({ run: null }), null);
});

test("填密钥的两家 (DeepSeek / GLM): 状态、余额、左下角", () => {
  const k: Account = { id: "deepseek", label: "DeepSeek", short: "DeepSeek", kind: "key", installed: true, version: null, signedIn: false, plan: null, usage: [], balance: null,
    usageWhy: null, login: "", install: "", keyTail: null, keyUrl: "https://platform.deepseek.com/api_keys" };
  const ds: Account = { ...k, keyTail: "a1b2", signedIn: true, balance: { currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00", enough: true } };
  const glm: Account = { ...k, id: "glm", label: "GLM 编程套餐", short: "GLM", keyTail: "zz99", signedIn: true, plan: "智谱 (国内)", usage: [{ label: "5 小时", used: 23, resetsAt: null }] };
  assert.deepEqual([accountStatus(k), accountStatus(ds), accountStatus(glm), accountStatus({ ...glm, signedIn: false }), accountStatus({ ...glm, signedIn: null })],
    ["没填密钥", "密钥可用", "密钥可用 · 智谱 (国内)", "密钥不对", "已填密钥 · 没查成"]);
  assert.equal(fmtBalance({ currency: "USD", total: "1.50", granted: "0", toppedUp: "1.50", enough: true }), "$1.50");
  assert.equal(accountsLine([k, ds, glm, { ...glm, signedIn: false }]), "DeepSeek 没填 · DeepSeek ¥110.00 · GLM 剩 77% · GLM 密钥不对");
});

test("中转站的模型分组: 没核实时按站里标的格式 (anthropic 能直接用); 核实过按结果 通 / 没通 (带原因) / 没核实; 余额不限额照写", () => {
  // 11-04 晚按站标的协议分四类 (站长 "去模型广场看看这些模型都是什么协议的"): anthropic / responses (走 Codex) / chat (站转格式) / unusable (图片视频, 不核不列)
  const models = [{ id: "glm-5.3", formats: ["openai", "anthropic"] }, { id: "grok-4.7", formats: ["openai"] }, { id: "x", formats: [] }, { id: "gpt-6.1-terra", formats: ["openai", "openai-response"] }, { id: "gpt-image-2", formats: ["image-generation"] }];
  const g = relayModelGroups(models);
  assert.deepEqual([g.native.map((m) => m.id), g.responses.map((m) => m.id), g.chat.map((m) => m.id), g.unusable.map((m) => m.id), g.verifiedAny, g.unverified.length], [["glm-5.3", "x"], ["gpt-6.1-terra"], ["grok-4.7"], ["gpt-image-2"], false, 4]);
  assert.deepEqual(relayModelGroups(undefined), { native: [], responses: [], chat: [], unusable: [], ok: [], failed: [], unverified: [], verifiedAny: false });
  const v = relayModelGroups(models, { "glm-5.3": { ok: true, ms: 900, text: "收到", at: "t" }, "grok-4.7": { ok: false, ms: 5, text: "API Error: 400 metadata", at: "t" } });
  assert.deepEqual([v.ok.map((m) => m.id), v.failed.map((m) => `${m.id}:${m.why}`), v.unverified.map((m) => m.id), v.verifiedAny], [["glm-5.3"], ["grok-4.7:API Error: 400 metadata"], ["x", "gpt-6.1-terra"], true]);
  assert.equal(verifyLine({ running: true, total: 5, done: 2, current: "kimi-k3", startedAt: "t", finishedAt: null, results: {} }), "正在核实 2/5 · kimi-k3");
  assert.equal(verifyLine({ running: false, total: 2, done: 2, current: null, startedAt: "t", finishedAt: "t2", results: { a: { ok: true, ms: 1, text: "", at: "" }, b: { ok: false, ms: 1, text: "", at: "" } } }), "核实完: 1 通 / 1 没通");
  assert.equal(fmtBalance({ currency: "USD", total: "不限额", granted: "", toppedUp: "", enough: true }), "不限额");
});

test("下一班阵容: 下拉按来源分组, 没登录 / 没填的灰掉, 中转站列这个令牌能用的模型; 值 家:模型 来回转", () => {
  const base = { label: "", installed: true, version: null, plan: null, usage: [], usageWhy: null, login: "", install: "" };
  const claude = { ...base, id: "claude", short: "Claude", signedIn: true } as Account;
  const grok = { ...base, id: "grok", short: "Grok", installed: false, signedIn: false } as Account;
  const relay = { ...base, id: "relay", short: "中转", kind: "key", keyTail: "0Dni", signedIn: true, models: [{ id: "glm-5.3", formats: ["anthropic"] }, { id: "grok-4.7", formats: ["openai"] }] } as Account;
  const codex = { ...base, id: "codex", short: "GPT", signedIn: true, model: "gpt-6.1-sol" } as Account;
  const groups = lineupOptions([claude, grok, relay, codex]);
  assert.deepEqual(groups.map((g) => g.label), ["Claude (官方订阅, Claude Code)", "Claude (Console API 密钥, Agent SDK)", "GPT (官方订阅, Codex)", "Gemini (官方, Antigravity CLI)", "Grok Build", "DeepSeek (官方)", "中转站 · Claude 格式 (Claude Code 直接用; 账号页可核实)", "中转站 · 只有 Chat 协议 (Claude Code 由站转格式)", "测试"]);
  // Claude 第二条路: 同样几档, 值 claude-api:<id>; 没填密钥灰掉
  assert.deepEqual(groups[1].items.map((o) => o.value), ["claude-api:claude-fable-5-1", "claude-api:claude-opus-5-5", "claude-api:claude-sonnet-5-5", "claude-api:claude-haiku-5-5"]);
  const anthNoKey = { ...base, id: "anthropic", short: "Claude API", kind: "key", keyTail: null, signedIn: false } as Account;
  assert.deepEqual(lineupOptions([claude, anthNoKey])[1].items[1], { value: "claude-api:claude-opus-5-5", label: "Claude Opus 5.5 (没填密钥)", disabled: true });
  assert.deepEqual([seatDisplay({ brain: "claude-api", model: "claude-opus-5-5" }), seatWord({ brain: "claude-api", model: "claude-opus-5-5" })], ["Claude Opus 5.5", "Claude-Opus-5.5"], "游戏里和订阅的 Claude 叫法一样");
  // 站标的协议分三类 (11-04 晚站长 "去模型广场看看这些模型都是什么协议的"): Responses (gpt / 站里的 grok) 开班走 Codex; 图片 / 视频不列
  const gptRelay = { ...relay, models: [{ id: "gpt-6.1-terra", formats: ["openai", "openai-response"] }, { id: "MiniMax-M3.1-Flash", formats: ["openai"] }, { id: "gpt-image-2", formats: ["image-generation"] }] } as Account;
  assert.deepEqual(lineupOptions([claude, gptRelay]).filter((g) => g.label.startsWith("中转站")).map((g) => [g.label, g.items.map((o) => o.value)]),
    [["中转站 · Responses 协议 (开班走 Codex 指向站)", ["relay:gpt-6.1-terra"]], ["中转站 · 只有 Chat 协议 (Claude Code 由站转格式)", ["relay:MiniMax-M3.1-Flash"]]]);
  assert.deepEqual([relayKind(["openai-response", "openai", "anthropic"]), relayKind(["openai", "openai-response"]), relayKind(["openai"]), relayKind(["image-generation"])], ["anthropic", "responses", "chat", "unusable"]);
  assert.deepEqual(groups[0].items.map((o) => o.value), ["claude:claude-fable-5-1", "claude:claude-opus-5-5", "claude:claude-sonnet-5-5", "claude:claude-haiku-5-5"], "Claude 列官方档位");
  assert.deepEqual(groups[2].items, [{ value: "codex:gpt-6.1-sol", label: "gpt-6.1-sol (Codex 配置里的默认模型)", disabled: false }], "GPT 列 Codex 配置里的模型");
  assert.deepEqual(groups[3].items, [{ value: "gemini", label: "Antigravity 默认模型", disabled: false }], "Gemini: 账号列表里没有它就能选");
  const agyMissing = { ...base, id: "gemini", short: "Gemini", installed: false, signedIn: null } as Account;
  assert.deepEqual(lineupOptions([claude, agyMissing])[3].items, [{ value: "gemini", label: "Antigravity 默认模型 (没装 agy)", disabled: true }], "Gemini: 没装 agy 灰掉");
  assert.deepEqual(lineupOptions([claude, { ...agyMissing, installed: true, signedIn: false }])[3].items[0].disabled, true, "没登录灰掉");
  const agyOn = { ...agyMissing, installed: true, signedIn: true, modelList: [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" }] } as Account;
  assert.deepEqual(lineupOptions([claude, agyOn])[3].items, [{ value: "gemini:gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High) (gemini-3.8-flash-high)", disabled: false }, { value: "gemini:claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking) (claude-opus-4-6-thinking)", disabled: false }], "登了就列 agy models 给的模型 (1.5.0 实测)");
  assert.deepEqual(groups[4].items, [{ value: "grok:grok-4.7", label: "grok-4.7 (没登录)", disabled: true }]);
  assert.deepEqual(groups[6].items, [{ value: "relay:glm-5.3", label: "glm-5.3" }]);
  assert.deepEqual([seatDisplay({ brain: "gemini", model: "" }), seatDisplay({ brain: "gemini", model: "gemini-3.5-pro" }), seatWord({ brain: "gemini", model: "" })], ["Gemini (Antigravity)", "Gemini-3.5-Pro", "Gemini"]);
  assert.equal(groups[0].items[0].disabled, false, "登了的 Claude 能选");
  const verified = { ...relay, verified: { "glm-5.3": { ok: true, ms: 1, text: "收到", at: "t" }, "grok-4.7": { ok: false, ms: 1, text: "400 metadata", at: "t" } } } as Account;
  assert.deepEqual(lineupOptions([claude, verified]).filter((g) => g.label.startsWith("中转站")).map((g) => [g.label, g.items.map((o) => `${o.value}${o.disabled ? "!" : ""}`)]),
    [["中转站 · 核实能用 (1)", ["relay:glm-5.3"]], ["中转站 · 没通 (1)", ["relay:grok-4.7!"]]], "核实过就按结果分, 没通的灰掉");
  assert.deepEqual(lineupOptions([claude, grok, { ...relay, signedIn: false, models: [] }]).find((g) => g.label === "中转站")?.items[0], { value: "relay", label: "令牌还没查成", disabled: true });
  assert.deepEqual(lineupOptions(null)[0].items[0], { value: "claude:claude-fable-5-1", label: "Claude Fable 5.1", disabled: false }, "还没读到账号时都能选");
  assert.deepEqual(parseSeatValue("relay:glm-5.3"), { brain: "relay", model: "glm-5.3" });
  assert.deepEqual(parseSeatValue("none"), { brain: "none", model: "" });
  assert.equal(seatValue({ brain: "deepseek", model: "deepseek-v4-pro" }), "deepseek:deepseek-v4-pro");
  assert.equal(seatValue({ brain: "none", model: "" }), "none");
  assert.equal(seatValue({ brain: "claude", model: "opus" }), "claude:claude-opus-5-5", "旧别名对到官方档位的 id, 旧 lineup.json 在新下拉里选得中");
  assert.deepEqual([seatDisplay({ brain: "claude", model: "claude-opus-5-5" }), seatDisplay({ brain: "claude", model: "opus" }), seatDisplay({ brain: "codex", model: "gpt-6.1-sol" }), seatWord({ brain: "claude", model: "claude-fable-5-1" })], ["Claude Opus 5.5", "Claude Opus", "Gpt-6.1-Sol", "Claude-Fable-5.1"]);
  assert.deepEqual([effortLabel("high"), effortLabel(undefined), effortLabel("odd")], ["高", "默认", "odd"]);
  // 群成员列表里的名字 和拉人下拉的默认
  assert.deepEqual([{ brain: "relay", model: "glm-5.3" }, { brain: "claude", model: "opus" }, { brain: "claude", model: "sonnet" }, { brain: "deepseek", model: "deepseek-v4-pro" }, { brain: "none", model: "" }, { brain: "relay", model: "MiniMax-M3.1-Flash" }].map(seatDisplay),
    ["Glm-5.3", "Claude Opus", "Claude Sonnet", "Deepseek-V4-Pro", "测试班 (不叫大脑)", "MiniMax-M3.1-Flash"], "不标中转 / DeepSeek, 首字母大写");
  assert.equal(defaultInvite(groups), "relay:glm-5.3", "中转站有能直接用的就默认它");
  assert.equal(defaultInvite(lineupOptions(null)), "claude:opus");
});

test("左下角账号卡只说几家能用; 右栏额度每家一行 (窗口 → 剩百分比和条, 余额 → 余额, 其余 → 状态); / 命令清单不含起停服务器类", () => {
  const base = { label: "", installed: true, version: null, plan: null, usage: [], usageWhy: null, login: "", install: "" };
  const claude = { ...base, id: "claude", short: "Claude", signedIn: true, usage: [{ label: "7 天窗口", used: 49, resetsAt: new Date(Date.now() + 3.7 * 86_400_000).toISOString() }] } as Account;
  const grok = { ...base, id: "grok", short: "Grok", installed: false, signedIn: null } as Account;
  const ds = { ...base, id: "deepseek", short: "DeepSeek", kind: "key", keyTail: "ab12", signedIn: true, balance: { currency: "CNY", total: "50.00", granted: "0", toppedUp: "50.00", enough: true } } as Account;
  const glm = { ...base, id: "glm", short: "GLM", kind: "key", keyTail: null, signedIn: null } as Account;
  assert.equal(accountsBrief(null), null);
  assert.equal(accountsBrief([grok, glm]), "还没有能用的账号");
  assert.equal(accountsBrief([claude, grok, ds, glm]), "2 家能用: Claude、DeepSeek");
  const now = Date.now();
  const c = accountQuota(claude, now);
  assert.equal(c.value, "剩 51%"); assert.equal(c.remain, 0.51); assert.match(c.detail, /^7 天窗口已用 49%, 3\.7 天后重置$/);
  const d = accountQuota(ds, now);
  assert.equal(d.value, "余额 ¥50.00"); assert.equal(d.remain, null); assert.equal(d.detail, "按用量扣费");
  assert.deepEqual([accountQuota(grok, now).value, accountQuota(grok, now).detail], ["—", "本机没装"]);
  assert.deepEqual([accountQuota(glm, now).value, accountQuota(glm, now).detail], ["—", "没填密钥"]);
  const blocked = ["start", "connect", "stop-session", "install", "deploy", "run", "stream"];
  assert.ok(SLASH_COMMANDS.length >= 12);
  for (const c of SLASH_COMMANDS) { assert.ok(!blocked.includes(c.cmd.split(" ")[0]), c.cmd); assert.ok(c.what.length > 3, c.cmd); }
  assert.equal(new Set(SLASH_COMMANDS.map((c) => c.cmd)).size, SLASH_COMMANDS.length);
  // 来源 · 致谢: 每条都有出处、许可、链接; 派对的 ./fh 必须在里面
  assert.ok(SOURCES.length >= 6);
  for (const s of SOURCES) { assert.ok(s.what && s.from && s.license && s.where, s.what); assert.match(s.url, /^https:\/\//); }
  assert.ok(SOURCES.some((s) => s.url.includes("nwinter/factorio-ai-party") && s.what.includes("/ 命令")));
});
