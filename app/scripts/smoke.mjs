#!/usr/bin/env node
// 界面的端到端冒烟检查 (不开游戏, 不碰正在跑的那一班):
//   造一班假的记录 (临时目录; RCON 端口是关着的, ./fh 是个只回显参数的假脚本) → 用它起控制接口 (127.0.0.1:4330)
//   → 开编好的界面程序, 让 WebView2 开调试端口 → 像人一样点界面、打字 → 核对显示的东西和控制接口那边的效果 → 全部关掉、删临时目录。
// 之后: 关掉界面和控制接口, 不起控制接口直接开界面 → 核对界面自己起了控制接口、读到数, 关界面时把它收掉。
// 用法 (仓库根目录, 先 cd app && npm run app:build): node --env-file-if-exists=.env app/scripts/smoke.mjs [界面程序路径]
//   .env 里的 LAB_DATA_DIR 有导出的中文名时会拷过去, 研究名就按官方中文名核对。4330 被占着 (真的控制接口在跑) 就不跑。
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");
const EXE = process.argv[2] ?? path.join(REPO, "app/src-tauri/target/release/factorio-pilot-app.exe");
const DBG = 9333;
const SHOTS = path.join(os.tmpdir(), "fp-smoke-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, what) => { results.push(ok); console.log(`${ok ? "通过" : "失败"}  ${what}`); };

const portOpen = (port) => new Promise((r) => { const s = net.connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

if (!fs.existsSync(EXE)) { console.error(`没有界面程序 ${EXE}: 先 cd app && npm run app:build`); process.exit(2); }
if (await portOpen(4330)) { console.error("4330 已经有控制接口在跑: 先关掉它再跑冒烟检查 (界面固定连 4330)"); process.exit(2); }

// ── 假的一班 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-smoke-"));
const runs = path.join(tmp, "lab", "play", "runs");
const PREV = "2000-01-01T00-00-00", CUR = "2000-01-01T01-00-00"; // 不会和真的班次重名 (界面按班次名存本地记录)
const cur = path.join(runs, CUR);
fs.mkdirSync(path.join(runs, PREV), { recursive: true });
fs.mkdirSync(cur, { recursive: true });
const w = (f, o) => fs.writeFileSync(path.join(cur, f), Array.isArray(o) ? o.map((x) => JSON.stringify(x)).join("\n") + "\n" : JSON.stringify(o));
fs.writeFileSync(path.join(runs, PREV, "review.json"), JSON.stringify({ lines: ["研究: 59 → 70 项"], fixes: ["先把绿瓶的线补上", "研究中心别空着"] }));
// 上一班留几个对话记录文件: 最后测"删对话记录" 只删这些, 留 summary / review
for (const f of ["turn-a-1.jsonl", "requests.jsonl", "monitor.jsonl"]) fs.writeFileSync(path.join(runs, PREV, f), "{}\n");
fs.writeFileSync(path.join(runs, PREV, "summary.json"), "{}"); // 上一班收尾了
// 两班属于同一个世界 (src/play/worlds.ts; 界面左上角按世界列班次)
for (const id of [PREV, CUR]) fs.writeFileSync(path.join(runs, id, "world.json"), JSON.stringify({ id: "sandbox-smoke", name: "沙盘 · 冒烟测试", kind: "sandbox", createdAt: "", firstRun: PREV }));
const deadPort = await freePort();
// B 的游戏用一个假 RCON (只认私信那条 dispatch, 回 ok, 记下收到的话): 等你卡片的按钮要能真送到、卡片变成已回复; A 的端口关着 (测没送到)
const told = [];
const fakeRcon = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  const reply = (id, body) => { const b = Buffer.from(body, "utf8"); const p = Buffer.alloc(14 + b.length); p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(id, 4); p.writeInt32LE(2, 8); b.copy(p, 12); sock.write(p); };
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
      const size = buf.readInt32LE(0), id = buf.readInt32LE(4), type = buf.readInt32LE(8), body = buf.subarray(12, 4 + size - 2).toString("utf8");
      buf = buf.subarray(4 + size);
      if (type === 3) { reply(id, ""); continue; }
      // control.ts: remote.call("agent_harness", "dispatch", [[\n{JSON}]]) (Lua 长括号, 里面是原样的 JSON)
      const json = /\[(=*)\[\n([\s\S]*)\]\1\]/.exec(body)?.[2];
      if (body.includes("dispatch") && json) try { told.push(JSON.parse(json).args.text); } catch { /* 不是私信 */ }
      reply(id, body.includes("dispatch") ? '{"ok":true}' : "");
    }
  });
  sock.on("error", () => {});
});
const livePort = await new Promise((r) => fakeRcon.listen(0, "127.0.0.1", () => r(fakeRcon.address().port)));
w("session-a.json", { rconPort: deadPort, password: "x", player: 1, name: "MK", model: "Claude Opus 5.5", seat: { brain: "claude", model: "claude-opus-5-5" } }); // 新格式 (run.ts 2026-11-03 起写 name / model, 11-05 起写 seat)
w("session-b.json", { rconPort: livePort, password: "x", player: 1, bot: "ai2" }); // 旧格式: 模型从轮次文件第一行读
const now = Date.now();
const t = (s) => new Date(now - 600_000 + s * 1000).toISOString();
w("monitor.jsonl", [
  { t: now - 30_000, tick: 0, researched: 40, labs: 11, labsWorking: 5, machines: 100, redTotal: 0, greenTotal: 0, blueTotal: 0, busyBy: { a: true, b: false } },
  { t: now - 5_000, tick: 36_000, researched: 41, research: "automation-2", labs: 11, labsWorking: 9, machines: 120, redTotal: 150, greenTotal: 80, blueTotal: 20, busyBy: { a: true, b: false } },
]);
w("health.jsonl", [{ lines: ["缺料: 石炉 3 台"] }]);
// 蓝图预览入口: 大脑 ./bp show / build 过的蓝图 (bp.ts 记的), 右栏"蓝图"卡列出来; 短字符串的预览链接直接 #source= (不要编辑器在跑)
w("blueprints.jsonl", [{ at: new Date(now - 200_000).toISOString(), agent: "a", cmd: "build", no: 3, label: "冶炼列 24 炉 (石炉)", source: "生成", w: 30, h: 12, bp: "0eNqrVkrKKU0tLMlMzVWyqlYqSs0pzSlKzEsFCVbHKKUmZ6TmFSeWlWakpiSWA0SrlWqB" }]);
// 看门狗 / 死亡 (M6 2026-11-04): 右栏"看门狗"卡; 本班死亡 0 (不然顶部会出死亡警报, 下面别的检查会被它挡)
w("watchdog.json", { at: new Date(now - 5_000).toISOString(), recoveries: 1, failed: 0, downtimeS: 80, downtimeShare: 0.015, down: false, downS: 0, last: { at: new Date(now - 300_000).toISOString(), reason: "服务器进程退出", save: "_autosave1", saveAgeS: 112, ok: true, downS: 60 }, deaths: 0, deathsTotal: 3, lastDeathAt: null, autoResearch: 2 });
// 大脑接口警报: alerts.jsonl 一条 → 打开界面就弹
w("alerts.jsonl", [{ at: new Date(now - 900_000).toISOString(), agent: "b", name: "Gpt-6.1-Terra", brain: "relay", model: "gpt-6.1-terra", kind: "probe", text: "API Error: 400 Unsupported parameter: metadata (request id: smoke)" }]);
// 开班扫描: run.ts 开班写的 world-scan.json → 右栏最上面
w("world-scan.json", { at: new Date(now - 600_000).toISOString(), stage: "绿瓶阶段", summary: "绿瓶阶段; 红 2.6 / 绿 8.3 / 蓝 0.0 每分钟", lines: ["游戏时间 13 小时 1 分; 已研究 70 项", "近 10 分钟每分钟产量: 红 2.6 / 绿 8.3 / 蓝 0.0"],
  judgement: ["阶段: 绿瓶阶段", "研究中心一半以上停着 (2/11): 科技包没送够"], plan: ["先修 1: 缺燃料: 锅炉 2 台", "目标 (下一档): 红瓶 30 / 绿瓶 30 每分钟", "分工建议 (2 人): 管理员: 先修; 角色 2: 科研链"] });
