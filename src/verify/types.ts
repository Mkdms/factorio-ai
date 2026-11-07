// M2 核实: 一个实验 = 一条说法 + 出处 + 在沙盘里怎么测 + 怎么判。
import type { LabInstance } from "../lab/instance.ts";

export interface Source {
  /** 来源说明, 例: "官方 wiki 物流网" / "本机原型数据 entities.lua" */
  title: string;
  url?: string;
  /** 资料日期 (wiki 最后编辑日、帖子日期) */
  date?: string;
  /** 可信度: 1 本机游戏自带, 2 官方, 3 老玩家社区, 4 视频 */
  credibility: 1 | 2 | 3 | 4;
}

export type Verdict = "verified" | "refuted" | "inconclusive";

export interface Outcome {
  verdict: Verdict;
  /** 一两句中文结论, 带实测数字 */
  summary: string;
  measured: Record<string, unknown>;
}

export interface Experiment {
  /** 唯一编号, 也是知识库里的事实编号 */
  id: string;
  /** 主题: 物流网 / 火车 / 电 / 腐坏 / 生物室 / 传送带 / 机械臂 ... */
  topic: string;
  /** 要核实的说法 (中文, 用游戏官方中文名) */
  claim: string;
  /** 关联: 检索编号 (如 "logistics.md L1") 和第一版教训 (如 "lessons-v1 #3") */
  refs: string[];
  sources: Source[];
  /** 在哪个地表上做, 默认新地星 nauvis */
  surface?: "nauvis" | "gleba" | "vulcanus" | "fulgora" | "aquilo";
  /** 预计游戏内时长 (秒), 只用于提示 */
  gameSeconds?: number;
  /** 故意测"没电"的实验设为 true; 否则框架在出结论时自动查实验区, 有没电的就把结论作废 */
  allowUnpowered?: boolean;
  /** 布局检查 (静态检查器扫实验区) 里允许的类别, 例: 故意让机械臂对着空地时写 ["inserter-empty-target"]; 默认全查 */
  allowLayout?: string[];
  /** 开测前允许出现的机器状态 (对照组故意不给燃料 / 故意冻住等), 例: ["no_fuel", "frozen"]; 其他不对的状态在打开拦截后会让实验不测量 (2026-11-02) */
  allowStatus?: string[];
  run(ctx: ExpContext): Promise<Outcome>;
}

export interface ExpContext {
  lab: LabInstance;
  /** 本实验独占区域的中心 (区域 ±20 格已清空、铺好地砖) */
  x: number;
  y: number;
  surface: string;
  /** 执行 Lua; 代码里用 `local a = ...` 取 args, args 里自动带上 x、y、surface */
  lua(code: string, args?: Record<string, unknown>): Promise<unknown>;
  /** 精确跑 n 个 tick */
  ticks(n: number): Promise<void>;
  /** 在游戏聊天里说一句 */
  say(text: string): Promise<void>;
  /** 内部名 → 官方中文名 (给人看的结论里一律用中文名) */
  zh(name: string): string;
  /** 一键给整块实验区铺电网 (四角广域配电站 + 电力接口); 需要独立电网的实验自己摆, 但都要过 powered() */
  power(): Promise<{ poles: { x: number; y: number }[]; eei: { x: number; y: number } }>;
  /** 测量前的强制检查: 实验区 (含 watch 登记的区域) 里用电的东西有没有没电的; 有就抛错 (带名字和位置) */
  powered(): Promise<void>;
  /** 实验在默认 ±20 区域之外另开的场地要登记, 供电检查 (powered 和框架出结论前的自动检查) 才扫得到 (雷达没电那次就是没登记) */
  watch(area: [[number, number], [number, number]]): void;
}
