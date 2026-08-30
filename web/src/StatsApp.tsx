import { useEffect, useMemo, useState } from "react";
import { SettingsSidebar } from "./SettingsSidebar";
import { TrajectoryTable } from "./trajectory-view";
import type { SessionEvent } from "./session-display";

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
  byModel: Array<{
    providerId: string;
    model: string;
    costCny: number;
    tokens: number;
  }>;
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
  waiting_plan: "等待计划确认",
  waiting_user: "等待你的回答",
  done: "已完成",
  error: "失败",
  interrupted: "中断",
};

interface RunSummaryView {
  taskId: string;
  description: string;
  status: "completed" | "interrupted" | "failed";
  reason?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: string;
  todos: Array<{ id: string; text: string; status: string }>;
}

const RUN_STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  interrupted: "已中断",
  failed: "已失败",
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
  const [summaryFor, setSummaryFor] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [runDetail, setRunDetail] = useState<{
    run: RunSummaryView;
    totals: {
      totalCostCny: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      status: string;
    };
  } | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  /** 轨迹表格模态：会话 id → 事件流（一次性拉取） */
  const [trajectoryFor, setTrajectoryFor] = useState<{
    id: string;
    title: string;
    events: SessionEvent[];
  } | null>(null);
  const [loadingTrajectory, setLoadingTrajectory] = useState(false);

  async function openTrajectory(id: string, title: string) {
    setTrajectoryFor({ id, title, events: [] });
    setLoadingTrajectory(true);
    try {
      const response = await fetch(
        `/api/sessions/${id}/events?project=${encodeURIComponent(currentProject)}`,
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "读取会话事件失败");
      }
      setTrajectoryFor({
        id,
        title,
        events: (payload.events ?? []) as SessionEvent[],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取会话事件失败");
      setTrajectoryFor(null);
    } finally {
      setLoadingTrajectory(false);
    }
  }

  async function openSummary(id: string, title: string) {
    setSummaryFor({ id, title });
    setRunDetail(null);
    setLoadingSummary(true);
    try {
      const response = await fetch(
        `/api/sessions/${id}/summary?project=${encodeURIComponent(currentProject)}`,
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "读取收尾总结失败");
      }
      setRunDetail(payload.run ? payload : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取收尾总结失败");
    } finally {
      setLoadingSummary(false);
    }
  }

  useEffect(() => {
    document.title = "任务统计 · MyAgent";
    void (async () => {
      const response = await fetch("/api/projects");
      const payload = await response.json();
      const next = (payload.projects ?? []) as ProjectEntry[];
      setProjects(next);
      const remembered = window.localStorage.getItem("stats.project");
      // 默认项目顺序：上次记忆 → 服务器默认项目（启动目录）→ 列表第一项。
      // 不能用 next[0] 兜底大厅：/api/projects 恒把大厅排第一，首次打开
      // 会串成大厅数据（用户当前项目上下文脱节）
      const initial =
        next.find((project) => project.key === remembered)?.key ??
        (payload.defaultKey as string | undefined) ??
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
    // 竞态保护：快速切换项目时，过期响应（旧项目的 fetch）不得覆盖新数据
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/stats?project=${encodeURIComponent(currentProject)}`,
          { signal: controller.signal },
        );
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error ?? "读取统计失败");
        }
        setStats(payload as SessionStatsPayload);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "读取统计失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
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
            {stats.byModel.length > 0 && (
              <section className="stats-model-section">
                <h2>按模型成本</h2>
                <div className="stats-model-table">
                  {stats.byModel.map((entry) => {
                    const maxCost = Math.max(
                      ...stats.byModel.map((item) => item.costCny),
                      0.01,
                    );
                    return (
                      <div
                        className="stats-model-row"
                        key={`${entry.providerId}/${entry.model}`}
                      >
                        <span className="stats-model-name">
                          {entry.model}
                          <small>{entry.providerId}</small>
                        </span>
                        <span className="stats-model-bar">
                          <span
                            style={{
                              width: `${
                                Math.round(
                                  (entry.costCny / maxCost) * 100,
                                ) || 1
                              }%`,
                            }}
                          />
                        </span>
                        <span className="stats-model-cost">
                          {formatCost(entry.costCny)}
                        </span>
                        <span className="stats-model-tokens">
                          {formatTokens(entry.tokens)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
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
                      <th>收尾总结</th>
                      <th>轨迹</th>
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
                        <td>
                          {session.kind === "run" ? (
                            <button
                              className="stats-summary-button"
                              onClick={() =>
                                void openSummary(session.id, session.title)
                              }
                            >
                              查看
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          <button
                            className="stats-summary-button"
                            onClick={() =>
                              void openTrajectory(session.id, session.title)
                            }
                          >
                            轨迹
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </>
        )}
        {summaryFor && (
          <div
            className="stats-modal-overlay"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setSummaryFor(null);
                setRunDetail(null);
              }
            }}
          >
            <div className="stats-modal" role="dialog" aria-label="收尾总结">
              <div className="stats-modal-head">
                <div>
                  <p className="eyebrow">RUN SUMMARY</p>
                  <h2>{summaryFor.title}</h2>
                </div>
                <button
                  className="stats-modal-close"
                  aria-label="关闭"
                  onClick={() => {
                    setSummaryFor(null);
                    setRunDetail(null);
                  }}
                >
                  ×
                </button>
              </div>
              {loadingSummary ? (
                <div className="chat-waiting">正在读取收尾总结…</div>
              ) : !runDetail ? (
                <div className="stats-modal-empty">
                  该会话没有可展示的收尾总结（可能中断于进程崩溃或 run 事件不完整）。
                </div>
              ) : (
                <>
                  <div className="stats-modal-meta">
                    <span
                      className={`stats-modal-status status-${runDetail.run.status}`}
                    >
                      {RUN_STATUS_LABEL[runDetail.run.status] ??
                        runDetail.run.status}
                    </span>
                    <span>
                      {formatTime(runDetail.run.startedAt)} →{" "}
                      {formatTime(runDetail.run.finishedAt)}
                    </span>
                    <span>
                      耗时{" "}
                      {Math.max(
                        1,
                        Math.round(runDetail.run.durationMs / 60_000),
                      )}{" "}
                      分钟
                    </span>
                    <span>
                      费用 {formatCost(runDetail.totals.totalCostCny)} · 输入{" "}
                      {formatTokens(runDetail.totals.totalInputTokens)}
                    </span>
                    {runDetail.run.reason && (
                      <span className="stats-modal-reason">
                        原因：{runDetail.run.reason}
                      </span>
                    )}
                  </div>
                  <div className="stats-modal-body">
                    <h3>收尾总结</h3>
                    <pre className="stats-modal-summary">
                      {runDetail.run.summary || "（无总结文本）"}
                    </pre>
                    {runDetail.run.todos.length > 0 && (
                      <>
                        <h3>Todo 快照</h3>
                        <ul className="stats-modal-todos">
                          {runDetail.run.todos.map((todo) => (
                            <li
                              key={todo.id}
                              className={
                                todo.status === "done" ? "todo-done" : ""
                              }
                            >
                              {todo.status === "done" ? "☑ " : "☐ "}
                              {todo.text}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {trajectoryFor && (
          <div
            className="stats-modal-overlay"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setTrajectoryFor(null);
              }
            }}
          >
            <div
              className="stats-modal stats-modal-trajectory"
              role="dialog"
              aria-label={`轨迹 · ${trajectoryFor.title}`}
            >
              <div className="stats-modal-head">
                <div>
                  <h3 title={trajectoryFor.title}>
                    {trajectoryFor.title.slice(0, 60)}
                  </h3>
                  <span className="stats-modal-reason">
                    {trajectoryFor.id}
                  </span>
                </div>
                <button
                  className="stats-modal-close"
                  onClick={() => setTrajectoryFor(null)}
                >
                  ×
                </button>
              </div>
              <div className="stats-modal-body">
                {loadingTrajectory ? (
                  <div className="chat-waiting">正在读取会话事件…</div>
                ) : (
                  <TrajectoryTable
                    events={trajectoryFor.events}
                    onClose={() => setTrajectoryFor(null)}
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
