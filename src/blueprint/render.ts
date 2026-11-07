// 蓝图出图: 用本机蓝图编辑器 (FactoryGameFan/factorio-blueprint-editor, MIT) 在无界面浏览器里渲染,
// 再画坐标网格和检查器标号, 按上限压缩 (最长边 ≤800、≤300KB; CLAUDE.md 输出上限)。给 AI 看图自查摆放和线路。
// 编辑器要开发模式 (localpreview) 才有测试接口 window.__fbe_test, 还要本机补丁 tools/fbe-patches/picture-frame.patch
// (暴露出图画框, 坐标网格靠它对位)。浏览器库 playwright 从编辑器目录借 (成熟库, 本仓库不加依赖)。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";

export interface RenderMark {
  x: number;
  y: number;
  label: string;
  level: "error" | "warn" | "info";
}

export interface RenderOptions {
  /** 最长边像素, 默认 800 */
  maxSide?: number;
  /** 文件上限字节, 默认 300_000 */
  maxBytes?: number;
  /** 打开编辑器的信息层 (alt: 配方图标、机械臂方向、没配对的地下带), 默认开 */
  alt?: boolean;
  /** 画坐标网格 (标蓝图坐标), 默认开 */
  grid?: boolean;
  /** 在图上画圈标号 (蓝图坐标) */
  marks?: RenderMark[];
  /** 参照实体 (蓝图字符串里的 entity_number 和坐标), 用来把编辑器坐标对回蓝图坐标; 给几个候选, 编辑器删掉了前面的 (认不出的建筑) 就用后面的 */
  reference?: { n: number; x: number; y: number }[];
  timeoutMs?: number;
}

export interface RenderResult {
  data: Buffer;
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
  /** 每格多少像素 */
  pxPerTile: number;
  /** 图片左上角对应的蓝图坐标 */
  origin: { x: number; y: number };
  gridStep: number;
  /** jpeg 时的质量 */
  quality?: number;
  ms: number;
}

const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

/** 网格间距 (格): 相邻两条线至少 minGapPx 像素 */
export function gridStep(pxPerTile: number, minGapPx = 40): number {
  return STEPS.find((s) => s * pxPerTile >= minGapPx) ?? STEPS[STEPS.length - 1];
}

/** 编辑器出图用的分辨率 (1 = 每格 32 像素): 先按 2 倍目标渲染再在画布里缩小, 小图不放大 */
export function renderResolution(frameW: number, frameH: number, maxSide: number): number {
  const longest = Math.max(frameW, frameH);
  return longest <= 0 ? 1 : Math.min(1, (2 * maxSide) / longest);
}

/** 压缩尝试顺序: 先 png, 再 jpeg 逐级降质量; 都超上限就缩小 0.8 倍重来 */
export const ENCODE_TRIES: { mime: "image/png" | "image/jpeg"; quality?: number }[] = [
  { mime: "image/png" },
  { mime: "image/jpeg", quality: 0.85 },
  { mime: "image/jpeg", quality: 0.7 },
  { mime: "image/jpeg", quality: 0.55 },
  { mime: "image/jpeg", quality: 0.4 },
];

export function fbeDir(): string {
  const d = process.env.FBE_DIR;
  if (!d) throw new Error("没设 FBE_DIR: 在 .env 里写本机蓝图编辑器目录 (见 docs/blueprint-dataset.md 出图一节)");
  return d;
}

export function fbeUrl(): string {
  return process.env.FBE_URL || "http://localhost:8080/";
}

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** 编辑器没开就用它自己的启动脚本开 (vite 8080 + 贴图 8081); 返回关掉的函数 (原来开着的不关) */
export async function ensureEditor(url = fbeUrl(), dir = fbeDir()): Promise<() => void> {
  if (await reachable(url)) return () => {};
  const bin = path.join(dir, "node_modules", ".bin");
  const child: ChildProcess = spawn(process.execPath, ["scripts/localpreview.mjs"], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    stdio: "ignore",
    windowsHide: true,
    // 单独的控制台: 2026-11-05 新图班出完俯视图关编辑器时, run.ts 被 Ctrl-C 结束 (退出码 3221225786), 没写 summary 和复盘; 同一个控制台的进程会一起收到这个事件
    detached: true,
  });
  child.unref();
  const stop = () => {
    if (child.exitCode !== null || !child.pid) return;
    // Windows 上只杀父进程会留下 vite / serve, 按进程树杀
    if (process.platform === "win32") {
      try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已经退了 */ }
    } else child.kill();
  };
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    if (child.exitCode !== null) throw new Error(`编辑器启动脚本退出了 (代码 ${child.exitCode}), 手动跑 start-fbe.cmd 看报错`);
    if (await reachable(url)) { await hideEditorWindows(dir); return stop; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  throw new Error("编辑器 90 秒没起来");
}

