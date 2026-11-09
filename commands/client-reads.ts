// 模型直接用注入客户端的程序 (game/client) 的只读工具, 和"看带子每道"这类经它批量读的命令 (代理 commands/broker.ts 里直接答, 不过身体锁、不进行动层)。
// 为什么: 模型原来只能用 ./fh 的命令, 上游 (factorio-mcp) 每加一种读法都要我们在这一层接才到模型手上 (0.0.11 合进来 26 项新能力, 只用上 1 项, 2026-11-09)。
// 只放只读工具: 上游只放行被动查询 (不跑任意 Lua、不调会改状态的方法、统计 getter 也不收), 只在本机这个客户端读, 不发给服务器; 动作一律走行动层 (身体锁、协助模式、成就规矩不变)。
import fs from "node:fs";
import path from "node:path";
import type { CallResult } from "../game/client/connect.ts";

export type ClientCall = (tool: string, args: Record<string, unknown>) => Promise<CallResult>;

/** 模型能直接调的工具 (game/client/tools.md); 动作类 (input、ui_action、player_action、chat_send、set_rendering、attach、detach) 和截图不在里面 */
export const READ_PASSTHROUGH = new Set(["world_query", "world_overview", "ui_read", "input_bindings", "chat_read"]);

/** 回复超过这么多字就只回开头, 全文写进角色目录的文件 (一个实体约 230 字节, 读一片区域很快就上百 KB) */
export const MCP_REPLY_CAP = 24_000;
export const MCP_DUMP_FILE = "mcp-last.json";

type Fail = { code: string; message: string };
export type ReadOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: Fail };

/**
 * ./fh call mcp --args '{"tool":"world_query","args":{...}}'
 * world_query 的 args 就是上游的 query (selection / fields / limit / reads …); 写成 {"query": {...}} 也认。
 * 超长的回复: result 里放开头和说明, 全文在 dumpDir/mcp-last.json。
 */
export async function mcpPassthrough(call: ClientCall, a: Record<string, unknown>, dumpDir?: string): Promise<ReadOutcome> {
  const tool = typeof a.tool === "string" ? a.tool : "";
  if (!READ_PASSTHROUGH.has(tool)) return { ok: false, error: { code: "mcp_refused", message: `只开放只读工具: ${[...READ_PASSTHROUGH].join(" / ")}; 动手用 ./fh 的动作 (${tool || "没给 tool"})` } };
  const args = (a.args && typeof a.args === "object" && !Array.isArray(a.args) ? a.args : {}) as Record<string, unknown>;
  const r = await call(tool, args);
  if (!r.ok) return { ok: false, error: { code: "mcp_error", message: `${tool}: ${String(r.error ?? "没回").slice(0, 1500)}\n参数写法见 ./fh help mcp (上游的工具说明在 game/client/tools.md, 不在角色目录; 常见: world_query 的 inspect 默认 values 模式不收 limit, 要表的条目写 mode: "entries")` } };
  const text = JSON.stringify(r.data ?? r.text ?? null);
  if (text.length <= MCP_REPLY_CAP) return { ok: true, result: { tool, data: r.data ?? r.text ?? null } };
  let file: string | null = null;
  if (dumpDir) { try { file = path.join(dumpDir, MCP_DUMP_FILE); fs.writeFileSync(file, text); } catch { file = null; } }
  return {
    ok: true,
    result: {
      tool,
      cut: `回复 ${text.length} 字, 只回开头 ${MCP_REPLY_CAP} 字${file ? `; 全文在 ${MCP_DUMP_FILE} (用 python / jq 取要的字段, 别整个读)` : ""}。下次缩小范围或只要几个字段 (fields: [...]、limit、mode: "entries" 加 limit)`,
      head: text.slice(0, MCP_REPLY_CAP),
    },
  };
}

// ---------- 看带子每道 (belt_lanes) ----------
const BELT_TYPES = ["transport-belt", "underground-belt", "splitter", "lane-splitter", "linked-belt", "loader", "loader-1x1"];
/** defines.transport_line: 1 左道、2 右道 (相对带子朝向); 地下带 3/4 是地下那段, 分流器 3~8 是另一半和分流段 */
const LINE_NAMES: Record<number, string> = { 1: "左道", 2: "右道", 3: "第3条线", 4: "第4条线", 5: "第5条线", 6: "第6条线", 7: "第7条线", 8: "第8条线" };
const DIR = (d: unknown) => (typeof d === "number" ? ({ 0: "北", 4: "东", 8: "南", 12: "西" } as Record<number, string>)[d] ?? `方向${d}` : "?");

type Pos = { x: number; y: number };
type Row = { attributes?: Record<string, unknown>; reads?: { path?: unknown; value?: unknown; read_status?: { status?: string; message?: string } }[] };

