// 联机主循环的纯逻辑 (库, 不直接运行; src/play/online.ts 用): 服务器地址从哪读、简报里联机这一节、知识放进 ref/。
import fs from "node:fs";
import { knowledgeFile } from "../lab/gamedir.ts";
import path from "node:path";

export type ServerConn = { address: string; password?: string; rcon?: { address: string; password: string } };

/** 连哪个服务器: keys.json 的 group_servers[群] (没给群或这个群没单独存就用默认的 server)。地址和密码只在本机, 不进任何仓库 */
export function readServer(keysFile: string, groupId?: string): ServerConn | null {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch { return null; }
  const r = raw as { server?: unknown; group_servers?: Record<string, unknown> };
  const s = (groupId ? r.group_servers?.[groupId] : undefined) ?? r.server;
  const v = typeof s === "string" ? (() => { try { return JSON.parse(s) as unknown; } catch { return { address: s }; } })() : s;
  const o = v as { address?: unknown; password?: unknown; rcon?: { address?: unknown; password?: unknown } } | undefined;
  if (typeof o?.address !== "string" || !o.address) return null;
  const rcon = o.rcon && typeof o.rcon.address === "string" && o.rcon.address && typeof o.rcon.password === "string" && o.rcon.password ? { rcon: { address: o.rcon.address, password: o.rcon.password } } : {};
  return { address: o.address, ...(typeof o.password === "string" && o.password ? { password: o.password } : {}), ...rcon };
}

/** 界面填的服务器 → 存 keys.json 的形状 (纯函数): 地址空就用 base (本机已存的); RCON 地址和密码要么都填要么都不填, 地址要带端口; 什么都没填回 null (这个群用默认的)。不合格抛错 */
export function cleanServerConn(raw: { address?: unknown; password?: unknown; rcon?: { address?: unknown; password?: unknown } } | undefined, base: ServerConn | null): ServerConn | null {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const address = text(raw?.address), password = text(raw?.password), rconAddress = text(raw?.rcon?.address), rconPassword = text(raw?.rcon?.password);
  if (!!rconAddress !== !!rconPassword) throw new Error("RCON 的地址和密码要一起填");
  if (rconAddress && !parseHostPort(rconAddress)) throw new Error("RCON 地址要写成 主机:端口");
  if (!address && !rconAddress) return null;
  const main = address ? { address, ...(password ? { password } : {}) } : base;
  if (!main) throw new Error("联机服务器: 要给地址 (主机:端口)");
  return { address: main.address, ...(main.password ? { password: main.password } : {}), ...(rconAddress ? { rcon: { address: rconAddress, password: rconPassword } } : {}) };
}

/** 服务器角色的名字: 已有真玩家叫这个就往后排 (第 2 个起加 -2) */
export const botNameCandidates = (name: string): string[] => [name, `${name}-2`, `${name}-3`, `${name}-4`, `${name}-5`];

/** 给界面看的服务器信息: 地址可以看 (本机界面), 密码只说有没有 */
export function serverView(conn: ServerConn | null): { address: string; hasPassword: boolean; rcon: string | null } | null {
  return conn ? { address: conn.address, hasPassword: !!conn.password, rcon: conn.rcon?.address ?? null } : null;
}

/** "主机:端口" → 拆开; 不合格回 null (纯函数) */
export function parseHostPort(address: string): { host: string; port: number } | null {
  const m = /^(.+):(\d{1,5})$/.exec(address.trim());
  if (!m) return null;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? { host: m[1], port } : null;
}

export type ClientPhase = "starting" | "connecting" | "waiting_map" | "downloading" | "loading" | "catching_up" | "in_game" | "server_left" | "disconnected";

