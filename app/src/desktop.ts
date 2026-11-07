// 桌面外壳 (app/src-tauri/src/main.rs) 的命令: 界面启动时 4330 没人听, 外壳自己在仓库目录起控制接口 (node src/play/control.ts), 关界面时收掉。
// 在浏览器里 (npm run dev) 没有外壳, 这些都返回 null, 照旧提示手动 npm run play:control。
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ControlProc } from "./logic.ts";

export const desktop = {
  controlStatus: (): Promise<ControlProc | null> => (isTauri() ? invoke<ControlProc>("control_status") : Promise.resolve(null)),
  /** 再起一次 (控制接口退出了 / 起不来改好之后); 4330 已经有人听就什么都不做 */
  controlStart: (): Promise<ControlProc | null> => (isTauri() ? invoke<ControlProc>("control_start") : Promise.resolve(null)),
  /** 窗口建的时候是隐藏的 (不然先白一下再出内容, 深色模式下很扎眼), 页面画好了再显示 */
  showWindow: (): Promise<void> => (isTauri() ? getCurrentWindow().show() : Promise.resolve()),
  /** 控制接口连不上时的停班: 外壳按 lab-data/play/current-run.json 直接给在跑的那一班写 STOP 文件; 浏览器里 null */
  stopRun: (): Promise<StopRun | null> => (isTauri() ? invoke<StopRun>("stop_run") : Promise.resolve(null)),
};
export type StopRun = { ok: boolean; run: string | null; error: string | null };
