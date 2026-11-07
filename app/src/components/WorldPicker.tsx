// 左栏顶上: 切世界和班次。
// 一个世界 = 一个存档连续跑的几班, 或一个联机服务器 (以后各算一个); 世界下面列班次, 点一班看它的对话; "空对话" = 不看旧记录。
//  (旧记录二十多班逐行列着) → 每个世界一组可折叠 (旧记录默认折着), 每组只露最近 5 班 (再看 N 班), 组头能"全部移出列表";
// "移出列表" (原"收起") 只在那一班的目录放一个标记, 记录不删 (复盘和接着跑要用), 点了即时消失、失败显示原因; "清我的话"清掉你在那一班里发过的话和命令 (存在界面里的), 点完显示"已清"。
import { useEffect, useRef, useState } from "react";
import { runBriefStatus, runLabel, type WorldInfo } from "../logic.ts";

/** 每组默认露几班 */
export const RUNS_SHOWN = 5;

export function WorldPicker({ worlds, worldName, viewRun, onPick, onHide, onHideMany, onClearMine, onPurge, onRename, error, onNewGroup, onPickGroup }: {
  worlds: WorldInfo[] | null; worldName: string | null; viewRun: string | null | undefined;
  onPick: (run: string | null) => void; onHide: (run: string, hidden: boolean) => void; onHideMany?: (runs: string[]) => void; onClearMine: (run: string) => void;
  /** 彻底删这几班的对话记录: 删对话 / 命令 / 读数 / 截图, 留复盘 / 统计 / 存档链; 大脑笔记、知识库、规则不碰 */
  onPurge?: (runs: string[]) => void;
  /** 改一个世界的标题; 空名 = 恢复原名 */
  onRename?: (world: string, name: string) => void;
  /** 收起 / 放出 / 改名失败的原因 (App 里接口报的), 显示在菜单底部 */
  error?: string | null;
  /** 新建对话 (= 新建一个群 / 世界) 和进一个还没开过班的群 */
  onNewGroup?: () => void; onPickGroup?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  /** 正在改名的世界和输入框里的字 */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  /** 折叠状态按世界记 (没记过的: 旧记录折着, 其余展开); 展开全部班次也按世界记 */
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [cleared, setCleared] = useState<string | null>(null);
  /** 点了"删对话记录"等确认的那一班 / 那一组 (第二次点才真删) */
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close); window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  useEffect(() => { if (!cleared) return; const t = setTimeout(() => setCleared(null), 1500); return () => clearTimeout(t); }, [cleared]);
  const hiddenCount = (worlds ?? []).reduce((n, w) => n + w.runs.filter((r) => r.hidden).length, 0);
  const sub = viewRun === null ? "空对话 · 不看旧记录" : viewRun ? `${runLabel(viewRun)}` : "…";
  const isFolded = (w: WorldInfo) => folded[w.id] ?? (w.id === "legacy" && !w.runs.some((r) => r.id === viewRun));
  // : 字写直白 —— 一个世界 = 一条存档链 (同一个存档连着跑的几班) 或一个联机服务器; 旧记录 = 11-03 以前没记世界的班
  const kindLabel = (w: WorldInfo) => (w.id === "legacy" ? "11-03 以前的班, 没记属于哪个世界" : w.kind === "server" ? "联机服务器" : "一条存档链");

  return (
    <div className="world-picker" ref={box}>
      <button className="world-button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="world-text">
          <span className="world-name">{viewRun === null ? worldName ?? "空对话" : worldName ?? "还没有任何一班"}</span>
          <span className="world-sub">{viewRun === null ? (worldName ? "群 · 还没在看它的班; 操作在右栏" : "点这里看各个世界的记录") : sub}</span>
        </span>
        <span className="world-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open ? (
        <div className="world-menu" role="menu">
          {onNewGroup ? <button className="world-run world-new" data-new-group onClick={() => { onNewGroup(); setOpen(false); }}>
            <span className="world-run-label">+ 新建对话</span><span className="world-run-state">= 新建一个群 (世界): 新地图 / 接着存档 / 联机服务器, 拉模型进群, 群里点开班</span>
          </button> : null}
          <button className={`world-run${viewRun === null ? " on" : ""}`} data-run="" onClick={() => { onPick(null); setOpen(false); }}>
            <span className="world-run-label">空对话</span><span className="world-run-state">不看任何一班的记录; 开了新的一班会自动跳过去</span>
          </button>
          {(worlds ?? []).map((w) => {
            const runs = w.runs.filter((r) => showHidden || !r.hidden);
            // 还没开过班的群: 一行, 点进去 (群卡上有开班)
            if (!runs.length && w.group) return (
              <div className="world-group" key={w.id} data-world={w.id}>
                <div className="world-group-head">
                  <button className="world-group-name" data-pick-group={w.id} onClick={() => { onPickGroup?.(w.id); setOpen(false); }} title="进这个群 (还没开过班)">
                    <span className="world-group-caret">·</span>
                    <span className="world-group-title">{w.name}</span>
                    <span className="world-group-meta">{kindLabel(w)} · 还没开过班 · 点进去开班</span>
                  </button>
                </div>
              </div>
            );
            if (!runs.length) return null;
            const fold = isFolded(w);
            const shown = more[w.id] ? runs : runs.slice(0, RUNS_SHOWN);
            const latest = runs[0] ? runLabel(runs[0].id) : "";
            return (
              <div className={`world-group${fold ? " folded" : ""}`} key={w.id} data-world={w.id}>
                <div className="world-group-head">
                  {editing?.id === w.id ? (
                    <input className="world-rename" autoFocus value={editing.text} maxLength={40} placeholder="标题 (留空恢复原名)" aria-label="世界标题"
                      onChange={(e) => setEditing({ id: w.id, text: e.target.value })}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { onRename?.(w.id, editing.text.trim()); setEditing(null); } else if (e.key === "Escape") setEditing(null); }}
                      onBlur={() => setEditing(null)} />
                  ) : (
                    <button className="world-group-name" onClick={() => setFolded((f) => ({ ...f, [w.id]: !fold }))} aria-expanded={!fold} title={fold ? "展开" : "折起"}>
                      <span className="world-group-caret">{fold ? "▸" : "▾"}</span>
                      <span className="world-group-title">{w.id === "legacy" && !w.renamed ? "旧记录" : w.name}</span>
                      <span className="world-group-meta">{kindLabel(w)} · {runs.length} 班{fold && latest ? ` · 最近 ${latest}` : ""}</span>
                    </button>
                  )}
                  {onRename && editing?.id !== w.id ? <button className="link-button world-rename-button" onClick={() => setEditing({ id: w.id, text: w.id === "legacy" && !w.renamed ? "" : w.name })} title="改这个世界显示的标题 (只改名字, 记录不动; 留空恢复原名)">改名</button> : null}
                  {onHideMany && !showHidden && runs.length > 1 ? <button className="link-button" onClick={() => onHideMany(runs.map((r) => r.id))} title="把这一组的班都从列表里藏起来 (记录不删, 随时能放回)">收起这一组</button> : null}
                  {onPurge && runs.some((r) => !r.running) ? (confirmPurge === `world:${w.id}`
                    ? <span className="world-confirm" data-purge-confirm={w.id}>删这 {runs.filter((r) => !r.running).length} 班的对话记录? <button className="link-button danger-link" onClick={() => { onPurge(runs.filter((r) => !r.running).map((r) => r.id)); setConfirmPurge(null); }}>删</button> <button className="link-button" onClick={() => setConfirmPurge(null)}>取消</button></span>
                    : <button className="link-button danger-link" data-purge-world={w.id} onClick={() => setConfirmPurge(`world:${w.id}`)} title="彻底删这一组每班的对话 / 命令 / 读数 / 截图记录; 复盘、统计、存档链留着, 大脑笔记和知识库不碰">删对话记录</button>) : null}
                </div>
                {fold ? null : shown.map((r) => (
                  <div className={`world-run-row${r.id === viewRun ? " on" : ""}${r.hidden ? " hidden-run" : ""}`} key={r.id}>
                    <button className="world-run" data-run={r.id} onClick={() => { onPick(r.id); setOpen(false); }}>
                      <span className="world-run-label">{runLabel(r.id)}</span>
                      <span className={`world-run-state s-${runBriefStatus(r)}`}>{runBriefStatus(r)}{r.hidden ? " · 已收起" : ""}</span>
                    </button>
                    <span className="world-run-actions">
                      <button className="link-button" onClick={() => onHide(r.id, !r.hidden)} title={r.hidden ? "放回列表" : "从列表里藏起来 (记录不删, 随时能放回)"}>{r.hidden ? "放回" : "收起"}</button>
                      <button className="link-button" onClick={() => { onClearMine(r.id); setCleared(r.id); }} title="清掉你在这一班发过的话和命令 (大脑的记录不动)">{cleared === r.id ? "已清" : "清我的话"}</button>
                      {onPurge && !r.running ? (confirmPurge === r.id
                        ? <span className="world-confirm" data-purge-confirm={r.id}>删? <button className="link-button danger-link" data-purge-yes={r.id} onClick={() => { onPurge([r.id]); setConfirmPurge(null); }}>删</button> <button className="link-button" onClick={() => setConfirmPurge(null)}>取消</button></span>
                        : <button className="link-button danger-link" data-purge={r.id} onClick={() => setConfirmPurge(r.id)} title="彻底删这一班的对话 / 命令 / 读数 / 截图记录 (turn-*.jsonl 等); 复盘、统计、存档链留着, 大脑笔记和知识库不碰; 删完从列表收起">删对话记录</button>) : null}
                    </span>
                  </div>
                ))}
                {!fold && runs.length > RUNS_SHOWN ? (
                  <button className="link-button world-more" onClick={() => setMore((m) => ({ ...m, [w.id]: !m[w.id] }))}>{more[w.id] ? "只看最近 5 班" : `再看 ${runs.length - RUNS_SHOWN} 班`}</button>
                ) : null}
              </div>
            );
          })}
          {!worlds?.length ? <div className="world-empty">还没有任何一班; 点上面"新建对话"建一个群</div> : null}
          {hiddenCount ? <button className="link-button world-toggle" onClick={() => setShowHidden((v) => !v)}>{showHidden ? "不显示已收起的" : `显示已收起的 ${hiddenCount} 班`}</button> : null}
          {error ? <div className="world-error">{error}</div> : null}
          {/*  */}
          <div className="world-note">"收起"只是从列表里藏起来 (随时能放回); "清我的话"只清你在界面里发过的话; "删对话记录"彻底删那一班的对话 / 命令 / 读数 / 截图 (要点两次确认)。三个都不碰大脑的笔记、复盘、知识库、规则和存档链。</div>
        </div>
      ) : null}
    </div>
  );
}
