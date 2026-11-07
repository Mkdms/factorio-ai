// 界面的数据转换 (纯函数, 不碰 DOM / 网络): 控制接口 (src/play/control.ts) 的回复 → 三栏要显示的东西。
// 单元测试在仓库 test/app-logic.test.ts (npm test 一起跑); 这里只用能被 Node 直接去类型运行的写法 (不用 enum / namespace)。

/** /api/brain?detail=1 的一行 (src/play/control-lib.ts BrainLineDetail) */
export type Line = { kind: "说" | "命令" | "结果"; text: string; at?: string; desc?: string; error?: boolean };
/** name = 游戏里的名字 (用户自己建的角色名 / bot 名); model = 大脑模型显示名 ("Claude Opus 5.5", 控制接口 2026-11-03 起给) */
export type Agent = { id: string; name: string; busy: boolean | null; /** 大脑这一轮还在跑 (想或等命令; 2026-11-05 起的班才有) */ thinking?: boolean | null; last: Line | null; model?: string; /** 多少秒没发过命令 (2026-11-05 加) */ quietS?: number; /** 中途被移出 (界面"移出"; 2026-11-05) */ left?: boolean; /** 阵容里的那一席 (2026-11-05 起的班才有) */ seat?: { brain: string; model: string }; /** 服务器角色的名字; 没有 = 玩家的身体 (老班, 或联机控制用户账号的) */ bot?: string };
export type Game = {
  tick: number; gameMinutes: number; researched?: number; research?: string; labs?: number; labsWorking?: number; machines?: number;
  busy?: Record<string, boolean>; perMin10?: { red: number; green: number; blue: number }; at?: number;
};
/** interrupted = 没收尾、30 分钟以上没新记录 (进程被结束了); lastAt = 最后一次记录 (毫秒) */
export type Run = { id: string; dir?: string; running: boolean; stopping: boolean; interrupted?: boolean; lastAt?: number | null; /** 这一班支持中途加人 / 移出 (2026-11-05 起开的班) */ rosterLive?: boolean };
export type Quota = { text: string; utilization: number | null; why?: string | null };
/** world = 这一班属于哪个世界; latest = 最新一班 (界面判断开了新班要不要跳过去) —— 控制接口 2026-11-03 起给 */
/** 这一班大脑看过 / 用过的一张蓝图 (GET /api/blueprints); link = 本机蓝图编辑器的预览链接 */
export type ShiftBlueprint = { no: number; label: string; source: string; w: number; h: number; cmd: string; at: string; agent: string; link: string | null };
/** 看门狗 / 死亡现状 (控制接口 2026-11-04 起给, 旧班 null): 停机秒数和占比、恢复次数、掉线中、最近一次恢复、本班死亡次数、自动排研究次数 */
export type Watchdog = { at: string; recoveries: number; failed: number; downtimeS: number; downtimeShare: number; down: boolean; downS: number;
  last: { at: string; reason: string; save?: string | null; saveAgeS?: number | null; ok: boolean; downS: number } | null; deaths: number; deathsTotal: number; lastDeathAt: string | null; autoResearch: number; /** 开班和平还剩多少秒 (2026-11-05 加) */ peaceLeftS?: number };
export type State = { run: Run | null; agents?: Agent[]; game?: Game | null; health?: string[]; quota?: Quota; review?: { lines: string[]; fixes: string[] } | null;
  world?: { id: string; name: string }; latest?: { id: string; running: boolean } | null; watchdog?: Watchdog | null; alerts?: Alert[]; replies?: ReplyStatus[] };
/** 你说的话谁回了谁没回 (控制接口 /api/state.replies) */
export type ReplyStatus = { at: string; text: string; scope: string; total: number; replied: string[]; waiting: string[] };
/** 你说的那句下面显示的一行: 送达了几个, 谁回了, 谁还在忙。对不上 (界面重开、老班) 就 null */
export function replyLine(text: string, at: string, replies: ReplyStatus[] | undefined): string | null {
  const t = Date.parse(at);
  const r = (replies ?? []).find((x) => x.text === text && Math.abs(Date.parse(x.at) - t) < 60_000);
  if (!r) return null;
  const parts = [r.total > 1 ? `已送达 ${r.total} 个` : "已送达"];
  if (r.replied.length) parts.push(`已回: ${r.replied.join("、")}`);
  if (r.waiting.length) parts.push(r.replied.length ? `还在忙: ${r.waiting.join("、")}` : "还在忙, 手上的事做完就回");
  return parts.join(" · ");
}
/** 多少秒没发命令 → 成员行的小字; 不到 1 分钟不显示 */
export function quietLabel(s: number | undefined): string | null {
  if (s === undefined || s < 60) return null;
  return `${Math.floor(s / 60)} 分钟没动静`;
}
/** 命令的等待被队友或管理员的消息打断 (退出码 3): 动作还在继续, 不是失败 */
export const isWaitInterrupted = (result: string) => /Exit code 3\b|ended this wait/.test(result);
/** 大脑接口警报 (控制接口 /api/state.alerts): kind probe = 开班前试通失败, api = 某一轮 Claude Code 回了 API 错误, tool = 大脑说工具坏了 / 缺工具 */
export type Alert = { at: string; agent: string; name: string; brain: string; model: string; kind: "probe" | "api" | "tool"; text: string };
export const alertKey = (a: Alert) => `${a.at}|${a.agent}`;
/** 还没看过的警报 (seen = 看过的 key) */
export const newAlerts = (alerts: Alert[] | undefined, seen: string[]): Alert[] => (alerts ?? []).filter((a) => !seen.includes(alertKey(a)));
/** 弹窗里一条怎么写 */
export function alertLine(a: Alert): { title: string; detail: string } {
  const who = `${prettyModel(a.model) || a.brain}${a.name ? ` (游戏里 ${a.name})` : ""}`;
  const via = a.brain === "relay" ? "走中转站" : a.brain === "deepseek" ? "走 DeepSeek 官方接口" : a.brain === "claude" ? "Claude 订阅" : a.brain;
  if (a.kind === "tool") return { title: `${who} 说工具有问题`, detail: a.text };
  return { title: `${who} ${a.kind === "probe" ? "开班试通失败" : "调用报错"} (${via})`, detail: a.text };
}

