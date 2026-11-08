// 派对整套代理配置 (库, 不直接运行): factorio-ai-party (MIT, 见 NOTICE) 给大脑的简报 AGENTS.md、参考手册 ref/ (`./fh help 主题`)
// 和宿主命令行 ./fh。用户定 (backlog #157): 第九轮大脑手里没有 harness 说明书, 301 条命令只查了 9 次, 猜参数失败 13%;
// 说明书一直在他们仓库里, 是我们只搬了模组、命令行和简报自己写。
// 只改: 2.1、中文和用户定的规矩、接手玩到一半的世界、我们的监工收件箱 / 体检; 去掉直播 / 观众 / 截图 / Mac 路径。
// 简报和手册在运行时从本机的派对仓库生成 (.env 的 PARTY_REPO), 不进我们的仓库。
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { argvFilePs1 } from "./ps1-wrap.ts";
import { bashExe } from "./shell.ts";
import { fhCliPath } from "./fh-cli.ts";
import { setupRef } from "../../core/run/workspace.ts";
import { composeBrief } from "../../core/run/brief.ts";

export type KitOpts = {
  partyRepo: string;
  dir: string;
  name: string;                 // 角色名 (玩家名或 bot 名)
  who: number | string;         // 玩家编号, 或 bot 名
  teammate?: { name: string; notes: string };
  /** 全队名单 (名字 + 模型), 写进简报 */
  team?: string;
  role?: string;
  /** 沙盘: 经 RCON 连游戏里的模组 */
  rconPort?: number;
  passwordFile?: string;
  /** 联机: 经这个管道连游戏外的模组 + 玩家操作 (src/io/mod-broker.ts); 没有 RCON */
  socket?: string;
  deadline: number;             // 毫秒时间戳
  resume: boolean;              // 接手已有世界 (不是新地图)
  ours: string;                 // 我们加在最前面的一节 (中文、用户定的规矩、监工)
  nodeBin: string;
  shim: string;                 // src/play/fh-shim.ts
  protoRoot: string;            // 游戏导出的原型数据 (聊天加标签用)
};

const fwd = (p: string) => p.replace(/\\/g, "/");

/** 派对 tools/new-run.sh 的 notes.md 骨架 (7 节) */
export const PARTY_NOTES = `# Notes

## Now

## Claims and coordinates

## Team agreements

## Open board items

## Milestones

## Lessons

## Log
`;

/** 双人合作一节 (改自派对 agent/coop.md: 去掉观众; 两个角色都是 Claude) */
export function coopText(): string {
  return `## Co-op

Two AI agents share this world:

- \`MK\` (player 1): Claude Opus
- \`ai2\` (bot): Claude Opus

You are \`{{PLAYER}}\`; your teammate is \`{{TEAMMATE}}\`. You share the factory, research and power; each of you
controls only your own character and inventory. Your \`./fh\` already targets your character.

- Chat: \`./fh say "..."\` posts in the game chat as you (keep it short and specific). A reply carries
  \`chat: unread=N latest=...\` when a new message arrived; \`./fh chat\` shows your unread messages. Answer your teammate promptly.
- In your first minute, agree on a split of work. Suggested start: {{ROLE}}. Renegotiate as the base grows.
- Claim areas before building and don't build inside your teammate's claim without asking. Announce shared
  infrastructure (power poles, main belts) when you build it.
- Hand items over through a chest: put them in, then say what and where.
- Your teammate's notes are readable at \`{{TEAMMATE_NOTES}}\`; keep yours useful to them (claims, layout, plans).
- When you're waiting on your teammate, say so, then do something else useful.
- A human (the user) may join the chat. Answer briefly and keep playing.
`;
}

