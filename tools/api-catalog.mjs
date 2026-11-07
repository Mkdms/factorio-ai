#!/usr/bin/env node
// API 目录: 读游戏自带的 doc-html/runtime-api.json、prototype-api.json 和 data/changelog.txt, 生成
//   catalog/runtime-index.json        本机用的完整索引 (不进仓库)
//   docs/capabilities.md 里两个标记之间的自动生成部分 (只放名字和数量, 不复制官方说明文字)
// 用法: node tools/api-catalog.mjs [Factorio 安装目录]   或在 .env 里设 FACTORIO_DIR
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.argv[2],
  process.env.FACTORIO_DIR,
  "C:/Program Files (x86)/Steam/steamapps/common/Factorio",
  "C:/Program Files/Factorio",
  path.join(process.env.HOME ?? "", ".steam/steam/steamapps/common/Factorio"),
].filter(Boolean);
const dir = candidates.find((d) => fs.existsSync(path.join(d, "doc-html", "runtime-api.json")));
if (!dir) {
  console.error("找不到 Factorio 安装目录 (需要 doc-html/runtime-api.json)。用法: node tools/api-catalog.mjs <安装目录>");
  process.exit(1);
}
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, "doc-html", f), "utf8"));
const runtime = read("runtime-api.json");
const proto = read("prototype-api.json");

// ---- full index (local only) ----
const classes = {};
for (const c of runtime.classes) {
  classes[c.name] = {
    abstract: !!c.abstract,
    parent: c.parent ?? null,
    read: (c.attributes ?? []).filter((a) => a.read_type).map((a) => a.name),
    write: (c.attributes ?? []).filter((a) => a.write_type).map((a) => a.name),
    methods: (c.methods ?? []).map((m) => m.name),
  };
}
const index = {
  version: runtime.application_version,
  api_version: runtime.api_version,
  globals: (runtime.global_objects ?? []).map((g) => ({ name: g.name, type: g.type })),
  classes,
  events: runtime.events.map((e) => e.name),
  defines: runtime.defines.map((d) => d.name),
  prototypes: proto.prototypes.map((p) => ({ name: p.name, typename: p.typename ?? null, abstract: !!p.abstract })),
};
fs.mkdirSync(path.join(ROOT, "catalog"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "catalog", "runtime-index.json"), JSON.stringify(index));

