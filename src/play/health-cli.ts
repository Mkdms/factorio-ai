#!/usr/bin/env node
// 基地体检命令行: 对正在跑的沙盘 (会话文件) 跑一次 src/play/health.ts, 打印问题清单。汇报前先跑这个。
//   node src/play/health-cli.ts <session.json>
import fs from "node:fs";
import path from "node:path";
import { labRoot } from "../lab/gamedir.ts";
import { loadZhNames } from "./chattags.ts";
import { RconClient } from "../lab/rcon.ts";
import { HEALTH_LUA, healthLines, normalizeHealth, type Health } from "./health.ts";

const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rcon = new RconClient({ port: s.rconPort, password: s.password });
await rcon.connect();
try {
  const h = normalizeHealth(JSON.parse(await rcon.exec(`/silent-command rcon.print(helpers.table_to_json((function() ${HEALTH_LUA.replace(/\n/g, " ")} end)()))`)) as Health);
  const ZH = loadZhNames(path.join(labRoot(), "prototypes"));
  const lines = healthLines(h, h.ghosts, (n) => ZH.get(n) ?? n);
  console.log(`体检 (tick ${h.tick}): ${lines.length ? `${lines.length} 类问题` : "没查出问题"}`);
  for (const l of lines) console.log("- " + l);
  console.log(`(虚影共 ${h.ghosts?.length ?? 0} 个; 研究中心 ${h.labs.working}/${h.labs.total}; 厂区树石 ${h.obstacles?.count ?? 0})`);
} finally {
  rcon.close();
}
