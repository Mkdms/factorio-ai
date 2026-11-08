// 右栏: 群公告 (上一班复盘 "先修这几条")、在线成员, 下面是游戏读数、体检、额度、停班按钮。
// 读数部分的版式照 OpenGrokBot 的右侧面板 (MIT, 见 NOTICE)。
import { useState, type ReactNode } from "react";
import { BACKEND_OPTIONS, EFFORTS, SCIENCE, type BackendPref, groupEnemyLabel, accountQuota, agentLabel, effortLabel, fmtGameTime, fmtNum, fmtPct, fmtRate, fmtSigned, groupKindLabel, lineupOptions, mkStatusLine, type MkState, parseSeatValue, quietLabel, quotaDetail, runLabel, seatDisplay, seatLabel, seatValue, seatWord, stopButton, vendorOf, watchdogLines, type Account, type Group, type ModelStat, type Review, type RosterSeat, type Scan, type ShiftBlueprint, type State } from "../logic.ts";
import { Avatar } from "./Avatar.tsx";
import type { Row } from "./Sidebar.tsx";

/** members = 这一班的角色 (左栏那几行, 不含全队); connected = 连得上控制接口 (你算在线); accounts = 五家账号 (额度每家一行), now = 算"几天后重置"用; stats = 每个模型的排行 (前 3), onStats = 看全表;
 *  seats = 下一班的群成员 (阵容), onInvite(值 "家:模型") 拉进来, onRemoveSeat(第几个) 移出 */