/** 客户端日志里的状态名 → 阶段 (用户连 czp 服务器的 factorio-current.log, ClientMultiplayerManager "changing state from(..) to(..)") */
const STATE_PHASE: Record<string, ClientPhase> = {
  Connecting: "connecting", ConnectedWaitingForMap: "waiting_map",
  ConnectedDownloadingMap: "downloading", ConnectedLoadingMap: "loading",
  TryingToCatchUp: "catching_up", WaitingForCommandToStartSendingTickClosures: "catching_up",
  InGame: "in_game",
  WaitingForUserToSaveOrQuitAfterServerLeft: "server_left",
  Disconnected: "disconnected", DisconnectScheduled: "disconnected", WaitingForDisconnectConfirmation: "disconnected",
};
const STATE_RE = /changing state from\(\w+\) to\((\w+)\)/g;
const JOIN_MARK = "Joining game";
/** 连不上时日志里能说明原因的行 (只看最后一次 Joining game 之后) */
const REASON_RE = /refused|cannot|can't|failed|password|verification|mismatch|incompatible|banned|rejected|desync|timed? ?out|is full/i;

/** 客户端日志 → 现在到哪一步, 连不上的话原因 (纯函数)。只读模式靠这个判断进没进世界和掉线, 不注入客户端 */
export function clientPhase(log: string): { phase: ClientPhase; reason: string | null } {
  let state = "";
  for (const m of log.matchAll(STATE_RE)) state = m[1];
  const phase: ClientPhase = state === "" ? "starting" : STATE_PHASE[state] ?? (state.startsWith("InGame") ? "in_game" : "connecting");
  let reason: string | null = null;
  if (phase === "disconnected" || phase === "server_left") {
    const from = log.lastIndexOf(JOIN_MARK);
    const since = from >= 0 ? log.slice(from) : log;
    // 客户端自己退的: 真服第一次连 (2026-11-06) 下地图 80 秒时 "Reason: Quit", 最后一行却是无关的 "cannot process synchronizer action", 报错就成了那句
    if (/Disconnecting multiplayer connection\. Reason: Quit\b/.test(since)) return { phase, reason: "客户端这边退出的 (窗口里点了取消、按了 ESC, 或窗口被关), 不是服务器踢的" };
    const lines = since.split(/\r?\n/).slice(1).filter((l) => !l.includes("changing state") && !l.includes("synchronizer action") && REASON_RE.test(l));
    reason = lines.at(-1)?.trim().replace(/^\d+\.\d+\s+/, "") ?? null;
  }
  return { phase, reason };
}

/** 文字里的服务器地址和密码换掉 (纯函数): 游戏把启动参数和连接地址写进日志 */
export function scrubText(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("<隐去>");
  return out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<隐去>");
}

/** 这个服务器连接里不能进日志的字: 地址、主机名、密码, RCON 的也算 */
export const secretsOf = (c: ServerConn): string[] => [c.address, c.address.split(":")[0], c.password, c.rcon?.address, c.rcon?.address.split(":")[0], c.rcon?.password].filter((s): s is string => !!s);

/** 客户端目录里带启动参数的文件: 日志只留在本机 (clients/ 不进备份), 收工也抹掉, 只有 keys.json 里有一份 */
export function scrubClientLogs(dir: string, server: ServerConn): number {
  const secrets = secretsOf(server);
  let n = 0;
  for (const name of ["factorio-current.log", "factorio-previous.log", "client.out"]) {
    const f = path.join(dir, name);
    let text: string;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const clean = scrubText(text, secrets);
    if (clean !== text) { fs.writeFileSync(f, clean); n++; }
  }
  return n;
}

/** 开班那一行: 谁、在哪、世界有哪些地表 */
export function whereLine(w: { player: { name?: string; position?: { x: number; y: number } }; hasBody: boolean; surfaces: { name: string; chunks: number; entities: number; mine: number; here: boolean }[] }): string {
  const here = w.surfaces.find((s) => s.here);
  const at = w.player.position ? `(${Math.round(w.player.position.x)},${Math.round(w.player.position.y)})` : "";
  const list = w.surfaces.map((s) => `${s.name}${s.here ? "*" : ""} 区块 ${s.chunks} 实体 ${s.entities} 我方 ${s.mine}`).join("; ");
  return `玩家 ${w.player.name ?? "?"}${w.hasBody ? "" : " (没有身体: 观战或远程视图)"} 在 ${here?.name ?? "?"} ${at}; 地表 ${w.surfaces.length} 个: ${list}`;
}

