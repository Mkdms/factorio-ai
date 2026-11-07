// 沙盘演示: 建新图 → 放一张小产线的蓝图 → 加速跑 N 分钟 → 用游戏自带的 production-score 读产量。
// 演示蓝图: 电力采矿机 → 电炉 → 电力机械臂 → 组装机2型 (铁齿轮) → 电力机械臂 → 钢箱; 电由电力接口 (沙盘专用的隐藏建筑) 供给。
import { SandboxServer } from "./server.ts";
import { encodeBlueprint, mapVersion, Dir, type BlueprintEntity } from "../blueprint.ts";

/** poleCopper = defines.wire_connector_id.pole_copper 的值 (从游戏读, 不写死) */
export function demoBlueprint(gameVersion: string, poleCopper: number): string {
  const e = (name: string, x: number, y: number, extra: Partial<BlueprintEntity> = {}): Omit<BlueprintEntity, "entity_number"> => ({ name, position: { x, y }, ...extra });
  const list = [
    e("electric-mining-drill", -1.5, -1.5, { direction: Dir.south }),
    e("electric-furnace", -1.5, 1.5),
    e("inserter", -1.5, 3.5, { direction: Dir.north }), // 机械臂方向 = 取货方向 (2.1.24 实测)
    e("assembling-machine-2", -1.5, 5.5, { recipe: "iron-gear-wheel" }),
    e("inserter", -1.5, 7.5, { direction: Dir.north }),
    e("steel-chest", -1.5, 8.5),
    e("medium-electric-pole", 0.5, -1.5),
    e("medium-electric-pole", 0.5, 3.5),
    e("medium-electric-pole", 0.5, 7.5),
    e("electric-energy-interface", 2, 0),
  ];
  const entities = list.map((x, i) => ({ entity_number: i + 1, ...x }) as BlueprintEntity);
  // 复活出来的电线杆不会自动连线 (2.1.24 实测), 铜线要写进蓝图: [实体, 接点, 实体, 接点]
  const wires = [
    [7, poleCopper, 8, poleCopper],
    [8, poleCopper, 9, poleCopper],
  ];
  return encodeBlueprint({ blueprint: { item: "blueprint", label: "sandbox demo: ore -> plate -> gear", entities, wires, version: mapVersion(gameVersion) } });
}

export interface DemoResult {
  instance: string;
  ticks: number;
  wallSeconds: number;
  placed: { ghosts: number; built: number; failed_count: number; offset?: { x: number; y: number } };
  produced: Record<string, number>;
  consumed: Record<string, number>;
  productionScore: number;
}

export async function runDemo(name: string, opts: { minutes?: number; seed?: number; speed?: number; log?: (s: string) => void } = {}): Promise<DemoResult> {
  const { minutes = 10, seed = 20261107, speed = 1000, log = () => undefined } = opts;
  const lab = new SandboxServer({ name, label: `演示: 电力采矿机 → 电炉 → 组装机2型 (铁齿轮), 加速跑 ${minutes} 分钟` });
  const t0 = Date.now();
  try {
    await lab.createMap("demo", { seed });
    log(`${name}: 新图已建好`);
    const ping = (await lab.start("demo")) as { base: string };
    log(`${name}: 服务器已启动 (RCON ${lab.rconPort}, UDP ${lab.udpPort})`);
    await lab.rpc("prepare_area", { area: [[-12, -12], [12, 12]], resource: { name: "iron-ore", amount: 1_000_000, area: [[-3, -3], [0, 0]] }, no_enemies: true });
    const poleCopper = (await lab.exec("return defines.wire_connector_id.pole_copper")) as number;
    const placed = (await lab.rpc("place_blueprint", { string: demoBlueprint(ping.base, poleCopper), position: [0, 0] })) as DemoResult["placed"];
    log(`${name}: 蓝图 ${placed.built}/${placed.ghosts} 件已建成, 失败 ${placed.failed_count}`);
    await lab.say(`蓝图建好 ${placed.built}/${placed.ghosts} 件。按计算每分钟约 30 块铁板、15 个铁齿轮。`);
    const ticks = Math.round(minutes * 60 * 60);
    const end = (await lab.runTicks(ticks, speed)) as { tick: number };
    log(`${name}: 跑完 ${ticks} 个 tick (游戏内 ${minutes} 分钟), 现在 tick ${end.tick}`);
    const score = (await lab.rpc("score", {})) as { production_score: number; produced: Record<string, number>; consumed: Record<string, number> };
    await lab.say(`跑完游戏内 ${minutes} 分钟: 铁矿 ${score.produced["iron-ore"] ?? 0}, 铁板 ${score.produced["iron-plate"] ?? 0}, 铁齿轮 ${score.produced["iron-gear-wheel"] ?? 0} (计算约 ${15 * minutes})。`);
    return { instance: name, ticks, wallSeconds: (Date.now() - t0) / 1000, placed, produced: score.produced, consumed: score.consumed, productionScore: score.production_score };
  } finally {
    await lab.stop({ save: false });
  }
}
