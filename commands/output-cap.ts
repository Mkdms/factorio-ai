// 工具输出封顶 (库, 不直接运行; 省 token: 旧项目账本里一次 28k 的 help、10~15k 的 science / inspect 一次就把上下文撑大, 之后每次请求都带着)。
// 超过上限就留头留尾、中间省略, 并提示怎么缩小范围; 不用 head / tail 截 (会丢报错和队友消息)。
export const FH_MAX_OUTPUT = 9000;

/** 文本超过 max 个字就只留前 head、后 tail 个字, 中间一行说明 */
export function capOutput(text: string, max = FH_MAX_OUTPUT, head = Math.floor(max * 0.8), tail = Math.floor(max * 0.15)): string {
  if (text.length <= max) return text;
  const cutHead = text.slice(0, head), cutTail = text.slice(-tail);
  const skipped = text.length - cutHead.length - cutTail.length;
  return `${cutHead}\n…(中间省略 ${skipped} 个字: 输出太长会占满上下文; 用 --args 缩小范围 / 换更具体的命令, 要看中段再用 | sed -n '起,止p')…\n${cutTail}`;
}
