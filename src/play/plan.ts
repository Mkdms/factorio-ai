#!/usr/bin/env node
// ./plan 物品 每分钟 [--near x,y]: 大脑用的 (用户不用打任何命令): 算全链 → 减场上已有 → 挑蓝图 → 找空地 → 查背包缺什么, 打出能直接跑的 ./bp build。
// 只读游戏, 不放东西; 放不放由大脑定。逻辑在 plan-lib.ts。
import fs from "node:fs";
import path from "node:path";
import { labRoot } from "../lab/gamedir.ts";
import { loadGameData } from "../calc/data.ts";
import { solvePlan } from "../calc/solve.ts";
import { argvFromFile } from "./argv-file.ts";
import { entries, type Entry } from "./bp.ts";
import { loadZhNames } from "./chattags.ts";
import { deltas, EXISTING_LUA, normalizeExisting, type Tech } from "./expand.ts";
import { handRecipeOf } from "./bp-gather.ts";
import { chainPlan, downgrade, missingItems, otherBlocks, pickBlock, planText, recipeFor, resolveItem, siteLua, unreachableTier, type Block, type Pick } from "./plan-lib.ts";

type PlanStep = { pick: Pick; at: { x: number; y: number } | null; lack: { item: string; lack: number }[]; others: { block: Block; size: number; shape: string }[] };

/** ./plan --build 一次最多放几块: 再多一条命令就要等好几分钟 */
const BUILD_MAX = 2;

