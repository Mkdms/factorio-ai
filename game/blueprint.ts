// 蓝图字符串编解码: 版本字节 "0" + base64(zlib(JSON))。
import zlib from "node:zlib";

export interface BlueprintEntity {
  entity_number: number;
  name: string;
  position: { x: number; y: number };
  /** 2.0 起是 16 方向: 北 0, 东 4, 南 8, 西 12 */
  direction?: number;
  recipe?: string;
  [k: string]: unknown;
}

export interface Blueprint {
  item: "blueprint";
  label?: string;
  entities?: BlueprintEntity[];
  tiles?: { name: string; position: { x: number; y: number } }[];
  version?: number;
  [k: string]: unknown;
}

export const Dir = { north: 0, east: 4, south: 8, west: 12 } as const;

/** 游戏版本号 a.b.c.d 编成蓝图里的 64 位版本 (每段 16 位) */
export function mapVersion(v: string): number {
  const [a = 0, b = 0, c = 0, d = 0] = v.split(".").map(Number);
  return ((a * 65536 + b) * 65536 + c) * 65536 + d;
}

export function encodeBlueprint(obj: { blueprint: Blueprint } | Record<string, unknown>): string {
  return "0" + zlib.deflateSync(Buffer.from(JSON.stringify(obj), "utf8"), { level: 9 }).toString("base64");
}

export function decodeBlueprint(s: string): Record<string, unknown> {
  const t = s.trim();
  if (t[0] !== "0") throw new Error(`不认识的蓝图版本字节: ${t[0]}`);
  return JSON.parse(zlib.inflateSync(Buffer.from(t.slice(1), "base64")).toString("utf8"));
}

/** helpers.encode_string 的结果 (base64 + deflate) 解回原文 */
export function decodeGameString(s: string): string {
  const b = Buffer.from(s, "base64");
  try {
    return zlib.inflateSync(b).toString("utf8");
  } catch {
    return zlib.inflateRawSync(b).toString("utf8");
  }
}
