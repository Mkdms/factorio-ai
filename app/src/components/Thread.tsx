// 中栏: 选中角色 (或全队) 的对话流 + 输入框。聊天室样式: 大脑说的靠左、带厂商 LOGO 头像和名字, 你说的靠右、蓝气泡。
// 对话行、"干了 N 步"、等你卡片、输入框的样子照 OpenGrokBot web/src/components/Thread.tsx、ActivityChip.tsx (MIT, 见 NOTICE)。
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { TEAM, askOptions, askReply, fmtClock, parseComposer, replyLine, speakerStarts, stepsMeta, timeMarks, type AskOption, type Item, type ReplyStatus, type Step, type Vendor } from "../logic.ts";
import { Avatar } from "./Avatar.tsx";

/** 一个角色在聊天里怎么显示: 名字 ("Claude Opus 5.5 · A")、厂商 (头像 LOGO)、游戏里叫什么、字母 (认不出厂商时头像写它) */
export type Who = { title: string; vendor: Vendor | null; game: string | null; letter: string };

/** onReply = 点等你卡片上的按钮: 对那个角色说一句 (全队视图里也是只发给问的那个); canReply = 这一班在跑、连得上 (不然不放按钮) */
export function Thread({ title, role, avatar, vendor, presence, banner, items, isTeam, block, onSend, onReply, canReply, down, who, emptyText, seed, members, replies }: {
  title: string; role: string; avatar: string; vendor: Vendor | null; presence: string | null; who: (agent: string) => Who;
  /** 你说的话谁回了 */
  replies?: ReplyStatus[];
  /** 群里 @ 的成员列表 (label = 游戏里的名字, 没空格, 当 @ 后面的词; detail = 模型名) */
  members?: Member[];
  /** 左栏"/ 命令"面板点的一条: 填进输入框 (n 每次不同, 同一条点两次也生效) */
  seed?: { text: string; n: number } | null;
  banner: { tone: "info" | "warn" | "down"; text: string; action?: { label: string; run: () => void } } | null;
  items: Item[]; isTeam: boolean; block: string | null; down: boolean; canReply: boolean;
  onSend: (msg: { type: "tell"; text: string } | { type: "fh"; args: string }) => void;
  onReply: (agent: string, text: string) => Promise<boolean>;
  /** 没有对话时中间那句 (空对话时说清楚为什么空) */
  emptyText?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // 在底部时新内容来了跟着滚; 往上翻看的时候不打扰
  const lastKey = items.length ? `${items.length}:${JSON.stringify(items.at(-1)).length}` : "0";
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastKey, title]);
  useEffect(() => { stick.current = true; }, [title]);
  const times = timeMarks(items);
  const starts = speakerStarts(items);

  return (
    <main className="thread">
      <header className="thread-header">
        <Avatar vendor={vendor} text={avatar} state={presence} size="small" />
        <span className="thread-name">{title}</span>
        <span className="thread-role">{role}</span>
      </header>
      {banner ? <div className={`banner ${banner.tone}`}>{banner.text}{banner.action ? <button className="banner-action" onClick={banner.action.run}>{banner.action.label}</button> : null}</div> : null}
      <div className="thread-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {items.length === 0 ? (
          <div className="thread-empty">{down ? "连上控制接口后这里显示大脑说的话和干的活" : emptyText ?? "这一班里还没有说过话"}</div>
        ) : withKeys(items).map(([k, x], i) => <ItemRow key={k} item={x} isTeam={isTeam} start={starts[i]} showTime={times[i]} who={who} onReply={canReply ? onReply : null} replies={replies} />)}
      </div>
      <Composer key={title} title={title} isTeam={isTeam} block={block} onSend={onSend} seed={seed ?? null} members={members ?? []} />
    </main>
  );
}

export type Member = { id: string; label: string; detail: string };
/** 光标前正在打的 "@词" (只认最后一个 @, 前面是行首或空白); 没有就 null */
export function mentionDraft(text: string): { start: number; word: string } | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(text);
  return m ? { start: m.index + (m[0].length - m[1].length - 1), word: m[1] } : null;
}

