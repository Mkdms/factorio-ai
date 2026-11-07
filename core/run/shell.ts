// 在 Windows 上找"对的" bash (库, 不直接运行)。
// 用户截图: 界面里输入 /call status, 对话里一堆乱码 + "WSL (14 - Relay) ERROR: … execvpe(/bin/bash) failed" ——
// 控制接口用 PATH 上的 `bash` 跑 ./fh, 双击界面时 PATH 是系统的, `bash` 解析到 WSL 的 C:\Users\…\WindowsApps\bash.exe (System32\bash.exe 同理),
// WSL 没装发行版就报错, 而且 wsl.exe 的输出是 UTF-16, 按 UTF-8 显示就是乱码。之前的冒烟都是从 Git Bash 里跑的 (它的 PATH 把 Git\usr\bin 放前面), 没撞上。
// 做法: 明确找 Git for Windows 的 bash (装在 Git\bin 或 Git\usr\bin; 系统 PATH 里通常只有 Git\cmd, 从 git.exe 的位置推), 跳过 WSL 的那两个。
import fs from "node:fs";
import path from "node:path";

const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
/** WSL 的 bash: System32\bash.exe、WindowsApps\bash.exe */
const isWsl = (f: string) => /[\\/](system32|windowsapps)[\\/]bash\.exe$/i.test(f);

/**
 * Git Bash 的路径; 找不到就退回 "bash" (让 PATH 决定)。顺序: .env 的 GIT_BASH → 常见安装目录 → PATH 上 git.exe 旁边的 → PATH 上不是 WSL 的 bash。
 * 不是 Windows 直接 "bash"。
 */
export function bashExe(env: NodeJS.ProcessEnv = process.env, platform = process.platform, exists: (f: string) => boolean = isFile): string {
  if (platform !== "win32") return "bash";
  const own = env.GIT_BASH?.trim();
  if (own && exists(own)) return own;
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : ""].filter((x): x is string => !!x);
  for (const r of roots) for (const sub of ["bin", path.join("usr", "bin")]) {
    const f = path.join(r, "Git", sub, "bash.exe");
    if (exists(f)) return f;
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    // …\Git\cmd\git.exe → …\Git\bin\bash.exe
    if (exists(path.join(d, "git.exe"))) for (const sub of [path.join("..", "bin"), path.join("..", "usr", "bin")]) {
      const f = path.resolve(d, sub, "bash.exe");
      if (exists(f)) return f;
    }
  }
  for (const d of dirs) {
    const f = path.join(d, "bash.exe");
    if (exists(f) && !isWsl(f)) return f;
  }
  return "bash";
}

/**
 * 子进程的 PATH 把 Git Bash 放最前面: Codex / Grok 在 PowerShell 里跑命令, 模型写 bash -lc './fh …' 时 bash 解析到 WSL,
 * 回一堆乱码 + "execvpe(/bin/bash) failed" (2026-11-05 Gpt 开局第一条就这样)。本机核过: 放前面之后 bash -lc 能跑 ./fh, 工作目录不变。
 */
export function withGitBash(env: NodeJS.ProcessEnv, platform = process.platform, exists: (f: string) => boolean = isFile): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const exe = bashExe(env, platform, exists);
  if (exe === "bash") return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: `${path.dirname(exe)}${path.delimiter}${env[key] ?? ""}` };
}

/** 子进程输出 → 字符串: 有大量 NUL 字节的是 UTF-16 (wsl.exe 这种), 按 UTF-16 解; 其余 UTF-8 */
export function decodeOutput(buf: Buffer | string): string {
  if (typeof buf === "string") return buf;
  if (buf.length >= 4) {
    let nul = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0) nul++;
    if (nul / buf.length > 0.2) return buf.toString("utf16le").replace(/^\uFEFF/, "");
  }
  return buf.toString("utf8");
}
