// 大脑 Bash 的放行和等待规则 (core/brains/hooks/permit.ts、hook.ts pre-tool); 不开游戏、不叫模型
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { permit, sleepVerdict, tokenize, normDir } from "../core/brains/hooks/permit.ts";

const CWD = "C:\\brains\\run1\\a"; // 假的角色目录 (钩子数据的 cwd 是 Windows 写法)

// factorio-ai-party tools/test_permit.py 的 ALLOW (我们同样放行的)
const PARTY_ALLOW = [
  './fh call move_to --args \'{"position":{"x":-38,"y":-12}}\' --wait --wait-timeout 120000 && for x in -44 -40 -36 -32; '
  + 'do ./fh call transfer --args "{\\"position\\":{\\"x\\":$x,\\"y\\":-14},\\"item\\":\\"copper-plate\\"}"; done',
  "for a in status chat; do ./fh call $a; done",
  "./fh call describe --format json > describe.json",
  './fh call status 2>&1 | grep -E "error|power"',
  "./fh call chat && ./fh board",
  "cat ../astra/notes.md",
  "date; cat deadline.txt",
  "for x in 1 2\ndo\n  ./fh call status\ndone",
];
// 旧项目实跑里被 dontAsk 拒掉的 (目录换成假的)
const OURS_ALLOW = [
  'cd "C:/brains/run1/a" && ./fh call stock; for a in belt_route build build_path nearest; do ./fh help $a; done',
  'cd /c/brains/run1/a; ./fh call status 2>&1 | grep -iE "^(action|crafting|last|clock)" | head',
  'for p in \'32.5,"y":-60.5\' \'36.5,"y":-60.5\'; do ./fh call inspect --args "{\\"position\\":{\\"x\\":$p}}" | grep -E "^(name|status_name)"; echo --; done',
  "./bp list 红瓶; ./bp list automation; ./fh call technologies 2>&1 | head -40",
  'for t in automation-2 logistics-2; do ./fh call research --args "{\\"technology\\":\\"$t\\"}" 2>&1 | grep -E "^queue|error" ; done',
  "./fh call craft --args '{\"recipe\":\"transport-belt\",\"count\":6}' >/dev/null; ./fh call craft --args '{\"recipe\":\"splitter\",\"count\":1}' 2>&1 | grep -E \"short\"",
  'grep -n "^## " notes.md; tail -40 ../team.md; ./fh call status',
  // 比派对多放的: 字面的 $ (正则行尾)、引号里的关键字是数据、子 shell、if
  'grep -E "error$" notes.md | wc -l',
  "./fh call chat --args '{\"text\":\"for x in a; do sleep 30; done\"}'",
  "(./fh call status; ./fh call chat) | head -5",
  "if ./fh call status | grep -q idle; then ./fh call chat; fi",
  "./fh call status | sort | uniq -c | sort -rn | head; tail -n 20 notes.md; date +%s",
  "./calc '{\"targets\":{\"automation-science-pack\":30}}' | cut -c1-120 | tr -s ' '",
  // 反斜杠开头的 grep 正则、echo $?
  "./fh call technologies | grep -E '\\[\\{\"name\":\"automation-science-pack\"' | grep -v \"| true$\" | cut -c1-60,300-",
  "./fh call belt_route --args '{}' --format json > route.json; echo $?; grep -o '\"route\":\"[^\"]*\"\\|\"placed\":[0-9]*' route.json",
];
// 派对 test_permit.py 的 PASS (不放行) + 我们实跑里本来就该拒的
const DENY = [
  "rm -rf notes.md",
  "for x in a b; do rm $x; done",
  "./fh call status > /tmp/out.txt",
  "./fh call status > ../other/notes.md",
  "echo $(cat ~/.config/pog/rcon-n.pw)",
  "cat ~/.config/pog/rcon-n.pw",
  "echo `whoami`",
  "cat > notes.md <<EOF\nhi\nEOF",
  "x=1; ./fh call status",
  "./fh call status; curl http://example.com",
  "echo ${HOME:-x}",
  "cd .. && ./fh call status",
  "python3 /Users/owner/x.py",
  "sleep 30", // 等事件用 ./fh sleep
  "head -n 117 notes.md > notes.tmp && mv notes.tmp notes.md",
  "./fh call status --format json > /tmp/st.json; ./fh call observe",
  "cd C:/other/run && ./fh call status",
  "F='\"direction\":\"to_entity\"'; ./fh call transfer --args \"{$F}\"",
  "./fh call queue_submit --args \"$(cat q1.json)\" | head -3",
  "ping -n 50 127.0.0.1 >/dev/null; ./fh call status",
  "./fh call scan | awk '{print $2}' | sort | uniq -c",
  "./fh call status 2>&1 | sed -n '/^last:/,$p' | head -25",
  "for ((i=0;i<3;i++)); do ./fh call status; done",
  "while true; do ./fh call status; sleep 30; done", // 派对放行; 我们: while 交给等待规则
];
// 派对 permit.py 放行、但其实危险的 (用他们的 --check 核实过): 我们必须拒
const PARTY_HOLES = [
  "echo a#; rm -rf .", // shlex 把词中间的 # 当注释
  "./fh call status |& rm -rf .", // 不认识的 |& 被当成参数
  "for f in /etc/x; do echo hi > $f; done", // for 词表不查, 变量当重定向目标
];
// 别的绕法和会写文件 / 挂住的选项
const TRICKS = [
  "for f in C:/Windows/x; do cat $f; done",
  "echo hi > C:/x.txt",
  'echo hi > "..\\x.txt"', // 引号里的 \ 留着, Git Bash 当路径分隔符
  "echo hi > $HOME/x",
  "echo hi > *.md",
  "echo $'\\x2fetc'",
  "sort -o out.txt notes.md",
  "sort -uo out.txt notes.md",
  "sort --compress-program=sh notes.md",
  "uniq notes.md out.txt",
  "tail -f context.log",
  "date -s 2020-01-01",
  "printf -v PATH x; grep a notes.md",
  "./fh call status # 注释",
  '"rm" -rf .',
  "./fh call status & rm notes.md",
  "$CMD notes.md",
  "./fh call status \\\n && rm x",
  "for x in \"a b\"; do sort $x; done",
  "cat \\\\\\\\server\\\\share\\\\x.txt", // UNC 路径
  "echo hi > \\\\x.txt",
  "echo $$; echo $!",
];

