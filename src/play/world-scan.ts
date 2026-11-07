// 开班扫描 (库, 不直接运行):
// 开班 / 接手存档 / 进联机服务器时先把世界摸一遍 → 现状 (时间、研究、产量、机器、体检)、判断 (到哪个阶段、最大的问题)、规划 (下一档要补什么、先修什么、几个人怎么分工)。
// 写成 world-scan.md 给每个大脑当第一份材料 (run.ts), 同时写 world-scan.json 给界面 (控制接口 GET /api/scan → 右栏"群公告"最上面)。
// 材料都是已有的: 产量用游戏的生产统计 (近 10 分钟), 机器 / 科技用 expand.ts 的 EXISTING_LUA, 体检用 health.ts, 下一档用 expand.ts 的 propose。纯函数 composeScan 有单元测试。
import type { Delta, Existing, Rates, Rung } from "./expand.ts";

/** 游戏里一次读完 (RCON / 沙盘 lab.exec); 联机时由 io-client 用只读查询拼同样的结构 */
export const SCAN_LUA = `local s = game.surfaces[1] local f = game.forces.player
local P = defines.flow_precision_index local st = f.get_item_production_statistics(s)
local function ten(name) local ok, v = pcall(function() return st.get_flow_count{name = name, category = "input", precision_index = P.ten_minutes, count = true} end) return ok and (v or 0) / 10 or 0 end
local n = 0 for _, t in pairs(f.technologies) do if t.researched then n = n + 1 end end
local q = {} for _, t in pairs(f.research_queue or {}) do q[#q + 1] = t.name end
local labs, working = 0, 0 for _, l in pairs(s.find_entities_filtered{type = "lab", force = f}) do labs = labs + 1 if l.status == defines.entity_status.working then working = working + 1 end end
local surfaces = {} for _, sf in pairs(game.surfaces) do surfaces[#surfaces + 1] = sf.name end
local silos = s.count_entities_filtered{type = "rocket-silo", force = f}
local cx, cy = 0, 0 local firstLab = s.find_entities_filtered{type = "lab", force = f, limit = 1}[1] if firstLab then cx, cy = firstLab.position.x, firstLab.position.y end
local nests, best, bx, by = 0, nil, 0, 0 for _, e in pairs(s.find_entities_filtered{force = "enemy", type = "unit-spawner"}) do nests = nests + 1 local d = ((e.position.x - cx) ^ 2 + (e.position.y - cy) ^ 2) ^ 0.5 if not best or d < best then best, bx, by = d, e.position.x, e.position.y end end
local enemy = {peaceful = s.peaceful_mode, nests = nests, nearest = best and math.floor(best) or 0, x = bx, y = by, polluted = best and s.get_pollution({bx, by}) or 0, turrets = s.count_entities_filtered{force = f, type = {"ammo-turret", "electric-turret", "fluid-turret"}}}
return {enemy = enemy, tick = game.tick, researched = n, research = f.current_research and f.current_research.name or "", queue = q, labs = {total = labs, working = working},
  rates = {red = ten("automation-science-pack"), green = ten("logistic-science-pack"), blue = ten("chemical-science-pack"), military = ten("military-science-pack"), purple = ten("production-science-pack"), yellow = ten("utility-science-pack"), space = ten("space-science-pack")},
  rockets = f.rockets_launched or 0, silos = silos, surfaces = surfaces, players = #game.connected_players, entities = s.count_entities_filtered{force = f}}`;

export type ScanRaw = {
  tick: number; researched: number; research: string; queue: string[]; labs: { total: number; working: number };
  rates: { red: number; green: number; blue: number; military?: number; purple?: number; yellow?: number; space?: number };
  rockets: number; silos: number; surfaces: string[]; players: number; entities: number;
  /** 虫子和防御; 老读数没有 */ enemy?: { peaceful: boolean; nests: number; nearest: number; x: number; y: number; polluted: number; turrets: number };
};
export type ScanInput = {
  raw: ScanRaw; existing: Existing; health: string[];
  /** 下一档 (expand.ts propose 的结果): 目标、差额、是否已达 */
  rung: Rung; deltas: Delta[]; reached: boolean;
  /** 这一班几个角色 */
  seats: number; zh: (n: string) => string;
  /** 开班和平还剩几分钟 (src/play/peace.ts); 这段时间读到和平开着, 但这个世界是有虫子的 */
  peaceMinutes?: number;
  /** 按判断 / 规划 / 体检的句子挑我们核实过的要点和蓝图候选 (src/play/hints.ts hintsForLines; 没给就没有这一节) */
  hintsFor?: (lines: string[]) => string[];
  /** 本机有全图布局 (lab-data/friend-world): 阶段提示里列分区图 */
  hasWorldMap?: boolean;
};
export type Scan = { at: string; stage: string; summary: string; lines: string[]; judgement: string[]; plan: string[]; hints: string[]; md: string };

