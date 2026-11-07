// 科技到手就告诉模型该用了 (库, 不直接运行):
// 查了记录: 跑满 3 小时的班次 11-04T18-40-18 和 11-05T02-13-24, roboport 一次都没出现, 模型自己想不起来。所以监工看到条件成立就说一次事实和下一步,
// 用不用模型定 (架构 2b)。机器人怎么用见 knowledge/brief-points.md "蓝瓶后机器人先当建设用, 白瓶后才做物流"。
export type MilestoneState = { done: Record<string, boolean>; roboports: number; logisticChests: number; queue: string[] };
export type Milestone = { id: string; when: (s: MilestoneState) => boolean; text: string };

const ROBOT_TECH = ["robotics", "construction-robotics", "logistic-robotics", "chemical-science-pack"];
export const MILESTONE_LUA = `local f = game.forces.player local s = game.surfaces[1]
  local d = {} for _, n in pairs(${JSON.stringify(ROBOT_TECH).replace("[", "{").replace("]", "}")}) do d[n] = f.technologies[n] and f.technologies[n].researched or false end
  local q = {} for i, t in pairs(f.research_queue or {}) do q[i] = t.name end
  return {done = d, roboports = s.count_entities_filtered{type = "roboport", force = f}, logisticChests = s.count_entities_filtered{type = "logistic-container", force = f}, queue = q}`;

export const MILESTONES: Milestone[] = [
  {
    id: "research-robots",
    when: (s) => s.done["chemical-science-pack"] === true && !s.done["construction-robotics"] && !s.queue.includes("construction-robotics"),
    text: "化工科技包已解锁, 建设机器人还没进研究队列。建设机器人能自动按虚影建造、修理、拆红叉, 比角色手放快, 值得排进队列 (前置是机器人技术)。",
  },
  {
    id: "build-roboport",
    when: (s) => s.done["construction-robotics"] === true && s.roboports === 0,
    text: "建设机器人已研究, 场上还没有机器人指令平台。放一座接上电, 里面放几个建设机器人, 之后范围内的虚影和拆除红叉它们会自动做, ./bp build 贴的虚影也算。",
  },
  {
    id: "use-logistics",
    when: (s) => s.done["logistic-robotics"] === true && s.roboports > 0 && s.logisticChests === 0,
    text: "物流机器人已研究, 场上还没有物流箱。品种多、量小的东西 (建材、燃料) 可以用被动供货箱（红箱）加优先集货箱（蓝箱）让机器人送, 不用角色来回搬; 大宗还是走传送带。",
  },
];

/** 这次该说哪些: 条件成立且这一班没说过; 说过的记进 said */
export function dueMilestones(s: MilestoneState, said: Set<string>): Milestone[] {
  const out = MILESTONES.filter((m) => !said.has(m.id) && m.when(s));
  for (const m of out) said.add(m.id);
  return out;
}

/** Lua 回来的表 → 状态 (空表可能是 {}, 不是数组) */
export function normalizeMilestone(raw: unknown): MilestoneState {
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<MilestoneState> | null;
  const q = o?.queue as unknown;
  return { done: (o?.done ?? {}) as Record<string, boolean>, roboports: Number(o?.roboports ?? 0), logisticChests: Number(o?.logisticChests ?? 0), queue: Array.isArray(q) ? (q as string[]) : Object.values((q ?? {}) as Record<string, string>) };
}