/** 把编辑器 vite 的黑窗口藏起来 (只藏, 服务不动): 它脱离控制台起, windowsHide 不管用, 桌面上留一个 node.exe 黑窗口一直开着 (2026-11-06 实测可见 993x519)。藏不掉不影响出图 */
async function hideEditorWindows(dir: string): Promise<void> {
  if (process.platform !== "win32") return;
  const script = `$ProgressPreference = 'SilentlyContinue'
Add-Type -Name W -Namespace FpHide -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr h, int n);'
$dir = '${dir.replaceAll("/", "\\").replaceAll("'", "''")}'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\\').Contains($dir) } | ForEach-Object { $h = (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle; if ($h -and $h -ne 0) { [void][FpHide.W]::ShowWindowAsync($h, 0) } }`;
  await new Promise<void>((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 20_000 }, () => resolve());
  });
}

type Page = {
  goto(u: string, o?: unknown): Promise<unknown>;
  waitForFunction(f: unknown, a?: unknown, o?: unknown): Promise<unknown>;
  evaluate<T>(f: unknown, a?: unknown): Promise<T>;
  keyboard: { press(k: string): Promise<void> };
  close(): Promise<void>;
};
type Browser = { newPage(o?: unknown): Promise<Page>; close(): Promise<void> };

/** 一个浏览器连本机编辑器, 可以连续出多张图 (数据集批量用) */
export class BlueprintRenderer {
  private browser?: Browser;
  private stopEditor: () => void = () => {};
  /** keepEditor: 编辑器留着 (大脑的 ./bp view 一班要看很多次, 用户也开 http://localhost:8080/ 看; 它是单独的控制台, 进程退了也还在) */
  private readonly opts: { keepEditor?: boolean };
  constructor(opts: { keepEditor?: boolean } = {}) { this.opts = opts; } // node 去类型模式不支持参数属性

  async open(): Promise<void> {
    const stop = await ensureEditor();
    if (!this.opts.keepEditor) this.stopEditor = stop;
    const req = createRequire(path.join(fbeDir(), "package.json"));
    const { chromium } = req("playwright") as { chromium: { launch(o: unknown): Promise<Browser> } };
    // 本机代理会替 localhost 回 503 (components.md), 浏览器不走代理
    this.browser = await chromium.launch({ args: ["--no-proxy-server"] });
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.stopEditor();
  }

