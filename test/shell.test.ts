// 找 Git Bash、解 UTF-16 输出 (src/play/shell.ts): 用户截图, 界面 /call status 走到了 WSL 的 bash, 一堆乱码
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { bashExe, decodeOutput, withGitBash } from "../src/play/shell.ts";

const P = (...s: string[]) => path.join(...s);

test("子进程 PATH 把 Git Bash 放最前面 (不然 PowerShell 里的 bash 是 WSL); 找不到或不是 Windows 不动", () => {
  const pf = "C:\\Program Files";
  const git = P(pf, "Git", "bin", "bash.exe");
  const has = (f: string) => path.resolve(f).toLowerCase() === path.resolve(git).toLowerCase();
  const out = withGitBash({ ProgramFiles: pf, Path: "C:\\WINDOWS\\system32" }, "win32", has);
  assert.equal(out.Path, `${P(pf, "Git", "bin")}${path.delimiter}C:\\WINDOWS\\system32`, "保留原来 PATH 的大小写写法");
  const none = { PATH: "C:\\x" };
  assert.equal(withGitBash(none, "win32", () => false), none);
  assert.equal(withGitBash(none, "linux", has), none);
});

test("Windows 上找 Git Bash: 装在 Git\\bin 的、从 PATH 上 git.exe 推的、PATH 上非 WSL 的; 都没有退回 bash", () => {
  const pf = "C:\\Program Files";
  const env = { ProgramFiles: pf, PATH: ["C:\\WINDOWS\\system32", "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps", P(pf, "Git", "cmd")].join(path.delimiter) };
  const has = (set: string[]) => (f: string) => set.map((x) => path.resolve(x).toLowerCase()).includes(path.resolve(f).toLowerCase());
  assert.equal(bashExe(env, "win32", has([P(pf, "Git", "bin", "bash.exe"), "C:\\WINDOWS\\system32\\bash.exe"])), P(pf, "Git", "bin", "bash.exe"), "常见安装目录");
  assert.equal(bashExe(env, "win32", has([P(pf, "Git", "usr", "bin", "bash.exe")])), P(pf, "Git", "usr", "bin", "bash.exe"));
  const envD = { ProgramFiles: "D:\\nope", PATH: ["C:\\WINDOWS\\system32", "E:\\tools\\Git\\cmd"].join(path.delimiter) };
  assert.equal(bashExe(envD, "win32", has(["E:\\tools\\Git\\cmd\\git.exe", "E:\\tools\\Git\\bin\\bash.exe", "C:\\WINDOWS\\system32\\bash.exe"])), path.resolve("E:\\tools\\Git\\bin\\bash.exe"), "从 git.exe 的位置推");
  const envW = { PATH: ["C:\\WINDOWS\\system32", "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps", "C:\\msys\\bin"].join(path.delimiter) };
  assert.equal(bashExe(envW, "win32", has(["C:\\WINDOWS\\system32\\bash.exe", "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe", "C:\\msys\\bin\\bash.exe"])), "C:\\msys\\bin\\bash.exe", "跳过 WSL 的两个");
  assert.equal(bashExe(envW, "win32", has(["C:\\WINDOWS\\system32\\bash.exe"])), "bash", "只有 WSL 的就退回 bash (让它报错, 不猜)");
  assert.equal(bashExe({ GIT_BASH: "X:\\my\\bash.exe" }, "win32", has(["X:\\my\\bash.exe"])), "X:\\my\\bash.exe", ".env 指定的优先");
  assert.equal(bashExe({}, "linux", () => true), "bash");
});

test("解输出: UTF-16 (wsl.exe 那种) 按 UTF-16 解, 其余 UTF-8", () => {
  const u16 = Buffer.from("\uFEFFwsl: localhost", "utf16le");
  assert.equal(decodeOutput(u16), "wsl: localhost");
  assert.equal(decodeOutput(Buffer.from("假 fh 收到: call status\n", "utf8")), "假 fh 收到: call status\n");
  assert.equal(decodeOutput(Buffer.alloc(0)), "");
  assert.equal(decodeOutput("已经是字符串"), "已经是字符串");
});
