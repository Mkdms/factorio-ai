// 开班扫描 (库): 开班时把世界摸一遍 → 现状写成 world-scan.md 给模型当第一份材料, world-scan.json 给界面。
// Lua 跑在游戏外的假接口上 (CommandBroker.evalLua), 服务器上一条都不跑; 读不到的字段当 0 或空, 写的是"读到的", 不是真值。
// 判断 / 规划 / 相关要点那几节 (旧项目按计算器和体检算的) 等训练集和计算器那块接上再加; 纯函数 normalizeScan / scanLines 有单元测试。
import fs from "node:fs";
import path from "node:path";

/** 游戏里一次读完 (沙盘 exec, 或游戏外的假接口) */
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
  rates: { red: number; green: number; blue: number; military: number; purple: number; yellow: number; space: number };
  rockets: number; silos: number; surfaces: string[]; players: number; entities: number;
  enemy?: { peaceful: boolean; nests: number; nearest: number; x: number; y: number; polluted: number; turrets: number };
};
const nz = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : v && typeof v === "object" ? Object.values(v).filter((x): x is string => typeof x === "string") : []);

/** 读到什么就写什么, 缺的当 0 / 空 (Lua 空表回来是 {} 不是数组) */
export function normalizeScan(raw: unknown): ScanRaw {
  const r = (raw ?? {}) as Partial<ScanRaw>;
  const rates = (r.rates ?? {}) as Partial<ScanRaw["rates"]>;
  return {
    tick: nz(r.tick), researched: nz(r.researched), research: typeof r.research === "string" ? r.research : "", queue: strs(r.queue),
    labs: { total: nz(r.labs?.total), working: nz(r.labs?.working) },
    rates: { red: nz(rates.red), green: nz(rates.green), blue: nz(rates.blue), military: nz(rates.military), purple: nz(rates.purple), yellow: nz(rates.yellow), space: nz(rates.space) },
    rockets: nz(r.rockets), silos: nz(r.silos), surfaces: strs(r.surfaces), players: nz(r.players), entities: nz(r.entities),
    ...(r.enemy && typeof r.enemy === "object" ? { enemy: { peaceful: r.enemy.peaceful !== false, nests: nz(r.enemy.nests), nearest: nz(r.enemy.nearest), x: nz(r.enemy.x), y: nz(r.enemy.y), polluted: nz(r.enemy.polluted), turrets: nz(r.enemy.turrets) } } : {}),
  };
}

/** 到哪个阶段了 (按产量和里程碑, 不按机器数) */
export function stageOf(raw: ScanRaw): string {
  const r = raw.rates;
  if (raw.surfaces.some((s) => /platform|vulcanus|fulgora|gleba|aquilo/i.test(s))) return "太空时代: 已有太空平台或别的星球";
  if (raw.rockets > 0) return "已发射火箭, 准备太空";
  if (raw.silos > 0) return "火箭发射井已建, 还没发射";
  if (r.space > 0 || r.yellow > 0 || r.purple > 0) return "紫 / 黄瓶阶段";
  if (r.blue > 0.5) return "蓝瓶已自动化";
  if (r.green > 0.5) return "绿瓶阶段";
  if (r.red > 0.5) return "红瓶阶段";
  if (raw.researched < 5 && raw.entities < 200) return "刚开局";
  return "有基地但科研停着";
}

const r1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
/** 现状的几行 (纯函数) */
export function scanLines(raw: ScanRaw): string[] {
  const h = Math.floor(raw.tick / 216000), m = Math.floor((raw.tick % 216000) / 3600);
  const lines = [
    `游戏时间 ${h} 小时 ${m} 分; 已研究 ${raw.researched} 项, 正在研究 ${raw.research || "无"}${raw.queue.length ? `, 队列还有 ${raw.queue.length} 项` : ", 队列空"}; 研究中心 ${raw.labs.working}/${raw.labs.total} 在工作`,
    `近 10 分钟每分钟产量: 红 ${r1(raw.rates.red)} / 绿 ${r1(raw.rates.green)} / 蓝 ${r1(raw.rates.blue)}${raw.rates.purple + raw.rates.yellow + raw.rates.space > 0 ? ` / 紫 ${r1(raw.rates.purple)} / 黄 ${r1(raw.rates.yellow)} / 太空 ${r1(raw.rates.space)}` : ""}`,
    `我方建筑 ${raw.entities} 件${raw.rockets ? `; 已发射火箭 ${raw.rockets} 次` : ""}${raw.silos ? `; 发射井 ${raw.silos}` : ""}${raw.surfaces.length > 1 ? `; 地表: ${raw.surfaces.join("、")}` : ""}; 在线 ${raw.players} 人`,
  ];
  const e = raw.enemy;
  if (e) lines.push(`敌人: ${e.peaceful ? "和平模式开着, 虫子不主动打" : "和平模式关着, 虫子会来打"}; 虫巢 ${e.nests} 个${e.nests ? `, 最近 ${e.nearest} 格 (${e.x},${e.y}), ${e.polluted > 0 ? "污染已碰到它" : "污染还没碰到它"}` : ""}; 炮塔 ${e.turrets} 座`);
  return lines;
}