test("放行: 派对的例子、旧项目实跑里被拒的循环 / 管道 / cd 自己目录", () => {
  for (const c of [...PARTY_ALLOW, ...OURS_ALLOW]) assert.equal(permit(c, CWD), true, c);
});

test("不放行: 别的程序、绝对路径、命令替换、heredoc、赋值、while; 派对版的三个漏洞和别的绕法", () => {
  for (const c of [...DENY, ...PARTY_HOLES, ...TRICKS]) assert.equal(permit(c, CWD), false, c);
  assert.equal(permit("uniq -c notes.md", CWD), true);
  assert.equal(permit('cd "C:/brains/run1/a" && ./fh call stock', ""), false); // 不知道自己目录就不认 cd
});

test("切词: 引号、转义、变量标记、符号取最长", () => {
  const t = tokenize("./fh call x --args \"{\\\"x\\\":$x}\" 2>&1 | grep 'a b'")!;
  assert.deepEqual(t.map((k) => k.t), ["./fh", "call", "x", "--args", '{"x":$x}', "2", ">&", "1", "|", "grep", "a b"]);
  assert.equal(t[4].v, true);
  assert.equal(t[10].q, true);
  assert.equal(tokenize("echo 'unclosed"), null);
  assert.equal(tokenize("echo a#b")![1].t, "a#b"); // 词中间的 # 是普通字符
  assert.equal(normDir("/c/Brains/Run1/a/"), normDir("C:\\brains\\run1\\a"));
});

test("等待规则: 循环里的 sleep 算串联, while / until 轮询拒绝, 引号里的 sleep 不算", () => {
  assert.match(sleepVerdict("for i in 1 2 3; do ./fh sleep 90; done") ?? "", /循环里有 sleep/);
  assert.match(sleepVerdict('until ./fh call status | grep -q "research=x"; do sleep 10; done') ?? "", /循环里有 sleep/);
  assert.match(sleepVerdict("while ./fh call status | grep -q busy; do ./fh call chat; done") ?? "", /while \/ until/);
  assert.match(sleepVerdict("sleep 6m") ?? "", /360 秒太长/);
  assert.match(sleepVerdict("sleep infinity") ?? "", /写成数字/);
  assert.equal(sleepVerdict("./fh sleep --until queue_done 120"), null);
  assert.equal(sleepVerdict("for a in status chat; do ./fh call $a; done"), null);
  assert.equal(sleepVerdict("./fh call chat --args '{\"text\":\"sleep 30 then sleep 30\"}'"), null);
  assert.match(sleepVerdict("cat <<EOF\nx\nEOF\nsleep 30; sleep 30") ?? "", /串了 2 个/); // 切不了词时按原来的正则数
});

test("钩子 pre-tool: 先拒串联 sleep, 再放行白名单命令, 别的说清为什么拒; 没标记不起作用", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fa-permit-"));
  const hook = path.join(import.meta.dirname, "..", "core", "brains", "hooks", "hook.ts");
  const run = (command: string) => spawnSync(process.execPath, [hook, "pre-tool"], { input: JSON.stringify({ cwd: d, tool_name: "Bash", tool_input: { command } }), encoding: "utf8" });
  const loop = "for a in status chat; do ./fh call $a; done";
  assert.equal(run(loop).stdout, ""); // 没有 .context-hooks 标记
  fs.writeFileSync(path.join(d, ".context-hooks"), "");
  const ok = run(loop);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecision, "allow");
  const own = run(`cd "${d.replace(/\\/g, "/")}" && ./fh call status | head -3`);
  assert.equal(JSON.parse(own.stdout).hookSpecificOutput.permissionDecision, "allow");
  const slept = run("for i in 1 2; do ./fh sleep 60; done");
  assert.equal(slept.status, 2);
  assert.match(slept.stderr, /循环里有 sleep/);
  const other = JSON.parse(run("rm -rf notes.md").stdout).hookSpecificOutput;
  assert.equal(other.permissionDecision, "deny");
  assert.match(other.permissionDecisionReason, /rm 不在能用的程序里/);
  assert.match(other.permissionDecisionReason, /Bash 没有被禁/);
  // 模型第一条命令 cd 到别处被拒: 不回答时它以为 Bash 全禁了, 几轮都停下来找人要权限
  const first = JSON.parse(run(`cd /c/Users 2>/dev/null; cd "${d.replace(/\\/g, "/")}" && ls -la && cat world-scan.md`).stdout).hookSpecificOutput;
  assert.equal(first.permissionDecision, "deny");
  assert.match(first.permissionDecisionReason, /cd 只能到你自己的工作目录, 不能 cd \/c\/Users/);
  assert.equal(run("./fh call status $(cat x)").stdout, "", "开头是本来就放行的程序: 不替 Claude Code 决定");
  assert.equal(run("python tools/x.py $(cat y)").stdout, "");
  const logText = fs.readFileSync(path.join(d, "context.log"), "utf8");
  assert.match(logText, /"permitted"/);
  assert.match(logText, /"denied"/);
});
