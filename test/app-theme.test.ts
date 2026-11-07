// 桌面界面的亮色 / 深色主题 (app/src/theme.ts): 选择的保存和跟随系统, 两套配色的对比度
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THEME_CHOICE, PALETTES, THEME_CHOICES, THEME_KEY, applyTheme, contrast, readThemeChoice, resolveTheme, saveThemeChoice, themeNote,
  type ThemeName,
} from "../app/src/theme.ts";

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };

test("选择记住: 存了什么下次读回什么; 没存过、存坏了、存储不能用都是跟随系统", () => {
  const s = memory();
  assert.equal(readThemeChoice(s), "system");
  assert.equal(DEFAULT_THEME_CHOICE, "system");
  for (const c of ["light", "dark", "system"] as const) { saveThemeChoice(s, c); assert.equal(s.m.get(THEME_KEY), c); assert.equal(readThemeChoice(s), c); }
  s.setItem(THEME_KEY, "粉色");
  assert.equal(readThemeChoice(s), "system");
  const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
  assert.equal(readThemeChoice(broken), "system");
  assert.doesNotThrow(() => saveThemeChoice(broken, "dark"));
  assert.equal(readThemeChoice(undefined), "system");
});

test("跟随系统: Windows 是深色就深色, 亮色就亮色; 手动选的不管系统", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  for (const sys of [true, false]) { assert.equal(resolveTheme("light", sys), "light"); assert.equal(resolveTheme("dark", sys), "dark"); }
  assert.equal(themeNote("system", false), "现在: 亮色 (跟随 Windows)");
  assert.equal(themeNote("dark", false), "现在: 深色");
  assert.deepEqual(THEME_CHOICES.map((c) => c.label), ["跟随系统", "亮色", "深色"]);
});

test("写到页面上: 每个变量、data-theme、color-scheme", () => {
  const props = new Map<string, string>();
  const root = { dataset: {} as Record<string, string | undefined>, style: { setProperty: (k: string, v: string) => void props.set(k, v), colorScheme: "" } };
  applyTheme("light", root);
  assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.colorScheme, "light");
  assert.equal(props.get("--bg"), PALETTES.light.bg);
  assert.equal(props.size, Object.keys(PALETTES.light).length);
  applyTheme("dark", root);
  assert.equal(props.get("--bg"), PALETTES.dark.bg);
  assert.deepEqual(Object.keys(PALETTES.light).sort(), Object.keys(PALETTES.dark).sort());
});

test("对比度算法 (WCAG 2) 对得上已知值", () => {
  assert.equal(+contrast("#000000", "#ffffff").toFixed(1), 21);
  assert.equal(+contrast("#777777", "#ffffff").toFixed(2), 4.48);
  assert.equal(contrast("#123456", "#123456"), 1);
});

// 两套主题都要看得清: 文字 ≥ 4.5 (正文 ≥ 7), 状态圆点等图形 ≥ 3 (WCAG 1.4.3 / 1.4.11)
for (const name of ["dark", "light"] as ThemeName[]) {
  test(`${name === "dark" ? "深色" : "亮色"}: 文字、失败红字、状态圆点、角标的对比度都够`, () => {
    const p = PALETTES[name];
    const need = (fg: keyof typeof p, bgs: (keyof typeof p)[], min: number) => {
      for (const bg of bgs) { const c = contrast(p[fg], p[bg]); assert.ok(c >= min, `${name}: ${fg} ${p[fg]} 在 ${bg} ${p[bg]} 上 ${c.toFixed(2)} < ${min}`); }
    };
    const surfaces = ["bg", "bg-raised", "bg-card", "bg-input"] as const;
    need("text", [...surfaces, "bg-active", "bg-hover"], 7);
    need("text-dim", [...surfaces, "bg-active", "bg-hover", "banner-bg"], 4.5);
    need("text-faint", [...surfaces, "bg-active", "bg-hover"], 4.5); // 左栏选中行、鼠标停着的行上的小字也要看得清
    need("red", ["bg", "bg-raised", "bg-card"], 4.5);          // 失败红字: "N 步失败"、"没送到"、输入框提示
    need("red-soft", ["bg-input", "bg-card"], 4.5);             // 失败的命令输出
    need("blue", ["bg", "bg-raised", "bg-card"], 4.5);         // "在干活"、"正在干 · 第 N 步"、"执行中…"
    need("amber-text", ["bg", "bg-raised", "bg-card"], 4.5);   // "等你" 卡片和状态字
    need("green", ["bg-raised", "bg-card"], 4.5);              // "在跑"、步骤的 ✓
    need("badge-fg", ["amber"], 4.5);                          // 角标里的数字
    for (const dot of ["blue", "amber", "green", "dot-idle", "red"] as const) need(dot, ["bg-raised", "bg-active"], 3); // 头像角上的圆点 (选中行也要看得清)、产量前的圆点
    need("warn-fg", ["warn-bg"], 4.5);
    need("down-fg", ["down-bg"], 4.5);
    need("accent-fg", ["accent"], 4.5);
    need("danger-fg", ["danger"], 4.5);
    need("stop-fg", ["bg-raised", "stop-hover"], 4.5);
    need("you-fg", ["you-bg"], 7);                             // 你说的话 (聊天室里靠右的蓝气泡)
  });
}
