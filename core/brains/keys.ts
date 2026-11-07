// 本机密钥和账号配置 (库, 不直接运行): data/accounts/keys.json, 不进仓库 (data/ 整个不上传)。
// 字段: anthropic (Console API 密钥) + anthropic_workspace (用户级密钥要的工作区); deepseek; relay_url / relay (中转站站点和令牌) / relay_model / relay_formats (站标的每个模型的接口格式, JSON 文字);
// server / group_servers (联机服务器地址密码, core/run/online-lib.ts 读)。
import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../../game/sandbox/paths.ts";

export const defaultKeysFile = (): string => path.join(dataRoot(), "accounts", "keys.json");

/** 本机存的密钥 {anthropic, deepseek, relay, relay_url, relay_model, …}; 没有文件是 {} */
export function readKeys(file = defaultKeysFile()): Record<string, string> {
  try { const o = JSON.parse(fs.readFileSync(file, "utf8")); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

/** 中转站的几样 (没填的是空串): url 站点、key 令牌、model 默认模型 */
export type RelayConfig = { url: string; key: string; model: string };
export function relayConfig(keys: Record<string, string>): RelayConfig {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { url: cleanUrl(s(keys.relay_url)) ?? "", key: s(keys.relay), model: s(keys.relay_model) };
}

/** 站点地址: 没写协议补 https://, 去掉末尾的 / 和 /v1 (Claude Code 自己会加 /v1); 不是 http(s) 地址 → null */
export function cleanUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t || /\s/.test(t)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname) return null;
  const p = u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "").replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${p}`;
}

/** 站标的每个模型的接口格式 (keys.json 的 relay_formats 是一段 JSON 文字 {模型: [格式]}); 坏了 / 没有 → {} */
export function readRelayFormats(file = defaultKeysFile()): Record<string, string[]> {
  try {
    const o = JSON.parse(readKeys(file).relay_formats ?? "{}");
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).map(String)]));
  } catch { return {}; }
}