const r1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const nz = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export function normalizeScan(raw: unknown): ScanRaw {
  const r = (raw ?? {}) as Partial<ScanRaw>;
  const rates = (r.rates ?? {}) as Partial<ScanRaw["rates"]>;
  return { tick: nz(r.tick), researched: nz(r.researched), research: typeof r.research === "string" ? r.research : "", queue: Array.isArray(r.queue) ? r.queue.filter((x): x is string => typeof x === "string") : [],
    labs: { total: nz(r.labs?.total), working: nz(r.labs?.working) }, rates: { red: nz(rates.red), green: nz(rates.green), blue: nz(rates.blue), military: nz(rates.military), purple: nz(rates.purple), yellow: nz(rates.yellow), space: nz(rates.space) },
    rockets: nz(r.rockets), silos: nz(r.silos), surfaces: Array.isArray(r.surfaces) ? r.surfaces.filter((x): x is string => typeof x === "string") : [], players: nz(r.players), entities: nz(r.entities),
    ...(r.enemy && typeof r.enemy === "object" ? { enemy: { peaceful: r.enemy.peaceful !== false, nests: nz(r.enemy.nests), nearest: nz(r.enemy.nearest), x: nz(r.enemy.x), y: nz(r.enemy.y), polluted: nz(r.enemy.polluted), turrets: nz(r.enemy.turrets) } } : {}) };
}

/** 到哪个阶段了 (按产量和里程碑判断, 不按机器数: 机器摆着不出货不算) */
export function stageOf(raw: ScanRaw, existing: Existing): string {
  const r = raw.rates;
  if (raw.surfaces.some((s) => /platform|vulcanus|fulgora|gleba|aquilo/i.test(s))) return "太空时代: 已有太空平台或别的星球";
  if (raw.rockets > 0) return "已发射火箭, 准备太空";
  if (raw.silos > 0) return "火箭发射井已建, 还没发射";
  if ((r.space ?? 0) > 0 || (r.yellow ?? 0) > 0 || (r.purple ?? 0) > 0) return "紫 / 黄瓶阶段";
  if (r.blue > 0.5) return "蓝瓶已自动化";
  if (existing.tech.oil || (existing.assemblers["chemical-science-pack"] ?? 0) > 0) return "绿瓶阶段, 蓝瓶在起步 (石油已研究或蓝瓶机已摆)";
  if (r.green > 0.5) return "绿瓶阶段";
  if (r.red > 0.5) return "红瓶阶段";
  if (raw.researched < 5 && raw.entities < 200) return "刚开局";
  return "有基地但科研停着";
}

const STAGE_LOOKUPS: [RegExp, string[]][] = [
  [/太空时代|已发射|发射井/, ["./fh help space-age", "./fh help pilot-progression P-prog-18", "./know 太空平台"]],
  [/紫 \/ 黄瓶/, ["./know 插件", "./know 火箭", "./fh help pilot-progression P-prog-08"]],
  [/蓝瓶已自动化/, ["./know 机器人", "./fh help pilot-progression P-prog-08", "./fh help pilot-production P-prod-14"]],
  [/蓝瓶在起步/, ["./know 裂解", "./know 塑料", "./know 硫磺", "./fh help pilot-production P-prod-14"]],
  [/绿瓶阶段/, ["./know 石油", "./know 钢", "./fh help pilot-production P-prod-01"]],
  [/红瓶阶段/, ["./know 绿瓶", "./know 电力采矿机", "./fh help pilot-production P-prod-01"]],
  [/刚开局/, ["./fh help pilot-progression P-prog-01", "./know 传送带", "./know 锅炉"]],
  [/有基地但科研停着/, ["./know 研究中心", "./fh call bottleneck"]],
];
const RATE_KEY: Record<string, keyof Rung> = { "automation-science-pack": "red", "logistic-science-pack": "green", "chemical-science-pack": "blue" };

