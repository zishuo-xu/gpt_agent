import { useState } from "react";
import type { SessionSummary } from "@shared/types.js";
import { statusMeta } from "./session-render";

export type TaskGroup = { id: string; label: string; sessions: SessionSummary[] };

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "最近";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} 天前` : new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function groupSessions(sessions: SessionSummary[]): TaskGroup[] {
  const waiting = sessions.filter((session) => ["waiting_permission", "waiting_plan", "waiting_user", "error", "interrupted"].includes(session.status));
  const running = sessions.filter((session) => session.status === "running");
  const recent = sessions.filter((session) => ["done", "idle"].includes(session.status));
  return [
    { id: "attention", label: "需要你处理", sessions: waiting },
    { id: "active", label: "进行中", sessions: running },
    { id: "recent", label: "最近任务", sessions: recent },
  ];
}

/** 左侧任务列表（移动端为抽屉，≤768px 生效；桌面恒展开） */
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
        ＋ 新建任务
      </button>
      <input
        className="sidebar-search"
        type="search"
        placeholder="搜索任务…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="sidebar-sessions" aria-label="任务列表">
        {visible.length === 0 && (
          <div className="sidebar-empty">
            {props.sessions.length === 0
              ? props.sessionsLoaded
                ? "还没有任务"
                : "加载任务…"
                : "无匹配任务"}
          </div>
        )}
        {groupSessions(visible).map((group) => group.sessions.length > 0 && (
          <section className={`task-group task-group-${group.id}`} key={group.id} aria-label={group.label}>
            <h2 className="task-group-label">{group.label}<span>{group.sessions.length}</span></h2>
            {group.sessions.map((session) => {
              const active = session.id === props.selectedId;
              const status = statusMeta[session.status];
              return (
                <div className={`sidebar-task-row ${active ? "active" : ""}`} key={session.id}>
                  <button
                    className={`sidebar-session ${active ? "active" : ""}`}
                    onClick={() => props.onSelect(session.id)}
                    title={session.title}
                  >
                    <span className={`session-dot tone-${status.tone}`} aria-hidden="true" />
                    <span className="session-line-title">{session.title}</span>
                  </button>
                  <span className="task-meta"><span>{status.label}</span><time dateTime={session.updatedAt}>{relativeTime(session.updatedAt)}</time></span>
                </div>
              );
            })}
          </section>
        ))}
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
