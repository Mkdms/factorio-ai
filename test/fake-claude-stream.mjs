// 假的 claude -p --input-format stream-json (test/play-claude-stream.test.ts 用): 照 Claude Code 2.1.282+ 的行为 (OpenMausBot server/drivers/claude.ts 的注释):
// 每条消息跑一轮: init → 一次"工具调用" (等 FAKE_TOOL_MS) → 期间写进来的插话在下一次模型调用前收下 (回显 isReplay + uuid) → assistant → result。
// FAKE_LATE=1: 插话写在最后一次模型调用期间 → result 之后才回显, 单独跑成一轮。FAKE_DROP=1: 带 uuid 的插话一律不理 (测宽限超时)。
import readline from "node:readline";

const late = process.env.FAKE_LATE === "1", drop = process.env.FAKE_DROP === "1", toolMs = Number(process.env.FAKE_TOOL_MS ?? 150);
let cost = 0, busy = false;
const queue = [];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const replay = (m) => out({ type: "user", isReplay: true, uuid: m.uuid, message: m.message });

async function run() {
  busy = true;
  while (queue.length) {
    const first = queue.shift();
    replay({ ...first, uuid: first.uuid ?? `cli-${Math.random()}` }); // 每轮的提示也回显, uuid 由 CLI 自己给 (2.1.314 实测)
    out({ type: "system", subtype: "init" });
    const got = [first.message.content];
    await new Promise((r) => setTimeout(r, toolMs));
    if (!late) while (queue.length && queue[0].uuid) { const s = queue.shift(); replay(s); got.push(s.message.content); }
    cost += 0.01;
    out({ type: "assistant", message: { id: `m${Math.random()}`, content: [{ type: "text", text: `收到: ${got.join(" | ")}` }], usage: { input_tokens: 1, output_tokens: 1 } } });
    out({ type: "result", subtype: "success", is_error: false, result: got.join(" | "), total_cost_usd: +cost.toFixed(2) });
  }
  busy = false;
}

readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (drop && m.uuid) return;
  if (m.message?.content === "退出") process.exit(3);
  queue.push(m);
  if (!busy) run();
}).on("close", () => process.exit(0));