/** 按步骤放块; 建过的下次 ./plan 从差额里减掉, 所以重跑不会重复放 */
async function goBuild(steps: { pick: { block: Block; delta: { add: number } }; at: { x: number; y: number } | null }[], again: string, retry?: (missing: Record<string, number>) => Promise<number | null>): Promise<number> {
  const { build } = await import("./bp.ts");
  const todo = steps.filter((s) => s.at);
  // 没有步骤 = 差额都是 0 或库里没块 (上面 planText 列了), 不是找不到地方 (2026-11-06 验证班: 机器够了还说"库里没有, 或附近找不到空地")
  if (!steps.length) { console.log("这次没有要放的块: 机器数够了, 差的 (上面列的) 库里没有现成的块。"); return 0; }
  if (!todo.length) { console.log("附近找不到空地, 什么都没放; 换个地方试 --near x,y。"); return 1; }
  let done = 0;
  for (const s of todo.slice(0, BUILD_MAX)) {
    console.log(`\n--- ./bp build ${s.pick.block.no} --at ${s.at!.x},${s.at!.y}`);
    const out: { missing?: Record<string, number> } = {};
    const code = await build(s.pick.block as Entry, ["--at", `${s.at!.x},${s.at!.y}`], String(s.pick.block.no), out);
    if (code === 2) { console.log(`\n料还在手搓, 这块没放。搓完再跑一次 ${again} (放好的不会重复)。`); return 2; }
    if (code !== 0) {
      const second = out.missing && retry ? await retry(out.missing) : null;
      if (second !== null) return second;
      console.log(`\n这块没放成, 后面的也没放; 已放 ${done} 块。看上面的原因, 修好再跑 ${again}。`);
      return code;
    }
    done++;
  }
  console.log(`\n放了 ${done} 块${todo.length > done ? `, 还差 ${todo.length - done} 块: 再跑一次 ${again}` : ""}。`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [name, rateText] = argv;
  // --near x,y 和 --near=x,y 都认 (2026-11-05 Gpt 写 --near=-25,20 被当成没给)
  const opt = (k: string) => { const eq = argv.find((a) => a.startsWith(`${k}=`)); if (eq) return eq.slice(k.length + 1); const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const perMin = Number(rateText);
  if (!name || !Number.isFinite(perMin) || perMin <= 0) { console.log("用法: ./plan 物品 每分钟 [--near x,y] [--build]  例: ./plan 化工科技包 30 (只算, 给步骤); 加 --build 算完直接放"); return 1; }
  // --build: 算完直接放 (一条命令顶手放几十条; 第 5 班起他们知道有块也嫌接不上: 算 → 选块 → 找空地 → 备料 → 放是 5 步)。放不放还是模型定, 这只是把它要做的事串起来
  const go = argv.includes("--build");
  const near = opt("--near")?.split(",").map(Number) as [number, number] | undefined;
  if (near && (near.length !== 2 || near.some((v) => !Number.isFinite(v)))) { console.log("error: --near 要写成 x,y"); return 1; }
  const gd = loadGameData();
  const zhMap = loadZhNames(process.env.FH_PROTO || path.join(labRoot(), "prototypes"));
  const zh = (id: string) => zhMap.get(id) ?? id;
  const item = resolveItem(name, zhMap, (id) => recipeFor(gd, id) !== null);
  if (!item) { console.log(`error: 认不出 "${name}", 写内部名或官方中文名 (ref/names.tsv)`); return 1; }
  // 新项目: 只走角色目录的管道 (和 ./fh 同一条; 没有 RCON)。场上读数和找空地 = 代理里跑在游戏外假接口上的两段固定 Lua (commands/broker.ts plan_read), 模型手里没有 Lua
  const pipe = process.env.FH_SOCKET, session = process.env.FP_SESSION;
  const { Harness } = await import("./harness.ts");
  let h: InstanceType<typeof Harness>, planRead: (args: Record<string, unknown>) => Promise<any>, close = () => {};
  if (pipe) {
    const { PipeRcon } = await import("../io/pipe-client.ts");
    h = new Harness(new PipeRcon(pipe) as never, 1, undefined, { reader: "plan" }); // 只读: 不占大脑的队友消息和提醒 (2026-11-05)
    planRead = async (args) => { const r = await h.request("plan_read", args); if (!r.ok) throw new Error(r.error?.message ?? "plan_read 失败"); return r.result; };
  } else if (session && fs.existsSync(session)) {
    // 装模组那条路 (run.ts --kit party, 角色目录的 ./plan 带 FP_SESSION): 经 RCON 连游戏里的模组, 场上读数和找空地那两段固定 Lua 也经 RCON 跑 (沙盘, 不算成就; 2026-11-08 补: 原来只认管道, 这条路上 ./plan 用不了)
    const s = JSON.parse(fs.readFileSync(session, "utf8")) as { rconPort: number; password: string; bot?: string; player?: number };
    const { RconClient } = await import("../lab/rcon.ts");
    const { EXISTING_LUA } = await import("./expand.ts");
    const { siteLua } = await import("./plan-lib.ts");
    const rcon = new RconClient({ port: s.rconPort, password: s.password });
    await rcon.connect();
    close = () => rcon.close();
    h = new Harness(rcon, s.bot ?? s.player ?? 1, undefined, { reader: "plan" });
    planRead = async (args) => {
      const a = args as { what?: string; near?: [number, number] | null; w?: number; h?: number; taken?: { x: number; y: number; w: number; h: number }[] };
      const lua = a.what === "existing" ? EXISTING_LUA : siteLua(Array.isArray(a.near) ? [Number(a.near[0]), Number(a.near[1])] : null, Number(a.w), Number(a.h), Array.isArray(a.taken) ? a.taken : []);
      return JSON.parse(String(await rcon.exec(`/silent-command local function main() ${lua} end rcon.print(helpers.table_to_json(main()))`)));
    };
  } else { console.log("error: 没有 FH_SOCKET 也没有 FP_SESSION (./plan 只在开班的角色目录里能用)"); return 1; }
  try {
    const blocks: Block[] = entries();
    const inv = await h.call("inventory", {});
    const held: Record<string, number> = {};
    for (const m of String(inv.result?.inventory ?? "").matchAll(/([\w-]+)\*(\d+)/g)) held[m[1]] = (held[m[1]] ?? 0) + Number(m[2]);
    const nearArg = near ? ` --near=${near.join(",")}` : "";
    const hand = handRecipeOf(gd);
    const stocks = new Map<string, number>();
    // 模组的 stock (和 craft 说 "none of ours to spare" 看的是同一份); 查不了当拿得到, 不因为读失败改方案
    const stockOf = async (it: string): Promise<number> => {
      if (!stocks.has(it)) { const r = await h.call("stock", { item: it, radius: 128 }); stocks.set(it, r.ok && typeof r.result?.total === "number" ? r.result.total : Infinity); }
      return stocks.get(it)!;
    };
    // 场上的每次现读: 按低一档重算时, 前面放好的块要算进去
    const planFor = async (tech: Tech | null): Promise<{ steps: PlanStep[]; tech: Tech }> => {
      const ex = normalizeExisting(await planRead({ what: "existing" }));
      const useTech = tech ?? ex.tech;
      const result = solvePlan(gd, chainPlan(gd, item, perMin, useTech));
      const ds = deltas(result, ex, gd);
      const taken: { x: number; y: number; w: number; h: number }[] = [];
      const steps: PlanStep[] = [];
      const noBlock = [];
      // 上游先: 采矿机没块 (列在后面), 炉子, 再组装机
      for (const d of [...ds.filter((x) => x.kind === "furnace"), ...ds.filter((x) => x.kind === "assembler")].filter((x) => x.add > 0)) {
        const pick = pickBlock(d, blocks, zh);
        if (!pick) { noBlock.push(d); continue; }
        const site = await planRead({ what: "site", near: near ?? null, w: pick.block.w, h: pick.block.h, taken });
        const at = site?.found ? { x: site.x, y: site.y } : null;
        if (at) taken.push({ ...at, w: pick.block.w, h: pick.block.h });
        steps.push({ pick, at, lack: missingItems(pick.block.counts, held), others: otherBlocks(d, blocks, zh, pick.block.no) });
      }
      noBlock.push(...ds.filter((x) => x.kind === "drill" && x.add > 0));
      // 研究了不等于造得出: 先查, 拿不到就直接按低一档写, 不用等真放失败 (真放时的回退还在, 兜 stock 读不到或别人刚拿走的)
      const lack: Record<string, number> = {};
      for (const st of steps) for (const l of st.lack) lack[l.item] = (lack[l.item] ?? 0) + l.lack;
      const down = await unreachableTier(lack, useTech, held, hand, stockOf);
      if (down) {
        console.log(`${zh(down.item)} 现在拿不到 (要${zh(down.short.item)} ${down.short.need}, 128 格内只有 ${down.short.have}), 这次按低一档算:`);
        return planFor(down.tech);
      }
      console.log(planText({ item, perMin, zh, deltas: ds, steps, noBlock, imports: result.imports, goCmd: go ? undefined : `./plan ${name} ${perMin}${nearArg} --build` }));
      return { steps, tech: useTech };
    };
    const first = await planFor(null);
    try { fs.appendFileSync(".calc.log", `${Math.floor(Date.now() / 1000)} plan\n`); } catch { /* 不在大脑目录 */ }
    if (go) {
      const again = `./plan ${name} ${perMin}${nearArg} --build`;
      // 研究了但造不出来的机器不再挡路: 低一档够放就放, 一直到没有更低的档 (决定还是模型的, 回复写明换了什么)
      const lower = async (tech: Tech, missing: Record<string, number>): Promise<number | null> => {
        const d = downgrade(tech, missing);
        if (!d) return null;
        console.log(`\n${zh(d.item)} 现在拿不到, 这次按低一档算:`);
        const p = await planFor(d.tech);
        return goBuild(p.steps, again, (m) => lower(d.tech, m));
      };
      return await goBuild(first.steps, again, (m) => lower(first.tech, m));
    }
    // 要建线了: 给看真实基地这条线怎么摆; 只给看, 方案模型定
    try { const pic = (await import("./bp-study.ts")).studyHint(item); if (pic) console.log(`\n${pic}`); } catch { /* 附带的 */ }
    return 0;
  } finally { close(); /* 管道一问一连没有要关的; RCON 那条关掉 */ }
}

if ((import.meta as { main?: boolean }).main) process.exitCode = await main(argvFromFile(process.argv.slice(2)));
