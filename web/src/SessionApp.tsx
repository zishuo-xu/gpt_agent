import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  PermissionMode,
  RecordedEvent,
  SessionStatus,
  SessionSummary,
  WorkspaceInfo,
} from "@shared/types.js";
import { useProjectPicker, type OpenedProject } from "./use-project-picker";
import { buildDisplayItems, toolResultDiffText } from "./session-display";
import type { DeliveryWorkbenchData } from "./DeliveryWorkbench";
import type { ApprovalScope } from "./session-render";
import {
  Composer,
  RunBoundsConfirmation,
  type RunBoundsPreview,
} from "./session-composer";
import {
  SessionHeader,
  SessionEmpty,
  type ProjectEntry,
} from "./session-header";
import { SessionRail } from "./session-rail";
import { SessionStatusBar } from "./session-statusbar";
import { SessionListSidebar } from "./session-sidebar";
import { SessionStream } from "./session-stream";
import { NewTaskOverlay } from "./session-new-task";
import { ProjectPicker } from "./ProjectPicker";
import { FlightRecorder } from "./flight-recorder";

import {
  PlanDecisionOverlay,
  type TaskPlanDetail,
} from "./session-plan";

export function initialTaskContext(defaultKey: string): {
  env: "project" | "lobby";
  project: string;
} {
  return defaultKey === "lobby"
    ? { env: "lobby", project: "" }
    : { env: "project", project: defaultKey };
}

/** SSE 事件记录（后端 RecordedEvent 的会话内形态） */
export type SessionEvent = RecordedEvent;

