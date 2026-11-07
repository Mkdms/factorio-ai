// 三栏: 左 全队 + 角色, 中 对话流 + 输入框, 右 游戏读数。每 5 秒读一次控制接口 (/api/state 和每个角色的 /api/brain)。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, BASE } from "./api.ts";
import {
  SCIENCE, TEAM, teamPresence, accountSeatFirst, agentLabel, agentTitle, alertKey, mentionTargets, runLabel, composerBlock, downBanner, landingBanner, newAlerts, nextViewRun, parseSeatValue, rosterDiff, seatValue, vendorOf, type WorldInfo, foldLines, localItems, loginDone, mergeThread, pendingAsks, presence, preview, runBanner, trimLocals,
  type Account, type BackendPref, type ControlProc, type Group, type Item, type KeyPatch, type Line, type Local, type MkState, type ModelStat, type NewGroupInput, type Presence, type Review, type RosterSeat, type Scan, type ShiftAgentStat, type ShiftBlueprint, type State,
} from "./logic.ts";
import { desktop } from "./desktop.ts";
import { Sidebar, type Row } from "./components/Sidebar.tsx";
import { Thread } from "./components/Thread.tsx";
import { Panel } from "./components/Panel.tsx";
import { AccountsModal, AlertModal, NewGroupModal, SourcesModal, StatsModal, StopModal } from "./components/Modals.tsx";
import { useTheme } from "./useTheme.ts";
import { WorldPicker } from "./components/WorldPicker.tsx";

const POLL_MS = 5000;
const localsKey = (run: string) => `fp-gui:locals:${run}`;