/** 派对简报里依赖他们环境的句子改掉 (找不到就跳过, 返回没改到的, 供日志提示) */
export function adaptBrief(text: string, ours: string): { text: string; missed: string[] } {
  const missed: string[] = [];
  text = text.replace(/\r\n/g, "\n"); // 派对的 brief.py 在 Windows 上按文本模式写, 是 CRLF
  const sub = (re: RegExp, to: string, tag: string) => { if (re.test(text)) text = text.replace(re, to); else missed.push(tag); };
  sub(/in a Factorio 2\.0\.\d+ multiplayer world/, "in a Factorio 2.1.24 multiplayer world (a private sandbox; where this file says 2.0, 2.1 is what runs)", "版本");
  sub(/- Pictures:[\s\S]*?\n- More detail:[^\n]*\n/, "- Pictures: `./fh view --out view.png` draws a schematic map; open it with Read.\n", "截图");
  sub(/Play only through `\.\/fh` and `\.\/shot`\./, "Play only through `./fh`.", "shot");
  sub(/never read\s+`~\/\.config\/pog`,\s*/, "", "pog");
  sub(/ or as a short `python3` script/, "", "python3");
  sub(/- `stream-people`[\s\S]*?\n(?=- `space-age`)/, "", "直播主题");
  // 我们的一节放在标题之后、正文之前
  text = text.replace(/^# You are playing Factorio\n/, `# You are playing Factorio\n\n${ours.trim()}\n`);
  return { text, missed };
}

/** 中文简报 (src/play/brief-zh.md, 派对 AGENTS.md 正文的翻译; 第十一轮: 英文简报下大脑一半的话是英文): 手册主题列表从英文简报里原样取 */
export function zhBrief(template: string, english: string, v: { ours: string; player: string; teammate?: string; teammateNotes?: string; role?: string; p1: string; team?: string }): string {
  const en = english.replace(/\r\n/g, "\n");
  const a = en.indexOf("## Reference topics\n"), b = en.indexOf("\n## Your shell");
  const refIndex = a >= 0 ? topicIndex(en.slice(en.indexOf("\n", a) + 1, b > a ? b : undefined)) : "(见 ./fh help)";
  // 两个人才有"那个队友"; 5 个人的班原来也只写一个 (2026-11-05 发现: 每个大脑都以为只有 mkdm 是队友, 笔记路径也只给它的)
  const many = (v.team ?? "").split("、").length > 2;
  const coop = v.teammate ? `## 合作

全队: ${v.team ?? `\`${v.p1}\`、\`${v.player}\``}。你是 \`${v.player}\`${many ? "" : `; 队友是 \`${v.teammate}\``}。工厂、研究、电力共享; 各自只控制自己的角色和背包。

- 自己组织分工, 没有指定的领队。每人至少负责一件事, 交出去时同一句里接一件新的。负责不等于只做它: 看板、告警、工厂里的事谁都可以做。${v.role ? ` 建议开头: ${v.role}。` : ""}
- **修、建、改不用先问** (除非看板上团队定的规矩要求问), 做完告诉负责人。
- 建之前先在看板认领区域 (\`./fh board\`, \`./fh help team\`)。建共用设施 (电线杆、主带) 时说一声。
- 聊天: \`./fh say "..."\` 所有人看得到, 短、具体; \`./fh tell 名字 "..."\` 只给他, 能叫醒他。别刷屏: 进度写看板和 notes.md, 聊天只说别人要知道的。
- 交东西走箱子: 放进去, 再说是什么、在哪。队友的笔记在 \`${many ? "../<他的目录 a、b、c…>/notes.md" : v.teammateNotes}\`, 你的也要对他有用。
- 等队友时说一声, 然后去做别的有用的事。

` : "";
  return template.replace("{{OURS}}", v.ours.trim()).replace(/\{\{PLAYER\}\}/g, v.player).replace(/\{\{COOP\}\}\r?\n/, coop) /* CRLF 检出 (core.autocrlf=true) 时模板是 \r\n */.replace("{{REF_INDEX}}", refIndex);
}

/** 手册目录缩成"主题: 讲什么": 命令清单在 describe.json 和 ./fh help 里都有, 不用占简报 */
export function topicIndex(raw: string): string {
  const rows: string[] = [];
  for (const item of ("\n" + raw.replace(/\r\n/g, "\n")).split(/\n- /).slice(1)) {
    const m = /^`([a-z-]+)`,\s*([\s\S]*?):\s/.exec(item.replace(/\s+/g, " ").trim() + " ");
    if (m && m[1] !== "stream-people") rows.push(`- \`${m[1]}\`: ${m[2]}`);
  }
  return rows.length ? rows.join("\n") : "(见 ./fh help)";
}