/** 一条线的 get_contents (按物品和品质的数) → [名字, 品质, 个数] */
function counts(v: unknown): { name: string; quality?: string; count: number }[] {
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Record<string, unknown>) : [];
  return list.flatMap((x) => {
    const o = x as { name?: unknown; quality?: unknown; count?: unknown };
    return typeof o?.name === "string" ? [{ name: o.name, ...(typeof o.quality === "string" && o.quality !== "normal" ? { quality: o.quality } : {}), count: Number(o.count ?? 0) }] : [];
  });
}
/** get_detailed_contents → [{名字, 在这条线上的位置}] (位置 0 = 线的起点, 按格算; 物品堆是引用, 只带名字) */
function detailed(v: unknown): { name: string; at: number }[] {
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Record<string, unknown>) : [];
  return list.flatMap((x) => {
    const o = x as { stack?: { name?: unknown }; position?: unknown };
    return typeof o?.stack?.name === "string" ? [{ name: o.stack.name, at: Math.round(Number(o.position ?? 0) * 100) / 100 }] : [];
  }).sort((a, b) => a.at - b.at);
}

/**
 * ./fh call belt_lanes --args '{"position":{"x":..,"y":..}}'  一格带子: 每条道上有什么、各多少、每个物品在道上的位置
 *                         '{"area":{"left_top":..,"right_bottom":..}}' 或 '{"position":..,"radius":8}'  一片带子: 每格每条道的数 (不列位置)
 * 一次调用读完 (注入客户端 0.0.11 的批量相对读 reads: 选中的每格带子跟着读各条线的 get_contents / get_detailed_contents)。
 */
export async function beltLanes(call: ClientCall, a: Record<string, unknown>): Promise<ReadOutcome> {
  const pos = a.position as Pos | undefined;
  const area = a.area as { left_top: Pos; right_bottom: Pos } | undefined;
  const radius = typeof a.radius === "number" ? a.radius : undefined;
  if (!area && !(pos && typeof pos.x === "number" && typeof pos.y === "number")) return { ok: false, error: { code: "bad_args", message: "belt_lanes 要 position {x, y} (一格), 或 area {left_top, right_bottom} / position + radius (一片)" } };
  const single = !area && radius === undefined;
  const lines = single ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4];
  const reads = [
    { path: [{ method: "get_max_transport_line_index" }] },
    ...lines.map((i) => ({ path: [{ method: "get_transport_line", arguments: [i] }, { method: "get_contents" }] })),
    ...(single ? lines.map((i) => ({ path: [{ method: "get_transport_line", arguments: [i] }, { method: "get_detailed_contents" }] })) : []),
  ];
  const selection = area ? { kind: "entities", area, type: BELT_TYPES } : radius !== undefined ? { kind: "entities", position: pos, radius, type: BELT_TYPES } : { kind: "entities", position: pos, type: BELT_TYPES };
  const limit = typeof a.limit === "number" ? a.limit : single ? 4 : 400;
  const r = await call("world_query", { selection, fields: ["name", "type", "position", "direction"], limit, reads });
  if (!r.ok) return { ok: false, error: { code: "client_read", message: `读带子没成: ${String(r.error ?? "").slice(0, 600)}` } };
  const d = (r.data ?? {}) as { objects?: Row[]; selection_complete?: boolean };
  const belts = (d.objects ?? []).map((o) => {
    const at = o.attributes ?? {};
    const rd = o.reads ?? [];
    const max = typeof rd[0]?.value === "number" ? Number(rd[0].value) : 2;
    const lanes: Record<string, unknown> = {};
    for (const [k, i] of lines.entries()) {
      if (i > max) break;
      const c = counts(rd[1 + k]?.value);
      const entry: Record<string, unknown> = { 数: c.length ? c : "空" };
      if (single) { const p = detailed(rd[1 + lines.length + k]?.value); if (p.length) entry.位置 = p; }
      lanes[LINE_NAMES[i] ?? `第${i}条线`] = entry;
    }
    return { name: at.name, position: at.position, 朝向: DIR(at.direction), 线数: max, lanes };
  });
  if (!belts.length) return { ok: false, error: { code: "no_belt", message: `${area ? "这片" : "这格"}没有传送带 (含地下带、分流器、装卸机)${single ? "; 给的是带子所在格的坐标吗? 一片用 radius 或 area" : ""}` } };
  return { ok: true, result: { belts, ...(d.selection_complete === false ? { cut: `带子超过 ${limit} 格, 只回了一部分: 缩小范围或加 limit` } : {}), 说明: "左道 / 右道按带子朝向分; 位置是在这条线上从起点量的格数 (只在查一格时给)" } };
}