/** 联机这一节 (开头加在简报最前面): 世界是别人的, 只能像玩家一样操作; 工具比沙盘少, 写清楚免得模型照沙盘的习惯试 */
export function onlineBrief(o: { name: string; server: boolean; readOnly: boolean; steam?: boolean; rcon?: boolean; /** 用户自己的新图: 没有别人的建筑, 不用协助模式那些规矩 */ ownWorld?: boolean }): string {
  if (o.rcon) return `## 先读这一节 (联机服务器, RCON + 模组)

- **你是谁**: 游戏里叫 \`${o.name}\`, 是服务器上的角色 (服务器装了我们的模组, 不是真客户端), 命令和沙盘一样 (\`paste\`、\`construct\`、\`order_set\` 这些都能用; \`./plan\`、\`./bp build\` 这里没接)。
- **这里是别人的世界 (协助模式)**: 这条路工具不拦, 你自己守: 不拆不改别人的建筑和设置; 共享的材料每样不超过库存一半, 不掏空别人在用的箱子; 自己建的自己维护; 大事先在聊天里问。
- **队友是真人**: 回复点对方名字, 收到指令先回"收到 + 打算怎么做", 动手前说、做完报, 带坐标; 任务排队不插队, 紧急才打断。话发 \`./fh say "..."\`。
- **语言**: 全部简体中文; 建筑物品用官方中文名 (ref/names.tsv)。
${o.readOnly ? "- **现在只读**: 所有动作都会被拒。只看世界、看聊天, 不要试动作。\n" : ""}
**还能用**: \`./know 关键词\` 查全部经验, \`./calc\` 算配比, \`./bp study 物品\` 看别人怎么摆。

`;
  const place = o.ownWorld ? "用户自己的新图" : o.server ? "朋友的联机服务器" : "本机沙盘 (照联机的样子跑: 服务器没装我们的模组)";
  const social = o.ownWorld
    ? "- **这张图只有你一个人**: 从空手开始, 开着虫子, 东西都是你自己的, 想拆就拆。\n"
    : `- **这里是别人的世界 (协助模式)**: 工具会拦, 但你也要知道为什么: 不拆不改别人的建筑和设置 (\`mine\`、\`rotate\` 只能动自己放的, 矿、树、石头随便挖); 共享的材料可以用, 每样不超过库存一半, 不掏空别人在用的箱子; 自己建的自己维护; 大事先在聊天里问。
- **队友是真人**: 回复点对方名字, 收到指令先回"收到 + 打算怎么做", 动手前说、做完报, 带坐标; 任务排队不插队, 紧急才打断。话发 \`./fh say "..."\`。
`;
  return `## 先读这一节 (${place})

- **你是谁**: 游戏里叫 \`${o.name}\`, 是一个真的玩家客户端${o.steam ? " (用户的账号, 用户要拿成就: 只走普通玩家操作, 这里也没有别的路)" : ""}。服务器上没有我们的模组, 没有控制台, 你做的每件事都和真人一样: 走路要时间、够不着要走过去、东西要在背包里。
${social}- **语言**: 全部简体中文; 建筑物品用官方中文名 (ref/names.tsv)。
${o.readOnly ? "- **现在只读**: 所有动作都会被拒。这一班只看世界、看聊天、说明你看到了什么, 不要试动作。\n" : ""}
**读得到的范围**: 你身体所在的地表; 流体、红绿线、物流网、别的玩家每条命令有限量 (超了那条回复里就缺, 过几秒再查); 想看别的地表要先过去。水和岩浆 \`map\` 上有; 找水用 \`./fh call nearest_water\` (\`nearest\` 只找实体, 找不到地块), 它给最近的水格, 算不出抽水机能放哪: 放在紧贴水面的岸上那一格试, 朝向由水岸决定, 放上后看 \`inspect\` 的出水口; 第一次看一片地要读地块, 多等几秒。世界大时 \`status\`、\`science\`、\`power\` 一条要几秒, 别轮询; 谁拆了什么读不到, 别猜是谁干的。
**能做的动作 (都走玩家操作, 一条命令做完才回)**: \`move_to\`、\`build\` (可批量 builds, 可带 direction、recipe)、\`build_path\`、\`transfer\`、\`collect\`、\`refuel\`、\`feed\`、\`craft\`、\`mine\`、\`rotate\`、\`research\`、\`say\`、\`shoot\` (\`{"auto":true,"ticks":300}\` 打最近的敌人, 或 \`{"position":{…},"ticks":120}\` 打那一点; 一条最多 600 tick, 打完才回; \`retreat\` 给 \`{"to":{…},"health_below":0.4}\` 血少了就撤; 射程看枪, 手枪 15 格)。读世界的命令照常 (\`status\`、\`observe\`、\`inspect\`、\`inventory\`、\`nearest\`、\`stock\`…), \`sleep\` 也能用。
**整块放**: \`./bp list 物品\` 看现成的块, \`./bp build 编号或自己的.json --at x,y [--dir east]\` 一次放一整块: 先查放不放得下、差的料从近处拿、拆掉挡路的树石, 一件件亲手放 (约 3 秒一件, 放不完回下一条命令)。没有虚影和机器人; 红绿线、过滤器、模块不带, 要自己补。
**死了**: 等十来秒在出生点复活, 背包留在尸体上; 走过去 \`./fh call mine --args '{"position":{尸体的位置}}'\` 东西全回背包 (\`recover\` 这里用不了)。尸体的位置 \`./fh call nearest --args '{"type":"character-corpse","radius":128}'\`。
**研究**: \`./fh call research\` 查队列, \`{"technology":…}\` 排上, \`{"remove":…}\` 取消 (依赖它的一起拿掉)。
**这里没有**: 虚影 (\`paste\`、\`construct\`、\`place_ghosts\`)、\`./plan\`、常驻命令 (\`order_set\`、队列)、\`belt_route\`、\`wire\`。会被明确拒绝, 不要反复试; 要长线就 \`build_path\` 分段铺。
**还能用**: \`./know 关键词\` 查全部经验, \`./calc\` 算配比, \`./bp study 物品\` 看别人怎么摆。做动作时回复里会自动带相关教训。
**节奏**: 放一个建筑约 3 秒, 取放约 2 秒, 带子每格约 1 秒, 走路一秒约 9 格。一条命令最多走 64 格 (再远先 \`move_to\`), 批量的干 60 秒先回做了多少。

`;
}

/** 我们的知识放进角色目录的 ref/ (./fh help pilot-主题、./know 的全文): run.ts 和 online.ts 共用 */
export function copyPilotRefs(repo: string, refDir: string) {
  void repo; // 第二版从 <仓库>/knowledge 拷; 新项目在 training/ (src/lab/gamedir.ts knowledgeFile)
  for (const f of fs.readdirSync(knowledgeFile("patterns"))) if (f.endsWith(".md") && f !== "README.md") fs.copyFileSync(path.join(knowledgeFile("patterns"), f), path.join(refDir, `pilot-${f}`));
  fs.copyFileSync(knowledgeFile("facts.md"), path.join(refDir, "pilot-facts.md"));
  fs.copyFileSync(knowledgeFile("ref-index.md"), path.join(refDir, "index.md"));
  fs.copyFileSync(path.join(repo, "docs", "research", "players", "game-tips.md"), path.join(refDir, "pilot-game-tips.md"));
  fs.mkdirSync(path.join(refDir, "research"), { recursive: true });
  for (const f of fs.readdirSync(path.join(repo, "docs", "research", "players"))) if (f.endsWith(".md")) fs.copyFileSync(path.join(repo, "docs", "research", "players", f), path.join(refDir, "research", f));
}