// ---- changelog: which 2.x releases this install has seen ----
let releases = [];
try {
  const log = fs.readFileSync(path.join(dir, "data", "changelog.txt"), "utf8");
  releases = [...log.matchAll(/^Version: (\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
} catch { /* optional */ }
const minor = runtime.application_version.split(".").slice(0, 2).join(".");
const sameMinor = releases.filter((v) => v.startsWith(minor + "."));

// ---- grouping by our own categories ----
const GROUPS = [
  ["太空", /Space|Platform|Planet|Asteroid|CargoPod|CargoHatch|CargoLandingPad/],
  ["火车与铁路", /Train|Rail|Schedule|Signal(?!ID)|TrainStop/],
  ["物流 (机器人、请求)", /Logistic|Roboport|Robot/],
  ["电路网络", /Circuit|ControlBehavior|Wire|Combinator/],
  ["玩家与界面", /Player|Gui|Render|Permission|Style|ModSetting|Rendering/],
  ["物品与物品栏", /Item|Inventory|Equipment|Burner|Fluid(?!Box)/],
  ["世界与地图", /Surface|Tile|Chunk|Map|Game|Bootstrap|Commands|Rcon|Remote|Helpers|Profiler|Random|Noise|Settings/],
  ["实体", /Entity|Control|Fluidbox|Segment|Unit|Commandable/],
  ["势力、科技、配方", /Force|Technology|Recipe|Achievement|Quality|Modifier/],
];
const groupOf = (name) => (GROUPS.find(([, rx]) => rx.test(name)) ?? ["其他"])[0];
const byGroup = new Map();
for (const [name, c] of Object.entries(classes)) {
  const g = groupOf(name);
  (byGroup.get(g) ?? byGroup.set(g, []).get(g)).push([name, c]);
}

// ---- what an autonomous player needs, and where the API offers it ----
const NEEDS = [
  ["地图上有什么 (实体、状态)", ["LuaSurface.find_entities_filtered", "LuaEntity.status"]],
  ["地块 (湿地、可建)", ["LuaSurface.get_tile", "LuaTile.name"]],
  ["箱子和物品栏", ["LuaEntity.get_inventory", "LuaInventory.get_contents"]],
  ["物流网库存和机器人", ["LuaLogisticNetwork.get_contents", "LuaLogisticNetwork.available_logistic_robots"]],
  ["产量统计", ["LuaForce.get_item_production_statistics", "LuaFlowStatistics.get_flow_count"]],
  ["电网统计", ["LuaEntity.electric_network_statistics"]],
  ["污染/孢子", ["LuaSurface.get_pollution"]],
  ["敌人进化", ["LuaForce.get_evolution_factor"]],
  ["科技进度", ["LuaForce.technologies", "LuaForce.current_research"]],
  ["火车状态和时刻表", ["LuaTrain.state", "LuaTrain.get_schedule"]],
  ["游戏自带寻路", ["LuaSurface.request_path"]],
  ["放蓝图 (沙盘)", ["LuaItemStack.import_stack", "LuaItemStack.build_blueprint"]],
  ["直接建造/拆除 (沙盘)", ["LuaSurface.create_entity", "LuaEntity.destroy"]],
  ["控制游戏速度 (沙盘)", ["LuaGameScript.speed", "LuaGameScript.tick_paused"]],
];
function lookup(ref) {
  const [cls, member] = ref.split(".");
  if (!classes[cls]) return "没有这个类";
  // members are inherited (LuaEntity -> LuaControl, LuaItemStack -> LuaItemCommon)
  for (let name = cls, c = classes[cls]; c; name = c.parent, c = c.parent ? classes[c.parent] : null) {
    const kinds = [];
    if (c.read.includes(member)) kinds.push("可读");
    if (c.write.includes(member)) kinds.push("可写");
    if (c.methods.includes(member)) kinds.push("方法");
    if (kinds.length) return kinds.join("/") + (name === cls ? "" : ` (继承自 ${name})`);
  }
  return "没有";
}

// ---- markdown ----
const L = [];
L.push(`生成: \`node tools/api-catalog.mjs\`, 游戏 ${runtime.application_version} (运行时 API 第 ${runtime.api_version} 版)。`);
L.push("");
L.push("| 项目 | 数量 |", "|---|---|");
L.push(`| 运行时类 | ${runtime.classes.length} |`, `| 事件 | ${runtime.events.length} |`, `| 概念 (数据结构) | ${runtime.concepts.length} |`, `| 常量组 (defines) | ${runtime.defines.length} |`);
L.push(`| 原型种类 | ${proto.prototypes.length} |`, `| 原型数据类型 | ${proto.types.length} |`);
L.push(`| 本机更新日志里的 ${minor}.x 版本 | ${sameMinor.length} (最新 ${releases[0] ?? "未知"}) |`);
L.push("");
L.push(`全局对象: ${index.globals.map((g) => "`" + g.name + "`").join(" ")}`);
L.push("");
L.push("### 自主玩家需要的接口 (存在性; 能不能在联机身体上读, M1 核实)");
L.push("| 需要 | 接口 | 文档里 |", "|---|---|---|");
for (const [need, refs] of NEEDS) L.push(`| ${need} | ${refs.map((r) => "`" + r + "`").join("<br>")} | ${refs.map(lookup).join("<br>")} |`);
L.push("");
L.push("### 按类分组 (可读属性 / 可写属性 / 方法 的个数)");
for (const [g] of [...GROUPS, ["其他"]]) {
  const rows = byGroup.get(g);
  if (!rows) continue;
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  L.push(`**${g}** (${rows.length}): ` + rows.map(([n, c]) => `\`${n}\` ${c.read.length}/${c.write.length}/${c.methods.length}`).join(", "));
  L.push("");
}
const md = L.join("\n");

const file = path.join(ROOT, "docs", "capabilities.md");
const START = "<!-- api-catalog:start -->", END = "<!-- api-catalog:end -->";
let doc = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : `# 接口能力\n\n${START}\n${END}\n`;
const a = doc.indexOf(START), b = doc.indexOf(END);
doc = a >= 0 && b > a ? doc.slice(0, a + START.length) + "\n" + md + "\n" + doc.slice(b) : doc + `\n${START}\n${md}\n${END}\n`;
fs.writeFileSync(file, doc);
console.log(`游戏 ${runtime.application_version}: ${runtime.classes.length} 个类, ${runtime.events.length} 个事件, ${proto.prototypes.length} 种原型 → docs/capabilities.md, catalog/runtime-index.json`);
