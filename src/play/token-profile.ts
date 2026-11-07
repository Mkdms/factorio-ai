// token 账本 (库, 不直接运行):
// 从一班的 turn-*.jsonl (Claude 形状的 stream-json; Grok / Codex / Gemini 的已翻译) 算: 每个角色发了多少次请求 (= 不同 message.id 的 assistant 消息, 每次都把整个上下文发一遍)、
// 每次请求的上下文 (input + 缓存读 + 缓存写)、缓存命中、输出; 每种命令 (./fh call X / ./calc / ./bp / cat / Read…) 调了几次、回复多大; 连续重复同一条查询 (轮询) 有多少。
// 结论用来挑省 token 的杠杆: 减请求次数 (合并命令、少轮询、监工少插话)、缩上下文、提缓存命中; 不换模型。
export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
export type ToolStat = { count: number; resultBytes: number; maxResultBytes: number };
export type AgentProfile = {
  requests: number; usage: Usage; turns: number;
  /** 每种命令族: 调用次数 (一条 Bash 串几个 ./fh 算几次) 和回复字节 (整条 Bash 的回复记在第一个命令族上, 串联的另记 chain) */
  tools: Record<string, ToolStat>;
  /** Bash 调用次数、其中串了 2 个以上 ./fh 的次数 */
  bash: number; bashChained: number;
  /** 和上一条 Bash 完全相同的命令 (轮询) */
  repeats: number;
  textBlocks: number; thinkingBlocks: number;
  /** 回复最大的 8 次工具调用 (命令 / 文件 + 字节), 看哪些该截短 */
  biggest: { what: string; bytes: number }[];
};

const zeroUsage = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
export const newProfile = (): AgentProfile => ({ requests: 0, usage: zeroUsage(), turns: 0, tools: {}, bash: 0, bashChained: 0, repeats: 0, textBlocks: 0, thinkingBlocks: 0, biggest: [] });