/** 完整工具 (派对 POG_FULL_TOOLS, 公开局开着: tools/public-start.sh:36): 自己的 tools/、共享的 team-tools/、游戏数据、Python。
 *  大脑自己写的计算器 / 规划脚本它才会用 (派对第 28 班 team-tools 187 个文件)。只在本机沙盘; 联机 (M7) 前要重新看权限, Windows 上没有沙箱, Python 能读本机任何文件。 */
export function setupFullTools(o: { dir: string; shared: string; prevTools?: string; prevShared?: string; gamedataDir: string }): void {
  const tools = path.join(o.dir, "tools");
  fs.mkdirSync(tools, { recursive: true });
  fs.mkdirSync(o.shared, { recursive: true });
  if (o.prevTools) copyTools(o.prevTools, tools);
  if (o.prevShared) copyTools(o.prevShared, o.shared);
  const lib = fhLibPy(bashExe(), o.gamedataDir);
  fs.writeFileSync(path.join(tools, "fhlib.py"), lib);
  fs.writeFileSync(path.join(o.shared, "fhlib.py"), lib);
}

/** 一班带到下一班 (派对 tools/full_tools.py carry 的规矩: 超过 5MB、缓存、点开头的文件不带) */
export function copyTools(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "__pycache__") continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyTools(a, b);
    else if (e.isFile() && fs.statSync(a).size <= 5 * 1024 * 1024) fs.copyFileSync(a, b);
  }
}

const fhLibPy = (bash: string, gamedata: string) => `# 自动生成: Python 脚本里调游戏和读游戏数据。脚本在角色目录下运行 (python tools/x.py), 只有 ./fh 能动游戏。
import json, os, subprocess
BASH, GAMEDATA = ${JSON.stringify(fwd(bash))}, ${JSON.stringify(fwd(gamedata))}
def fh(*args, timeout=900):
    """跑一条 ./fh, 返回输出文字。例: fh("call", "status")"""
    r = subprocess.run([BASH, "./fh", *map(str, args)], capture_output=True, encoding="utf-8", errors="replace", timeout=timeout)
    return r.stdout + r.stderr
def call(action, **args):
    """跑一个动作, 返回解析好的回复。例: call("recipes", name="iron-plate")"""
    return json.loads(fh("call", action, "--format", "json", "--args", json.dumps(args, ensure_ascii=False)))
def gamedata(kind):
    """这个版本的原型数据, 按种类: recipe、technology、item、fluid、assembling-machine… 文件名看 os.listdir(GAMEDATA)"""
    with open(os.path.join(GAMEDATA, kind + ".json"), encoding="utf-8") as f:
        return json.load(f)
`;

/** 原型数据按种类拆成小文件 (派对给大脑的 gamedata/; 整个 dump 29MB, 读一次太慢): 只拆一次, 放本机数据目录, 不进仓库 */
export function ensureGamedata(dumpFile: string, outDir: string): string {
  if (fs.existsSync(path.join(outDir, "recipe.json"))) return outDir;
  fs.mkdirSync(outDir, { recursive: true });
  const raw = JSON.parse(fs.readFileSync(dumpFile, "utf8")) as Record<string, unknown>;
  for (const [kind, rows] of Object.entries(raw)) if (rows && typeof rows === "object") fs.writeFileSync(path.join(outDir, `${kind}.json`), JSON.stringify(rows));
  return outDir;
}