/** 读本班存下的本地记录; 界面关掉前没等到结果的, 标成没等到 */
function loadLocals(run: string): Local[] {
  try {
    const raw = JSON.parse(localStorage.getItem(localsKey(run)) ?? "[]") as Local[];
    return raw.map((l): Local => l.type === "cmd" && l.pending ? { ...l, pending: false, out: "(界面重开前没等到结果)", code: 1 }
      : l.type === "tell" && l.status === "发送中" ? { ...l, status: "没送到", error: "界面重开前没等到回音" } : l);
  } catch { return []; }
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const [brains, setBrains] = useState<Record<string, Line[]>>({});
  const [review, setReview] = useState<Review>(null);
  const [scan, setScan] = useState<Scan>(null); // 开班扫描
  // 大脑接口警报: 看过的记在本机, 没看过的弹
  const [alertSeen, setAlertSeen] = useState<string[]>(() => { try { const v = JSON.parse(localStorage.getItem("fp-gui:alerts-seen") ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } });
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string>(() => localStorage.getItem("fp-gui:selected") ?? "a");
  /** 左栏 "/ 命令" 面板点的一条 → 填进输入框 */
  const [seed, setSeed] = useState<{ text: string; n: number } | null>(null);
  const [locals, setLocals] = useState<Local[]>([]);
  const [localsRun, setLocalsRun] = useState<string | null>(null);
  const [modal, setModal] = useState<null | "stop" | "accounts" | "sources" | "stats" | "newGroup">(null);
  /** 每个模型的统计和排行 (GET /api/stats, 和世界列表一起每分钟重读) */
  const [stats, setStats] = useState<{ models: ModelStat[]; shifts: ShiftAgentStat[] } | null>(null);
  /** 这一班看过 / 用过的蓝图 (GET /api/blueprints), 和统计一起每分钟重读 */
  const [blueprints, setBlueprints] = useState<ShiftBlueprint[] | null>(null);
  const openBlueprint = async (url?: string) => {
    try { const r = await api.openEditor(); await api.openUrl(url ?? r.url); } catch (e) { console.error("打开蓝图编辑器失败", e); }
  };
  const [now, setNow] = useState(() => Date.now());
  const [proc, setProc] = useState<ControlProc | null>(null); // 界面自己起的控制接口 (桌面外壳; 浏览器里是 null)
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [watching, setWatching] = useState<{ id: string; until: number } | null>(null); // 点了登录, 等它登好
  // 看哪一班: undefined = 还没定, null = 空对话 (没在跑时打开; 不看旧记录), 字符串 = 那一班 (nextViewRun)
  const [viewRun, setViewRun] = useState<string | null | undefined>(undefined);
  const [worlds, setWorlds] = useState<WorldInfo[] | null>(null);
  const theme = useTheme();
  const viewRunRef = useRef(viewRun);
  viewRunRef.current = viewRun;
  const prevLatest = useRef<string | null>(null);
  useEffect(() => { desktop.showWindow().catch(() => {}); }, []);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const inflight = useRef(false);
  const ticks = useRef(0);

  const loadAccounts = useCallback(async (fresh: boolean) => {
    setAccountsLoading(true);
    try { const r = await api.accounts(fresh); setAccounts(r.accounts); setAccountsError(null); return r.accounts; }
    catch (e) { setAccountsError((e as Error).message); return null; }
    finally { setAccountsLoading(false); }
  }, []);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const want = viewRunRef.current;
      let s = await api.state(typeof want === "string" ? want : undefined);
      const v = nextViewRun(want, s.latest, prevLatest.current);
      prevLatest.current = s.latest?.id ?? null;
      if (v !== want) { viewRunRef.current = v; setViewRun(v); if (typeof v === "string" && v !== s.run?.id) s = await api.state(v); }
      setState(s); setDown(null); setNow(Date.now());
      if (ticks.current % 6 === 0) { api.worlds().then((r) => setWorlds(r.worlds), () => {}); api.groups().then((r) => setGroups(r.groups), () => {}); api.stats().then((r) => setStats(r), () => {}); api.blueprints(typeof v === "string" ? v : undefined).then((r) => setBlueprints(r.blueprints), () => {}); }
      // 每 5 分钟 (打开账号页时立刻读)
      if (ticks.current % 60 === 0) loadAccounts(false);
      const sel = selectedRef.current;
      // 空对话不读大脑的记录
      const ids = v === null ? [] : s.agents?.map((a) => a.id) ?? [];
      const run = s.run?.id;
      const got = await Promise.all(ids.map((id) => api.brain(id, sel === id ? 150 : sel === TEAM ? 80 : 40, run).then((r) => [id, r.lines] as const, () => [id, null] as const)));
      setBrains((prev) => Object.fromEntries(got.map(([id, lines]) => [id, lines ?? prev[id] ?? []])));
      if (ticks.current++ % 6 === 0) { api.review(run).then(setReview, () => {}); api.scan(run).then(setScan, () => {}); }
    } catch (e) {
      setDown((e as Error).message); setNow(Date.now());
      desktop.controlStatus().then(setProc, () => {});
    } finally { inflight.current = false; }
  }, [loadAccounts]);

  // 点了登录: 每 5 秒重读这一家 (不用缓存), 登好了或者 3 分钟到了就停
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(async () => {
      const list = await loadAccounts(true);
      if (loginDone(list, watching.id) || Date.now() > watching.until) setWatching(null);
    }, 5000);
    return () => clearInterval(t);
  }, [watching, loadAccounts]);
  const login = async (id: string) => { await api.login(id); setWatching({ id, until: Date.now() + 180_000 }); };
  /** 存 / 删密钥 (中转站还有站点、系统访问令牌): 控制接口回这一家查过的新状态, 换进列表 */
  const saveKey = async (id: string, key?: string, extra?: KeyPatch) => {
    const r = await api.setKey(id, key, extra);
    setAccounts((list) => list?.map((x) => (x.id === id ? r.account : x)) ?? list);
  };
  // 下一班阵容: 打开账号页时读, 改一行就存
  const [seats, setSeats] = useState<RosterSeat[] | null>(null);
  // 群 = 对话 = 世界: 群列表、正在看的群 (还没开过班的群 = 空对话 + 群卡); 名单按群存
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupView, setGroupView] = useState<string | null>(null);
  const loadGroups = useCallback(async () => { try { setGroups((await api.groups()).groups); } catch { /* 控制接口没起 */ } }, []);
  const groupFor = groupView ?? (state?.world?.id && groups.some((g) => g.id === state.world!.id) ? state.world!.id : null);
  const group = groupFor ? groups.find((g) => g.id === groupFor) ?? null : null;
  const loadLineup = useCallback(async (g: string | null) => { try { setSeats((await api.lineup(g ?? undefined)).seats); } catch { setSeats([]); } }, []);
  const saveLineup = async (s: RosterSeat[]) => { const r = await api.saveLineup(s, groupFor ?? undefined); setSeats(r.seats); if (groupFor) loadGroups(); };
  // 群里移出一个 (名单用右栏"编辑名单"的多选框整份存)
  const removeSeat = async (i: number) => saveLineup((seats ?? []).filter((_, k) => k !== i));
  // 名单只有一份: 在跑时保存 = 比一下差异, 新勾的进来干活、去掉的移出 (run.ts 30 秒内照做); 没在跑就只是存着, 开班按它
  const saveAndApply = async (s: RosterSeat[]) => {
    await saveLineup(s);
    if (!state?.run?.running || !state.run.rosterLive) return;
    const d = rosterDiff(s, state.agents ?? []);
    for (const seat of d.join) await api.rosterJoin(seat);
    for (const id of d.leave) await api.rosterLeave(id);
    await refresh();
  };
  /** 在线成员那行的"移出": 现在就移出, 名单里也去掉一席 */
  const leaveAgent = async (id: string) => {
    const a = state?.agents?.find((x) => x.id === id);
    const all = seats ?? [];
    const account = group?.kind === "server"; // 第 1 席控制用户账号 (只有联机服务器的群) 时名单里的它不动
    const i = a?.seat ? all.findIndex((x, k) => (!account || k > 0) && seatValue(x) === seatValue(a.seat!)) : -1;
    if (i >= 0) await saveLineup(all.filter((_, k) => k !== i));
    await api.rosterLeave(id);
    await refresh();
  };
  /** 换第 i 个角色的模型 (管理员那行的下拉; 没存过时第 1 个就是它) */
  const setSeat = async (i: number, value: string) => { const base = seats?.length ? seats : [{ brain: "claude", model: "opus" }]; await saveLineup(base.map((s, k) => (k === i ? { ...parseSeatValue(value), ...(s.effort ? { effort: s.effort } : {}) } : s))); };
  /** 换第 i 个角色的思考强度 (空 = 默认) */
  const setSeatEffort = async (i: number, effort: string) => { const base = seats?.length ? seats : [{ brain: "claude", model: "opus" }]; await saveLineup(base.map((s, k) => (k === i ? { brain: s.brain, model: s.model, ...(effort ? { effort } : {}) } : s))); };
  useEffect(() => { loadLineup(groupFor); }, [loadLineup, groupFor]);
  useEffect(() => { loadGroups(); }, [loadGroups]);
  /** 进一个还没开过班的群: 空对话 + 右栏群卡 (开班在那里) */
  const pickGroup = (id: string) => { setGroupView(id); viewRunRef.current = null; setViewRun(null); setBrains({}); ticks.current = 0; refresh(); };
  const setGroupReveal = async (on: boolean) => { if (!group) return; await api.setGroupReveal(group.id, on); await loadGroups(); };
  const setGroupBackend = async (backend: BackendPref) => { if (!group) return; await api.setGroupBackend(group.id, backend); await loadGroups(); };
  const setGroupRcon = async (address: string, password: string) => { if (!group) return; await api.setGroupRcon(group.id, address, password); await loadGroups(); };
  const connectGroup = async () => { if (!group) throw new Error("没选群"); return (await api.connectGroup(group.id)).log; };
  const createGroup = async (input: NewGroupInput) => { const r = await api.createGroup(input); await loadGroups(); api.worlds().then((w) => setWorlds(w.worlds), () => {}); pickGroup(r.group.id); };
  const [startError, setStartError] = useState<string | null>(null);
  // 我的账号的群: 这一局的状态; 只在看着这种群时才问 (别的时候不多打接口)
  const [mk, setMk] = useState<MkState | null>(null);
  const watchMk = group?.kind === "mine";
  useEffect(() => {
    if (!watchMk) return;
    let live = true;
    const load = () => { api.mk().then((m) => { if (live) setMk(m); }, () => undefined); };
    load();
    const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
  }, [watchMk]);
  const setGroupGoal = async (goal: string) => { if (!group) return; await api.setGroupGoal(group.id, goal); await loadGroups(); };
  const stopMk = async () => { await api.stopMk(); setMk(await api.mk()); };
  const startGroup = async () => {
    if (!group) return;
    setStartError(null);
    if (group.kind === "mine") {
      try { await api.startGroup(group.id); setTimeout(() => { api.mk().then(setMk, () => undefined); }, 1500); } catch (e) { setStartError((e as Error).message); throw e; }
      return;
    }
    try { await api.startGroup(group.id); setGroupView(null); setTimeout(() => { ticks.current = 0; refresh(); }, 3000); } catch (e) { setStartError((e as Error).message); throw e; }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => { localStorage.setItem("fp-gui:selected", selected); refresh(); }, [selected, refresh]);

  // 本地记录 (你说的话、你执行的命令) 按班存
  const runId = state?.run?.id ?? null;
  useEffect(() => { if (runId) { setLocals(loadLocals(runId)); setLocalsRun(runId); } }, [runId]);
  useEffect(() => { if (localsRun) localStorage.setItem(localsKey(localsRun), JSON.stringify(trimLocals(locals))); }, [locals, localsRun]);

  // 研究名、科技包名换成官方中文名
  const research = state?.game?.research;
  useEffect(() => {
    const need = [research, ...SCIENCE.map((s) => s.item)].filter((n): n is string => !!n && !(n in names));
    if (need.length) api.names(need).then((r) => setNames((p) => ({ ...p, ...r.names })), () => {});
  }, [research, names]);
  const zh = useCallback((n: string) => names[n] ?? n, [names]);

  const landing = viewRun === null;
  const agents = state?.agents ?? [];
  const running = !!state?.run?.running;
  // 切世界 / 班次: 换班次就重读 (对话、复盘)
  const pick = (run: string | null) => { setGroupView(null); viewRunRef.current = run; setViewRun(run); setBrains({}); ticks.current = 0; refresh(); };
  const [worldsError, setWorldsError] = useState<string | null>(null);
  /** 移出 / 放回: 先在界面上改 (即时消失), 再调接口; 失败就把原因显示在菜单底部并重读 */
  const hideRuns = (runs: string[], hidden: boolean) => {
    setWorlds((ws) => ws?.map((w) => ({ ...w, runs: w.runs.map((r) => (runs.includes(r.id) ? { ...r, hidden } : r)) })) ?? ws);
    setWorldsError(null);
    Promise.all(runs.map((run) => api.hide(run, hidden)))
      .then(() => api.worlds()).then((r) => setWorlds(r.worlds))
      .catch((e) => { setWorldsError(`${hidden ? "收起" : "放回"}失败: ${(e as Error).message}`); api.worlds().then((r) => setWorlds(r.worlds), () => {}); });
  };
  const hideRun = (run: string, hidden: boolean) => hideRuns([run], hidden);
  /** 改世界标题: 存到控制接口, 然后重读世界列表和状态 (左上角的名字也跟着变) */
  const renameWorld = (world: string, name: string) => {
    setWorldsError(null);
    api.worldName(world, name).then(() => api.worlds()).then((r) => { setWorlds(r.worlds); refresh(); })
      .catch((e) => setWorldsError(`改名失败: ${(e as Error).message}`));
  };
  const clearMine = (run: string) => { localStorage.removeItem(localsKey(run)); if (run === localsRun) setLocals([]); };
  /** 彻底删几班的对话记录: 控制接口删文件并标记收起; 顺便清掉你在那几班发的话; 失败原因显示在菜单底部 */
  const purgeRuns = (runs: string[]) => {
    setWorldsError(null);
    api.purge(runs).then((r) => {
      for (const run of runs) clearMine(run);
      if (r.skipped.length) setWorldsError(`有 ${r.skipped.length} 班没删: ${r.skipped.map((s) => `${runLabel(s.run)} (${s.why})`).join("; ")}`);
      return api.worlds();
    }).then((r) => { setWorlds(r.worlds); if (runs.includes(viewRunRef.current ?? "")) pick(null); })
      .catch((e) => { setWorldsError(`删对话记录失败: ${(e as Error).message}`); api.worlds().then((r) => setWorlds(r.worlds), () => {}); });
  };
  const { perAgent, team } = useMemo(() => {
    // 空对话: 左栏的最后一句、对话流都不带旧记录 (你在上一班发的话也不带)
    const mine = landing ? [] : locals;
    const folded = Object.fromEntries(agents.map((a) => [a.id, landing ? [] : foldLines(brains[a.id] ?? [], a.id)]));
    const perAgent: Record<string, Item[]> = Object.fromEntries(agents.map((a) => [a.id, mergeThread([folded[a.id], localItems(mine, a.id)])]));
    const team = mergeThread([...agents.map((a) => folded[a.id]), localItems(mine, TEAM)]);
    return { perAgent, team };
  }, [agents, brains, locals, landing]);

  const rows: Row[] = useMemo(() => {
    const ag = agents.map((a): Row => {
      // 这一班没在跑了就没法回它, 不挂角标 (对话流里的等你卡片还在)
      const pending = running ? pendingAsks(perAgent[a.id] ?? []) : 0;
      return { id: a.id, title: agentTitle(a.id, agents), agent: a, presence: presence(a, pending, running), preview: preview(perAgent[a.id] ?? []), pending };
    });
    const allPresence: Presence | null = !state?.run ? null : !running ? "没在跑" : teamPresence(ag.map((r) => r.presence as Presence));
    return [{ id: TEAM, title: TEAM, agent: null, presence: allPresence, preview: preview(team), pending: ag.reduce((n, r) => n + r.pending, 0) }, ...ag];
  }, [agents, perAgent, team, running, state?.run]);

  const pendingAlerts = useMemo(() => newAlerts(state?.alerts, alertSeen), [state?.alerts, alertSeen]);
  // 选中的角色这一班没有 (换班了、还没读到) 就看全队
  const view = selected !== TEAM && agents.some((a) => a.id === selected) ? selected : TEAM;
  const row = rows.find((r) => r.id === view) ?? rows[0];
  const isTeam = view === TEAM;
  const items = landing ? [] : isTeam ? team : perAgent[view] ?? [];
  const land = landing ? landingBanner(state) : null;
  const downInfo = down ? downBanner(down, proc, BASE.replace("http://", "")) : null;
  const banner = downInfo
    ? { tone: "down" as const, text: downInfo.text, action: downInfo.retry ? { label: "起控制接口", run: () => { desktop.controlStart().then((p) => { setProc(p); refresh(); }, () => {}); } } : undefined }
    : land ? { tone: land.tone, text: land.text, action: { label: "查看", run: () => pick(land.runId) } } : runBanner(state, now);
  const role = isTeam
    ? (agents.length ? agents.map((a) => `${agentTitle(a.id, agents)} (游戏里: ${a.name})`).join("、") : "这一班没有角色")
    : `游戏里叫 ${row.agent?.name ?? "?"}${row.presence ? ` · ${row.presence}` : ""}`;

  const who = useCallback((id: string) => {
    const a = agents.find((x) => x.id === id);
    return { title: agentTitle(id, agents), vendor: vendorOf(a?.model), game: a?.name ?? null, letter: agentLabel(id) };
  }, [agents]);

  const update = (at: string, f: (l: Local) => Local) => setLocals((ls) => ls.map((l) => (l.at === at ? f(l) : l)));
  /** 发话 / 执行命令; 返回送没送到 (等你卡片的按钮用: 没送到可以再点) */
  const send = async (agent: string, m: { type: "tell"; text: string } | { type: "fh"; args: string }): Promise<boolean> => {
    const at = new Date().toISOString();
    let ok = true;
    if (m.type === "tell") {
      setLocals((ls) => [...ls, { type: "tell", agent, text: m.text, at, status: "发送中" }]);
      const errors: string[] = [];
      // 群里 @ 某个成员只发给他; 没有 @ 或 @全队 = 每个角色各收一遍
      const liveAgents = agents.filter((a) => !a.left); // 移出的角色没有身体了, 发不到
      const mention = agent === TEAM ? mentionTargets(m.text, liveAgents) : null;
      const targets = agent === TEAM ? (mention!.ids.length ? mention!.ids : liveAgents.map((a) => a.id)) : [agent];
      if (mention && mention.unknown.length && !mention.ids.length) {
        update(at, (l) => ({ ...l, status: "没送到", error: `群里没有叫 ${mention.unknown.map((u) => `@${u}`).join(" / ")} 的成员 (打 @ 从列表里选)` }) as Local);
        return false;
      }
      const scope = agent === TEAM && targets.length === liveAgents.length ? "team" : "direct";
      for (const id of targets) {
        try { await api.tell(id, m.text, scope); } catch (e) { errors.push(`${agentTitle(id, agents)}: ${(e as Error).message}`); }
      }
      update(at, (l) => ({ ...l, status: errors.length ? "没送到" : "已送到", error: errors.join("; ") || undefined }) as Local);
      ok = !errors.length;
    } else {
      setLocals((ls) => [...ls, { type: "cmd", agent, args: m.args, at, pending: true }]);
      try { const r = await api.fh(agent, m.args); update(at, (l) => ({ ...l, pending: false, out: r.out, code: r.code }) as Local); }
      catch (e) { update(at, (l) => ({ ...l, pending: false, out: (e as Error).message, code: 1 }) as Local); ok = false; }
    }
    refresh();
    return ok;
  };

  return (
    <div className="app">
      <Sidebar rows={landing ? rows.slice(0, 1) : rows} selected={view} onSelect={setSelected} onAccounts={() => { setModal("accounts"); loadAccounts(false); loadLineup(groupFor); }}
        onSources={() => setModal("sources")}
        onPick={(cmd) => setSeed({ text: `/${cmd} `, n: Date.now() })}
        top={<WorldPicker worlds={worlds} worldName={group && groupView ? group.name : landing ? null : state?.world?.name ?? null} viewRun={viewRun} onPick={pick} onHide={hideRun} onHideMany={(runs) => hideRuns(runs, true)} onClearMine={clearMine} onPurge={purgeRuns} onRename={renameWorld} error={worldsError}
          onNewGroup={() => setModal("newGroup")} onPickGroup={pickGroup} />} />
      <Thread
        title={landing ? "空对话" : agentTitle(view, agents)} who={who} role={landing ? "没在看任何一班; 上一班的记录在左上角" : role} avatar={isTeam || landing ? "队" : agentLabel(view)} vendor={isTeam || landing ? null : vendorOf(row?.agent?.model)} presence={landing ? null : row?.presence ?? null}
        banner={banner} items={items} isTeam={isTeam} down={!!down} emptyText={landing ? "空对话: 没有在跑的班, 旧记录收在左上角 · 开了新的一班会自己跳过去" : undefined}
        block={down ? "连不上控制接口, 不能发话" : composerBlock(state, view)}
        members={agents.filter((a) => !a.left).map((a) => ({ id: a.id, label: a.name || agentLabel(a.id), detail: agentTitle(a.id, agents) }))}
        onSend={(m) => send(view, m)}
        onReply={(agent, text) => send(agent, { type: "tell", text })} canReply={running && !down} replies={state?.replies}
        seed={seed}
      />
      <Panel state={state} review={review} scan={scan} zh={zh} onStop={() => setModal("stop")} members={landing ? [] : rows.slice(1)} selected={view} onSelect={setSelected} connected={!down} accounts={accounts} now={now} stats={stats?.models ?? null} onStats={() => setModal("stats")} blueprints={blueprints} onOpenBlueprint={openBlueprint}
        seats={seats} onRemoveSeat={removeSeat} onSetSeat={setSeat} onSetSeatEffort={setSeatEffort} onSaveSeats={saveAndApply} onLeaveAgent={leaveAgent} onMakeAccount={(seat) => saveLineup(accountSeatFirst(seats ?? [], seat))} landing={landing}
        group={group} groupRunning={!!state?.latest?.running} onStartGroup={startGroup} startError={startError} onSetReveal={setGroupReveal} onSetBackend={setGroupBackend} onSetRcon={setGroupRcon} onConnect={connectGroup} mk={mk} onStopMk={stopMk} onSetGoal={setGroupGoal} />
      {modal === "stats" && stats ? <StatsModal models={stats.models} shifts={stats.shifts} onClose={() => setModal(null)} /> : null}
      {modal === "stop" && (state?.run || down) ? <StopModal runId={state?.run?.id ?? ""} down={!!down} onClose={() => setModal(null)} onConfirm={async () => {
        // 控制接口发不到 (没在跑 / 退出了) 就让桌面外壳直接写停班标记; 浏览器里没有外壳, 照旧报错
        try { await api.stop(); } catch (e) {
          const r = await desktop.stopRun();
          if (!r) throw e;
          if (!r.ok) throw new Error(`控制接口连不上 (${(e as Error).message}); 界面直接写也没成: ${r.error ?? "?"}`);
        }
        await refresh();
      }} /> : null}
      {pendingAlerts.length ? <AlertModal alerts={pendingAlerts} onClose={() => { const next = [...alertSeen, ...pendingAlerts.map(alertKey)].slice(-200); setAlertSeen(next); localStorage.setItem("fp-gui:alerts-seen", JSON.stringify(next)); }} /> : null}
      {modal === "sources" ? <SourcesModal onClose={() => setModal(null)} /> : null}
      {modal === "newGroup" ? <NewGroupModal worlds={worlds} onCreate={createGroup} onClose={() => setModal(null)} /> : null}
      {modal === "accounts" ? (
        <AccountsModal accounts={accounts} accountsError={accountsError} loading={accountsLoading} watching={watching?.id ?? null} now={now} down={!!down}
          onClose={() => setModal(null)} onRefresh={() => loadAccounts(true)} onLogin={login} onSaveKey={saveKey} seats={seats} onSaveLineup={saveLineup} onVerifyRelay={async () => { await api.relayVerify(); }} relayVerifyStatus={() => api.relayVerifyStatus()}
          theme={theme.choice} systemDark={theme.systemDark} onTheme={theme.setChoice} />
      ) : null}
    </div>
  );
}