/** 这一班最可能要查的: 差额里的科技包给 ./plan, 再加这一阶段常查的; 有虫子加防御 */
export function lookupsFor(stage: string, todo: Delta[], rung: Rung, zh: (n: string) => string, enemy?: { peaceful: boolean; nests: number } | null, hasWorldMap = false): string[] {
  const out: string[] = [];
  // : 放进 ref 不算看到, 开班就列出来 (./bp study --map 祝融星、玄冥星… 回复末尾有)
  if (hasWorldMap) out.push("./bp study --map 新地星");
  for (const d of todo) { const k = d.kind === "assembler" ? RATE_KEY[d.key] : undefined; if (k && rung[k] > 0) out.push(`./plan ${zh(d.key)} ${rung[k]}`); }
  for (const [re, rows] of STAGE_LOOKUPS) if (re.test(stage)) { out.push(...rows); break; }
  if (enemy && !enemy.peaceful && enemy.nests > 0) out.push("./know 炮塔");
  out.push("./fh help index");
  return [...new Set(out)];
}

/** 扫描结果 → 给大脑的 markdown 和给界面的几行 */
export function composeScan(i: ScanInput, at = new Date().toISOString()): Scan {
  const { raw, existing, zh } = i;
  const h = Math.floor(raw.tick / 216000), m = Math.floor((raw.tick % 216000) / 3600);
  const asm = Object.entries(existing.assemblers).sort((a, b) => b[1] - a[1]);
  const drills = Object.entries(existing.drillPerMin);
  const lines = [
    `游戏时间 ${h} 小时 ${m} 分; 已研究 ${raw.researched} 项, 正在研究 ${raw.research ? zh(raw.research) : "无"}${raw.queue.length ? `, 队列还有 ${raw.queue.length} 项` : ", 队列空"}; 研究中心 ${raw.labs.working}/${raw.labs.total} 在工作`,
    `近 10 分钟每分钟产量: 红 ${r1(raw.rates.red)} / 绿 ${r1(raw.rates.green)} / 蓝 ${r1(raw.rates.blue)}${(raw.rates.purple ?? 0) + (raw.rates.yellow ?? 0) + (raw.rates.space ?? 0) > 0 ? ` / 紫 ${r1(raw.rates.purple ?? 0)} / 黄 ${r1(raw.rates.yellow ?? 0)} / 太空 ${r1(raw.rates.space ?? 0)}` : ""}`,
    `机器: 组装机 ${asm.reduce((n, [, c]) => n + c, 0)} 台 (${asm.slice(0, 6).map(([k, c]) => `${zh(k)} ${c}`).join("、") || "没有"}), 炉 ${existing.furnaces} 台, 采矿 ${drills.length ? drills.map(([k, v]) => `${zh(k)} 每分钟 ${Math.round(v)}`).join("、") : "没有采矿机"}`,
    `科技: ${[["automation2", "组装机 2 型"], ["steelFurnace", "钢炉"], ["electricFurnace", "电炉"], ["oil", "石油"], ["electricDrill", "电力采矿机"]].filter(([k]) => existing.tech[k as keyof typeof existing.tech]).map(([, n]) => n).join("、") || "都还没研究"}${raw.rockets ? `; 已发射火箭 ${raw.rockets} 次` : ""}${raw.surfaces.length > 1 ? `; 地表: ${raw.surfaces.join("、")}` : ""}`,
    `体检: ${i.health.length ? `${i.health.length} 类问题 —— ${i.health.slice(0, 5).join("; ")}` : "没发现问题"}`,
  ];
  const e = raw.enemy;
  const grace = i.peaceMinutes && i.peaceMinutes > 0 ? i.peaceMinutes : 0;
  if (e) lines.push(`敌人: ${grace ? `和平模式还开着, ${grace} 分钟后自动关, 之后虫子会来打` : e.peaceful ? "和平模式开着, 虫子不主动打" : "和平模式关着, 虫子会来打"}; 虫巢 ${e.nests} 个${e.nests ? `, 最近 ${e.nearest} 格 (${e.x},${e.y}), ${e.polluted > 0 ? "污染已碰到它" : "污染还没碰到它"}` : ""}; 炮塔 ${e.turrets} 座`);
  const stage = stageOf(raw, existing);
  const judgement: string[] = [`阶段: ${stage}`];
  // 2026-11-05 验证班: 接没有防御的存档关和平 (污染已到虫巢), 第 4 分钟起被啃, 8 分钟建筑 1320 → 949
  // 污染读数会来回变 (同一个存档读过 19 和 0, 那一轮第 4 分钟就被啃), 所以虫巢离得近也算, 不只看污染
  if (e && (!e.peaceful || grace) && e.nests > 0 && (e.polluted > 0 || e.nearest < 200) && e.turrets < 8) judgement.push(`有虫子${grace ? ` (和平还剩 ${grace} 分钟)` : ""}, 最近的虫巢 ${e.nearest} 格${e.polluted > 0 ? ", 污染已碰到它" : ""}, 炮塔只有 ${e.turrets} 座: 实测没有防御时几分钟内就开始被啃 (8 分钟丢 28% 建筑), 这是最先要解决的`);
  const labsIdle = raw.labs.total > 0 && raw.labs.working < raw.labs.total / 2;
  if (labsIdle) judgement.push(`研究中心一半以上停着 (${raw.labs.working}/${raw.labs.total}): 科技包没送够或研究队列空, 这是最先要解决的`);
  if (!raw.research && !raw.queue.length && raw.labs.total > 0) judgement.push("没有在研究的科技: 先排研究队列");
  const fuel = i.health.find((l) => /燃料/.test(l)); if (fuel) judgement.push(`燃料问题会拖垮发电和冶炼: ${fuel}`);
  const stuck = i.health.find((l) => /堵|满/.test(l)); if (stuck) judgement.push(`有堵死的带子 / 出口: ${stuck}`);
  const todo = i.deltas.filter((d) => d.add > 0);
  if (i.reached) judgement.push(`下一档 (红 ${i.rung.red} / 绿 ${i.rung.green}${i.rung.blue ? ` / 蓝 ${i.rung.blue}` : ""}) 已达到, 规划里按再翻倍算`);
  else if (!todo.length) judgement.push("下一档的机器按计算器已经够了但产量没到: 瓶颈在原料供给 / 带子 / 燃料 / 电, 不在机器数");
  const plan: string[] = [];
  plan.push(...i.health.slice(0, 3).map((l, k) => `先修 ${k + 1}: ${l}`));
  plan.push(`目标 (下一档): 红瓶 ${i.rung.red} / 绿瓶 ${i.rung.green}${i.rung.blue ? ` / 蓝瓶 ${i.rung.blue}` : ""} 每分钟`);
  plan.push(...todo.slice(0, 6).map((d) => d.kind === "furnace" ? `加炉子: ${d.have} → ${d.need} 台 (${d.note ?? ""})` : d.kind === "drill" ? `加 ${zh(d.key)} 采矿机: ${d.have} → ${d.need} 台` : `加 ${zh(d.key)} 的机器 (${zh(d.machine)}): ${d.have} → ${d.need} 台`));
  if (i.seats >= 2) {
    const roles = ["角色 1: 先修 (燃料、电、堵死的带子、采空的矿), 再管冶炼和主带", "角色 2: 科研链 (红 / 绿瓶机器、研究中心供料、研究队列不空)", "角色 3: 下一档的新线 (按扩产提案建; 有石油就先塑料 / 蓝瓶)", "角色 4+: 备料和建材 (板子、齿轮、电路的库存), 给前面三个人供"];
    plan.push(`分工建议 (${i.seats} 人): ${roles.slice(0, Math.min(4, i.seats)).join("; ")}`);
  }
  const summary = `${stage}; 红 ${r1(raw.rates.red)} / 绿 ${r1(raw.rates.green)} / 蓝 ${r1(raw.rates.blue)} 每分钟; 研究中心 ${raw.labs.working}/${raw.labs.total}; 体检 ${i.health.length} 类`;
  // 相关要点: 按这次扫描点出的问题和规划, 从 knowledge/brief-points.md 挑 (被动推送)
  const hints = i.hintsFor ? i.hintsFor([...judgement, ...plan, ...i.health]) : [];
  const md = [`# 开班扫描 (${at.slice(0, 16).replace("T", " ")} 读的; 先看这个再动手)`, "", "## 现状", ...lines.map((l) => `- ${l}`), "", "## 判断", ...judgement.map((l) => `- ${l}`), "", "## 规划", ...plan.map((l) => `- ${l}`), "",
    ...(hints.length ? ["## 相关要点 (我们核实过的经验, 按上面的问题挑的; 出处在括号里, 全文 ./fh help pilot-*)", ...hints.map((l) => `- ${l}`), ""] : []),
    "## 这一阶段可能用得上的命令 (按阶段和差额算的, 都能直接跑)", ...lookupsFor(stage, todo, i.rung, zh, e, i.hasWorldMap).map((l) => `- \`${l}\``), "",
    "这是开班时按读数自动算的, 不是命令: 情况变了以你看到的为准; 扩产的具体台数监工每 15 分钟会重算一次。"].join("\n");
  return { at, stage, summary, lines, judgement, plan, hints, md };
}
