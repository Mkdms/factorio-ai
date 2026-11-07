// ./bp build 自己备料 (库, 不直接运行): 缺东西先从箱子和机器出口拿, 再手搓, 不再一句"材料不够"退回去。
// : 班次 10-16-30 只有 Gpt 用 ./bp build, 前几次都被"材料不够, 先备料"退回, 又得自己一件件搓一件件拿。
// 每一步都是玩家规则的动作 (走过去拿、背包里手搓), 花游戏时间; 拿不到、搓不了的如实报缺什么。

import type { GameData } from "../calc/data.ts";

export type Need = Record<string, number>;
/** 手搓配方: 产量和原料; 手搓不了 (冶炼、没有配方) 返回 null */
export type HandRecipe = (item: string) => { name: string; yield: number; ingredients: { name: string; amount: number }[] } | null;

/** 还差多少 */
export function lacking(need: Need, held: Need): Need {
  const out: Need = {};
  for (const [k, v] of Object.entries(need)) if ((held[k] ?? 0) < v) out[k] = v - (held[k] ?? 0);
  return out;
}

/** 手搓 lack 这些一共还要拿多少原料: 展开到手搓不了的 (铁板这种), 背包里有的先扣; 能搓的中间件游戏手搓队列会自己搓 */
export function rawNeeds(lack: Need, held: Need, recipe: HandRecipe): Need {
  const left = { ...held };
  const raw: Need = {};
  const take = (item: string, n: number, depth: number) => {
    const used = Math.min(left[item] ?? 0, n);
    left[item] = (left[item] ?? 0) - used;
    expand(item, n - used, depth);
  };
  const expand = (item: string, n: number, depth: number) => {
    if (n <= 0) return;
    const r = depth < 12 ? recipe(item) : null;
    if (!r) { raw[item] = (raw[item] ?? 0) + n; return; }
    const crafts = Math.ceil(n / Math.max(r.yield, 1));
    for (const g of r.ingredients) take(g.name, g.amount * crafts, depth + 1);
  };
  for (const [k, v] of Object.entries(lack)) expand(k, v, 0);
  return raw;
}

/** 角色手搓得了的配方 (./bp build 备料、./plan 查拿不拿得到都用这一份) */
export function handRecipeOf(gd: Pick<GameData, "recipes">): HandRecipe {
  return (item) => {
    const r = gd.recipes.get(item) ?? [...gd.recipes.values()].find((x) => x.products.some((p) => p.name === item));
    if (!r || !r.categories.some((c) => c === "crafting" || c.includes("hand-crafting"))) return null;
    return { name: r.name, yield: r.products.find((p) => p.name === item)?.amount ?? 1, ingredients: r.ingredients.map((g) => ({ name: g.name, amount: g.amount })) };
  };
}

export type GatherIo = {
  held: () => Promise<Need>;
  /** 从箱子和机器出口拿 (走过去), 拿多少算多少, 不抛错 */
  collect: (item: string, count: number) => Promise<void>;
  /** 排手搓; 返回排上没有 (排不上的原因) */
  craft: (recipe: string, count: number) => Promise<{ ok: boolean; why?: string }>;
  recipe: HandRecipe;
  sleep: (ms: number) => Promise<void>;
  /** 等手搓最多多久 */
  craftWaitMs: number;
  /** 手搓队列里还有几项; 没给就当 0 */
  queued?: () => Promise<number>;
};

/** 把 need 备齐; 返回还缺什么和做了什么 (给模型看); crafting = 手搓还在排队, 角色接着搓, 模型不用再排、可以先干别的 */
export async function gather(need: Need, io: GatherIo): Promise<{ still: Need; notes: string[]; crafting?: boolean }> {
  const notes: string[] = [];
  // 上一次排的还没搓完: 不再拿料不再排 (否则同一条命令重跑一次就多搓一份), 直接说还要等
  const before = await io.queued?.() ?? 0;
  if (before > 0) {
    const lack = lacking(need, await io.held());
    if (Object.keys(lack).length) { notes.push(`手搓队列还有 ${before} 项在搓, 这次没再排; 你可以先干别的, 搓完再跑同一条命令`); return { still: lack, notes, crafting: true }; }
    return { still: {}, notes };
  }
  const first = lacking(need, await io.held());
  for (const [k, v] of Object.entries(first)) await io.collect(k, v);
  let held = await io.held();
  let lack = lacking(need, held);
  const took = Object.keys(first).filter((k) => !lack[k]);
  if (took.length) notes.push(`从箱子和机器出口拿到: ${took.join(" ")}`);
  if (!Object.keys(lack).length) return { still: {}, notes };
  // 手搓: 先拿原料, 再排队, 等它搓完
  for (const [k, v] of Object.entries(rawNeeds(lack, held, io.recipe))) await io.collect(k, v);
  const queued: string[] = [];
  let stuck = false;
  for (const [k, v] of Object.entries(lack)) {
    const r = io.recipe(k);
    if (!r) continue;
    const c = await io.craft(r.name, Math.ceil(v / Math.max(r.yield, 1)));
    if (c.ok) queued.push(k); else { stuck = true; notes.push(`${k} 搓不了: ${String(c.why ?? "").slice(0, 120)}`); }
  }
  // 有一样搓不了, 这块反正放不成: 不等别的搓完, 也不说"搓完再跑" (2026-11-06 验证班: 组装机2型缺钢, 回"正在手搓", 再跑一次才报缺, 白等一轮); 排上的角色接着搓, 东西还在
  if (stuck) {
    if (queued.length) notes.push(`手搓: ${queued.join(" ")}`);
    return { still: lacking(need, await io.held()), notes };
  }
  if (queued.length) {
    notes.push(`手搓: ${queued.join(" ")}`);
    const deadline = Date.now() + io.craftWaitMs;
    for (;;) {
      await io.sleep(1000);
      held = await io.held();
      if (!queued.some((k) => (held[k] ?? 0) < need[k]) || Date.now() >= deadline) break;
    }
  }
  held = await io.held();
  const still = lacking(need, held);
  // 等到点了还在搓: 角色接着搓, 模型别干等
  if (queued.length && Object.keys(still).length && (await io.queued?.() ?? 0) > 0) {
    notes.push("还没搓完, 角色接着搓; 你可以先干别的, 搓完再跑同一条命令 (不会重复排)");
    return { still, notes, crafting: true };
  }
  return { still, notes };
}
