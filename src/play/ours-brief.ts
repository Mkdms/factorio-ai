// 简报最前面"先读这一节" (库, 不直接运行): 原来 3782 字, 写满打法、典故和用户原话, 大脑照样不做;
// 派对的简报只写事实 (site/content/how/agents.md "Facts only": 连里程碑清单都删了, "it narrows what agents think of")。
// 这里只留: 世界是什么、用户定的规矩、有哪些工具。打法在手册 pilot-* 和做动作时自动带出的教训里。
// 世界是不是和平要按真实设置写, 不写死: 2026-11-05 这里写着"和平模式, 不研究军事类科技", 模型在聊天说"按规矩不研究军事科技"
/** 用户定的规矩 (两条路的简报都放: 不装模组那条路 core/run/online.ts 2026-11-08 起也放, 原来没有) */
export const USER_RULES = `**用户定的规矩**:
1. 一条道一种料; 一条道混了几种料尽头才要出口, 不混的话带子满着就是等下游, 不用接箱子吞料。带子和管道能直就直, 前方没挡就不拐弯, 地下管道只在要穿过东西时用。电线杆横平竖直, 沿带子和产线边走, 不斜穿空地把整块地切碎。建造位置附近的树和石头先拆, 范围留大些, 别等挡住了再砍。
2. 建造和升级按已研究的最高档; 料供不上或没用才用次一档。
3. 手搬只用于开局和应急; 例行运输接成带子, 燃料走煤带。
4. 先修会拖垮全局的 (电、燃料、堵死的带子), 再扩。
5. 材料先自给: 查库存 → 取 → 造 → 采, 还不够再找人要。
6. 修、建、改不用问, 队友认领的区域也一样, 做完告诉他。真人或别的团队已经建好的基地: 拆东西、在里面建整条线、大量用稀缺共享资源要先问。
7. 研究只排场上产得出瓶子的。
`;

export function oursBrief(o: { resume: boolean; multi: boolean; peaceful: boolean; /** 有敌人的世界开班先留的和平还剩几分钟 (src/play/peace.ts) */ peaceMinutes?: number; /** 真人用户在游戏里的名字; 他只看和说话, 没有身体 */ human?: string }): string {
  const shared = o.multi ? "../team-tools/" : "team-tools/";
  const world = o.peaceful ? "这个世界现在开着和平模式 (敌人不主动打)。这只是这个世界的设置, 别的世界不一定"
    : o.peaceMinutes ? `这个世界有敌人, 污染碰到它们的基地就会来打; 现在还开着和平, 这一班开始后 ${o.peaceMinutes} 分钟自动关, 之后虫子真的来打`
    : "这个世界有敌人, 污染碰到它们的基地就会来打";
  return `## 先读这一节 (本机沙盘)

- **世界**: 太空时代; ${world}。敌人、污染、进化度看 \`./fh call status\`, 防御和军事科技跟别的事一样, 按局势和目标自己定。${o.resume ? "这是玩到一半的世界: 先 `./fh call map`、`status`、`bottleneck` 摸清现状, 读 notes.md 和队友的笔记。" : "新地图, 从零开始。"}${o.human ? `
- **真人**: 用户在游戏里叫 \`${o.human}\`, 只看和说话, 没有身体, 不算队员。` : ""}
- **语言**: 说话、笔记、聊天都用简体中文; 建筑物品科技用官方中文名 (\`ref/names.tsv\`), 命令里写内部名。

${USER_RULES}
**工具**:
- \`./plan 物品 每分钟 [--near x,y]\`: 要建线就跑它。算全链、减掉场上已有、挑实测过的蓝图、找空地、查背包缺什么, 给你能直接跑的 \`./bp build\`。
- \`./know 关键词\`: 查全部积累 (老玩家思路、核实过的事实、教训、检索资料; 官方名或内部名都行)。放机器时回复会自动附算好的配比、相关经验和真实基地的摆法。
- \`./bp study 物品 [第几段] [--image] [--community]\`: 看真实基地这条线怎么摆 (字符图 + 读数; --image 用蓝图编辑器出真图, Read 打开)。自己设计的蓝图: \`./bp view 文件\` 出图, \`./bp check 文件\` 查错, \`./bp build 文件 --at x,y\` 建。
- \`./calc '{"targets":{"automation-science-pack":30}}'\`: 只算配比。\`./bp list 关键词\` / \`show 编号\` / \`view 编号\`: 蓝图库。打法查 \`./fh help pilot-production\`、\`pilot-progression\`、\`pilot-logistics-choice\`、\`pilot-layout-styles\`、\`pilot-facts\`。
- \`tools/\` 是你自己的, \`${shared}\` 全队共享: 脚本、计算器、规划器, 想要什么自己写, 下一班还在。Python 3 能用: \`python tools/x.py\`, 里面 \`from fhlib import fh, call, gamedata\` 调游戏和读游戏数据 (共享目录的脚本先 \`import sys; sys.path.insert(0, "${shared.slice(0, -1)}")\`)。
- 能上网查 wiki 和计算器 (WebSearch、WebFetch)。只有 \`./fh\` 能动游戏。
`;
}

/** 90 分钟问一次 (派对 how/operations.md: "what harness change would help you most?", 633 条诉求里修出了大半个 harness; 我们一条都没收过) */
export const TOOL_POLL = "监工 (不打断手上的活): 工具上最想要什么改动? 一两条就行: 想要什么命令 / 读数 / 提醒, 解决什么问题, 这班碰到几次。回 ./fh call operator --args '{\"text\":\"工具诉求: …\"}', 没有就不用回。";

/** 从大脑的 journal 里捞工具诉求 (一行一个请求, 班末写进 tool-requests.md 给工程师看) */
export function toolRequests(journalText: string): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  for (const line of journalText.split(/\r?\n/)) {
    if (!line.includes("工具诉求")) continue;
    let e: { at?: string; event?: string; request?: { action?: string; args?: { text?: unknown } } };
    try { e = JSON.parse(line); } catch { continue; }
    const t = e.request?.args?.text;
    if (e.event === "request" && e.request?.action === "operator" && typeof t === "string" && t.startsWith("工具诉求")) out.push({ at: e.at ?? "", text: t });
  }
  return out;
}