/** 联机群的选项: 走哪条路、RCON、只读连接 */
function ServerOptions({ group, onSetBackend, onSetRcon, onConnect, children }: { group: Group; onSetBackend: (b: BackendPref) => Promise<void>; onSetRcon: (address: string, password: string) => Promise<void>; onConnect: () => Promise<string>; children?: ReactNode }) {
  const backend = group.backend ?? "auto";
  const [address, setAddress] = useState(group.server?.rcon ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const run = async (fn: () => Promise<string | void>, done: string) => {
    setBusy(true); setNote(null);
    try { const r = await fn(); setNote({ text: typeof r === "string" ? `${done} 记录: ${r}` : done }); }
    catch (e) { setNote({ text: (e as Error).message, bad: true }); }
    finally { setBusy(false); }
  };
  return (
    <div className="server-options" data-group-server-options>
      <label className="server-row">
        <span>走哪条路</span>
        <select className="key-select" data-group-backend value={backend} disabled={busy} onChange={(e) => { void run(() => onSetBackend(e.target.value as BackendPref), "已保存"); }}>
          {BACKEND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <div className="server-note">{BACKEND_OPTIONS.find((o) => o.value === backend)?.note}</div>
      {backend !== "memory" ? (
        <div data-group-rcon>
          <div className="server-note">RCON: {group.server?.rcon ? `已填 ${group.server.rcon}` : "没填"} (只存本机)</div>
          <div className="server-inputs">
            <input className="world-rename" data-group-rcon-address value={address} placeholder="主机:端口" onChange={(e) => setAddress(e.target.value)} />
            <input className="world-rename" data-group-rcon-password type="password" value={password} placeholder={group.server?.rcon ? "密码 (不改就空着)" : "密码"} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button className="link-button" data-group-rcon-save disabled={busy} onClick={() => { void run(async () => { await onSetRcon(address, password); setPassword(""); }, address.trim() ? "RCON 已保存" : "RCON 已清掉"); }}>{address.trim() ? "保存 RCON" : "清掉 RCON"}</button>
        </div>
      ) : null}
      {children}
      <button className="primary-button" data-group-connect disabled={busy || !group.server} onClick={() => { void run(onConnect, "在连了, 客户端窗口会自己开, 5 分钟后断开。"); }}>只读连接 (不叫模型)</button>
      {note ? <div className={note.bad ? "account-note bad" : "server-note"} data-group-server-note>{note.text}</div> : null}
    </div>
  );
}

export function Panel({ state, review, scan, zh, onStop, members, selected, onSelect, connected, accounts, now, stats, onStats, blueprints, onOpenBlueprint, seats, onRemoveSeat, onSetSeat, onSetMe, onSetSeatEffort, onSaveSeats, onLeaveAgent, onMakeAccount, landing, group, groupRunning, onStartGroup, startError, mk, onStopMk, onSetGoal, onSetReveal, onSetBackend, onSetRcon, onConnect }: {
  /** 让这个模型下一班起控制用户的账号 */ onMakeAccount?: (seat: RosterSeat) => Promise<void>;
  /** 在线成员的"移出": 现在就移出 (2026-11-05) */ onLeaveAgent?: (id: string) => Promise<void>;
  state: State | null; review: Review; /** 开班扫描 (现状 / 判断 / 规划) */ scan?: Scan; zh: (n: string) => string; onStop: () => void;
  members: Row[]; selected: string; onSelect: (id: string) => void; connected: boolean;
  accounts?: Account[] | null; now?: number;
  stats?: ModelStat[] | null; onStats?: () => void;
  blueprints?: ShiftBlueprint[] | null; onOpenBlueprint?: (url?: string) => void;
  seats?: RosterSeat[] | null; onRemoveSeat?: (i: number) => Promise<void>;
  /** 换第 i 个角色的模型 (管理员那行的下拉) / 思考强度 */
  onSetSeat?: (i: number, value: string) => Promise<void>; onSetSeatEffort?: (i: number, effort: string) => Promise<void>;
  /** "我 · 管理员"那一行选的: 谁用用户的 Steam 账号玩这个世界 (null = 用户自己看和说话) */
  onSetMe?: (seat: RosterSeat | null) => Promise<void>;
  /** 整份名单 (多选框列表勾完保存) */
  onSaveSeats?: (seats: RosterSeat[]) => Promise<void>;
  /** 空对话 (没在看任何一班): 不显示上一班的公告 / 读数 / 体检 / 蓝图 / 看门狗, 只留成员、统计、额度 */
  landing?: boolean;
  /** 正在看的群 (= 对话 = 世界): 群卡 + 开班按钮; groupRunning = 有一班在跑 (不能再开) */
  group?: Group | null; groupRunning?: boolean; onStartGroup?: () => Promise<void>; startError?: string | null; onSetReveal?: (on: boolean) => Promise<void>; onSetBackend?: (b: BackendPref) => Promise<void>; onSetRcon?: (address: string, password: string) => Promise<void>; onConnect?: () => Promise<string>;
  /** 我的账号的群: 这一局的状态、停、改目标 */
  mk?: MkState | null; onStopMk?: () => Promise<void>; onSetGoal?: (goal: string) => Promise<void>;
}) {
  const run = state?.run ?? null;
  const g = state?.game ?? null;
  const [allHealth, setAllHealth] = useState(false);
  const wd = watchdogLines(state?.watchdog);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const u = state?.quota?.utilization ?? null;
  const reviewTitle = !review ? "上一班复盘" : review.run === run?.id ? "这一班的复盘" : "上一班复盘";
  const online = members.filter((m) => m.presence && m.presence !== "没在跑").length + (connected ? 1 : 0);
  // 下一班名单 = 勾模型 (取代原来的"拉人"下拉): 点"编辑名单"出多选框列表, 同一个模型要几个点 +, 保存 = 整份名单存进 lineup.json
  const [editing, setEditing] = useState(false);
  const groups = lineupOptions(accounts ?? null);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => { setInviteBusy(true); setInviteError(null); try { await fn(); } catch (e) { setInviteError((e as Error).message); } finally { setInviteBusy(false); } };
  const nextSeats = seats ?? [];
  // 第 1 席控制用户的账号: 只有联机服务器的群 (沙盘全是服务器角色, 窗口只看)
  // "我"那一行选了模型 = 用用户的 Steam 账号玩 (只有一个身体, 没有名单); 老的"我的账号"类型同样
  const mine = group?.kind === "mine" || !!group?.me;
  const accountMode = group?.kind === "server" || mine;
  // 谁用用户的账号: 联机服务器的群 = 第 1 席; 别的群 = "我"那一行选的 (group.me; 老的"我的账号"类型是第 1 席)
  const admin: RosterSeat | null = group?.kind === "server" ? nextSeats[0] ?? null : group?.me ?? (group?.kind === "mine" ? nextSeats[0] ?? null : null);
  const listed = accountMode ? nextSeats.slice(1) : nextSeats;
  const liveAccount = accountMode ? members.find((m) => m.id === "a" && !m.agent?.left) ?? null : null;
  const openEditor = () => { const d: Record<string, number> = {}; for (const s of listed) { const v = seatValue(s); d[v] = (d[v] ?? 0) + 1; } setDraft(d); setInviteError(null); setEditing(true); };
  const draftTotal = Object.values(draft).reduce((n, k) => n + k, 0);
  const saveEditor = () => act(async () => {
    const out: RosterSeat[] = accountMode ? [admin ?? { brain: "claude", model: "opus" }] : [];
    for (const g of groups) for (const o of g.items) { const want = draft[o.value] ?? 0; const old = listed.filter((s) => seatValue(s) === o.value); for (let k = 0; k < want; k++) out.push(old[k] ?? parseSeatValue(o.value)); }
    if (!out.length) throw new Error("至少留一个角色");
    await onSaveSeats!(out);
    setEditing(false);
  });
  const bump = (v: string, n: number) => setDraft((d) => ({ ...d, [v]: Math.max(0, Math.min(9, n)) }));
  const effortSelect = (i: number, s: RosterSeat) => onSetSeatEffort ? (
    <select className="key-select effort-select" value={s.effort ?? ""} disabled={inviteBusy} aria-label={`角色 ${i + 1} 的思考强度`} title="思考强度 (Claude Code / Grok / Codex 都有这几档; 默认 = 开班命令行的 --effort)" onChange={(e) => act(() => onSetSeatEffort(i, e.target.value))}>
      <option value="">强度: 默认</option>{EFFORTS.map(([k, name]) => <option key={k} value={k}>强度: {name}</option>)}
    </select>) : null;
  // 下一班名单和本班一样 (在跑、人数相同、名字一一对上) → 不重复列
  const liveNames = members.map((m) => m.title.replace(/\s*\(.*\)$/, ""));
  const sameAsLive = !!run?.running && nextSeats.length > 1 && nextSeats.length === members.length && listed.every((s) => liveNames.includes(seatDisplay(s)) || liveNames.some((n) => n.startsWith(seatDisplay(s))));
  // 名单只有一份: 在跑且这一班支持时, 保存名单 = 马上生效, 不再单列"下一班"
  const liveEdit = !!run?.running && !!run.rosterLive && !!onLeaveAgent;
  const [leaving, setLeaving] = useState<string[]>([]);

  return (
    <aside className="panel">
      <div className="panel-header">
        <span className="panel-title">本班</span>
        <span className={`panel-run${run?.running ? " live" : ""}`}>{!run ? "还没有班次" : run.running ? (run.stopping ? "正在收尾" : "在跑") : run.interrupted ? "中断了" : "没有在跑"}</span>
      </div>
      <div className="panel-body">
        {group ? (
          <section className="panel-section group-card" data-group-card>
            <div className="panel-section-title">群<span className="sub">{groupKindLabel(group.kind)} · 每班 {group.minutes} 分钟 · {group.seats.length} 人{groupEnemyLabel(group)}</span></div>
            <div className="group-name">{group.name}</div>
            {group.kind === "save" && group.save ? <div className="member-sub">接着: {group.save}</div> : null}
            {group.kind === "server" ? <div className="member-sub">服务器: {group.server?.address ?? "本机没存地址"}{group.server?.hasPassword ? " · 有密码" : ""} (协助模式)</div> : null}
            {group.kind === "server" && onSetBackend && onSetRcon && onConnect ? (
              <ServerOptions key={group.id} group={group} onSetBackend={onSetBackend} onSetRcon={onSetRcon} onConnect={onConnect}>
                {onSetReveal ? (
                  <label className="server-check">
                    <input type="checkbox" data-group-reveal-toggle checked={!!group.revealUncharted} onChange={(e) => { void onSetReveal(e.target.checked); }} />
                    <span>让 AI 也看没探过的地方 (内存里有整张图)。默认关: 和真人玩家看到的一样。</span>
                  </label>
                ) : null}
              </ServerOptions>
            ) : null}
            {mine ? <MineCard key={group!.id} group={group!} mk={mk ?? null} startBusy={startBusy} onStart={onStartGroup ? () => { setStartBusy(true); onStartGroup().catch(() => undefined).finally(() => setStartBusy(false)); } : undefined} onStop={onStopMk} onSetGoal={onSetGoal} /> : group.kind === "server" ? <div className="server-note">真模型的班还开不了: 先只读连接, 对过读数再说。</div> : (
              <div className="lineup-foot">
                {onStartGroup ? <button className="primary-button" data-group-start disabled={startBusy || !!groupRunning} onClick={() => { setStartBusy(true); onStartGroup().catch(() => undefined).finally(() => setStartBusy(false)); }}>{startBusy ? "正在开…" : groupRunning ? "有一班在跑" : "开班"}</button> : null}
                <span className="member-sub">开班 = 用群成员 (下面的名单) 接着这个群最近一班连跑: 每班 {group.minutes} 分钟, 到点存档、写复盘、换新的大脑会话接着玩 (游戏不关), 点"停班"才停; 没跑过就开新图</span>
              </div>
            )}
            {startError ? <div className="account-note bad">{startError}</div> : null}
          </section>
        ) : null}
        {landing && !group ? <section className="panel-section"><div className="panel-empty" data-landing-note>空对话: 不看任何一班的读数 (左上角选一班看它的; 开了新的一班会自己跳过去)</div></section> : null}
        {landing && group ? <section className="panel-section"><div className="panel-empty" data-landing-note>{mine ? "选好下面第 1 席的模型, 点上面\"开局\"; 这局的进展在上面群卡里" : group.kind === "server" ? "联机服务器: 点上面\"只读连接\", 不叫模型" : "这个群还没开过班 (或没在看它的班): 点上面\"开班\""}</div></section> : null}
        {!landing && scan ? <section className="panel-section scan" data-scan>
          <div className="panel-section-title">开班扫描<span className="sub">{scan.stage}</span></div>
          <ol className="fix-list">{[...scan.judgement.slice(1), ...scan.plan].map((l, i) => <li key={i}><span>{l}</span></li>)}</ol>
          <button className="link-button" onClick={() => setScanOpen((v) => !v)}>{scanOpen ? "收起现状" : `现状读数 ${scan.lines.length} 行`}</button>
          {scanOpen ? <ul className="review-lines">{scan.lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
        </section> : null}
        {!landing ? <section className="panel-section notice">
          <div className="panel-section-title">群公告<span className="sub">{reviewTitle} · 先修这几条</span></div>
          {review ? (
            <>
              {review.fixes.length ? <ol className="fix-list">{review.fixes.map((f, i) => <li key={i}><span>{f}</span></li>)}</ol> : <div className="panel-empty">没有要先修的</div>}
              {review.lines.length ? <button className="link-button" onClick={() => setReviewOpen((v) => !v)}>{reviewOpen ? "收起读数" : `复盘读数 ${review.lines.length} 行 · ${runLabel(review.run)}`}</button> : null}
              {reviewOpen ? <ul className="review-lines">{review.lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
            </>
          ) : <div className="panel-empty">还没有复盘 (每班结束时自动写)</div>}
        </section> : null}

        <section className="panel-section">
          <div className="panel-section-title">在线成员 {online}<span className="sub">共 {members.length + 1}</span></div>
          <div className="member-list">
            {members.filter((m) => !m.agent?.left).map((m) => (
              <div key={m.id} className="member-line">
                <button className={`member-row${m.id === selected ? " selected" : ""}`} data-id={m.id} onClick={() => onSelect(m.id)} title={`和 ${m.title} 单聊`}>
                  <Avatar vendor={vendorOf(m.agent?.model)} text={(m.agent?.name?.[0] ?? agentLabel(m.id)).toUpperCase()} state={m.presence} />
                  <span className="member-text"><span className="member-name">{m.title}</span>{m.agent ? <span className="member-sub">{m.id === "a" && !m.agent.bot ? "控制你的账号 · " : ""}游戏里: {m.agent.name}{quietLabel(m.agent.quietS) ? ` · ${quietLabel(m.agent.quietS)}` : ""}</span> : null}</span>
                  {m.presence ? <span className={`member-tag s-${m.presence}`}>{m.presence === "没在跑" ? "离线" : m.presence}</span> : null}
                </button>
                {accountMode && onMakeAccount && m.id !== "a" && m.agent?.seat && seatValue(m.agent.seat) !== (admin ? seatValue(admin) : "") ? <button className="link-button" data-make-account={m.id} disabled={inviteBusy} title="下一班起让这个模型控制你的账号 (这一班不变; 想马上换: 停班再开班)" onClick={() => act(() => onMakeAccount(m.agent!.seat!))}>控制我的账号</button> : null}
                {/* 点了要马上看得见 (成功后这一行整个消失) */}
                {liveEdit && m.agent?.bot && members.filter((x) => !x.agent?.left).length > 1 ? <button className="link-button danger-link" data-leave={m.id} disabled={inviteBusy || leaving.includes(m.id)} title="现在就移出: 大脑停, 游戏角色收回, 背包放进旁边的钢箱 (30 秒内生效)" onClick={() => { setLeaving((l) => [...l, m.id]); act(() => onLeaveAgent!(m.id)); }}>{leaving.includes(m.id) ? "移出中, 30 秒内" : "移出"}</button> : null}
              </div>
            ))}
            {/* "我" = 用户本人; 下拉选谁控制用户的账号 = 第 1 个角色 (11-05 看到这里写 Opus、在线的是 Haiku, 问"这个是我们整个群的大脑思维对吧": 不是, 而且要写明是下一班) */}
            <div className="member-row me" data-id="me">
              <Avatar vendor={null} text="我" me />
              <span className="member-text"><span className="member-name">我 · 管理员</span>
                {/* 在这一行里选谁用用户的 Steam 账号玩 (2026-11-08: 不再是单独的对话类型): 选了模型 = 它用你的账号在本机玩这个世界, 只走玩家操作、不装模组, 算成就; "我自己" = 看和说话 */}
                {admin ? <span className="member-sub" data-me-model>{run?.running ? "下一班起 " : ""}{group?.kind === "server" ? "控制你账号的模型" : "用你的 Steam 账号玩这个世界的模型"}: {seatDisplay(admin)}{admin.effort ? ` · 强度 ${effortLabel(admin.effort)}` : ""}{group?.kind === "server" ? "" : " (只走玩家操作, 不装模组, 算成就)"}</span> : <span className="member-sub" data-observer>在游戏窗口里看和说话, 不占角色</span>}
                {run?.running && liveAccount?.agent?.seat && admin && seatValue(liveAccount.agent.seat) !== seatValue(admin) ? <span className="member-sub" data-account-now>这一班还是 {seatDisplay(liveAccount.agent.seat)}</span> : null}
                {(group?.kind === "server" ? onSetSeat : onSetMe) ? <span className="admin-controls">
                  <select className="key-select admin-select" data-me-select value={admin ? seatValue(admin) : "self"} disabled={inviteBusy} aria-label="谁用你的账号玩" onChange={(e) => act(() => group?.kind === "server" ? onSetSeat!(0, e.target.value) : onSetMe!(e.target.value === "self" ? null : parseSeatValue(e.target.value)))}>
                    {group?.kind !== "server" ? <option value="self">我自己 (看和说话, 不占角色)</option> : null}
                    {groups.map((gr) => <optgroup key={gr.label} label={gr.label}>{gr.items.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}</optgroup>)}
                  </select>
                  {group?.kind === "server" ? effortSelect(0, admin ?? { brain: "claude", model: "opus" }) : admin && onSetMe ? (
                    <select className="key-select effort-select" value={admin.effort ?? ""} disabled={inviteBusy} aria-label="思考强度" onChange={(e) => act(() => onSetMe({ ...admin, ...(e.target.value ? { effort: e.target.value } : {}) }))}>
                      <option value="">强度: 默认 (low)</option>
                      {["low", "medium", "high", "xhigh", "max"].map((x) => <option key={x} value={x}>{effortLabel(x)}</option>)}
                    </select>
                  ) : null}
                </span> : null}</span>
              <span className={`member-tag${connected ? " s-在线" : ""}`}>{connected ? "在线" : "连不上"}</span>
            </div>
          </div>
          {/* 我的账号只有一个身体, 没有名单 */}
          {mine ? null : <>
          {/* 下一班名单和本班在线的分开: 名单和本班阵容一样时只写一行 */}
          <div className="panel-section-title" style={{ marginTop: 10 }}>{liveEdit ? "加人" : `名单 ${nextSeats.length ? nextSeats.length : ""}`}
            {onSaveSeats ? <button className="link-button sub" data-edit-members onClick={() => (editing ? setEditing(false) : openEditor())}>{editing ? "收起" : "编辑名单"}</button> : null}
          </div>
          {editing && onSaveSeats ? (
            <div className="member-editor" data-member-editor>
              {groups.map((gr) => (
                <div key={gr.label} className="member-group">
                  <div className="member-group-title">{gr.label}</div>
                  {gr.items.map((o) => { const n = draft[o.value] ?? 0; return (
                    <label key={o.value} className={`member-option${o.disabled ? " off" : ""}${n ? " on" : ""}`} data-member-option={o.value}>
                      <input type="checkbox" checked={n > 0} disabled={!!o.disabled || inviteBusy} onChange={(e) => bump(o.value, e.target.checked ? 1 : 0)} />
                      <span className="member-option-name">{o.label}</span>
                      {n > 0 ? <span className="member-count" title="同一个模型要几个角色"><button type="button" disabled={inviteBusy} onClick={() => bump(o.value, n - 1)} aria-label="少一个">−</button><b data-count>{n}</b><button type="button" disabled={inviteBusy} onClick={() => bump(o.value, n + 1)} aria-label="多一个">+</button></span> : null}
                    </label>); })}
                </div>
              ))}
              <div className="lineup-foot">
                <button className="small-primary" data-member-save disabled={inviteBusy} onClick={saveEditor}>{inviteBusy ? "正在存…" : accountMode ? `保存 (管理员 + ${draftTotal} 个角色)` : `保存 (${draftTotal} 个角色)`}</button>
                <button className="link-button" disabled={inviteBusy} onClick={() => setEditing(false)}>取消</button>
                <span className="member-sub">{liveEdit ? "保存后 30 秒内生效: 新勾的进来干活, 去掉的移出; " : "勾上 = 开班时多一个角色用这个模型; "}同一个模型要几个就点 +; 灰的那家没登录 / 没填密钥</span>
              </div>
              {inviteError ? <div className="member-sub bad">{inviteError}</div> : null}
            </div>
          ) : null}
          <div className="member-list" data-next-list>
            {sameAsLive && !liveEdit ? <div className="member-sub" style={{ padding: "4px 6px" }} data-next-same>同本班阵容 ({nextSeats.length} 人): {nextSeats.map(seatDisplay).join("、")}; 要换就编辑名单</div> : null}
            {run?.running && !run.rosterLive && !sameAsLive ? <div className="member-sub" style={{ padding: "4px 6px" }} data-next-note>这一班开的时候还没有中途加人功能, 下面的名单下一班才生效</div> : null}
            {!sameAsLive && !liveEdit ? nextSeats.map((s, i) => (accountMode && i === 0 ? null : (
              <div key={i} className="member-next" data-next={i}>
                <Avatar vendor={vendorOf(s.model || s.brain)} text={seatWord(s).charAt(0).toUpperCase()} />
                <span className="member-text"><span className="member-name">{seatDisplay(s)}</span><span className="member-sub">{seatLabel(nextSeats, i, accountMode)}</span>{effortSelect(i, s)}</span>
                <span className="member-tag">待开班</span>
                {accountMode && onMakeAccount ? <button className="link-button" disabled={inviteBusy} title="让这个模型控制你的账号, 原来第 1 个变成普通队员" onClick={() => act(() => onMakeAccount(s))}>控制我的账号</button> : null}
                {onRemoveSeat && nextSeats.length > 1 ? <button className="link-button danger-link" disabled={inviteBusy} title="从名单去掉" onClick={() => act(() => onRemoveSeat(i))}>移出</button> : null}
              </div>
            ))) : null}
            {!editing && inviteError ? <div className="member-sub bad">{inviteError}</div> : null}
            {accountMode && seats && seats.length <= 1 && !editing ? <div className="member-sub" style={{ padding: "4px 6px" }}>只有管理员 (我); 点"编辑名单"勾几个模型当队友</div> : null}
          </div>
          </>}
        </section>

        {!landing ? <>
        <section className="panel-section">
          <div className="panel-section-title">游戏读数{run ? <span className="sub">{runLabel(run.id)}</span> : null}</div>
          {g ? (
            <div className="stats">
              <div className="stat"><div className="stat-label">游戏时间</div><div className="stat-value">{fmtGameTime(g.gameMinutes)}</div></div>
              <div className="stat"><div className="stat-label">研究中心在工作</div><div className="stat-value">{g.labsWorking ?? "—"}<small>/ {g.labs ?? "—"}</small></div></div>
              <div className="stat wide"><div className="stat-label">正在研究</div><div className="stat-value" title={g.research ? zh(g.research) : undefined}>{g.research ? zh(g.research) : "没有"}<small>已研究 {g.researched ?? "—"} 项</small></div></div>
              <div className="stat wide"><div className="stat-label">生产机器</div><div className="stat-value">{g.machines ?? "—"}<small>台</small></div></div>
            </div>
          ) : <div className="panel-empty">还没有读数</div>}
        </section>

        <section className="panel-section">
          <div className="panel-section-title">近 10 分钟每分钟产量</div>
          {g?.perMin10 ? (
            <div className="rates">
              {SCIENCE.map((s) => {
                const name = zh(s.item);
                return (
                  <div className="rate" key={s.key}>
                    <span className={`rate-dot ${s.key}`} />
                    <span className="rate-name" title={name}>{name === s.item ? s.fallback : name}</span>
                    <span className="rate-value">{fmtRate(g.perMin10![s.key])}<small>个/分</small></span>
                  </div>
                );
              })}
            </div>
          ) : <div className="panel-empty">还没有读数</div>}
        </section>

        <section className="panel-section stats-section">
          {/* 每个模型的统计和排行: 按每真实小时科技包产量增量排, 这里只放前 3, 点开看全表 */}
          <div className="panel-section-title">统计 · 排行{stats?.length ? <button className="link-button sub" onClick={onStats}>看全表 ({stats.length} 个模型)</button> : null}</div>
          {stats?.length ? (
            <ol className="stats-rank">
              {stats.slice(0, 3).map((m, i) => (
                <li key={m.model} className="stats-row">
                  <span className="stats-pos">{i + 1}</span>
                  <span className="stats-text">
                    <span className="stats-model">{m.vendor}<span className="stats-model-id"> · {m.model}</span></span>
                    <span className="stats-detail">{m.shifts} 班 {fmtNum(m.realHours)} 小时 · 产量/分 {fmtNum(m.scienceAvg)} · 建造 {m.builds} · 算配比 {m.calc} · 查经验 {m.knowledge} · 花费 {m.costUsd === null ? "—" : `$${fmtNum(m.costUsd, 2)}`}</span>
                  </span>
                  <span className="stats-gain" title="每真实小时科技包每分钟产量的增量 (班末比上一班)">{fmtSigned(m.gainPerHour)}<span className="stats-unit">/小时</span></span>
                </li>
              ))}
            </ol>
          ) : <div className="panel-empty">{stats === null || stats === undefined ? "还没读到统计" : "还没有跑完的班 (中断的班不计)"}</div>}
        </section>

        <section className="panel-section">
          {/* 看门狗 / 死亡 (M6 2026-11-04): 停机秒数和占比 (指标 <5%)、恢复次数和最近一次、本班死亡、自动排研究 */}
          <div className="panel-section-title">看门狗{state?.watchdog?.down ? <span className="sub warn-text">掉线中</span> : null}</div>
          {wd.length ? <ul className="health-list watchdog-list">{wd.map((l, i) => <li key={i}>{l}</li>)}</ul> : <div className="panel-empty">这一班没有看门狗记录 (11-04 之前的班, 或还没开始采样)</div>}
        </section>

        <section className="panel-section">
          {/* 蓝图预览入口: 这一班大脑看过 / 用过的蓝图 (./bp show / file / build 记的), "预览"在本机蓝图编辑器里打开 (控制接口负责起编辑器和开浏览器) */}
          <div className="panel-section-title">蓝图<button className="link-button sub" onClick={() => onOpenBlueprint?.()}>打开编辑器</button></div>
          {blueprints?.length ? (
            <ul className="health-list bp-list">{blueprints.slice(0, 8).map((b, i) => (
              <li key={i}>
                <span className="bp-label" title={`${b.source} · ${b.cmd} · ${b.agent} · ${b.at}`}>{b.label}</span>
                <small>{b.w}×{b.h}</small>
                {b.link ? <button className="link-button" onClick={() => onOpenBlueprint?.(b.link!)}>预览</button> : null}
              </li>
            ))}</ul>
          ) : <div className="panel-empty">这一班还没看过蓝图 (大脑用 ./bp show / build 时会记在这里)</div>}
        </section>

        <section className="panel-section">
          <div className="panel-section-title">体检</div>
          {state?.health?.length ? (
            <>
              <ul className="health-list">{state.health.map((l, i) => <li key={i} className={allHealth ? undefined : "clamped"}>{l}</li>)}</ul>
              <button className="link-button" onClick={() => setAllHealth((v) => !v)}>{allHealth ? "收起" : "看全文"}</button>
            </>
          ) : <div className="panel-empty">没有问题 (或还没体检)</div>}
        </section>
        </> : null}


        <section className="panel-section">
          <div className="panel-section-title">额度</div>
          {/* 每家一行; 写剩多少, 条的长度 = 剩的。
              Claude 在跑时用大脑报的官方额度事件 (state.quota), 其余各家用账号页读到的 (accounts) */}
          {(() => {
            const rows = (accounts ?? []).map((a) => accountQuota(a, now ?? Date.now()));
            const claude = rows.find((r) => r.name === "Claude");
            if (u !== null || !claude) {
              const row = { name: "Claude", remain: u === null ? null : Math.max(0, 1 - u), value: u === null ? "—" : `剩 ${fmtPct(Math.max(0, 1 - u))}`, detail: `${quotaDetail(state?.quota?.text)}${state?.quota?.why ? ` (${state.quota.why})` : ""}` };
              if (claude) rows[rows.indexOf(claude)] = row; else rows.unshift(row);
            }
            return rows.map((r) => {
              const left = r.remain === null ? null : Math.max(0, Math.min(1, r.remain));
              return (
                <div className="quota-item" key={r.name}>
                  <div className="quota-row"><span className="quota-name">{r.name}</span><span className="quota-pct">{r.value}</span></div>
                  {left !== null ? <div className="quota-bar"><div className={left <= 0.15 ? "high" : left <= 0.4 ? "mid" : ""} style={{ width: `${Math.round(left * 100)}%` }} /></div> : null}
                  <div className="quota-text">{r.detail}</div>
                </div>
              );
            });
          })()}
          {!accounts?.length && u === null ? <div className="panel-empty">还没读到额度 (点左下角"账号 · 设置")</div> : null}
        </section>
      </div>
      <div className="panel-foot">
        {(() => { const b = stopButton(connected, run); return (<>
          <button className="stop-button" disabled={b.disabled} onClick={onStop}>{b.label}</button>
          <div className="stop-note">{b.note}</div>
        </>); })()}
      </div>
    </aside>
  );
}

/** 我的账号的群: 目标、开局 / 停局、这一局的进展 */
function MineCard({ group, mk, startBusy, onStart, onStop, onSetGoal }: { group: Group; mk: MkState | null; startBusy: boolean; onStart?: () => void; onStop?: () => Promise<void>; onSetGoal?: (goal: string) => Promise<void> }) {
  const [goal, setGoal] = useState(group.goal ?? "");
  const [stopBusy, setStopBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = !!mk?.running;
  const here = running && mk?.current?.group === group.id;
  const status = mkStatusLine(mk, group.id);
  return (
    <div data-mine-card>
      <div className="settings-title" style={{ marginTop: 8 }}>这一局要它做什么</div>
      <textarea className="world-rename" data-mine-goal style={{ width: "100%", margin: 0, minHeight: 64, resize: "vertical" }} maxLength={2000} value={goal} disabled={running} placeholder="例: 摧毁一个虫巢, 拿成就&quot;害虫防治&quot;。不写就让它自己玩" onChange={(e) => setGoal(e.target.value)} onBlur={() => { if (goal.trim() !== (group.goal ?? "") && onSetGoal) onSetGoal(goal).catch((e: Error) => setError(e.message)); }} />
      <div className="lineup-foot">
        {here && onStop ? <button className="primary-button" data-mine-stop disabled={stopBusy || !!mk?.stopping} onClick={() => { setStopBusy(true); setError(null); onStop().catch((e: Error) => setError(e.message)).finally(() => setStopBusy(false)); }}>{mk?.stopping ? "正在收尾…" : "停下这一局"}</button> : onStart ? <button className="primary-button" data-group-start disabled={startBusy || running} onClick={onStart}>{startBusy ? "正在开…" : running ? "账号正在别处玩" : "开局"}</button> : null}
        <span className="member-sub">开局 = 打开你的 Steam 版, 连到本机这个群自己的图, 第 1 席的模型只用普通玩家操作来玩, 能拿成就; 每局最长 {group.minutes} 分钟, 这张图下次接着玩。你开着游戏时开不了; 关窗口或关界面都会停; 这局期间可以随便切窗口、拖窗口。</span>
      </div>
      {status ? <div className="member-sub" data-mine-status>{status}</div> : null}
      {here && mk?.lines.length ? <ul className="review-lines" data-mine-lines>{mk.lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
      {error ? <div className="account-note bad">{error}</div> : null}
    </div>
  );
}
