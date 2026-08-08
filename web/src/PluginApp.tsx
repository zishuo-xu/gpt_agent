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
}

/** 插件面板：加载清单 / 加载错误 / 调用统计（可观测性） */
export function PluginApp() {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    document.title = "插件 · MyAgent";
    void fetch("/api/plugins")
      .then(async (response) => {
        if (!response.ok) throw new Error("读取插件状态失败");
        return response.json() as Promise<PluginStatus>;
      })
      .then(setStatus)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "读取插件状态失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  const hasStats = (status?.stats.length ?? 0) > 0;

  return (
    <div className="shell">
      <SettingsSidebar active="plugins" />

      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">PLUGINS / OBSERVABILITY</p>
            <h1>插件</h1>
            <p>已加载插件、加载错误与调用统计（重启 server 后生效，无热重载）。</p>
          </div>
        </header>

        {loading && <p className="plugin-hint">读取中…</p>}
        {!loading && error && (
          <p className="plugin-hint plugin-error">{error}</p>
        )}

        {!loading && !error && status && (
          <>
            <section className="plugin-section">
              <h2>已加载（{status.loaded.length}）</h2>
              {status.loaded.length === 0 ? (
                <p className="plugin-hint">未加载插件。放入 .myagent/tools/ 并重启 server。</p>
              ) : (
                <ul className="plugin-list">
                  {status.loaded.map((entry) => (
                    <li key={entry.name} className="plugin-item">
                      <span className="plugin-name">{entry.name}</span>
                      <code className="plugin-source">{entry.source}</code>
                    </li>
                  ))}
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
