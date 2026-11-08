// 大脑 Bash 命令的放行和等待规则 (库, 不直接运行; hooks/hook.ts 的 pre-tool 用)。
//
// 放行 (permit) 搬自 factorio-ai-party (MIT) tools/permit.py 和 tools/test_permit.py 的例子 (NOTICE 署名)。
// 他们的理由: Claude Code 的 dontAsk 模式把 "for x in ...; do ./fh call transfer ...$x...; done" 这种命令整条拒掉 (每一段都在白名单里也拒),
// 模型以为 Bash 全禁了。PreToolUse 钩子对 "每一段都以白名单程序开头、只用列表 / 管道 / 循环 / 条件、变量只有 $name / ${name}、
// 重定向只写工作区里的相对路径或 /dev/null" 的命令回答 allow; 别的不回答, 照常走权限规则。
// 旧项目实跑记录里 96 条被拒的 Bash 大多是 for 循环、cd 自己目录 && …、带 | grep 的管道。
//
// 和他们的不同 —— 他们的命令还跑在 Claude Code 的沙箱里兜底, 我们在 Windows 上没有沙箱, 所以更紧:
//   1. 分词自己写成接近 bash 的。他们用 Python shlex, 用他们的 permit.py --check 核出三处会放行危险命令:
//      "echo a#; rm -rf ." (shlex 把词中间的 # 也当注释, 吞掉了后半句)、"./fh call status |& rm -rf ." (不认识的 |& 被当成参数)、
//      "for f in /etc/x; do echo hi > $f; done" (for 的词表不查, 变量当重定向目标)。
//      我们: 词首 # 不放行、不认识的符号不放行、for 词表和参数一样查、重定向目标不许带变量。
//   2. 白名单 = ./fh ./fp (装模组那条路 run.ts 的 fp 配置) ./calc ./bp ./plan ./know + python (沙盘里放开, 没有沙箱, 联机前要重新看) + 只读小工具。去掉 sleep (等事件用 ./fh sleep 秒数 --until 条件)、
//      rg (--pre 能跑别的程序)。会写文件或挂住的选项不放行: sort -o / --compress-program、uniq 的第二个文件 (输出文件)、tail -f、date -s、printf -v。
//   3. 多认一种: cd 到自己的工作目录 (大脑常写 cd "<自己目录>" && …)。
//   4. Windows 路径: 盘符 (C:/、C:\) 和 \ 开头的也算绝对路径。
// 等待规则 (sleepVerdict, 我们自己的): 一条命令里两个以上 sleep、一次超过 300 秒、循环里带 sleep (每圈睡一次就是串联)、
// while / until 循环 (一直轮询) 都拒绝并说明怎么改。放行之前先过等待规则。

/** 一个词或一个符号; v = 词里有 $变量 (值看不见), q = 带引号或反斜杠 (这样的 do、for 不是关键字) */
export type Tok = { t: string; op: boolean; v: boolean; q: boolean };

const OPS = [";;", "&&", "||", "|&", "&>>", ">>", "&>", ">&", "<&", ">|", "<>", "<<", "<(", ">(", ";", "&", "|", "<", ">", "(", ")"];
const PUNCT = new Set(";&|<>()");