/** 一条 Bash 命令里的命令族: 去掉开头的 cd, 按 && / ; / | 切, 每段取 "./fh call X" / "./fh help" / "./calc" / "./bp X" / 第一个词 */
export function commandFamilies(cmd: string): string[] {
  const out: string[] = [];
  for (const raw of cmd.split(/&&|;|\|\||\n/)) {
    const seg = raw.trim().replace(/^\(+/, "");
    if (!seg || /^cd\s/.test(seg) || seg === ")") continue;
    const s = seg.split("|")[0].trim(); // 管道后面的 head / grep 不算
    let m: RegExpExecArray | null;
    if ((m = /^(?:\.?\/?|\.\\)fh(?:\.cmd)?\s+call\s+([A-Za-z_][\w-]*)/.exec(s))) out.push(`fh ${m[1]}`);
    else if (/^(?:\.?\/?|\.\\)fh(?:\.cmd)?\s+help\b/.test(s)) out.push("fh help");
    else if ((m = /^(?:\.?\/?|\.\\)fh(?:\.cmd)?\s+([A-Za-z_][\w-]*)/.exec(s))) out.push(`fh:${m[1]}`); // call / help 之外的子命令 (chat / tell / wait / cmd…)
    else if (/^(?:\.?\/?|\.\\)fh(?:\.cmd)?\s*$/.test(s)) out.push("fh:(无参数)");
    else if (/^(?:\.?\/?|\.\\)calc(?:\.cmd)?\b/.test(s)) out.push("calc");
    else if ((m = /^(?:\.?\/?|\.\\)bp(?:\.cmd)?\b\s*([A-Za-z-]*)/.exec(s))) out.push(`bp${m[1] ? " " + m[1] : ""}`);
    else out.push(s.split(/\s+/)[0].replace(/^["']|["']$/g, "").slice(0, 24));
  }
  return out.length ? out : ["(空)"];
}

/** 一班一个角色的 turn 文件内容 (多个文件就都喂进来, 每个文件算一轮) → 账本 */
export function profileTurns(files: string[][]): AgentProfile {
  const p = newProfile();
  const seen = new Set<string>();
  const toolFamily = new Map<string, string>(); // tool_use_id → 记回复字节的命令族
  const toolWhat = new Map<string, string>(); // tool_use_id → 给人看的命令 / 文件
  let lastBash = "";
  for (const lines of files) {
    p.turns++;
    for (const line of lines) {
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "assistant" && o.message) {
        const id = String(o.message.id ?? "");
        const u = o.message.usage ?? {};
        if (id && !seen.has(id)) {
          seen.add(id); p.requests++;
          p.usage.input += num(u.input_tokens); p.usage.cacheRead += num(u.cache_read_input_tokens); p.usage.cacheWrite += num(u.cache_creation_input_tokens); p.usage.output += num(u.output_tokens);
        }
        for (const b of Array.isArray(o.message.content) ? o.message.content : []) {
          if (b.type === "text") p.textBlocks++;
          else if (b.type === "thinking") p.thinkingBlocks++;
          else if (b.type === "tool_use") {
            const name = String(b.name ?? "?");
            if (name === "Bash") {
              const cmd = String(b.input?.command ?? "");
              const fams = commandFamilies(cmd);
              const norm = cmd.replace(/\s+/g, " ").trim();
              if (norm && norm === lastBash) p.repeats++;
              lastBash = norm;
              p.bash++;
              const fhCount = fams.filter((f) => f.startsWith("fh ")).length;
              if (fhCount >= 2) p.bashChained++;
              for (const f of fams) bump(p.tools, f, 0);
              toolFamily.set(String(b.id ?? ""), fams.length > 1 ? `chain(${fams[0]}+${fams.length - 1})` : fams[0]);
              toolWhat.set(String(b.id ?? ""), norm.replace(/^cd\s+"[^"]*"\s*&&\s*/, "").slice(0, 90));
            } else {
              bump(p.tools, name, 0);
              toolFamily.set(String(b.id ?? ""), name);
              toolWhat.set(String(b.id ?? ""), `${name} ${String(b.input?.file_path ?? b.input?.pattern ?? b.input?.path ?? "").split(/[\\/]/).slice(-2).join("/")}`.slice(0, 90));
            }
          }
        }
      } else if (o.type === "user" && o.message) {
        for (const b of Array.isArray(o.message.content) ? o.message.content : []) {
          if (b.type !== "tool_result") continue;
          const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
          const fam = toolFamily.get(String(b.tool_use_id ?? "")) ?? "?";
          const bytes = Buffer.byteLength(text, "utf8");
          bump(p.tools, fam, bytes, true);
          p.biggest.push({ what: toolWhat.get(String(b.tool_use_id ?? "")) ?? fam, bytes });
          p.biggest.sort((x, y) => y.bytes - x.bytes).splice(8);
        }
      }
    }
  }
  return p;
}

function bump(tools: Record<string, ToolStat>, fam: string, bytes: number, resultOnly = false) {
  const t = (tools[fam] ??= { count: 0, resultBytes: 0, maxResultBytes: 0 });
  if (!resultOnly) t.count++;
  t.resultBytes += bytes;
  if (bytes > t.maxResultBytes) t.maxResultBytes = bytes;
}
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** 汇总几行给人看的结论 */
export function profileLines(p: AgentProfile, realMinutes: number): string[] {
  const ctx = p.usage.input + p.usage.cacheRead + p.usage.cacheWrite;
  const perReq = p.requests ? ctx / p.requests : 0;
  const hit = ctx ? p.usage.cacheRead / ctx : 0;
  const perHour = realMinutes ? p.requests / (realMinutes / 60) : 0;
  const byCount = Object.entries(p.tools).filter(([k]) => !k.startsWith("chain(")).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  const byBytes = Object.entries(p.tools).sort((a, b) => b[1].resultBytes - a[1].resultBytes).slice(0, 6);
  return [
    `请求 ${p.requests} 次 (${perHour.toFixed(0)} 次/小时), ${p.turns} 轮; 每次请求上下文 ${(perReq / 1000).toFixed(1)}k (缓存命中 ${(hit * 100).toFixed(0)}%, 缓存写 ${(p.usage.cacheWrite / 1e6).toFixed(2)}M), 输出共 ${(p.usage.output / 1e3).toFixed(0)}k`,
    `Bash ${p.bash} 次 (串 2 个以上 ./fh 的 ${p.bashChained} 次, 和上一条完全相同的 ${p.repeats} 次); 文字块 ${p.textBlocks}, 思考块 ${p.thinkingBlocks}`,
    `最常调: ${byCount.map(([k, v]) => `${k} ×${v.count}`).join(", ")}`,
    `回复最大: ${byBytes.map(([k, v]) => `${k} 共 ${(v.resultBytes / 1e3).toFixed(0)}k (最大单次 ${(v.maxResultBytes / 1e3).toFixed(0)}k)`).join(", ")}`,
    `最大的几次: ${p.biggest.slice(0, 5).map((b) => `${(b.bytes / 1e3).toFixed(0)}k ← ${b.what}`).join(" | ")}`,
  ];
}
