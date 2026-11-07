// 游戏系统覆盖清单: 原来的流程是"检索说法 → 挑来核实", 哪块没覆盖看不见, 只能等用户点出来。
// 这里从本机原型数据列出玩家能建造的全部实体和全部科技, 到知识库里逐个找 (官方中文名或内部名):
// 已核实的事实 (knowledge/facts.json) > 思路库 (knowledge/patterns/) > 只在检索资料里 (docs/research/players/) > 空白。生成 docs/coverage.md。
// 用法: npm run coverage
import fs from "node:fs";
import path from "node:path";
import { defaultDumpPath } from "../blueprint/rules.ts";
import { zhNamesFrom } from "../lab/names.ts";

const root = path.join(import.meta.dirname, "..", "..");
const dumpPath = defaultDumpPath();
const raw = JSON.parse(fs.readFileSync(dumpPath, "utf8")) as Record<string, Record<string, any>>;
const zh = zhNamesFrom(path.dirname(dumpPath));

// 玩家能建造的实体 = 物品 place_result (+ 铁轨规划器的各种轨)
const buildable = new Set<string>();
for (const group of Object.values(raw)) {
  for (const it of Object.values(group ?? {})) {
    if (!it || typeof it !== "object") continue;
    if (it.hidden || (Array.isArray(it.flags) && it.flags.includes("spawnable"))) continue; // 装卸机、永续箱这类编辑器 / 沙盘专用的不算 (正常游戏造不出来)
    if (typeof it.place_result === "string") buildable.add(it.place_result);
    if (Array.isArray(it.rails)) for (const r of it.rails) buildable.add(r);
    if (it.support && typeof it.support === "string") buildable.add(it.support);
    if (it.ramp && typeof it.ramp === "string") buildable.add(it.ramp);
  }
}
const typeOf = new Map<string, string>();
for (const [type, group] of Object.entries(raw)) for (const name of Object.keys(group ?? {})) if (buildable.has(name) && group[name]?.collision_box) typeOf.set(name, type);
const techs = Object.entries(raw.technology ?? {}).filter(([, t]) => !t.hidden).map(([n]) => n);

const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
const dirText = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => read(path.join(d, f))).join("\n") : "");
const facts = read(path.join(root, "knowledge", "facts.json"));
const patterns = dirText(path.join(root, "knowledge", "patterns"));
const research = dirText(path.join(root, "docs", "research", "players")) + read(path.join(root, "docs", "verify.md"));

type Level = "核实" | "思路" | "检索" | "空白";
function level(name: string): Level {
  const keys = [name, zh(name)].filter((k) => k && k.length >= 2);
  const hit = (text: string) => keys.some((k) => text.includes(k));
  return hit(facts) ? "核实" : hit(patterns) ? "思路" : hit(research) ? "检索" : "空白";
}

const byType = new Map<string, { name: string; lv: Level }[]>();
for (const [name, type] of typeOf) byType.set(type, [...(byType.get(type) ?? []), { name, lv: level(name) }]);
const techLv = techs.map((n) => ({ name: n, lv: level(n) }));
const count = (l: { lv: Level }[], lv: Level) => l.filter((x) => x.lv === lv).length;

const lines: string[] = [];
lines.push("# 游戏系统覆盖清单 (自动生成: `npm run coverage`, 不要手改)", "");
lines.push(`> 生成于 ${new Date().toISOString().slice(0, 10)}, 原型数据 ${path.basename(path.dirname(dumpPath))}。每一项按官方中文名或内部名在知识库里找: **核实** = knowledge/facts.json 里有 (沙盘核实过); **思路** = knowledge/patterns/ 里有; **检索** = 只在 docs/research/players/ 或 verify.md 里提过; **空白** = 哪里都没有。`);
lines.push("> 来由:  —— 原来哪块没覆盖看不见。每次会话先看这里的空白和\"只有检索\"的, 再决定检索 / 实验什么。名字匹配是粗的 (短名可能误中), 只当线索。", "");
const all = [...byType.values()].flat();
lines.push("## 汇总", "| 类别 | 总数 | 核实 | 思路 | 只有检索 | 空白 |", "|---|---|---|---|---|---|");
lines.push(`| 玩家能建造的实体 | ${all.length} | ${count(all, "核实")} | ${count(all, "思路")} | ${count(all, "检索")} | ${count(all, "空白")} |`);
lines.push(`| 科技 | ${techLv.length} | ${count(techLv, "核实")} | ${count(techLv, "思路")} | ${count(techLv, "检索")} | ${count(techLv, "空白")} |`, "");
lines.push("## 实体 (按原型类型; 先列空白, 再列只有检索的)", "| 类型 | 总数 | 核实 | 空白的 | 只有检索的 |", "|---|---|---|---|---|");
for (const [type, list] of [...byType.entries()].sort((a, b) => count(b[1], "空白") - count(a[1], "空白") || a[0].localeCompare(b[0]))) {
  const names = (lv: Level) => list.filter((x) => x.lv === lv).map((x) => zh(x.name)).join("、") || "—";
  lines.push(`| ${type} | ${list.length} | ${count(list, "核实")} | ${names("空白")} | ${names("检索")} |`);
}
lines.push("", "## 科技里的空白", techLv.filter((t) => t.lv === "空白").map((t) => zh(t.name)).join("、") || "—", "");
fs.writeFileSync(path.join(root, "docs", "coverage.md"), lines.join("\n") + "\n");
console.log(`实体 ${all.length}: 核实 ${count(all, "核实")}、思路 ${count(all, "思路")}、只有检索 ${count(all, "检索")}、空白 ${count(all, "空白")}; 科技 ${techLv.length}: 核实 ${count(techLv, "核实")}、思路 ${count(techLv, "思路")}、只有检索 ${count(techLv, "检索")}、空白 ${count(techLv, "空白")} → docs/coverage.md`);
