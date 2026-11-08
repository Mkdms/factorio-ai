// 弹窗: 停班确认、账号 · 设置 (外观; 三家命令行 Claude Code / Grok Build / Codex 登没登、登录按钮、剩多少额度; DeepSeek / GLM 填密钥、余额 / 额度;
// 中转站 (New API, 2026-11-04) 填站点 + 令牌、选给大脑的模型; 读控制接口 /api/accounts)。
import { useEffect, useState, type ReactNode } from "react";
import { BASE } from "../api.ts";
import { BACKEND_OPTIONS, MAX_SEATS, ROUTE_OPTIONS, SOURCES, type BackendPref, type GroupRoute, type NewGroupInput, accountStatus, alertLine, fmtBalance, fmtNum, fmtPct, fmtSigned, groupKindLabel, lineupOptions, parseSeatValue, relayModelGroups, remainPct, resetIn, runLabel, seatLabel, seatValue, vendorOf, EFFORTS, verifyLine, type Account, type Alert, type Group, type KeyPatch, type ModelStat, type RosterSeat, type ShiftAgentStat, type VerifyStatus, type WorldInfo } from "../logic.ts";
/** 存密钥: key 不给 = 不改密钥 (中转站只改系统访问令牌时); extra 只有中转站用 */
type SaveKey = (id: string, key?: string, extra?: KeyPatch) => Promise<void>;
import { Avatar } from "./Avatar.tsx";
import { THEME_CHOICES, themeNote, type ThemeChoice } from "../theme.ts";

