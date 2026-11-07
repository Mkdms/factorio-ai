// 在一个沙盘实例里依次跑实验, 结果写进 knowledge/facts.json (机器读) 和 knowledge/facts.md (人读)。
// 每个实验占一块 40×40 的独立区域; 开着可视化窗口时, 镜头 (玩家) 会移到正在做的实验旁边。
import fs from "node:fs";
import path from "node:path";
import { LabInstance } from "../lab/instance.ts";
import { REPO } from "../lab/gamedir.ts";
import { zhNames } from "../lab/names.ts";
import type { Experiment, ExpContext, Outcome } from "./types.ts";
import { loadRules, type Rules } from "../blueprint/rules.ts";
import { loadRailGeometry } from "../blueprint/rail-geometry.ts";
import { checkBlueprint } from "../blueprint/check.ts";

// 布局关: 实验摆完后用我们自己的蓝图静态检查器扫实验区。
// 只看会让实验白做的几类: 机械臂对着空地、重叠、地下带没配对、传送带顶着不接货的面、迎头、车站没轨、铁轨不在网格、信号位置; 供电由引擎检查管, 流体 (永续管道当源) 不看。
const LAYOUT_KINDS = new Set(["inserter-empty-target", "overlap", "underground-unpaired", "belt-blocked", "belt-head-on", "train-stop-no-rail", "rail-off-grid", "signal-misplaced"]);
let layoutRules: Rules | null | undefined;
/** 开测前状态检查是否拦截: 先 false (只记录), 用全量回归的 regression-preflight.json 校准、给对照组写好 allowStatus 后改成 true */
const STATUS_BLOCKING = true; // 2026-11-02 用第五次全量回归的 regression-preflight.json 校准后打开
/** 拦哪些: 前置不够的 (缺燃料、没电、缺流体、没配方、冻住…); 缺原料 / 输出满是开测那一刻的正常过渡状态 (原料还在路上), 只记录不拦 */
const BLOCKING_STATUS = new Set(["no_fuel", "no_recipe", "no_power", "missing_required_fluid", "fluid_ingredient_shortage", "no_input_fluid", "frozen", "disabled", "no_ammo", "no_minable_resources"]);

// 实验前后对比全局状态: 玩家阵营新建的、不在本实验登记场地里的实体 (逃过了供电和布局检查, 还会干扰后面的实验);
// 开着的配方变了 (框架会复位阵营加成和昼夜, 不复位配方)。会动的 / 地上的 / 虚影不算。快照放在游戏的 storage 里, 不往外传。
const LEAK_SKIP = `{"character", "logistic-robot", "construction-robot", "combat-robot", "item-entity", "corpse", "character-corpse", "projectile", "explosion", "particle-source", "fire", "sticker", "highlight-box", "speech-bubble", "entity-ghost", "tile-ghost", "locomotive", "cargo-wagon", "fluid-wagon", "artillery-wagon", "car", "spider-vehicle", "rail-remnants", "smoke-with-trigger"}`;
const LEAK_BEFORE = `local skip = {} for _, t in ipairs(${LEAK_SKIP}) do skip[t] = true end -- 不能用 invert: 它把 force 条件也一起取反了 (第一次把新长出来的树全算成"场地外新建")
storage.leak_snap = {}
for _, s in pairs(game.surfaces) do
  for _, e in pairs(s.find_entities_filtered{force = "player"}) do if not skip[e.type] then storage.leak_snap[s.name .. "|" .. e.name .. "|" .. e.position.x .. "," .. e.position.y] = true end end
end
storage.leak_recipes = {}
for name, r in pairs(game.forces.player.recipes) do if r.enabled then storage.leak_recipes[name] = true end end
return true`;
const LEAK_AFTER = `local a = ...
local skip = {} for _, t in ipairs(${LEAK_SKIP}) do skip[t] = true end -- 不能用 invert: 它把 force 条件也一起取反了 (第一次把新长出来的树全算成"场地外新建")
local out, n = {}, 0
for _, s in pairs(game.surfaces) do
  for _, e in pairs(s.find_entities_filtered{force = "player"}) do
    local p = e.position
    if not skip[e.type] and not (storage.leak_snap or {})[s.name .. "|" .. e.name .. "|" .. p.x .. "," .. p.y] then
      local inside = false
      if s.name == a.surface then
        for _, ar in ipairs(a.areas) do if p.x >= ar[1][1] and p.x <= ar[2][1] and p.y >= ar[1][2] and p.y <= ar[2][2] then inside = true break end end
      end
      if not inside then n = n + 1 if #out < 8 then out[#out + 1] = s.name .. ":" .. e.name .. "(" .. p.x .. "," .. p.y .. ")" end end
    end
  end
end
local recipes = {}
for name, r in pairs(game.forces.player.recipes) do if r.enabled ~= ((storage.leak_recipes or {})[name] == true) then recipes[#recipes + 1] = (r.enabled and "+" or "-") .. name end end
table.sort(recipes)
return {outside = n, sample = out, recipes = recipes}`;

