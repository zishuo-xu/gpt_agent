import { useEffect, useState } from "react";
import { SettingsSidebar } from "./SettingsSidebar";

interface PluginLoaded {
  name: string;
  source: string;
}

interface PluginError {
  file: string;
  message: string;
}

interface PluginStats {
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
}

interface PluginStatus {
  loaded: PluginLoaded[];
  errors: PluginError[];
  stats: PluginStats[];
  disabled: string[];
}

/** 插件面板：加载清单 / 加载错误 / 调用统计 + 热重载与启停（可观测性 + 管理） */
export function PluginApp() {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloading, setReloading] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/plugins");
      if (!response.ok) throw new Error("读取插件状态失败");
      setStatus((await response.json()) as PluginStatus);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "读取插件状态失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    document.title = "插件 · MyAgent";
    void load();
  }, []);

  async function reload() {
    setReloading(true);
    setNotice(null);
    try {
      const response = await fetch("/api/plugins/reload", {
        method: "POST",
      });
      if (!response.ok) throw new Error("重新加载失败");
      setStatus((await response.json()) as PluginStatus);
      setNotice({ tone: "ok", text: "插件已重新加载（新请求生效）" });
    } catch (err: unknown) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "重新加载失败",
      });
    } finally {
      setReloading(false);
    }
  }

  async function toggle(name: string, enabled: boolean) {
    setNotice(null);
    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(name)}/enabled`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error("切换失败");
      setStatus((await loadStatus()) ?? status);
      setNotice({ tone: "ok", text: `${name} 已${enabled ? "启用" : "禁用"}` });
    } catch (err: unknown) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "切换失败",
      });
    }
  }

  async function loadStatus(): Promise<PluginStatus | null> {
    const response = await fetch("/api/plugins");
    if (!response.ok) return null;
    return (await response.json()) as PluginStatus;
  }

  const hasStats = (status?.stats.length ?? 0) > 0;
  const disabledSet = new Set(status?.disabled ?? []);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const keyword = search.trim().toLowerCase();
  const visibleLoaded = (status?.loaded ?? []).filter((entry) => {
    const isOff = disabledSet.has(entry.name);
    if (filter === "enabled" && isOff) return false;
    if (filter === "disabled" && !isOff) return false;
    if (keyword && !entry.name.toLowerCase().includes(keyword) && !entry.source.toLowerCase().includes(keyword)) return false;
    return true;
  });

  return (
    <div className="shell">
      <SettingsSidebar active="plugins" />

      <main>
        <header className="page-header">
          <div>
            <h1>扩展</h1>
            <p>管理插件与集成能力。变更插件文件后点「重新加载」即可生效（新请求），无需重启 server。</p>
          </div>
          <button
            className="save-button"
            onClick={() => void reload()}
            disabled={reloading}
          >
            {reloading ? "加载中…" : "重新加载"}
          </button>
        </header>

        {notice && (
          <p className={`plugin-notice plugin-notice-${notice.tone}`}>
            {notice.text}
          </p>
        )}

        <div className="plugin-toolbar">
          <div className="sidebar-search-wrap plugin-search">
            <input
              className="sidebar-search"
              type="search"
              placeholder="搜索扩展名称或描述"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="搜索扩展"
            />
            <kbd className="sidebar-search-kbd" aria-hidden="true">⌘F</kbd>
          </div>
          <div className="scope-switch plugin-filter" aria-label="扩展筛选">
            <button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>全部</button>
            <button className={filter === "enabled" ? "selected" : ""} onClick={() => setFilter("enabled")}>已启用</button>
            <button className={filter === "disabled" ? "selected" : ""} onClick={() => setFilter("disabled")}>未启用</button>
          </div>
        </div>

        {loading && <p className="plugin-hint">读取中…</p>}
        {!loading && error && (
          <p className="plugin-hint plugin-error">{error}</p>
        )}

        {!loading && !error && status && (
          <>
            <section className="plugin-section">
              <h2>已加载（{status.loaded.length}）</h2>
              {status.loaded.length === 0 ? (
                <p className="plugin-hint">未加载插件。放入 .myagent/tools/ 并点「重新加载」。</p>
              ) : visibleLoaded.length === 0 ? (
                <p className="plugin-hint">无匹配扩展。</p>
              ) : (
                <ul className="plugin-list">
                  {visibleLoaded.map((entry) => {
                    const isOff = disabledSet.has(entry.name);
                    const stat = status.stats.find((item) => item.name === entry.name);
                    return (
                      <li
                        key={entry.name}
                        className={`plugin-item${isOff ? " plugin-item-off" : ""}`}
                      >
                        <span className="plugin-icon" aria-hidden="true">
                          {entry.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="plugin-item-main">
                          <span className="plugin-name">{entry.name}</span>
                          <code className="plugin-source">{entry.source}</code>
                        </span>
                        {stat && (
                          <span className="plugin-item-stat" title="调用次数 / 失败">
                            {stat.calls} 次调用{stat.errors > 0 ? ` · ${stat.errors} 失败` : ""}
                          </span>
                        )}
                        <span className={`plugin-state${isOff ? " off" : ""}`}>
                          {isOff ? "未启用" : "已启用"}
                        </span>
                        <button
                          className={`switch plugin-switch${isOff ? "" : " on"}`}
                          aria-checked={!isOff}
                          aria-label={`${isOff ? "启用" : "禁用"} ${entry.name}`}
                          onClick={() => void toggle(entry.name, isOff)}
                          title={isOff ? "启用该插件" : "禁用该插件（模型将不可见、不可调用）"}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="plugin-section">
              <h2>加载错误（{status.errors.length}）</h2>
              {status.errors.length === 0 ? (
                <p className="plugin-hint">无。</p>
              ) : (
                <ul className="plugin-errors">
                  {status.errors.map((entry, index) => (
                    <li key={index} className="plugin-error-item">
                      <code>{entry.file}</code>
                      <span>{entry.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="plugin-section">
              <h2>调用统计（{status.stats.length}）</h2>
              {!hasStats ? (
                <p className="plugin-hint">暂无调用。插件工具被调用后在此累计（MCP 工具同样计入）。</p>
              ) : (
                <table className="plugin-stats">
                  <thead>
                    <tr>
                      <th>工具</th>
                      <th>调用次数</th>
                      <th>失败</th>
                      <th>成功率</th>
                      <th>平均耗时</th>
                      <th>累计耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.stats.map((entry) => {
                      const rate =
                        entry.calls === 0
                          ? "—"
                          : `${Math.round(
                              ((entry.calls - entry.errors) / entry.calls) * 100,
                            )}%`;
                      const avgMs =
                        entry.calls === 0
                          ? "—"
                          : `${Math.round(entry.totalMs / entry.calls)}ms`;
                      return (
                        <tr key={entry.name}>
                          <td className="plugin-stats-name">{entry.name}</td>
                          <td>{entry.calls}</td>
                          <td
                            className={
                              entry.errors > 0 ? "plugin-stats-error" : ""
                            }
                          >
                            {entry.errors}
                          </td>
                          <td>{rate}</td>
                          <td>{avgMs}</td>
                          <td>{Math.round(entry.totalMs)}ms</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