/** 本地时间 + 时区偏移, 派对 deadline.ts 认的格式 (它把 CST 当美国中部时间, 所以写数字偏移) */
export function deadlineText(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** 生成一个大脑工作目录: AGENTS.md / CLAUDE.md、ref/、./fh、deadline.txt; notes.md 由调用方放 (接班带上一班的) */
export function setupPartyWorkspace(o: KitOpts): { missed: string[] } {
  fs.mkdirSync(o.dir, { recursive: true });
  // 本机没有派对仓库 (重构后不下载别人的项目): 简报和手册用我们自己的训练集 (training/manuals, 和不装模组那条路同一份), 命令行用 commands/cli
  if (!o.partyRepo || !fs.existsSync(path.join(o.partyRepo, "tools", "brief.py"))) return ownWorkspace(o);
  // POG_SPACE_AGE=1: 派对公开局开着, 太空时代的说明 (agent/spaceage.md) 放在 ref/space-age.md 开头; 我们一直漏了 (2026-11-05 对源码时发现)
  const env = { ...process.env, PYTHONUTF8: "1", POG_SPACE_AGE: "1" };
  const brief = path.join(o.partyRepo, "tools", "brief.py");
  const time = fs.readFileSync(path.join(o.partyRepo, "agent", "time-realtime.md"), "utf8");
  const coop = o.teammate ? coopText() : "";
  execFileSync("python", ["-I", "-X", "utf8", brief, "write", o.dir, o.name, time, coop, o.teammate?.name ?? "", o.teammate?.notes ?? "", o.role ?? ""], { cwd: o.partyRepo, env, stdio: "pipe" });
  execFileSync("python", ["-I", "-X", "utf8", brief, "harness", o.dir, "claude"], { cwd: o.partyRepo, env, stdio: "pipe" });
  const english = fs.readFileSync(path.join(o.dir, "AGENTS.md"), "utf8");
  let { text, missed } = adaptBrief(english, o.ours);
  const tpl = path.join(path.dirname(o.shim), "brief-zh.md");
  if (fs.existsSync(tpl)) {
    const p1 = typeof o.who === "number" ? o.name : o.teammate?.name ?? "MK";
    text = zhBrief(fs.readFileSync(tpl, "utf8"), english, { ours: o.ours, player: o.name, teammate: o.teammate?.name, teammateNotes: o.teammate?.notes, role: o.role, p1, team: o.team });
    fs.writeFileSync(path.join(o.dir, "AGENTS.en.md"), adaptBrief(english, o.ours).text); // 英文原版留着对照
  }
  // knowledge/brief-points.md 的要点不再并进简报正文 (进了简报第 5 班照样不用): 做动作时教训库自动带出 (lessons-seed), 监工和开班扫描按情况附, 手册 building / analysis / moving-items 末尾有全文
  fs.writeFileSync(path.join(o.dir, "AGENTS.md"), text);
  fs.writeFileSync(path.join(o.dir, "CLAUDE.md"), text); // Claude Code 读 CLAUDE.md (派对用软链, Windows 上复制)
  fs.rmSync(path.join(o.dir, "ref", "stream-people.md"), { force: true });
  writeFh(o, missed);
  // describe.json: 一行一个动作 (派对 launch-agent.sh 开班前写好, 简报里叫大脑 grep 它)
  // 联机: 代理和这里在同一个进程, 同步等子进程会把代理堵死 (仓库 CLAUDE.md 工具坑), 由调用方异步跑 writeDescribeJson
  if (!o.socket) try {
    // 用 Git Bash 跑 (src/play/shell.ts): PowerShell 里起班时 PATH 上没有 sh, 以前这步会静默失败
    // FH_MAX_OUTPUT=0: 这条是我们自己要整段 JSON 的, 不走给大脑的 ./fh 输出封顶 (2026-11-05 真跑: 封顶在 7200 字处插了省略说明, JSON 解析失败, 4 个角色都没有 describe.json)
    const raw = execFileSync(bashExe(), [path.join(o.dir, "fh"), "call", "describe", "--format", "json"], { cwd: o.dir, env: { ...env, FH_MAX_OUTPUT: "0" }, encoding: "utf8", timeout: 60_000 });
    const lines = execFileSync("python", ["-I", "-X", "utf8", path.join(o.partyRepo, "tools", "describe-lines.py")], { input: raw, env, encoding: "utf8" });
    fs.writeFileSync(path.join(o.dir, "describe.json"), lines);
  } catch { missed.push("describe.json"); }
  return { missed };
}

/** 没有派对仓库时的角色目录: 简报 = 训练集的模板 (manuals/brief.md) + 装模组这条路的说明 + 我们的规矩 (o.ours); 手册 = 训练集 manuals/ref + 思路 + 事实 (和不装模组那条路同一份) */
function ownWorkspace(o: KitOpts): { missed: string[] } {
  const refDir = path.join(o.dir, "ref");
  setupRef(refDir);
  const team = o.team ? `- **全队**: ${o.team}${o.teammate ? `; 队友 \`${o.teammate.name}\` 的笔记在 ${o.teammate.notes}` : ""}\n` : "";
  const world = `## 先读这一节 (本机沙盘, 服务器装了我们的模组)

- **你是谁**: 游戏里叫 \`${o.name}\`, 是服务器上的角色 (模组造的, 不是真客户端)。命令全部能用, 在游戏里由模组执行: 铺线 (\`pole_route\`、\`belt_route\`、\`pipe_route\`)、虚影 (\`place_ghosts\`、\`paste\`) 和 \`construct\` 去建、常驻命令 (\`order_set\`) 和队列、配置、装备、载具都有。参数拿不准先 \`./fh help 动作\`。
- **算和建**: \`./calc\` 算配比; \`./plan 物品 每分钟\` 算全链并找空地, 加 \`--build\` 直接放; \`./bp list\` / \`./bp show\` / \`./bp build 编号 --at x,y\` 整块建 (这条路上贴虚影再建, 比一件件手放快得多)。整条线先 \`./plan\`, 别一台台手摆。
${team}${o.role ? `- **这一班你主要负责**: ${o.role}\n` : ""}- **语言**: 全部简体中文; 建筑物品用官方中文名 (ref/names.tsv)。
${o.resume ? "- **接着上一班的世界玩**: 先读 notes.md 和开班扫描, 别重建已有的东西。\n" : ""}`;
  const text = composeBrief({ world: `${o.ours.trim()}\n\n${world}`, name: o.name, refDir });
  fs.writeFileSync(path.join(o.dir, "AGENTS.md"), text);
  fs.writeFileSync(path.join(o.dir, "CLAUDE.md"), text);
  const missed: string[] = ["describe.json (没有派对仓库; ./fh help 动作 照样查得到)"];
  writeFh(o, missed);
  return { missed };
}