export interface FactRecord {
  /** 这个实验里自动补了几根杆子 (power_fix); 0 才算干净, 回归测试把 >0 当失败 (2026-11-01: 自动补杆盖住了四角连不上线的 bug) */
  autoFixes?: number;
  /** 开测前状态不对的机器 (缺料、没燃料、缺流体、冻住…; 先只记录, 2026-11-02) */
  preflight?: { name: string; x: number; y: number; status: string }[];
  /** 实验前后对比: 场地外新建的实体、开着的配方变化 (先只记录, 2026-11-02) */
  leaks?: { outside: number; sample: string[]; recipes: string[] };
  id: string;
  topic: string;
  claim: string;
  verdict: Outcome["verdict"];
  summary: string;
  measured: Record<string, unknown>;
  refs: string[];
  sources: Experiment["sources"];
  game_version: string;
  mods: string;
  date: string;
  experiment: string;
}

const FACTS_JSON = path.join(REPO, "knowledge", "facts.json");
const FACTS_MD = path.join(REPO, "knowledge", "facts.md");
const VERDICT_ZH = { verified: "✅ 已核实", refuted: "❌ 被推翻", inconclusive: "❔ 没测出结论" } as const;

export function loadFacts(): Record<string, FactRecord> {
  try {
    return JSON.parse(fs.readFileSync(FACTS_JSON, "utf8"));
  } catch {
    return {};
  }
}

