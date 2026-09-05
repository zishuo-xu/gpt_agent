/**
 * 设置区侧栏：会话 / 设置 / 扩展 / 记忆 / 定时 / 统计（与任务栏同风格的品牌区）。
 */
export function SettingsSidebar(props: {
  active: "settings" | "plugins" | "memory" | "scheduled" | "stats";
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
            <path d="M4.5 7h5M7 4.5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <span>MyAgent</span>
      </div>
      <nav aria-label="设置导航">
        <button
          className="nav-item"
          onClick={() => {
            window.location.hash = "sessions";
          }}
        >
          <span aria-hidden="true">◉</span>会话
        </button>
        <button
          className={`nav-item ${
            props.active === "settings" ? "active" : ""
          }`}
          onClick={() => {
            window.location.hash = "settings";
          }}
        >
          <span aria-hidden="true">⚙</span>设置
        </button>
        <button
          className={`nav-item ${
            props.active === "plugins" ? "active" : ""
          }`}
          onClick={() => {
            window.location.hash = "plugins";
          }}
        >
          <span aria-hidden="true">▣</span>扩展
        </button>
        <button
          className={`nav-item ${
            props.active === "memory" ? "active" : ""
          }`}
          onClick={() => {
            window.location.hash = "memory";
          }}
        >
          <span aria-hidden="true">▤</span>记忆
        </button>
        <button
          className={`nav-item ${
            props.active === "scheduled" ? "active" : ""
          }`}
          onClick={() => {
            window.location.hash = "scheduled";
          }}
        >
          <span aria-hidden="true">◷</span>定时
        </button>
        <button
          className={`nav-item ${
            props.active === "stats" ? "active" : ""
          }`}
          onClick={() => {
            window.location.hash = "stats";
          }}
        >
          <span aria-hidden="true">▦</span>统计
        </button>
      </nav>
      <div className="local-state">
        <span className="status-dot" />
        本机服务
        <small>{window.location.host}</small>
      </div>
    </aside>
  );
}