export type Scan = { at: string; stage: string; summary: string; lines: string[]; md: string };
export function composeScan(raw: ScanRaw, at = new Date().toISOString()): Scan {
  const stage = stageOf(raw), lines = scanLines(raw);
  const judgement = [`阶段: ${stage}`];
  if (raw.labs.total > 0 && raw.labs.working < raw.labs.total / 2) judgement.push(`研究中心一半以上停着 (${raw.labs.working}/${raw.labs.total}): 科技包没送够或研究队列空, 这是最先要解决的`);
  if (!raw.research && !raw.queue.length && raw.labs.total > 0) judgement.push("没有在研究的科技: 先排研究队列");
  const e = raw.enemy;
  if (e && !e.peaceful && e.nests > 0 && (e.polluted > 0 || e.nearest < 200) && e.turrets < 8) judgement.push(`有虫子, 最近的虫巢 ${e.nearest} 格${e.polluted > 0 ? ", 污染已碰到它" : ""}, 炮塔只有 ${e.turrets} 座: 实测没有防御时几分钟内就开始被啃, 这是最先要解决的`);
  const summary = `${stage}; 红 ${r1(raw.rates.red)} / 绿 ${r1(raw.rates.green)} / 蓝 ${r1(raw.rates.blue)} 每分钟; 研究中心 ${raw.labs.working}/${raw.labs.total}`;
  // 下一档要补什么: 红瓶还没自动化就把能一条命令建整条线的递上 (只给命令, 用不用模型定)
  const next = raw.rates.red <= 0 ? "automation-science-pack" : raw.rates.green <= 0 ? "logistic-science-pack" : raw.rates.blue <= 0 ? "chemical-science-pack" : null;
  const plan = next ? [`下一档: ${next} 还没有机器在出。整条线一条命令 (算全链 → 减场上已有 → 挑蓝图块 → 找空地 → 备料 → 放): ./plan ${next} 30 --build; 只看方案: ./plan ${next} 30; 配比: ./calc '{"targets":{"${next}":30}}'; 库里的块: ./bp list`] : [];
  const md = [`# 开班扫描 (${at.slice(0, 16).replace("T", " ")} 读的; 先看这个再动手)`, "", "## 现状", ...lines.map((l) => `- ${l}`), "", "## 判断", ...judgement.map((l) => `- ${l}`), ...(plan.length ? ["", "## 规划", ...plan.map((l) => `- ${l}`)] : []), "",
    "这是开班时按读数自动算的, 不是命令: 情况变了以你看到的为准。"].join("\n");
  // judgement / plan 也给界面 (右栏"开班扫描"那节读这两样; 缺了界面整页崩, 2026-11-08 核出来)
  return { at, stage, summary, lines, judgement, plan, md };
}

/** 写 <dir>/world-scan.md 和 <runDir>/world-scan.json; 回一句摘要 */
export async function writeScan(exec: (code: string) => Promise<unknown>, dir: string, runDir: string, online = true): Promise<string> {
  const sc = composeScan(normalizeScan(await exec(SCAN_LUA)));
  const head = online ? "(读数来自进程外读内存, 个别字段可能读不到; 别人的世界只作判断依据, 大事先问)\n\n" : "";
  fs.writeFileSync(path.join(dir, "world-scan.md"), head + sc.md);
  const { md: _md, ...forUi } = sc; void _md;
  fs.writeFileSync(path.join(runDir, "world-scan.json"), JSON.stringify(forUi, null, 1));
  return sc.summary;
}