export function SessionApp(props: { initialSessionId?: string }) {
  const { initialSessionId } = props;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [currentProject, setCurrentProject] = useState("");
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [message, setMessage] = useState("");
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("normal");
  /** 新建会话的执行环境：项目 or 大厅（不操作文件） */
  const [newTaskEnv, setNewTaskEnv] = useState<"project" | "lobby">("project");
  /** 新建会话所选项目 key（项目环境下） */
  const [newTaskProject, setNewTaskProject] = useState("");
  /** 详情抽屉（任务清单/消耗/会话信息）是否打开 */
  const [showDetail, setShowDetail] = useState(false);
  /** 会话视图标签：对话 | 轨迹（任务可观测，默认展示标签栏）；实验会话额外有对比 */
  const [sessionView, setSessionView] = useState<"conversation" | "trace" | "compare">("conversation");
  /** 移动端侧栏抽屉开合（≤768px 生效） */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** 桌面端左侧栏折叠为图标栏（记忆在 localStorage） */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("myagent.sidebarCollapsed") === "1",
  );
  // 项目选择器（目录浏览 + 打开项目）：打开成功后切换到目标项目视图
  const projectPicker = useProjectPicker({
    onOpened: (project: OpenedProject) => {
      setSelectedId("");
      setSessions([]);
      setSessionsLoaded(false);
      setEvents([]);
      setCurrentProject(project.key);
      // 新建面板可能正打开着：同步面板内执行环境，避免下拉停留在旧项目
      setNewTaskEnv("project");
      setNewTaskProject(project.key);
      // 打开后立即拉取该项目的会话列表（值不变时 useEffect 不会触发）
      void refreshSessions();
      // 刷新项目列表（把新项目并入切换器）
      void (async () => {
        const projectsResponse = await fetch("/api/projects");
        const projectsPayload = await projectsResponse.json();
        setProjects((projectsPayload.projects ?? []) as ProjectEntry[]);
      })();
    },
  });
  const [submitting, setSubmitting] = useState(false);
  const [resolvedPermissions, setResolvedPermissions] =
    useState<Set<string>>(new Set());
  /** 正在提交审批的 callId（按钮 loading 态） */
  const [pendingPermissionCallId, setPendingPermissionCallId] =
    useState<string | null>(null);
  const [pendingClarificationId, setPendingClarificationId] =
    useState<string | null>(null);
  const [permissionFeedback, setPermissionFeedback] =
    useState<Record<string, string>>({});
  const [error, setError] = useState("");
  /** 来源筛选（Trajectory 按来源分组）：全部/推理/工具/子代理/系统；消息始终显示 */
  const [sourceFilter, setSourceFilter] = useState("all");
  /** 缓存 miss 提示开关（behavior.showCacheMissNotices；默认关，参照 Pi） */
  const [showCacheMissNotices, setShowCacheMissNotices] =
    useState(false);
  const [runBoundsPreview, setRunBoundsPreview] =
    useState<RunBoundsPreview | null>(null);
  /** 无人值守任务模式：提交自动加 /run 前缀（任务边界确认链路） */
  const [runMode, setRunMode] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"project" | "isolated">("project");
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [delivery, setDelivery] = useState<DeliveryWorkbenchData | undefined>();
  /** 可选的人在闭环规划门：关闭时保留原有直接执行语义。 */
  const [planMode, setPlanMode] = useState(false);
  const [planDetail, setPlanDetail] = useState<TaskPlanDetail | null>(null);
  const [planFeedback, setPlanFeedback] = useState("");
  const [planSubmitting, setPlanSubmitting] = useState(false);
  const chatStreamRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const previousStatuses = useRef<Record<string, SessionStatus>>({});
  const appliedInitialSessionId = useRef<string | undefined>(undefined);
  const seenSeqs = useRef<Set<number>>(new Set());
  /** 刚完成会话的标题提醒（用户查看后清除） */
  const justCompleted = useRef<{ id: string; title: string } | null>(null);

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId),
    [sessions, selectedId],
  );
  const waitingUser = selected?.status === "waiting_user";
  // running 表示"真的在跑"；等待审批/等待用户时任务暂停，不显示中止按钮，但输入框仍按排队语义处理
  const running = selected?.status === "running";
  const busy =
    running ||
    selected?.status === "waiting_permission" ||
    waitingUser;
  const visibleEvents = events;
  const displayItems = useMemo(
    () => buildDisplayItems(visibleEvents),
    [visibleEvents],
  );
  // Trajectory 来源筛选：只保留目标来源的事件（消息始终保留作上下文）
  const filteredDisplayItems = useMemo(() => {
    if (sourceFilter === "all") return displayItems;
    return displayItems.filter((item) => {
      if (item.kind === "message") return true;
      if (sourceFilter === "thinking") return item.kind === "thinking";
      if (sourceFilter === "tool") {
        return item.kind === "tool" || item.kind === "approval";
      }
      if (sourceFilter === "subtask") return item.kind === "subtask";
      return (
        item.kind === "system" ||
        item.kind === "clarification" ||
        item.kind === "cost" ||
        item.kind === "ledger"
      );
    });
  }, [displayItems, sourceFilter]);
  const latestTodos = useMemo(() => {
    const update = [...visibleEvents]
      .reverse()
      .find((record) => record.event.type === "todo_update");
    if (!update || update.event.type !== "todo_update") {
      return selected?.todos ?? [];
    }
    return update.event.todos ?? selected?.todos ?? [];
  }, [visibleEvents, selected]);

  /** 右栏「文件改动」面板：从 Edit/Write/MultiEdit 工具结果汇总（同路径合并累计增删行） */
  const fileChanges = useMemo(() => {
    const byPath = new Map<string, { added: number; removed: number }>();
    for (const item of displayItems) {
      if (item.kind !== "tool") continue;
      const tool = String(item.call.tool ?? "");
      if (!["Edit", "Write", "MultiEdit"].includes(tool)) continue;
      const path = String(item.call.target ?? "");
      if (!path) continue;
      const text = toolResultDiffText(item.result);
      let added = 0;
      let removed = 0;
      if (text) {
        for (const line of text.split("\n")) {
          if (line.startsWith("+++") || line.startsWith("---")) continue;
          if (line.startsWith("+")) added += 1;
          else if (line.startsWith("-")) removed += 1;
        }
      }
      const entry = byPath.get(path) ?? { added: 0, removed: 0 };
      entry.added += added;
      entry.removed += removed;
      byPath.set(path, entry);
    }
    return [...byPath.entries()].map(([path, stat]) => ({
      path,
      added: stat.added,
      removed: stat.removed,
    }));
  }, [displayItems]);

  async function refreshSessions() {
    const response = await fetch(projectUrl("/api/sessions"));
    if (!response.ok) return;
    const payload = await response.json();
    setSessions((payload.sessions ?? []) as SessionSummary[]);
    // 首次拉取成功后才把空列表认定为"确实没有会话"（此前显示加载态）
    setSessionsLoaded(true);
  }

  async function loadPlan(sessionId: string) {
    const response = await fetch(
      projectUrl(`/api/sessions/${sessionId}/plan`),
    );
    if (!response.ok) return;
    const payload = await response.json() as { plan?: TaskPlanDetail | null };
    if (payload.plan?.status === "awaiting_approval") {
      setPlanDetail(payload.plan);
      setPlanFeedback(payload.plan.feedback ?? "");
    }
  }

  // 记忆面板 / 地址栏直达：#sessions/<id>
  useEffect(() => {
    if (!sessionsLoaded || !initialSessionId) return;
    if (appliedInitialSessionId.current === initialSessionId) return;
    if (sessions.some((session) => session.id === initialSessionId)) {
      setSelectedId(initialSessionId);
      appliedInitialSessionId.current = initialSessionId;
    }
  }, [sessionsLoaded, sessions, initialSessionId]);

  useEffect(() => {
    const current = window.location.hash.slice(1);
    if (
      current === "settings" ||
      current === "memory" ||
      current === "plugins" ||
      current === "scheduled" ||
      current === "stats"
    ) {
      return;
    }
    const next = selectedId ? `sessions/${selectedId}` : "sessions";
    if (current !== next) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#${next}`,
      );
    }
  }, [selectedId]);

  useEffect(() => {
    if (!selected || selected.status !== "waiting_plan") {
      setPlanDetail(null);
      setPlanFeedback("");
      return;
    }
    void loadPlan(selected.id);
  }, [selected?.id, selected?.status, selected?.plan?.revision, currentProject]);

  async function deleteSession(id: string) {
    const response = await fetch(
      projectUrl(`/api/sessions/${id}`),
      {
        method: "DELETE",
      },
    );
    if (!response.ok) return;
    if (selectedId === id) setSelectedId("");
    await refreshSessions();
  }

  function projectUrl(path: string, key?: string): string {
    const joiner = path.includes("?") ? "&" : "?";
    return `${path}${joiner}project=${encodeURIComponent(key ?? currentProject)}`;
  }

  function exportSession(sessionId: string) {
    const anchor = document.createElement("a");
    anchor.href = projectUrl(`/api/sessions/${sessionId}/export`);
    anchor.download = `myagent-${sessionId}.html`;
    anchor.click();
  }

  useEffect(() => {
    void refreshSessions();
    const timer = window.setInterval(
      () => void refreshSessions(),
      1500,
    );
    return () => window.clearInterval(timer);
  }, [currentProject]);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/projects");
      if (!response.ok) return;
      const payload = await response.json();
      setProjects((payload.projects ?? []) as ProjectEntry[]);
      const defaultKey = payload.defaultKey ?? "";
      if (!defaultKey) return;
      const taskContext = initialTaskContext(defaultKey);
      setCurrentProject((current) => current || defaultKey);
      setNewTaskProject((current) => current || taskContext.project);
      if (taskContext.env === "lobby") setNewTaskEnv("lobby");
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/config/effective");
      if (!response.ok) return;
      const payload = await response.json();
      setShowCacheMissNotices(
        (payload.config as { behavior?: { showCacheMissNotices?: boolean } })
          ?.behavior?.showCacheMissNotices === true,
      );
    })();
  }, []);

  function switchProject(key: string) {
    setCurrentProject(key);
    setSelectedId("");
    setSessions([]);
    setSessionsLoaded(false);
    setEvents([]);
    setNewTaskEnv(key === "lobby" ? "lobby" : "project");
    setNewTaskProject(key === "lobby" ? "" : key);
    if (key === "lobby") setWorkspaceMode("project");
  }

  /** 准备新任务首页状态：初始化执行环境（当前项目 or 大厅）。 */
  function openNewTask() {
    setSelectedId("");
    setNewTaskEnv(currentProject === "lobby" ? "lobby" : "project");
    setNewTaskProject(currentProject === "lobby" ? "" : currentProject);
    setWorkspaceMode("project");
  }

  // 标题统一在此设置：等待审批 > 刚完成提醒 > 当前会话 > 默认
  useEffect(() => {
    const waiting = sessions.filter(
      (session) =>
        session.status === "waiting_permission" ||
        session.status === "waiting_plan" ||
        session.status === "waiting_user",
    ).length;
    for (const session of sessions) {
      const previous = previousStatuses.current[session.id];
      if (
        previous &&
        previous !== session.status &&
        session.status === "done" &&
        session.id !== selectedId
      ) {
        justCompleted.current = { id: session.id, title: session.title };
      }
      previousStatuses.current[session.id] = session.status;
    }
    if (justCompleted.current?.id === selectedId) {
      justCompleted.current = null;
    }
    if (waiting > 0) {
      document.title = `(${waiting}) 等待决定 · MyAgent`;
    } else if (justCompleted.current) {
      document.title = `任务完成 · ${justCompleted.current.title} · MyAgent`;
    } else if (selected) {
      document.title = `${selected.title} · MyAgent`;
    } else {
      document.title = "监控台 · MyAgent";
    }
  }, [sessions, selected, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setEvents([]);
      setWorkspaceInfo(null);
      setDelivery(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          projectUrl(`/api/sessions/${selectedId}/workspace`),
        );
        if (!response.ok) {
          if (!cancelled) setWorkspaceInfo(null);
          return;
        }
        const payload = await response.json() as {
          workspace?: WorkspaceInfo | null;
        };
        if (!cancelled) setWorkspaceInfo(payload.workspace ?? null);
      } catch {
        if (!cancelled) setWorkspaceInfo(null);
      }
    })();
    const refreshDelivery = async () => {
      try {
        const response = await fetch(projectUrl(`/api/sessions/${selectedId}/delivery`));
        if (!response.ok) {
          if (!cancelled) setDelivery(undefined);
          return;
        }
        const payload = await response.json() as { delivery?: DeliveryWorkbenchData; workspace?: WorkspaceInfo };
        if (!cancelled) {
          setDelivery(payload.delivery);
          if (payload.workspace) setWorkspaceInfo(payload.workspace);
        }
      } catch {
        if (!cancelled) setDelivery(undefined);
      }
    };
    void refreshDelivery();
    setEvents([]);
    setResolvedPermissions(new Set());
    seenSeqs.current = new Set();
    const source = new EventSource(
      projectUrl(`/api/sessions/${selectedId}/stream`),
    );
    source.onmessage = (messageEvent) => {
      const record = JSON.parse(
        messageEvent.data,
      ) as SessionEvent;
      if (seenSeqs.current.has(record.seq)) return;
      seenSeqs.current.add(record.seq);
      setEvents((current) => [...current, record]);
      if (["run_finished", "done", "error", "interrupted", "acceptance_result", "review_result"].includes(record.event.type)) {
        void refreshDelivery();
      }
      if (record.event.type === "plan_proposed") {
        void loadPlan(selectedId);
        void refreshSessions();
      }
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setError("实时事件连接已关闭，请刷新页面重试。");
      }
    };
    return () => {
      cancelled = true;
      source.close();
    };
  }, [selectedId]);

  useEffect(() => {
    const stream = chatStreamRef.current;
    if (!stream) return;
    if (waitingUser) {
      const clarifications = stream.querySelectorAll<HTMLElement>(
        '[data-display-kind="clarification"]',
      );
      const clarification = clarifications.item(clarifications.length - 1);
      if (clarification) {
        stream.scrollTop = Math.max(0, clarification.offsetTop - 12);
        return;
      }
    }
    stream.scrollTop = stream.scrollHeight;
  }, [selectedId, events.length, waitingUser]);

  function updateMessage(value: string) {
    setMessage(value);
    setRunBoundsPreview(null);
  }

  async function submitMessage(boundsConfirmed = false, steer = false) {
    let content = message.trim();
    if (!content) return;
    // 无人值守任务模式：自动加 /run 前缀（用户已手动输入时不再重复）
    if (runMode && !waitingUser && !content.startsWith("/run")) {
      content = `/run ${content}`;
    }
    setSubmitting(true);
    setError("");
    try {
      let confirmBounds = false;
      if (content.startsWith("/run")) {
        const previewResponse = await fetch("/api/run/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: content }),
        });
        const preview = await previewResponse.json();
        if (!previewResponse.ok) {
          throw new Error(preview.error ?? "/run 参数无效");
        }
        const hardRules = preview.task?.hardRules ?? [];
        const semanticBounds =
          preview.task?.semanticBounds ?? [];
        const checks = preview.task?.checks ?? [];
        if ((hardRules.length > 0 || checks.length > 0) && !boundsConfirmed) {
          setRunBoundsPreview({
            hardRules,
            semanticBounds,
            checks,
            ...(preview.task?.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: preview.task.checkTimeoutMs }),
          });
          return;
        }
        confirmBounds = boundsConfirmed;
      }
      // 新建会话：按执行环境确定目标项目（大厅 → lobby，项目 → 所选项目）
      const targetKey = selectedId
        ? currentProject
        : newTaskEnv === "lobby"
          ? "lobby"
          : newTaskProject || currentProject;
      const response = await fetch(
        selectedId
          ? projectUrl(`/api/sessions/${selectedId}/input`)
          : projectUrl("/api/sessions", targetKey),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            selectedId
              ? {
                  message: content,
                  confirmBounds,
                  ...(planMode && !waitingUser ? { planMode: true } : {}),
                  ...(steer && busy && !waitingUser ? { steer: true } : {}),
                }
              : {
                  task: content,
                  permissionMode,
                  confirmBounds,
                  ...(planMode ? { planMode: true } : {}),
                  workspaceMode,
                },
          ),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "发送失败");
      }
      if (!selectedId) {
        // 切到目标项目（如果与当前不同），使会话列表归属正确
        if (targetKey !== currentProject) {
          setCurrentProject(targetKey);
          setSessions([]);
          setEvents([]);
        }
        setSelectedId(payload.session.id);
      }
      setMessage("");
      setRunBoundsPreview(null);
      await refreshSessions();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "发送失败",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function answerPermission(
    callId: string,
    granted: boolean,
    scope: ApprovalScope = "once",
    feedback?: string,
  ) {
    setPendingPermissionCallId(callId);
    try {
      const response = await fetch(
        projectUrl(`/api/sessions/${selectedId}/permission`),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callId,
            granted,
            scope,
            ...(feedback?.trim()
              ? { feedback: feedback.trim() }
              : {}),
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "审批失败");
        return;
      }
      setResolvedPermissions(
        (current) => new Set([...current, callId]),
      );
      await refreshSessions();
    } finally {
      setPendingPermissionCallId(null);
    }
  }

  async function answerClarification(
    questionId: string,
    answer: string,
    optionId?: string,
  ) {
    if (!selectedId || !answer.trim()) return;
    setPendingClarificationId(questionId);
    setError("");
    try {
      const response = await fetch(
        projectUrl(`/api/sessions/${selectedId}/answer`),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            questionId,
            answer: answer.trim(),
            ...(optionId ? { optionId } : {}),
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "提交答案失败");
      await refreshSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交答案失败");
    } finally {
      setPendingClarificationId(null);
    }
  }

  async function decidePlan(
    decision: "approved" | "revision_requested" | "analysis_only",
    feedback?: string,
  ) {
    if (!selectedId) return;
    setPlanSubmitting(true);
    setError("");
    try {
      const response = await fetch(
        projectUrl(`/api/sessions/${selectedId}/plan/decision`),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision,
            ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "计划决策失败");
      }
      setPlanDetail(null);
      setPlanFeedback("");
      await refreshSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "计划决策失败");
    } finally {
      setPlanSubmitting(false);
    }
  }

  async function interrupt() {
    const response = await fetch(
      projectUrl(`/api/sessions/${selectedId}/interrupt`),
      { method: "POST" },
    );
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "中止失败");
    }
    await refreshSessions();
  }

  async function resumeInterrupted() {
    const response = await fetch(
      projectUrl(`/api/sessions/${selectedId}/resume`),
      { method: "POST" },
    );
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "续跑失败");
    }
    await refreshSessions();
  }

  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (showDetail) {
        setShowDetail(false);
        return;
      }
      if (busy) void interrupt();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, busy, showDetail]);

  function startNewSession() {
    setSelectedId("");
    setSessionView("conversation");
    setMessage("");
    setRunBoundsPreview(null);
    openNewTask();
  }

  return (
    <div className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <SessionListSidebar
        sessions={sessions}
        sessionsLoaded={sessionsLoaded}
        selectedId={selectedId}
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() =>
          setSidebarCollapsed((v) => {
            window.localStorage.setItem("myagent.sidebarCollapsed", v ? "0" : "1");
            return !v;
          })
        }
        currentProject={currentProject}
        projects={projects}
        onSwitchProject={switchProject}
        onSelect={(id) => {
          setSelectedId(id);
          setSessionView("conversation");
          // 移动端：选中会话后收起抽屉
          setSidebarOpen(false);
        }}
        onNew={startNewSession}
      />

      <main className="sessions-main">
        {/* 移动端侧栏抽屉开关：无条件渲染（未选中会话时也要能打开列表） */}
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarOpen(true)}
          title="会话列表"
          aria-label="打开会话列表"
        >
          ☰
        </button>
        {selected ? (
          <>
            <SessionHeader
              selected={selected}
              busy={running}
              onInterrupt={() => void interrupt()}
              onResume={() => void resumeInterrupted()}
            />

            {error && (
              <div className="notice error">{error}</div>
            )}

            <FlightRecorder
              session={selected}
              project={currentProject}
              view={sessionView}
              onViewChange={setSessionView}
              onSelectSession={(id) => {
                setSelectedId(id);
                setSessionView("conversation");
                void refreshSessions();
              }}
              traceActions={
                <>
                  <button
                    className={`detail-toggle ${showDetail ? "active" : ""}`}
                    onClick={() => {
                      setSessionView("conversation");
                      setShowDetail(true);
                    }}
                  >
                    任务详情
                  </button>
                  <button
                    className="detail-toggle"
                    onClick={() => exportSession(selected.id)}
                  >
                    导出
                  </button>
                  <button
                    className="detail-toggle danger"
                    onClick={() => {
                      if (
                        window.confirm(
                          `确认删除会话「${selected.title}」？该操作不可恢复。`,
                        )
                      ) {
                        void deleteSession(selected.id);
                      }
                    }}
                  >
                    删除
                  </button>
                </>
              }
              conversation={
              <div className="session-workspace">
                <section className="chat-column">
                {workspaceInfo && <WorkspaceBanner workspace={workspaceInfo} />}
                {selected.status === "done" &&
                  selected.kind === "run" &&
                  selected.toolCallCount === 0 && (
                    <div className="rail-todo-warning" role="alert">
                      Agent 未调用任何工具就宣布完成——若这是编码/搭建任务，
                      结果可能不完整，请检查或让 Agent 重新执行
                    </div>
                  )}
                {selected.status === "done" &&
                  latestTodos.some((todo) => todo.status !== "completed") && (
                    <div className="rail-todo-warning" role="alert">
                      Agent 已宣布完成，但仍有{" "}
                      {latestTodos.filter((todo) => todo.status !== "completed").length}{" "}
                      项任务未完成或未更新
                    </div>
                  )}
                <SessionStatusBar
                  latestTodos={latestTodos}
                  fileChanges={fileChanges}
                  selected={selected}
                  onOpen={() => setShowDetail(true)}
                />
                <SessionStream
                  displayItems={filteredDisplayItems}
                  totalEvents={events.length}
                  streamRef={chatStreamRef}
                  showCacheMissNotices={showCacheMissNotices}
                  compact
                  resolvedPermissions={resolvedPermissions}
                  pendingPermissionCallId={pendingPermissionCallId}
                  pendingClarificationId={pendingClarificationId}
                  permissionFeedback={permissionFeedback}
                  onFeedback={(callId, value) =>
                    setPermissionFeedback((current) => ({
                      ...current,
                      [callId]: value,
                    }))
                  }
                  onPermission={answerPermission}
                  onClarification={answerClarification}
                  sourceFilter={sourceFilter}
                  onSourceFilter={setSourceFilter}
                  delivery={delivery}
                  workspace={workspaceInfo ?? undefined}
                  onContinue={() => {
                    composerRef.current?.focus();
                  }}
                  onCopyPath={() => {
                    const path = workspaceInfo?.path;
                    if (!path) return;
                    if (!navigator.clipboard) {
                      setError("浏览器不支持复制，请手动选择隔离路径");
                      return;
                    }
                    void navigator.clipboard.writeText(path).catch(() =>
                      setError("复制隔离路径失败，请手动复制"),
                    );
                  }}
                  onExport={() => exportSession(selected.id)}
                />
                <>
                  {runBoundsPreview && (
                    <RunBoundsConfirmation
                      preview={runBoundsPreview}
                      submitting={submitting}
                      onConfirm={() => void submitMessage(true)}
                      onCancel={() => setRunBoundsPreview(null)}
                    />
                  )}
                  <Composer
                      textareaRef={composerRef}
                      message={message}
                      setMessage={updateMessage}
                      busy={busy}
                      waitingUser={waitingUser}
                      submitting={submitting}
                      selected
                      runMode={runMode}
                      onRunModeChange={setRunMode}
                      planMode={planMode}
                      onPlanModeChange={setPlanMode}
                      showModes={false}
                      onSubmit={submitMessage}
                    />
                </>
              </section>

              {showDetail && sessionView === "conversation" && (
                <>
                  <div className="rail-drawer-mask" onClick={() => setShowDetail(false)} />
                  <div className="rail-drawer" role="dialog" aria-label="任务详情">
                    <div className="rail-drawer-head">
                      <span>详情</span>
                      <button
                        type="button"
                        className="rail-drawer-close"
                        aria-label="关闭详情"
                        onClick={() => setShowDetail(false)}
                      >✕</button>
                    </div>
                    <SessionRail
                      latestTodos={latestTodos}
                      selected={selected}
                      showDetail
                      fileChanges={fileChanges}
                    />
                  </div>
                </>
              )}
            </div>
              }
            />
          </>
        ) : (
          <SessionEmpty
            error={error}
            newTaskComposer={
              <NewTaskOverlay
                presentation="home"
                newTaskEnv={newTaskEnv}
                newTaskProject={newTaskProject}
                projects={projects}
                permissionMode={permissionMode}
                runBoundsPreview={runBoundsPreview}
                submitting={submitting}
                message={message}
                runMode={runMode}
                workspaceMode={workspaceMode}
                onWorkspaceModeChange={setWorkspaceMode}
                onRunModeChange={setRunMode}
                planMode={planMode}
                onPlanModeChange={setPlanMode}
                onEnvChange={(env) => {
                  setNewTaskEnv(env);
                  if (env === "lobby") setWorkspaceMode("project");
                }}
                onProjectChange={setNewTaskProject}
                onPermissionMode={setPermissionMode}
                onMessage={updateMessage}
                onSubmit={submitMessage}
                onOpenProjectPicker={() => void projectPicker.openProjectPicker()}
                onClose={() => undefined}
                onCancelBounds={() => setRunBoundsPreview(null)}
              />
            }
          />
        )}
            {planDetail && (
              <PlanDecisionOverlay
                plan={planDetail}
                feedback={planFeedback}
                submitting={planSubmitting}
                onFeedback={setPlanFeedback}
                onDecision={decidePlan}
              />
            )}
            {projectPicker.showProjectPicker && (
              <ProjectPicker
                roots={projectPicker.fsRoots}
                path={projectPicker.fsPath}
                entries={projectPicker.fsEntries}
                error={projectPicker.fsError}
                opening={projectPicker.fsOpening}
                onNavigate={(dir) => void projectPicker.loadFsDirectory(dir)}
                onOpen={() => void projectPicker.confirmOpenProject(projectPicker.fsPath)}
                onClose={projectPicker.closeProjectPicker}
              />
            )}
      </main>
    </div>
  );
}

export function WorkspaceBanner({ workspace }: { workspace: WorkspaceInfo }) {
  // 路径已失效：交付详情里有说明，对话流不再展示残留提示
  if (!workspace.exists) return null;
  return (
    <section
      className="workspace-banner"
      aria-label="隔离工作区"
    >
      <strong>隔离工作区</strong>
      <span className="workspace-banner-path" title={workspace.path}>
        原项目未自动修改 · 独立 worktree：<code>{workspace.path}</code>
      </span>
      {workspace.head && <span>HEAD <code>{workspace.head.slice(0, 12)}</code></span>}
      {(workspace.warnings ?? []).length > 0 && (
        <span>快照提示：{(workspace.warnings ?? []).join("；")}</span>
      )}
      <small>不会自动合并、commit 或 push。</small>
    </section>
  );
}

// 兼容既有测试引用：这些组件原定义于本文件，现移入独立模块，经此处 re-export
export { SessionListSidebar } from "./session-sidebar";
