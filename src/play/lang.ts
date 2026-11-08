// 大脑说的话是不是英文 (库; 监工提醒用)。用户: 全程中文 (多次抱怨"又变成英文"); 第十三轮接续第 1 班头 10 分钟 9 句里 8 句英文。
// 只看去掉代码 (`...`)、内部名 (transport-belt、iron_plate)、坐标后的字母: 几乎没有汉字、字母够一句话 → 英文。夹着英文名词的中文句子不算。
export function isEnglish(text: string): boolean {
  const t = text.replace(/`[^`]*`/g, " ").replace(/\b[a-z0-9]+(?:[-_][a-z0-9]+)+\b/gi, " ").replace(/\(?-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\)?/g, " ");
  const han = (t.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  return han < 2 && latin >= 8;
}

/** 一段话里有没有整句英文: 按行和句末标点切开逐句看 (2026-11-08 装模组连续班: "先补煤。Now the refuel tour (…)." 这种中英混在一段里的, 整段看算中文, 一直漏) */
export function hasEnglishSentence(text: string): boolean {
  const noCode = text.replace(/`[^`]*`/g, " ");
  return noCode.split(/\r?\n|(?<=[.!?。！？])\s*/).some((s) => s.trim() && isEnglish(s));
}

/**
 * 每个角色的英文计数: 记一段话, 返回要不要提醒 (window 内 ≥ n 段带英文句, 且离上次提醒 ≥ gap)。
 * 2026-11-08 起 3 句 / 5 分钟 → 2 段 / 5 分钟、隔 3 分钟, 提醒后不清零: 原来提醒一次就清零, 同一班后面又说英文也不再提醒 (一班 5/21 句英文只提醒了 1 次)。
 */
export class EnglishWatch {
  total = 0; english = 0;
  private recent: number[] = [];
  private lastNudge = -Infinity;
  private n: number; private windowMs: number; private gapMs: number;
  constructor(n = 2, windowMs = 300_000, gapMs = 180_000) { this.n = n; this.windowMs = windowMs; this.gapMs = gapMs; }
  note(text: string, now = Date.now()): boolean {
    this.total++;
    if (!hasEnglishSentence(text)) return false;
    this.english++;
    this.recent = [...this.recent.filter((t) => now - t < this.windowMs), now];
    if (this.recent.length < this.n || now - this.lastNudge < this.gapMs) return false;
    this.lastNudge = now;
    return true;
  }
}
