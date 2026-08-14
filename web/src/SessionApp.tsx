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
} from "@shared/types.js";
import { useProjectPicker, type OpenedProject } from "./use-project-picker";
import { buildDisplayItems } from "./session-display";
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
  const [replay, setReplay] = useState(false);
  const [replayCursor, setReplayCursor] = useState(0);
  /** Trajectory 式回放：自动播放（⏸ 暂停）与速度倍率（1/2/4/8x） */
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  /** 来源筛选（Trajectory 按来源分组）：全部/推理/工具/子代理/系统；消息始终显示 */
  const [sourceFilter, setSourceFilter] = useState("all");
  /** 缓存 miss 提示开关（behavior.showCacheMissNotices；默认关，参照 Pi） */
  const [showCacheMissNotices, setShowCacheMissNotices] =
    useState(false);
  const [runBoundsPreview, setRunBoundsPreview] =
    useState<RunBoundsPreview | null>(null);
  /** 无人值守任务模式：提交自动加 /run 前缀（任务边界确认链路） */
  const [runMode, setRunMode] = useState(false);
  const chatStreamRef = useRef<HTMLDivElement>(null);
  const previousStatuses = useRef<Record<string, SessionStatus>>({});
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
  const visibleEvents = useMemo(
    () => (replay ? events.slice(0, replayCursor) : events),
    [replay, events, replayCursor],
  );
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
  /** 自动播放推进：按速度倍率逐事件前进，播完自动停止 */
  useEffect(() => {
    if (!replay || !replayPlaying) return;
    if (replayCursor >= events.length) {
      setReplayPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      setReplayCursor((cursor) => Math.min(cursor + 1, events.length));
    }, 200 / replaySpeed);
    return () => clearTimeout(timer);
  }, [replay, replayPlaying, replayCursor, events.length, replaySpeed]);
  /** 播放/暂停：播到末尾时重新从头播放 */
  function togglePlayback() {
    if (replayCursor >= events.length) setReplayCursor(0);
    setReplayPlaying((playing) => !playing);
  }
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
  // 回放模式下清单跟随回放游标，而非会话最新状态
  const latestTodos = useMemo(() => {
    const update = [...visibleEvents]
      .reverse()
      .find((record) => record.event.type === "todo_update");
    if (!update || update.event.type !== "todo_update") {
      return selected?.todos ?? [];
    }
    return update.event.todos ?? selected?.todos ?? [];
  }, [visibleEvents, selected]);

  async function refreshSessions() {
    const response = await fetch(projectUrl("/api/sessions"));
    if (!response.ok) return;
    const payload = await response.json();
    setSessions((payload.sessions ?? []) as SessionSummary[]);
    // 首次拉取成功后才把空列表认定为"确实没有会话"（此前显示加载态）
    setSessionsLoaded(true);
  }

  // 记忆面板「打开会话」跳转：列表加载后自动选中目标会话（仅首次；找不到静默回退列表视图）
  const appliedInitialSessionRef = useRef(false);
  useEffect(() => {
    if (
      appliedInitialSessionRef.current ||
      !sessionsLoaded ||
      !initialSessionId
    ) {
      return;
    }
    appliedInitialSessionRef.current = true;
    if (sessions.some((session) => session.id === initialSessionId)) {
      setSelectedId(initialSessionId);
      setShowNewTask(false);
    }
  }, [sessionsLoaded, sessions, initialSessionId]);

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
    }
  }

  /** 打开新建会话面板：初始化执行环境（当前项目 or 大厅） */
  function openNewTask() {
    setSelectedId("");
    setNewTaskEnv(currentProject === "lobby" ? "lobby" : "project");
    setNewTaskProject(currentProject === "lobby" ? "" : currentProject);
    setShowNewTask(true);
  }

  // 标题统一在此设置：等待审批 > 刚完成提醒 > 当前会话 > 默认
  useEffect(() => {
    const waiting = sessions.filter(
      (session) => session.status === "waiting_permission",
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
      document.title = `(${waiting}) 等待审批 · MyAgent`;
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
      setReplay(false);
      return;
    }
    setEvents([]);
    setReplay(false);
    setReplayPlaying(false);
    setReplayCursor(0);
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
      // 分支切换事件实时刷新分支树（含跨端切换：CLI /branch 或 /goto）
      if (record.event.type === "branch_switch") {
        void refreshBranches();
      }
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setError("实时事件连接已关闭，请刷新页面重试。");
      }
    };
    return () => source.close();
  }, [selectedId]);

  useEffect(() => {
    if (replay) return;
    const stream = chatStreamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, [selectedId, events.length, replay]);

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
        if (hardRules.length > 0 && !boundsConfirmed) {
          setRunBoundsPreview({ hardRules, semanticBounds });
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
                  ...(steer && busy ? { steer: true } : {}),
                }
              : {
                  task: content,
                  permissionMode,
                  confirmBounds,
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
                const anchor = document.createElement("a");
                anchor.href = projectUrl(
                  `/api/sessions/${selected.id}/export`,
                );
                anchor.download = `myagent-${selected.id}.html`;
                anchor.click();
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
              onReplay={() => {
                // 进入回放从第一个事件开始（Trajectory 式回放整个过程）
                setReplay(true);
                setReplayCursor(events.length > 0 ? 1 : 0);
                setReplayPlaying(false);
              }}
            />

            {error && (
              <div className="notice error">{error}</div>
            )}

            <div className="session-workspace with-rail">
              <section className="chat-column">
                <SessionStream
                  displayItems={filteredDisplayItems}
                  totalEvents={events.length}
                  replay={replay}
                  replayCursor={replayCursor}
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
                  replayPlaying={replayPlaying}
                  replaySpeed={replaySpeed}
                  sourceFilter={sourceFilter}
                  onTogglePlayback={togglePlayback}
                  onReplaySpeed={setReplaySpeed}
                  onSourceFilter={setSourceFilter}
                  onExitReplay={() => {
                    setReplay(false);
                    setReplayPlaying(false);
                  }}
                  onReplayCursor={setReplayCursor}
                />
                {!replay && (
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
                      message={message}
                      setMessage={updateMessage}
                      busy={busy}
                      submitting={submitting}
                      selected
                      runMode={runMode}
                      onRunModeChange={setRunMode}
                      onSubmit={submitMessage}
                    />
                  </>
                )}
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
                  onRunModeChange={setRunMode}
                  onEnvChange={setNewTaskEnv}
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

// 兼容既有测试引用：这些组件原定义于本文件，现移入独立模块，经此处 re-export
export { SessionListSidebar } from "./session-sidebar";
export {
  TaskScopeTemplates,
  TASK_SCOPE_TEMPLATES,
} from "./session-composer";
