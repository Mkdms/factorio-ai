// 沙盘服务器: 一个本机无界面服务器 = 一个单独的数据目录 (config.ini、mods、saves、日志) + 自己的端口。
// 多开: 每个实例目录、端口、RCON 密码都不同, 互不干扰; 不碰用户自己的存档和设置。
// 和游戏里我们的模组 (game/mod/factorio-ai) 说话: RCON 发控制台命令调 remote 接口, 或 UDP 快速通道 (不经控制台)。
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { RconClient } from "./rcon.ts";
import { UdpChannel } from "./udp.ts";
import { decodeGameString } from "../blueprint.ts";
import { ROOT, SANDBOX_MOD, findFactorioDir, factorioExe, dataRoot, builtinMods, writeGameDir } from "./paths.ts";
import { Viewer } from "./viewer.ts";
import { clearRunning, killPid, pidAlive, readRunning, waitPidExit, writeRunning } from "./running.ts";

export { ROOT, findFactorioDir, factorioExe, dataRoot, builtinMods, writeGameDir };

export async function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export async function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.once("error", reject);
    s.bind(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/** 字符串放进 Lua 长括号 (等号数量避开内容里的 ]=*]) */
export function longBracket(s: string): [string, string] {
  let eq = "";
  while (s.includes("]" + eq + "]")) eq += "=";
  return ["[" + eq + "[", "]" + eq + "]"];
}

export class SandboxError extends Error {
  raw?: string;
  constructor(message: string, raw?: string) {
    super(message);
    this.raw = raw;
  }
}

/** 解析模组的回复; 不是 "j:" / "z:" 开头就是没读到 (不能当成读到空) */
export function parseReply(raw: string): { ok: boolean; data?: unknown; error?: string; tick: number } {
  const t = raw.trim();
  let json: string;
  if (t.startsWith("j:")) json = t.slice(2);
  else if (t.startsWith("z:")) json = decodeGameString(t.slice(2));
  else throw new SandboxError(`没读到模组的回复 (模组没加载或命令出错): ${t.slice(0, 300)}`, raw);
  return JSON.parse(json);
}

export interface ServerOptions {
  /** 实例名, 也是数据目录名 (data/sandbox/<name>) */
  name: string;
  factorioDir?: string;
  /** 启用游戏自带的 DLC 模组 (太空时代等), 默认 true */
  dlc?: boolean;
  /** 打开 UDP 快速通道, 默认 true */
  udp?: boolean;
  /** 可视化: 起服后另开一个游戏窗口连进来, 做完窗口再留一会儿才关。默认看 SANDBOX_VIEW=1; 停留 SANDBOX_VIEW_LINGER 秒 (默认 60); 窗口在时速度上限 SANDBOX_VIEW_MAX_SPEED (默认 20) */
  view?: boolean;
  /** 可视化时在游戏聊天里显示的名字 */
  label?: string;
  /** 覆盖服务器设置 */
  serverSettings?: Record<string, unknown>;
  /** 沙盘模组之外还要装的我们的模组 (game/mod/ 下); 观看窗口自动装同一套 */
  mods?: string[];
  /** 干净的服务器: 一个我们的模组都不装, 当联机服务器的替身 (模型那条路不装模组)。没有 rpc / exec / UDP; 测试要真值用 rcon.exec 发 /silent-command */
  clean?: boolean;
}

export interface RpcOptions {
  via?: "rcon" | "udp";
  timeoutMs?: number;
  /** 单次回复的字节上限 (压缩后), 默认 SandboxServer.defaultMaxReplyBytes (8MB) */
  maxReplyBytes?: number;
  /** 只读请求: 断线或超时后自动重试一次 */
  retry?: boolean;
}

const READY = `${SANDBOX_MOD}-ready`;

export class SandboxServer {
  /** 单次回复的默认上限 (压缩后 8MB); 43125 件的基地 place_blueprint 回复约 1MB */
  static defaultMaxReplyBytes = 8 * 1024 * 1024;
  readonly name: string;
  readonly dir: string;
  readonly factorioDir: string;
  readonly exe: string;
  readonly opts: ServerOptions;
  gamePort = 0;
  rconPort = 0;
  udpPort = 0;
  password = "";
  proc: ChildProcess | null = null;
  /** 接上的 (不是本进程起的) 服务器进程 (attach; 换班不关游戏) */
  pid: number | null = null;
  rcon: RconClient | null = null;
  udp: UdpChannel | null = null;
  save = "";
  viewer: Viewer | null = null;

  constructor(opts: ServerOptions) {
    if (!/^[\w.-]+$/.test(opts.name)) throw new Error(`实例名只能用字母数字和 ._-: ${opts.name}`);
    this.opts = { dlc: true, udp: true, view: process.env.SANDBOX_VIEW === "1", ...opts };
    this.name = opts.name;
    this.factorioDir = findFactorioDir(opts.factorioDir);
    this.exe = factorioExe(this.factorioDir);
    this.dir = path.join(dataRoot(), "sandbox", opts.name);
  }

  get configPath() {
    return path.join(this.dir, "config.ini");
  }

  savePath(name: string) {
    return path.join(this.dir, "saves", name.endsWith(".zip") ? name : name + ".zip");
  }

  /** 写好单独的配置、模组列表、服务器设置, 把我们的模组拷进去 */
  prepare(locale = "en") {
    writeGameDir(this.dir, this.factorioDir, { dlc: !!this.opts.dlc, locale, mods: this.opts.mods, noMod: !!this.opts.clean });
    fs.writeFileSync(
      path.join(this.dir, "server-settings.json"),
      JSON.stringify(
        {
          name: `factorio-ai-sandbox-${this.name}`,
          description: "local sandbox, not public",
          tags: [],
          max_players: 0,
          visibility: { public: false, lan: false },
          require_user_verification: false,
          allow_commands: "admins-only",
          autosave_interval: 10,
          autosave_slots: 2,
          afk_autokick_interval: 0,
          auto_pause: false,
          auto_pause_when_players_connect: false,
          only_admins_can_pause_the_game: true,
          non_blocking_saving: false,
          ...(this.opts.serverSettings ?? {}),
        },
        null,
        2,
      ),
    );
  }

  #run(args: string[], label: string, timeoutMs = 300_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const log = fs.createWriteStream(path.join(this.dir, `${label}.out`));
      const p = spawn(this.exe, ["-c", this.configPath, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      p.stdout.pipe(log);
      p.stderr.pipe(log);
      const timer = setTimeout(() => p.kill(), timeoutMs);
      p.on("error", reject);
      p.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`factorio ${label} 退出码 ${code}, 日志 ${path.join(this.dir, label + ".out")}`));
      });
    });
  }

  /** 建一张新图 (含已启用的 DLC); mapGenSettings 会和游戏默认值合并 */
  async createMap(save: string, opts: { seed?: number; mapGenSettings?: object; mapSettings?: object } = {}) {
    this.prepare();
    const args = ["--create", this.savePath(save)];
    if (opts.seed !== undefined) args.push("--map-gen-seed", String(opts.seed));
    if (opts.mapGenSettings) {
      const f = path.join(this.dir, "map-gen-settings.json");
      fs.writeFileSync(f, JSON.stringify(opts.mapGenSettings));
      args.push("--map-gen-settings", f);
    }
    if (opts.mapSettings) {
      const f = path.join(this.dir, "map-settings.json");
      fs.writeFileSync(f, JSON.stringify(opts.mapSettings));
      args.push("--map-settings", f);
    }
    fs.rmSync(this.savePath(save), { force: true });
    await this.#run(args, "create");
    if (!fs.existsSync(this.savePath(save))) throw new Error(`建图后没找到存档 ${this.savePath(save)}`);
  }

  /** 本机版本 + 启用模组对应的原型数据目录 (data/prototypes/<模组-版本...>) */
  prototypesDir(): string {
    const mods = builtinMods(this.factorioDir).filter((m) => m.name === "base" || this.opts.dlc);
    return path.join(dataRoot(), "prototypes", mods.map((m) => `${m.name}-${m.version}`).join("_"));
  }

  /** 导出游戏运行时的常量表 defines (原型目录下 defines.json; 游戏外的模组宿主要它): 没有就经 RCON 读一次。要服务器在跑 */
  async dumpDefines(): Promise<string> {
    const file = path.join(this.prototypesDir(), "defines.json");
    if (!fs.existsSync(file)) {
      // 干净的服务器没有模组: 直接一条 Lua 把 defines 打成 JSON (沙盘不在乎成就)
      const d = this.opts.clean
        ? JSON.parse((await this.rcon!.exec("/silent-command rcon.print(helpers.table_to_json(defines))", { retry: true, timeoutMs: 60_000 })).trim())
        : await this.exec("return defines", undefined, { maxReplyBytes: 64 * 1024 * 1024, timeoutMs: 60_000 });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(d));
    }
    return file;
  }

  /** 导出当前版本的原型数据 (data-raw-dump.json) 和英文、简体中文的名称 (locale/<语言>/*.json); 已有就跳过。先写临时目录再改名, 多个实例同时导出也不会写坏 */
  async dumpPrototypes(): Promise<string> {
    const outDir = this.prototypesDir();
    if (fs.existsSync(path.join(outDir, "data-raw-dump.json"))) return outDir;
    const tmp = `${outDir}.tmp-${this.name}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    const so = path.join(this.dir, "script-output");
    this.prepare();
    fs.rmSync(so, { recursive: true, force: true });
    await this.#run(["--dump-data"], "dump-data");
    fs.mkdirSync(path.join(tmp, "locale"), { recursive: true });
    fs.copyFileSync(path.join(so, "data-raw-dump.json"), path.join(tmp, "data-raw-dump.json"));
    for (const locale of ["en", "zh-CN"]) {
      this.prepare(locale);
      fs.rmSync(so, { recursive: true, force: true });
      await this.#run(["--dump-prototype-locale"], `dump-locale-${locale}`);
      const dst = path.join(tmp, "locale", locale);
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(so).filter((f) => f.endsWith("-locale.json"))) fs.copyFileSync(path.join(so, f), path.join(dst, f));
    }
    this.prepare();
    try {
      fs.renameSync(tmp, outDir);
    } catch (e) {
      // 别的实例先导完了: 用它的, 删掉自己的
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!fs.existsSync(path.join(outDir, "data-raw-dump.json"))) throw e;
    }
    return outDir;
  }

  /** 服务器进程还在 (自己起的: 退出了的话 exit 事件会把 proc 清掉; 接上的: 探 pid) */
  get alive() {
    return this.proc ? this.proc.exitCode === null : pidAlive(this.pid);
  }

  /** 接上这个实例目录里已经在跑的服务器 (上一班留下的, running.json): 不读档不重起; 没有 / 进程没了 / RCON 连不上 → false (调用方改为正常开) */
  async attach(): Promise<boolean> {
    if (this.proc) throw new Error(`实例 ${this.name} 已在运行`);
    const r = readRunning(this.dir);
    if (!r) return false;
    this.gamePort = r.gamePort; this.udpPort = r.udpPort; this.rconPort = r.rconPort; this.password = r.password; this.save = r.save; this.pid = r.pid;
    const rcon = new RconClient({ port: this.rconPort, password: this.password });
    try {
      await Promise.race([rcon.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error("RCON 10 秒连不上")), 10_000))]);
      this.rcon = rcon;
      const out = await this.rcon.exec(`/silent-command rcon.print("${READY}")`, { retry: true });
      if (out.trim() !== READY) throw new Error(`RCON 回了 ${out.slice(0, 80)}`);
      const ping = (await this.rpc("ping", {}, { retry: true })) as { mod?: string };
      if (!ping.mod) throw new Error("沙盘模组没加载");
      if (this.opts.udp && this.udpPort) { await this.rpc("udp", { enabled: true }); this.udp = new UdpChannel(this.udpPort); }
      return true;
    } catch (e) {
      rcon.close(); this.rcon = null; this.pid = null;
      throw new Error(`接不上在跑的服务器 (pid ${r.pid}, RCON ${r.rconPort}): ${(e as Error).message}`);
    }
  }

  /** 放手不关 (换班不关游戏): 断开 RCON / UDP, 服务器进程留着给下一班 attach; 退出时不杀它 */
  release(): void {
    this.udp?.close(); this.udp = null;
    this.rcon?.close(); this.rcon = null;
    // unref: 子进程句柄不再撑着本进程的事件循环 (不 unref 的话收尾完了也退不出)
    if (this.proc) { killOnExit.delete(this.proc); this.pid = this.proc.pid ?? null; this.proc.removeAllListeners("exit"); this.proc.unref(); this.proc = null; }
  }

  /** 让服务器现在存一次档 (/server-save 存到当前存档), 等文件更新 (最多 30 秒); 返回存档路径 */
  async saveNow(): Promise<string> {
    if (!this.rcon) throw new Error("RCON 没连上");
    const file = this.savePath(this.save || "m");
    const before = (() => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } })();
    await this.rcon.exec("/server-save", { timeoutMs: 10_000 });
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 500));
      try { const st = fs.statSync(file); if (st.mtimeMs > before && Date.now() - st.mtimeMs > 1000) return file; } catch { /* 还没写出来 */ }
    }
    throw new Error(`存档 ${file} 30 秒内没更新`);
  }

  /** 崩溃 / 卡死后用同一个数据目录重启 (端口、密码不变; 原型数据不重新导出)。旧进程还活着就先结束它 (存档不动); 用哪份存档由调用方定 */
  async restart(save: string) {
    await this.stop({ save: false, timeoutMs: 10_000 });
    return this.start(save, { dump: false, keepPorts: true });
  }

  /** 用指定存档启动无界面服务器, 连上 RCON 和 UDP, 确认模组已加载。启动前先确保本版本的原型数据已导出 */
  async start(save: string, opts: { dump?: boolean; keepPorts?: boolean } = {}) {
    if (this.proc) throw new Error(`实例 ${this.name} 已在运行`);
    if (opts.dump !== false) await this.dumpPrototypes();
    this.prepare();
    if (!fs.existsSync(this.savePath(save))) throw new Error(`没有存档 ${this.savePath(save)}`);
    this.save = save;
    // 崩溃重启 (restart) 时端口、密码照旧: 连着的命令行、观看窗口、控制接口都不用改
    if (!(opts.keepPorts && this.rconPort && this.password)) {
      [this.gamePort, this.udpPort, this.rconPort] = await Promise.all([freeUdpPort(), freeUdpPort(), freeTcpPort()]);
      this.password = crypto.randomBytes(12).toString("hex");
    }
    const args = [
      "-c", this.configPath,
      "--start-server", this.savePath(save),
      "--server-settings", path.join(this.dir, "server-settings.json"),
      "--port", String(this.gamePort),
      "--bind", "127.0.0.1",
      "--rcon-bind", `127.0.0.1:${this.rconPort}`,
      "--rcon-password", this.password,
    ];
    if (this.opts.udp && !this.opts.clean) args.push("--enable-lua-udp", String(this.udpPort));
    // 日志直接写文件、进程 detached: 换班不关游戏时起它的程序退出了它也在; 本进程正常退出仍由 killOnExit 收掉 (release 过的除外)
    const logFd = fs.openSync(path.join(this.dir, "server.out"), "a");
    const proc = spawn(this.exe, args, { stdio: ["ignore", logFd, logFd], windowsHide: true, detached: true });
    fs.closeSync(logFd);
    this.proc = proc; this.pid = null;
    let exited = false;
    proc.on("exit", () => {
      exited = true;
      if (this.proc === proc) { this.proc = null; clearRunning(this.dir); }
    });
    killOnExit.add(proc);

    this.rcon = new RconClient({ port: this.rconPort, password: this.password });
    try {
      await Promise.race([
        this.rcon.connect(),
        new Promise((_, rej) => proc.once("exit", (c) => rej(new Error(`服务器启动失败, 退出码 ${c}; 日志 ${path.join(this.dir, "server.out")}`)))),
      ]);
    } catch (e) {
      if (!exited) proc.kill();
      throw e;
    }
    // 每张图第一次用 Lua 命令时, 游戏会提示"会禁用成就, 请再输一次", 第一条命令不执行 (2.1.24 实测)。
    // 干净的服务器 (联机替身) 一条 Lua 都不发 (发了这张图就不算成就; 2026-11-08 查出这里是开班路上最后一条): 用 /version 探 RCON 通不通
    for (let i = 0; ; i++) {
      const out = this.opts.clean ? await this.rcon.exec("/version", { retry: true }) : await this.rcon.exec(`/silent-command rcon.print("${READY}")`, { retry: true });
      if (this.opts.clean ? /\d+\.\d+\.\d+/.test(out) : out.trim() === READY) break;
      if (i >= 3) throw new Error(`RCON 预热失败: ${out.slice(0, 200)}`);
    }
    let ping: { mod?: string; clean?: boolean } = { clean: true };
    if (!this.opts.clean) {
      ping = (await this.rpc("ping", {}, { retry: true })) as { mod?: string };
      if (!ping.mod) throw new Error("沙盘模组没加载");
      if (this.opts.udp) {
        await this.rpc("udp", { enabled: true });
        this.udp = new UdpChannel(this.udpPort);
      }
    }
    if (proc.pid) writeRunning(this.dir, { pid: proc.pid, gamePort: this.gamePort, udpPort: this.udpPort, rconPort: this.rconPort, password: this.password, save, startedAt: new Date().toISOString() });
    if (this.opts.view) await this.#openViewer();
    return ping;
  }

  /**
   * 调模组的一个方法, 返回 data; 出错抛 SandboxError。
   * 回复为空 (玩家加入、服务器为他存图的那一刻, 命令的回复会丢; 2.1.24 实测) 时:
   * 只读请求 (retry) 自动重试几次; 会改东西的请求照实报错, 不猜它执行了没有。
   */
  async rpc(method: string, args: object = {}, opts: RpcOptions = {}): Promise<unknown> {
    if (this.opts.clean) throw new Error(`干净的服务器没装沙盘模组, 没有 rpc (${method}); 测试要真值用 rcon.exec 发 /silent-command`);
    const req = JSON.stringify({ method, args });
    let raw = "";
    for (let attempt = 0; attempt < (opts.retry ? 4 : 1); attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 300 * attempt));
      if (opts.via === "udp") {
        if (!this.udp) throw new SandboxError("UDP 快速通道没开");
        raw = await this.udp.request(req, opts.timeoutMs);
      } else {
        if (!this.rcon) throw new SandboxError(`实例 ${this.name} 没在运行`);
        const [open, close] = longBracket(req);
        raw = await this.rcon.exec(`/silent-command rcon.print(remote.call("${SANDBOX_MOD}","rpc",${open}${req}${close}))`, {
          timeoutMs: opts.timeoutMs,
          retry: opts.retry,
        });
      }
      if (raw.trim() !== "") break;
    }
    // 输出上限: 超过就拒绝, 让调用方分页, 不让大回复往上游 (模型) 流
    const cap = opts.maxReplyBytes ?? SandboxServer.defaultMaxReplyBytes;
    if (raw.length > cap) throw new SandboxError(`${method} 的回复 ${(raw.length / 1e6).toFixed(1)}MB 超过上限 ${(cap / 1e6).toFixed(0)}MB: 分页或缩小范围 (可用 maxReplyBytes 临时放宽)`);
    const reply = parseReply(raw);
    if (!reply.ok) throw new SandboxError(`${method} 出错: ${reply.error}`, raw);
    return reply.data;
  }

  exec(code: string, args?: unknown, opts?: RpcOptions) {
    return this.rpc("exec", { code, args }, opts);
  }

  /** 打开可视化窗口并等玩家连进来 (最多 90 秒); 打不开只记一句, 不影响实验 */
  async #openViewer() {
    try {
      this.viewer = new Viewer(`viewer-${this.name}`, this.factorioDir);
      this.viewer.launch(this.gamePort, { dlc: this.opts.dlc, mods: this.opts.mods });
      for (let i = 0; i < 180; i++) {
        const v = (await this.rpc("viewer", {}, { retry: true })) as { count: number };
        if (v.count > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      await this.say(`实验开始: ${this.opts.label ?? this.name}`);
    } catch (e) {
      console.error(`可视化窗口没打开 (实验照常): ${(e as Error).message}`);
    }
  }

  /** 在游戏聊天里说一句 (只在有窗口时有用; 失败不报错) */
  async say(text: string) {
    if (!this.viewer?.proc) return;
    await this.rpc("say", { text: `[沙盘] ${text}` }).catch(() => undefined);
  }

  /** 有窗口时的速度上限 */
  get maxSpeed(): number {
    return this.viewer?.proc ? Number(process.env.SANDBOX_VIEW_MAX_SPEED ?? 20) : Infinity;
  }

  /** 暂停状态下精确跑 n 个 tick (speed 为倍速), 跑完返回 */
  async runTicks(n: number, speed = 1000, pollMs = 250) {
    speed = Math.min(speed, this.maxSpeed);
    const start = (await this.rpc("ping", {}, { retry: true })) as { tick: number };
    await this.rpc("time", { speed, run_ticks: n });
    const target = start.tick + n;
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs));
      const s = (await this.rpc("ping", {}, { retry: true })) as { tick: number; ticks_to_run: number };
      if (s.tick >= target && s.ticks_to_run === 0) return s;
      if (!this.proc) throw new Error("服务器在跑 tick 时退出了");
    }
  }

  /** 停服。save=true 时用 /quit (游戏会把当前状态存回启动用的存档); false 时直接结束进程, 存档不变 */
  async stop(opts: { save?: boolean; timeoutMs?: number } = {}) {
    const { save = true, timeoutMs = 30_000 } = opts;
    if (this.viewer?.proc && this.proc) {
      const linger = Number(process.env.SANDBOX_VIEW_LINGER ?? 60);
      await this.say(`实验结束, 窗口 ${linger} 秒后关闭。`);
      await this.rpc("time", { paused: false, speed: 1 }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, linger * 1000));
    }
    this.viewer?.close();
    this.viewer = null;
    const proc = this.proc;
    const pid = this.pid; // 接上的 (不是本进程起的)
    this.udp?.close();
    this.udp = null;
    if (!save) { proc?.kill(); if (!proc && pid) killPid(pid); }
    else if (this.rcon) {
      this.rcon.exec("/quit", { timeoutMs: 5000 }).catch(() => undefined);
    }
    if (proc && proc.exitCode === null) {
      const ok = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        proc.once("exit", () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      if (!ok) proc.kill();
    } else if (!proc && pid && pidAlive(pid)) {
      if (!(await waitPidExit(pid, timeoutMs))) killPid(pid);
    }
    this.rcon?.close();
    this.rcon = null;
    this.proc = null;
    this.pid = null;
    clearRunning(this.dir);
    if (proc) killOnExit.delete(proc);
  }
}

// Node 退出时不留下孤儿服务器进程
const killOnExit = new Set<ChildProcess>();
process.on("exit", () => {
  for (const p of killOnExit) if (p.exitCode === null) p.kill();
});
