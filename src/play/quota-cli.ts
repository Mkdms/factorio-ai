#!/usr/bin/env node
// 查订阅额度, 不花额度 (用量接口, quota.ts readPlanUsage)。读不到时只说原因; 加 --probe 才跑探针 (一条极小的 claude -p, 花一点额度)。
//   npm run play:quota [-- --probe] [--json]
import os from "node:os";
import { parseArgs } from "node:util";
import { readPlanUsage, probeQuota, describeQuota, maxUtilization } from "./quota.ts";

const { values } = parseArgs({ options: { probe: { type: "boolean", default: false }, json: { type: "boolean", default: false }, model: { type: "string", default: "opus" } } });
const r = await readPlanUsage();
let q = r.q;
if (!q && values.probe) q = await probeQuota(process.env.CLAUDE_BIN ?? "claude", process.env, os.tmpdir(), values.model!);
if (values.json) console.log(JSON.stringify({ source: r.q ? "usage" : q ? "probe" : null, why: r.why ?? null, quota: q, max: maxUtilization(q) }));
else console.log(`${describeQuota(q)}${r.q ? " (用量接口, 没花额度)" : q ? ` (用量接口没读到: ${r.why}; 用的探针)` : ` (用量接口没读到: ${r.why}${values.probe ? "; 探针也没读到" : "; 要跑探针加 --probe, 花一点额度"})`}`);
process.exit(q ? 0 : 1);
