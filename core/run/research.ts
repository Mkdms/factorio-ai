// 研究队列空了时告诉模型能排什么 (库, 不直接运行; 监工用)。模型的路不碰 Lua, 所以不替它排 (旧项目在沙盘里用 add_research 自动排), 只说事实: 能研究的里最便宜的几项、要哪些瓶, 或下一步靠什么触发。
// 成员名对过本机 2.1.24 的 doc-html (LuaForce.research_queue / current_research; LuaTechnology.research_unit_*)。
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

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []) as T[];

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

/** 军事类科技: 和平模式的沙盘不提 */
const MILITARY = /^(military|weapon-shooting-speed|physical-projectile-damage|stronger-explosives|refined-flammables|laser-weapons-damage|laser-shooting-speed|energy-weapons-damage|electric-weapons-damage|artillery|gun-turret|laser-turret|flamethrower|land-mine|tank|rocketry|explosive-rocketry|atomic-bomb|uranium-ammo|defender|distractor|destroyer|follower-robot|railgun|tesla|rocket-turret)/;
export const isMilitary = (name: string) => MILITARY.test(name);

/** 能排的: 只要场上在产的瓶 (什么都没产过就按只有红瓶算), 和平模式跳过军事类; 最便宜的优先, 其次要的瓶种类少的 */
export function pickResearch(st: ResearchState): { pick: TechCandidate | null; usable: TechCandidate[]; producing: string[] } {
  const producing = st.producing.length ? st.producing : ["automation-science-pack"];
  const usable = st.candidates
    .filter((c) => c.packs.length > 0 && c.packs.every((p) => producing.includes(p)) && !(st.peaceful && isMilitary(c.name)))
    .sort((a, b) => a.units * a.time - b.units * b.time || a.packs.length - b.packs.length || a.name.localeCompare(b.name));
  return { pick: usable[0] ?? null, usable, producing };
}

/** 研究队列空了时递给模型的话 (事实 + 能跑的命令, 不替它排) */
export function researchIdleText(st: ResearchState, zh: (n: string) => string = (n) => n): string {
  const { usable, producing } = pickResearch(st);
  if (usable.length) return `研究队列空了。用场上在产的瓶 (${producing.map(zh).join("、")}) 能研究的, 最便宜的几项: ${usable.slice(0, 3).map((c) => `${zh(c.name)} (${c.units} 单位, 要 ${c.packs.map(zh).join("+")})`).join("; ")}。排上: ./fh call research --args '{"technology":"${usable[0].name}"}'`;
  const trig = st.triggers.slice(0, 3).map((t) => triggerText(t, zh)).join("; ");
  return trig ? `研究队列空了: 现在没有能用研究中心研究的科技, 下一步科技靠做事触发 —— ${trig}。` : `研究队列空了: 用场上在产的瓶 (${producing.map(zh).join("、")}) 能研究的都研究完了, 要继续研究得先产下一种瓶。`;
}
