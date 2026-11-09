// 用 注入客户端的程序 (game/client) 做界面类动作 (M4 清单第 6 条; 旧项目 docs/io-client.md 第 11 节 T10)。
// 照第一版 pilot/src/skills/place-area.ts 的 setClipboard / stampBlueprint 改写: 快捷栏"导入字符串" → 输入框 → 导入 → 手里拿着蓝图 → 鼠标指地面 → 放虚影。
// 第一版的坑: 他的 set_text 最多 1024 字 (0.0.10 文档仍是), 剪贴板 Ctrl+V 粘 517 字成功、3757 字失败 (原因没查清) → 这里每一步都读回核对:
// 粘贴后先读输入框里的字数, 再点导入; 导入后读手上是不是蓝图。动作只报已发出 (他的规矩), 结果都靠读回。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Call } from "./query.ts";
import { readPlayer } from "./query.ts";
import { Timeline } from "./timeline.ts";
import type { Controls } from "./controls.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd: string) => execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], { windowsHide: true, timeout: 20_000, encoding: "utf8" });

/** 系统剪贴板 (游戏和我们在同一台电脑上)。会覆盖用户的剪贴板: 先 save() 存原文字, 用完 restore() */
export const clipboard = {
  set(text: string) {
    const f = path.join(os.tmpdir(), `fp-clip-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(f, text, "utf8");
    try { ps(`Set-Clipboard -Value (Get-Content -Raw -LiteralPath '${f}')`); } finally { fs.rmSync(f, { force: true }); }
  },
  save(): string | null {
    try { const t = ps("Get-Clipboard -Raw"); return t === "" ? null : t.replace(/\r?\n$/, ""); } catch { return null; }
  },
  restore(saved: string | null) {
    if (saved !== null) this.set(saved);
  },
};

const TEXTBOX = { path: [{ axis: "descendant", match: { native_type: "agui::TextBox", visible: true } }] };

async function ok(call: Call, name: string, args: Record<string, unknown>) {
  const r = await call(name, args);
  if (!r.ok) throw new Error(`${name} 失败: ${(r.error ?? "").slice(0, 200)}`);
  return r.data as Record<string, unknown>;
}

/** 输入框里现在的字数 (没打开 = -1) */
export async function textboxLength(call: Call): Promise<number> {
  const r = await call("ui_read", { selector: TEXTBOX });
  const nodes = ((r.data as { nodes?: { matched?: boolean; visible?: boolean; text?: string | null }[] } | undefined)?.nodes ?? []).filter((n) => n.matched && n.visible);
  if (!nodes.length) return -1;
  return (nodes[0].text ?? "").length; // text 缺省 = 空字符串 (他的约定)
}

export type ImportMode = "clipboard" | "set_text";

/**
 * 把蓝图字符串导进手里 (光标)。返回每一步的读回: 粘进去几个字、手上是什么。
 * mode clipboard: 剪贴板 + 点一下输入框 + Ctrl+V (按键时间线); set_text: 他的 set_text (≤1024 字)
 */
export async function importBlueprint(call: Call, controls: Controls, text: string, mode: ImportMode, waitMs = 1500) {
  const steps: Record<string, unknown> = { length: text.length, mode };
  await ok(call, "ui_action", { action: "click", selector: { path: [{ axis: "descendant", match: { prototype: { name: "import-string" } } }] } });
  let len = -1;
  for (let i = 0; i < 20 && len < 0; i++) { await sleep(150); len = await textboxLength(call); }
  if (len < 0) throw new Error("导入字符串的窗口没打开");
  if (mode === "set_text") {
    await ok(call, "ui_action", { action: "set_text", selector: TEXTBOX, text });
  } else {
    clipboard.set(text);
    await ok(call, "ui_action", { action: "click", selector: TEXTBOX });
    const t = new Timeline().key("LCTRL", 0, 6).key("V", 2, 4);
    await ok(call, "input", { timeline: t.entries });
  }
  await sleep(waitMs);
  steps.pasted = await textboxLength(call);
  await ok(call, "ui_action", { action: "click", selector: { path: [{ axis: "descendant", match: { native_type: "agui::TextButton", text: "导入" } }] } });
  // 大蓝图导入要时间 (5 万字第一次只等了约 2 秒, 手上还是空): 最多等 10 秒
  let p = await readPlayer(call);
  for (let i = 0; i < 50 && !p.cursor; i++) { await sleep(200); p = await readPlayer(call); }
  steps.cursor = p.cursor?.name ?? null;
  if (!p.cursor) {
    // 还是空: 把界面上能看到的文字读出来 (可能是提示或报错)
    const r = await call("ui_read", {});
    const labels = ((r.data as { nodes?: { type?: string; text?: string | null; visible?: boolean }[] } | undefined)?.nodes ?? []).filter((n) => n.visible && typeof n.text === "string" && n.text.length > 0 && n.text.length < 300).map((n) => n.text);
    steps.uiText = labels.slice(0, 12);
  }
  if (p.cursor?.name !== "blueprint" && (await textboxLength(call)) >= 0) await call("input", { timeline: new Timeline().key(controls.key("toggle-menu"), 0).entries }).catch(() => undefined);
  return steps as { length: number; mode: ImportMode; pasted: number; cursor: string | null; uiText?: string[] };
}

/** 手里拿着蓝图时, 鼠标指到地面某点, 按"放虚影" (默认 Shift+左键) 放下, 再把手清空 */
export async function placeHeldBlueprint(call: Call, controls: Controls, at: { x: number; y: number }) {
  const t = new Timeline().worldPosition(at, 0, 10).control(controls.resolve("build-ghost"), 5, 6);
  await ok(call, "input", { timeline: t.entries });
  await sleep(400);
  await ok(call, "input", { timeline: new Timeline().key(controls.key("clear-cursor"), 0).entries });
}

// ---------- 界面小功能 + 按数量取放 (M4 清单第 7 条, T8): 搬自第一版 pilot/src/skills/ui.ts、transfer.ts ----------
type UiNode = { id: number; parent?: number; type: string; text?: string | null; visible?: boolean; matched?: boolean; properties?: { prototype?: { name?: string }; element?: { count?: number }; number?: { value?: number }; icons?: { normal?: { name?: string } | null } } };
type Pos = { x: number; y: number };

export async function readTree(call: Call, selector?: unknown): Promise<UiNode[]> {
  // 0.0.11: 没有 max_nodes 了 (按相对深度 max_depth 截, 不按节点数); 带选择器时只回匹配到的子树, 匹配到的根 matched = true
  const r = await call("ui_read", selector ? { selector } : {});
  return ((r.data as { nodes?: UiNode[] } | undefined)?.nodes ?? []);
}
const hasWidget = async (call: Call, t: string) => (await readTree(call, { path: [{ axis: "descendant", match: { native_type: t } }] })).some((n) => n.type === t || n.type.endsWith(t));
export const isCharacterGuiOpen = (call: Call) => hasWidget(call, "CraftingGui");
export async function pressKey(call: Call, key: string) { await ok(call, "ui_action", { action: "press_key", key }); }

/** 点控件; 找不到时把选择器写进报错 (第一版: 光秃秃的 "matched no widget" 让人猜了一周) */
export async function clickWidget(call: Call, selector: unknown, button: "left" | "right" | "middle" = "left", modifiers: string[] = []) {
  const r = await call("ui_action", { action: "click", selector, button, ...(modifiers.length ? { modifiers } : {}) });
  if (!r.ok) throw new Error(`${(r.error ?? "").slice(0, 120)} [${JSON.stringify(selector).replace(/"axis":"descendant",/g, "").slice(0, 160)}]`);
}

export async function openCharacterGui(call: Call, controls: Controls) {
  if (await isCharacterGuiOpen(call)) return;
  await pressKey(call, controls.key("open-character-gui"));
  await sleep(150);
  if (await isCharacterGuiOpen(call)) return;
  // 别的窗口抢了焦点 (按键把它关掉了而不是打开背包): 关掉再试一次 (第一版)
  await pressKey(call, "ESCAPE");
  await sleep(150);
  await pressKey(call, controls.key("open-character-gui"));
  await sleep(150);
  if (!(await isCharacterGuiOpen(call))) throw new Error("背包窗口没打开");
}

/** 关掉打开的窗口: 背包键关实体窗口; 若因此打开了背包, 再关掉 (第一版 closeEntityGui) */
export async function closeWindows(call: Call, controls: Controls) {
  await pressKey(call, controls.key("open-character-gui"));
  await sleep(150);
  if (await isCharacterGuiOpen(call)) { await pressKey(call, controls.key("open-character-gui")); await sleep(150); }
  if (await isCharacterGuiOpen(call)) { await pressKey(call, "ESCAPE"); await sleep(150); }
}

export async function clearCursor(call: Call, controls: Controls) {
  // 手上空着不按: 这个键空手时是吸管, 会把鼠标指着的东西从背包吸到手上 (2026-11-06 动作核对: build_path 重跑一格没铺, 背包却少了)
  if (!(await readPlayer(call)).cursor) return;
  await ok(call, "input", { timeline: new Timeline().key(controls.key("clear-cursor"), 0, 2).entries });
  // 等手上真空了才回: 联机有网络延迟 (真服日志 latency 32 tick), 下一条读背包会少算手上那些 (2026-11-06 注入客户端的程序 存档副本)
  for (let i = 0; i < 25; i++) { await sleep(100); if (!(await readPlayer(call)).cursor) return; }
}

/** 空手对着实体按"打开窗口"; 手里有东西时左键会放下或用掉 (第一版坑 #1), 所以先清手 */
export async function openEntity(call: Call, controls: Controls, at: Pos) {
  if ((await readPlayer(call)).cursor) await clearCursor(call, controls);
  await ok(call, "input", { timeline: new Timeline().worldPosition(at, 0, 10).control(controls.resolve("open-gui"), 4, 6).entries });
  await sleep(250);
  return readTree(call);
}

// 物品占好几格时选择器会同时匹配几格, 注入客户端的程序 0.0.10 拒绝有歧义的选择 ("UI selector is ambiguous"; 第一版那时默认第一个) → 明确取第一格
export const invSlot = (item: string) => ({ path: [{ axis: "descendant", match: { native_type: "InventoryGui" } }, { axis: "descendant", match: { native_type: "InventoryGuiSlot", prototype: { name: item } }, position: 1 }] });

/**
 * 一下下右键放回, 直到手上剩 count 个。每点一次都等手上数量真的变了再点下一次 (最多等 1 秒):
 * 动作只报已发出 (注入客户端的程序 规矩), 连点时读到的数量落后于已发出的点击, 会多放回 (2026-11-02 T8: 要 25 拿到 23)。返回每次点完的数量序列。
 */
async function putBackUntil(call: Call, sel: unknown, count: number) {
  const seq: number[] = [];
  for (let i = 0; i < 200; i++) {
    const before = (await readPlayer(call)).cursor?.count ?? 0;
    seq.push(before);
    if (before <= count) break;
    await clickWidget(call, sel, "right");
    let after = before;
    for (let w = 0; w < 10 && after === before; w++) { await sleep(100); after = (await readPlayer(call)).cursor?.count ?? 0; }
    if (after === before) { seq.push(after); break; } // 点了没变化: 不再盲目连点
  }
  return seq;
}

/** 手上拿正好 count 个: 背包里左键拿一组 (要的不到半组就右键拿半组), 再在原格子上右键一个个放回 (第一版 pickItem) */
export async function pickExact(call: Call, controls: Controls, item: string, count: number) {
  if ((await readPlayer(call)).cursor) await clearCursor(call, controls);
  await openCharacterGui(call, controls);
  const nodes = await readTree(call, invSlot(item));
  const slot = nodes.find((n) => n.type === "InventoryGuiSlot" && n.properties?.prototype?.name === item);
  const first = slot?.properties?.element?.count ?? slot?.properties?.number?.value ?? 1;
  await clickWidget(call, invSlot(item), count <= Math.floor(first / 2) ? "right" : "left");
  await sleep(300);
  const seq = await putBackUntil(call, invSlot(item), count);
  const got = (await readPlayer(call)).cursor;
  await closeWindows(call, controls);
  return got ? { ...got, seq } : null;
}

/**
 * 往实体里放正好 count 个。第一版的做法 (在背包里右键凑出正好的数量, 再 Ctrl+点击实体) 在 2.1 不成立:
 * 在自己背包格子上右键一个都放不回 (2026-11-02 T8: 手上一直 50) → 改成: 打开实体窗口, 从窗口里的背包面板左键拿起一组,
 * 在**实体的格子**上一下下右键, 每次放进 1 个 (取出时右键实体格子是有效的), 放够了清手 (剩下的回背包)。
 */
export async function insertExact(call: Call, controls: Controls, at: Pos, item: string, count: number) {
  const nodes = await openEntity(call, controls, at);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const under = (n: UiNode, re: RegExp) => { for (let cur: UiNode | undefined = n, d = 0; cur && d < 14; cur = cur.parent !== undefined ? byId.get(cur.parent) : undefined, d++) if (re.test(cur.type)) return true; return false; };
  const own = nodes.filter((n) => /Slot/.test(n.type) && !under(n, /^(InventoryGui|ToolEquipGui|QuickBarGui|CraftingGui)$/));
  const target = own.find((n) => n.properties?.prototype?.name === item) ?? own.find((n) => !n.properties?.prototype?.name);
  if (!target) { await closeWindows(call, controls); throw new Error(`窗口里没有能放 ${item} 的格子`); }
  const dest = { path: [{ axis: "descendant", match: { native_type: target.type }, position: nodes.filter((n) => n.type === target.type).indexOf(target) + 1 }] };
  await clickWidget(call, invSlot(item), "left"); // 窗口里的背包面板: 拿起第一格那一组
  await sleep(300);
  const picked = (await readPlayer(call)).cursor;
  if (picked?.name !== item || (picked.count ?? 0) < count) { await closeWindows(call, controls); await clearCursor(call, controls); return { picked, inserted: 0 }; }
  const seq = await putBackUntil(call, dest, (picked.count ?? 0) - count);
  const left = (await readPlayer(call)).cursor;
  await closeWindows(call, controls);
  await clearCursor(call, controls);
  return { picked, held: left ? { ...left, seq } : null, inserted: (picked.count ?? 0) - (left?.count ?? 0) };
}

/**
 * 从实体里取正好 count 个: 打开它的窗口, 在它自己的格子 (不在玩家面板里的) 左键拿起那一组, 右键一个个放回到剩 count 个, 关窗口后清手 (进背包)。
 * 不用空手 Ctrl+点击: 那会把这种物品**全**拿走 (第一版 2026-10-29: 要 6 组拿走了 3263 个填埋材料)。
 */
export async function takeExact(call: Call, controls: Controls, at: Pos, item: string, count: number) {
  const nodes = await openEntity(call, controls, at);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const under = (n: UiNode, re: RegExp) => { for (let cur: UiNode | undefined = n, d = 0; cur && d < 14; cur = cur.parent !== undefined ? byId.get(cur.parent) : undefined, d++) if (re.test(cur.type)) return true; return false; };
  const slots = nodes.filter((n) => /Slot/.test(n.type) && !under(n, /^(InventoryGui|ToolEquipGui|QuickBarGui|CraftingGui)$/) && n.properties?.prototype?.name === item);
  if (!slots.length) {
    const slotNodes = nodes.filter((n) => /Slot/.test(n.type));
    const types = [...new Set(nodes.map((n) => n.type).filter((t) => !t.startsWith("agui::")))].slice(0, 20);
    await closeWindows(call, controls);
    throw new Error(`窗口里没有 ${item} 的格子; 界面类型 ${types.join(",")}; 格子 ${slotNodes.length} 个, 第一个 ${JSON.stringify(slotNodes.find((n) => !under(n, /^(InventoryGui|ToolEquipGui|QuickBarGui|CraftingGui)$/)) ?? slotNodes[0] ?? null).slice(0, 300)}`);
  }
  const target = slots[0];
  const sel = { path: [{ axis: "descendant", match: { native_type: target.type }, position: nodes.filter((n) => n.type === target.type).indexOf(target) + 1 }] };
  await clickWidget(call, sel, "left");
  await sleep(300);
  const seq = await putBackUntil(call, sel, count);
  const c = (await readPlayer(call)).cursor;
  const held = c ? { ...c, seq } : null;
  await closeWindows(call, controls);
  await clearCursor(call, controls);
  return { held };
}

// ---------- 设请求和设配方 (M4 清单第 8 条, T9): 搬自第一版 pilot manual.ts setRequest、ui.ts chooseRecipe, 按 2026-11-02 在 2.1.24 现场看到的界面改 ----------
const step = (native_type: string, extra: Record<string, unknown> = {}, position?: number) => ({ axis: "descendant", match: { native_type, ...extra }, ...(position ? { position } : {}) });
const live = (nodes: UiNode[]) => nodes.filter((n) => n.matched);
async function waitFor(fn: () => Promise<boolean>, ms = 2000) {
  for (let t = 0; t < ms; t += 100) { if (await fn()) return true; await sleep(100); }
  return fn();
}
const present = (call: Call, t: string) => async () => live(await readTree(call, { path: [step(t)] })).length > 0;

/** 弹窗 / 选择窗口里, 物品或配方的格子不在当前标签页时逐页找 (选择器只能按类型 / 文字 / 原型匹配, 标签页按原型名点) */
async function showSlot(call: Call, root: ReturnType<typeof step>, slotType: string, name: string) {
  const visible = async () => live(await readTree(call, { path: [root, step(slotType, { prototype: { name } })] })).some((n) => n.visible !== false);
  if (await visible()) return true;
  const tabs = live(await readTree(call, { path: [root, step("ItemGroupTab")] })).map((n) => n.properties?.prototype?.name).filter(Boolean) as string[];
  for (const tab of tabs) {
    await clickWidget(call, { path: [root, step("ItemGroupTab", { prototype: { name: tab } })] });
    await sleep(150);
    if (await visible()) return true;
  }
  return false;
}

/**
 * 手搓 count 次 (M4 第 4 步; 搬自第一版 pilot ui.ts craft, 那边在 2.1.23 真服上用过): 开背包 → 找配方格 (不在当前标签页就逐页找) → 右键一次 5 个、左键一次 1 个 → 关窗口。
 * 没解锁或不能手搓时配方格不在, 报错。材料够不够由调用方读手搓队列判断 (动作只报已发出)。
 */
export async function craftByHand(call: Call, controls: Controls, recipe: string, count: number) {
  await openCharacterGui(call, controls);
  try {
    const root = step("CraftingGui");
    if (!(await showSlot(call, root, "RecipeSlot", recipe))) throw new Error(`recipe is unavailable: ${recipe} 不在手搓面板里 (没解锁或不能手搓)`);
    const sel = { path: [root, step("RecipeSlot", { prototype: { name: recipe } }, 1)] };
    let queued = 0;
    while (queued < count) {
      if (count - queued >= 5) { await clickWidget(call, sel, "right"); queued += 5; } else { await clickWidget(call, sel, "left"); queued += 1; }
      await sleep(40);
    }
    return { queued };
  } finally { await closeWindows(call, controls); }
}

/**
 * 开始研究或排进队列 (M4 第 4 步; 搬自第一版 pilot ui.ts research, 控件 2.1.23 核实): 科技窗口 → 点科技格 (同名有列表和图两份, 第一份是列表) → 点"开始研究 / 排队研究"。
 * 联机时科技窗口不暂停; 单机会暂停, 所以无论如何都要关干净。按钮灰的 (前置没完成、没有瓶) 报错。
 */
export async function researchTech(call: Call, controls: Controls, tech: string) {
  const open = present(call, "TechnologyListGui");
  if (!(await open())) {
    await pressKey(call, controls.key("open-technology-gui"));
    if (!(await waitFor(open))) throw new Error("科技窗口没打开");
  }
  try {
    await clickWidget(call, { path: [step("TechnologySlot", { prototype: { name: tech, native_type: "TechnologyPrototype" } }, 1)] });
    await sleep(150);
    const rows = live(await readTree(call, { path: [step("FeaturedTechnologyGui"), step("agui::TextButton")] }));
    const btn = rows.find((n) => n.type === "agui::TextButton");
    if (!btn) throw new Error(`${tech}: 没有开始研究的按钮`);
    if (btn.enabled === false) throw new Error(`${tech} 现在不能研究 (前置没完成或没有瓶): "${btn.text ?? ""}"`);
    const queued = /排队|queue/i.test(btn.text ?? "");
    await clickWidget(call, { path: [step("FeaturedTechnologyGui"), step("agui::TextButton", {}, 1)] });
    await sleep(150);
    return { queued };
  } finally {
    for (const key of ["ESCAPE", "ESCAPE", controls.key("open-character-gui")]) { if (!(await open())) break; await pressKey(call, key); await sleep(150); }
  }
}

/**
 * 把一项研究从队列拿掉 (模型因为"排了撤不掉"不敢排): 科技窗口上方的队列 ResearchQueueGui, 每项 TechnologyQueueElement 里有格子和一个关闭按钮 (真人鼠标移上去才显示, 沙盘实测隐藏时也点得到; 右键只会关窗口)。
 * 排在它后面、依赖它的会被游戏一起拿掉。
 */
export async function cancelResearch(call: Call, controls: Controls, tech: string) {
  const open = present(call, "TechnologyListGui");
  if (!(await open())) {
    await pressKey(call, controls.key("open-technology-gui"));
    if (!(await waitFor(open))) throw new Error("科技窗口没打开");
  }
  try {
    const queued = async () => {
      const nodes = await readTree(call, { path: [step("ResearchQueueGui")] });
      const rows = nodes.filter((n) => n.type === "TechnologyQueueElement");
      // 按父子关系认: 控件表里子节点排在父节点前面, 按出现顺序数会错一位, 取消错项 (2026-11-06 沙盘: 要取消 concrete, circuit-network 没了)
      return nodes.filter((n) => n.type === "TechnologySlot" && n.properties?.prototype?.name).map((n) => ({ name: String(n.properties?.prototype?.name), at: rows.findIndex((r) => r.id === n.parent) + 1 })).filter((s) => s.at > 0);
    };
    const before = await queued();
    const hit = before.find((s) => s.name === tech);
    if (!hit) throw new Error(`${tech} 不在研究队列里 (队列: ${before.map((s) => s.name).join(", ") || "空"})`);
    await clickWidget(call, { path: [step("ResearchQueueGui"), step("TechnologyQueueElement", {}, hit.at), step("IconButton", {}, 1)] });
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const now = (await queued()).map((s) => s.name);
      if (!now.includes(tech)) {
        // 只许少掉它和排在它后面的 (依赖它的游戏会一起拿掉); 前面的少了就是点错了, 要说出来
        const lost = before.filter((s) => s.at < hit.at && !now.includes(s.name)).map((s) => s.name);
        if (lost.length) throw new Error(`取消 ${tech} 时前面的 ${lost.join(", ")} 也没了, 像是点错了`);
        return;
      }
    }
    throw new Error(`点了取消, ${tech} 还在队列里`);
  } finally {
    for (const key of ["ESCAPE", "ESCAPE", controls.key("open-character-gui")]) { if (!(await open())) break; await pressKey(call, key); await sleep(150); }
  }
}

/** 按图标名点按钮: 选择器不能按图标匹配, 按它在同类按钮里的位置点 (都是叶子控件, 输出顺序和选择器的先序一致) */
async function clickIcon(call: Call, root: ReturnType<typeof step>, icon: string) {
  const btns = live(await readTree(call, { path: [root, step("IconButton")] }));
  const pos = btns.findIndex((n) => n.properties?.icons?.normal?.name === icon) + 1;
  if (!pos) throw new Error(`没有图标为 ${icon} 的按钮 (有: ${btns.map((n) => n.properties?.icons?.normal?.name).join(",")})`);
  await clickWidget(call, { path: [root, step("IconButton", {}, pos)] });
}

/**
 * 给优先集货箱（蓝箱）等物流箱设一条请求: 最小 min, 最大 max (省略 = 无限)。有这个物品的请求格就改它, 没有就用第一个空格。
 * 2.1.24 的界面 (2026-11-02 T9 现场看): 请求格 ChooseLogisticRequestAndTrashButton → 弹窗 ItemAndDoubleCountSelectGui
 * (物品标签页 + SimpleSlot<SignalIDBase>, 最小框 = 第 1 个输入框, 最大框 = 第 2 个, 一条双头滑块) → 点弹窗里的绿勾 (图标 check_mark) 确认。
 * 坑: 按确认键 (E) 关不掉弹窗、请求不生效; 最大框清空或填"无限"都不行 —— 服务器读回最小 0 最大 0;
 * "无限"要点滑块最右端 (先点滑块再填最小)。动作只报已发出, 是否生效由调用方等过延迟后读回 (readRequests)。
 */
export async function setRequest(call: Call, controls: Controls, at: Pos, item: string, min: number, max?: number) {
  const nodes = await openEntity(call, controls, at);
  try {
    const slots = nodes.filter((n) => n.type === "ChooseLogisticRequestAndTrashButton");
    if (!slots.length) throw new Error("窗口里没有请求格 (不是物流箱?)");
    const existing = slots.find((n) => n.properties?.prototype?.name === item);
    const target = existing ?? slots.find((n) => !n.properties?.prototype?.name);
    if (!target) throw new Error(`请求格已满 (${slots.length} 格)`);
    await clickWidget(call, { path: [step("ChooseLogisticRequestAndTrashButton", {}, slots.indexOf(target) + 1)] });
    const root = step("ItemAndDoubleCountSelectGui");
    if (!(await waitFor(present(call, "ItemAndDoubleCountSelectGui")))) throw new Error("点请求格后没有弹出设置请求的窗口");
    if (!existing) {
      if (!(await showSlot(call, root, "SimpleSlot<class SignalIDBase>", item))) throw new Error(`设置请求的窗口里找不到 ${item}`);
      await clickWidget(call, { path: [root, step("SimpleSlot<class SignalIDBase>", { prototype: { name: item } }, 1)] });
      await sleep(250);
    }
    const field = (i: number) => ({ path: [root, step("agui::TextField", {}, i)] });
    if (max === undefined) {
      const r = await call("ui_action", { action: "click", selector: { path: [root, step("agui::DoubleSlider")] }, position: { x: 0.995, y: 0.5 } });
      if (!r.ok) throw new Error(`点滑块右端失败: ${r.error}`);
      await sleep(150);
      await ok(call, "ui_action", { action: "set_text", selector: field(1), text: String(Math.round(min)) });
    } else {
      await ok(call, "ui_action", { action: "set_text", selector: field(1), text: String(Math.round(min)) });
      await ok(call, "ui_action", { action: "set_text", selector: field(2), text: String(Math.round(max)) });
    }
    await sleep(150);
    const fields = live(await readTree(call, { path: [root, step("agui::TextField")] })).slice(0, 2).map((n) => n.text ?? "");
    await clickIcon(call, root, "check_mark");
    const closed = await waitFor(async () => !(await present(call, "ItemAndDoubleCountSelectGui")()));
    if (!closed) throw new Error(`点绿勾后设置请求的窗口没关 (输入框 ${fields.join(" / ")})`);
    return { slot: slots.indexOf(target) + 1, fields };
  } finally {
    await closeWindows(call, controls);
  }
}

/**
 * 给组装机设配方。没配方的机器一打开就是选配方窗口 (AssemblingMachineSelectRecipeGui); 有配方的先点机器窗口里的"换配方"按钮 (图标 change_recipe)。
 * 配方不在选配方窗口里 (没解锁 / 这台机器做不了) 就报错。2026-11-02 T9: 第一版这段在 2.1.24 仍对, 只是"换配方"按钮按图标名找。
 */
export async function setRecipe(call: Call, controls: Controls, at: Pos, recipe: string) {
  await openEntity(call, controls, at);
  try {
    const picker = step("AssemblingMachineSelectRecipeGui");
    if (!(await present(call, "AssemblingMachineSelectRecipeGui")())) {
      await clickIcon(call, step("AssemblingMachineGui"), "change_recipe");
      if (!(await waitFor(present(call, "AssemblingMachineSelectRecipeGui")))) throw new Error("点换配方后没有打开选配方窗口");
    }
    if (!(await showSlot(call, picker, "RecipeSlot", recipe))) throw new Error(`选配方窗口里没有 ${recipe} (没解锁或这台机器做不了)`);
    await clickWidget(call, { path: [picker, step("RecipeSlot", { prototype: { name: recipe } }, 1)] });
    const closed = await waitFor(async () => !(await present(call, "AssemblingMachineSelectRecipeGui")()));
    return { pickerClosed: closed };
  } finally {
    await closeWindows(call, controls);
  }
}
