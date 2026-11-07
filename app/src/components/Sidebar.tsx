// 左栏: 全队 + 每个角色一行 (头像、"Claude Opus 5.5 · A"、游戏里的名字作小字、状态点、最后一句、等你的角标); 底部账号 · 设置 (三家各剩多少额度)。
// 顶上不再写 "Factorio Pilot"。样子照 OpenGrokBot web/src/components/Sidebar.tsx (MIT, 见 NOTICE)。
// 底部三个按钮下面的小字 (几家能用 / 哪些是搬来的 / N 条命令) 去掉了
import { SLASH_COMMANDS, TEAM, agentLabel, vendorOf, type Agent, type Presence } from "../logic.ts";
import { Avatar } from "./Avatar.tsx";
import { useState, type ReactNode } from "react";

export type Row = { id: string; title: string; agent: Agent | null; presence: Presence | null; preview: string; pending: number };

export function Sidebar({ rows, selected, onSelect, onAccounts, onSources, onPick, top }: {
  rows: Row[]; selected: string; onSelect: (id: string) => void; onAccounts: () => void;
  /** 来源 · 致谢弹窗 */
  onSources?: () => void;
  /** 点了"/ 命令"面板里的一条: 填进输入框 */
  onPick?: (cmd: string) => void;
  /** 顶上: 切世界和班次 (WorldPicker) */
  top?: ReactNode;
}) {
  const [cmdsOpen, setCmdsOpen] = useState(false);
  return (
    <aside className="sidebar">
      {top}
      <div className="sidebar-list">
        {rows.map((r, i) => {
          // 有角标就已经在说"等你"了; 没有角标时写一句状态
          const note = r.presence && r.presence !== "没在跑" && !(r.presence === "等你" && r.pending > 0) ? r.presence : null;
          return (
            <div key={r.id}>
              {i === 1 ? <div className="sidebar-section">角色</div> : null}
              <button className={`sidebar-item${r.id === selected ? " selected" : ""}`} data-id={r.id} onClick={() => onSelect(r.id)} title={r.agent ? `${r.title} · 游戏里叫 ${r.agent.name}` : undefined}>
                <Avatar vendor={r.agent ? vendorOf(r.agent.model) : null} text={r.id === TEAM ? "队" : agentLabel(r.id)} state={r.presence} title={r.presence ?? undefined} />
                <span className="sidebar-text">
                  <span className="sidebar-name">
                    <span className="sidebar-title">{r.title}</span>
                    {note ? <span className={`sidebar-state s-${note}`}>{note}</span> : null}
                  </span>
                  {r.agent ? <span className="sidebar-sub">游戏里: {r.agent.name}</span> : null}
                  <span className="sidebar-preview">{r.preview}</span>
                </span>
                {r.pending > 0 ? <span className="sidebar-badge" title={`${r.pending} 件事等你处理`}>{r.pending}</span> : null}
              </button>
            </div>
          );
        })}
      </div>
      <div className="sidebar-foot">
        {/* "/ 命令" 面板: 输入框以 / 开头直接执行的命令都是什么、干什么; 点一条就填进输入框 (还要选一个角色再发) */}
        <button className="cmd-toggle" onClick={() => setCmdsOpen((v) => !v)} aria-expanded={cmdsOpen}>
          <span className="avatar small">/</span>
          <span className="account-text">
            <span className="account-title">/ 命令</span>
            {cmdsOpen ? <span className="account-sub">点一条填进输入框 (先选一个角色)</span> : null}
          </span>
          <span className="cmd-caret">{cmdsOpen ? "▾" : "▸"}</span>
        </button>
        {cmdsOpen ? (
          <ul className="cmd-list">
            {SLASH_COMMANDS.map((c) => (
              <li key={c.cmd}><button className="cmd-item" onClick={() => onPick?.(c.cmd)} title={`填入 /${c.cmd}`}><code>/{c.cmd}</code><span className="cmd-what">{c.what}</span></button></li>
            ))}
          </ul>
        ) : null}
        <button className="account-button" onClick={onAccounts}>
          <span className="avatar small">设</span>
          <span className="account-text">
            <span className="account-title">账号 · 设置</span>
          </span>
        </button>
        <button className="account-button" onClick={onSources}>
          <span className="avatar small">源</span>
          <span className="account-text">
            <span className="account-title">来源 · 致谢</span>
          </span>
        </button>
      </div>
    </aside>
  );
}