w("turn-a-1.jsonl", [
  { type: "assistant", timestamp: t(0), message: { content: [{ type: "text", text: "先把**铁板线**接上" }, { type: "tool_use", name: "Bash", input: { command: "./fh call status", description: "看状态" } }] } },
  { type: "user", timestamp: t(2), message: { content: [{ type: "tool_result", content: "tick: 1" }] } },
  { type: "assistant", timestamp: t(3), message: { content: [{ type: "tool_use", name: "Bash", input: { command: "./fh call build", description: "放石炉" } }] } },
  { type: "user", timestamp: t(4), message: { content: [{ type: "tool_result", is_error: true, content: "Exit code 1\nerror: out of reach" }] } },
]);
w("turn-b-1.jsonl", [
  { type: "system", subtype: "init", model: "claude-sonnet-5-5" },
  { type: "assistant", timestamp: t(1), message: { content: [{ type: "text", text: "B 去补蓝瓶" }, { type: "tool_use", name: "Bash", input: { command: `./fh call operator --args '{"text":"要不要拆掉旧的石炉?"}'`, description: "问操作员" } }] } },
]);
// 第二次找操作员, 列了选项 (简报要求一行一个): 卡片上每个选项一个按钮
w("turn-b-2.jsonl", [
  { type: "assistant", timestamp: t(5), message: { content: [{ type: "tool_use", name: "Bash", input: { command: `./fh call operator --args '${JSON.stringify({ text: "先修哪条?\n1. 铜列煤道\n2. 蓝瓶线" })}'`, description: "问操作员" } }] } },
]);
// 中文名: 从本机导出的原型数据拷两份 (没有就按内部名核对)
const realProto = process.env.LAB_DATA_DIR ? path.join(process.env.LAB_DATA_DIR, "prototypes") : null;
const protoDir = realProto && fs.existsSync(realProto) ? fs.readdirSync(realProto).map((d) => path.join(realProto, d, "locale", "zh-CN")).find((d) => fs.existsSync(d)) : null;
let researchZh = "automation-2";
if (protoDir) {
  const to = path.join(tmp, "lab", "prototypes", "smoke", "locale", "zh-CN");
  fs.mkdirSync(to, { recursive: true });
  for (const f of ["technology-locale.json", "item-locale.json"]) fs.copyFileSync(path.join(protoDir, f), path.join(to, f));
  researchZh = JSON.parse(fs.readFileSync(path.join(to, "technology-locale.json"), "utf8")).names["automation-2"] ?? researchZh;
}
// 假 ./fh: 只回显参数
for (const id of ["a", "b"]) {
  const d = path.join(tmp, "brain", CUR, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "fh"), "#!/usr/bin/env bash\necho \"假 fh 收到: $*\"\n", { mode: 0o755 });
}

// ── 起控制接口和界面 ──
const procs = [];
const control = spawn(process.execPath, ["src/play/control.ts"], { cwd: REPO, env: { ...process.env, LAB_DATA_DIR: path.join(tmp, "lab"), BRAIN_DIR: path.join(tmp, "brain") }, stdio: "ignore", windowsHide: true });
procs.push(control);
for (let i = 0; i < 40 && !(await portOpen(4330)); i++) await sleep(250);
fs.rmSync(path.join(os.tmpdir(), "factorio-pilot-gui-smoke"), { recursive: true, force: true }); // 从没选过主题、没存过记录开始
// LAB_DATA_DIR 一定要给: 关界面 = 停班 (外壳写 STOP), 不给就会读真的 lab-data, 冒烟关窗口时把真在跑的那一班停掉
const app = spawn(EXE, [], { env: { ...process.env, FP_GUI_DEBUG_PORT: String(DBG), LAB_DATA_DIR: path.join(tmp, "lab"), BRAIN_DIR: path.join(tmp, "brain") }, stdio: "ignore" });
procs.push(app);

