// 游戏内提示与技巧的完整性 (2026-11-02: 第一次只读了 base 和 space-age 两个模组, 说成"全部 76 条", 漏了品质 4 条和高架铁路 1 条):
// 从游戏数据目录下所有模组现数, 和 docs/research/players/game-tips.md 里声明的条数、模组清单对不上就失败 (换版本 / 加模组也能抓住)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findFactorioDir } from "../src/lab/gamedir.ts";

let dataDir: string | null = null;
try { dataDir = path.join(findFactorioDir(), "data"); } catch { dataDir = null; }

test("提示与技巧: 游戏里所有模组的条数和 game-tips.md 声明的一致", { skip: !dataDir }, () => {
  const counts: Record<string, number> = {};
  for (const mod of fs.readdirSync(dataDir!)) {
    const f = path.join(dataDir!, mod, "prototypes", "tips-and-tricks.lua");
    if (!fs.existsSync(f)) continue;
    counts[mod] = (fs.readFileSync(f, "utf8").match(/type\s*=\s*"tips-and-tricks-item"/g) ?? []).length;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const md = fs.readFileSync(path.join(import.meta.dirname, "..", "training", "knowledge", "pending", "research", "game-tips.md"), "utf8"); // 新项目里资料在 training/ (第二版是 docs/research/players/)
  const declared = Number(md.match(/共\s*(\d+)\s*条/)?.[1]);
  assert.equal(total, declared, `游戏里共 ${total} 条 (${JSON.stringify(counts)}), game-tips.md 声明 ${declared} 条: 有新的提示没读`);
  for (const mod of Object.keys(counts)) assert.ok(md.includes(mod), `game-tips.md 没提到模组 ${mod} 的提示`);
});