/** 照 bash 的规则切词; 遇到不放行的写法 (命令替换、反引号、$'…'、注释、没收尾的引号、续行) 返回 null */
export function tokenize(cmd: string): Tok[] | null {
  const out: Tok[] = [];
  let w = "", has = false, v = false, q = false;
  const end = () => { if (has) out.push({ t: w, op: false, v, q }); w = ""; has = false; v = false; q = false; };
  // 读 $ 开头的一段, 返回吃掉的字符数; null = 不放行
  const dollar = (i: number, inDq: boolean): number | null => {
    const n = cmd[i + 1] ?? "";
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(cmd.slice(i + 1));
    if (name) { v = true; w += "$" + name[0]; return 1 + name[0].length; }
    if (/^[0-9@?]$/.test(n)) { v = true; w += "$" + n; return 2; } // $? = 上一条的退出码 (echo $?)
    if (n === "{") { const m = /^\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(cmd.slice(i + 1)); if (!m) return null; v = true; w += "$" + m[0]; return 1 + m[0].length; } // ${x:-…} ${x@P} 等不放行
    if (n !== "" && "([*#?!$-".includes(n)) return null; // 命令替换、算术、特殊参数
    if (!inDq && (n === "'" || n === '"')) return null; // $'…' $"…" 会改写内容 (转义序列), 我们看到的不是 bash 看到的
    w += "$"; // 后面是空白、收尾的引号、| 之类: 字面的 $ (例 grep "error$")
    return 1;
  };
  for (let i = 0; i < cmd.length; ) {
    const c = cmd[i];
    if (c === " " || c === "\t" || c === "\r") { end(); i++; continue; }
    if (c === "\n") { end(); out.push({ t: ";", op: true, v: false, q: false }); i++; continue; }
    if (PUNCT.has(c)) { end(); const op = OPS.find((o) => cmd.startsWith(o, i))!; out.push({ t: op, op: true, v: false, q: false }); i += op.length; continue; }
    if (c === "`") return null;
    if (c === "#" && !has) return null; // 注释: 不放行 (bash 只在词首认 #; 词中间的 # 是普通字符)
    if (c === "\\") { const e = cmd[i + 1]; if (e === undefined || e === "\n" || e === "\r") return null; w += e; has = true; q = true; i += 2; continue; }
    if (c === "'") { const j = cmd.indexOf("'", i + 1); if (j < 0) return null; w += cmd.slice(i + 1, j); has = true; q = true; i = j + 1; continue; }
    if (c === '"') {
      has = true; q = true; i++;
      for (;;) {
        if (i >= cmd.length) return null;
        const d = cmd[i];
        if (d === '"') { i++; break; }
        if (d === "`") return null;
        if (d === "\\") {
          const e = cmd[i + 1];
          if (e === undefined || e === "\n" || e === "\r") return null;
          if ('$`"\\'.includes(e)) { w += e; i += 2; } else { w += "\\"; i++; }
          continue;
        }
        if (d === "$") { const k = dollar(i, true); if (k === null) return null; i += k; continue; }
        w += d; i++;
      }
      continue;
    }
    if (c === "$") { const k = dollar(i, false); if (k === null) return null; has = true; i += k; continue; }
    w += c; has = true; i++;
  }
  end();
  return out;
}

