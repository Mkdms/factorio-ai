// 电第二批 (已核实补到 10 条; 第十批里"管道一段 320 上限"被推翻): 电力不足时机器按保障比例变慢 (游戏内提示与技巧 TT18)。
// 故意自建一张限电的小电网 (真太阳能板 + 一根中型电线杆), 不能用 ctx.power() (那是无限电源); 同一张网里的成员用 electric_network_id 核对, 不靠心算覆盖。
// 对照 = 同一台机器: 先 1 块板 (不够), 再加 2 块 (够), 比两段的做齿轮速度; 期望值按原型 (板子发电、组装机耗电 + 待机) 算。
import type { Experiment } from "../src/verify/types.ts";

const BUILD = `
local a = ...
local s = game.surfaces[a.surface]
s.daytime = 0 -- 正午, 太阳能满发 (框架在下一个实验前放开昼夜)
s.freeze_daytime = true
local f = "player"
local pole = lab.place{surface = s, name = "medium-electric-pole", position = {a.x - 2.5, a.y + 0.5}, force = f} -- lint-ok: 故意自建限电电网, 测的就是电力不足
local t = lab.tiles(pole)
-- 西边 1 块太阳能板, 东边组装机2型 (都贴着电线杆)
local panel = lab.place{surface = s, name = "solar-panel", position = {t.x1 - 1.5, t.y1 + 0.5}, force = f}
local asm = lab.place{surface = s, name = "assembling-machine-2", position = {t.x2 + 2.5, t.y1 + 0.5}, force = f}
asm.set_recipe("iron-gear-wheel")
local put = asm.get_inventory(defines.inventory.crafter_input).insert{name = "iron-plate", count = 100}
if put ~= 100 then error("铁板只塞进 " .. put .. "/100", 0) end -- 原料槽一格最多 100 (第一次塞 600 没核对, 后半段断料)
lab.label(panel, "只有 1 块板: 故意不够")
local ap = asm.prototype
local drain = ap.electric_energy_source_prototype and ap.electric_energy_source_prototype.drain or 0
return {pole = {x = pole.position.x, y = pole.position.y}, asm = {x = asm.position.x, y = asm.position.y}, panels = {{x = panel.position.x, y = panel.position.y}},
        usage = ap.get_max_energy_usage() * 60, drain = drain * 60, panel_w = prototypes.entity["solar-panel"].get_max_energy_production() * 60,
        speed = asm.crafting_speed, energy = prototypes.recipe["iron-gear-wheel"].energy}`;

// 再加 2 块板: 放在电线杆南边一排 (从电线杆的格子算, 放不下 lab.place 会报错)
const MORE_PANELS = `
local a = ...
local s = game.surfaces[a.surface]
local pole = s.find_entity("medium-electric-pole", {a.pole.x, a.pole.y})
local t = lab.tiles(pole)
local out = {}
for i, dx in ipairs({-1.5, 1.5}) do
  local p = lab.place{surface = s, name = "solar-panel", position = {t.x1 + dx, t.y2 + 3.5}, force = "player"} -- 3×3 中心要落在 .5 上 (lab.md #17): 杆子格 x1 ± 1.5
  out[i] = {x = p.position.x, y = p.position.y}
end
return out`;

// 读: 组装机做了多少 (清输出槽记数)、进度, 以及所有成员是不是同一张网、这张网是不是只有这些
const READ = `
local a = ...
local s = game.surfaces[a.surface]
local asm = s.find_entity("assembling-machine-2", {a.asm.x, a.asm.y})
local out = asm.get_output_inventory()
local n = out.get_item_count("iron-gear-wheel")
out.clear()
local inv = asm.get_inventory(defines.inventory.crafter_input)
local have = inv.get_item_count("iron-plate")
if have < 60 then inv.insert{name = "iron-plate", count = 100 - have} end -- 每秒补到 100, 不让断料
local net = asm.electric_network_id
local same = true
for _, p in ipairs(a.panels) do local e = s.find_entity("solar-panel", {p.x, p.y}); if not e or e.electric_network_id ~= net then same = false end end
return {gears = n, progress = asm.crafting_progress, net = net or -1, same = same}`; // 太阳能板不支持 energy_generated_last_tick ("Entity is not generator"), 发电按原型功率 × 块数算 (正午冻结)

