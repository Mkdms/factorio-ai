// 沙盘默认存档 (src/lab/default-save.ts): 全新目录没有本机那份参考存档时不能当它存在
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultLabSave } from "../src/lab/default-save.ts";

test("全新目录没有参考存档: 回 undefined", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "default-save-"));
  try { assert.equal(defaultLabSave(root), undefined); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("本机有参考存档: 回它的路径", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "default-save-"));
  try {
    const save = path.join(root, "play", "runs", "2026-11-05T10-16-30", "end.zip");
    fs.mkdirSync(path.dirname(save), { recursive: true });
    fs.writeFileSync(save, "");
    assert.equal(defaultLabSave(root), save);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
