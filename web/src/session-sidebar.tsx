import { useState } from "react";
import type { SessionSummary } from "@shared/types.js";

export type TaskGroup = { id: string; label: string; sessions: SessionSummary[] };

/** 任务行尾的状态标记：待处理红点 / 进行中绿圈 / 完成绿勾 */
function TaskStateMark({ status }: { status: SessionSummary["status"] }) {
  if (["waiting_permission", "waiting_plan", "waiting_user", "error", "interrupted"].includes(status)) {
    return <span className="task-state-mark mark-attention" aria-label="需要处理" />;
  }
  if (status === "running") {
    return <span className="task-state-mark mark-running" aria-label="进行中" />;
  }
  return (
    <span className="task-state-mark mark-done" aria-label="已完成">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
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

/** 左侧任务栏（设计稿形态：品牌 / 项目切换 / 新建任务 / 搜索 / 分组列表 / 底部设置与扩展）
 *  移动端为抽屉（≤768px 生效；桌面恒展开） */
export function SessionListSidebar(props: {
  sessions: SessionSummary[];
  sessionsLoaded: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  currentProject?: string;
  projects?: { key: string; name: string; cwd: string }[];
  onSwitchProject?: (key: string) => void;
  /** 移动端抽屉开合（≤768px 生效；桌面恒展开） */
  open?: boolean;
  /** 桌面端折叠为图标栏（≤768px 抽屉态下忽略） */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
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
  const groups = groupSessions(visible);
  return (
    <aside
      className={`sidebar session-list-sidebar${props.open ? " open" : ""}${props.collapsed ? " collapsed" : ""}`}
    >
      <div className="brand">
        <span className="brand-mark">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
            <path d="M4.5 7h5M7 4.5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <span className="brand-name">MyAgent</span>
        <button
          type="button"
          className="sidebar-collapse"
          aria-label={props.collapsed ? "展开侧栏" : "折叠侧栏"}
          title={props.collapsed ? "展开侧栏" : "折叠侧栏"}
          onClick={props.onToggleCollapse}
        >
          {props.collapsed ? "»" : "«"}
        </button>
      </div>
      {props.projects && props.projects.length > 0 && (
        <select
          className="sidebar-project-switcher"
          value={props.currentProject}
          onChange={(event) => props.onSwitchProject?.(event.target.value)}
          title="选择工作区"
          aria-label="选择工作区"
        >
          {props.projects.map((project) => (
            <option value={project.key} key={project.key}>
              {project.name}
            </option>
          ))}
        </select>
      )}
      <button className="sidebar-new" onClick={props.onNew} title="新建任务">
        <span className="sidebar-new-plus" aria-hidden="true">+</span> 新建任务
      </button>
      <div className="sidebar-search-wrap">
        <input
          className="sidebar-search"
          type="search"
          placeholder="搜索任务"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <kbd className="sidebar-search-kbd" aria-hidden="true">⌘K</kbd>
      </div>
      <div className="sidebar-sessions" aria-label="会话列表">
        {visible.length === 0 && (
          <div className="sidebar-empty">
            {props.sessions.length === 0
              ? props.sessionsLoaded
                ? "还没有任务"
                : "加载任务…"
              : "无匹配任务"}
          </div>
        )}
        {groups.map((group) => group.sessions.length > 0 && (
          <section className={`task-group task-group-${group.id}`} key={group.id} aria-label={group.label}>
            <h2 className="task-group-label">
              <span className="task-group-name">
                {group.id === "attention" && <span className="task-group-dot dot-amber" aria-hidden="true" />}
                {group.id === "active" && <span className="task-group-dot dot-green" aria-hidden="true" />}
                {group.label}
              </span>
              <span className="task-group-count">{group.sessions.length}</span>
            </h2>
            {group.sessions.map((session) => {
              const active = session.id === props.selectedId;
              return (
                <div className={`sidebar-task-row ${active ? "active" : ""}`} key={session.id}>
                  <button
                    className={`sidebar-session ${active ? "active" : ""}`}
                    onClick={() => props.onSelect(session.id)}
                    title={session.title}
                  >
                    <span className="session-line-title">{session.title}</span>
                    <TaskStateMark status={session.status} />
                  </button>
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
          title="设置"
        >
          <span aria-hidden="true">⚙</span>设置
        </button>
        <button
          className="nav-item"
          onClick={() => {
            window.location.hash = "plugins";
          }}
          title="扩展"
        >
          <span aria-hidden="true">🧩</span>扩展
        </button>
        <div className="local-state" title={`本机服务 ${window.location.host}`}>
          <span className="status-dot" />
        </div>
      </div>
    </aside>
  );
}
