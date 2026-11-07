// 研究自动续上 (M6): 研究中心空了 1 分钟且队列也空, 监工按场上在产的瓶
// 选一项最便宜的排上 (和平模式跳过军事类; 11-03 第 3 班排了要灰瓶的 "动能武器伤害 3", 11 台研究中心全停), 并告诉大脑, 它想换随时改。
// 成员名 2026-11-04 对过本机 2.1.24 的 doc-html (LuaForce.add_research / research_queue / current_research; LuaTechnology.research_unit_*)。
// 纯函数 pickResearch 有单元测试 test/research.test.ts; RESEARCH_LUA 在 test/sandbox/research.test.ts 里对真游戏跑。
export type TechCandidate = { name: string; units: number; time: number; packs: string[]; level?: number };
/** 触发型科技 (2.0 起开局那几项: 做出 10 个铁板、建一台锅炉…): 研究中心研究不了, 只能靠做事触发 */
export type TriggerTech = { name: string; trigger: string };
export type ResearchState = { current: string; queue: number; peaceful: boolean; producing: string[]; candidates: TechCandidate[]; triggers: TriggerTech[] };

/** 读: 当前研究、队列长度、和平模式、场上产过的瓶 (产量统计 > 0)、前置已完成且能在研究中心研究的科技 (candidates)、前置已完成的触发型科技 (triggers) */
export const RESEARCH_LUA = `local f = game.forces.player local s = game.surfaces[1]
local stats = f.get_item_production_statistics(s)
local packs, producing, cands, trigs = {}, {}, {}, {}
for name, t in pairs(f.technologies) do
  if not t.researched and t.enabled and not t.prototype.hidden then
    local ok = true
    for _, p in pairs(t.prerequisites) do if not p.researched then ok = false break end end
    local trig = nil pcall(function() trig = t.prototype.research_trigger end)
    if ok and trig == nil then
      local ps = {}
      for _, i in pairs(t.research_unit_ingredients) do ps[#ps + 1] = i.name packs[i.name] = true end
      cands[#cands + 1] = {name = name, units = t.research_unit_count, time = t.research_unit_energy / 60, packs = ps, level = t.level}
    elseif ok then
      local tgt = trig.item or trig.entity or trig.fluid
      if type(tgt) == "table" then tgt = tgt.name end
      trigs[#trigs + 1] = {name = name, trigger = tostring(trig.type) .. (tgt and (" " .. tostring(tgt)) or "") .. (trig.count and (" x" .. tostring(trig.count)) or "")}
    end
  end
end
for p in pairs(packs) do if stats.get_input_count(p) > 0 then producing[#producing + 1] = p end end
return {current = f.current_research and f.current_research.name or "", queue = #f.research_queue, peaceful = s.peaceful_mode and true or false, producing = producing, candidates = cands, triggers = trigs}`;

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []) as T[]; // Lua 空表回来是 {} (lab.md #55)

/** RESEARCH_LUA 的回复整理成 ResearchState */
export function normalizeResearch(raw: unknown): ResearchState {
  const r = (raw ?? {}) as Partial<ResearchState>;
  return {
    current: String(r.current ?? ""), queue: Number(r.queue ?? 0), peaceful: !!r.peaceful,
    producing: arr<string>(r.producing),
    candidates: arr<TechCandidate>(r.candidates).map((c) => ({ ...c, packs: arr<string>(c.packs) })),
    triggers: arr<TriggerTech>(r.triggers),
  };
}

/** 触发条件说成人话 (Lua 给的是 "craft-item iron-plate x10" 这种) */
export function triggerText(t: TriggerTech, zh: (n: string) => string = (n) => n): string {
  const [kind, target, count] = t.trigger.split(" ");
  const n = count ? ` ${count.replace(/^x/, "")} 个` : "";
  const what = target ? zh(target) : "";
  const verb: Record<string, string> = { "craft-item": `做出${n} ${what}`, "mine-entity": `采到 ${what}`, "craft-fluid": `做出 ${what}`, "build-entity": `建一台 ${what}`, "send-item-to-orbit": `把 ${what} 送上轨道`, "capture-spawner": "捕获一个虫巢", "create-space-platform": "建一个太空平台" };
  return `${zh(t.name)} (${verb[kind] ?? t.trigger})`;
}

/** 军事类科技 (伤害、射速、炮塔、弹药、军备科技包那一支): 和平模式的沙盘不排 */
const MILITARY = /^(military|weapon-shooting-speed|physical-projectile-damage|stronger-explosives|refined-flammables|laser-weapons-damage|laser-shooting-speed|energy-weapons-damage|electric-weapons-damage|artillery|gun-turret|laser-turret|flamethrower|land-mine|tank|rocketry|explosive-rocketry|atomic-bomb|uranium-ammo|defender|distractor|destroyer|follower-robot|railgun|tesla|rocket-turret)/;
export const isMilitary = (name: string) => MILITARY.test(name);

/**
 * 选一项排上: 只要场上在产的瓶 (什么都没产过就按只有红瓶算: 每个工厂都从红瓶开始), 和平模式跳过军事类;
 * 最便宜的优先 (单位数 × 每单位秒数), 其次要的瓶种类少的
 */
export function pickResearch(st: ResearchState): { pick: TechCandidate | null; usable: TechCandidate[]; producing: string[] } {
  const producing = st.producing.length ? st.producing : ["automation-science-pack"];
  const usable = st.candidates
    .filter((c) => c.packs.length > 0 && c.packs.every((p) => producing.includes(p)) && !(st.peaceful && isMilitary(c.name)))
    .sort((a, b) => a.units * a.time - b.units * b.time || a.packs.length - b.packs.length || a.name.localeCompare(b.name));
  return { pick: usable[0] ?? null, usable, producing };
}