export const brownoutSlowsMachines: Experiment = {
  id: "power.brownout.slows-proportionally",
  topic: "电",
  claim: "电力不足时机器变慢: 1 块太阳能板 (60kW) 带一台组装机2型 (工作 150kW + 待机 5kW) 时, 做齿轮的速度约为满电时的 60/155 ≈ 39%; 加够太阳能板后恢复全速",
  refs: ["docs/research/players/game-tips.md TT18 (电力不足时机器变慢, 看电网统计的保障)", "架构 (告警判据用\"保障\")"],
  sources: [
    { title: "游戏内提示与技巧: 电力不足 (本机 2.1.24)", credibility: 1 },
    { title: "本机原型: solar-panel 60kW、assembling-machine-2 150kW (待机默认 = 耗电的 1/30)", credibility: 1 },
  ],
  gameSeconds: 140,
  async run(ctx) {
    const b = (await ctx.lua(BUILD)) as { pole: { x: number; y: number }; asm: { x: number; y: number }; panels: { x: number; y: number }[]; usage: number; drain: number; panel_w: number; speed: number; energy: number };
    await ctx.say("一张故意不够电的小电网: 1 块太阳能板带一台组装机; 60 秒后再加 2 块板");
    await ctx.ticks(120);
    await ctx.powered();
    const fullRate = (b.speed / b.energy) * 60; // 满电每分钟齿轮数
    const phase = async (panels: { x: number; y: number }[]) => {
      await ctx.ticks(300); // 先等 5 秒稳定
      let gears = 0, last: { gears: number; progress: number; net: number; same: boolean } | null = null;
      const p0 = ((await ctx.lua(READ, { asm: b.asm, panels })) as { progress: number }).progress;
      for (let t = 0; t < 60 * 60; t += 60) {
        await ctx.ticks(60);
        last = (await ctx.lua(READ, { asm: b.asm, panels })) as typeof last;
        gears += last!.gears;
      }
      const made = gears + last!.progress - p0;
      return { made, perMin: made, ratio: made / fullRate, same: last!.same, net: last!.net, gen: panels.length * b.panel_w };
    };
    const low = await phase(b.panels);
    const more = (await ctx.lua(MORE_PANELS, { pole: b.pole })) as { x: number; y: number }[];
    const all = [...b.panels, ...more];
    const high = await phase(all);
    const demand = b.usage + b.drain;
    const expectLow = b.panel_w / demand; // 按"发电 / 总需求 (含待机)"
    const expectLowAlt = (b.panel_w - b.drain) / b.usage; // 另一种算法: 先扣待机
    const measured = { b, fullRate, low, high, expectLow, expectLowAlt };
    if (!low.same || !high.same || low.net < 0) return { verdict: "inconclusive", summary: `太阳能板和组装机不在同一张电网 (前段 ${low.same}, 后段 ${high.same})`, measured };
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const ok = Math.abs(low.ratio - expectLow) < 0.05 && high.ratio > 0.97;
    const closer = Math.abs(low.ratio - expectLow) <= Math.abs(low.ratio - expectLowAlt) ? "发电/总需求" : "(发电 − 待机)/工作耗电";
    return {
      verdict: ok ? "verified" : high.ratio > 0.97 && low.ratio > 0.9 ? "refuted" : "inconclusive",
      summary: `1 块板 (按原型 ${(low.gen / 1000).toFixed(1)}kW, 需求 ${(demand / 1000).toFixed(1)}kW): 每分钟 ${low.made.toFixed(1)} 个齿轮 = 满电的 ${pct(low.ratio)} (按发电/总需求应 ${pct(expectLow)}, 先扣待机应 ${pct(expectLowAlt)}, 更接近${closer}); 加到 3 块 (${(high.gen / 1000).toFixed(1)}kW): ${high.made.toFixed(1)} 个 = ${pct(high.ratio)}`,
      measured,
    };
  },
};
