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

  return (
    <div className="shell">
      <SettingsSidebar active="plugins" />

      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">PLUGINS / OBSERVABILITY</p>
            <h1>插件</h1>
            <p>已加载插件、加载错误与调用统计。变更插件文件后点「重新加载」即可生效（新请求），无需重启 server。</p>
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
              ) : (
                <ul className="plugin-list">
                  {status.loaded.map((entry) => {
                    const isOff = disabledSet.has(entry.name);
                    return (
                      <li
                        key={entry.name}
                        className={`plugin-item${isOff ? " plugin-item-off" : ""}`}
                      >
                        <span className="plugin-name">{entry.name}</span>
                        <code className="plugin-source">{entry.source}</code>
                        <button
                          className={`plugin-toggle${isOff ? " off" : ""}`}
                          onClick={() => void toggle(entry.name, isOff)}
                          title={isOff ? "启用该插件" : "禁用该插件（模型将不可见、不可调用）"}
                        >
                          {isOff ? "已禁用" : "启用中"}
                        </button>
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
