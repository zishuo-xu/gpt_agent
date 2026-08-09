import { useEffect, useMemo, useState } from "react";
import { SettingsSidebar } from "./SettingsSidebar";

interface ProjectEntry {
  key: string;
  name: string;
}

interface DayBucket {
  day: string;
  sessions: number;
  completed: number;
  failed: number;
  tokens: number;
  costCny: number;
}

interface SessionStatsPayload {
  totals: {
    sessions: number;
    running: number;
    completed: number;
    failed: number;
    interrupted: number;
    tokens: number;
    costCny: number;
    runSessions: number;
  };
  byDay: DayBucket[];
  sessions: Array<{
    id: string;
    title: string;
    status: string;
    kind: string;
    createdAt: string;
    updatedAt: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostCny: number;
  }>;
}

const STATUS_LABEL: Record<string, string> = {
  idle: "空闲",
  running: "运行中",
  waiting_permission: "等待审批",
  done: "已完成",
  error: "失败",
  interrupted: "中断",
};

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function formatCost(costCny: number): string {
  return `¥${costCny.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/**
 * 任务统计面板：/api/stats 聚合会话 summary（按天分桶 + 总量），
 * 纯 CSS 柱状图展示每日 tokens/费用，下方为会话明细表。
 */
export function StatsApp() {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [currentProject, setCurrentProject] = useState("");
  const [stats, setStats] = useState<SessionStatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    document.title = "任务统计 · MyAgent";
    void (async () => {
      const response = await fetch("/api/projects");
      const payload = await response.json();
      const next = (payload.projects ?? []) as ProjectEntry[];
      setProjects(next);
      const remembered = window.localStorage.getItem("stats.project");
      const initial =
        next.find((project) => project.key === remembered)?.key ??
        next[0]?.key ??
        "";
      setCurrentProject(initial);
    })();
  }, []);

  useEffect(() => {
    if (!currentProject) return;
    window.localStorage.setItem("stats.project", currentProject);
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const response = await fetch(
          `/api/stats?project=${encodeURIComponent(currentProject)}`,
        );
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error ?? "读取统计失败");
        }
        setStats(payload as SessionStatsPayload);
      } catch (err) {
        setError(err instanceof Error ? err.message : "读取统计失败");
      } finally {
        setLoading(false);
      }
    })();
  }, [currentProject, reloadKey]);

  const chart = useMemo(() => {
    if (!stats || stats.byDay.length === 0) return null;
    const days = stats.byDay;
    const maxTokens = Math.max(...days.map((day) => day.tokens), 1);
    const maxCost = Math.max(...days.map((day) => day.costCny), 0.01);
    return { days, maxTokens, maxCost };
  }, [stats]);

  const totals = stats?.totals;

  return (
    <div className="shell">
      <SettingsSidebar active="stats" />
      <main className="memory-main">
        <header className="page-header">
          <div>
            <p className="eyebrow">AGENT / STATS</p>
            <h1>任务统计</h1>
            <p>会话用量聚合 · 按天分桶 · 本地时区</p>
          </div>
          <button
            className="save-button"
            disabled={!currentProject}
            onClick={() => setReloadKey((value) => value + 1)}
          >
            刷新
          </button>
        </header>
        <div className="page-toolbar">
          <label>
            项目
            <select
              className="project-switcher"
              value={currentProject}
              onChange={(event) => setCurrentProject(event.target.value)}
            >
              {projects.map((project) => (
                <option value={project.key} key={project.key}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <div className="notice error">{error}</div>}
        {loading && <div className="chat-waiting">正在聚合统计…</div>}
        {!loading && stats && (
          <>
            <section className="stats-cards">
              <div className="stats-card">
                <span>会话总数</span>
                <strong>{totals?.sessions ?? 0}</strong>
                <small>无人值守 {totals?.runSessions ?? 0}</small>
              </div>
              <div className="stats-card">
                <span>完成</span>
                <strong>{totals?.completed ?? 0}</strong>
                <small>失败 {totals?.failed ?? 0}</small>
              </div>
              <div className="stats-card">
                <span>进行中</span>
                <strong>{totals?.running ?? 0}</strong>
                <small>中断 {totals?.interrupted ?? 0}</small>
              </div>
              <div className="stats-card">
                <span>输入 tokens</span>
                <strong>{formatTokens(totals?.tokens ?? 0)}</strong>
                <small>{totals?.tokens ?? 0} 累计</small>
              </div>
              <div className="stats-card">
                <span>累计费用</span>
                <strong>{formatCost(totals?.costCny ?? 0)}</strong>
                <small>输出 {totals?.sessions ?? 0} 会话</small>
              </div>
            </section>
            {chart ? (
              <section className="stats-chart-section">
                <h2>每日用量</h2>
                <div className="stats-chart">
                  {chart.days.map((day) => (
                    <div className="stats-chart-col" key={day.day}>
                      <div className="stats-chart-bars">
                        <div
                          className="stats-bar tokens"
                          style={{
                            height: `${
                              Math.round(
                                (day.tokens / chart.maxTokens) * 100,
                              ) || 1
                            }%`,
                          }}
                          title={`${day.day} tokens：${day.tokens}`}
                        />
                        <div
                          className="stats-bar cost"
                          style={{
                            height: `${
                              Math.round(
                                (day.costCny / chart.maxCost) * 100,
                              ) || 1
                            }%`,
                          }}
                          title={`${day.day} 费用：${formatCost(day.costCny)}`}
                        />
                      </div>
                      <span className="stats-chart-label">
                        {day.day.slice(5)}
                      </span>
                      <small className="stats-chart-count">
                        {day.sessions}
                      </small>
                    </div>
                  ))}
                </div>
                <div className="stats-chart-legend">
                  <span className="legend-tokens">输入 tokens</span>
                  <span className="legend-cost">费用</span>
                  <span>每列上方数字为当日会话数</span>
                </div>
              </section>
            ) : (
              <div className="stats-empty">
                暂无会话数据。跑过 /run 任务或对话后这里会出现聚合。
              </div>
            )}
            {stats.sessions.length > 0 && (
              <section className="stats-sessions">
                <h2>会话明细</h2>
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>创建时间</th>
                      <th>标题</th>
                      <th>类型</th>
                      <th>状态</th>
                      <th>输入 tokens</th>
                      <th>费用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.sessions.map((session) => (
                      <tr key={session.id}>
                        <td>{formatTime(session.createdAt)}</td>
                        <td title={session.title}>{session.title}</td>
                        <td>
                          {session.kind === "run" ? "无人值守" : "交互"}
                        </td>
                        <td>
                          <span className={`status-${session.status}`}>
                            {STATUS_LABEL[session.status] ?? session.status}
                          </span>
                        </td>
                        <td>{formatTokens(session.totalInputTokens)}</td>
                        <td>{formatCost(session.totalCostCny)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
