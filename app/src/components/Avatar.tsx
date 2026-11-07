// 头像: 模型厂商的 LOGO。图标来自 LobeHub 的 AI 厂商图标库
// @lobehub/icons-static-svg 1.102.0 (MIT, 见 NOTICE); 商标归各厂商, 这里只用来标出每个角色跑的是哪家的模型。
// 白底圆形: 单色图标 (OpenAI、Grok) 用的是 currentColor, 当图片画出来是黑的, 白底上深色、浅色模式都看得清。认不出厂商时写字母。
// : 补上中转站里常见的几家 (MiniMax、Kimi、豆包、阶跃、通义、Gemini)。
import claude from "@lobehub/icons-static-svg/icons/claude-color.svg";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import grok from "@lobehub/icons-static-svg/icons/grok.svg";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import doubao from "@lobehub/icons-static-svg/icons/doubao-color.svg";
import stepfun from "@lobehub/icons-static-svg/icons/stepfun-color.svg";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import { VENDOR_NAME, type Vendor } from "../logic.ts";

const LOGO: Record<Vendor, string> = { claude, openai, grok, deepseek, glm: zhipu, minimax, kimi, doubao, stepfun, qwen, gemini };

/** state = 右下角的状态点 (在干活 / 等你 / 闲着; 别的不画); me = "我" (你自己, 蓝底) */
export function Avatar({ vendor, text, state, size, title, me }: {
  vendor: Vendor | null; text: string; state?: string | null; size?: "small" | "chat"; title?: string; me?: boolean;
}) {
  const cls = ["avatar", size, vendor ? "logo" : null, me ? "me" : null].filter(Boolean).join(" ");
  return (
    <span className={cls} data-state={state ?? undefined} title={title}>
      {vendor ? <img src={LOGO[vendor]} alt={VENDOR_NAME[vendor]} draggable={false} /> : text}
    </span>
  );
}