export function writeFacts(facts: Record<string, FactRecord>) {
  fs.mkdirSync(path.dirname(FACTS_JSON), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(facts).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(FACTS_JSON, JSON.stringify(sorted, null, 2) + "\n");
  const byTopic = new Map<string, FactRecord[]>();
  for (const f of Object.values(sorted)) byTopic.set(f.topic, [...(byTopic.get(f.topic) ?? []), f]);
  const lines = [
    "# 沙盘核实过的事实",
    "",
    "> 由 `npm run verify` 生成, 不要手改。每条都在本机沙盘里实测 (实验代码在 `experiments/`), 带出处、游戏版本和日期。",
    "> 只有 ✅ 的可以当设计依据; ❌ 说明网上或旧文档的说法不对; ❔ 是实验没测出结论, 要改实验。",
    "",
  ];
  for (const [topic, list] of byTopic) {
    lines.push(`## ${topic}`, "", "| 编号 | 说法 | 结果 | 实测 | 关联 | 版本 / 日期 |", "|---|---|---|---|---|---|");
    for (const f of list) {
      lines.push(`| ${f.id} | ${f.claim} | ${VERDICT_ZH[f.verdict]} | ${f.summary} | ${f.refs.join("; ")} | ${f.game_version} / ${f.date} |`);
    }
    lines.push("");
  }
  fs.writeFileSync(FACTS_MD, lines.join("\n"));
}

export async function runExperiments(
  list: { exp: Experiment; file: string }[],
  opts: { seed?: number; log?: (s: string) => void; write?: boolean; view?: boolean; name?: string } = {},
): Promise<FactRecord[]> {
  const { seed = 20261031, log = console.log, write = true } = opts;
  const lab = new LabInstance({
    name: opts.name ?? "verify",
    label: `M2 核实: ${list.length} 个实验`,
    ...(opts.view === undefined ? {} : { view: opts.view }),
  });
  const records: FactRecord[] = [];
  try {
    await lab.createMap("verify", { seed });
    const ping = (await lab.start("verify")) as { base: string; space_age?: string };
    const mods = ping.space_age ? `base ${ping.base} + space-age ${ping.space_age}` : `base ${ping.base}`;
    for (const planet of new Set(list.map((e) => e.exp.surface ?? "nauvis"))) {
      if (planet !== "nauvis") await lab.exec(`local a = ... if not game.surfaces[a] then game.planets[a].create_surface() end`, planet);
    }
    const facts = loadFacts();
    const zh = zhNames(lab);
    // 每个地表各自从原点附近按 8 列的网格排实验区 (±20 格一块, 间距 64): 越排越远会跑进敌人领地
    // (回归时第 24 个实验落在祝融星 x=1600, 撼地虫把电线杆拆了, 2026-11-01)
    const slot: Record<string, number> = {};
    for (let i = 0; i < list.length; i++) {
      const { exp, file } = list[i];
      const surface = exp.surface ?? "nauvis";
      const k = slot[surface] ?? 0;
      slot[surface] = k + 1;
      const x = ((k % 8) + 1) * 64, y = Math.floor(k / 8) * 64;
      await lab.rpc("prepare_area", { surface, area: [[x - 20, y - 20], [x + 20, y + 20]], no_enemies: true });
      // 复位会串到下一个实验的阵营加成 (实验自己改的只对自己有效; 2026-11-01 回归: 火车实验的手部容量 +3 让腐坏优先那条一次抓 4 个)
      await lab.exec(`local f = game.forces.player
        for _, k in ipairs({"inserter_stack_size_bonus", "bulk_inserter_capacity_bonus", "worker_robots_storage_bonus", "worker_robots_speed_modifier", "worker_robots_battery_modifier", "manual_crafting_speed_modifier", "laboratory_speed_modifier", "mining_drill_productivity_bonus"}) do
          pcall(function() f[k] = 0 end)
        end
        for _, s in pairs(game.surfaces) do s.freeze_daytime = false end
        return true`);
      const v = (await lab.rpc("viewer", { position: [x - 6, y + 6], surface }, { retry: true }).catch(() => null)) as { players?: string[]; unlocked?: number } | null;
      if (v?.players?.length) log(`  观看窗口: ${v.players.join(", ")} (实验在 ${surface}; 已解锁星球和航线 ${v.unlocked ?? "?"} 个)`); // 用户截图发现跟不到别的星球, 打出来核对
      await lab.say(`实验 ${i + 1}/${list.length} [${exp.topic}] ${exp.claim}`);
      log(`实验 ${i + 1}/${list.length} ${exp.id}: ${exp.claim}`);
      const areas: [[number, number], [number, number]][] = [[[x - 20, y - 20], [x + 20, y + 20]]];
      const unpoweredIn = async () => {
        const out: { name: string; x: number; y: number; status: string }[] = [];
        for (const area of areas) {
          const r = (await lab.rpc("unpowered", { surface, area }, { retry: true })) as (typeof out[number] & { network?: boolean })[] | Record<string, never>;
          // Lua 的空表过来是 {} 不是 []; 接在电网里只是 low_power 的不算 (沙盘电源无限, 那是刚放下在充自己的缓冲: 机器人指令平台 100MJ 要 20 秒; 第九批误判 3 条, 2026-11-01)
          out.push(...(Array.isArray(r) ? r : []).filter((e) => !(e.network === true && e.status === "low_power")));
        }
        return out;
      };
      let autoFixes = 0; // 这个实验里自动补了几根杆子 (0 才算干净; 回归测试检查)
      // 开测前的机器状态快照: 缺料、没燃料、缺流体、冻住等引擎自己记的状态。
      // 先只记录 (rec.preflight), 回归里看清哪些是故意的 (对照组), 再改成默认拦截 (exp.allowStatus 声明例外)
      let preflight: { name: string; x: number; y: number; status: string }[] = [];
      const statusProblems = async () => {
        const out: typeof preflight = [];
        for (const area of areas) {
          const r = (await lab.exec(`local a = ... local names = {} for k, v in pairs(defines.entity_status) do names[v] = k end
            local bad = {no_fuel = true, no_recipe = true, no_power = true, missing_required_fluid = true, fluid_ingredient_shortage = true, no_input_fluid = true, frozen = true, no_minable_resources = true, full_output = true, item_ingredient_shortage = true, no_ingredients = true, no_ammo = true, disabled = true}
            local out = {}
            for _, e in pairs(game.surfaces[a.surface].find_entities_filtered{area = a.area, type = {"assembling-machine", "furnace", "lab", "boiler", "generator", "mining-drill", "reactor", "ammo-turret", "electric-turret", "fluid-turret", "agricultural-tower", "rocket-silo"}}) do
              local ok, st = pcall(function() return e.status end)
              local n = ok and st and names[st] or nil
              if n and bad[n] then out[#out + 1] = {name = e.name, x = e.position.x, y = e.position.y, status = n} end
            end
            return out`, { surface, area }, { retry: true })) as typeof out | Record<string, never>;
          out.push(...(Array.isArray(r) ? r : []));
        }
        return out;
      };
      const layoutProblems = async (): Promise<string[]> => {
        if (layoutRules === undefined) { try { layoutRules = loadRules(); } catch { layoutRules = null; } }
        if (!layoutRules) return [];
        const ents: { entity_number: number; name: string; position: { x: number; y: number } }[] = [];
        const seen = new Set<string>(); // 实验区和 watch 的场地会重叠, 同一个实体只算一次 (第一次跑时自己和自己报了"重叠")
        for (const area of areas) {
          const r = (await lab.rpc("snapshot", { surface, area }, { retry: true })) as typeof ents | Record<string, never>;
          for (const e of Array.isArray(r) ? r : []) {
            const k = `${e.name}@${e.position.x},${e.position.y}`;
            if (seen.has(k)) continue;
            seen.add(k);
            ents.push({ ...e, entity_number: ents.length + 1 });
          }
        }
        const allowed = new Set(exp.allowLayout ?? []);
        return checkBlueprint(ents, undefined, layoutRules, zh, loadRailGeometry())
          .filter((f) => LAYOUT_KINDS.has(f.kind) && !allowed.has(f.kind) && (f.level === "error" || f.level === "warn"))
          .map((f) => f.msg);
      };
      const ctx: ExpContext = {
        lab, x, y, surface,
        lua: (code, args = {}) => lab.exec(code, { x, y, surface, ...args }),
        ticks: async (n) => void (await lab.runTicks(n)),
        say: (t) => lab.say(t),
        zh,
        power: () => lab.rpc("power_area", { surface, area: [[x - 20, y - 20], [x + 20, y + 20]] }) as Promise<{ poles: { x: number; y: number }[]; eei: { x: number; y: number } }>,
        powered: async () => {
          await lab.runTicks(30); // 让电网算一拍
          let list = await unpoweredIn();
          if (list.length && !exp.allowUnpowered) { // 故意不接电的实验不补杆 (2026-11-02: 给不接电的实验补的配电站压在组装机上)
            // 盖漏不再让结论作废: 按数据在没电的东西旁边补配电站 + 电源, 记录下来
            const fix = (await lab.rpc("power_fix", { surface, targets: list.map((e) => ({ x: e.x, y: e.y })) })) as { fixed: number; failed: { x: number; y: number; why: string }[] | Record<string, never> };
            await lab.runTicks(30);
            const before = list;
            list = await unpoweredIn();
            autoFixes += fix.fixed;
            log(`  ⚡ 供电盖漏自动补: ${before.length} 个没电 (${before.slice(0, 3).map((e) => `${zh(e.name)}(${e.x},${e.y}) ${e.status}${(e as { network?: boolean }).network ? "" : "/不在网里"}`).join("、")}), 补了 ${fix.fixed} 处, 现在没电 ${list.length} 个 —— 这是实验或供电函数的 bug, 回归测试会报`);
            await lab.say(`供电盖漏: 自动补了 ${fix.fixed} 处`);
          }
          if (list.length && !exp.allowUnpowered) {
            throw new Error(`实验区里有 ${list.length} 个用电的东西没电 (自动补杆后仍没电): ` + list.slice(0, 6).map((e) => `${zh(e.name)}(${e.x},${e.y}) ${e.status}`).join("、"));
          }
          const bad = await layoutProblems();
          if (bad.length) {
            log(`  🧱 布局检查: ${bad.length} 处摆错 —— ${bad.slice(0, 4).join("; ")}`);
            throw new Error(`布局检查不过 (实验摆错了, 不测量): ${bad.slice(0, 4).join("; ")}`);
          }
          preflight = await statusProblems();
          const unexpected = preflight.filter((e) => BLOCKING_STATUS.has(e.status) && !(exp.allowStatus ?? []).includes(e.status));
          if (STATUS_BLOCKING && unexpected.length) throw new Error(`开测前机器状态不对 (前置不够, 不测量): ${unexpected.slice(0, 4).map((e) => `${zh(e.name)}(${e.x},${e.y}) ${e.status}`).join("、")}; 故意的要在实验里写 allowStatus`);
          if (preflight.length) log(`  🩺 开测前机器状态: ${preflight.slice(0, 5).map((e) => `${zh(e.name)}(${e.x},${e.y}) ${e.status}`).join("、")}${preflight.length > 5 ? ` 等 ${preflight.length} 个` : ""} (先只记录; 故意的要在实验里声明)`);
        },
        watch: (area) => void areas.push(area),
      };
      await lab.exec(LEAK_BEFORE, {}, { retry: true });
      let outcome: Outcome;
      try {
        outcome = await exp.run(ctx);
      } catch (e) {
        outcome = { verdict: "inconclusive", summary: `实验出错: ${(e as Error).message.slice(0, 300)}`, measured: {} };
      }
      // 框架级检查 (不靠实验自己记得): 出结论时实验区里还有没电的用电设备, 结论作废 (电线杆盖漏过四次, 2026-11-01)
      if (outcome.verdict !== "inconclusive" && !exp.allowUnpowered) {
        const list = await unpoweredIn();
        if (list.length) {
          outcome = {
            verdict: "inconclusive",
            summary: `测量时实验区有 ${list.length} 个没电的 (${list.slice(0, 4).map((e) => `${zh(e.name)}(${e.x},${e.y})`).join("、")}), 结论作废。原结论: ${outcome.summary}`,
            measured: { ...outcome.measured, unpowered: list },
          };
        }
      }
      // 框架级布局检查: 出结论前对所有实验都做一遍 (原来只在 ctx.powered() 里做, 不调它的实验就漏了; 2026-11-02 发现)
      if (outcome.verdict !== "inconclusive") {
        const bad = await layoutProblems();
        if (bad.length) {
          outcome = { verdict: "inconclusive", summary: `出结论时布局检查不过 (${bad.slice(0, 3).join("; ")}), 结论作废。原结论: ${outcome.summary}`, measured: { ...outcome.measured, layout: bad } };
        }
      }
      await lab.say(`${VERDICT_ZH[outcome.verdict]}: ${outcome.summary}`);
      log(`  ${VERDICT_ZH[outcome.verdict]}: ${outcome.summary}`);
      const leakRaw = (await lab.exec(LEAK_AFTER, { surface, areas }, { retry: true })) as { outside: number; sample: string[] | Record<string, never>; recipes: string[] | Record<string, never> };
      const leaks = { outside: leakRaw.outside, sample: Array.isArray(leakRaw.sample) ? leakRaw.sample : [], recipes: Array.isArray(leakRaw.recipes) ? leakRaw.recipes : [] };
      if (leaks.outside || leaks.recipes.length) log(`  🧭 实验前后对比: 场地外新建 ${leaks.outside} 个${leaks.sample.length ? ` (${leaks.sample.slice(0, 3).join("、")})` : ""}; 配方变了 ${leaks.recipes.length} 个${leaks.recipes.length ? ` (${leaks.recipes.slice(0, 4).join("、")})` : ""} (先只记录)`);
      const rec: FactRecord = {
        autoFixes,
        ...(preflight.length ? { preflight } : {}),
        ...(leaks.outside || leaks.recipes.length ? { leaks } : {}),
        id: exp.id,
        topic: exp.topic,
        claim: exp.claim,
        verdict: outcome.verdict,
        summary: outcome.summary,
        measured: outcome.measured,
        refs: exp.refs,
        sources: exp.sources,
        game_version: ping.base,
        mods,
        date: new Date().toISOString().slice(0, 10),
        experiment: file,
      };
      facts[exp.id] = rec;
      records.push(rec);
      if (write) writeFacts(facts); // 每做完一个就落盘, 中途出事也不丢
    }
  } finally {
    await lab.stop({ save: false });
  }
  return records;
}
