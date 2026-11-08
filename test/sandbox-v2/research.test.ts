// 研究自动续上的沙盘测试 (RESEARCH_LUA 对真游戏 2.1.24): 新图上只有触发型科技 (研究中心研究不了), 把触发型完成后能选出只要红瓶的科技, 排上后当前研究就是它。
// 不开窗口。npm run test:sandbox
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { LabInstance } from "../../src/lab/instance.ts";
import { RESEARCH_LUA, normalizeResearch, pickResearch, triggerText } from "../../src/play/research.ts";

const lab = new LabInstance({ name: "test-research", view: false });
before(async () => {
  await lab.createMap("t", { seed: 42 });
  await lab.start("t");
  await lab.exec(`game.surfaces[1].peaceful_mode = true return true`);
});
after(() => lab.stop({ save: false }));

test("新图: 研究中心空着, 没有能研究的, 只有触发型科技 (说成人话)", async () => {
  const st = normalizeResearch(await lab.exec(RESEARCH_LUA));
  assert.equal(st.current, "");
  assert.equal(st.queue, 0);
  assert.equal(st.peaceful, true);
  assert.deepEqual(st.candidates, [], "2.0 开局的科技都是触发型, 研究中心研究不了");
  assert.ok(st.triggers.length > 0, "应读到前置已满足的触发型科技");
  assert.ok(st.triggers.every((t) => /^[a-z-]+( |$)/.test(t.trigger)), `触发描述形如 "craft-item iron-plate x10": ${JSON.stringify(st.triggers)}`);
  assert.equal(pickResearch(st).pick, null);
  const text = triggerText(st.triggers[0]);
  assert.match(text, /\(/, `说成人话: ${text}`);
});

test("触发型都完成后: 能选出只要红瓶的科技, 排上后当前研究就是它", async () => {
  await lab.exec(`for _, t in pairs(game.forces.player.technologies) do local trig = nil pcall(function() trig = t.prototype.research_trigger end) if trig ~= nil then t.researched = true end end return true`);
  const st = normalizeResearch(await lab.exec(RESEARCH_LUA));
  assert.ok(st.candidates.length > 0, "触发型完成后应有能在研究中心研究的科技");
  assert.ok(st.candidates.every((c) => c.packs.length > 0), "候选都要有瓶");
  const { pick, producing } = pickResearch(st);
  assert.deepEqual(producing, ["automation-science-pack"], "什么都没产, 按只有红瓶算");
  assert.ok(pick, "应能选出只要红瓶的科技");
  assert.deepEqual(pick!.packs, ["automation-science-pack"]);
  const ok = await lab.exec(`return game.forces.player.add_research("${pick!.name}")`);
  assert.equal(ok, true, "add_research 应成功");
  const now = normalizeResearch(await lab.exec(RESEARCH_LUA));
  assert.equal(now.current, pick!.name);
  // 监工一次排 3 项 (run.ts): 后两项也能进队列
  const { usable } = pickResearch(st);
  for (const p of usable.slice(1, 3)) assert.equal(await lab.exec(`return game.forces.player.add_research("${p.name}")`), true, `排 ${p.name}`);
  const after = normalizeResearch(await lab.exec(RESEARCH_LUA));
  assert.equal(after.current, pick!.name, "当前研究不变");
  assert.ok(after.queue >= Math.min(3, usable.length) - 1, `队列里应有后面的项: ${after.queue}`);
});