/** deadline.txt 和 ./fh (sh + ps1): 派对整套和我们自己的角色目录共用 */
function writeFh(o: KitOpts, missed: string[]): void {
  fs.writeFileSync(path.join(o.dir, "deadline.txt"), deadlineText(o.deadline) + "\n");
  const who = typeof o.who === "string" ? `--bot '${o.who}'` : `--player ${o.who}`;
  // 派对命令行的 --bot 名字校验放开 (src/play/fh-cli.ts; 2026-11-05 真跑: 模型名当角色名被客户端拦, 服务器角色一条命令都发不出)
  const cli = fhCliPath(o.partyRepo);
  if (!cli.patched) missed.push("cli.js 的角色名校验 (上游改了写法? 服务器角色的命令会被拦)");
  // 联机: 管道代替 RCON; 动作要做几秒, --timeout 给够 (不然命令行 5 秒没回就重发, 回复里多一段"重发了几次"; io-client.md 11j 第七块); FH_ONLINE: 回复后面不提沙盘才有的 ./plan ./bp build
  const link: Record<string, string> = o.socket ? { FH_SOCKET: o.socket, FH_ONLINE: "1" } : { FACTORIO_RCON_HOST: "127.0.0.1", FACTORIO_RCON_PORT: String(o.rconPort), FACTORIO_RCON_PASSWORD_FILE: o.passwordFile ?? "" };
  const timeoutArgs = o.socket ? ["--timeout", "90000"] : [];
  fs.writeFileSync(path.join(o.dir, "fh"), [
    "#!/bin/sh",
    `export ${Object.entries(link).map(([k, v]) => `${k}='${fwd(v)}'`).join(" ")}`,
    `export FH_REF_DIR='${fwd(path.join(o.dir, "ref"))}' FH_DEADLINE_FILE='${fwd(path.join(o.dir, "deadline.txt"))}' PYTHONUTF8=1`,
    `export FH_CLI='${fwd(cli.cli)}' FH_PROTO='${fwd(o.protoRoot)}'`,
    `exec '${fwd(o.nodeBin)}' '${fwd(o.shim)}' "$@" ${who} ${timeoutArgs.join(" ")} --journal '${fwd(path.join(o.dir, "journal.jsonl"))}'`,
    "",
  ].join("\n"));
  // PowerShell 版 fh.ps1 (Grok Build 在 Windows 上用 PowerShell; 参数写成文件交给 node, src/play/ps1-wrap.ts / argv-file.ts); 环境和 sh 版一样
  fs.writeFileSync(path.join(o.dir, "fh.ps1"), argvFilePs1(o.nodeBin, path.join(path.dirname(path.dirname(path.dirname(o.shim))), ".env"), o.shim,
    [...(typeof o.who === "string" ? ["--bot", o.who] : ["--player", String(o.who)]), ...timeoutArgs, "--journal", path.join(o.dir, "journal.jsonl")],
    { ...link, FH_REF_DIR: path.join(o.dir, "ref"), FH_DEADLINE_FILE: path.join(o.dir, "deadline.txt"), PYTHONUTF8: "1",
      FH_CLI: cli.cli, FH_PROTO: o.protoRoot }));
}