function Modal({ title, children, onClose, wide, className }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; /** 额外样式类 */ className?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? " wide" : ""}${className ? ` ${className}` : ""}`} role="dialog" aria-label={title}>
        <div className="modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** 新建对话 = 新建一个群 (世界):
 *  名字、类型 (新地图 / 接着存档 / 联机服务器)、一班多少分钟; 成员建好后在群里"拉人"。记录都在 lab-data (I 盘), 不在 C 盘 */
export function NewGroupModal({ worlds, onCreate, onClose }: { worlds: WorldInfo[] | null; onCreate: (input: NewGroupInput) => Promise<void>; onClose: () => void }) {
  const [reveal, setReveal] = useState(false);
  const [password, setPassword] = useState("");
  const [backend, setBackend] = useState<BackendPref>("auto");
  const [rconAddress, setRconAddress] = useState("");
  const [rconPassword, setRconPassword] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Group["kind"]>("new");
  const [route, setRoute] = useState<GroupRoute>("memory");
  const [save, setSave] = useState("");
  const [address, setAddress] = useState("");
  const [minutes, setMinutes] = useState("180");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true); setError(null);
    try { await onCreate({ name, kind, ...(kind === "new" || kind === "save" ? { route } : {}), ...(kind === "save" ? { save } : {}), ...(kind === "server" ? { server: { address, password, ...(backend !== "memory" && (rconAddress || rconPassword) ? { rcon: { address: rconAddress, password: rconPassword } } : {}) }, revealUncharted: reveal, backend } : {}), ...(kind === "mine" ? { goal } : {}), minutes: Number(minutes) || 180 }); onClose(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="新建对话 (= 新建一个群 / 世界)" onClose={onClose} className="new-group-modal">
      <div className="modal-body" data-new-group-modal>
        <div className="settings-title">名字</div>
        <input className="world-rename" style={{ width: "100%", margin: 0 }} data-group-name autoFocus value={name} maxLength={40} placeholder="例: 第二张图 / 朋友的服务器" onChange={(e) => { setName(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create(); }} />
        <div className="settings-title" style={{ marginTop: 12 }}>类型</div>
        <div className="segmented" role="radiogroup" aria-label="类型">
          {(["new", "save", "server"] as const).map((k) => <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? "on" : undefined} onClick={() => setKind(k)}>{groupKindLabel(k)}</button>)}
        </div>
        {kind === "new" || kind === "save" ? (
          <div style={{ marginTop: 8 }} data-group-route>
            <div className="settings-title">走哪条路</div>
            <div className="segmented" role="radiogroup" aria-label="路线">
              {ROUTE_OPTIONS.map((o) => <button key={o.value} role="radio" aria-checked={route === o.value} className={route === o.value ? "on" : undefined} onClick={() => setRoute(o.value)}>{o.label}</button>)}
            </div>
            <div className="settings-note">{ROUTE_OPTIONS.find((o) => o.value === route)?.note}</div>
          </div>
        ) : null}
        {kind === "save" ? (
          <div style={{ marginTop: 8 }}>
            <div className="settings-note">存档 (.zip) 的路径; 选现有的一条存档链 = 接它最近一班的结束存档:</div>
            <select className="key-select" style={{ maxWidth: "100%", marginTop: 4 }} value="" onChange={(e) => { if (e.target.value) setSave(e.target.value); }}>
              <option value="">(选一条存档链, 或在下面手填)</option>
              {(worlds ?? []).filter((w) => w.runs.some((r) => r.ended)).map((w) => { const r = w.runs.find((x) => x.ended)!; return <option key={w.id} value={`__run__:${r.id}`}>{w.name} · {r.label}</option>; })}
            </select>
            <input className="world-rename" style={{ width: "100%", margin: "4px 0 0" }} value={save} placeholder="I:\\...\\lab-data\\play\\runs\\<班次>\\end.zip" onChange={(e) => setSave(e.target.value)} />
          </div>
        ) : null}
        {kind === "server" ? (
          <div style={{ marginTop: 8 }}>
            <div className="settings-note">联机服务器 (协助模式)。地址和密码只存本机, 不进备份。建好后能只读连接, 真模型的班还开不了。</div>
            <div className="settings-title" style={{ marginTop: 8 }}>地址和密码</div>
            <div className="server-inputs">
              <input className="world-rename" data-group-address value={address} placeholder="主机:端口; 空着 = 用本机存的" onChange={(e) => setAddress(e.target.value)} />
              <input className="world-rename" data-group-password type="password" value={password} placeholder="密码 (没有就空着)" onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="settings-title" style={{ marginTop: 8 }}>走哪条路</div>
            <select className="key-select" style={{ maxWidth: "100%" }} data-group-backend-new value={backend} onChange={(e) => setBackend(e.target.value as BackendPref)}>
              {BACKEND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <div className="settings-note">{BACKEND_OPTIONS.find((o) => o.value === backend)?.note}</div>
            {backend !== "memory" ? (
              <div data-group-rcon-new>
                <div className="settings-title" style={{ marginTop: 8 }}>RCON 地址和密码 (服务器没开就空着)</div>
                <div className="server-inputs">
                  <input className="world-rename" data-group-rcon-address-new value={rconAddress} placeholder="主机:端口" onChange={(e) => setRconAddress(e.target.value)} />
                  <input className="world-rename" data-group-rcon-password-new type="password" value={rconPassword} placeholder="密码" onChange={(e) => setRconPassword(e.target.value)} />
                </div>
              </div>
            ) : null}
            <label className="settings-note" style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 8 }}>
              <input type="checkbox" data-group-reveal checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
              <span>让 AI 也看没探过的地方 (内存里有整张图, 虫巢和矿都读得到)。默认关: 和真人玩家看到的一样。</span>
            </label>
          </div>
        ) : null}
        {kind === "mine" ? (
          <div style={{ marginTop: 8 }} data-mine-new>
            <div className="settings-note">用你的 Steam 账号玩本机一张新图: 选一个模型, 只走普通玩家操作, 不装模组、不开 RCON, 能拿成就。你自己开着游戏时开不了。</div>
            <div className="settings-title" style={{ marginTop: 8 }}>这一局要它做什么 (可以不写)</div>
            <textarea className="world-rename" style={{ width: "100%", margin: 0, minHeight: 64, resize: "vertical" }} maxLength={2000} value={goal} placeholder="例: 摧毁一个虫巢, 拿成就&quot;害虫防治&quot;" onChange={(e) => setGoal(e.target.value)} />
          </div>
        ) : null}
        <div className="settings-title" style={{ marginTop: 12 }}>{kind === "mine" ? "每局最长 (分钟)" : "每班时长 (分钟)"}</div>
        <div className="settings-note">{kind === "mine" ? "到点模型停下、关游戏、比成就; 这张图下次接着玩" : "所有 AI 一起玩这么久, 到点存档、写复盘、换新的大脑会话接着玩 (游戏不关); 点右栏\"停班\"才停。派对是 4 小时一班, 默认 180"}</div>
        <input className="world-rename" style={{ width: 120, margin: 0 }} type="number" min={5} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        <div className="modal-note">{kind === "mine" ? "建好后在右栏第 1 席选模型, 群卡上点\"开局\"。" : kind === "server" ? "建好后在右栏群卡上点\"只读连接\"。" : "建好后在右栏\"编辑名单\"里选模型进群 (默认 1 个 Claude Opus), 群卡上点\"开班\"。"}记录和笔记都在 I 盘的 lab-data 和大脑目录里, 不占 C 盘。</div>
        {error ? <div className="account-note bad" style={{ marginTop: 8 }}>{error}</div> : null}
      </div>
      <div className="modal-buttons">
        <button className="secondary" onClick={onClose} disabled={busy}>取消</button>
        <button className="primary" data-group-create disabled={busy || !name.trim() || (kind === "save" && !save.trim()) || (kind === "server" && !address.trim())} onClick={create}>{busy ? "正在建…" : "创建"}</button>
      </div>
    </Modal>
  );
}

/** 大脑接口警报弹窗: 哪个角色、哪个模型、走哪条线、原文; 点"知道了"记成看过 */
export function AlertModal({ alerts, onClose }: { alerts: Alert[]; onClose: () => void }) {
  return (
    <Modal title={alerts.every((a) => a.kind === "tool") ? `工具有问题 (${alerts.length} 条)` : `大脑接口不通 (${alerts.length} 条)`} onClose={onClose} className="alert-modal">
      <div className="modal-body" data-alerts>
        {alerts.map((a, i) => { const l = alertLine(a); return (
          <div className="alert-item" key={i}>
            <div className="alert-title">{l.title}<span className="alert-time">{new Date(a.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span></div>
            <pre className="alert-text">{l.detail}</pre>
          </div>
        ); })}
        <div className="modal-note">中转站: 多半是站里这条渠道转协议时上游不收某个字段 / 令牌没分到这个模型 / 余额; 把原文给站长看。DeepSeek: 看余额和密钥。这一班其他角色照常跑; 换模型在右栏"下一班名单"。</div>
      </div>
      <div className="modal-buttons"><button className="primary" onClick={onClose}>知道了</button></div>
    </Modal>
  );
}

/** down = 连不上控制接口: 这次由桌面外壳直接写停班标记, 弹窗里说清楚; runId 空 = 还没连上过, 不知道是哪一班 */
export function StopModal({ runId, down, onConfirm, onClose }: { runId: string; down?: boolean; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="停班: 这一班存档收尾?" onClose={onClose}>
      <div className="modal-body" data-stop-modal>
        {runId ? `${runLabel(runId)}的这一班` : "正在跑的这一班"}会先存档, 写复盘, 然后停下 (大脑都停)。<br />
        这一步不能撤回; 想接着玩要重新开一班。
        {down ? <div className="modal-note">现在连不上控制接口, 这次由界面直接给在跑的那一班写停班标记 (效果一样: 大脑看到后存档收尾)。直接关掉游戏窗口也等于停班。</div> : null}
        {error ? <div style={{ color: "var(--red)", marginTop: 8 }}>没停成: {error}</div> : null}
      </div>
      <div className="modal-buttons">
        <button className="secondary" onClick={onClose} disabled={busy}>取消</button>
        <button className="danger" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try { await onConfirm(); onClose(); } catch (e) { setError((e as Error).message); setBusy(false); }
        }}>{busy ? "正在发…" : "存档收尾"}</button>
      </div>
    </Modal>
  );
}

export function AccountsModal({ accounts, accountsError, loading, watching, now, down, onClose, onRefresh, onLogin, onSaveKey, seats, onSaveLineup, theme, systemDark, onTheme, onVerifyRelay, relayVerifyStatus }: {
  accounts: Account[] | null; accountsError: string | null; loading: boolean; watching: string | null; now: number; down: boolean;
  onClose: () => void; onRefresh: () => void; onLogin: (id: string) => Promise<void>; onSaveKey: SaveKey;
  /** 下一班阵容 (null = 还没读到) 和存它 */
  seats: RosterSeat[] | null; onSaveLineup: (seats: RosterSeat[]) => Promise<void>;
  theme: ThemeChoice; systemDark: boolean; onTheme: (c: ThemeChoice) => void;
  /** 中转站模型核实: 开始一轮 / 看进度 */
  onVerifyRelay?: () => Promise<void>; relayVerifyStatus?: () => Promise<VerifyStatus>;
}) {
  return (
    <Modal title="账号 · 设置" onClose={onClose} wide>
      <div className="settings-title">外观</div>
      <div className="segmented" role="radiogroup" aria-label="外观">
        {THEME_CHOICES.map((c) => (
          <button key={c.id} role="radio" aria-checked={theme === c.id} className={theme === c.id ? "on" : undefined} onClick={() => onTheme(c.id)}>{c.label}</button>
        ))}
      </div>
      <div className="settings-note">{themeNote(theme, systemDark)} · 选择会记住, 下次打开还是它</div>
      <div className="settings-title" style={{ marginTop: 18 }}>下一班阵容</div>
      <LineupEditor seats={seats} accounts={accounts} onSave={onSaveLineup} />
      <div className="settings-title account-head" style={{ marginTop: 18 }}>
        <span>账号</span>
        <button className="link-button" onClick={onRefresh} disabled={loading || down}>{loading ? "正在查…" : "刷新"}</button>
      </div>
      <div className="account-list">
        {accounts ? accounts.map((a) => a.kind === "key" ? <KeyRow key={a.id} a={a} now={now} onSave={onSaveKey} onVerify={a.id === "relay" ? onVerifyRelay : undefined} verifyStatus={a.id === "relay" ? relayVerifyStatus : undefined} onDone={onRefresh} />
          : <AccountRow key={a.id} a={a} now={now} watching={watching === a.id} onLogin={onLogin} />)
          : <div className="account-row"><span className="detail off">{down ? "连不上控制接口, 读不到账号" : accountsError ? `没读到: ${accountsError}` : "正在查各家的命令行和密钥…"}</span></div>}
        <div className="account-row"><span className="avatar small">接</span><span className="name">控制接口</span>
          <span className={`detail${down ? " off" : ""}`}>{BASE.replace("http://", "")}<br />{down ? "连不上" : "已连上"}</span></div>
      </div>
      <div className="modal-note">登录在弹出的命令行窗口里完成, 界面不经手密码; 密钥和令牌只存本机。给角色分模型在上面的"下一班阵容"。</div>
      <div className="modal-buttons"><button className="primary" onClick={onClose}>好</button></div>
    </Modal>
  );
}

/** 下一班阵容: 每个角色一行选模型 (来源: Claude 订阅 / Grok / DeepSeek / 中转站的模型 / 测试), 改一行就存;
 *  第 1 个是你的账号 (连着窗口的玩家), 其余是服务器角色。同一班里可以几个角色都走中转站、各用不同模型 */
function LineupEditor({ seats, accounts, onSave }: { seats: RosterSeat[] | null; accounts: Account[] | null; onSave: (seats: RosterSeat[]) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = lineupOptions(accounts);
  const rows: RosterSeat[] = seats && seats.length ? seats : [{ brain: "claude", model: "opus" }];
  const save = async (next: RosterSeat[]) => {
    setBusy(true); setError(null);
    try { await onSave(next); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const set = (i: number, v: string) => save(rows.map((s, k) => (k === i ? { ...parseSeatValue(v), ...(s.effort ? { effort: s.effort } : {}) } : s)));
  const setEffort = (i: number, e: string) => save(rows.map((s, k) => (k === i ? { brain: s.brain, model: s.model, ...(e ? { effort: e } : {}) } : s)));
  if (!seats) return <div className="account-note">正在读阵容…</div>;
  return (
    <div className="lineup-list" data-lineup>
      {rows.map((s, i) => {
        const v = seatValue(s);
        const known = groups.some((g) => g.items.some((o) => o.value === v));
        return (
          <div className="lineup-row" key={i}>
            <span className="lineup-label">{seatLabel(rows, i)}</span>
            <select className="key-select" value={v} disabled={busy} aria-label={`角色 ${i + 1} 的模型`} onChange={(e) => set(i, e.target.value)}>
              {known ? null : <option value={v}>{v} (现在选不到: 没登录 / 没填密钥?)</option>}
              {groups.map((g) => <optgroup key={g.label} label={g.label}>{g.items.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}</optgroup>)}
            </select>
            <select className="key-select effort-select" value={s.effort ?? ""} disabled={busy} aria-label={`角色 ${i + 1} 的思考强度`} title="思考强度 (Claude Code --effort / Grok / Codex 同样几档; 默认 = 开班命令行的 --effort)" onChange={(e) => setEffort(i, e.target.value)}>
              <option value="">强度: 默认</option>{EFFORTS.map(([k, name]) => <option key={k} value={k}>强度: {name}</option>)}
            </select>
            {rows.length > 1 ? <button className="link-button danger-link" disabled={busy} onClick={() => save(rows.filter((_, k) => k !== i))}>去掉</button> : null}
          </div>
        );
      })}
      <div className="lineup-foot">
        {rows.length < MAX_SEATS ? <button className="link-button" disabled={busy} onClick={() => save([...rows, { brain: "relay", model: "" }].map((s) => (s.brain === "relay" && !s.model ? firstRelay(groups) ?? { brain: "claude", model: "opus" } : s)))}>加一个角色</button> : null}
        <span className="account-note">{seats.length ? "已存; 开班没给 --brains 就按这个" : "还没存过 (默认 1 个角色 Claude Opus); 改一下就存"}{busy ? " · 正在存…" : ""}</span>
      </div>
      {error ? <div className="account-note bad">{error}</div> : null}
    </div>
  );
}
/** 加角色时的默认: 中转站有能直接用的模型就用第一个, 不然 Claude Opus */
function firstRelay(groups: { label: string; items: { value: string; disabled?: boolean }[] }[]): RosterSeat | null {
  const g = groups.find((x) => x.label.startsWith("中转站 · 核实能用")) ?? groups.find((x) => x.label.startsWith("中转站 · Claude 格式"));
  const o = g?.items.find((x) => !x.disabled);
  return o ? parseSeatValue(o.value) : null;
}


/** 每个额度窗口一条: 剩多少 %、几天后重置 */
/** 来源 · 致谢: 搬来 / 借鉴的东西从哪里来、什么许可 (全文在仓库 NOTICE) */
export function SourcesModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="来源 · 致谢" onClose={onClose} wide>
      <div className="modal-body">
        <div className="modal-note">这些是从别人的开源项目搬来或借鉴的, 按各自的许可署名; 完整说明在仓库根目录的 NOTICE。</div>
        <div className="account-list">
          {SOURCES.map((s) => (
            <div className="account-row source-row" key={s.what}>
              <div className="source-text">
                <div className="source-what">{s.what}</div>
                <div className="source-from">{s.from} · {s.license} · 用在 {s.where}</div>
                <a className="source-link" href={s.url} target="_blank" rel="noreferrer">{s.url}</a>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="modal-buttons"><button className="primary" onClick={onClose}>好</button></div>
    </Modal>
  );
}

/** 统计 · 排行全表: 上面按模型汇总 (排行), 下面每班每角色一行 (新的在前) */
export function StatsModal({ models, shifts, onClose }: { models: ModelStat[]; shifts: ShiftAgentStat[]; onClose: () => void }) {
  const money = (x: number | null) => (x === null ? "—" : `$${fmtNum(x, 2)}`);
  return (
    <Modal title="统计 · 排行" onClose={onClose} wide className="stats-modal">
      <div className="modal-body">
        <div className="modal-note">排行按"每真实小时科技包每分钟产量的增量" (这一班班末近 10 分钟的红 + 绿 + 蓝, 减同一世界上一班的, 除以这一班的真实小时数); 新世界第一班从 0 起。花费是 Claude Code 按官方价估的 (订阅实际不按这个扣; 走 Codex 的角色不报花费, 真实数字看站里或 Console)。"查经验"只数主动查的, "带出经验"数做动作时回复里自动带出的教训。中断的班 (没写 summary.json) 不计。</div>
        <table className="stats-table">
          <thead><tr><th className="num">#</th><th>模型</th><th className="num">班</th><th className="num">小时</th><th className="num">增量/小时</th><th className="num">产量/分 (均)</th><th className="num">建造</th><th className="num">建造/小时</th><th className="num">请求</th><th className="num">查询占比</th><th className="num">失败</th><th className="num">空闲</th><th className="num" title="用了几次 ./calc">算配比</th><th className="num" title="用了几次 ./bp">蓝图库</th><th className="num" title="用了几次 ./plan">规划</th><th className="num" title="跑了几次 Python 脚本">Python</th><th className="num" title="主动查了几次我们的经验主题 (fh help pilot-* / 直接读 facts、patterns)">查经验</th><th className="num" title="做动作时回复里自动带出教训的次数 (不用它查)">带出经验</th><th className="num">花费</th><th className="num">花费/小时</th></tr></thead>
          <tbody>
            {models.map((m, i) => (
              <tr key={m.model}>
                <td className="num">{i + 1}</td><td title={m.model}>{m.vendor}<span className="stats-model-id"> · {m.model}</span></td><td className="num">{m.shifts}</td><td className="num">{fmtNum(m.realHours)}</td>
                <td className="num strong">{fmtSigned(m.gainPerHour)}</td><td className="num">{fmtNum(m.scienceAvg)}</td><td className="num">{m.builds}</td><td className="num">{fmtNum(m.buildsPerHour)}</td>
                <td className="num">{m.requests}</td><td className="num">{m.readShare === null ? "—" : fmtPct(m.readShare)}</td><td className="num">{m.fails}</td><td className="num">{m.idleShare === null ? "—" : fmtPct(m.idleShare)}</td>
                <td className="num">{m.calc}</td><td className="num">{m.bp}</td><td className="num">{m.plan ?? 0}</td><td className="num">{m.python ?? 0}</td><td className="num">{m.knowledge}</td><td className="num">{m.lessons ?? 0}</td>
                <td className="num">{money(m.costUsd)}</td><td className="num">{money(m.costPerHour)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="panel-section-title stats-sub">每班每角色 ({shifts.length} 行)</div>
        <table className="stats-table">
          <thead><tr><th>班</th><th>世界</th><th>角色</th><th>模型</th><th className="num">轮次</th><th className="num">请求</th><th className="num">查询</th><th className="num">建造</th><th className="num">失败</th><th className="num">产量/分</th><th className="num">增量</th><th className="num">真实分钟</th><th className="num">游戏分钟</th><th className="num">空闲</th><th className="num">算配比</th><th className="num">蓝图库</th><th className="num">规划</th><th className="num">Python</th><th className="num">查经验</th><th className="num">带出经验</th><th className="num">花费</th></tr></thead>
          <tbody>
            {[...shifts].reverse().map((s) => (
              <tr key={`${s.run}-${s.agent}`}>
                <td>{runLabel(s.run).replace(" 开班", "")}</td><td title={s.world}>{s.worldName}</td><td>{s.agent.toUpperCase()}</td><td>{s.vendor}</td>
                <td className="num">{s.turns}</td><td className="num">{s.requests}</td><td className="num">{s.reads}</td><td className="num">{s.builds}</td><td className="num">{s.fails}</td>
                <td className="num">{fmtNum(s.science)}</td><td className="num strong">{fmtSigned(s.scienceGain)}</td><td className="num">{fmtNum(s.realMinutes, 0)}</td><td className="num">{fmtNum(s.gameMinutes, 0)}</td>
                <td className="num">{s.idleShare === null ? "—" : fmtPct(s.idleShare)}</td><td className="num">{s.calc}</td><td className="num">{s.bp}</td><td className="num">{s.plan ?? 0}</td><td className="num">{s.python ?? 0}</td><td className="num">{s.knowledge}</td><td className="num">{s.lessons ?? 0}</td><td className="num">{money(s.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="modal-buttons"><button className="primary" onClick={onClose}>好</button></div>
    </Modal>
  );
}

function UsageBars({ a, now }: { a: Account; now: number }) {
  return <>{a.usage.map((w) => {
    const left = remainPct(w);
    return (
      <div className="account-usage" key={w.label}>
        <div className="quota-row"><span className="quota-name">{w.label}</span><span className="quota-pct">剩 {left}%</span></div>
        <div className="quota-bar"><div className={left <= 15 ? "high" : left <= 40 ? "mid" : ""} style={{ width: `${left}%` }} /></div>
        {w.resetsAt ? <div className="quota-text">{resetIn(w.resetsAt, now)}</div> : null}
      </div>
    );
  })}</>;
}

/** 填密钥的一家 (DeepSeek / GLM / 中转站): 没填给输入框和去哪拿; 填了显示末 4 位、余额或额度, 可以换、删。
 *  中转站 (relay) 多一格站点地址; 填好后列出这个令牌能用的模型 (选模型在"下一班阵容"), 还可以选填站里的系统访问令牌 + 用户 ID 读账户余额
 *  */
function KeyRow({ a, now, onSave, onVerify, verifyStatus, onDone }: { a: Account; now: number; onSave: SaveKey; onVerify?: () => Promise<void>; verifyStatus?: () => Promise<VerifyStatus>; onDone?: () => void }) {
  const relay = a.id === "relay";
  const [editing, setEditing] = useState(false);
  // 核实进度: 开了一轮就每 3 秒问一次, 跑完重读账号 (下拉按核实结果分组)
  const [vs, setVs] = useState<VerifyStatus | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  useEffect(() => {
    if (!relay || !verifyStatus) return;
    let stop = false;
    const tick = async () => { try { const s = await verifyStatus(); if (!stop) { setVs(s); if (!s.running && vs?.running) onDone?.(); } } catch { /* 控制接口没起 */ } };
    tick();
    const t = setInterval(() => { if (vs?.running) tick(); }, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [relay, verifyStatus, vs?.running, onDone]);
  const startVerify = async () => { setVerifyError(null); try { await onVerify?.(); const s = await verifyStatus?.(); if (s) setVs(s); } catch (e) { setVerifyError((e as Error).message); } };
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(a.url ?? "");
  const [access, setAccess] = useState("");
  const [user, setUser] = useState(a.accessUser ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = (k: string) => run(async () => { await onSave(a.id, k, relay ? { url } : undefined); setEditing(false); setKey(""); });
  // 系统访问令牌填了以后只显示末 4 位 + "不读了": 加个"换"把输入框再打开
  const [editAccess, setEditAccess] = useState(false);
  const saveAccess = (t: string) => run(async () => { await onSave(a.id, undefined, { access: t, user: t ? user : "" }); setAccess(""); setEditAccess(false); });
  const form = !a.keyTail || editing;
  const canSave = !!key.trim() && (!relay || !!url.trim());
  const { native, responses, chat, unusable, ok, failed, unverified, verifiedAny } = relayModelGroups(a.models, a.verified);
  const names = (list: { id: string }[], n = 6) => list.slice(0, n).map((m) => m.id).join(", ") + (list.length > n ? ` … 共 ${list.length} 个` : "");
  return (
    <div className="account-card" data-provider={a.id}>
      <div className="account-top">
        <Avatar vendor={vendorOf(a.id)} text={a.short.charAt(0)} size="small" />
        <span className="name">{a.label}</span>
        <span className={`account-status${a.keyTail && a.signedIn ? "" : " off"}`}>{accountStatus(a)}</span>
      </div>
      {a.balance ? (
        <div className="account-usage">
          <div className="quota-row"><span className="quota-name">余额</span><span className="quota-pct">{fmtBalance(a.balance)}</span></div>
          <div className="quota-text">{a.balance.note ?? `赠送 ${a.balance.granted} + 充值 ${a.balance.toppedUp} (按量付费)`}{a.balance.enough === false ? " · 余额不够调用了" : ""}</div>
        </div>
      ) : null}
      <UsageBars a={a} now={now} />
      {a.keyTail && a.usageWhy ? <div className={`account-note${a.signedIn === false ? " bad" : ""}`}>{a.usageWhy}</div> : null}
      {form ? (
        <div className="account-install">
          {relay ? (
            <div className="key-form">
              <input type="url" autoComplete="off" spellCheck={false} placeholder="中转站地址, 例 https://ai.example.com (不用带 /v1)" value={url}
                onChange={(e) => { setUrl(e.target.value); setError(null); }} />
            </div>
          ) : null}
          <div className="key-form">
            <input type="password" autoComplete="off" spellCheck={false} placeholder={relay ? "粘贴站里建的令牌 (sk-…)" : `粘贴 ${a.short} 的 API 密钥`} value={key}
              onChange={(e) => { setKey(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === "Enter" && canSave) save(key); }} />
            <button className="small-primary" disabled={busy || !canSave} onClick={() => save(key)}>{busy ? "正在查…" : "保存"}</button>
            {editing ? <button className="link-button" disabled={busy} onClick={() => { setEditing(false); setKey(""); setUrl(a.url ?? ""); setError(null); }}>取消</button> : null}
          </div>
          {a.keyUrl ? <div className="account-note">在这里拿{relay ? "令牌" : "密钥"}: <code className="selectable">{a.keyUrl}</code></div>
            : relay ? <div className="account-note">令牌在站的 控制台 → 令牌 里建; 保存后读它能用的模型</div> : null}
        </div>
      ) : (
        <div className="account-actions">
          {relay && a.url ? <span className="account-note">站点 <code className="selectable">{a.url}</code></span> : null}
          <span className="account-note">密钥末 4 位 <code>{a.keyTail}</code></span>
          <button className="link-button" disabled={busy} onClick={() => setEditing(true)}>换{relay ? "站点 / 令牌" : "密钥"}</button>
          <button className="link-button danger-link" disabled={busy} onClick={() => save("")}>{busy ? "正在删…" : "删除"}</button>
        </div>
      )}
      {relay ? <div className="account-note">请求经本机小代理转发 (自动起), 去掉 GPT 渠道不收的 metadata 字段</div> : null}
      {relay && a.keyTail && a.signedIn ? (
        <>
          {verifiedAny ? <>
            <div className="account-note">核实能用 {ok.length} 个: {names(ok)}</div>
            {failed.length ? <div className="account-note bad">没通 {failed.length} 个: {failed.slice(0, 4).map((m) => `${m.id} (${m.why.slice(0, 50)})`).join("; ")}{failed.length > 4 ? ` … 共 ${failed.length} 个` : ""}</div> : null}
            {unverified.length ? <div className="account-note">没核实 {unverified.length} 个: {names(unverified, 4)}</div> : null}
          </> : <>
            {native.length ? <div className="account-note">Claude 格式 {native.length} 个 (Claude Code 直接用): {names(native)}</div> : null}
            {responses.length ? <div className="account-note">Responses 协议 {responses.length} 个 (开班走 Codex 指向站): {names(responses, 4)}</div> : null}
            {chat.length ? <div className="account-note">只有 Chat 协议 {chat.length} 个 (Claude Code 由站转格式): {names(chat, 4)}</div> : null}
            {unusable.length ? <div className="account-note">不是对话模型 {unusable.length} 个 (图片 / 视频, 用不了): {names(unusable, 3)}</div> : null}
          </>}
          {onVerify ? <div className="account-actions" data-relay-verify>
            <button className="link-button" disabled={!!vs?.running || busy} onClick={startVerify}>{vs?.running ? "正在核实…" : verifiedAny ? "重新核实全部模型" : "核实全部模型"}</button>
            <span className="account-note">{vs ? verifyLine(vs) : ""}{vs?.running ? "" : " 每个模型只发 1 条按它协议写的最小请求 (花站里一点余额); 通的进下拉的\"核实能用\"组"}</span>
            {verifyError ? <span className="account-note bad">{verifyError}</span> : null}
          </div> : null}
          {a.accessTail && !editAccess ? (
            <div className="account-actions">
              <span className="account-note">账户余额用系统访问令牌读 (末 4 位 <code>{a.accessTail}</code>, 用户 ID {a.accessUser ?? "?"})</span>
              <button className="link-button" disabled={busy} onClick={() => setEditAccess(true)}>换</button>
              <button className="link-button danger-link" disabled={busy} onClick={() => saveAccess("")}>不读了</button>
            </div>
          ) : (
            <div className="account-install">
              <div className="key-form">
                <input type="password" autoComplete="off" spellCheck={false} placeholder="系统访问令牌 (可选, 读账户余额)" value={access} onChange={(e) => { setAccess(e.target.value); setError(null); }} />
                <input type="text" autoComplete="off" spellCheck={false} placeholder="用户 ID" value={user} style={{ flex: "0 0 80px" }} onChange={(e) => { setUser(e.target.value); setError(null); }} />
                <button className="small-primary" disabled={busy || !access.trim() || !user.trim()} onClick={() => saveAccess(access)}>{busy ? "正在查…" : "保存"}</button>
                {editAccess ? <button className="link-button" disabled={busy} onClick={() => { setEditAccess(false); setAccess(""); setUser(a.accessUser ?? ""); }}>取消</button> : null}
              </div>
              <div className="account-note">站里 个人设置 → 系统访问令牌, 加页面上的用户 ID, 填了显示账户余额 (可选)</div>
            </div>
          )}
        </>
      ) : null}
      {error ? <div className="account-note bad">{error}</div> : null}
    </div>
  );
}

function AccountRow({ a, now, watching, onLogin }: { a: Account; now: number; watching: boolean; onLogin: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const login = async () => {
    setBusy(true); setError(null);
    try { await onLogin(a.id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(a.install); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setError("复制不了, 手动选中上面的命令复制"); }
  };
  return (
    <div className="account-card" data-provider={a.id}>
      <div className="account-top">
        <Avatar vendor={vendorOf(a.id)} text={a.short.charAt(0)} size="small" />
        <span className="name">{a.label}</span>
        <span className={`account-status${a.installed && a.signedIn ? "" : " off"}`}>{accountStatus(a)}{a.version ? ` · ${a.version}` : ""}</span>
      </div>
      <UsageBars a={a} now={now} />
      {a.installed && a.signedIn !== false && a.usageWhy ? <div className="account-note">{a.usage.length ? a.usageWhy : `额度没读到: ${a.usageWhy}`}</div> : null}
      {!a.installed ? (
        <div className="account-install">
          <div className="account-note">在 PowerShell 里运行下面这条装上, 装好后点"刷新":</div>
          <div className="install-line"><code>{a.install}</code><button className="link-button" onClick={copy}>{copied ? "已复制" : "复制"}</button></div>
        </div>
      ) : (
        <div className="account-actions">
          {watching ? <span className="account-note">已开登录窗口 (<code>{a.login}</code>): 在浏览器里登完, 这里会自己更新</span> : null}
          <button className={a.signedIn ? "link-button" : "small-primary"} onClick={login} disabled={busy}>{busy ? "正在开…" : a.signedIn ? "重新登录" : "登录"}</button>
        </div>
      )}
      {error ? <div className="account-note bad">{error}</div> : null}
    </div>
  );
}
