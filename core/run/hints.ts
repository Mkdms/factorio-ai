// 要点提示 (库, 不直接运行): 把 training/knowledge/verified/points.md 里核实过的要点按"眼下的情况"挑出来, 附在开班扫描 (和以后的监工点名) 后面 —— 被动推送, 不等模型自己去查。
// 要点文字只有一个家 (points.md), 这里只按出处标签挑。
export type Hint = { title: string; when: RegExp; tags: string[] };
export const HINTS: Hint[] = [
  { title: "研究中心停", when: /研究中心.*(停|只有|缺|空)|没有在研究/, tags: ["P-mind-01", "P-prod-21"] },
  { title: "缺燃料", when: /燃料/, tags: ["P-ops-fuel"] },
  { title: "采空", when: /采空/, tags: ["P-prog-09"] },
  { title: "堵", when: /堵|出口满|尽头/, tags: ["P-logi-12", "P-prod-21"] },
  { title: "缺料", when: /缺料|缺(铁|铜|板|齿轮|电路|瓶)/, tags: ["P-prod-22", "P-prod-23"] },
  { title: "加炉子", when: /加炉子|冶炼|炉子不够|furnace/i, tags: ["P-prod-01", "P-style-01"] },
  { title: "加组装机", when: /加 .* 的机器|组装机|assembl/i, tags: ["P-prod-01", "P-prod-04"] },
  { title: "没扩产", when: /没新增|产量没达标|扩产|产量比上一班低/, tags: ["P-prod-01", "P-prod-04", "P-mind-01"] },
  { title: "闲着", when: /闲了|站着|空闲|出生点/, tags: ["P-mind-01", "P-prod-23"] },
  { title: "缺电", when: /缺电|发电不够|没接上/, tags: ["P-ops-power"] },
  { title: "新线", when: /下一档|新线|蓝瓶|石油|塑料/, tags: ["P-prod-01", "P-logi-12"] },
  { title: "刚开局", when: /刚开局|从零开始|新地图/, tags: ["P-mind-01", "P-prod-01"] },
];

/** points.md 里带这些出处标签的要点 (每条一行, 去掉开头的 "- ") */
export function pointsByTags(md: string, tags: string[]): string[] {
  const out: string[] = [];
  for (const l of md.replace(/\r\n/g, "\n").split("\n")) {
    if (!/^\s*-\s/.test(l)) continue;
    const t = l.replace(/^\s*-\s*/, "").trim();
    if (tags.some((g) => t.includes(g)) && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 这些句子 (扫描的判断、体检、点名) 对得上的要点; 没对上就空 */
export function hintsForLines(md: string, lines: string[], max = 4): string[] {
  const out: string[] = [];
  for (const h of HINTS) {
    if (!lines.some((l) => h.when.test(l))) continue;
    for (const p of pointsByTags(md, h.tags)) if (out.length < max && !out.includes(p)) out.push(p);
  }
  return out;
}

/** 一句话版 (接在监工私信后面): 最多 n 条, 没有就空串 */
export function hintLine(md: string, lines: string[], n = 2): string {
  const h = hintsForLines(md, lines, n);
  return h.length ? `要点 (我们核实过的经验, 出处在括号里): ${h.join(" ‖ ")}` : "";
}
