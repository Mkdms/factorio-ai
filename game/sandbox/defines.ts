// 游戏的 defines 对照表 (库): defines.entity_status 等枚举的"名字 → 数字"。API 文件 (runtime-api.json) 只有名字和 order, 没有数值;
// 联机时客户端没有 RCON 也读不到 → 从本机同版本的游戏 (无界面沙盘) 读一次存成 lab-data/prototypes/<版本>/defines.json。
// 联机时客户端和服务器必须是同一个版本, 所以本机导出的就是服务器上的数值 (旧项目 docs/io-client.md 第 11b 节 T6: 注入客户端的程序 只给数字, 名字要我们这层给)。
// 和铁轨几何 (src/blueprint/rail-geometry.ts) 一样, 在 dump-data 时导出。
import fs from "node:fs";
import path from "node:path";

/** defines 里每一张"名字 → 数字"的平表 (嵌套的、不是数字的跳过) */
export type Defines = Record<string, Record<string, number>>;

export const definesFile = (protoDir: string) => path.join(protoDir, "defines.json");

/** 在跑着的沙盘里读 defines (lab = LabInstance, 只用它的 exec) */
export async function deriveDefines(lab: { exec(code: string): Promise<unknown> }, protoDir: string): Promise<Defines> {
  const d = (await lab.exec(`local out = {}
    for k, t in pairs(defines) do
      if type(t) == "table" then
        local m, n = {}, 0
        for name, v in pairs(t) do if type(v) == "number" then m[name] = v n = n + 1 end end
        if n > 0 then out[k] = m end
      end
    end
    return out`)) as Defines;
  if (!d?.entity_status || typeof d.entity_status !== "object") throw new Error("沙盘没读到 defines.entity_status");
  fs.mkdirSync(protoDir, { recursive: true });
  fs.writeFileSync(definesFile(protoDir), JSON.stringify(d));
  return d;
}

export function loadDefines(protoDir: string): Defines | null {
  try { return JSON.parse(fs.readFileSync(definesFile(protoDir), "utf8")) as Defines; } catch { return null; }
}

/** 数字 → 名字 (例: entity_status 31 → "no_ingredients"); 表里没有返回 null */
export function defineName(defs: Defines | null, table: string, value: number): string | null {
  const t = defs?.[table];
  if (!t) return null;
  for (const [name, v] of Object.entries(t)) if (v === value) return name;
  return null;
}
