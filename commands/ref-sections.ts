// 手册按段查 (库, 不直接运行; commands/fh.ts 调): ./fh help 主题 太大就回目录, ./fh help 主题 3 或 ./fh help 主题 P-prod-03 回一段。
// 手册单份 24~94KB, 整份输出被封顶砍掉中间, 读一次占很多上下文。不复制文件: 文字只有一个家。
import fs from "node:fs";
import path from "node:path";

export type Section = { title: string; line: number; lines: number; text: string };

/** 按 ## 和 ### 切段: 第一个标题之前的算"开头"; 太碎的合进上一段 (小于 300 字) */
export function splitSections(md: string, minChars = 300): Section[] {
  const rows = md.replace(/\r\n/g, "\n").split("\n");
  const out: Section[] = [];
  let cur: { title: string; line: number; rows: string[] } = { title: "开头", line: 1, rows: [] };
  const push = () => {
    const text = cur.rows.join("\n").trim();
    if (!text) return;
    const last = out.at(-1);
    if (last && text.length < minChars && !/^#{2,3} /.test(text)) { last.text += `\n${text}`; last.lines += cur.rows.length; return; }
    out.push({ title: cur.title, line: cur.line, lines: cur.rows.length, text });
  };
  rows.forEach((l, i) => {
    const m = /^#{2,3} +(.+)$/.exec(l);
    if (m) { push(); cur = { title: m[1].trim(), line: i + 1, rows: [l] }; } else cur.rows.push(l);
  });
  push();
  return out;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** 目录: 每段一行 (序号、标题、大小) */
export function tocText(topic: string, md: string, maxLines = 70): string {
  const secs = splitSections(md);
  const rows = secs.slice(0, maxLines).map((s, i) => `${i + 1}. ${clip(s.title, 60)} (${s.text.length} 字)`);
  return [`${topic} 共 ${md.length} 字 ${secs.length} 段, 整份读太占上下文, 只看要的那段: ./fh help ${topic} 序号 或 ./fh help ${topic} 关键词; 按问题找: ./know 关键词`, ...rows, ...(secs.length > maxLines ? [`…还有 ${secs.length - maxLines} 段, 用关键词查`] : [])].join("\n");
}

/** 一段: 序号或标题里的关键词 (P-prod-03、燃料); 找不到 null */
export function sectionText(topic: string, md: string, what: string, cap = 9000): string | null {
  const secs = splitSections(md);
  const n = /^\d+$/.test(what) ? Number(what) : 0;
  const i = n ? n - 1 : secs.findIndex((s) => s.title.toLowerCase().includes(what.toLowerCase()));
  const hit = secs[i];
  if (!hit) return null;
  const head = `${topic} 第 ${i + 1}/${secs.length} 段${i + 1 < secs.length ? ` (下一段: ./fh help ${topic} ${i + 2})` : ""}`;
  const body = cap > 0 && hit.text.length > cap ? `${hit.text.slice(0, cap)}\n…(这段太长, 后面还有 ${hit.text.length - cap} 字; 用 Read ref/${topic}.md offset=${hit.line} 接着看)` : hit.text;
  return `${head}\n${body}`;
}

/** ./fh help 主题 [段] 由这里答就回文字; 交给命令行 (不是手册文件 / 够小) 回 null */
export function manualAnswer(refDir: string, topic: string, what: string | undefined, cap: number): string | null {
  if (!/^[\w.-]+$/.test(topic)) return null;
  const f = path.join(refDir, `${topic}.md`);
  if (!fs.existsSync(f)) return null;
  const md = fs.readFileSync(f, "utf8");
  if (what) return sectionText(topic, md, what, cap) ?? `${topic} 里没有 "${what}" 这一段。\n${tocText(topic, md)}`;
  if (cap > 0 && md.length > cap) return tocText(topic, md);
  return null;
}
