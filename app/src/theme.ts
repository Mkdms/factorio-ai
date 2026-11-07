// 亮色 / 深色主题。
// 两套配色只在这里定义一份, 启动时写成 :root 上的 CSS 变量 (index.css 只用变量); 测试 (test/app-logic.test.ts) 直接核对比度。
// 跟随系统 + 存选择的做法、亮色配色 (daylight 皮肤) 改自 OpenMausBot src/lib/skins.ts、src/styles.css (Apache-2.0, 见 NOTICE);
// 深色是原来改自 OpenGrokBot 的那套 (MIT)。改动: 颜色都改成不透明的 (好算对比度), 次要文字、状态圆点、角标调到够对比度。
// 只用能被 Node 直接去类型运行的写法。

export type ThemeChoice = "system" | "light" | "dark";
export type ThemeName = "light" | "dark";

export const THEME_KEY = "fp-gui:theme";
export const DEFAULT_THEME_CHOICE: ThemeChoice = "system";
export const THEME_CHOICES: { id: ThemeChoice; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "亮色" },
  { id: "dark", label: "深色" },
];
export const THEME_NAMES: Record<ThemeName, string> = { light: "亮色", dark: "深色" };
export const DARK_QUERY = "(prefers-color-scheme: dark)";

type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const isChoice = (v: unknown): v is ThemeChoice => v === "system" || v === "light" || v === "dark";

/** 读记住的选择; 没存过、存坏了、存储不能用 → 跟随系统 */
export function readThemeChoice(store: Pick<Store, "getItem"> | undefined): ThemeChoice {
  try { const v = store?.getItem(THEME_KEY); return isChoice(v) ? v : DEFAULT_THEME_CHOICE; } catch { return DEFAULT_THEME_CHOICE; }
}
/** 记住选择 (存储不能用就算了, 这次照样换) */
export function saveThemeChoice(store: Pick<Store, "setItem"> | undefined, choice: ThemeChoice): void {
  try { store?.setItem(THEME_KEY, choice); } catch { /* 存不了 */ }
}
/** 实际用哪套: 跟随系统时看 Windows 是不是深色 */
export const resolveTheme = (choice: ThemeChoice, systemDark: boolean): ThemeName => (choice === "system" ? (systemDark ? "dark" : "light") : choice);
/** 设置里那一行小字: "现在: 亮色 (跟随 Windows)" */
export const themeNote = (choice: ThemeChoice, systemDark: boolean): string => `现在: ${THEME_NAMES[resolveTheme(choice, systemDark)]}${choice === "system" ? " (跟随 Windows)" : ""}`;

/** 配色: 键是 CSS 变量名 (去掉 --) */
export type Palette = Record<
  | "bg" | "bg-raised" | "bg-card" | "bg-input" | "bg-hover" | "bg-active"
  | "border" | "border-strong" | "focus"
  | "text" | "text-dim" | "text-faint"
  | "accent" | "accent-fg"
  | "blue" | "amber" | "amber-text" | "green" | "red" | "red-soft" | "badge-fg"
  | "banner-bg" | "warn-bg" | "warn-fg" | "down-bg" | "down-fg"
  | "avatar-bg" | "dot-idle" | "track" | "cmd-border" | "btn-disabled-bg" | "btn-disabled-fg"
  | "stop-border" | "stop-fg" | "stop-hover" | "danger" | "danger-fg"
  | "scroll" | "scroll-hover" | "shadow" | "scrim"
  | "you-bg" | "you-fg" | "logo-bg",
  string
>;

export const PALETTES: Record<ThemeName, Palette> = {
  dark: {
    "bg": "#0d0d0d", "bg-raised": "#131313", "bg-card": "#1a1a1a", "bg-input": "#161616", "bg-hover": "#1f1f1f", "bg-active": "#262626",
    "border": "#262626", "border-strong": "#343434", "focus": "#4a4a4a",
    "text": "#ededed", "text-dim": "#b0b0b0", "text-faint": "#8e8e8e",
    "accent": "#ededed", "accent-fg": "#0d0d0d",
    "blue": "#4d9fff", "amber": "#d9a441", "amber-text": "#d9a441", "green": "#4ec26f", "red": "#e5534b", "red-soft": "#f0a3a3", "badge-fg": "#111111",
    "banner-bg": "#111111", "warn-bg": "#17130a", "warn-fg": "#d9a441", "down-bg": "#1a0f0f", "down-fg": "#f0a3a3",
    "avatar-bg": "#232323", "dot-idle": "#777777", "track": "#262626", "cmd-border": "#3a4a63", "btn-disabled-bg": "#2a2a2a", "btn-disabled-fg": "#858585",
    "stop-border": "#5a2a27", "stop-fg": "#f0a3a3", "stop-hover": "#1f1111", "danger": "#c9433c", "danger-fg": "#ffffff",
    "scroll": "#2a2a2a", "scroll-hover": "#383838", "shadow": "rgba(0, 0, 0, 0.6)", "scrim": "rgba(0, 0, 0, 0.6)",
    "you-bg": "#1c4f9c", "you-fg": "#ffffff", "logo-bg": "#ffffff",
  },
  light: {
    "bg": "#fcfcfc", "bg-raised": "#f5f5f5", "bg-card": "#f2f2f2", "bg-input": "#ffffff", "bg-hover": "#ececec", "bg-active": "#e4e4e4",
    "border": "#e2e2e2", "border-strong": "#c8c8c8", "focus": "#8f8f8f",
    "text": "#1c1c1c", "text-dim": "#4a4a4a", "text-faint": "#636363",
    "accent": "#1c1c1c", "accent-fg": "#ffffff",
    "blue": "#0b69cc", "amber": "#a35f00", "amber-text": "#9c5b00", "green": "#007a44", "red": "#cd2834", "red-soft": "#b3261e", "badge-fg": "#ffffff",
    "banner-bg": "#f2f2f2", "warn-bg": "#fdf4e3", "warn-fg": "#8a5100", "down-bg": "#fdecec", "down-fg": "#a3221b",
    "avatar-bg": "#ebebeb", "dot-idle": "#7a7a7a", "track": "#e4e4e4", "cmd-border": "#7aa7dc", "btn-disabled-bg": "#e6e6e6", "btn-disabled-fg": "#8a8a8a",
    "stop-border": "#e3a5a1", "stop-fg": "#b3261e", "stop-hover": "#fdf0ef", "danger": "#c9302c", "danger-fg": "#ffffff",
    "scroll": "#c4c4c4", "scroll-hover": "#a8a8a8", "shadow": "rgba(28, 28, 28, 0.14)", "scrim": "rgba(0, 0, 0, 0.32)",
    "you-bg": "#cfe4ff", "you-fg": "#1c1c1c", "logo-bg": "#ffffff",
  },
};

/** WCAG 2 对比度 (#rrggbb) */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) throw new Error(`不是 #rrggbb: ${hex}`);
    const [r, g, bl] = [m[1], m[2], m[3]].map((h) => { const c = parseInt(h, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** 把一套配色写到页面上 (CSS 变量 + data-theme + color-scheme, 后者让滚动条和输入框跟着变) */
export function applyTheme(name: ThemeName, root: { dataset: Record<string, string | undefined>; style: { setProperty(k: string, v: string): void; colorScheme: string } }): void {
  for (const [k, v] of Object.entries(PALETTES[name])) root.style.setProperty(`--${k}`, v);
  root.style.colorScheme = name;
  root.dataset.theme = name;
}
