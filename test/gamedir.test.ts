// 本机数据目录 (game/sandbox/paths.ts; 第二版 src/lab/gamedir.ts 的 labRoot / labPath / labRel 是它的转接): 可以在仓库外。环境变量没有时读 .env 文件 (模型的 ./fh 有时不带 .env 变量);
// 记录里写 "data/..." 相对路径, 搬了数据目录也找得到。第二版叫 LAB_DATA_DIR 和 "lab-data/...", 新项目改成 DATA_DIR 和 "data/..."。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { envFileVar, labPath, labRel, labRoot, REPO } from "../src/lab/gamedir.ts";

test(".env 文件里的变量: 去引号, 不看注释, 空值算没有, 只取第一个", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fp-envfile-"));
  const f = path.join(d, ".env");
  fs.writeFileSync(f, ["# DATA_DIR=注释里的不算", "FOO=1", 'DATA_DIR="D:/数据 目录"', "DATA_DIR=第二个", "EMPTY=", ""].join("\r\n"));
  assert.equal(envFileVar("DATA_DIR", f), "D:/数据 目录");
  assert.equal(envFileVar("FOO", f), "1");
  assert.equal(envFileVar("EMPTY", f), undefined);
  assert.equal(envFileVar("NOPE", f), undefined);
  assert.equal(envFileVar("FOO", path.join(d, "没有这个文件")), undefined);
  fs.rmSync(d, { recursive: true });
});

test("labRoot: 环境变量优先; 没有环境变量时读仓库 .env (子进程里核, 不动本进程的环境)", () => {
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(os.tmpdir(), "fp-lab-env");
  try { assert.equal(labRoot(), path.resolve(os.tmpdir(), "fp-lab-env")); } finally { if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev; }
  const fromFile = envFileVar("DATA_DIR");
  const env = { ...process.env };
  delete env.DATA_DIR;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { labRoot } from ${JSON.stringify(new URL("../src/lab/gamedir.ts", import.meta.url).href)}; console.log(labRoot());`], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.resolve(fromFile ?? path.join(REPO, "data")));
});

test("labPath / labRel: data/ 开头的落在数据目录下, 其他相对仓库; 两个互为反向", () => {
  const prev = process.env.DATA_DIR;
  const lab = path.join(os.tmpdir(), "fp-lab-elsewhere");
  process.env.DATA_DIR = lab;
  try {
    assert.equal(labPath("data/datasets/a/b.json"), path.join(lab, "datasets", "a", "b.json"));
    assert.equal(labPath("data\\datasets\\x"), path.join(lab, "datasets", "x"));
    assert.equal(labPath("training/knowledge/verified/facts.md"), path.join(REPO, "training", "knowledge", "verified", "facts.md"));
    assert.equal(labRel(path.join(lab, "datasets", "renders", "r.png")), "data/datasets/renders/r.png");
    assert.equal(labRel(path.join(REPO, "docs", "run.md")), "docs/run.md");
    for (const rel of ["data/play/groups/g.json", "docs/run.md"]) assert.equal(labRel(labPath(rel)), rel);
  } finally { if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev; }
});