/** 切成一条条简单命令 (第一个词是程序), 外加用到的循环、for 的词表、重定向目标; 不认识的结构返回 null */
export type Shell = { cmds: Tok[][]; loops: string[]; forWords: Tok[]; targets: Tok[] };
const CONTROL = new Set([";", ";;", "&&", "||", "|", "|&", "&", "(", ")"]);
const REDIRECT = new Set([">", ">>", "<", "&>", "&>>", ">&", "<&", ">|", "<>"]);
const KEYWORDS = new Set(["do", "done", "then", "else", "fi", "!", "{", "}"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseShell(command: string): Shell | null {
  const toks = tokenize(command);
  if (!toks) return null;
  const s: Shell = { cmds: [], loops: [], forWords: [], targets: [] };
  let state: "start" | "cmd" | "forName" | "forIn" | "forWords" = "start", target = false, cur: Tok[] = [];
  for (const k of toks) {
    if (target) { if (k.op) return null; s.targets.push(k); target = false; continue; }
    if (k.op) {
      if (REDIRECT.has(k.t)) { if (state.startsWith("for")) return null; target = true; continue; }
      if (!CONTROL.has(k.t) || state === "forName") return null; // <<、<(、>( 和 for ((…)) 不放行
      state = "start";
      continue;
    }
    if (state === "forName") { if (k.v || k.q || !NAME.test(k.t)) return null; state = "forIn"; continue; }
    if (state === "forIn") { if (k.t !== "in" || k.q) return null; state = "forWords"; continue; }
    if (state === "forWords") { s.forWords.push(k); continue; }
    if (state === "start" && !k.q) {
      if (KEYWORDS.has(k.t)) continue;
      if (k.t === "while" || k.t === "until") { s.loops.push(k.t); continue; }
      if (k.t === "if" || k.t === "elif") continue; // 条件本身是命令, 照命令查
      if (k.t === "for") { s.loops.push("for"); state = "forName"; continue; }
    }
    if (state === "start") { cur = [k]; s.cmds.push(cur); state = "cmd"; continue; }
    cur.push(k);
  }
  if (target || state === "forName" || state === "forWords") return null;
  return s;
}

/** 白名单程序: 我们的命令行 + 只读小工具 */
export const PROGRAMS = new Set(["./fh", "./fp", "./calc", "./bp", "./plan", "./know", "python", "python3", "grep", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "cat", "echo", "printf", "jq", "ls", "date", "true", "false", "test", "["]);

// 参数: 单个 \ 开头多半是 grep 正则 (\[、\{、\b), 只把 \\ (UNC) 当路径; 重定向目标另外不许任何 \ 开头
const isAbs = (t: string) => (t.startsWith("/") && t !== "/dev/null") || t.startsWith("~") || t.startsWith("\\\\") || /^[A-Za-z]:/.test(t);
/** 目录比较: \ 换 /、Git Bash 的 /c/ 换 c:/、去尾部 /、不分大小写 */
export const normDir = (p: string) => p.replace(/\\/g, "/").replace(/^\/([A-Za-z])(?=\/|$)/, "$1:").replace(/\/+$/, "").toLowerCase();
const safeTarget = (k: Tok) => !k.v && (k.t === "/dev/null" || /^\d+$/.test(k.t) || k.t === "-" ||
  (k.t !== "" && !isAbs(k.t) && !k.t.startsWith("\\") && !k.t.split(/[\\/]/).includes("..") && !/[*?[\]{}~$]/.test(k.t)));

/** 白名单程序里会写文件、改系统或挂住的选项 */
function optionsOk(prog: string, args: Tok[]): boolean {
  if (["sort", "uniq", "tail", "date", "printf"].includes(prog) && args.some((a) => a.v)) return false; // 变量里的选项看不见
  const t = args.map((a) => a.t);
  switch (prog) {
    case "sort": return !t.some((a) => /^-[A-Za-z]*o/.test(a) || /^--[oc]/.test(a)); // -o / --output 写文件, --compress-program 跑程序
    case "tail": return !t.some((a) => /^-[A-Za-z0-9]*[fF]/.test(a) || a.startsWith("--f")); // -f 一直挂着
    case "date": return !t.some((a) => /^-[A-Za-z]*s/.test(a) || a.startsWith("--s")); // -s 改系统时间
    case "printf": return t[0] !== "-v"; // -v 给变量赋值 (能改 PATH)
    case "uniq": { // uniq 输入 输出: 第二个文件是写出去的
      let n = 0;
      for (let i = 0; i < t.length; i++) { if (/^-[fsw]$/.test(t[i])) i++; else if (t[i] === "-" || !t[i].startsWith("-")) n++; }
      return n < 2;
    }
    default: return true;
  }
}

/** 不放行的原因 (放行返回 null): 每一段都是白名单程序 (或 cd 到自己目录), 只用列表 / 管道 / for / if, 重定向只写工作区相对路径。cwd = 角色目录 (钩子数据的 cwd) */
export function permitWhy(command: string, cwd = ""): string | null {
  if (/\$\(|<\(|>\(|<<|\\\r?\n/.test(command)) return "不能用命令替换 $(…)、进程替换、heredoc 和续行 (写文件用 Write / Edit 工具, 不用 cat <<EOF)"; // 引号里也算, 宁紧勿松
  const s = parseShell(command);
  if (!s || !s.cmds.length) return "这条命令解析不了 (注释、反引号、没收尾的引号或不认识的写法)";
  if (s.loops.some((l) => l !== "for")) return "while / until 循环不放行"; // 等待规则会拒并说明
  const bad = s.targets.find((k) => !safeTarget(k));
  if (bad) return `重定向只能写工作区里的相对路径, 不能写 ${bad.t}`;
  if (s.forWords.some((k) => k.v || /\s/.test(k.t) || isAbs(k.t))) return "for 的词表不能有变量、空格或绝对路径"; // 词表就是之后的变量值
  for (const [p, ...args] of s.cmds) {
    if (p.v) return "程序名不能是变量";
    if (p.t === "cd") {
      if (args.length === 1 && !args[0].v && cwd && (args[0].t === "." || normDir(args[0].t) === normDir(cwd))) continue;
      return `cd 只能到你自己的工作目录, 不能 cd ${args.map((a) => a.t).join(" ")}`;
    }
    if (!PROGRAMS.has(p.t)) return `${p.t} 不在能用的程序里`;
    const abs = args.find((a) => isAbs(a.t));
    if (abs) return `参数不能用绝对路径 (${abs.t}), 用相对路径`;
    if (!optionsOk(p.t, args)) return `${p.t} 的这个选项不放行 (会写文件、挂住或改系统)`;
  }
  return null;
}
export function permit(command: string, cwd = ""): boolean { return permitWhy(command, cwd) === null; }

/** --allowedTools 里本来就放行的开头: 这些不替 Claude Code 决定, 让它自己按规则判 */
const RULE_PREFIX = /^\s*(\.\/(fh|calc|bp|plan|know)|python3?)(\s|$)/;
/**
 * 被拒时告诉模型真实原因: 不回答的话 Claude Code 只说 "don't ask 模式拒绝", 模型第一条命令被拒就以为 Bash 全禁了, 几轮都停下来找人要权限。
 * 本来就过得了规则的返回 null, 交给 Claude Code。
 */
export function denyText(command: string, cwd = ""): string | null {
  const why = permitWhy(command, cwd);
  if (why === null || RULE_PREFIX.test(command)) return null;
  return `这一条没放行: ${why}。Bash 没有被禁, 不用找人要权限: 你已经在工作目录里, 改成直接跑就行, 例 ./fh call status。能用: ./fh ./calc ./bp ./plan ./know python, 和 grep head tail wc sort uniq cut tr cat echo printf jq ls date; 路径用相对路径, 不要 cd 到别处。`;
}

/** 一段简单命令的 sleep 秒数 (不是 sleep 返回 undefined, 读不出数字返回 NaN) */
function sleepSeconds(argv: string[]): number | undefined {
  const unit: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
  const sec = (a: string) => { const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(a); return m ? Number(m[1]) * unit[m[2]] : NaN; };
  if (argv[0] === "sleep") return argv.length > 1 ? argv.slice(1).reduce((x, a) => x + sec(a), 0) : NaN; // coreutils 把几个参数加起来
  const rest = argv[0] === "./fh" ? (argv[1] === "sleep" ? argv.slice(2) : argv[1] === "call" && argv[2] === "sleep" ? argv.slice(3) : undefined) : undefined;
  if (!rest) return undefined;
  const n = rest.find((a) => /^\d+$/.test(a)); // fh sleep 的秒数是第一个位置参数, 选项 (--until …) 可以在前面
  return n === undefined ? NaN : Number(n);
}

/** 一条命令里的 sleep: 两个以上 (串联)、合计超过 300 秒、循环里有 sleep、while / until 轮询就拒绝, 返回给大脑看的理由; 没问题返回 null (没活时一次等待最多 300 秒) */
export function sleepVerdict(command: string): string | null {
  const s = parseShell(command);
  const secs = s
    ? s.cmds.map((c) => sleepSeconds(c.map((k) => k.t))).filter((x): x is number => x !== undefined)
    : [...command.matchAll(/(?:\.\/fh\s+(?:call\s+)?sleep|(?:^|[;&|\s])sleep)\s+(\d+)/g)].map((m) => Number(m[1])); // 切不了词 (heredoc、$(…)) 就按原来的正则数
  const how = "睡觉不算玩: 先挂队列或常驻命令让角色干着, 再用 ./fh sleep 秒数 --until 条件 等一件具体的事 (一次最多 300 秒)。";
  if (s && s.loops.length && secs.length) return `拒绝: 循环里有 sleep (每一圈睡一次, 等于串联 sleep)。${how}`;
  if (s && s.loops.some((l) => l !== "for")) return `拒绝: while / until 循环会一直轮询, 刷请求也占着这一轮。等一件事用 ./fh sleep 秒数 --until 条件 (到了会提前醒); 要重复固定几次用 for 循环。`;
  if (secs.length >= 2) return `拒绝: 一条命令里串了 ${secs.length} 个 sleep (共 ${secs.reduce((x, y) => x + y, 0)} 秒)。${how}`;
  if (secs.length === 1 && Number.isNaN(secs[0])) return `拒绝: sleep 的秒数要直接写成数字 (例 ./fh sleep 120 --until 条件), 一次最多 300 秒。`;
  if (secs.length === 1 && secs[0] > 300) return `拒绝: 一次 sleep ${secs[0]} 秒太长 (最多 300 秒)。用 ./fh sleep 秒数 --until 条件 等一件具体的事。`;
  return null;
}