/** 右栏"看门狗"卡的几行: 停机、恢复、死亡、自动排研究 */
export function watchdogLines(w: Watchdog | null | undefined): string[] {
  if (!w) return [];
  const out: string[] = [];
  if (w.peaceLeftS && w.peaceLeftS > 0) out.push(`和平还剩 ${Math.ceil(w.peaceLeftS / 60)} 分钟, 到点自动关, 虫子开始打`);
  out.push(`停机 ${w.downtimeS} 秒 (${fmtPct(w.downtimeShare)})${w.down ? ` · 现在掉线 ${w.downS} 秒` : ""}`);
  const last = w.last;
  out.push(`恢复 ${w.recoveries} 次${w.failed ? ` (失败 ${w.failed})` : ""}${last ? ` · 最近 ${fmtDay(new Date(last.at))} ${last.reason} → ${last.ok ? (last.save ?? "开班存档") : "重启失败"}` : ""}`);
  out.push(`死亡 ${w.deaths} 次${w.lastDeathAt ? ` (最近 ${fmtDay(new Date(w.lastDeathAt))})` : ""}${w.deathsTotal > w.deaths ? ` · 这个世界累计 ${w.deathsTotal}` : ""}`);
  out.push(`自动排研究 ${w.autoResearch} 次`);
  return out;
}
/** GET /api/worlds 的一个世界和它的班次 (新的在前) */
export type RunBrief = { id: string; label: string; running: boolean; ended: boolean; interrupted: boolean; hidden: boolean; lastAt: number | null };
/** GET /api/stats (src/play/stats.ts): 每个模型的汇总和排行 */
export type ModelStat = {
  model: string; vendor: string; shifts: number; agentShifts: number; realHours: number;
  scienceAvg: number | null; gainPerHour: number | null;
  builds: number; buildsPerHour: number; requests: number; readShare: number | null; fails: number;
  costUsd: number | null; costPerHour: number | null; idleShare: number | null;
  /** 用了几次我们的计算器 / 蓝图库 / 经验; lessons = 回复里自动带出教训的次数 (2026-11-05 加, 旧控制接口没有) */
  calc: number; bp: number; plan?: number; python?: number; knowledge: number; lessons?: number;
};
/** 每班每角色一行 */
export type ShiftAgentStat = {
  run: string; world: string; worldName: string; agent: string; model: string | null; vendor: string;
  turns: number; requests: number; reads: number; builds: number; fails: number; costUsd: number | null;
  realMinutes: number; gameMinutes: number | null; science: number | null; scienceGain: number | null; idleShare: number | null;
  calc: number; bp: number; plan?: number; python?: number; knowledge: number; lessons?: number;
};
/** 排行里的数字: null → "—"; 带符号的增量 */
export const fmtNum = (x: number | null | undefined, d = 1): string => (x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(d));
export const fmtSigned = (x: number | null | undefined, d = 1): string => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(d)}`);
export type WorldInfo = { id: string; name: string; kind: string; /** 用户改过标题 (旧记录组默认名很长, 没改时界面只写"旧记录") */ renamed?: boolean; runs: RunBrief[]; /** 是界面建的群 (可能还没开过班) */ group?: boolean };
/** 联机服务器走哪条路 (规矩在 src/io/backend.ts) */
export type BackendPref = "auto" | "memory" | "rcon";
export const BACKEND_OPTIONS: { value: BackendPref; label: string; note: string }[] = [
  { value: "auto", label: "自动", note: "没填 RCON 或服务器没装我们的模组就走内存外挂; 都有才走 RCON" },
  { value: "memory", label: "内存外挂", note: "服务器什么都不用装, 游戏里不跑代码" },
  { value: "rcon", label: "RCON + 模组", note: "服务器要开 RCON 并装我们的模组; 功能最全, 但会跑 Lua 命令, 这张图不能再拿成就" },
];
/** 群 = 对话 = 世界 (控制接口 /api/groups): kind new 新地图 / save 接着存档 / server 联机 (能只读连接, 真模型的班还开不了); server 从 keys.json 读, 密码只说有没有 */
/** 沙盘的群走哪条路: memory = 不装模组 (算成就, 和联机同一条路), mods = 装模组 + RCON 全性能 (后期不要成就时) */
export type GroupRoute = "memory" | "mods";
export const routeLabel = (r: GroupRoute | undefined): string => (r === "mods" ? "装模组全性能 (不算成就)" : "不装模组 (算成就)");
export const ROUTE_OPTIONS: { value: GroupRoute; label: string; note: string }[] = [
  { value: "memory", label: "不装模组 (算成就)", note: "读内存 + 像玩家一样操作, 每个动作真人速度; 和联机服务器同一条路, 这张图能拿成就。一班一个角色。" },
  { value: "mods", label: "装模组全性能 (不算成就)", note: "沙盘装模组 + RCON, 贴蓝图瞬间建好, 能多角色; 这张图不算成就。后期不要成就时用。" },
];
export type Group = { id: string; name: string; createdAt: string; kind: "new" | "save" | "server" | "mine"; /** 沙盘群走哪条路; 没写 = memory */ route?: GroupRoute; /** 我的账号: 这一局要模型做什么 */ goal?: string; /** false = 关和平, 虫子真的来打 */ peaceful?: boolean; /** 有虫子时开班先留几分钟和平 */ peacefulMinutes?: number; save?: string; server?: { address: string; hasPassword: boolean; rcon: string | null } | null; /** 联机服务器走哪条路; 没写 = 自动 */ backend?: BackendPref; /** 联机服务器: 没探过的区块也读 (默认关) */ revealUncharted?: boolean; seats: RosterSeat[]; minutes: number };
/** 新建对话填的 (地址和密码存 keys.json, 不进群文件) */
export type NewGroupInput = { name: string; kind: Group["kind"]; route?: GroupRoute; save?: string; server?: { address: string; password?: string; rcon?: { address: string; password: string } }; minutes?: number; revealUncharted?: boolean; backend?: BackendPref; goal?: string };
export const groupKindLabel = (k: Group["kind"]): string => (k === "new" ? "新地图" : k === "save" ? "接着存档" : k === "mine" ? "我的账号" : "联机服务器");
/** 用模型玩用户账号的状态 (GET /api/mk, src/play/mk-lib.ts mkView) */
export type MkState = { current: { runId: string; group?: string; brain: string; model?: string; effort: string; minutes: number; startedAt: string; ended?: string; error?: string; result?: { before: number; after: number | null; fresh: string[] } } | null; running: boolean; stopping: boolean; lines: string[] };
/** 这个群的一局: 这一行怎么说 (别的群的局不算这个群的; 但账号只有一个, 别的群在跑时这里也开不了) */
export function mkStatusLine(mk: MkState | null | undefined, groupId: string): string | null {
  const c = mk?.current;
  if (!c) return null;
  if (mk!.running) return c.group === groupId ? (mk!.stopping ? "正在收尾: 关游戏、比成就" : `在跑: 第 1 席 ${c.brain}${c.model ? ` ${c.model}` : ""}`) : "你的账号正在别的群里玩";
  if (c.group !== groupId) return null;
  if (c.error) return `上一局没跑完: ${c.error}`;
  if (!c.ended) return "上一局被中断了, 没比成就";
  const r = c.result;
  if (!r || r.after === null) return "上一局收工了, 读不到 Steam 的成就缓存";
  return r.fresh.length ? `上一局: 成就 ${r.before} → ${r.after}, 新拿到 ${r.fresh.join("、")}` : `上一局: 成就 ${r.before} → ${r.after}, 这次没有新的`;
}
export const runBriefStatus = (r: Pick<RunBrief, "running" | "interrupted">): string => (r.running ? "在跑" : r.interrupted ? "中断了" : "收尾了");

/**
 * 看哪一班: 还没定 (undefined) → 最新一班在跑就看它, 不然空对话 (null);
 * 之后新开了一班, 正在空对话或在看上一班 (刚才的最新一班) 就跳过去; 自己选了更早的班就不动
 */
export function nextViewRun(current: string | null | undefined, latest: { id: string; running: boolean } | null | undefined, prevLatest: string | null): string | null {
  if (current === undefined) return latest?.running ? latest.id : null;
  if (latest?.running && latest.id !== current && (current === null || current === prevLatest)) return latest.id;
  return current;
}
/** 空对话时顶上那一行: 最近一班是什么时候、什么状态, 点"查看"看它的记录 */
export function landingBanner(state: State | null): { tone: "info"; text: string; runId: string } | null {
  const r = state?.run;
  if (!r) return null;
  return { tone: "info", text: `没有在跑 · 上一班 (${runLabel(r.id).replace(/ 开班$/, "")}, ${r.interrupted ? "中断了" : "收尾了"}) 的记录`, runId: r.id };
}
export type Review = { run: string; lines: string[]; fixes: string[] } | null;

/** 界面自己记的: 你说的话、你执行的命令 (控制接口不存这些; 按班存在 localStorage) */
export type Local =
  | { type: "tell"; agent: string; text: string; at: string; status: "发送中" | "已送到" | "没送到"; error?: string }
  | { type: "cmd"; agent: string; args: string; at: string; pending: boolean; out?: string; code?: number };

export type Step = { cmd: string; desc?: string; result?: string; error?: boolean; at?: string };
/** 对话流里的一项。steps = 连续的命令和结果折成一行 "干了 N 步"; ask = 大脑找操作员 (./fh call operator), 也就是"等你" */
export type Item =
  | { type: "say"; agent: string; text: string; at?: string; /** 是对你 (操作员) 说的汇报, 不是要你拍板 */ toYou?: boolean }
  | { type: "steps"; agent: string; steps: Step[]; at?: string }
  | { type: "ask"; agent: string; text: string; at?: string; answered: boolean }
  | { type: "you"; agent: string; text: string; at: string; status: "发送中" | "已送到" | "没送到"; error?: string }
  | { type: "you-cmd"; agent: string; args: string; at: string; pending: boolean; out?: string; code?: number };

/** 全队 (不是某个角色) 的对话流用这个 id */
export const TEAM = "全队";

/** 群里 @ 某个成员: "@游戏名" / "@模型名" / "@A" 只发给他, "@全队" 或没有 @ 发给所有人。
 *  ids = 点到的角色 (按出现顺序, 不重复); unknown = 没有这个成员的 @; all = 明确 @ 了全队 */
export function mentionTargets(text: string, agents: Agent[]): { ids: string[]; unknown: string[]; all: boolean } {
  const ids: string[] = [], unknown: string[] = [];
  let all = false;
  for (const m of text.matchAll(/(?:^|[\s,，、(（])@([^\s@,，:：、()（）]+)/g)) {
    const tok = m[1], low = tok.toLowerCase();
    if (/^(全队|所有人|大家|all|everyone|team)$/i.test(tok)) { all = true; continue; }
    const hit = agents.find((a) => [a.name, a.model, agentLabel(a.id), agentTitle(a.id, agents)].some((n) => n && n.toLowerCase() === low))
      ?? (() => { const pre = agents.filter((a) => [a.name, a.model].some((n) => n && n.toLowerCase().startsWith(low))); return pre.length === 1 ? pre[0] : undefined; })();
    if (!hit) unknown.push(tok);
    else if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  return { ids: all ? agents.map((a) => a.id) : ids, unknown, all };
}

const OPERATOR_ASK = /(^|[\s;&|(])\.\/fh\s+call\s+operator\b/;
/** 这条命令是大脑在找操作员 (= 找你) */
export const isOperatorAsk = (cmd: string): boolean => OPERATOR_ASK.test(cmd);

/** 从 ./fh call operator --args '{"text":"..."}' 里取出它要说的话; 取不出就给整条命令 */
export function askText(cmd: string): string {
  const quoted = /--args\s+'([^']*)'/.exec(cmd)?.[1];
  if (quoted) { try { const o = JSON.parse(quoted); if (typeof o?.text === "string") return o.text; } catch { /* 被截断了, 走下面 */ } }
  const m = /"text"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(cmd);
  if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
  return commandLabel(cmd);
}

/** 找操作员的这句话是不是真要你拍板 (问号、"批准 / 要不要 / 是否 / 请…"、列了选项) —— "收到, 我先修…" 这种汇报不算, 当普通的话显示, 不弹批准 / 不批
 *  (简报要它先回一句"收到"再干活, 所以汇报会很多) */
export function needsReply(text: string): boolean {
  const t = text.trim();
  if (!t || /^工具诉求/.test(t)) return false; // 工具诉求是给工程师看的, 不等你拍板
  if (/[?？]/.test(t)) return true;
  if (askOptions(t).length) return true;
  return /(批准|不批|可以吗|可不可以|能不能|行不行|要不要|是否|哪个|哪种|哪一|请(?!求)|指示|怎么办|同意|允许|确认一下|帮我|需要你|等你|由你|你定|你来定|决定)/.test(t) || /[吗呢](?=[\s。!！,，;；)）]|$)/.test(t);
}

/** 显示用的命令: 去掉大脑常加的 cd "<大脑目录>" && 前缀 (界面里不露本机路径) */
export const commandLabel = (cmd: string): string => cmd.replace(/^(\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, "").trim();

/** 操作员 (你) 的话转到大脑那里时, fh 回复里是 "OPERATOR: 用户: ..." (control.ts tell 加的前缀) */
const YOUR_WORDS = /OPERATOR:\s*(用户[:：]|管理员 \(用户\))/; // control.ts tell 的前缀 11-04 晚改成 "管理员 (用户) 在界面…说", 这里没跟上, 回过的等你一直算没回 (2026-11-05)

/**
 * 一个角色最近的行 → 对话流: 说的话一条一项; 连续的命令和结果折成一项 "干了 N 步" (结果按先后配给还没有结果的命令);
 * 找操作员的命令单独成一项 "等你", 之后的结果里出现你的话 (OPERATOR: 用户:) 就算回过了。
 */
export function foldLines(lines: Line[], agent: string): Item[] {
  const items: Item[] = [];
  const waiting: (Step | null)[] = []; // 还没配上结果的命令 (null = 找操作员的那条, 它的结果不显示)
  let group: Item & { type: "steps" } | null = null;
  const asks: { item: Item & { type: "ask" }; idx: number }[] = [];
  lines.forEach((l, idx) => {
    if (l.kind === "说") { group = null; items.push({ type: "say", agent, text: l.text, at: l.at }); return; }
    if (l.kind === "命令") {
      if (isOperatorAsk(l.text)) {
        group = null;
        const text = askText(l.text);
        // 汇报 ("收到, 我先修…") 当它对你说的话; 真要你拍板的才是"等你" (2026-11-05)
        if (!needsReply(text)) { items.push({ type: "say", agent, text, at: l.at, toYou: true }); waiting.push(null); return; }
        const item = { type: "ask" as const, agent, text, at: l.at, answered: false };
        items.push(item); asks.push({ item, idx }); waiting.push(null);
        return;
      }
      const step: Step = { cmd: commandLabel(l.text), desc: l.desc, at: l.at };
      if (!group) { group = { type: "steps", agent, steps: [], at: l.at }; items.push(group); }
      group.steps.push(step); waiting.push(step);
      return;
    }
    // 结果
    if (waiting.length) {
      const s = waiting.shift()!;
      if (s) { s.result = l.text; if (l.error && !isWaitInterrupted(l.text)) s.error = true; }
    } else {
      // 命令在截取范围之前: 单独记一步, 只有结果
      if (!group) { group = { type: "steps", agent, steps: [], at: l.at }; items.push(group); }
      group.steps.push({ cmd: "", result: l.text, error: (l.error && !isWaitInterrupted(l.text)) || undefined, at: l.at });
    }
  });
  for (const a of asks) a.item.answered = lines.slice(a.idx + 1).some((l) => l.kind === "结果" && YOUR_WORDS.test(l.text));
  return items;
}

/** 界面自己记的 → 对话流的项: 全队看全部; 某个角色看发给它的和发给全队的话 */
export function localItems(locals: Local[], agent: string): Item[] {
  return locals.filter((l) => agent === TEAM || l.agent === agent || (l.agent === TEAM && l.type === "tell")).map((l): Item => l.type === "tell"
    ? { type: "you", agent: l.agent, text: l.text, at: l.at, status: l.status, error: l.error }
    : { type: "you-cmd", agent: l.agent, args: l.args, at: l.at, pending: l.pending, out: l.out, code: l.code });
}

const ms = (at?: string): number | null => { if (!at) return null; const t = Date.parse(at); return Number.isNaN(t) ? null : t; };

/**
 * 按时间合并几路对话流 (各路自己的先后不变): 没有时间的项接在同一路前一项后面。
 * 你在某个时间之后说过话 (已送到), 那之前的"等你"就算回过了。
 */
export function mergeThread(streams: Item[][]): Item[] {
  const keyed: { item: Item; t: number; s: number; i: number }[] = [];
  streams.forEach((items, s) => {
    let last = -Infinity;
    items.forEach((item, i) => { const t = ms(item.at) ?? last; last = t; keyed.push({ item, t, s, i }); });
  });
  keyed.sort((a, b) => a.t - b.t || a.s - b.s || a.i - b.i);
  const out = keyed.map((k) => k.item);
  const told = out.filter((x): x is Item & { type: "you" } => x.type === "you" && x.status === "已送到");
  // 没带时间的"等你" (Codex / Grok 翻译过来的行可能没有 at) 用它在这一路里继承到的时间 (k.t) 比, 不然永远算没回过, 卡片一直"正在发"
  for (const k of keyed) {
    const x = k.item;
    if (x.type !== "ask" || x.answered) continue;
    const t = ms(x.at) ?? (Number.isFinite(k.t) ? k.t : null);
    if (t !== null && told.some((y) => (y.agent === x.agent || y.agent === TEAM) && (ms(y.at) ?? 0) > t)) x.answered = true;
  }
  return out;
}

/** 哪些项上方写时间: 第一项, 或者和上一项隔了 gapMin 分钟以上 (每项都写太挤; 照 OpenGrokBot "停顿之后才写几点") */
export function timeMarks(items: Item[], gapMin = 3): boolean[] {
  let prev: number | null = null;
  return items.map((x, i) => {
    const t = ms(x.at);
    const show = t !== null && (i === 0 || prev === null || t - prev >= gapMin * 60_000);
    if (t !== null) prev = t;
    return show;
  });
}

/** 等你处理的件数 (左栏角标): 还没回过的"等你" */
export const pendingAsks = (items: Item[]): number => items.filter((x) => x.type === "ask" && !x.answered).length;

export type Presence = "等你" | "在干活" | "在想" | "开班中" | "闲着" | "没在跑";
/** 左栏圆点: 有没回的"等你"优先; 这一班没在跑就是"没在跑"; 还没有第一次读数是"开班中";
 *  身体在动是"在干活"; 身体没动但大脑这一轮还在跑是"在想" */
export function presence(agent: Agent, pending: number, running: boolean): Presence {
  if (!running || agent.left) return "没在跑"; // 被移出的角色显示离线
  if (pending > 0) return "等你";
  if (agent.busy === null || agent.busy === undefined) return "开班中";
  return agent.busy ? "在干活" : agent.thinking ? "在想" : "闲着";
}
/** 全队那一行: 有人等你 > 有人在动或在想 > 都在开班 > 闲着 */
export function teamPresence(all: Presence[]): Presence {
  if (all.includes("等你")) return "等你";
  if (all.includes("在干活") || all.includes("在想")) return "在干活";
  if (all.length && all.every((p) => p === "开班中")) return "开班中";
  return "闲着";
}

/** 左栏的预览: 对话流最后一项的一句话 */
export function preview(items: Item[]): string {
  const x = items.at(-1);
  if (!x) return "还没有说过话";
  switch (x.type) {
    case "say": return firstLine(x.text);
    case "ask": return `等你: ${firstLine(x.text)}`;
    case "you": return `你: ${firstLine(x.text)}`;
    case "you-cmd": return `你执行: /${x.args}`;
    case "steps": { const s = x.steps.at(-1); return `干了 ${x.steps.length} 步${s ? ` · ${s.desc ?? firstLine(s.cmd || s.result || "")}` : ""}`; }
  }
}
const firstLine = (s: string): string => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";

/** "干了 N 步" 那一行的小字: 失败几步 */
export function stepsMeta(steps: Step[]): string {
  const failed = steps.filter((s) => s.error).length;
  return `干了 ${steps.length} 步${failed ? ` · ${failed} 步失败` : ""}`;
}

/** 输入框: "/" 开头 = 直接执行游戏命令 (/ 后面是 ./fh 的参数), 其他 = 对它说话 */
export function parseComposer(raw: string): { type: "fh"; args: string } | { type: "tell"; text: string } | { type: "error"; text: string } | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith("/")) {
    const args = t.slice(1).trim().replace(/^\.\/fh\s+/, "");
    return args ? { type: "fh", args } : { type: "error", text: "/ 后面要写 ./fh 的参数, 例如 /call status" };
  }
  return { type: "tell", text: t };
}

/** 班次目录名是开班的 UTC 时间 (2026-11-03T11-17-28) → Date */
export function runStart(id: string): Date | null {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(id);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : null;
}
const pad = (n: number) => String(n).padStart(2, "0");
/** 本地时间 "11月3日 19:17" */
export const fmtDay = (d: Date): string => `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** 本地时间 "19:17" */
export const fmtClock = (at?: string): string => { const t = ms(at); if (t === null) return ""; const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const runLabel = (id: string): string => { const d = runStart(id); return d ? `${fmtDay(d)} 开班` : id; };

/** 游戏时间 (分钟) → "13 小时 27 分" */
export function fmtGameTime(min: number | undefined): string {
  if (min === undefined || !Number.isFinite(min)) return "—";
  const m = Math.floor(min);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分`;
}
/** 每分钟产量: 10 以下一位小数, 以上取整 */
export const fmtRate = (x: number | undefined): string => (x === undefined || !Number.isFinite(x) ? "—" : x < 10 ? x.toFixed(1) : String(Math.round(x)));
export const fmtPct = (u: number | null | undefined): string => (u === null || u === undefined || !Number.isFinite(u) ? "—" : `${Math.round(u * 100)}%`);

/** 额度说明去掉开头的 "额度 (可用): " (标题已经写了额度, 状态括号对用户没用); 没读到时的 "额度: 没读到 …" 留着 */
export const quotaDetail = (text: string | undefined): string => (text ? text.replace(/^额度 \([^)]*\):\s*/, "") : "还没读到");

/** 三种科技包的内部名 (右栏用 /api/names 换成官方中文名) */
export const SCIENCE = [
  { key: "red", item: "automation-science-pack", fallback: "红瓶" },
  { key: "green", item: "logistic-science-pack", fallback: "绿瓶" },
  { key: "blue", item: "chemical-science-pack", fallback: "蓝瓶" },
] as const;

/** 读数多久没更新 (分钟); 没有读数时间就 null */
export const staleMinutes = (game: Game | null | undefined, now: number): number | null => (game?.at ? Math.max(0, (now - game.at) / 60000) : null);
/** 读数超过这么多分钟没更新, 就提示"可能卡住或已经停了" (监工大约每 20 秒记一次) */
export const STALE_MIN = 3;

/** 对话流上方的一条提示: 没在跑 / 正在收尾 / 读数很久没更新; 正常在跑时没有 */
export function runBanner(state: State | null, now: number): { tone: "info" | "warn"; text: string } | null {
  if (!state) return null;
  if (!state.run) return { tone: "info", text: "还没有任何一班的记录" };
  if (!state.run.running && state.run.interrupted) {
    return { tone: "warn", text: `最近一班 (${runLabel(state.run.id)}) 中断了: 没存档收尾${state.run.lastAt ? `, 最后一次记录在 ${fmtDay(new Date(state.run.lastAt))}` : ""} · 下面是它的记录` };
  }
  if (!state.run.running) return { tone: "info", text: `没有在跑 · 下面是最近一班 (${runLabel(state.run.id)}) 的记录` };
  if (state.run.stopping) return { tone: "warn", text: "正在收尾: 存档后这一班就停" };
  // 威胁警报在顶部 (用户定的布局): 游戏掉线 (看门狗在等 / 在重启) 和本班死亡次数
  const w = state.watchdog;
  if (w?.down) return { tone: "warn", text: `游戏掉线 ${w.downS} 秒: 看门狗${w.downS >= 45 ? "正在用最新自动存档重启" : "在等它恢复 (45 秒后重启)"}` };
  const st = staleMinutes(state.game, now);
  if (st !== null && st >= STALE_MIN) return { tone: "warn", text: `在跑, 但读数已经 ${Math.floor(st)} 分钟没更新 (可能卡住或已经停了)` };
  if (w && w.deaths > 0) return { tone: "warn", text: `本班角色死亡 ${w.deaths} 次${w.lastDeathAt ? ` (最近 ${fmtDay(new Date(w.lastDeathAt))})` : ""}: 看对话里大脑怎么处理, 右栏"看门狗"有明细` };
  return null;
}

/** 名单和在跑的角色比 → 要加的、要移出的: 第 1 席是玩家的身体时不动 (老班 / 联机; 沙盘 A 也是服务器角色, 一样能进出);
 *  同一个模型几个角色按个数对; 老的会话文件没记 seat 的角色不动 (认不出它是哪一席) */
export function rosterDiff(seats: RosterSeat[], live: Agent[]): { join: RosterSeat[]; leave: string[] } {
  // 第 1 个位置 (控制用户账号的) 下一班才换, 现在不加不移; 但顺序变了 (accountSeatFirst) 不算有人进出, 所以连 A 和第 1 个一起配对
  const firstIsBody = live.some((a) => a.id === "a" && !a.left && !a.bot);
  const unmatched = live.filter((a) => !a.left && a.seat);
  const join: RosterSeat[] = [];
  seats.forEach((s, n) => {
    const k = seatValue(s);
    const i = unmatched.findIndex((a) => seatValue(a.seat!) === k);
    if (i >= 0) unmatched.splice(i, 1); else if (n > 0 || !firstIsBody) join.push(s);
  });
  return { join, leave: unmatched.filter((a) => !firstIsBody || a.id !== "a").map((a) => a.id) };
}
/** 让这个模型控制用户的账号 = 排到名单第 1 个 (第 1 个角色连着用户的账号), 原来第 1 个变成普通队员; 名单里没有就加到最前面 */
export function accountSeatFirst(seats: RosterSeat[], seat: RosterSeat): RosterSeat[] {
  const k = seatValue(seat);
  const i = seats.findIndex((s) => seatValue(s) === k);
  if (i === 0) return seats;
  return i < 0 ? [seat, ...seats] : [seats[i], ...seats.filter((_, n) => n !== i)];
}

/** 右栏底部的停班按钮 (backlog #294):
 *  连得上 → 只有在跑且没在收尾才能点; 连不上 → 仍能点, 由桌面外壳直接给在跑的那一班写停班标记 (main.rs stop_run), 说明写在按钮下面 */
export function stopButton(connected: boolean, run: Run | null | undefined): { disabled: boolean; label: string; note: string } {
  if (!connected) return { disabled: false, label: "停班 (存档收尾)", note: "连不上控制接口: 点了由界面直接写停班标记, 大脑看到后存档收尾; 关掉游戏窗口也等于停班" };
  if (run?.running && run.stopping) return { disabled: true, label: "正在收尾…", note: "大脑已停, 存档后游戏关闭" };
  if (run?.running) return { disabled: false, label: "停班 (存档收尾)", note: "会先问你确认。直接关掉这个界面也等于停班" };
  return { disabled: true, label: "停班 (存档收尾)", note: "没有在跑的一班" };
}

/** 输入框能不能发: 这一班在跑才能发 (对它说话和执行命令都要连到游戏) */
export function composerBlock(state: State | null, agent: string): string | null {
  if (!state?.run) return "还没有任何一班, 不能发话";
  if (!state.run.running) return "没有在跑, 不能发话";
  if (agent === TEAM) return null;
  const a = state.agents?.find((x) => x.id === agent);
  if (a?.left) return "这个角色已经移出了";
  return a ? null : "这一班没有这个角色";
}

/** 角色的字母: 记录里的 id 大写 (A、B; 和复盘里一致; 界面上只在认不出厂商、没有 LOGO 时当头像的字) */
export const agentLabel = (id: string): string => (id === TEAM ? TEAM : id.toUpperCase());
/** 界面上的角色名 = 模型名 "Claude Opus 5.5" (11-04: "角色名就叫他们模型的名字, 不是 A B C");
 *  同一班两个角色同一个模型时后面带游戏里的名字区分 "Claude Opus 5.5 (ai2)"; 控制接口没给模型名 (旧版本) 时只写字母 */
export function agentTitle(id: string, agents: Agent[] = []): string {
  if (id === TEAM) return TEAM;
  const a = agents.find((x) => x.id === id);
  if (!a?.model) return agentLabel(id);
  const same = agents.filter((x) => x.model === a.model).length > 1;
  return same && a.name ? `${a.model} (${a.name})` : a.model;
}

// ── 等你卡片的按钮 (照 OpenMausBot 的批准 / 不批) ──
export type AskOption = { key: string; text: string };
const OPTION_LINE = /^\s*(?:[-*]\s*)?(\d{1,2}|[A-Fa-f])\s*[.)、．:：]\s*(\S.{0,79})$/;
const CIRCLED = "①②③④⑤⑥";
/**
 * 大脑把选项写成一行一个 (1. … / A) … / ①…, 简报里这样要求) 时, 每项一个按钮; 要从 1 / A / ① 开始、挨着数, 2~6 项。
 * 不像选项 (没写、只有 1 项、不挨着) 返回 []: 卡片上就放"批准 / 不批"。
 */
export function askOptions(text: string): AskOption[] {
  const out: AskOption[] = [];
  for (const line of text.split(/\r?\n/)) {
    const c = /^\s*([①-⑥])\s*(\S.{0,79})$/.exec(line);
    const m = c ? [line, String(CIRCLED.indexOf(c[1]) + 1), c[2]] : OPTION_LINE.exec(line);
    if (!m) continue;
    const key = /^[A-Fa-f]$/.test(m[1]) ? m[1].toUpperCase() : m[1];
    const want = out.length === 0 ? null : /^[A-F]$/.test(out[0].key) ? String.fromCharCode(out[0].key.charCodeAt(0) + out.length) : String(Number(out[0].key) + out.length);
    if (out.length === 0 ? !["1", "A"].includes(key) : key !== want) continue;
    out.push({ key, text: m[2].trim() });
  }
  return out.length >= 2 && out.length <= 6 ? out : [];
}
/** 点按钮发给大脑的话: 带上它问的是哪件事 (前 40 字), 它可能已经在想别的了 */
export function askReply(ask: string, choice: AskOption | "批准" | "不批"): string {
  const q = firstLine(ask);
  const quote = q.length > 40 ? `${q.slice(0, 40)}…` : q;
  const what = choice === "批准" ? "批准" : choice === "不批" ? "不批, 先别做" : `选 ${choice.key}: ${choice.text}`;
  return `${what} (回你问的: "${quote}")`;
}

// ── 账号页 (控制接口 GET /api/accounts, 格式见 src/play/accounts.ts 的 Account) ──
/** used = 已用百分数 0~100 */
export type UsageWindow = { label: string; used: number; resetsAt: string | null };
/** 按量付费的余额 (DeepSeek / 中转站), 金额是接口回的原样字符串; note 有就代替"赠送 + 充值"那行小字 */
export type Balance = { currency: string; total: string; granted: string; toppedUp: string; enough: boolean | null; note?: string };
/** kind: cli = 官方命令行登录 (Claude Code / Grok Build / Codex); key = 填 API 密钥 (DeepSeek / GLM 编程套餐 / 中转站; keyTail = 密钥末 4 位)。
 *  中转站 (id = relay, 2026-11-04) 多带 url (站点)、model (给大脑的模型)、models (这个令牌能用的模型) */
export type Account = {
  id: string; label: string; short: string; kind?: "cli" | "key"; installed: boolean; version: string | null; signedIn: boolean | null;
  plan: string | null; usage: UsageWindow[]; balance?: Balance | null; usageWhy: string | null; login: string; install: string;
  keyTail?: string | null; keyUrl?: string | null;
  url?: string | null; model?: string | null; models?: RelayModel[]; accessTail?: string | null; accessUser?: string | null;
  /** 中转站: 核实过的模型 (账号页"核实"按钮发一句看通不通); codex: model = Codex 配置里的默认模型 */
  verified?: Record<string, VerifyRecord>;
  /** gemini (Antigravity CLI): `agy models` 列出来的模型 (id + 显示名) */
  modelList?: { id: string; name: string }[];
};
export type VerifyRecord = { ok: boolean; ms: number; text: string; at: string };
/** 中转站的一个模型: formats 是站的价目表里写的接口格式, 有 anthropic 的 Claude Code 能直接用 */
export type RelayModel = { id: string; formats: string[] };
/** 分组: native / other 按站的价目表 (标了 anthropic 的能直接用); 核实过 再分 ok 通 / failed 没通 (带原因) / unverified 没核实 */
/** 站标的协议 → 我们怎么用它 (同 src/play/relay-route.ts relayKind; 2026-11-04 晚站长 "去模型广场看看这些模型都是什么协议的"): anthropic = Claude Code 直接用;
 *  responses = 没 Claude 格式、有 Responses 协议 (gpt / 站里的 grok) → 开班时走 Codex 指向站; chat = 只有 Chat 协议 (MiniMax 系列) → Claude Code 由站转格式; unusable = 图片 / 视频 */
export type RelayKind = "anthropic" | "responses" | "chat" | "unusable";
export function relayKind(formats: string[]): RelayKind {
  const f = formats.map((x) => x.toLowerCase());
  if (!f.length || f.includes("anthropic")) return "anthropic";
  if (f.some((x) => /response/.test(x))) return "responses";
  if (f.includes("openai")) return "chat";
  return "unusable";
}
export function relayModelGroups(models: RelayModel[] | undefined, verified?: Record<string, VerifyRecord>): { native: RelayModel[]; responses: RelayModel[]; chat: RelayModel[]; unusable: RelayModel[]; ok: RelayModel[]; failed: (RelayModel & { why: string })[]; unverified: RelayModel[]; verifiedAny: boolean } {
  const list = models ?? [];
  const v = verified ?? {};
  const usable = list.filter((m) => relayKind(m.formats) !== "unusable");
  const ok = usable.filter((m) => v[m.id]?.ok), failed = usable.filter((m) => v[m.id] && !v[m.id].ok).map((m) => ({ ...m, why: v[m.id].text })), unverified = usable.filter((m) => !v[m.id]);
  return { native: list.filter((m) => relayKind(m.formats) === "anthropic"), responses: list.filter((m) => relayKind(m.formats) === "responses"), chat: list.filter((m) => relayKind(m.formats) === "chat"),
    unusable: list.filter((m) => relayKind(m.formats) === "unusable"), ok, failed, unverified, verifiedAny: ok.length + failed.length > 0 };
}
/** 核实进度 (控制接口 GET /api/relay/verify) */
export type VerifyStatus = { running: boolean; total: number; done: number; current: string | null; startedAt: string | null; finishedAt: string | null; results: Record<string, VerifyRecord> };
export const verifyLine = (s: VerifyStatus | null): string => !s ? "" : s.running ? `正在核实 ${s.done}/${s.total}${s.current ? ` · ${s.current}` : ""}` : s.finishedAt ? `核实完: ${Object.values(s.results).filter((r) => r.ok).length} 通 / ${Object.values(s.results).filter((r) => !r.ok).length} 没通` : "";
/** 存密钥的参数: key 不给 = 不改密钥; extra 只有中转站用 (url 站点、model 默认模型、access 系统访问令牌 + user 用户 ID 读账户余额) */
export type KeyPatch = { url?: string; model?: string; access?: string; user?: string };
/** "¥110.00" / "$1.00"; 不是数的 (中转站 "不限额") 照写 */
export const fmtBalance = (b: Balance): string => (/^\d/.test(b.total) ? `${b.currency === "CNY" ? "¥" : b.currency === "USD" ? "$" : `${b.currency} `}${b.total}` : b.total);

/** 开班扫描 (控制接口 /api/scan; run.ts 开班时按读数算的现状 / 判断 / 规划); 没有 → null */
export type Scan = { at: string; stage: string; summary: string; lines: string[]; judgement: string[]; plan: string[] } | null;

// ── 下一班阵容 (控制接口 /api/lineup): 每个角色一个模型, 来源可以是任一家 ──
export type RosterSeat = { brain: string; model: string; /** 思考强度 (low/medium/high/xhigh/max; 空 = 开班命令行的默认) */ effort?: string };
/** 同 src/play/brains.ts 的 MAX_AGENTS (角色 id 一个字母 a~z); 真正的上限是机器和服务器位子 */
export const MAX_SEATS = 26;
export type SeatOption = { value: string; label: string; disabled?: boolean };
/** 下拉的值 "家:模型" ↔ 角色 (强度另一个控件, 不在值里)。Claude 的旧别名 (opus / sonnet…) 对到官方档位的完整 id, 这样旧的 lineup.json 在新下拉里也选得中 */
const CLAUDE_ALIAS: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-1" };
export const seatValue = (s: RosterSeat): string => (s.model ? `${s.brain}:${s.brain === "claude" ? CLAUDE_ALIAS[s.model.toLowerCase()] ?? s.model : s.model}` : s.brain);
export function parseSeatValue(v: string): RosterSeat {
  const i = v.indexOf(":");
  return i < 0 ? { brain: v, model: "" } : { brain: v.slice(0, i), model: v.slice(i + 1) };
}
/** 模型名规范写法 (同 src/play/model-name.ts prettyModel): gpt-6.1-terra → Gpt-6.1-Terra, MiniMax-M3.1-Flash 不变 */
export function prettyModel(model: string | undefined): string {
  const m = (model ?? "").trim().split("/").pop() ?? "";
  return m.split("-").map((seg) => (seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : seg)).join("-");
}
/** 群成员列表里一个角色的名字 ("不要标注是中转的"): 模型名规范写法, Claude 的别名写 Claude Opus / Sonnet */
export function seatDisplay(s: RosterSeat): string {
  const m = s.model.trim();
  if (s.brain === "claude" || s.brain === "claude-api") {
    const f = claudeFull(m);
    if (f) return `Claude ${f.family.charAt(0).toUpperCase() + f.family.slice(1)} ${f.version}`;
    return /^(opus|sonnet|haiku|fable)$/i.test(m) || !m ? `Claude ${m ? m.charAt(0).toUpperCase() + m.slice(1).toLowerCase() : "Opus"}` : prettyModel(m);
  }
  if (s.brain === "none") return "测试班 (不叫大脑)";
  if (!m) return s.brain === "relay" ? "中转站 (没选模型)" : s.brain === "grok" ? "Grok-4.7" : s.brain === "deepseek" ? "Deepseek-Flash" : s.brain === "codex" ? "GPT (Codex)" : s.brain === "gemini" ? "Gemini (Antigravity)" : s.brain;
  return prettyModel(m);
}
/** 拉人下拉的默认选项: 中转站有核实能用 / 能直接用的就第一个, 不然 Claude Opus */
export function defaultInvite(groups: { label: string; items: SeatOption[] }[]): string {
  const g = groups.find((x) => x.label.startsWith("中转站 · 核实能用")) ?? groups.find((x) => x.label.startsWith("中转站 · Claude 格式"));
  return g?.items.find((o) => !o.disabled)?.value ?? "claude:opus";
}
/** 强度档 (Claude Code --effort / Grok --reasoning-effort / Codex model_reasoning_effort 同名) */
export const EFFORTS: [string, string][] = [["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "很高"], ["max", "最高"]];
export const effortLabel = (e: string | undefined): string => (e ? EFFORTS.find(([k]) => k === e)?.[1] ?? e : "默认");
/** Claude 官方档位 (同 Claude Code /model 列的; id 是完整模型名, 2026-11-04) */
export const CLAUDE_MODELS: [string, string][] = [["claude-fable-5-1", "Claude Fable 5.1"], ["claude-opus-5-5", "Claude Opus 5.5"], ["claude-sonnet-5-5", "Claude Sonnet 5.5"], ["claude-haiku-5-5", "Claude Haiku 5.5"]];
const claudeFull = (m: string): { family: string; version: string } | null => { const r = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/i.exec(m.trim()); return r ? { family: r[1].toLowerCase(), version: `${r[2]}.${r[3]}` } : null; };
/** 一个角色在游戏里的名字 (同 src/play/model-name.ts botName, 不含 -2 后缀): 模型名规范写法, Claude 别名 → Claude-Opus; 方括号去掉, 空格换 -, 最多 28 字 */
export function seatWord(s: RosterSeat): string {
  const b = s.brain.trim().toLowerCase();
  const m = s.model.trim();
  const vendor: Record<string, string> = { claude: "Claude", "claude-api": "Claude", grok: "Grok", deepseek: "Deepseek", codex: "Gpt", gemini: "Gemini", glm: "Glm", none: "Test", relay: "Relay" };
  const isClaude = b === "claude" || b === "claude-api";
  const f = isClaude ? claudeFull(m) : null;
  const raw = !m || b === "none" ? vendor[b] ?? b.charAt(0).toUpperCase() + b.slice(1) : f ? `Claude-${f.family.charAt(0).toUpperCase() + f.family.slice(1)}-${f.version}` : isClaude && /^(opus|sonnet|haiku|fable)$/i.test(m) ? `Claude-${m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()}` : prettyModel(m);
  return raw.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^[^A-Za-z]+/, "").replace(/-+$/, "").slice(0, 28) || "Ai";
}
/** 第 i 个角色在游戏里叫什么 (同 brains.ts lineup): 模型名, 同名第 2 个起 -2; account = 第 1 个控制你的账号 (联机服务器的群; 名字不改) → null */
export function seatGameName(seats: RosterSeat[], i: number, account = false): string | null {
  if (account && i === 0) return null;
  const base = seatWord(seats[i]);
  const nth = seats.slice(account ? 1 : 0, i).filter((s) => seatWord(s) === base).length + 1;
  return nth <= 1 ? base : `${base}-${nth}`;
}
/** 第 i 个角色的说明: 沙盘全是服务器角色, 窗口只看; account = 联机服务器的群: 第 1 个操控你的账号 */
export const seatLabel = (seats: RosterSeat[], i: number, account = false): string => (account && i === 0 ? "控制你的账号, 游戏里名字不改" : `服务器角色 · 游戏里叫 ${seatGameName(seats, i, account)}`);
/** 群卡上说虫子的那几个字: 有虫子时开班先留的和平也写上 */
export const groupEnemyLabel = (g: { peaceful?: boolean; peacefulMinutes?: number }): string => (g.peaceful === false ? ` · 有虫子${g.peacefulMinutes ? `, 开班先和平 ${g.peacefulMinutes} 分钟` : ""}` : "");
/** Gemini (Antigravity) 那一组: 没装 agy → 灰 "(没装 agy)"; 没登录 → 灰 "(没登录)"; 登了且列到模型 → 每个模型一项 (值 gemini:<id>); 其余 → "默认模型" 可选 */
export function geminiItems(a: Account | undefined, loaded: boolean): SeatOption[] {
  if (loaded && a && !a.installed) return [{ value: "gemini", label: "Antigravity 默认模型 (没装 agy)", disabled: true }];
  if (loaded && a && a.signedIn === false) return [{ value: "gemini", label: "Antigravity 默认模型 (没登录: 终端跑一次 agy)", disabled: true }];
  if (a?.modelList?.length) return a.modelList.map((m) => ({ value: `gemini:${m.id}`, label: m.name === m.id ? m.id : `${m.name} (${m.id})`, disabled: false }));
  return [{ value: "gemini", label: "Antigravity 默认模型", disabled: false }];
}
/** 能选的模型, 按来源分组; 没登录 / 没填密钥的那家灰掉 (还能看见, 知道去哪开) */
export function lineupOptions(accounts: Account[] | null): { label: string; items: SeatOption[] }[] {
  const acct = (id: string) => accounts?.find((a) => a.id === id);
  const off = (id: string, why: string): string => { const a = acct(id); return !accounts || !a ? "" : a.signedIn ? "" : ` (${why})`; };
  const dis = (id: string): boolean => { const a = acct(id); return !!accounts && !!a && !a.signedIn; };
  // 官方订阅两家: Claude 列官方档位 (同 Claude Code /model 的几档), GPT 列 Codex 配置里的默认模型
  const codexModel = acct("codex")?.model || "gpt-6.1-sol";
  const groups: { label: string; items: SeatOption[] }[] = [
    { label: "Claude (官方订阅, Claude Code)", items: CLAUDE_MODELS.map(([id, name]) => ({ value: `claude:${id}`, label: `${name}${off("claude", "没登录")}`, disabled: dis("claude") })) },
    // Claude 的第二条路: 同样几档模型, 走 Agent SDK 按 token 扣 Console; 密钥在账号页 "Claude (Console API 密钥)" 卡填
    { label: "Claude (Console API 密钥, Agent SDK)", items: CLAUDE_MODELS.map(([id, name]) => ({ value: `claude-api:${id}`, label: `${name}${off("anthropic", "没填密钥")}`, disabled: dis("anthropic") })) },
    { label: "GPT (官方订阅, Codex)", items: [{ value: `codex:${codexModel}`, label: `${codexModel} (Codex 配置里的默认模型)${off("codex", "没登录")}`, disabled: dis("codex") }] },
    // Gemini 经 Antigravity CLI: 登了就列 `agy models` 给的模型 (1.5.0 实测 6 个); 没装 / 没登灰掉; 还没读到就一个"默认模型"
    { label: "Gemini (官方, Antigravity CLI)", items: geminiItems(acct("gemini"), !!accounts) },
    { label: "Grok Build", items: [{ value: "grok:grok-4.7", label: `grok-4.7${off("grok", "没登录")}`, disabled: dis("grok") }] },
    { label: "DeepSeek (官方)", items: ["deepseek-flash[1m]", "deepseek-v4-pro"].map((m) => ({ value: `deepseek:${m}`, label: `${m}${off("deepseek", "没填密钥")}`, disabled: dis("deepseek") })) },
  ];
  const relay = acct("relay");
  const rg = relayModelGroups(relay?.models, relay?.verified);
  if (relay?.signedIn && (rg.native.length || rg.responses.length || rg.chat.length)) {
    // 每个模型标出它走哪条路 (11-04 晚站长 "去模型广场看看这些模型都是什么协议的"): Claude 格式 → Claude Code; Responses → Codex 指向站; Chat → Claude Code 由站转格式
    const tag = (m: RelayModel) => { const k = relayKind(m.formats); return k === "responses" ? " · Responses, 走 Codex" : k === "chat" ? " · Chat, 站转格式" : ""; };
    if (rg.verifiedAny) {
      // 核实过就按结果分: 通的一组, 没核实的一组, 没通的灰掉并写原因
      if (rg.ok.length) groups.push({ label: `中转站 · 核实能用 (${rg.ok.length})`, items: rg.ok.map((m) => ({ value: `relay:${m.id}`, label: `${m.id}${tag(m)}` })) });
      if (rg.unverified.length) groups.push({ label: `中转站 · 没核实 (${rg.unverified.length}, 账号页点核实)`, items: rg.unverified.map((m) => ({ value: `relay:${m.id}`, label: `${m.id}${tag(m)}` })) });
      if (rg.failed.length) groups.push({ label: `中转站 · 没通 (${rg.failed.length})`, items: rg.failed.map((m) => ({ value: `relay:${m.id}`, label: `${m.id} (${m.why.slice(0, 60)})`, disabled: true })) });
    } else {
      if (rg.native.length) groups.push({ label: "中转站 · Claude 格式 (Claude Code 直接用; 账号页可核实)", items: rg.native.map((m) => ({ value: `relay:${m.id}`, label: m.id })) });
      if (rg.responses.length) groups.push({ label: "中转站 · Responses 协议 (开班走 Codex 指向站)", items: rg.responses.map((m) => ({ value: `relay:${m.id}`, label: m.id })) });
      if (rg.chat.length) groups.push({ label: "中转站 · 只有 Chat 协议 (Claude Code 由站转格式)", items: rg.chat.map((m) => ({ value: `relay:${m.id}`, label: m.id })) });
    }
  } else groups.push({ label: "中转站", items: [{ value: "relay", label: relay?.keyTail ? "令牌还没查成" : "没填站点和令牌", disabled: true }] });
  groups.push({ label: "测试", items: [{ value: "none", label: "不叫大脑 (测试班, 只开游戏和监工)" }] });
  return groups;
}
/** 一家的状态一句话 */
export function accountStatus(a: Account): string {
  if (a.kind === "key") {
    if (!a.keyTail) return "没填密钥";
    if (a.signedIn === false) return "密钥不对";
    if (a.signedIn === null) return "已填密钥 · 没查成";
    return a.plan ? `密钥可用 · ${a.plan}` : "密钥可用";
  }
  if (!a.installed) return "本机没装";
  if (a.signedIn === false) return "装了, 还没登录";
  if (a.signedIn === null) return "装了, 看不出登没登录";
  return a.plan ? `已登录 · ${a.plan}` : "已登录";
}
/** 还剩多少 % (取整) */
export const remainPct = (w: UsageWindow): number => Math.max(0, Math.min(100, Math.round(100 - w.used)));
/** 剩得最少的窗口 */
export const tightest = (a: Account): UsageWindow | null => a.usage.reduce<UsageWindow | null>((m, w) => (!m || w.used > m.used ? w : m), null);
/** "3.6 天后重置" / "4.2 小时后重置" / "" */
export function resetIn(at: string | null, now: number): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return "";
  const h = (t - now) / 3_600_000;
  if (h <= 0) return "到重置时间了";
  return h >= 24 ? `${(h / 24).toFixed(1)} 天后重置` : `${h.toFixed(1)} 小时后重置`;
}
/** 左下角那一小行: "Claude 剩 56% · Grok 没装 · GPT 没装 · DeepSeek ¥110.00 · GLM 没填"; 还没读到时 null */
export function accountsLine(list: Account[] | null): string | null {
  if (!list) return null;
  return list.map((a) => {
    const w = tightest(a);
    if (a.kind === "key") return `${a.short} ${!a.keyTail ? "没填" : a.signedIn === false ? "密钥不对" : a.balance ? fmtBalance(a.balance) : w ? `剩 ${remainPct(w)}%` : a.signedIn ? "可用" : "?"}`;
    return `${a.short} ${!a.installed ? "没装" : a.signedIn === false ? "没登录" : w ? `剩 ${remainPct(w)}%` : a.signedIn ? "已登录" : "?"}`;
  }).join(" · ");
}
/** 左下角账号卡的一小行, 只说有几家能用 (明细在右栏"额度"和账号页); 还没读到时 null */
export function accountsBrief(list: Account[] | null): string | null {
  if (!list) return null;
  const ready = list.filter((a) => a.signedIn === true);
  if (!ready.length) return "还没有能用的账号";
  return `${ready.length} 家能用: ${ready.map((a) => a.short).join("、")}`;
}
/** 右栏"额度"每家一行: 剩多少 (0~1, 没有窗口时 null)、右边的字、下面的小字 */
export function accountQuota(a: Account, now: number): { name: string; remain: number | null; value: string; detail: string } {
  const w = tightest(a);
  if (w) return { name: a.short, remain: remainPct(w) / 100, value: `剩 ${remainPct(w)}%`, detail: `${w.label}已用 ${Math.round(w.used)}%${resetIn(w.resetsAt, now) ? `, ${resetIn(w.resetsAt, now)}` : ""}` };
  if (a.kind === "key" && a.balance && a.signedIn) return { name: a.short, remain: null, value: `余额 ${fmtBalance(a.balance)}`, detail: a.balance.enough === false ? "余额不够了" : "按用量扣费" };
  // 登了但额度没读到: 写原因
  return { name: a.short, remain: null, value: "—", detail: a.signedIn && a.usageWhy ? `额度没读到: ${a.usageWhy}` : accountStatus(a) };
}
/** 输入框 "/" 开头直接执行的命令 (= 派对宿主命令行 ./fh 的子命令, 开给大脑的那些; 起停服务器类不开放, src/play/fh-shim.ts BLOCKED); 左栏"/ 命令"面板列出 */
export const SLASH_COMMANDS: { cmd: string; what: string }[] = [
  { cmd: "call status", what: "角色现在的状态 (位置、手上、在做什么)" },
  { cmd: "observe", what: "周围一圈的世界状态 (实体、资源、敌情)" },
  { cmd: "call 动作 --args {…}", what: "执行一个游戏动作 (walk、craft、place、transfer…); /help 动作 看参数" },
  { cmd: "help", what: "命令和动作清单; /help 动作 看那个动作的参数" },
  { cmd: "wait", what: "等当前动作 (和战斗) 结束" },
  { cmd: "sleep 秒数", what: "睡一会儿, 受伤 / 被叫 / 队列跑完会提前醒" },
  { cmd: "queue status", what: "看它排队中的工作; queue cancel 立刻取消" },
  { cmd: "board", what: "全队公告板 (任务、请求、认领、笔记)" },
  { cmd: "research", what: "研究队列和进度" },
  { cmd: "say 文字", what: "在游戏聊天里说一句" },
  { cmd: "tell 名字 文字", what: "私信一个队友 (不经游戏聊天)" },
  { cmd: "chat", what: "它还没读的聊天" },
  { cmd: "players", what: "地图上的真人玩家在哪、建了什么" },
  { cmd: "blueprint list", what: "蓝图库; blueprint place 放一张" },
  { cmd: "view --out 路径.png", what: "把周围画成一张示意图" },
];
/** 搬来 / 借鉴的东西都标出处; 全文在仓库根目录 NOTICE */
export type Source = { what: string; from: string; url: string; license: string; where: string };
export const SOURCES: Source[] = [
  { what: "输入框的 / 命令 (派对宿主命令行 ./fh) 和游戏里的 agent-harness-party 模组", from: "factorio-ai-party · Nick Winter (vendor/factorio-harness)", url: "https://github.com/nwinter/factorio-ai-party", license: "MIT", where: "src/play/fh-shim.ts、mods/agent-harness-party/" },
  { what: "工厂摘要、监工、命令放行钩子 (搬成 TypeScript) 和简报的思路", from: "factorio-ai-party · Nick Winter", url: "https://github.com/nwinter/factorio-ai-party", license: "MIT", where: "src/play/digest.ts、permit.ts、brief-zh.md" },
  { what: "agent-harness 模组 (移植到 2.1)", from: "factorio-harness · Carson Burke", url: "https://github.com/CarsonBurke/factorio-harness", license: "MIT", where: "mods/agent-harness/" },
  { what: "产量公式", from: "RateCalculator · raiguard", url: "https://codeberg.org/raiguard/RateCalculator", license: "MIT", where: "mods/agent-harness/rates.lua" },
  { what: "联机接口的参考实现 (我们在它的 pilot 分支上加工具: 进化度、直接发玩家动作、读内存)", from: "factorio-mcp · czp3009 (朋友, 同意借鉴和复制)", url: "https://github.com/czp3009/factorio-mcp", license: "见他的仓库", where: "src/io/" },
  { what: "三栏聊天界面的样子 (左栏、对话行、右侧面板、样式)", from: "OpenGrokBot · wolfqing", url: "https://github.com/wolfqing/OpenGrokBot", license: "MIT", where: "app/src/" },
  { what: "Claude 常驻会话驱动和额度读法", from: "OpenMausBot · Milind Soni", url: "https://github.com/milind-soni/OpenMausBot", license: "Apache-2.0", where: "src/play/claude-stream.ts、quota.ts" },
  // 蓝图编辑器 (11-04 问"为什么界面上看不到": 之前只接在命令行, 没进致谢)
  { what: "蓝图出图和预览链接 (./bp render / link、数据集配图; 本机单独装, 不在仓库里)", from: "factorio-blueprint-editor · FactoryGameFan", url: "https://github.com/FactoryGameFan/factorio-blueprint-editor", license: "MIT", where: "src/blueprint/render.ts、src/dataset/ingest.ts (.env 的 FBE_DIR / FBE_URL)" },
];
/** 点了登录之后: 这一家登好了没有 (界面每 5 秒重读, 最多 3 分钟) */
export const loginDone = (list: Account[] | null, id: string): boolean => !!list?.find((a) => a.id === id)?.signedIn;

// ── 界面自己起的控制接口 (桌面外壳 app/src-tauri/src/main.rs, 调用在 src/desktop.ts) ──
/** started = 外壳起过它; running = 还活着; exit = 退出时的说明; error = 起不来的原因; log = 它的输出写在哪 */
export type ControlProc = { started: boolean; running: boolean; exit: string | null; error: string | null; log: string };

/** 连不上控制接口时顶上那条提示: 外壳起过它就说它在干什么; 没有外壳 (浏览器里) 就提示手动起 */
export function downBanner(err: string, proc: ControlProc | null, base: string): { text: string; retry: boolean } {
  const manual = `连不上控制接口 ${base}: 先在仓库目录运行 npm run play:control (${err})`;
  if (!proc) return { text: manual, retry: false };
  if (proc.error) return { text: `界面起控制接口没起来: ${proc.error}`, retry: true };
  if (proc.started && proc.running) return { text: "界面正在起控制接口… (第一次要几秒)", retry: false };
  if (proc.started) return { text: `界面起的控制接口退出了${proc.exit ? ` (${proc.exit})` : ""}; 它的输出在 ${proc.log}`, retry: true };
  return { text: `连不上控制接口 ${base} (${err}); 界面打开时它在别处跑着, 现在停了`, retry: true };
}

// ── 聊天室 ──
export type Vendor = "claude" | "openai" | "grok" | "deepseek" | "glm" | "minimax" | "kimi" | "doubao" | "stepfun" | "qwen" | "gemini";
export const VENDOR_NAME: Record<Vendor, string> = { claude: "Claude", openai: "OpenAI", grok: "Grok", deepseek: "DeepSeek", glm: "智谱 GLM", minimax: "MiniMax", kimi: "Kimi", doubao: "豆包", stepfun: "阶跃星辰", qwen: "通义千问", gemini: "Gemini" };
/** 模型名 ("Claude Opus 5.5"、"Grok 4.7"、"GPT-5.5"、"MiniMax-M3.1-Flash"…) 或账号 id (claude / codex / grok / deepseek / glm) → 厂商, 头像用它的 LOGO; 认不出 null (头像写字母)。
 *  : 补中转站里常见的几家 */
export function vendorOf(model?: string | null): Vendor | null {
  const m = (model ?? "").toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return "claude";
  if (/grok|xai/.test(m)) return "grok";
  if (/deepseek/.test(m)) return "deepseek";
  if (/glm|zhipu|chatglm|bigmodel/.test(m)) return "glm";
  if (/minimax/.test(m)) return "minimax";
  if (/kimi|moonshot/.test(m)) return "kimi";
  if (/doubao|volcengine|bytedance/.test(m)) return "doubao";
  if (/stepfun|^step[-\s\d]/.test(m)) return "stepfun";
  if (/qwen|tongyi/.test(m)) return "qwen";
  if (/gemini/.test(m)) return "gemini";
  if (/gpt|codex|openai|^o\d/.test(m)) return "openai";
  return null;
}
/** 对话流里哪些项开始新的一段 (这一项上面放头像和名字): 第一项、换了说话的人 (你说的都算"你")、或者和上一项隔了 gapMin 分钟以上 */
export function speakerStarts(items: Item[], gapMin = 3): boolean[] {
  let prev: { who: string; t: number | null } | null = null;
  return items.map((x) => {
    const who = x.type === "you" || x.type === "you-cmd" ? "你" : x.agent;
    const t = ms(x.at);
    const start = !prev || prev.who !== who || (t !== null && prev.t !== null && t - prev.t >= gapMin * 60_000);
    prev = { who, t: t ?? prev?.t ?? null };
    return start;
  });
}

/** localStorage 里存的本班记录最多留这么多条 */
export const LOCAL_MAX = 300;
export const trimLocals = (locals: Local[]): Local[] => locals.slice(-LOCAL_MAX);