/** 联机用的 describe.json: 和上面同一件事, 异步 (代理在同一个进程); 失败回 false, 不影响开工 */
export async function writeDescribeJson(dir: string, partyRepo: string): Promise<boolean> {
  const run = promisify(execFile);
  const env = { ...process.env, PYTHONUTF8: "1", POG_SPACE_AGE: "1", FH_MAX_OUTPUT: "0" };
  try {
    const { stdout } = await run(bashExe(), [path.join(dir, "fh"), "call", "describe", "--format", "json"], { cwd: dir, env, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const p = execFile("python", ["-I", "-X", "utf8", path.join(partyRepo, "tools", "describe-lines.py")], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }, () => undefined);
    const lines = await new Promise<string>((resolve, reject) => {
      let out = "";
      p.stdout!.on("data", (d: string) => { out += d; });
      p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`describe-lines 退出 ${code}`))));
      p.stdin!.end(stdout);
    });
    fs.writeFileSync(path.join(dir, "describe.json"), lines);
    return true;
  } catch { return false; }
}

/** 手搬统计 (照派对 tools/factory_digest.py 手搬那一行): since 之后成功的 transfer / collect / refuel / feed 次数, 按物品分。
 *  按次数不按件数: 走过去搬的定时动作, 件数要等做完才知道, 第一次回复里没有 (第十三轮旁路脚本按件数算成了 0) */
export function haulCounts(journal: string, since: number): { calls: number; byItem: [string, number][] } {
  if (!fs.existsSync(journal)) return { calls: 0, byItem: [] };
  const req = new Map<string, any>();
  const by: Record<string, number> = {};
  let calls = 0;
  for (const line of fs.readFileSync(journal, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (Date.parse(e.at) < since) continue;
    if (e.event === "request" && e.request?.id) req.set(e.request.id, e.request);
    else if (e.event === "response" && e.response?.ok) {
      const q = req.get(e.response.id);
      if (!q || !["transfer", "collect", "refuel", "feed"].includes(q.action)) continue;
      calls++;
      const items = q.args?.items ? Object.keys(q.args.items) : [q.args?.item ?? q.args?.fuel ?? (q.action === "refuel" ? "fuel" : "?")];
      for (const it of items) by[it] = (by[it] ?? 0) + 1;
    }
  }
  return { calls, byItem: Object.entries(by).sort((a, b) => b[1] - a[1]) };
}

/** 派对 journal.jsonl (请求 / 回复两条一组) → 我们 requests.jsonl 的格式, 汇总和窥看共用; 等待里的 status / sleep_check 轮询标 wait */
export function journalToRequests(journal: string, agent: string): { t: number; id: string; action: string; args: unknown; ok: boolean; ms: number; tick?: number; error?: string; wait?: boolean; agent: string }[] {
  if (!fs.existsSync(journal)) return [];
  const req = new Map<string, { at: number; action: string; args: unknown }>();
  const out: ReturnType<typeof journalToRequests> = [];
  for (const line of fs.readFileSync(journal, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.event === "request" && e.request?.id) req.set(e.request.id, { at: Date.parse(e.at), action: e.request.action, args: e.request.args });
    else if (e.event === "response" && e.response?.id && req.has(e.response.id)) {
      const q = req.get(e.response.id)!;
      req.delete(e.response.id);
      const r = e.response;
      out.push({ t: q.at, id: r.id, action: q.action, args: q.args, ok: !!r.ok, ms: Date.parse(e.at) - q.at, tick: r.tick, agent,
        // observe scope=sleep_check 是 ./fh sleep 自己的轮询, 不是大脑在查 (2026-11-05 查出: 第 5 班 A 一个角色 3061 次, "查询占比 85%" 大半是它)
        ...(r.ok ? {} : { error: `${r.error?.code}: ${r.error?.message}` }), ...(q.action === "status" || q.action === "sleep_check" || (q.args as { scope?: string } | null)?.scope === "sleep_check" ? { wait: true } : {}) });
    }
  }
  return out;
}