  async render(bpString: string, opt: RenderOptions = {}): Promise<RenderResult> {
    if (!this.browser) await this.open();
    const t0 = Date.now();
    const timeout = opt.timeoutMs ?? 600_000;
    const page = await this.browser!.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(fbeUrl(), { waitUntil: "domcontentloaded", timeout });
      await page.waitForFunction(() => {
        const el = document.getElementById("loadingScreen");
        return el && !el.classList.contains("active");
      }, null, { timeout });
      const hasFrame = await page.evaluate<boolean>(() => typeof (window as any).__fbe_test?.pictureFrame === "function");
      if (!hasFrame) throw new Error("编辑器没有 pictureFrame: 要开发模式 (start-fbe.cmd) 并打本机补丁 tools/fbe-patches/picture-frame.patch");
      await page.evaluate(async (s: string) => {
        const f = (window as any).__fbe_test;
        const x = await f.getBlueprintOrBookFromSource(s);
        await f.loadBp(x);
      }, bpString);
      // 信息层 (alt) 编辑器默认开着; 按一下 Alt 切换, 松开时生效
      const wantAlt = opt.alt !== false;
      if ((await page.evaluate<boolean>(() => (window as any).__fbe_test.infoOverlayVisible())) !== wantAlt) {
        await page.keyboard.press("AltLeft");
        await page.waitForFunction((w: boolean) => (window as any).__fbe_test.infoOverlayVisible() === w, wantAlt, { timeout: 10_000 });
      }
      // 载入完贴图还在路上 (编辑器先发空贴图、文件到了再填; 它自己的 image-export 测试也是等"连续两次出图一致"):
      // 每 0.5 秒出一张小图算指纹, 画框和指纹连续两次不变才算画完
      const settled = await page.evaluate<boolean>(async (limitMs: number) => {
        const f = (window as any).__fbe_test;
        const t0 = Date.now();
        let last = "", same = 0;
        while (Date.now() - t0 < limitMs) {
          const fr = f.pictureFrame();
          const bmp = await createImageBitmap(await f.getPicture(Math.min(1, 256 / Math.max(fr.width, fr.height))));
          const c = document.createElement("canvas");
          c.width = bmp.width; c.height = bmp.height;
          const g = c.getContext("2d")!;
          g.drawImage(bmp, 0, 0);
          const px = g.getImageData(0, 0, c.width, c.height).data;
          let h = 0;
          for (let i = 0; i < px.length; i += 4) h = (h * 31 + px[i] + px[i + 1] * 7 + px[i + 2] * 13 + px[i + 3] * 17) >>> 0;
          const key = `${fr.x},${fr.y},${fr.width},${fr.height},${h}`;
          same = key === last ? same + 1 : 0;
          if (same >= 2) return true;
          last = key;
          await new Promise((r) => setTimeout(r, 500));
        }
        return false;
      }, Math.min(timeout, 120_000));
      if (!settled) throw new Error("贴图 2 分钟还没加载稳定");
      const frame0 = await page.evaluate<{ width: number; height: number }>(() => (window as any).__fbe_test.pictureFrame());
      const args = {
        res: renderResolution(frame0.width, frame0.height, opt.maxSide ?? 800),
        maxSide: opt.maxSide ?? 800,
        maxBytes: opt.maxBytes ?? 300_000,
        grid: opt.grid !== false,
        marks: opt.marks ?? [],
        ref: opt.reference ?? null,
        tries: ENCODE_TRIES,
        steps: STEPS,
      };
      const out = await page.evaluate<{ url: string; width: number; height: number; pxPerTile: number; origin: { x: number; y: number }; gridStep: number; mime: "image/png" | "image/jpeg"; quality?: number; bytes: number } | { error: string }>(async (a: typeof args) => {
        const f = (window as any).__fbe_test;
        const frame = f.pictureFrame() as { x: number; y: number; width: number; height: number };
        // 编辑器坐标 → 蓝图坐标: 参照实体两边的位置差
        let off = { x: 0, y: 0 };
        if (a.ref && a.ref.length) {
          const hit = a.ref.find((r: { n: number }) => f.entityPosition(r.n));
          if (!hit) return { error: `编辑器里找不到参照实体 (试了 ${a.ref.map((r: { n: number }) => "#" + r.n).join(" ")})` };
          const p = f.entityPosition(hit.n);
          off = { x: p.x - hit.x, y: p.y - hit.y };
        }
        const bmp = await createImageBitmap(await f.getPicture(a.res));
        const tilesW = frame.width / 32, tilesH = frame.height / 32;
        const origin = { x: frame.x / 32 - off.x, y: frame.y / 32 - off.y };
        let scale = Math.min(1, a.maxSide / Math.max(bmp.width, bmp.height));
        for (let round = 0; round < 8; round++) {
          const W = Math.max(1, Math.round(bmp.width * scale)), H = Math.max(1, Math.round(bmp.height * scale));
          const ppt = W / tilesW;
          const c = document.createElement("canvas");
          c.width = W; c.height = H;
          const g = c.getContext("2d")!;
          g.fillStyle = "#2a2a2a"; // 透明处填深灰 (jpeg 不会变黑, 网格看得清)
          g.fillRect(0, 0, W, H);
          g.imageSmoothingEnabled = true;
          g.imageSmoothingQuality = "high";
          g.drawImage(bmp, 0, 0, W, H);
          const step = a.steps.find((s) => s * ppt >= 40) ?? a.steps[a.steps.length - 1];
          if (a.grid) {
            g.strokeStyle = "rgba(255,255,255,0.28)";
            g.lineWidth = 1;
            g.font = "11px sans-serif";
            g.textBaseline = "top";
            const label = (t: string, x: number, y: number) => {
              g.lineWidth = 3; g.strokeStyle = "rgba(0,0,0,0.85)"; g.strokeText(t, x, y);
              g.fillStyle = "#ffe066"; g.fillText(t, x, y);
              g.lineWidth = 1; g.strokeStyle = "rgba(255,255,255,0.28)";
            };
            for (let gx = Math.ceil(origin.x / step) * step; gx <= origin.x + tilesW; gx += step) {
              const x = Math.round((gx - origin.x) * ppt) + 0.5;
              g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
              label(String(gx), x + 2, 2);
            }
            for (let gy = Math.ceil(origin.y / step) * step; gy <= origin.y + tilesH; gy += step) {
              const y = Math.round((gy - origin.y) * ppt) + 0.5;
              g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
              label(String(gy), 2, y + 2);
            }
          }
          const colors = { error: "#ff3030", warn: "#ffa020", info: "#40c0ff" } as const;
          g.font = "bold 12px sans-serif";
          g.textBaseline = "middle";
          for (const m of a.marks) {
            const x = (m.x - origin.x) * ppt, y = (m.y - origin.y) * ppt;
            const r = Math.max(6, ppt * 0.7);
            g.lineWidth = 2; g.strokeStyle = colors[m.level];
            g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
            g.lineWidth = 3; g.strokeStyle = "#000"; g.strokeText(m.label, x + r + 2, y);
            g.fillStyle = colors[m.level]; g.fillText(m.label, x + r + 2, y);
          }
          for (const t of a.tries) {
            const blob: Blob | null = await new Promise((ok) => c.toBlob(ok, t.mime, t.quality));
            if (blob && blob.size <= a.maxBytes) {
              const url: string = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result as string); r.readAsDataURL(blob); });
              return { url, width: W, height: H, pxPerTile: ppt, origin, gridStep: step, mime: t.mime, quality: t.quality, bytes: blob.size };
            }
          }
          scale *= 0.8;
        }
        return { error: "缩到很小也超过字节上限" };
      }, args);
      if ("error" in out) throw new Error(out.error);
      return {
        data: Buffer.from(out.url.slice(out.url.indexOf(",") + 1), "base64"),
        mime: out.mime, width: out.width, height: out.height, pxPerTile: out.pxPerTile,
        origin: out.origin, gridStep: out.gridStep, quality: out.quality, ms: Date.now() - t0,
      };
    } finally {
      await page.close();
    }
  }
}