/** 按 类型 + 角色 + 时间 给 key (不用下标): 每次只取最近几十行, 窗口往后滑时, 点开的"干了 N 步"不会串到别的项上 */
function withKeys(items: Item[]): [string, Item][] {
  const seen = new Map<string, number>();
  return items.map((x) => {
    const base = `${x.type}|${x.agent}|${x.at ?? "-"}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return [`${base}|${k}`, x];
  });
}

/** 一段话开头那一行: 名字 (全队里写; 单聊不写, 标题已经有了)、游戏里的名字作小标签、时间 (停顿之后才写) */
function Meta({ item, isTeam, start, showTime, who }: { item: Item; isTeam: boolean; start: boolean; showTime: boolean; who: (agent: string) => Who }) {
  const mine = item.type === "you" || item.type === "you-cmd";
  const name = !start ? null : mine ? (isTeam && item.agent !== TEAM ? `你 → ${who(item.agent).title}` : "你") : isTeam ? who(item.agent).title : null;
  const tag = start && !mine && isTeam ? who(item.agent).game : null;
  const time = showTime ? fmtClock(item.at) : "";
  if (!name && !time) return null;
  return (
    <div className="row-meta">
      {name ? <span className="speaker">{name}</span> : null}
      {tag ? <span className="speaker-tag">游戏里: {tag}</span> : null}
      {time ? <span className="row-time">{time}</span> : null}
    </div>
  );
}

/** 聊天室的一行: 一段话的第一项左边 (你说的在右边) 放头像, 后面接着说的空出头像的位置 */
function ItemRow({ item, isTeam, start, showTime, who, onReply, replies }: {
  item: Item; isTeam: boolean; start: boolean; showTime: boolean; who: (agent: string) => Who; onReply: ((agent: string, text: string) => Promise<boolean>) | null; replies?: ReplyStatus[];
}) {
  const mine = item.type === "you" || item.type === "you-cmd";
  const w = mine ? null : who(item.agent);
  const head = !start ? <span className="avatar-gap" />
    : mine ? <Avatar vendor={null} text="我" size="chat" me title="你" />
    : <Avatar vendor={w!.vendor} text={w!.letter} size="chat" title={w!.title} />;
  let body;
  switch (item.type) {
    case "say": body = <div className={`bubble markdown${item.toYou ? " to-you" : ""}`} data-to-you={item.toYou ? "1" : undefined}>{item.toYou ? <div className="say-to-you">对你说 (汇报, 不用批)</div> : null}<Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{item.text}</Markdown></div>; break;
    case "steps": body = <StepsChip steps={item.steps} />; break;
    case "ask": body = <AskCard item={item} onReply={onReply} />; break;
    case "you":
      body = <>
        <div className="bubble">{item.text}</div>
        {item.status !== "已送到" ? <div className={`you-status${item.status === "没送到" ? " bad" : ""}`}>{item.status}{item.error ? `: ${item.error}` : ""}</div>
          : replyLine(item.text, item.at, replies) ? <div className="you-status" data-reply-line="1">{replyLine(item.text, item.at, replies)}</div> : null}
      </>;
      break;
    case "you-cmd":
      body = (
        <div className="cmd-card">
          <div className="cmd-line">/{item.args}</div>
          {item.pending ? <div className="cmd-pending">执行中…</div>
            : <div className={`cmd-out${item.code ? " bad" : ""}`}>{(item.out ?? "").trim() || "(没有输出)"}{item.code ? `\n(退出码 ${item.code})` : ""}</div>}
        </div>
      );
      break;
  }
  return (
    <div className={`row${mine ? " you" : ""}${start ? " start" : ""}`} data-agent={mine ? undefined : item.agent}>
      {head}
      <div className="row-main"><Meta item={item} isTeam={isTeam} start={start} showTime={showTime} who={who} />{body}</div>
    </div>
  );
}

/** 等你卡片: 大脑列了选项 (1. … 2. …) 就每项一个按钮, 没列就是 批准 / 不批; 点了发一句带上它问的是哪件事的话。也可以在输入框里自己打字回 */
function AskCard({ item, onReply }: { item: Item & { type: "ask" }; onReply: ((agent: string, text: string) => Promise<boolean>) | null }) {
  const [sent, setSent] = useState<string | null>(null); // 点过的按钮: 等话送到之前不让再点
  const [done, setDone] = useState<string | null>(null); // 送到了: 卡片自己变成已回复, 不等大脑的记录里出现你的话
  const [failed, setFailed] = useState<string | null>(null);
  const options = askOptions(item.text);
  const choices: { label: string; choice: AskOption | "批准" | "不批"; tone: string }[] = options.length
    ? options.map((o) => ({ label: `${o.key}. ${o.text}`, choice: o, tone: "option" }))
    : [{ label: "批准", choice: "批准", tone: "approve" }, { label: "不批", choice: "不批", tone: "deny" }];
  const answered = item.answered || done !== null;
  const live = !answered && !!onReply;
  return (
    <div className={`ask-card${answered ? " answered" : ""}`}>
      <div className="ask-label">{answered ? `找过你 · 已回复${done ? ` "${done}"` : ""}` : "等你"}</div>
      <div className="ask-text">{item.text}</div>
      {live ? (
        <div className={`ask-buttons${options.length ? " options" : ""}`}>
          {choices.map((c) => (
            <button key={c.label} className={`ask-button ${c.tone}${sent === c.label ? " sent" : ""}`} disabled={sent !== null}
              onClick={async () => { setSent(c.label); setFailed(null); if (await onReply!(item.agent, askReply(item.text, c.choice))) setDone(c.label); else { setFailed(c.label); setSent(null); } }}>{c.label}</button>
          ))}
        </div>
      ) : null}
      {live ? <div className={`ask-hint${failed ? " bad" : ""}`}>{sent ? `正在发 "${sent}"…` : failed ? `"${failed}" 没送到 (原因在下面你说的话那里), 可以再点一次` : "点按钮回它, 或者在下面的输入框自己打字"}</div> : null}
      {!item.answered && !onReply ? <div className="ask-hint">这一班没在跑, 回不了</div> : null}
    </div>
  );
}

/** 连续的命令和结果: 一行 "干了 N 步", 点开看每一步 (大脑写的说明、命令、结果) */
function StepsChip({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState(false);
  const last = steps.at(-1);
  const running = !!last && last.cmd !== "" && last.result === undefined;
  const failed = steps.filter((s) => s.error).length;
  const span = [fmtClock(steps[0]?.at), fmtClock(last?.at)].filter(Boolean);
  return (
    <div className={`steps-chip${running ? " running" : ""}`}>
      <button className="steps-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="steps-label">{running ? `正在干 · 第 ${steps.length} 步` : stepsMeta(steps).replace(/ · .*$/, "")}</span>
        <span className="steps-meta">{running ? (last!.desc ?? last!.cmd) : (last?.desc ?? "")}{span.length === 2 && span[0] !== span[1] ? ` · ${span[0]}–${span[1]}` : ""}</span>
        {failed ? <span className="steps-fail">{failed} 步失败</span> : null}
        <span className="steps-caret">{open ? "收起" : "展开"}</span>
      </button>
      {open ? (
        <ol className="steps-list">
          {steps.map((s, i) => (
            <li key={i} className={s.error ? "failed" : s.result === undefined && s.cmd ? "waiting" : undefined}>
              <span className="step-mark">{s.error ? "✕" : s.result === undefined && s.cmd ? "…" : "✓"}</span>
              <span className="step-desc">{s.desc ?? (s.cmd ? "" : "(更早的命令的结果)")}</span>
              {s.cmd ? <span className="step-cmd">{s.cmd}</span> : null}
              {s.result !== undefined ? <pre className="step-out">{s.result}</pre> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function Composer({ title, isTeam, block, onSend, seed, members }: { title: string; isTeam: boolean; block: string | null; onSend: (m: { type: "tell"; text: string } | { type: "fh"; args: string }) => void; seed: { text: string; n: number } | null; members: Member[] }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const cmdMode = text.trimStart().startsWith("/");
  // 群里打 @ 弹成员列表 (照 QQ 群): 按打到一半的词筛 (游戏名 / 模型名开头), 点一个就填成 "@名字 "
  const draft = isTeam && !cmdMode ? mentionDraft(text) : null;
  const candidates = draft ? [{ id: TEAM, label: "全队", detail: "每个角色都收到" }, ...members].filter((m) => !draft.word || m.label.toLowerCase().startsWith(draft.word.toLowerCase()) || m.detail.toLowerCase().startsWith(draft.word.toLowerCase())) : [];
  const pickMember = (m: Member) => {
    if (!draft) return;
    setText(`${text.slice(0, draft.start)}@${m.label} `);
    const el = ref.current; if (el) { el.focus(); requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length)); }
  };
  // 左栏点了一条 "/ 命令": 填进来并把光标放到末尾 (用户接着补参数)
  useEffect(() => { if (seed) { setText(seed.text); setError(null); const el = ref.current; if (el) { el.focus(); requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length)); } } }, [seed]);
  useLayoutEffect(() => { const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 180)}px`; } }, [text]);

  const submit = () => {
    const p = parseComposer(text);
    if (!p) return;
    if (p.type === "error") return setError(p.text);
    if (p.type === "fh" && isTeam) return setError("游戏命令要用某个角色的身份执行: 先在左边选一个角色");
    setError(null);
    onSend(p);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
  };
  return (
    <div className="composer-wrap">
      {candidates.length ? (
        <div className="mention-list" data-mention-list>
          {candidates.map((m) => <button type="button" key={m.id} className="mention-item" data-member={m.id} onMouseDown={(e) => { e.preventDefault(); pickMember(m); }}>@{m.label}<span className="mention-detail">{m.detail}</span></button>)}
        </div>
      ) : null}
      <div className="composer">
        <textarea ref={ref} rows={1} value={text} disabled={!!block} className={cmdMode ? "cmd-mode" : undefined}
          placeholder={block ?? (isTeam ? "对全队说… (每个角色都会收到; @名字 只对他说)" : `对 ${title} 说…  以 / 开头 = 直接执行游戏命令`)}
          onChange={(e) => { setText(e.target.value); setError(null); }} onKeyDown={onKey} />
        <button onClick={submit} disabled={!!block || !text.trim()} aria-label="发送" title="发送 (回车)">↑</button>
      </div>
      <div className={`composer-hint${error ? " bad" : ""}`}>
        {error ?? (cmdMode ? <>回车执行 <code>./fh {text.trim().slice(1).trim().replace(/^\.\/fh\s+/, "") || "…"}</code>, 结果显示在对话里</>
          : <>回车发送, Shift+回车换行{isTeam ? <> · 打 <code>@</code> 选成员, 只对他说</> : <> · 例: <code>/call status</code> 看它的状态</>}</>)}
      </div>
    </div>
  );
}
