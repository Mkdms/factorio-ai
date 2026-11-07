// 大脑接口警报 (库, 不直接运行): 某个角色的大脑 (中转站 / DeepSeek / Claude …) 调不通时记一条,
// 界面读到新的就弹窗。两处来源: run.ts 开班前给每个非 Claude 订阅的角色发一句试通 (kind = probe), 和每轮结束时 Claude Code 的 result 带 API 错误 (kind = api)。
// 记在 <班次目录>/alerts.jsonl, 控制接口 /api/state 带最近 20 条 (alerts); 界面按 at|agent 记"看过了" (localStorage), 没看过的弹。
import fs from "node:fs";
import path from "node:path";

/** kind: probe = 开班试通失败, api = 轮次报 API 错误, tool = 大脑说工具坏了 / 缺工具 (2026-11-05) */
export type Alert = { at: string; agent: string; name: string; brain: string; model: string; kind: "probe" | "api" | "tool"; text: string };

/** 大脑回的文字是不是接口层的失败 (不是游戏里的失败): HTTP 4xx / 5xx、API Error、连不上、密钥 / 余额问题 */
export const isApiFailure = (text: string): boolean =>
  /API Error|Unsupported parameter|\bHTTP (4\d\d|5\d\d)\b|\b(400|401|402|403|404|408|429|500|502|503|504)\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|rate limit|invalid (api )?key|authentication|unauthorized|insufficient.*(balance|quota|credits)|余额不足|额度不足|令牌|not_found_error|overloaded/i.test(text);

export const alertsFile = (runDir: string) => path.join(runDir, "alerts.jsonl");
export const alertKey = (a: { at: string; agent: string }) => `${a.at}|${a.agent}`;

export function appendAlert(runDir: string, a: Alert): void {
  fs.appendFileSync(alertsFile(runDir), JSON.stringify(a) + "\n");
}
/** 最近 max 条 (旧的在前); 没有文件 → [] */
export function readAlerts(runDir: string, max = 20): Alert[] {
  let text = "";
  try { text = fs.readFileSync(alertsFile(runDir), "utf8"); } catch { return []; }
  const out: Alert[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o.at === "string" && typeof o.text === "string") out.push(o); } catch { /* 坏行跳过 */ }
  }
  return out.slice(-max);
}

/** 同一角色同样的话 10 分钟内只记一次 (一轮轮失败会刷屏) */
export class AlertDedupe {
  private last = new Map<string, number>();
  private windowMs: number;
  constructor(windowMs = 10 * 60_000) { this.windowMs = windowMs; } // 不用参数属性写法: Node 的 strip-only TypeScript 不支持
  should(agent: string, text: string, now = Date.now()): boolean {
    const k = `${agent}|${text.slice(0, 120)}`;
    const t = this.last.get(k);
    if (t !== undefined && now - t < this.windowMs) return false;
    this.last.set(k, now);
    return true;
  }
}
