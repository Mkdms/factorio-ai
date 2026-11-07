// 连续换班配套: 拦串联 sleep (context.ts sleepVerdict)、手搬统计 (partykit.ts haulCounts); 不开游戏
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sleepVerdict } from "../src/play/context.ts";
import { haulCounts } from "../src/play/partykit.ts";

test("串联 sleep 和太长的 sleep 要拒绝, 单次等具体条件放行 (第十三轮班末串了 5 个 sleep 60)", () => {
  assert.match(sleepVerdict("./fh sleep 60 && ./fh sleep 60 && ./fh sleep 60") ?? "", /串了 3 个 sleep/);
  assert.match(sleepVerdict("./fh call chat_ack --args '{}' && sleep 30; sleep 30") ?? "", /串了 2 个/);
  assert.match(sleepVerdict("./fh sleep 600") ?? "", /太长/);
  assert.equal(sleepVerdict("./fh sleep 120 --until queue_done"), null);
  assert.equal(sleepVerdict("./fh call status && ./fh call research"), null);
});

test("手搬统计按次数、按物品, 只算成功的搬运类动作", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fp-haul-")), "journal.jsonl");
  const at = (s: number) => new Date(Date.UTC(2026, 10, 3, 7, 0, s)).toISOString();
  const rows = [
    { at: at(1), event: "request", request: { id: "1", action: "transfer", args: { item: "coal", count: 50 } } },
    { at: at(2), event: "response", response: { id: "1", ok: true, result: { op: "transfer", until_tick: 5 } } },
    { at: at(3), event: "request", request: { id: "2", action: "refuel", args: { radius: 20 } } },
    { at: at(4), event: "response", response: { id: "2", ok: true, result: {} } },
    { at: at(5), event: "request", request: { id: "3", action: "transfer", args: { items: { "iron-plate": 20, coal: 10 } } } },
    { at: at(6), event: "response", response: { id: "3", ok: true, result: {} } },
    { at: at(7), event: "request", request: { id: "4", action: "transfer", args: { item: "coal" } } },
    { at: at(8), event: "response", response: { id: "4", ok: false, error: { code: "x" } } },
    { at: at(9), event: "request", request: { id: "5", action: "build", args: { item: "transport-belt" } } },
    { at: at(10), event: "response", response: { id: "5", ok: true, result: {} } },
  ];
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const h = haulCounts(f, 0);
  assert.equal(h.calls, 3);
  assert.deepEqual(h.byItem, [["coal", 2], ["fuel", 1], ["iron-plate", 1]]);
  assert.equal(haulCounts(f, Date.UTC(2026, 10, 3, 7, 0, 4)).calls, 1);
});
