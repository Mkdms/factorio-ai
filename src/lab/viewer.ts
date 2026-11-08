// 转接: 第二版的 src/lab/viewer.ts 在新项目里是 game/sandbox/viewer.ts
// 第二版开窗口传 repoMods (mods/ 下的目录名), 新项目的窗口只认 mods (game/mod/ 下的名字): 这里照沙盘实例 (instance.ts mapRepoMods) 一样对过去。
// 不对的话客户端不带模组去连装了模组的服务器, 卡在"模组与服务器不一致, 要同步吗"的确认框 (2026-11-08 装模组的路窗口掉线重开时用户截图看到)
import { Viewer } from "../../game/sandbox/viewer.ts";
import { mapRepoMods } from "./instance.ts";

export * from "../../game/sandbox/viewer.ts";

export class ViewerClient extends Viewer {
  override launch(gamePort: number, opts: Parameters<Viewer["launch"]>[1] & { repoMods?: string[] } = {}) {
    const { repoMods, ...rest } = opts;
    return super.launch(gamePort, repoMods ? { ...rest, mods: [...mapRepoMods(repoMods), ...(rest.mods ?? [])] } : rest);
  }
}
