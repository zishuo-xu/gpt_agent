import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  PermissionMode,
  RecordedEvent,
  SessionBranch,
  SessionStatus,
  SessionSummary,
  WorkspaceInfo,
} from "@shared/types.js";
import { useProjectPicker, type OpenedProject } from "./use-project-picker";
import { buildDisplayItems } from "./session-display";
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
import {
  SessionRail,
  type Bookmark,
  type UserTurn,
} from "./session-rail";
import { SessionListSidebar } from "./session-sidebar";
import { SessionStream } from "./session-stream";
import { NewTaskOverlay } from "./session-new-task";
import { ProjectPicker } from "./ProjectPicker";
import { FlightRecorder } from "./flight-recorder";

import {
  PlanDecisionOverlay,
  type TaskPlanDetail,
} from "./session-plan";

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
  const [branches, setBranches] = useState<SessionBranch[]>([]);
  const [currentBranchId, setCurrentBranchId] = useState("main");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [message, setMessage] = useState("");
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("normal");
  const [showNewTask, setShowNewTask] = useState(false);
  /** 新建会话的执行环境：项目 or 大厅（不操作文件） */
  const [newTaskEnv, setNewTaskEnv] = useState<"project" | "lobby">("project");
  /** 新建会话所选项目 key（项目环境下） */
  const [newTaskProject, setNewTaskProject] = useState("");
  /** 详情区右栏（任务清单/消耗/会话信息）展开/收起 */
  const [showDetail, setShowDetail] = useState(false);
  /** 移动端侧栏抽屉开合（≤768px 生效） */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // 项目选择器（目录浏览 + 打开项目）：打开成功后切换到目标项目视图
  const projectPicker = useProjectPicker({
    onOpened: (project: OpenedProject) => {
      setSelectedId("");
      setSessions([]);
      setSessionsLoaded(false);
      setEvents([]);
      setCurrentProject(project.key);
      // 新建面板可能正打开着：同步面板内执行环境，避免下拉停留在旧项目
      if (showNewTask) {
        setNewTaskEnv("project");
        setNewTaskProject(project.key);
      }
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
  const busy =
    selected?.status === "running" ||
    selected?.status === "waiting_permission";
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
        item.kind === "cost" ||
        item.kind === "ledger"
      );
    });
  }, [displayItems, sourceFilter]);
  // 对话链路：每轮用户提问的目录，点击可定位到对应消息
  const userTurns = useMemo<UserTurn[]>(() => {
    let turn = 0;
    return displayItems.flatMap((item) =>
      item.kind === "message" && item.author === "user"
        ? [
            {
              seq: item.seq,
              ts: item.ts,
              text: item.text,
              turn: (turn += 1),
            },
          ]
        : [],
    );
  }, [displayItems]);
  const latestTodos = useMemo(() => {
    const update = [...visibleEvents]
      .reverse()
      .find((record) => record.event.type === "todo_update");
    if (!update || update.event.type !== "todo_update") {
      return selected?.todos ?? [];
    }
    return update.event.todos ?? selected?.todos ?? [];
  }, [visibleEvents, selected]);

  // 存在任务清单时自动展开详情右栏（从 0 搭建场景：用户默认看到任务进度）
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    if (!autoExpandedRef.current && latestTodos.length > 0) {
      autoExpandedRef.current = true;
      setShowDetail(true);
    }
  }, [latestTodos]);

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
      setShowNewTask(false);
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

  async function refreshBranches() {
    if (!selectedId) {
      setBranches([]);
      setCurrentBranchId("main");
      return;
    }
    const response = await fetch(
      projectUrl(`/api/sessions/${selectedId}/branches`),
    );
    if (!response.ok) return;
    const payload = await response.json();
    setBranches((payload.branches ?? []) as SessionBranch[]);
    setCurrentBranchId(payload.currentBranchId ?? "main");
  }

  async function refreshBookmarks() {
    if (!selectedId) {
      setBookmarks([]);
      return;
    }
    const response = await fetch(
      projectUrl(`/api/sessions/${selectedId}/bookmarks`),
    );
    if (!response.ok) return;
    const payload = await response.json();
    setBookmarks((payload.bookmarks ?? []) as Bookmark[]);
  }

  /** 打书签：name 空串移除；成功后刷新列表 */
  async function toggleBookmark(seq: number, name: string) {
    if (!selectedId) return;
    const response = await fetch(
      projectUrl(`/api/sessions/${selectedId}/bookmarks`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seq, name }),
      },
    );
    if (response.ok) await refreshBookmarks();
  }

  /** 回溯切换分支：事件流会推送 branch_switch，树随 SSE 自动刷新 */
  async function switchBranch(branchId: string) {
    if (busy || !selectedId || branchId === currentBranchId) return;
    const response = await fetch(
      projectUrl(`/api/sessions/${selectedId}/switch-branch`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId }),
      },
    );
    if (response.ok) {
      const payload = await response.json();
      setCurrentBranchId(payload.currentBranchId ?? branchId);
    } else {
      const payload = await response.json().catch(() => null);
      setError(payload?.error ?? "切换分支失败");
    }
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
      setCurrentProject((current) => current || (payload.defaultKey ?? ""));
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
    // 新建面板打开时同步执行环境（面板是模态，正常无法同时操作，防御性同步）
    if (showNewTask) {
      setNewTaskEnv(key === "lobby" ? "lobby" : "project");
      setNewTaskProject(key === "lobby" ? "" : key);
      if (key === "lobby") setWorkspaceMode("project");
    }
  }

  /** 打开新建会话面板：初始化执行环境（当前项目 or 大厅） */
  function openNewTask() {
    setSelectedId("");
    setNewTaskEnv(currentProject === "lobby" ? "lobby" : "project");
    setNewTaskProject(currentProject === "lobby" ? "" : currentProject);
    setWorkspaceMode("project");
    setShowNewTask(true);
  }

  // 标题统一在此设置：等待审批 > 刚完成提醒 > 当前会话 > 默认
  useEffect(() => {
    const waiting = sessions.filter(
      (session) =>
        session.status === "waiting_permission" ||
        session.status === "waiting_plan",
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
    void refreshBranches();
    void refreshBookmarks();
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
      // 分支切换事件实时刷新分支树（含跨端切换：CLI /branch 或 /goto）
      if (record.event.type === "branch_switch") {
        void refreshBranches();
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
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, [selectedId, events.length]);

  /** 对话链路跳转：平滑滚动到对应 seq 的消息 */
  function scrollToSeq(seq: number) {
    const node = chatStreamRef.current?.querySelector(
      `[data-seq="${seq}"]`,
    );
    node?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function updateMessage(value: string) {
    setMessage(value);
    setRunBoundsPreview(null);
  }

  async function submitMessage(boundsConfirmed = false, steer = false) {
    let content = message.trim();
    if (!content) return;
    // 无人值守任务模式：自动加 /run 前缀（用户已手动输入时不再重复）
    if (runMode && !content.startsWith("/run")) {
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
                  ...(planMode ? { planMode: true } : {}),
                  ...(steer && busy ? { steer: true } : {}),
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
        setShowNewTask(false);
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
    if (!selectedId || !busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void interrupt();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, busy]);

  function startNewSession() {
    setSelectedId("");
    setMessage("");
    setRunBoundsPreview(null);
    openNewTask();
  }

  return (
    <div className="shell">
      <SessionListSidebar
        sessions={sessions}
        sessionsLoaded={sessionsLoaded}
        selectedId={selectedId}
        open={sidebarOpen}
        onSelect={(id) => {
          setSelectedId(id);
          setShowNewTask(false);
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
              currentProject={currentProject}
              projects={projects}
              busy={busy}
              showDetail={showDetail}
              onSwitchProject={switchProject}
              onInterrupt={() => void interrupt()}
              onResume={() => void resumeInterrupted()}
              onNew={startNewSession}
              onExport={() => {
                exportSession(selected.id);
              }}
              onDelete={() => {
                if (
                  window.confirm(
                    `确认删除会话「${selected.title}」？该操作不可恢复。`,
                  )
                ) {
                  void deleteSession(selected.id);
                }
              }}
              onToggleDetail={() => setShowDetail((v) => !v)}
            />

            {error && (
              <div className="notice error">{error}</div>
            )}

            <FlightRecorder
              session={selected}
              project={currentProject}
              onSelectSession={(id) => {
                setSelectedId(id);
                void refreshSessions();
              }}
              conversation={
              <div className="session-workspace with-rail">
              <section className="chat-column">
                {workspaceInfo && <WorkspaceBanner workspace={workspaceInfo} />}
                <SessionStream
                  displayItems={filteredDisplayItems}
                  totalEvents={events.length}
                  streamRef={chatStreamRef}
                  showCacheMissNotices={showCacheMissNotices}
                  resolvedPermissions={resolvedPermissions}
                  pendingPermissionCallId={pendingPermissionCallId}
                  permissionFeedback={permissionFeedback}
                  onFeedback={(callId, value) =>
                    setPermissionFeedback((current) => ({
                      ...current,
                      [callId]: value,
                    }))
                  }
                  onBookmark={(seq, name) =>
                    void toggleBookmark(seq, name)
                  }
                  onPermission={answerPermission}
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
                      submitting={submitting}
                      selected
                      runMode={runMode}
                      onRunModeChange={setRunMode}
                      planMode={planMode}
                      onPlanModeChange={setPlanMode}
                      onSubmit={submitMessage}
                    />
                </>
              </section>

              <SessionRail
                branches={branches}
                currentBranchId={currentBranchId}
                busy={busy}
                userTurns={userTurns}
                bookmarks={bookmarks}
                latestTodos={latestTodos}
                selected={selected}
                showDetail={showDetail}
                onSwitchBranch={(branchId) =>
                  void switchBranch(branchId)
                }
                onScrollToSeq={scrollToSeq}
                onToggleBookmark={(seq, name) =>
                  void toggleBookmark(seq, name)
                }
              />
            </div>
              }
            />
          </>
        ) : (
          <SessionEmpty
            error={error}
            currentProject={currentProject}
            projects={projects}
            onSwitchProject={switchProject}
            onNew={startNewSession}
          />
        )}
            {showNewTask && (
              <div
                className="new-task-overlay"
                onClick={(event) => {
                  if (event.target === event.currentTarget) {
                    setShowNewTask(false);
                  }
                }}
              >
                <NewTaskOverlay
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
                  onPickTemplate={setMessage}
                  onSubmit={submitMessage}
                  onOpenProjectPicker={() => void projectPicker.openProjectPicker()}
                  onClose={() => setShowNewTask(false)}
                  onCancelBounds={() => setRunBoundsPreview(null)}
                />
              </div>
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
  return (
    <section
      className={`workspace-banner${workspace.exists ? "" : " workspace-banner-missing"}`}
      aria-label="隔离工作区"
    >
      <strong>{workspace.exists ? "隔离工作区" : "隔离工作区不可用"}</strong>
      <span>
        原项目未自动修改 · 独立 worktree：<code>{workspace.path}</code>
      </span>
      {workspace.head && <span>HEAD <code>{workspace.head.slice(0, 12)}</code></span>}
      {!workspace.exists && <span>风险：隔离路径已不存在，无法继续或复现。</span>}
      {(workspace.warnings ?? []).length > 0 && (
        <span>快照提示：{(workspace.warnings ?? []).join("；")}</span>
      )}
      <small>不会自动合并、commit 或 push。</small>
    </section>
  );
}

// 兼容既有测试引用：这些组件原定义于本文件，现移入独立模块，经此处 re-export
export { SessionListSidebar } from "./session-sidebar";
export {
  TaskScopeTemplates,
  TASK_SCOPE_TEMPLATES,
} from "./session-composer";
