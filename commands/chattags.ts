// 游戏聊天的富文本标签和官方中文名 (库, 不直接运行): 星球前缀 [planet=nauvis]、坐标 → [gps=x,y,星球] (点开定位)、官方中文名前加图标 [item=…] / [fluid=…] / [technology=…] / [entity=…]。
// 名单从沙盘导出的 locale/zh-CN/*-locale.json 读 (game/sandbox/server.ts dumpPrototypes), 目录给版本目录本身或它的上一层都行。
import fs from "node:fs";
import path from "node:path";

export type NameIndex = { byZh: Map<string, string>; re: RegExp | null };

/** 找有 locale/zh-CN 的目录: 给的目录自己有就用它, 否则在子目录里找 (有 space-age 的优先) */
function localeDir(protoRoot: string): string | undefined {
  if (!protoRoot || !fs.existsSync(protoRoot)) return undefined;
  if (fs.existsSync(path.join(protoRoot, "locale", "zh-CN"))) return protoRoot;
  const sub = fs.readdirSync(protoRoot).filter((d) => fs.existsSync(path.join(protoRoot, d, "locale", "zh-CN"))).sort((x, y) => Number(y.includes("space-age")) - Number(x.includes("space-age")))[0];
  return sub ? path.join(protoRoot, sub) : undefined;
}

/** 中文名 → 标签 的索引 (同名时 物品 > 流体 > 科技 > 实体) */
export function loadNameIndex(protoRoot: string): NameIndex {
  const byZh = new Map<string, string>();
  const dir = localeDir(protoRoot);
  if (dir) for (const [file, kind] of [["item-locale.json", "item"], ["fluid-locale.json", "fluid"], ["technology-locale.json", "technology"], ["entity-locale.json", "entity"]] as const) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, "locale", "zh-CN", file), "utf8")).names as Record<string, string>)) {
        if (typeof v === "string" && v.length >= 2 && /[一-鿿]/.test(v) && !byZh.has(v)) byZh.set(v, `[${kind}=${k}]`);
      }
    } catch { /* 没导出 */ }
  }
  return fromMap(byZh);
}

/** 内部名 → 官方中文名 (同名时 物品 > 流体 > 实体 > 科技): 角色目录的 ref/names.tsv、教训键推断、监工消息用 */
export function loadZhNames(protoRoot: string): Map<string, string> {
  const rows = new Map<string, string>();
  const dir = localeDir(protoRoot);
  if (dir) for (const f of ["item-locale.json", "fluid-locale.json", "entity-locale.json", "technology-locale.json"]) {
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, "locale", "zh-CN", f), "utf8")).names as Record<string, string>)) if (typeof v === "string" && !rows.has(k)) rows.set(k, v); } catch { /* 没导出 */ }
  }
  return rows;
}

export function fromMap(byZh: Map<string, string>): NameIndex {
  const names = [...byZh.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return { byZh, re: names.length ? new RegExp(names.join("|"), "g") : null };
}

/** 工具回复里的英文状态词和常说的英文词 → 中文 */
const WORDS: Record<string, string> = {
  low_power: "电力不足", no_power: "没电", no_fuel: "没燃料", no_recipe: "没配方", working: "运转中", full_output: "出口满", item_ingredient_shortage: "缺料", fluid_ingredient_shortage: "缺流体",
  assembler: "组装机", assemblers: "组装机", drill: "采矿机", drills: "采矿机", furnace: "炉子", furnaces: "炉子", inserters: "机械臂", belt: "传送带", belts: "传送带", pole: "电线杆", poles: "电线杆",
  burner: "热能", north: "北", south: "南", east: "东", west: "西",
};
const keysOf = new WeakMap<NameIndex, Map<string, string>>();
function byKey(idx: NameIndex): Map<string, string> {
  let m = keysOf.get(idx);
  if (!m) {
    m = new Map();
    for (const [zh, tag] of idx.byZh) { const k = /^\[[a-z-]+=(.+)\]$/.exec(tag)?.[1]; if (k && !m.has(k)) m.set(k, zh); }
    keysOf.set(idx, m);
  }
  return m;
}
/** 聊天里的内部名和英文状态词换成中文; 命令 (./fh …、--参数)、@名字、模型名这些不动 */
export function zhWords(text: string, idx: NameIndex): string {
  const keys = byKey(idx);
  return text.replace(/(?<![\w.@-]|\.\/)[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*(?![\w-])/g, (w) => {
    const low = w.toLowerCase();
    return keys.get(low) ?? WORDS[low] ?? w;
  });
}

/** 一条聊天加标签; 已有的 [..] 标签原样保留, 不重复加 */
export function chatTags(text: string, idx: NameIndex, surface = "nauvis"): string {
  const parts = text.split(/(\[[a-z-]+=[^\]]*\])/g); // 奇数位是已有标签
  const out = parts.map((p, i) => {
    if (i % 2 === 1) return p;
    let s = zhWords(p, idx);
    s = s.replace(/x\s*[=≈]\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*y\s*[=≈]\s*(-?\d+(?:\.\d+)?)/g, (_m, x, y) => `[gps=${x},${y},${surface}]`);
    s = s.replace(/\(?(?<![\w.\d=])(-?\d{1,5}(?:\.\d+)?)\s*,\s*(-?\d{1,5}(?:\.\d+)?)(?![\w.\d])\)?/g, (m, x, y) => (/[.-]/.test(x + y) || m.startsWith("(") ? `[gps=${x},${y},${surface}]` : m));
    const afterIcon = i > 0 && /^\[(item|fluid|technology|entity|recipe)=/.test(parts[i - 1]);
    if (idx.re) s = s.replace(idx.re, (n: string, off: number) => (off === 0 && afterIcon ? n : `${idx.byZh.get(n)}${n}`));
    return s;
  }).join("");
  return out.startsWith("[planet=") ? out : `[planet=${surface}] ${out}`;
}
