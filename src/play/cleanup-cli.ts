#!/usr/bin/env node
// 清场命令行: 让会话里的服务器角色 (bot) 清掉挡路的树石, 材料放进箱子 (src/play/cleanup.ts)。不用大脑。
//   node src/play/cleanup-cli.ts <session-b.json>   (会话文件要有 bot, 例如 runs/<时间>/session-b.json)
import fs from "node:fs";
import { RconClient } from "../lab/rcon.ts";
import { Harness } from "./harness.ts";
import { cleanup } from "./cleanup.ts";

const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!s.bot) { console.log("error: 会话里没有服务器角色 (bot), 用 session-b.json"); process.exit(1); }
const rcon = new RconClient({ port: s.rconPort, password: s.password });
await rcon.connect();
const exec = async (lua: string, args?: unknown) => {
  const body = `local a = helpers.json_to_table(${JSON.stringify(JSON.stringify(args ?? {}))}) ${lua.replace(/^local a = \.\.\. /, "").replace(/\n/g, " ")}`;
  return JSON.parse(await rcon.exec(`/silent-command rcon.print(helpers.table_to_json((function() ${body} end)()))`));
};
try {
  const unit = Number(await exec(`local out = {} for _, c in pairs(game.surfaces[1].find_entities_filtered{name = "character"}) do if not c.player then out[#out + 1] = c.unit_number end end return out`).then((u: number[]) => u[0]));
  const h = new Harness(rcon, s.bot);
  const t0 = Date.now();
  const r = await cleanup(h, exec, unit, (l) => console.log(l));
  console.log(`清场: 树石 ${r.before} → ${r.after}; 放进箱子 ${JSON.stringify(r.stored)}; ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
} finally {
  rcon.close();
}
