import { useEffect, useState } from "react";
import { SettingsSidebar } from "./SettingsSidebar";

interface ProjectEntry {
  key: string;
  name: string;
}

interface ScheduledTaskView {
  id: string;
  command: string;
  at: string;
  everyMinutes?: number;
  createdAt: string;
}

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTime(iso: string): string {
  return TIME_FORMAT.format(new Date(iso));
}

function scheduleLabel(task: ScheduledTaskView): string {
  const when = formatTime(task.at);
  return task.everyMinutes
    ? `每 ${task.everyMinutes} 分钟 · 下次 ${when}`
    : `一次性 · ${when}`;
}

/**
 * 定时任务面板：注册 /run --at/--every 任务，到期由 Web 服务端 ticker 触发。
 * 任务按项目隔离（persist 于项目 stateDir 的 scheduled.jsonl）。
 */
export function ScheduledApp() {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [currentProject, setCurrentProject] = useState("");
  const [tasks, setTasks] = useState<ScheduledTaskView[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    document.title = "定时任务 · MyAgent";
    void (async () => {
      const response = await fetch("/api/projects");
      const payload = await response.json();
      const next = (payload.projects ?? []) as ProjectEntry[];
      setProjects(next);
      const remembered = window.localStorage.getItem("scheduled.project");
      const initial =
        next.find((project) => project.key === remembered)?.key ??
        next[0]?.key ??
        "";
      setCurrentProject(initial);
    })();
  }, []);

  async function loadTasks(project: string) {
    if (!project) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/scheduled?project=${encodeURIComponent(project)}`,
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "读取定时任务失败");
      }
      setTasks((payload.tasks ?? []) as ScheduledTaskView[]);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "读取定时任务失败",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!currentProject) return;
    window.localStorage.setItem("scheduled.project", currentProject);
    void loadTasks(currentProject);
  }, [currentProject]);

  // 每 30s 自动刷新：到期任务被 ticker 消费后从列表消失
  useEffect(() => {
    if (!currentProject) return;
    const timer = window.setInterval(
      () => void loadTasks(currentProject),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, [currentProject]);

  useEffect(() => {
    if (notice?.tone !== "ok") return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function addTask() {
    const command = draft.trim();
    if (!command) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/scheduled?project=${encodeURIComponent(currentProject)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "注册定时任务失败");
      }
      setDraft("");
      setTasks((current) => [...current, payload.task as ScheduledTaskView]);
      setNotice({ tone: "ok", text: "定时任务已注册。" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "注册定时任务失败",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function removeTask(task: ScheduledTaskView) {
    if (
      !window.confirm(
        `删除定时任务「${task.command}」？已注册的调度将从磁盘移除。`,
      )
    ) {
      return;
    }
    const response = await fetch(
      `/api/scheduled/${task.id}?project=${encodeURIComponent(currentProject)}`,
      { method: "DELETE" },
    );
    const payload = await response.json();
    if (!response.ok) {
      setNotice({
        tone: "error",
        text: payload.error ?? "删除失败",
      });
      return;
    }
    setTasks((current) => current.filter((item) => item.id !== task.id));
    setNotice({ tone: "ok", text: "定时任务已删除。" });
  }

  return (
    <div className="shell">
      <SettingsSidebar active="scheduled" />
      <main className="memory-main">
        <header className="page-header">
          <div>
            <p className="eyebrow">AGENT / SCHEDULER</p>
            <h1>定时任务</h1>
            <p>
              无人值守 /run 定时触发 · 到期由本机 Web 服务启动会话
            </p>
          </div>
          <button
            className="save-button"
            disabled={!currentProject}
            onClick={() => void loadTasks(currentProject)}
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
          <span className="scheduler-hint">
            例：/run 每早巡检 --at 09:00 或 /run 每 30 分钟巡检 --every 30
          </span>
        </div>
        {notice && (
          <div className={`notice ${notice.tone}`}>{notice.text}</div>
        )}
        <section className="scheduler-new">
          <input
            className="scheduler-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void addTask();
              }
            }}
            placeholder="/run 任务描述 [--at HH:mm] [--every N 分钟] [--permission …]"
            disabled={!currentProject}
          />
          <button
            className="save-button"
            disabled={submitting || !draft.trim() || !currentProject}
            onClick={() => void addTask()}
          >
            {submitting ? "注册中…" : "注册定时任务"}
          </button>
        </section>
        <section className="scheduler-list">
          {loading ? (
            <div className="chat-waiting">正在读取定时任务…</div>
          ) : tasks.length === 0 ? (
            <div className="scheduler-empty">
              当前项目暂无定时任务。注册后由服务端轮询触发，无需保持本页面打开。
            </div>
          ) : (
            tasks.map((task) => (
              <div className="scheduler-item" key={task.id}>
                <div className="scheduler-item-main">
                  <code>{task.command}</code>
                  <small>
                    {scheduleLabel(task)} · 注册于{" "}
                    {formatTime(task.createdAt)}
                  </small>
                </div>
                <button
                  className="scheduler-remove"
                  onClick={() => void removeTask(task)}
                  title="删除定时任务"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </section>
      </main>
    </div>
  );
}
