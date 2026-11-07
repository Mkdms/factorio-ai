#!/usr/bin/env node
// 沙盘命令行: npm run sandbox:demo [-- --minutes 10 --seed 7]
import { parseArgs } from "node:util";
import { runDemo } from "./demo.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { minutes: { type: "string", default: "10" }, seed: { type: "string", default: "20261107" } } });
const cmd = positionals[0] ?? "demo";
if (cmd === "demo") {
  const r = await runDemo("demo", { minutes: Number(values.minutes), seed: Number(values.seed), log: console.log });
  console.log(JSON.stringify(r, null, 1));
} else {
  console.log(`不认识的命令 ${cmd}; 有: demo`);
  process.exit(1);
}
