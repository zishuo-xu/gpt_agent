import { useState } from "react";
import type { SessionSummary } from "@shared/types.js";
import { statusMeta } from "./session-render";

/** 左侧会话列表（移动端为抽屉，≤768px 生效；桌面恒展开） */
export function SessionListSidebar(props: {
  sessions: SessionSummary[];
  sessionsLoaded: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** 移动端抽屉开合（≤768px 生效；桌面恒展开） */
  open?: boolean;
}) {
  const [search, setSearch] = useState("");
  const keyword = search.trim().toLowerCase();
  const visible = keyword
    ? props.sessions.filter(
        (session) =>
          session.title.toLowerCase().includes(keyword) ||
          (session.firstMessage ?? "").toLowerCase().includes(keyword),
      )
    : props.sessions;
  return (
    <aside
      className={`sidebar session-list-sidebar${props.open ? " open" : ""}`}
    >
      <div className="brand">
        <span className="brand-mark">◆</span>
        <span>MyAgent</span>
      </div>
      <button className="sidebar-new" onClick={props.onNew}>
        ＋ 新会话
      </button>
      <input
        className="sidebar-search"
        type="search"
        placeholder="搜索会话…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="sidebar-sessions" aria-label="会话列表">
        {visible.length === 0 && (
          <div className="sidebar-empty">
            {props.sessions.length === 0
              ? props.sessionsLoaded
                ? "还没有会话"
                : "加载会话…"
              : "无匹配会话"}
          </div>
        )}
        {visible.map((session) => {
          const active = session.id === props.selectedId;
          const status = statusMeta[session.status];
          return (
            <button
              key={session.id}
              className={`sidebar-session ${active ? "active" : ""}`}
              onClick={() => props.onSelect(session.id)}
              title={session.title}
            >
              <span className={`session-dot tone-${status.tone}`} />
              <span className="session-line-title">{session.title}</span>
            </button>
          );
        })}
      </div>
      <div className="sidebar-foot">
        <button
          className="nav-item"
          onClick={() => {
            window.location.hash = "settings";
          }}
        >
          <span>⚙</span>设置
        </button>
        <div className="local-state">
          <span className="status-dot" />
          本机服务
          <small>{window.location.host}</small>
        </div>
      </div>
    </aside>
  );
}
