#!/usr/bin/env node
// 基地复盘 (docs/brain-run.md): 把大脑建的基地导出来 → 量规整度 → 出俯视图 (≤800 像素, ≤300KB)。
//  —— 每轮结束自动跑, 下一轮和上一轮比。
// 导出用 io-lab 的 snapshot (沙盘上帝视角, 只读), 出图用我们的蓝图渲染 (src/blueprint/render.ts)。
//   node src/play/review.ts --save <存档.zip> [--out 图片前缀]     (直接运行时才执行; import 只拿函数)
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { LabInstance } from "../lab/instance.ts";
import { encodeBlueprint } from "../lab/blueprint.ts";
import { BlueprintRenderer, writeRender } from "../blueprint/render.ts";

type Rec = { entity_number: number; name: string; position: { x: number; y: number }; direction?: number; type?: string; recipe?: string };
const DIR: Record<number, [number, number]> = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };
const POLES = /^(small|medium|big)-electric-pole$|^substation$/;
const CONSUMERS = /^(assembling-machine-[123]|lab|inserter|fast-inserter|long-handed-inserter|bulk-inserter|electric-mining-drill|radar|electric-furnace|chemical-plant|oil-refinery|pumpjack|offshore-pump-x)$/;

export async function reviewBase(lab: LabInstance, outBase: string) {
  const box = (await lab.exec(`local s = game.surfaces[1] local x0, y0, x1, y1
    for _, e in pairs(s.find_entities_filtered{force = "player"}) do if e.type ~= "character" then
      local p = e.position x0 = math.min(x0 or p.x, p.x) y0 = math.min(y0 or p.y, p.y) x1 = math.max(x1 or p.x, p.x) y1 = math.max(y1 or p.y, p.y) end end
    if not x0 then return nil end return {x0 = x0, y0 = y0, x1 = x1, y1 = y1}`)) as { x0: number; y0: number; x1: number; y1: number } | null;
  if (!box) return { entities: 0 };
  const ents = ((await lab.rpc("snapshot", { area: [[box.x0 - 3, box.y0 - 3], [box.x1 + 3, box.y1 + 3]] })) as Rec[]).filter((e) => e.name !== "character");
  // 带子拐弯率: 一段普通传送带的出口那格也是传送带、但方向不同 = 一个弯
  const belts = ents.filter((e) => e.name.endsWith("transport-belt"));
  const at = new Map(belts.map((b) => [`${Math.floor(b.position.x)},${Math.floor(b.position.y)}`, b]));
  let turns = 0;
  for (const b of belts) {
    const v = DIR[b.direction ?? 0]; if (!v) continue;
    const next = at.get(`${Math.floor(b.position.x) + v[0]},${Math.floor(b.position.y) + v[1]}`);
    if (next && next.direction !== b.direction) turns++;
  }
  const undergrounds = ents.filter((e) => e.type === "underground-belt" || e.name.endsWith("underground-belt")).length;
  const poles = ents.filter((e) => POLES.test(e.name)).length;
  const consumers = ents.filter((e) => CONSUMERS.test(e.name)).length;
  const pipes = ents.filter((e) => e.name === "pipe").length, pipeUnder = ents.filter((e) => e.name === "pipe-to-ground").length;
  const w = Math.round(box.x1 - box.x0 + 1), h = Math.round(box.y1 - box.y0 + 1);
  const metrics = {
    entities: ents.length, area: `${w}x${h}`, belts: belts.length, beltTurns: turns, beltTurnRate: belts.length ? +(turns / belts.length).toFixed(3) : 0, undergroundBelts: undergrounds,
    poles, consumers, polesPerConsumer: consumers ? +(poles / consumers).toFixed(2) : 0, pipes, pipeToGround: pipeUnder,
  } as Record<string, unknown>;
  // 俯视图
  const r = new BlueprintRenderer();
  try {
    const bp = { item: "blueprint", label: "大脑的基地", version: 562949958139904, entities: ents.map((e, i) => ({ ...e, entity_number: i + 1 })) };
    // 最多等 90 秒: 渲染器默认 10 分钟, 2026-11-04 两班收尾都在这里卡了整整 10 分钟才报 "page.waitForFunction: Timeout 600000ms"; 出不了图就跳过, 指标照记
    const res = await r.render(encodeBlueprint({ blueprint: bp }), { maxSide: 800, maxBytes: 300_000, grid: true, timeoutMs: 90_000 });
    metrics.image = writeRender(outBase, res);
  } catch (e) {
    metrics.image = `出图失败: ${(e as Error).message.slice(0, 160)}`;
  } finally {
    await r.close().catch(() => undefined);
  }
  return metrics;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { save: { type: "string" }, out: { type: "string" } } });
  if (!values.save) { console.log("用法: node src/play/review.ts --save <存档.zip> [--out 图片前缀]"); process.exit(2); }
  const lab = new LabInstance({ name: "play-review", view: false, repoMods: ["agent-harness"] });
  try {
    lab.prepare();
    fs.copyFileSync(values.save, lab.savePath("m"));
    await lab.start("m");
    const m = await reviewBase(lab, values.out ?? path.join(path.dirname(values.save), path.basename(values.save, ".zip") + "-base"));
    console.log(JSON.stringify(m, null, 2));
  } finally {
    await lab.stop({ save: false });
  }
}