type RawBp = { entities?: { entity_number?: number; position: { x: number; y: number } }[]; tiles?: { position: { x: number; y: number } }[]; wires?: number[][]; schedules?: { locomotives?: number[] }[]; [k: string]: unknown };

/** 只留中心在 [x1,x2]×[y1,y2] 里的实体和地砖; 两头都留下的电线、还有车头的时刻表跟着留 (看大蓝图的局部) */
export function cropBlueprint<T extends RawBp>(bp: T, area: [number, number, number, number]): T {
  const [x1, y1, x2, y2] = [Math.min(area[0], area[2]), Math.min(area[1], area[3]), Math.max(area[0], area[2]), Math.max(area[1], area[3])];
  const inside = (p: { x: number; y: number }) => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
  const entities = (bp.entities ?? []).filter((e) => inside(e.position));
  const kept = new Set(entities.map((e) => e.entity_number));
  const out: RawBp = { ...bp, entities };
  if (bp.tiles) out.tiles = bp.tiles.filter((t) => inside(t.position));
  if (bp.wires) out.wires = bp.wires.filter((w) => kept.has(w[0]) && kept.has(w[2]));
  if (bp.schedules) out.schedules = bp.schedules.map((s) => ({ ...s, locomotives: (s.locomotives ?? []).filter((n) => kept.has(n)) })).filter((s) => s.locomotives.length > 0);
  return out as T;
}

/** 预览链接 (给人看的报告用; 也是用户手动调整的入口): 短蓝图把字符串放进链接 (#source=, 不靠服务器);
 *  长的 (朋友基地 43 万字) 写进编辑器的本机目录 public/local-bp/, 链接用 ?source=同源地址 (要本机补丁 local-source.patch: 同源直接取, 不经公网代理) */
export const LINK_INLINE_MAX = 2000;
export function previewLink(bpString: string, dir = fbeDir(), url = fbeUrl()): string {
  const base = url.endsWith("/") ? url : url + "/";
  if (bpString.length <= LINK_INLINE_MAX) return `${base}#source=${bpString}`;
  const name = createHash("sha1").update(bpString).digest("hex").slice(0, 12) + ".txt";
  const out = path.join(dir, "packages", "website", "public", "local-bp");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, name), bpString);
  return `${base}?source=${base}local-bp/${name}`;
}

/** 蓝图里前 10 件带编号的实体, 当坐标参照的候选 */
export function referenceOf(bp: { entities?: { entity_number?: number; position: { x: number; y: number } }[] }): RenderOptions["reference"] {
  const es = (bp.entities ?? []).filter((x) => typeof x.entity_number === "number").slice(0, 10);
  return es.length ? es.map((e) => ({ n: e.entity_number!, x: e.position.x, y: e.position.y })) : undefined;
}

export function writeRender(file: string, r: RenderResult): string {
  const ext = r.mime === "image/png" ? ".png" : ".jpg";
  const out = file.replace(/\.(png|jpe?g)$/i, "") + ext;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, r.data);
  return out;
}
