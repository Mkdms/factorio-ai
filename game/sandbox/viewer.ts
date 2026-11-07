// 观看用的游戏客户端: 用单独的配置和数据目录 (data/clients/<名字>/) 另开一个带界面的游戏窗口, 自动连进本机沙盘服务器。
// 模组和服务器完全一致 (都由 writeGameDir 写), 用户自己的游戏、配置和存档不碰。
// 换班不关游戏: 窗口 detached 起、pid 记在 viewer.json, 下一班用 attach 认领, 不重开。
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { factorioExe, findFactorioDir, dataRoot, writeGameDir } from "./paths.ts";
import { killPid, pidAlive } from "./running.ts";

const VIEWER_FILE = "viewer.json";

/** 游戏客户端日志 (factorio-current.log) 的结尾是不是"正常退出": 用户点右上角 × → "Quitting: window closed.", 菜单里退出 → "Quitting: user-quit." (2.1.24 日志原文);
 *  显卡挂了或进程被杀都没有这一行 → null。只看最后 60 行, 旧的退出不算。 */
export function normalQuitReason(logText: string): "window closed" | "user-quit" | null {
  const tail = logText.split(/\r?\n/).slice(-60).join("\n");
  const m = /Quitting: (window closed|user-quit)/.exec(tail);
  return m ? (m[1] as "window closed" | "user-quit") : null;
}

export class Viewer {
  readonly dir: string;
  readonly factorioDir: string;
  proc: ChildProcess | null = null;
  /** 接上的 (上一班起的) 窗口进程 */
  pid: number | null = null;
  /** 窗口里用的名字; null = Steam 版, 名字取自 Steam 登录改不了 */
  readonly playerName: string | null;

  /** opts.playerName: 想让窗口叫这个名字 → 要 .env 的 FACTORIO_VIEWER_DIR 指向独立版 (不走 Steam、不登录, 局域网玩家名才生效); 没配就还是 Steam 版 */
  constructor(name = "viewer", factorioDir?: string, opts: { playerName?: string } = {}) {
    const standalone = opts.playerName ? process.env.FACTORIO_VIEWER_DIR : undefined;
    const usable = !!standalone && fs.existsSync(path.join(standalone, "data", "base", "info.json"));
    this.factorioDir = usable ? standalone! : findFactorioDir(factorioDir);
    this.playerName = usable ? opts.playerName! : null;
    this.dir = path.join(dataRoot(), "clients", name);
  }

  /** 窗口进程还在 (自己起的或接上的) */
  get alive(): boolean {
    return this.proc ? this.proc.exitCode === null : pidAlive(this.pid);
  }

  /** 打开窗口并连到 127.0.0.1:gamePort; 返回进程 (窗口关掉时进程退出)。
   *  address: 连别人的服务器 (host:port), 客户端不带任何我们的模组; clientMods: 连别人的服务器时试着带上这些模组; as: 这一次用别的名字 */
  launch(gamePort: number, opts: { dlc?: boolean; mods?: string[]; address?: string; password?: string; clientMods?: string[]; as?: string } = {}): ChildProcess {
    writeGameDir(this.dir, this.factorioDir, {
      dlc: opts.dlc ?? true,
      locale: "zh-CN",
      extra: ["[graphics]", "full-screen=false"],
      mods: opts.address ? opts.clientMods ?? [] : opts.mods,
      noMod: !!opts.address && !opts.clientMods?.length,
    });
    // 独立版: 不给令牌 = 不登录, 名字就是这里写的
    if (this.playerName) fs.writeFileSync(path.join(this.dir, "player-data.json"), JSON.stringify({ "service-username": opts.as ?? this.playerName, "service-token": "" }));
    const logFd = fs.openSync(path.join(this.dir, "client.out"), "a");
    const proc = spawn(factorioExe(this.factorioDir), ["-c", path.join(this.dir, "config.ini"), "--mp-connect", opts.address ?? `127.0.0.1:${gamePort}`, ...(opts.password ? ["--password", opts.password] : [])], {
      stdio: ["ignore", logFd, logFd], detached: true,
      // Steam 版直接启动时会"要求重启游戏"并经 Steam 重新打开 (丢掉我们的参数); 设 SteamAppId 让它直接启动 (Factorio = 427520)
      env: this.playerName ? { ...process.env } : { ...process.env, SteamAppId: "427520", SteamGameId: "427520" },
    });
    fs.closeSync(logFd);
    proc.on("exit", () => {
      if (this.proc === proc) { this.proc = null; this.#clear(); }
    });
    this.proc = proc; this.pid = null;
    if (proc.pid) fs.writeFileSync(path.join(this.dir, VIEWER_FILE), JSON.stringify({ pid: proc.pid, gamePort, startedAt: new Date().toISOString() }));
    return proc;
  }

  /** 窗口进程不在了, 而且是用户自己关的 → 原因; 还活着或是崩的 → null */
  normalQuit(): "window closed" | "user-quit" | null {
    if (this.alive) return null;
    try { return normalQuitReason(fs.readFileSync(path.join(this.dir, "factorio-current.log"), "utf8")); } catch { return null; }
  }

  /** 认领上一班留下的窗口 (viewer.json 里的 pid 还在、连的是同一个端口) → true; 不在就清掉记录 → false */
  attach(gamePort: number): boolean {
    let o: { pid?: unknown; gamePort?: unknown } | null = null;
    try { o = JSON.parse(fs.readFileSync(path.join(this.dir, VIEWER_FILE), "utf8")); } catch { return false; }
    const pid = typeof o?.pid === "number" ? o.pid : 0;
    if (!pidAlive(pid) || o?.gamePort !== gamePort) { this.#clear(); return false; }
    this.pid = pid; this.proc = null;
    return true;
  }

  /** 放手不关 (换班不关游戏): 本进程退出时窗口留着 */
  release(): void {
    if (this.proc) { this.pid = this.proc.pid ?? null; this.proc.removeAllListeners("exit"); this.proc.unref(); this.proc = null; }
  }

  close() {
    if (this.proc) this.proc.kill(); else if (this.pid) killPid(this.pid);
    this.proc = null; this.pid = null;
    this.#clear();
  }

  #clear() { try { fs.unlinkSync(path.join(this.dir, VIEWER_FILE)); } catch { /* 没有 */ } }
}
