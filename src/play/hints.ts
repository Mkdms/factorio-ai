// 要点提示 (库, 不直接运行): 把 knowledge/brief-points.md 里核实过的要点按"眼下的情况"挑出来, 附在开班扫描和监工点名后面 ——
// 被动推送, 不等大脑自己去查 (这班 20 分钟 4 个角色查 pilot-* 主题 0 次)。
// 要点文字只有一个家 (brief-points.md), 这里只按出处标签挑; 蓝图候选从 ./bp list 来 (用不用、放哪由大脑定, 架构 2b)。

/** when: 扫描 / 体检 / 点名的句子匹配上就挑这条; tags: brief-points.md 里要点末尾的出处标签; bp: ./bp list 的关键词 (按实体内部名筛) */
export type Hint = { title: string; when: RegExp; tags: string[]; bp?: string };
export const HINTS: Hint[] = [
  { title: "研究中心停", when: /研究中心.*(停|只有|缺|空)|没有在研究/, tags: ["P-mind-01", "P-prod-21"] },
  { title: "缺燃料", when: /燃料/, tags: ["P-ops-fuel"] },
  { title: "采空", when: /采空/, tags: ["P-prog-09"] },
  { title: "堵", when: /堵|出口满|尽头/, tags: ["P-logi-12", "P-prod-21"] },
  { title: "缺料", when: /缺料|缺(铁|铜|板|齿轮|电路|瓶)/, tags: ["P-prod-22", "P-prod-23"] },
  { title: "加炉子", when: /加炉子|冶炼|炉子不够|furnace/i, tags: ["P-prod-01", "P-style-01"], bp: "furnace" },
  { title: "加组装机", when: /加 .* 的机器|组装机|assembl/i, tags: ["P-prod-01", "P-prod-04"], bp: "assembling" },
  { title: "没扩产", when: /没新增|产量没达标|扩产|产量比上一班低/, tags: ["P-prod-01", "P-prod-04", "P-mind-01"] },
  { title: "闲着", when: /闲了|站着|空闲|出生点/, tags: ["P-mind-01", "P-prod-23"] },
  { title: "缺电", when: /缺电|发电不够|没接上/, tags: ["P-ops-power"] },
  { title: "新线", when: /下一档|新线|蓝瓶|石油|塑料/, tags: ["P-prod-01", "P-logi-12"] },
];

/** brief-points.md 里带这些出处标签的要点 (每条一行, 去掉开头的 "- ") */
export function pointsByTags(md: string, tags: string[]): string[] {
  const out: string[] = [];
  for (const l of md.replace(/\r\n/g, "\n").split("\n")) {
    if (!/^\s*-\s/.test(l)) continue;
    const t = l.replace(/^\s*-\s*/, "").trim();
    if (tags.some((g) => t.includes(g)) && !out.includes(t)) out.push(t);
  }
  return out;
}

export type HintOpts = { /** ./bp list 关键词 → 候选行 (run.ts 给 bp.ts 的 listLines; 测试给假的) */ bp?: (kw: string) => string[]; /** 最多几条要点 (蓝图候选另算一行) */ max?: number };

/** 这些句子 (扫描的判断 / 规划、体检、点名) 对得上的要点 + 蓝图候选; 没对上就空 */
export function hintsForLines(md: string, lines: string[], opts: HintOpts = {}): string[] {
  const max = opts.max ?? 4;
  const out: string[] = [];
  const bpSeen = new Set<string>();
  for (const h of HINTS) {
    if (!lines.some((l) => h.when.test(l))) continue;
    for (const p of pointsByTags(md, h.tags)) if (out.length < max && !out.includes(p)) out.push(p);
    if (h.bp && opts.bp && !bpSeen.has(h.bp)) {
      bpSeen.add(h.bp);
      const rows = opts.bp(h.bp).slice(0, 3);
      if (rows.length) out.push(`蓝图库里有实测过的块 (./bp list ${h.bp} 看全部, ./bp show 编号 看喂料和产量; 用不用、放哪你定): ${rows.join(" / ")}`);
    }
  }
  return out;
}

/** 一句话版 (接在监工私信后面): 最多 n 条, 没有就空串 */
export function hintLine(md: string, lines: string[], n = 2, bp?: (kw: string) => string[]): string {
  const h = hintsForLines(md, lines, { max: n, bp });
  return h.length ? `要点 (我们核实过的经验, 出处在括号里): ${h.join(" ‖ ")}` : "";
}
