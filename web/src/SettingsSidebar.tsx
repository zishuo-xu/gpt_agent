/**
 * 设置区侧栏：设置 + 记忆面板 整合的导航。
 * 记忆面板并入设置（作为子项），不再单独占主导航。
 */
export function SettingsSidebar(props: {
  active: "settings" | "memory";
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">◆</span>
        <span>MyAgent</span>
      </div>
      <nav aria-label="设置导航">
        <button
          className="nav-item"
          onClick={() => {
            window.location.hash = "sessions";
          }}
        >
          <span>◉</span>会话
        </button>
        <button
          className={`nav-item ${
            props.active === "settings" ? "active" : ""
          }`}
          onClick={() => {
            window.location.hash = "settings";
          }}
        >
          <span>⚙</span>模型配置
        </button>
        <button
          className={`nav-item ${
            props.active === "memory" ? "active" : ""
          }`}
          onClick={() => {
            window.location.hash = "memory";
          }}
        >
          <span>✎</span>记忆面板
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
