// 主题选择 (跟随系统 / 亮色 / 深色): 记在 localStorage, 跟着 Windows 变, 系统画的标题栏也跟着换。
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DARK_QUERY, applyTheme, readThemeChoice, resolveTheme, saveThemeChoice, type ThemeChoice } from "./theme.ts";

/** 存储不能用时 (被禁) 读 localStorage 本身就会抛错 */
export const themeStore = (): Storage | undefined => { try { return localStorage; } catch { return undefined; } };
const systemDark = (): boolean => { try { return matchMedia(DARK_QUERY).matches; } catch { return false; } };

/** 页面画出来之前先上色 (main.tsx 调), 免得先闪一下另一套 */
export function paintSavedTheme(): void {
  applyTheme(resolveTheme(readThemeChoice(themeStore()), systemDark()), document.documentElement);
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice(themeStore()));
  const [sysDark, setSysDark] = useState(systemDark);
  useEffect(() => {
    const q = matchMedia(DARK_QUERY);
    const on = () => setSysDark(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  const name = resolveTheme(choice, sysDark);
  useEffect(() => { applyTheme(name, document.documentElement); }, [name]);
  useEffect(() => {
    saveThemeChoice(themeStore(), choice);
    // 标题栏是系统画的: 手动选了就钉住, 跟随系统就交还给系统。Tauri 换窗口主题时也会改页面看到的 prefers-color-scheme,
    // 所以交还之后重新读一次系统是深色还是亮色。
    if (isTauri()) getCurrentWindow().setTheme(choice === "system" ? null : choice).then(() => setSysDark(systemDark()), () => {});
  }, [choice]);
  return { choice, setChoice, systemDark: sysDark, name };
}