let ws;
/** 发关窗口消息 (taskkill 不带 /F, 和点右上角 × 一样), 等界面退出 */
const closeApp = (p) => new Promise((r) => {
  if (p.exitCode !== null) return r(true);
  const t = setTimeout(() => r(false), 15_000);
  p.once("exit", () => { clearTimeout(t); r(true); });
  spawn("taskkill", ["/PID", String(p.pid)], { stdio: "ignore", windowsHide: true });
});
try {
  let seq = 0;
  const waiting = new Map();
  /** 连界面页面的调试端口 (界面重开后再连一次) */
  const connect = async () => {
    let page;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(500);
      try { page = (await (await fetch(`http://127.0.0.1:${DBG}/json`)).json()).find((p) => p.type === "page" && /tauri\.localhost/.test(p.url)); } catch { /* 还没起来 */ }
    }
    if (!page) throw new Error("界面的调试端口没起来");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("连不上调试端口")); });
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  };
  await connect();
  const send = (method, params = {}) => new Promise((r) => { const i = ++seq; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => { const m = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); return m.result?.result?.value; };
  const until = async (expr, ms = 15_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(250); } return false; };
  const text = () => js("document.body.innerText");
  // 左栏的行按 data-id 找 (头像换成厂商 LOGO 后不再写字母): "A" → a, "队" → 全队
  const pick = (label) => js(`document.querySelector('.sidebar-item[data-id="${label === "队" ? "全队" : label.toLowerCase()}"]')?.click() ?? 'none'`);
  const type = async (s) => {
    await js(`(() => { const ta = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(s)}); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(150);
    await js(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  };
  const theme = () => js("document.documentElement.dataset.theme");
  const choose = async (label) => {
    await js(`document.querySelector('.account-button').click()`);
    await until("!!document.querySelector('.segmented')");
    await js(`[...document.querySelectorAll('.segmented button')].find((b) => b.innerText === ${JSON.stringify(label)}).click()`);
    await sleep(300);
    const note = await js("document.querySelector('.settings-note')?.innerText");
    if (label === "亮色") await shot("0-外观设置.png");
    await js(`document.querySelector('.modal-buttons .primary').click()`);
    return note;
  };
  // 页面上实际画出来的颜色 (不是配色表): 角标、失败红字、状态圆点、次要文字对它们背后的底色
  const measure = () => js(`(() => {
    const lum = (c) => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const clear = (c) => !c || c === 'transparent' || /rgba\\(.*,\\s*0\\)$/.test(c);
    const bgOf = (el) => { for (; el; el = el.parentElement) { const c = getComputedStyle(el).backgroundColor; if (!clear(c)) return c; } return getComputedStyle(document.body).backgroundColor; };
    const out = [];
    const add = (what, fg, bg, min) => out.push({ what, r: +ratio(fg, bg).toFixed(2), min });
    document.querySelectorAll('.sidebar-badge').forEach((e) => add('角标', getComputedStyle(e).color, getComputedStyle(e).backgroundColor, 4.5));
    document.querySelectorAll('.steps-fail, .you-status.bad').forEach((e) => add('失败红字', getComputedStyle(e).color, bgOf(e), 4.5));
    document.querySelectorAll('.steps-list li.failed .step-out').forEach((e) => add('失败输出', getComputedStyle(e).color, bgOf(e), 4.5));
    document.querySelectorAll('.avatar[data-state]').forEach((e) => { const a = getComputedStyle(e, '::after'); if (a.display !== 'none') add('状态圆点', a.backgroundColor, bgOf(e.parentElement), 3); });
    document.querySelectorAll('.sidebar-preview, .sidebar-sub, .row-time, .steps-meta, .stat-label, .composer-hint').forEach((e) => add('次要文字', getComputedStyle(e).color, bgOf(e), 4.5));
    return out;
  })()`);
  const contrastOk = async (label) => {
    const m = await measure();
    const kinds = new Set(m.map((x) => x.what));
    const bad = m.filter((x) => x.r < x.min);
    const low = (k) => Math.min(...m.filter((x) => x.what === k).map((x) => x.r));
    check(bad.length === 0 && ["角标", "失败红字", "失败输出", "状态圆点", "次要文字"].every((k) => kinds.has(k)),
      `${label}: 画出来的对比度都够 (最低: 角标 ${low("角标")}、失败红字 ${low("失败红字")}、失败输出 ${low("失败输出")}、状态圆点 ${low("状态圆点")}、次要文字 ${low("次要文字")})${bad.length ? ` 不够: ${JSON.stringify(bad.slice(0, 3))}` : ""}`);
  };
  const shot = async (name) => { const m = await send("Page.captureScreenshot", { format: "png" }); fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(m.result.data, "base64")); };

  check(await until("document.body.innerText.includes('研究中心在工作')"), "连上控制接口, 右栏有读数");
  // 大脑接口警报弹窗: 假班次有一条 alerts.jsonl → 一打开就弹, 点"知道了"消失并记成看过
  check(await until("!!document.querySelector('[data-alerts]') && (document.querySelector('.modal-title')?.innerText ?? '').includes('大脑接口不通') && document.querySelector('[data-alerts]').innerText.includes('Gpt-6.1-Terra') && document.querySelector('[data-alerts]').innerText.includes('Unsupported parameter')", 15_000),
    "大脑接口警报: 一打开就弹窗, 写着哪个模型走中转试通失败和原文");
  await js(`[...document.querySelectorAll('.modal-buttons button')].find((b) => b.innerText === '知道了').click()`);
  check(await until("!document.querySelector('[data-alerts]')", 10_000) && JSON.parse(await js("localStorage.getItem('fp-gui:alerts-seen') ?? '[]'")).length === 1, "点知道了: 弹窗关掉, 记成看过 (再开不再弹)");
  const body = await text();
  check(body.includes(researchZh) && body.includes("已研究 41 项"), `正在研究显示官方中文名 "${researchZh}"、已研究 41 项`);
  check(/9\s*\/\s*11/.test(body), "研究中心 9 / 11");
  check(await js("[...document.querySelectorAll('.rate-value')].map((e) => e.innerText.replace(/\\s/g, '')).join(' ')") === "15个/分 8.0个/分 2.0个/分", "近 10 分钟每分钟: 红瓶 15、绿瓶 8.0、蓝瓶 2.0");
  // 复盘在读数之后才读 (每 6 次刷新一次), 等它出现, 不拿上面那一次的文字判断 (11-03 开账号页后慢了一点, 截早了一次)
  check(await until("document.body.innerText.includes('先把绿瓶的线补上') && document.body.innerText.includes('上一班复盘')"), "上一班复盘的先修这几条");
  check(body.includes("缺料: 石炉 3 台"), "体检");
  check(body.includes("停机 80 秒 (2%)") && body.includes("恢复 1 次") && body.includes("服务器进程退出 → _autosave1"), "看门狗卡: 停机 80 秒 (2%)、恢复 1 次、最近一次 服务器进程退出 → _autosave1");
  check(await until("!!document.querySelector('[data-scan]') && document.querySelector('[data-scan]').innerText.includes('绿瓶阶段') && document.querySelector('[data-scan]').innerText.includes('先修 1: 缺燃料') && document.querySelector('[data-scan]').innerText.includes('分工建议')", 15_000),
    "开班扫描卡: 阶段、先修、下一档目标、分工建议");
  check(body.includes("死亡 0 次 · 这个世界累计 3") && body.includes("自动排研究 2 次"), "看门狗卡: 死亡 0 次 (累计 3)、自动排研究 2 次");
  // 蓝图卡是另一次请求 (/api/blueprints) 画的, 比读数晚一点: 等它出现, 不拿上面那次的快照判断 (11-04 第三次冒烟时快照里还没有, 误报一次)
  check(await until("document.body.innerText.includes('冶炼列 24 炉 (石炉)') && document.body.innerText.includes('打开编辑器') && document.body.innerText.includes('预览')", 15_000), "蓝图卡: 列出这一班用过的蓝图, 有\"打开编辑器\"和\"预览\"");
  const bps = await (await fetch("http://127.0.0.1:4330/api/blueprints")).json();
  check(bps.blueprints?.length === 1 && String(bps.blueprints[0].link).includes("#source=0eNqr") && String(bps.editor).startsWith("http"), "/api/blueprints 给预览链接 (#source=) 和编辑器地址");
  const bad = await fetch("http://127.0.0.1:4330/api/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }) });
  check(bad.status === 400, "/api/open 只许编辑器自己的地址 (别的 400)");
  check(await until("document.querySelector('.sidebar-item[data-id=b] .sidebar-badge')?.innerText === '2'"), "左栏 B 有等你的角标 2 (找了操作员两次)");
  // 聊天室: 头像是厂商 LOGO、右栏群公告 + 在线成员
  check(await until("['a', 'b'].every((id) => { const i = document.querySelector(`.sidebar-item[data-id=${id}] .avatar img`); return i && i.alt === 'Claude' && i.complete && i.naturalWidth > 0; })"),
    "左栏两个角色的头像是 Claude 的 LOGO (图片读到了)");
  check(await js("document.querySelector('.panel-section.notice')?.innerText.includes('群公告') && document.querySelector('.panel-section.notice').innerText.includes('先把绿瓶的线补上')"), "右栏最上面是群公告: 上一班复盘先修这几条");
  const members = await js("[...document.querySelectorAll('.member-row')].map((r) => r.querySelector('.member-name').innerText + '|' + (r.querySelector('.member-tag')?.innerText ?? ''))");
  check(members.join(" / ") === "Claude Opus 5.5|在干活 / Claude Sonnet 5.5|等你 / 我 · 管理员|在线" && await js("[...document.querySelectorAll('.panel-section-title')].some((t) => t.innerText.startsWith('在线成员 3'))"),
    `在线成员 3: ${members.join(" / ")}`);
  await js(`document.querySelector('.member-row[data-id=b]').click()`);
  check(await until("document.querySelector('.thread-name')?.innerText === 'Claude Sonnet 5.5'"), "点在线成员里的 Claude Sonnet: 打开和它的单聊 (角色名 = 模型名, 不带 A / B)");
  // 下一班名单 = 多选框列表: 编辑名单 → 勾 测试班 并点 + 到 2 个 → 保存 = 下一班多两个角色 (存 lineup.json), 列在成员下面标"待开班"; 移出 → 少一个
  const lineupFile = path.join(tmp, "lab", "accounts", "lineup.json");
  await js(`document.querySelector('[data-edit-members]').click()`);
  check(await until("!!document.querySelector('[data-member-editor]') && [...document.querySelectorAll('[data-member-editor] .member-group-title')].length >= 5 && [...document.querySelectorAll('[data-member-editor] input[type=checkbox]')].length >= 8", 10_000),
    "编辑名单: 多选框列表按来源分组 (Claude 官方档位 / GPT / Grok / DeepSeek / 中转站 / 测试)");
  check(await js("[...document.querySelectorAll('[data-member-editor] .member-group-title')].map((e) => e.innerText).join('|')").then((s) => s.includes("Claude (官方订阅") && s.includes("GPT (官方订阅")), "列表里有 Claude 和 GPT 两家官方订阅");
  await js(`document.querySelector('[data-member-option="none"] input').click()`);
  await js(`document.querySelector('[data-member-option="none"] .member-count button[aria-label="多一个"]').click()`);
  check(await js("document.querySelector('[data-member-option=\"none\"] [data-count]')?.innerText === '2' && /\\(\\d+ 个角色\\)/.test(document.querySelector('[data-member-save]').innerText) && !document.querySelector('[data-member-save]').innerText.includes('管理员')"), "勾上测试班并点 +: 个数 2, 保存按钮只写几个角色 (沙盘窗口只看, 不算管理员一席)");
  await js(`document.querySelector('[data-member-save]').click()`);
  // 沙盘全是服务器角色, 窗口只看: 名单列全部, 我那行不选模型, 也没有"控制我的账号"
  check(await until("[...document.querySelectorAll('[data-next-list] .member-next .member-name')].filter((t) => t.innerText === '测试班 (不叫大脑)').length === 2", 15_000)
    && await js("[...document.querySelectorAll('.member-next .member-tag')].every((e) => e.innerText === '待开班') && document.querySelector('[data-observer]')?.innerText.includes('不占角色') && !document.querySelector('.admin-select') && !document.querySelector('.member-row.me .effort-select') && ![...document.querySelectorAll('.member-next button')].some((b) => b.innerText === '控制我的账号') && document.querySelectorAll('.member-row').length === 3"),
    "保存: 名单 (和本班在线分开) 列全部角色都是待开班, 我那行写着只看不占角色, 没有模型下拉和控制我的账号");
  const seatsAfter = JSON.parse(fs.readFileSync(lineupFile, "utf8")).seats.length;
  check(seatsAfter >= 2, `lineup.json 存了 ${seatsAfter} 个角色`);
  const nextCount = () => js("document.querySelectorAll('.member-next').length");
  const before = await nextCount();
  await js(`[...document.querySelectorAll('.member-next')].at(-1).querySelector('.danger-link').click()`);
  check(await until(`document.querySelectorAll('.member-next').length === ${before - 1}`, 15_000) && JSON.parse(fs.readFileSync(lineupFile, "utf8")).seats.length === seatsAfter - 1, "移出一个: 少一个待开班, 文件同步");
  // 强度: 名单第 1 行选"高" → lineup.json 记 effort
  await js(`(() => { const s = document.querySelector('.member-next[data-next="0"] .effort-select'); s.value = 'high'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check(await (async () => { const end = Date.now() + 10_000; while (Date.now() < end) { try { if (JSON.parse(fs.readFileSync(lineupFile, "utf8")).seats[0].effort === "high") return true; } catch { /* 还没写 */ } await sleep(200); } return false; })(),
    "名单第 1 个选强度 高: lineup.json 第 1 个角色 effort = high");
  await pick("队");
  const rowsText = await js("[...document.querySelectorAll('.sidebar-item')].map((b) => b.querySelector('.sidebar-title').innerText + '|' + (b.querySelector('.sidebar-sub')?.innerText ?? '')).join(' / ')");
  check(rowsText === "全队| / Claude Opus 5.5|游戏里: MK / Claude Sonnet 5.5|游戏里: ai2", `左栏: 模型名, 游戏里的名字作小字 (新会话文件读 name / model, 旧的模型从轮次文件读、名字用 bot 名): ${rowsText}`);
  check(!(await text()).includes("Factorio Pilot"), "界面里不再写 Factorio Pilot (标题栏已经有了)");
  // 按世界分: 左上角写世界名; 点开列出这个世界的两班和状态; 收起只放标记、能放出来
  check(await until("document.querySelector('.world-name')?.innerText === '沙盘 · 冒烟测试'"), "左上角写着这一班的世界: 沙盘 · 冒烟测试");
  await js(`document.querySelector('.world-button').click()`);
  await until("document.querySelectorAll('.world-run[data-run^=\"2000\"]').length === 2");
  const runRows = await js("[...document.querySelectorAll('.world-run[data-run^=\"2000\"]')].map((b) => b.dataset.run.slice(11) + ':' + b.querySelector('.world-run-state').innerText).join(' ')");
  check(runRows === "01-00-00:在跑 00-00-00:收尾了", `世界下面列出两班, 新的在前: ${runRows}`);
  await shot("7-世界和班次.png");
  // 世界标题自己改: 组头"改名" → 输入 → 回车; 组头和左上角都变, 存在 play/world-names.json, world.json 不动
  await js(`document.querySelector('.world-group[data-world="sandbox-smoke"] .world-rename-button').click()`);
  await until("!!document.querySelector('.world-rename')");
  await js(`(() => { const el = document.querySelector('.world-rename'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '冒烟测试 · 假数据 · 别点, 会自动关'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  check(await until("document.querySelector('.world-group[data-world=\"sandbox-smoke\"] .world-group-title')?.innerText === '冒烟测试 · 假数据 · 别点, 会自动关'") && await until("document.querySelector('.world-name')?.innerText === '冒烟测试 · 假数据 · 别点, 会自动关'"),
    "改名: 组头和左上角都变成 冒烟测试 · 假数据 · 别点, 会自动关");
  const names = JSON.parse(fs.readFileSync(path.join(tmp, "lab", "play", "world-names.json"), "utf8"));
  check(names["sandbox-smoke"] === "冒烟测试 · 假数据 · 别点, 会自动关" && JSON.parse(fs.readFileSync(path.join(runs, CUR, "world.json"), "utf8")).name === "沙盘 · 冒烟测试", "改名只写 world-names.json, 班次的 world.json 不动");
  await js(`document.querySelector('.world-run[data-run="${PREV}"]').parentElement.querySelector('.world-run-actions .link-button').click()`);
  // 界面先即时把那行拿掉再调接口, 标记文件稍后才写: 等到它出现 (最多 5 秒)
  const marked = async () => { const end = Date.now() + 5000; while (Date.now() < end) { if (fs.existsSync(path.join(runs, PREV, "hidden"))) return true; await sleep(100); } return false; };
  check(await until(`!document.querySelector('.world-run[data-run="${PREV}"]')`) && await marked() && fs.existsSync(path.join(runs, PREV, "review.json")),
    "移出上一班: 列表里立刻没了, 只放了 hidden 标记, 记录还在");
  await js(`[...document.querySelectorAll('.world-toggle')].at(0)?.click()`);
  await until(`!!document.querySelector('.world-run[data-run="${PREV}"]')`);
  await js(`document.querySelector('.world-run[data-run="${PREV}"]').parentElement.querySelector('.world-run-actions .link-button').click()`);
  for (let i = 0; i < 20 && fs.existsSync(path.join(runs, PREV, "hidden")); i++) await sleep(200);
  check(!fs.existsSync(path.join(runs, PREV, "hidden")), "显示收起的 → 放出: 标记删了");
  // 彻底删对话记录: 点两次确认 → 上一班的 turn / requests / monitor 没了, summary / review 还在, 并标记收起
  await js(`document.querySelector('[data-purge="${PREV}"]').click()`);
  check(await until(`!!document.querySelector('[data-purge-yes="${PREV}"]')`), "删对话记录: 先问一次确认");
  await js(`document.querySelector('[data-purge-yes="${PREV}"]').click()`);
  check(await (async () => { const end = Date.now() + 10_000; while (Date.now() < end) { if (!fs.existsSync(path.join(runs, PREV, "turn-a-1.jsonl")) && fs.existsSync(path.join(runs, PREV, "hidden"))) return true; await sleep(200); } return false; })()
    && !fs.existsSync(path.join(runs, PREV, "requests.jsonl")) && !fs.existsSync(path.join(runs, PREV, "monitor.jsonl")) && fs.existsSync(path.join(runs, PREV, "summary.json")) && fs.existsSync(path.join(runs, PREV, "review.json")) && fs.existsSync(path.join(runs, PREV, "world.json")),
    "确认后: 对话 / 请求 / 读数记录删了, summary / review / world.json 留着, 这一班标记收起");
  //  (开着"显示已收起的"时删过的行还在): 删过的班从列表里彻底消失, 开着"显示已收起的"也不列
  check(await until(`!document.querySelector('.world-run[data-run="${PREV}"]')`, 10_000) && fs.existsSync(path.join(runs, PREV, "purged")), "删完从列表里彻底消失 (purged 标记; 开着\"显示已收起的\"也不列)");
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  const sysDark = await js("matchMedia('(prefers-color-scheme: dark)').matches");
  const first = [await theme(), await js("localStorage.getItem('fp-gui:theme')")];
  check(first[0] === (sysDark ? "dark" : "light") && [null, "system"].includes(first[1]), `没选过时跟随 Windows (现在系统是${sysDark ? "深色" : "亮色"}; 界面是 ${first[0]}, 存的是 ${first[1]})`);
  const lightNote = await choose("亮色");
  check(await theme() === "light" && await js("getComputedStyle(document.body).backgroundColor") === "rgb(252, 252, 252)" && await js("localStorage.getItem('fp-gui:theme')") === "light" && lightNote?.startsWith("现在: 亮色"),
    "账号 · 设置里选亮色: 马上换成亮色, 并记住");
  check(await js("document.querySelector('.sidebar-item[data-id=a] .avatar')?.dataset.state === '在干活'"), "左栏 A 的圆点是在干活");

  await pick("A");
  check(await until("document.querySelector('.thread-name')?.innerText === 'Claude Opus 5.5' && document.body.innerText.includes('干了 2 步')"), "选 A: 标题是 \"Claude Opus 5.5\", 两条命令折成 \"干了 2 步\"");
  check((await js("document.querySelector('.thread-role')?.innerText"))?.startsWith("游戏里叫 MK"), "对话标题旁写着游戏里的名字 MK");
  check((await text()).includes("1 步失败"), "折叠行写着 1 步失败");
  await js(`[...document.querySelectorAll('.steps-toggle')].at(-1).click()`);
  check(await until("document.body.innerText.includes('./fh call status') && document.body.innerText.includes('tick: 1') && document.body.innerText.includes('看状态')"), "点开: 每一步的说明、命令、结果");
  check(await js("!!document.querySelector('.markdown strong')"), "大脑的话按 Markdown 显示 (加粗)");
  // 展开之后, 刷新 (每 5 秒) 不能把它收回去: 记下 .steps-list 消失过几次、当时页面在干什么
  await js(`window.__gone = []; new MutationObserver(() => { if (!document.querySelector('.steps-list') && window.__gone.length < 5) window.__gone.push({ t: Date.now(), name: document.querySelector('.thread-name')?.innerText, rows: document.querySelectorAll('.thread-scroll .row').length, empty: !!document.querySelector('.thread-empty'), banner: document.querySelector('.banner')?.innerText ?? null }); }).observe(document.body, { childList: true, subtree: true })`);

  await type("/call status");
  check(await until("[...document.querySelectorAll('.cmd-out')].some((e) => e.innerText.includes('假 fh 收到: call status'))", 20_000), "输入 /call status → 用 A 执行 ./fh call status, 结果显示在对话里");
  await type("多造几台石炉");
  check(await until("[...document.querySelectorAll('.you-status')].some((e) => e.innerText.includes('没送到'))", 30_000), "打字 = 对 A 说话; 游戏没开 (RCON 关着) 时显示没送到和原因");
  const chat = await js(`(() => {
    // 你连着说的几句只有第一句放头像 (和 QQ 一样), 看这一段的第一句
    const you = [...document.querySelectorAll('.row.you.start')].at(-1), ai = document.querySelector('.row.start[data-agent=a]');
    const r = you?.querySelector('.row-main > .bubble, .row-main > .cmd-card')?.getBoundingClientRect(), s = document.querySelector('.thread-scroll').getBoundingClientRect();
    return { dir: you && getComputedStyle(you).flexDirection, me: you?.querySelector('.avatar.me')?.innerText, gapRight: r ? Math.round(s.right - r.right) : null, gapLeft: r ? Math.round(r.left - s.left) : null, aiLogo: ai?.querySelector('.avatar img')?.alt };
  })()`);
  check(chat.dir === "row-reverse" && chat.me === "我" && chat.gapRight < chat.gapLeft && chat.aiLogo === "Claude", `聊天室: 你说的话靠右、头像"我"; 大脑说的靠左、头像是 LOGO (${JSON.stringify(chat)})`);
  await shot("1-角色A-亮色.png");
  const gone = await js("JSON.stringify(window.__gone)");
  check(gone === "[]", `展开的"干了 N 步"在刷新、执行命令、发话之后还开着${gone === "[]" ? "" : ` (被收起: ${gone})`}`);
  if (gone !== "[]") await js(`[...document.querySelectorAll('.steps-toggle')].at(-1).click()`);
  await contrastOk("亮色");
  await choose("深色");
  check(await theme() === "dark" && await js("getComputedStyle(document.body).backgroundColor") === "rgb(13, 13, 13)", "选深色: 马上换成深色");
  await contrastOk("深色");
  await shot("1-角色A-深色.png");
  await send("Page.reload");
  await sleep(500);
  check(await until("document.body.innerText.includes('研究中心在工作')") && await theme() === "dark", "重开页面: 还是上次选的深色");
  await pick("A");
  await until("document.body.innerText.includes('干了 2 步')");
  const sysNote = await choose("跟随系统");
  check(await until(`document.documentElement.dataset.theme === (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')`) && await js("localStorage.getItem('fp-gui:theme')") === "system" && sysNote?.includes("跟随 Windows"),
    "选回跟随系统: 跟着 Windows, 设置里写着跟随 Windows");

  // 账号页: 读的是这台机器上真的三家命令行 (只查状态和额度, 不点登录: 那会真开一个登录窗口); DeepSeek / GLM / 中转站的密钥存在冒烟的临时目录
  await js(`document.querySelector('.account-button').click()`);
  check(await until("document.querySelectorAll('.account-card').length === 8", 40_000), "账号页: 八家各一张卡片 (11-04 加 Gemini / Antigravity, 11-05 加 Claude Console 密钥)");
  const cards = await js("[...document.querySelectorAll('.account-card')].map((c) => c.querySelector('.name').innerText + '|' + c.querySelector('.account-status').innerText)");
  check(cards.map((c) => c.split("|")[0]).join(",") === "Claude Code,Grok Build,Codex (GPT),Gemini (Antigravity),Claude (Console API 密钥),DeepSeek,GLM 编程套餐,中转站 (New API)" && cards.every((c) => /\|(已登录|本机没装|装了|没填密钥)/.test(c)), `八家的状态: ${cards.join(" / ")}`);
  // 中转站卡 (2026-11-04): 没填时有站点和令牌两格, 只填令牌不给地址时保存键不亮
  check(await js("(() => { const c = document.querySelector('.account-card[data-provider=relay]'); return !!c && c.querySelectorAll('.key-form input').length === 2 && !!c.querySelector('.key-form input[type=url]'); })()"), "中转站卡: 站点地址 + 令牌两个输入框");
  // 中转站本机代理: 卡里写明请求经本机小代理转发、去掉 metadata, 不用另开程序
  check(await js("document.querySelector('.account-card[data-provider=relay]').innerText.includes('本机小代理') && document.querySelector('.account-card[data-provider=relay]').innerText.includes('metadata')"), "中转站卡: 写明请求经本机小代理转发 (去掉 metadata 字段, 不用另开程序)");
  // 下一班阵容: 上面群里拉人 / 移出后剩 1 行; 加一个角色 → 2 行并存进 lineup.json; 去掉 → 回 1 行
  check(await until("document.querySelectorAll('[data-lineup] .lineup-row').length === 1", 15_000) && await js("[...document.querySelectorAll('[data-lineup] optgroup')].map((g) => g.label).join('|')").then((s) => s.includes("Claude (官方订阅") && s.includes("Claude (Console API 密钥") && s.includes("GPT (官方订阅") && s.includes("Gemini (官方") && s.includes("中转站")) && await js("!!document.querySelector('[data-lineup] .effort-select')"),
    "阵容: 默认 1 个角色, 下拉按来源分组 (Claude 订阅 / Claude Console 密钥 / GPT 官方订阅 / Gemini / Grok / DeepSeek / 中转站 / 测试), 每行带强度下拉");
  await js(`[...document.querySelectorAll('[data-lineup] button')].find((b) => b.innerText === '加一个角色').click()`);
  check(await until("document.querySelectorAll('[data-lineup] .lineup-row').length === 2", 15_000) && JSON.parse(fs.readFileSync(lineupFile, "utf8")).seats.length === 2, "阵容: 加一个角色 → 2 行, 存进 lineup.json");
  await js(`[...document.querySelectorAll('[data-lineup] button')].find((b) => b.innerText === '去掉').click()`);
  check(await until("document.querySelectorAll('[data-lineup] .lineup-row').length === 1", 15_000) && JSON.parse(fs.readFileSync(lineupFile, "utf8")).seats.length === 1, "阵容: 去掉 → 1 行, 文件同步");
  check(await js("[...document.querySelectorAll('.account-card')].every((c) => { const st = c.querySelector('.account-status').innerText; return st.startsWith('本机没装') ? !!c.querySelector('.install-line code') : st === '没填密钥' ? !!c.querySelector('.key-form input[type=password]') : !!c.querySelector('.account-actions button'); })"),
    "没装的给安装命令和复制按钮, 装了的给登录 / 重新登录按钮, 没填密钥的给密钥输入框");
  const usage = await js("[...document.querySelectorAll('.account-card .account-usage .quota-pct')].map((e) => e.innerText)");
  check(usage.every((x) => /^剩 \d+%$/.test(x)), `额度写的是剩多少: ${usage.join(", ") || "(这台机器上没读到额度)"}`);
  await shot("5-账号页.png");
  // 填一个假的 DeepSeek 密钥: 存进临时目录、立刻去查 (真的 DeepSeek 会回不认, 连不上就是没查成), 只显示末 4 位, 再删掉
  const FAKE_KEY = "sk-smoke-0000-test";
  const keysFile = path.join(tmp, "lab", "accounts", "keys.json");
  // 账号弹窗只有 Esc / 点遮罩 / 关闭按钮会关: 记下来, 失败时分得清是真人点了窗口 (isTrusted) 还是代码关的
  await js(`(() => { window.__inputLog = []; for (const t of ['mousedown', 'keydown']) window.addEventListener(t, (e) => window.__inputLog.push([t, e.key ?? '', String(e.target?.className ?? '').slice(0, 24), e.isTrusted]), true); })()`);
  await js(`(() => { const i = document.querySelector('.account-card[data-provider=deepseek] .key-form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(FAKE_KEY)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  await js(`document.querySelector('.account-card[data-provider=deepseek] .key-form .small-primary').click()`);
  const keyShown = await until("/末 4 位 test/.test(document.querySelector('.account-card[data-provider=deepseek]').innerText)", 30_000);
  const dsStatus = await js("document.querySelector('.account-card[data-provider=deepseek] .account-status').innerText");
  const apiText = await (await fetch("http://127.0.0.1:4330/api/accounts")).text();
  check(keyShown && ["密钥不对", "已填密钥 · 没查成"].includes(dsStatus) && JSON.parse(fs.readFileSync(keysFile, "utf8")).deepseek === FAKE_KEY && !apiText.includes(FAKE_KEY),
    `DeepSeek 填密钥: 存进本机文件、立刻去查 (${dsStatus})、界面只显示末 4 位, 控制接口回的东西里没有整个密钥`);
  await shot("6-填了密钥.png");
  // 这一项 11-04 时好时坏 (smoke7 / smoke11 失败, 其余过): 记下按钮找没找到、最后的状态、文件里还在不在, 下次失败能看出原因
  const delBtn = await js(`(() => { const b = [...document.querySelectorAll('.account-card[data-provider=deepseek] button')].find((b) => b.innerText === '删除'); if (!b) return 'none'; b.click(); return 'clicked'; })()`);
  const delOk = await until("document.querySelector('.account-card[data-provider=deepseek] .account-status')?.innerText === '没填密钥'", 30_000);
  const delFile = JSON.parse(fs.readFileSync(keysFile, "utf8")).deepseek === undefined;
  check(delBtn === "clicked" && delOk && delFile, `删除密钥: 文件里没了, 卡片回到没填密钥 (按钮 ${delBtn}; 状态 ${await js("document.querySelector('.account-card[data-provider=deepseek] .account-status')?.innerText ?? '?'")}; 文件里${delFile ? "没了" : "还在"}; 输入 ${await js("JSON.stringify(window.__inputLog ?? [])")})`);
  await js(`document.querySelector('.modal-buttons .primary').click()`);
  // 左下角三个按钮下面不再有小字 (以前写 "4 家能用: …" / "哪些是搬来的…" / "15 条: 以 / 开头…")
  check(await js("[...document.querySelectorAll('.sidebar-foot .account-sub')].length === 0"), "左下角按钮下面没有小字");
  // 统计 · 排行: 右栏有这一节 (冒烟的假班有没有 summary.json 都行: 有就列前 3, 没有就写"还没有跑完的班")
  const statsText = await js("document.querySelector('.stats-section')?.innerText ?? ''");
  check(/统计 · 排行/.test(statsText) && (/\/小时/.test(statsText) || /还没有跑完的班/.test(statsText)), `右栏有统计 · 排行: ${statsText.replace(/\s+/g, ' ').slice(0, 80)}`);
  const quotaNames = await js("[...document.querySelectorAll('.quota-item .quota-name')].map((n) => n.innerText).join(',')");
  check(/Claude/.test(quotaNames) && /DeepSeek/.test(quotaNames) && /GLM/.test(quotaNames), `右栏额度每家一行: ${quotaNames}`);

  await pick("B");
  check(await until("document.querySelector('.ask-card:not(.answered)')?.innerText.includes('要不要拆掉旧的石炉?')"), "选 B: 找操作员的命令显示成等你卡片");
  const cardButtons = await js("[...document.querySelectorAll('.ask-card:not(.answered)')].map((c) => [...c.querySelectorAll('.ask-button')].map((b) => b.innerText).join('|')).join(' / ')");
  check(cardButtons === "批准|不批 / 1. 铜列煤道|2. 蓝瓶线", `等你卡片的按钮: 没列选项的是批准 / 不批, 列了选项的每项一个 (${cardButtons})`);
  await shot("4-等你卡片按钮.png");
  await js(`[...document.querySelectorAll('.ask-button')].find((b) => b.innerText === '1. 铜列煤道').click()`);
  const sentOk = await until(`document.querySelectorAll('.ask-card:not(.answered)').length === 0`, 20_000);
  // 私信开头写明是管理员说的、怎么回 (control.ts tell)
  check(sentOk && told.some((x) => x.startsWith('管理员 (用户) 在界面里对你说: 选 1: 铜列煤道 (回你问的: "先修哪条?") —— 手上的事做完就回他')),
    `点 "1. 铜列煤道": 用 B 的身份发出私信 (游戏里收到 ${JSON.stringify(told)}), 两张卡片都变成已回复`);
  check(await until("!document.querySelector('.sidebar-item[data-id=b] .sidebar-badge')"), "回了之后 B 的角标没了");
  await pick("队");
  check(await until("document.body.innerText.includes('B 去补蓝瓶') && document.body.innerText.includes('铁板线')"), "全队: 两个角色的话合在一起");
  check(await js("[...document.querySelectorAll('.speaker')].some((e) => e.innerText === 'Claude Sonnet 5.5') && [...document.querySelectorAll('.speaker')].some((e) => e.innerText === 'Claude Opus 5.5')"), "全队里每句话上面写模型名");
  await type("/call status");
  check(await until("document.querySelector('.composer-hint.bad')?.innerText.includes('先在左边选一个角色')"), "全队里不能直接执行命令, 提示先选角色");
  // 群里 @ 成员: 打 @ 弹成员列表; 选一个只发给他 (B 的假游戏收到, A 的死端口不碰 → 已送到)
  await js(`(() => { const ta = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '@'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check(await until("[...document.querySelectorAll('.mention-item')].map((b) => b.dataset.member).join(',') === '全队,a,b'"), "全队输入框打 @: 弹出成员列表 (全队 / MK / ai2)");
  await js(`document.querySelector('.mention-item[data-member=b]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`);
  check(await until("document.querySelector('.composer textarea').value === '@ai2 ' && !document.querySelector('.mention-list')"), "点 ai2: 填成 \"@ai2 \", 列表收起");
  const toldBefore = told.length;
  await type("@ai2 你在做什么");
  // 送到了就不显示状态 (Thread.tsx 只在发送中 / 没送到时放 .you-status): 看最后一条你说的话下面没有状态行
  check(await until("(() => { const last = [...document.querySelectorAll('.row.you')].at(-1); return !!last && last.innerText.includes('@ai2 你在做什么') && !last.querySelector('.you-status:not([data-reply-line])'); })()", 20_000) && told.length === toldBefore + 1 && told.at(-1).startsWith("管理员 (用户) 在界面里对你说: @ai2 你在做什么 —— 手上的事做完就回他"),
    `@ai2 只发给 B (B 的游戏收到 1 条、开头写明是管理员说的; A 的死端口没碰 → 已送到): ${JSON.stringify(told.at(-1)).slice(0, 80)}`);
  // : 你说的话下面显示送达和谁回了 (/api/state.replies)
  check(await until("(() => { const last = [...document.querySelectorAll('.row.you')].at(-1); return !!last?.querySelector('[data-reply-line]') && last.querySelector('[data-reply-line]').innerText.includes('已送达') && last.querySelector('[data-reply-line]').innerText.includes('还在忙'); })()", 15_000),
    "你说的话下面显示已送达、还在忙");
  await type("@没有的人 你好");
  check(await until("document.body.innerText.includes('群里没有叫 @没有的人 的成员')") && told.length === toldBefore + 1, "@ 不存在的成员: 不发, 提示群里没有这个成员");

  // 中途加人 / 移出: 这一班开了信箱 (roster.jsonl) → 成员行有"移出", 编辑名单保存 = 马上生效
  const rosterFile = path.join(cur, "roster.jsonl");
  const rosterOps = () => { try { return fs.readFileSync(rosterFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  check(await js("!document.querySelector('[data-leave]')"), "这一班没开信箱: 成员行没有移出按钮");
  fs.writeFileSync(rosterFile, "");
  check(await until("!!document.querySelector('[data-leave=\"b\"]') && !document.querySelector('[data-leave=\"a\"]')", 15_000), "开了信箱: B 有移出, A (玩家的身体) 没有");
  await js(`document.querySelector('[data-edit-members]').click()`);
  await until("!!document.querySelector('[data-member-option=\"none\"] input')", 10_000);
  await js(`document.querySelector('[data-member-option="none"] input').click()`);
  await js(`document.querySelector('[data-member-save]').click()`);
  let joined = false;
  for (let i = 0; i < 40 && !joined; i++) { await sleep(250); joined = rosterOps().some((o) => o.op === "join" && o.seat?.brain === "none"); }
  check(joined, "在跑时保存名单: 新勾的记进 roster.jsonl (join)");
  await js(`document.querySelector('[data-leave="b"]').click()`);
  let leftOp = false;
  for (let i = 0; i < 40 && !leftOp; i++) { await sleep(250); leftOp = rosterOps().some((o) => o.op === "leave" && o.agent === "b"); }
  check(leftOp, "点移出: 记进 roster.jsonl (leave)");
  fs.rmSync(rosterFile, { force: true });
  await until("!document.querySelector('[data-leave]')", 15_000);

  await js(`[...document.querySelectorAll('button')].find((b) => b.innerText.includes('停班'))?.click()`);
  check(await until("document.querySelector('.modal')?.innerText.includes('存档收尾?')"), "停班先弹确认");
  await shot("2-停班确认.png");
  await js(`[...document.querySelectorAll('.modal button')].find((b) => b.innerText.includes('存档收尾'))?.click()`);
  const stopped = await until("document.querySelector('.panel-run')?.innerText === '正在收尾'");
  check(stopped && fs.existsSync(path.join(cur, "STOP")), "确认后控制接口放了 STOP 文件, 右栏显示正在收尾");

  fs.writeFileSync(path.join(cur, "summary.json"), "{}");
  check(await until("document.querySelector('.banner')?.innerText.startsWith('没有在跑 · 下面是最近一班') && document.querySelector('.composer textarea').disabled", 15_000), "这一班结束后: 提示没有在跑、输入框不能用, 记录还在");
  check(await until("!document.querySelector('.sidebar-badge') && document.querySelector('.stop-button').disabled && document.querySelector('.stop-button').innerText.startsWith('停班')"), "结束后不挂等你角标, 停班按钮灰掉");
  await shot("3-没有在跑.png");

  // ── 界面自己起控制接口: 关掉界面和冒烟起的控制接口, 不起控制接口直接开界面 (带上假记录的目录, 它起的控制接口会继承) ──
  ws.close();
  // 关界面也要停用户账号那一局 (它不走班次, 外壳按 mk-current.json 找)
  const mkPlay = path.join(tmp, "lab", "play"), mkRun = path.join(mkPlay, "online", "mk-smoke");
  fs.mkdirSync(mkRun, { recursive: true });
  fs.writeFileSync(path.join(mkPlay, "mk-current.json"), JSON.stringify({ runId: "mk-smoke", runDir: mkRun, pid: process.pid, startedAt: "x", brain: "none", effort: "low", minutes: 5 }));
  check(await closeApp(app), "关界面 (关窗口消息, 和点 × 一样): 界面退出");
  check(fs.existsSync(path.join(mkRun, "STOP")), "关界面: 用户账号那一局也收到 STOP");
  fs.rmSync(path.join(mkPlay, "mk-current.json"));
  control.kill();
  for (let i = 0; i < 40 && (await portOpen(4330)); i++) await sleep(250);
  await sleep(1500); // 等 WebView2 的子进程退干净 (同一个数据目录)
  const app2 = spawn(EXE, [], { env: { ...process.env, FP_GUI_DEBUG_PORT: String(DBG), LAB_DATA_DIR: path.join(tmp, "lab"), BRAIN_DIR: path.join(tmp, "brain") }, stdio: "ignore" });
  procs.push(app2);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(500); up = await portOpen(4330); }
  check(up, "4330 没人听时, 界面自己起了控制接口");
  await connect();
  // 重开时没有在跑 → 空对话: 连上的证据是没有"连不上"横幅且右栏有成员 / 空对话说明
  check(await until("!document.querySelector('.banner.down') && (!!document.querySelector('[data-landing-note]') || document.body.innerText.includes('研究中心在工作'))", 30_000), "界面连上自己起的控制接口 (没有连不上的横幅, 右栏是空对话说明或读数)");
  // 打开时没有在跑的班: 中间是空的, 顶上一行上一班的记录 → 查看
  check(await until("document.querySelector('.thread-empty')?.innerText.startsWith('空对话') && document.querySelector('.banner')?.innerText.includes('没有在跑 · 上一班') && document.querySelector('.world-name')?.innerText === '空对话'"),
    "重开界面、没有在跑: 空对话, 顶上写着上一班的记录");
  check(await js("[...document.querySelectorAll('.sidebar-preview')].every((e) => e.innerText === '还没有说过话')"), "空对话时左栏每行的最后一句也不带旧记录");
  // : 空对话时左栏只有全队, 右栏不显示上一班的读数 / 体检 / 公告, 标题写空对话
  check(await js("document.querySelectorAll('.sidebar-item').length === 1 && !!document.querySelector('[data-landing-note]') && ![...document.querySelectorAll('.panel-section-title')].some((t) => /^(游戏读数|体检|群公告)/.test(t.innerText)) && document.querySelector('.thread-name')?.innerText === '空对话'"),
    "空对话: 左栏只剩全队, 右栏没有上一班的读数 / 体检 / 公告, 标题是空对话");
  await shot("8-空对话.png");
  // 新建对话 = 新建一个群: 左上角菜单 "+ 新建对话" → 名字 → 创建 → 群出现在世界列表 (还没开过班) → 进群: 右栏群卡 + 开班按钮, 名单是这个群的
  await js(`document.querySelector('.world-button').click()`);
  check(await until("!!document.querySelector('[data-new-group]')", 10_000), "世界菜单最上面有 + 新建对话");
  await js(`document.querySelector('[data-new-group]').click()`);
  check(await until("!!document.querySelector('[data-new-group-modal]')", 10_000), "新建对话弹窗打开");
  // 联机服务器才有"读没探过的地方", 默认关
  check(!(await js(`!!document.querySelector('[data-group-reveal]')`)), "新地图的群没有这个选项");
  await js(`[...document.querySelectorAll('[data-new-group-modal] [role=radio]')].find((b) => b.textContent.includes('联机')).click()`);
  check(await until("!!document.querySelector('[data-group-reveal]') && !document.querySelector('[data-group-reveal]').checked", 5_000), "联机服务器的群有这个选项, 默认关");
  // 走哪条路: 默认自动; 选内存外挂就不用填 RCON
  const pickOption = (sel, value) => `(() => { const s = document.querySelector('${sel}'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${value}'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`;
  check(await js(`document.querySelector('[data-group-backend-new]')?.value === 'auto' && !!document.querySelector('[data-group-rcon-new]')`), "联机群: 走哪条路默认自动, 有 RCON 的输入框");
  await js(pickOption("[data-group-backend-new]", "memory"));
  check(await until("!document.querySelector('[data-group-rcon-new]')", 5_000), "选内存外挂: RCON 的输入框收起");
  await js(pickOption("[data-group-backend-new]", "auto"));
  await until("!!document.querySelector('[data-group-rcon-new]')", 5_000);
  await js(`[...document.querySelectorAll('[data-new-group-modal] [role=radio]')].find((b) => b.textContent.includes('新地图')).click()`);
  check(await until("!document.querySelector('[data-group-backend-new]')", 5_000), "新地图的群没有走哪条路");
  await sleep(100);
  await js(`(() => { const i = document.querySelector('[data-group-name]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '冒烟群'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(100);
  await js(`document.querySelector('[data-group-create]').click()`);
  const groupsDir = path.join(tmp, "lab", "play", "groups");
  check(await until("!document.querySelector('[data-new-group-modal]') && !!document.querySelector('[data-group-card]') && document.querySelector('[data-group-card]').innerText.includes('冒烟群') && !!document.querySelector('[data-group-start]')", 15_000)
    && fs.existsSync(groupsDir) && fs.readdirSync(groupsDir).filter((f) => f.endsWith(".json")).length === 1,
    "创建群: 存进 lab-data/play/groups, 自动进群, 右栏群卡写着名字和开班按钮");
  check(await js("document.querySelector('.world-name')?.innerText === '冒烟群' && document.querySelectorAll('[data-lineup], [data-next-list]').length >= 1 && [...document.querySelectorAll('.member-next .member-name')].some((e) => e.innerText.startsWith('Claude Opus'))"),
    "进群后: 左上角写群名, 名单是这个群的 (默认 1 个 Claude Opus)");
  // 我的账号的群: 第 1 席选模型, 没有名单, 开局按钮在; 这里不点 (会开用户的 Steam 版)
  await js(`document.querySelector('.world-button').click()`);
  await until("!!document.querySelector('[data-new-group]')", 10_000);
  await js(`document.querySelector('[data-new-group]').click()`);
  await until("!!document.querySelector('[data-new-group-modal]')", 10_000);
  await js(`[...document.querySelectorAll('[data-new-group-modal] [role=radio]')].find((b) => b.textContent.includes('我的账号')).click()`);
  check(await until("!!document.querySelector('[data-mine-new]')", 5_000), "新建对话有\"我的账号\", 能写目标");
  await js(`(() => { const i = document.querySelector('[data-group-name]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '冒烟我的账号'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await js(`(() => { const t = document.querySelector('[data-mine-new] textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, '冒烟目标'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(100);
  await js(`document.querySelector('[data-group-create]').click()`);
  check(await until("!document.querySelector('[data-new-group-modal]') && !!document.querySelector('[data-mine-card]') && document.querySelector('[data-group-start]')?.innerText === '开局' && document.querySelector('[data-mine-goal]')?.value === '冒烟目标'", 15_000), "我的账号的群: 群卡有目标和\"开局\"按钮");
  check(await js("!!document.querySelector('.admin-select') && !document.querySelector('[data-next-list]') && !document.querySelector('[data-edit-members]')"), "第 1 席能选模型, 没有名单 (账号只有一个身体)");
  await shot("7b-我的账号.png");
  // 联机群: 地址和密码进 keys.json, 不进群文件 (群文件进备份); 选项存下来; 只读连接的按钮在, 这里不点 (会开客户端)
  await js(`document.querySelector('.world-button').click()`);
  await until("!!document.querySelector('[data-new-group]')", 10_000);
  await js(`document.querySelector('[data-new-group]').click()`);
  await until("!!document.querySelector('[data-new-group-modal]')", 10_000);
  await js(`[...document.querySelectorAll('[data-new-group-modal] [role=radio]')].find((b) => b.textContent.includes('联机')).click()`);
  await until("!!document.querySelector('[data-group-address]')", 5_000);
  const fill = (sel, v) => js(`(() => { const i = document.querySelector('${sel}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await fill("[data-group-name]", "冒烟群联机");
  await fill("[data-group-address]", "smoke.example:34197");
  await fill("[data-group-password]", "smoke-server-pw");
  await fill("[data-group-rcon-address-new]", "smoke.example:27015");
  await fill("[data-group-rcon-password-new]", "smoke-rcon-pw");
  await sleep(100);
  await shot("8-新建联机群.png");
  await js(`document.querySelector('[data-group-create]').click()`);
  check(await until("!document.querySelector('[data-new-group-modal]') && !!document.querySelector('[data-group-backend]') && document.querySelector('[data-group-backend]').value === 'auto' && document.querySelector('[data-group-card]').innerText.includes('smoke.example:34197') && document.querySelector('[data-group-card]').innerText.includes('已填 smoke.example:27015') && !!document.querySelector('[data-group-connect]') && !document.querySelector('[data-group-start]')", 15_000), "联机群卡: 地址、RCON 已填、默认自动、只读连接在, 没有开班按钮");
  await shot("9-联机群卡.png");
  const serverGroupText = () => fs.readdirSync(groupsDir).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(groupsDir, f), "utf8")).join("");
  const keysText = fs.readFileSync(path.join(tmp, "lab", "accounts", "keys.json"), "utf8");
  check(!/smoke\.example|smoke-server-pw|smoke-rcon-pw/.test(serverGroupText()) && /smoke-server-pw/.test(keysText) && /smoke-rcon-pw/.test(keysText), "地址和密码只在 keys.json, 群文件里没有");
  check(!(await js(`document.body.innerText.includes('smoke-server-pw') || document.body.innerText.includes('smoke-rcon-pw')`)), "界面上看不到密码");
  await js(pickOption("[data-group-backend]", "memory"));
  check(await until("document.querySelector('[data-group-backend]')?.value === 'memory' && !document.querySelector('[data-group-rcon]')", 10_000) && /"backend": "memory"/.test(serverGroupText()), "改成内存外挂: 存进群文件, RCON 收起");
  await js(pickOption("[data-group-backend]", "rcon"));
  check(await until("document.querySelector('[data-group-server-options]')?.innerText.includes('不能再拿成就') && !!document.querySelector('[data-group-rcon]')", 10_000), "选 RCON: 说明里写着不能再拿成就");
  await shot("9-联机群卡-RCON.png");
  check(await js(`[...document.querySelectorAll('.server-note, .server-check span, [data-landing-note]')].every((e) => e.scrollWidth <= e.clientWidth + 1)`), "联机群卡的说明文字没有被截断");
  check(await js(`document.querySelector('[data-landing-note]')?.innerText.includes('只读连接') && !document.querySelector('[data-landing-note]')?.innerText.includes('开班')`), "联机群的提示说只读连接, 不说开班");
  await js(pickOption("[data-group-backend]", "auto"));
  await until("!!document.querySelector('[data-group-rcon]')", 10_000);
  await js(`document.querySelector('.world-button').click()`);
  check(await until("!!document.querySelector('[data-pick-group]') && [...document.querySelectorAll('[data-pick-group]')].some((e) => e.innerText.includes('冒烟群') && e.innerText.includes('还没开过班'))", 10_000), "世界菜单里列着这个群 (还没开过班)");
  await js(`document.querySelector('.world-run[data-run=""]').click()`);
  await js(`document.querySelector('.banner-action')?.click()`);
  // 前面把这个世界改名成"冒烟测试 · 假数据 · 别点, 会自动关"了 (存在 world-names.json, 重开界面也在), 左上角写的是改后的名
  check(await until("document.body.innerText.includes('先把铁板线接上') && document.querySelector('.world-name')?.innerText === '冒烟测试 · 假数据 · 别点, 会自动关'"), "点\"查看\": 显示上一班的对话, 左上角回到它的世界 (改过的名字重开也在)");
  check(await closeApp(app2), "再关界面: 界面退出");
  let closed = false;
  for (let i = 0; i < 40 && !closed; i++) { await sleep(250); closed = !(await portOpen(4330)); }
  check(closed, "关界面时把自己起的控制接口也收掉了 (4330 不再有人听)");

  // ── 控制接口起不来时也能停班: 假仓库里的 control.ts 一跑就退 → 界面连不上
  //    → 停班按钮仍能点 → 弹窗说明由界面直接写 → 外壳 (main.rs stop_run) 按 lab-data/play/current-run.json 给在跑的那一班写 STOP 文件 ──
  const fakeRepo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(fakeRepo, "src", "play"), { recursive: true });
  fs.writeFileSync(path.join(fakeRepo, "src", "play", "control.ts"), "process.exit(0);\n");
  fs.writeFileSync(path.join(fakeRepo, "package.json"), "{}\n");
  const LIVE = "2000-01-01T02-00-00";
  const liveRun = path.join(runs, LIVE);
  fs.mkdirSync(liveRun, { recursive: true });
  fs.writeFileSync(path.join(tmp, "lab", "play", "current-run.json"), JSON.stringify({ runId: LIVE, runDir: liveRun, startedAt: new Date().toISOString() }));
  await sleep(1500);
  const app3 = spawn(EXE, [], { env: { ...process.env, FP_GUI_DEBUG_PORT: String(DBG), FP_REPO_DIR: fakeRepo, LAB_DATA_DIR: path.join(tmp, "lab"), BRAIN_DIR: path.join(tmp, "brain") }, stdio: "ignore" });
  procs.push(app3);
  await connect();
  check(await until("document.querySelector('.banner.down')?.innerText.includes('退出了') && !document.querySelector('.stop-button').disabled && document.querySelector('.stop-note').innerText.includes('直接写停班标记')", 30_000),
    "控制接口起不来 (一跑就退): 横幅说它退出了, 停班按钮仍能点, 下面说明由界面直接写");
  await js(`document.querySelector('.stop-button').click()`);
  check(await until("!!document.querySelector('[data-stop-modal]') && document.querySelector('[data-stop-modal]').innerText.includes('直接给在跑的那一班写停班标记')"), "停班弹窗: 说明这次由界面直接写停班标记");
  await shot("9-连不上时停班.png");
  await js(`document.querySelector('.modal-buttons .danger').click()`);
  let stopped3 = false;
  for (let i = 0; i < 40 && !stopped3; i++) { await sleep(250); stopped3 = fs.existsSync(path.join(liveRun, "STOP")); }
  check(stopped3 && await until("!document.querySelector('[data-stop-modal]')") && fs.readFileSync(path.join(liveRun, "STOP"), "utf8").includes("外壳直接写的"),
    "确认后: 外壳给 current-run.json 指的那一班写了 STOP 文件 (注明是外壳直接写的), 弹窗关掉");
  check(!fs.existsSync(path.join(runs, PREV, "STOP")) && fs.readFileSync(path.join(cur, "STOP"), "utf8").startsWith("控制接口"), "只写在跑的那一班: 收尾了的上一班没有 STOP, 前面那班的 STOP 还是控制接口写的");
  check(await closeApp(app3), "关界面: 界面退出");

  // ── 关界面 = 停班: 有一班在跑时点 × → 外壳写 STOP; 收尾了的班不写 ──
  const LIVE2 = "2000-01-01T03-00-00";
  const live2 = path.join(runs, LIVE2);
  fs.mkdirSync(live2, { recursive: true });
  fs.writeFileSync(path.join(tmp, "lab", "play", "current-run.json"), JSON.stringify({ runId: LIVE2, runDir: live2, startedAt: new Date().toISOString() }));
  await sleep(1500);
  const app4 = spawn(EXE, [], { env: { ...process.env, FP_GUI_DEBUG_PORT: String(DBG), LAB_DATA_DIR: path.join(tmp, "lab"), BRAIN_DIR: path.join(tmp, "brain") }, stdio: "ignore" });
  procs.push(app4);
  await connect();
  await sleep(1000);
  check(!fs.existsSync(path.join(live2, "STOP")), "开着界面: 没写停班标记");
  check(await closeApp(app4), "点 × 关界面 (班在跑): 不弹窗, 界面直接退出");
  check(fs.existsSync(path.join(live2, "STOP")) && fs.readFileSync(path.join(live2, "STOP"), "utf8").includes("关界面 = 停班"), "关界面后: 在跑的那一班有了 STOP 文件 (run.ts 30 秒内收尾, 大脑都停)");
  // 收尾了的班不写
  const DONE = "2000-01-01T04-00-00", doneDir = path.join(runs, DONE);
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, "summary.json"), "{}");
  fs.writeFileSync(path.join(tmp, "lab", "play", "current-run.json"), JSON.stringify({ runId: DONE, runDir: doneDir, startedAt: new Date().toISOString() }));
  for (let i = 0; i < 40 && (await portOpen(4330)); i++) await sleep(250);
  await sleep(1500);
  const app5 = spawn(EXE, [], { env: { ...process.env, FP_GUI_DEBUG_PORT: String(DBG), LAB_DATA_DIR: path.join(tmp, "lab"), BRAIN_DIR: path.join(tmp, "brain") }, stdio: "ignore" });
  procs.push(app5);
  await connect();
  check(await closeApp(app5) && !fs.existsSync(path.join(doneDir, "STOP")), "没有在跑的班时关界面: 什么都不写");
} catch (e) {
  check(false, `出错: ${e.message}`);
} finally {
  try { ws?.close(); } catch { /* 已关 */ }
  for (const p of procs) try { p.kill(); } catch { /* 已退出 */ }
  fakeRcon.close();
  await sleep(1000);
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} / ${results.length} 项通过${failed ? `, ${failed} 项失败` : ""}; 截图在 ${SHOTS}`);
process.exit(failed ? 1 : 0);
