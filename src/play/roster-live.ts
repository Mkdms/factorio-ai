// 中途加人 / 移出 (库, 不直接运行):
// 控制接口往 <班次>/roster.jsonl 追加一行 (join / leave), run.ts 的监工每 30 秒读新行照做 —— 和 STOP 文件、tells.jsonl 同一套"文件当信箱"的做法, 控制接口不碰在跑的进程。
// 加人 = 新建游戏角色 (bot_create) + 大脑目录 + 简报 + 开它的轮次循环; 移出 = 停掉那个大脑、收回游戏角色 (bot_remove: 角色原地倒下, 尸体里留着背包)。
import fs from "node:fs";
import { cleanSeat, type RosterSeat } from "./roster.ts";
import { botName } from "./model-name.ts";

export const ROSTER_FILE = "roster.jsonl";
export type RosterOp = { at: string } & ({ op: "join"; seat: RosterSeat } | { op: "leave"; agent: string });

/** 一行 → 操作; 不认识 / 坏行 → null (跳过, 不让一行坏数据停掉监工) */
export function parseRosterOp(line: string): RosterOp | null {
  let o: any;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const at = typeof o.at === "string" ? o.at : new Date(0).toISOString();
  if (o.op === "join") { const seat = cleanSeat(o.seat); return seat ? { at, op: "join", seat } : null; }
  if (o.op === "leave") { const agent = typeof o.agent === "string" ? o.agent.trim() : ""; return /^[a-z]$/.test(agent) ? { at, op: "leave", agent } : null; }
  return null;
}

/** 从上次读到的字节位置往后读新行 (文件还没有 / 没新内容 → 空); 只认整行 (末尾没换行的半行留到下次) */
export function readRosterOps(file: string, from: number): { ops: RosterOp[]; next: number } {
  let buf: Buffer;
  try { buf = fs.readFileSync(file); } catch { return { ops: [], next: from }; }
  if (buf.length <= from) return { ops: [], next: from };
  const chunk = buf.subarray(from);
  const lastNl = chunk.lastIndexOf(0x0a);
  if (lastNl < 0) return { ops: [], next: from };
  const text = chunk.subarray(0, lastNl + 1).toString("utf8");
  const ops = text.split("\n").map((l) => l.trim()).filter(Boolean).map(parseRosterOp).filter((x): x is RosterOp => !!x);
  return { ops, next: from + lastNl + 1 };
}

export function appendRosterOp(file: string, op: RosterOp): void {
  fs.appendFileSync(file, JSON.stringify(op) + "\n");
}

/** 只有这种名字才拼进 Lua (和我们移植的模组规则一样) */
export const isSafeBotName = (name: string): boolean => /^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(name);

/** 收回角色后把尸体里的东西搬进旁边的钢箱 (bot_remove 让角色原地倒下, 背包在尸体里, 尸体到时间会消失): 找最近的尸体, 一格一格搬, 满了再放一个箱子 */
export function salvageLua(x: number, y: number): string {
  const n = (v: number) => (Number.isFinite(v) ? String(v) : "0");
  return `local s = game.surfaces[1] local x, y = ${n(x)}, ${n(y)}
    local best, bd for _, c in pairs(s.find_entities_filtered{name = "character-corpse", position = {x, y}, radius = 4}) do
      local d = (c.position.x - x) ^ 2 + (c.position.y - y) ^ 2 if not bd or d < bd then best, bd = c, d end end
    if not best then return {found = false} end
    local inv = best.get_inventory(defines.inventory.character_corpse)
    local chests, items, left, chest = {}, 0, 0, nil
    local function newChest()
      local pos = s.find_non_colliding_position("steel-chest", {x, y}, 30, 1, true) if not pos then return nil end
      local c = s.create_entity{name = "steel-chest", position = pos, force = "player"}
      if c then chests[#chests + 1] = {x = c.position.x, y = c.position.y} end return c end
    if inv then for i = 1, #inv do local st = inv[i] if st.valid_for_read then
      local guard = 0
      while st.valid_for_read and guard < 4 do guard = guard + 1
        if not chest then chest = newChest() if not chest then break end end
        local before = st.count local moved = chest.insert(st) items = items + moved
        if moved >= before then st.clear() else if moved > 0 then st.count = before - moved end chest = nil end
      end
      if st.valid_for_read then left = left + st.count end
    end end end
    if left == 0 then best.destroy() end
    return {found = true, items = items, left = left, chests = chests}`;
}

export type Salvage = { found: boolean; items: number; left: number; chests: { x: number; y: number }[] };
/** lab.exec 的回复 → 结构 (字符串要再解一层; Lua 空表回来是 {}) */
export function normalizeSalvage(raw: unknown): Salvage {
  let o: any = raw;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { o = null; } }
  return { found: o?.found === true, items: Number(o?.items) || 0, left: Number(o?.left) || 0, chests: Array.isArray(o?.chests) ? o.chests : [] };
}
export function salvageText(s: Salvage): string {
  if (!s.found) return "附近没找到尸体, 背包没搬";
  if (!s.items && !s.left) return "背包是空的";
  const where = s.chests.map((c) => `(${c.x}, ${c.y})`).join("、");
  return `背包 ${s.items} 个物品放进了钢箱 ${where}${s.left ? `; 还有 ${s.left} 个没放下, 留在尸体里` : ""}`;
}

/** 下一个空着的角色 id (a~z, 用过的不复用: 记录文件按 id 命名); 满了 null */
export function nextAgentId(used: string[]): string | null {
  for (let i = 0; i < 26; i++) { const id = String.fromCharCode(97 + i); if (!used.includes(id)) return id; }
  return null;
}

/** 新角色在游戏里的名字: 模型名规范写法, 和已有同模型的错开 (Claude-Opus-5.5 → 第 2 个 Claude-Opus-5.5-2), 和 src/play/brains.ts lineup() 同一条规则 */
export function nthBotName(brain: string, model: string, existing: string[]): string {
  const base = botName(brain, 1, model);
  for (let nth = 1; nth < 100; nth++) { const n = botName(brain, nth, model); if (!existing.includes(n)) return n; }
  return `${base}-${Date.now() % 1000}`;
}
