// 观看模式: 沙盘服务器按正常速度跑, 另开一个游戏窗口连进去, 在游戏聊天框里用中文播报实验进度。
// 关掉游戏窗口, 沙盘服务器自动关闭。
import path from "node:path";
import { LabInstance } from "./instance.ts";
import { ViewerClient } from "./viewer.ts";
import { demoBlueprint } from "./demo.ts";
import { zhNames } from "./names.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function watch(opts: { seed?: number; log?: (s: string) => void } = {}) {
  const { seed = 20261031, log = console.log } = opts;
  const lab = new LabInstance({ name: "watch", view: false }); // 观看模式自己管窗口
  const viewer = new ViewerClient("viewer");
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    viewer.close();
    await lab.stop({ save: false });
    log("沙盘已关闭");
  };
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));

  try {
    await lab.createMap("watch", { seed });
    const ping = (await lab.start("watch")) as { base: string };
    const zh = zhNames(lab);
    log(`沙盘服务器已启动 (端口 ${lab.gamePort}), 正在打开观看窗口...`);
    const proc = viewer.launch(lab.gamePort);
    proc.on("exit", () => void shutdown());

    // 等玩家连进来
    let joined = false;
    for (let i = 0; i < 360 && !closing; i++) {
      const v = (await lab.rpc("viewer", {}, { retry: true })) as { count: number };
      if (v.count > 0) {
        joined = true;
        break;
      }
      await sleep(500);
    }
    if (!joined) throw new Error(`3 分钟内没有玩家连进来; 客户端日志 ${path.join(viewer.dir, "client.out")}`);
    const who = (await lab.rpc("viewer", { position: [6, 2], zoom: 1.6 }, { retry: true })) as { players: string[] };
    log(`玩家 ${who.players.join("、")} 已连进沙盘`);

    const say = (text: string) => lab.rpc("say", { text: `[沙盘] ${text}` });
    await sleep(3000);
    await say("欢迎! 这是本机沙盘服务器, 和你自己的存档无关, 关掉这个窗口沙盘就自动关闭。");
    await sleep(5000);
    await say(`第 1 步: 清出一块空地, 在左边铺一小片${zh("iron-ore")}。`);
    await lab.rpc("prepare_area", {
      area: [[-12, -12], [12, 12]],
      resource: { name: "iron-ore", amount: 1_000_000, area: [[-3, -3], [0, 0]] },
      no_enemies: true,
    });
    await sleep(5000);
    const chain = ["electric-mining-drill", "electric-furnace", "inserter", "assembling-machine-2", "inserter", "steel-chest"].map(zh).join(" → ");
    await say(`第 2 步: 放一张蓝图: ${chain}。电由${zh("electric-energy-interface")} (沙盘专用) 供给。`);
    await sleep(3000);
    const poleCopper = (await lab.exec("return defines.wire_connector_id.pole_copper")) as number;
    const placed = (await lab.rpc("place_blueprint", { string: demoBlueprint(ping.base, poleCopper), position: [0, 0] })) as {
      built: number;
      ghosts: number;
      failed_count: number;
      moved_characters: number;
    };
    if (placed.moved_characters) await say(`有角色挡在蓝图位置上, 已把他挪到旁边 (游戏不让把建筑建在人身上)。`);
    if (placed.failed_count) await say(`注意: 有 ${placed.failed_count} 件没建成, 只剩蓝色虚影。`);
    const start = ((await lab.rpc("ping", {}, { retry: true })) as { tick: number }).tick;
    await say(
      `建好了 ${placed.built}/${placed.ghosts} 件。按计算: ${zh("electric-mining-drill")}每秒挖 0.5 个${zh("iron-ore")}, 所以每分钟应出 30 块${zh("iron-plate")}、15 个${zh("iron-gear-wheel")}。`,
    );
    await say("你是管理员: 输入 /c game.speed = 10 可以加速 10 倍, /c game.speed = 1 恢复。每过游戏内 1 分钟我报一次产量。");
    log("蓝图已放好, 开始播报产量 (关掉游戏窗口即结束)");

    let minute = 1;
    while (!closing) {
      await sleep(1000);
      const tick = ((await lab.rpc("ping", {}, { retry: true })) as { tick: number }).tick;
      if (tick - start < minute * 3600) continue;
      const s = (await lab.rpc("score", {}, { retry: true })) as { produced: Record<string, number> };
      const p = (n: string) => s.produced[n] ?? 0;
      await say(
        `第 ${minute} 分钟: ${zh("iron-ore")} ${p("iron-ore")}, ${zh("iron-plate")} ${p("iron-plate")}, ${zh("iron-gear-wheel")} ${p("iron-gear-wheel")} (计算约 ${15 * minute})。`,
      );
      minute++;
    }
  } catch (e) {
    if (!closing) {
      log(`观看模式出错: ${(e as Error).message}`);
      await shutdown();
      throw e;
    }
  }
}
