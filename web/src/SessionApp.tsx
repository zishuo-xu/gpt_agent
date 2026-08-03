import {
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type PermissionMode = "strict" | "normal" | "trust";
type ApprovalScope = "once" | "session" | "project" | "global";
type SessionStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "done"
  | "error"
  | "interrupted";

interface ProjectEntry {
  key: string;
  name: string;
  cwd: string;
}

interface FsRoot {
  name: string;
  path: string;
}

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostCny: number;
  todos: Todo[];
  toolCallCount: number;
  kind: "interactive" | "run";
}

interface SessionEvent {
  seq: number;
  ts: string;
  event: Record<string, any> & { type: string };
}

interface RunBoundsPreview {
  hardRules: Array<{ effect: "deny"; pattern: string }>;
  semanticBounds: string[];
}

interface SessionBranch {
  id: string;
  parent: string | null;
  forkSeq: number | null;
  label?: string;
  createdAt: string;
}

const statusMeta: Record<
  SessionStatus,
  { label: string; tone: string }
> = {
  idle: { label: "待开始", tone: "neutral" },
  running: { label: "运行中", tone: "running" },
  waiting_permission: { label: "等待审批", tone: "waiting" },
  done: { label: "已完成", tone: "done" },
  error: { label: "出错", tone: "error" },
  interrupted: { label: "已中止", tone: "neutral" },
};

export function SessionApp() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [currentProject, setCurrentProject] = useState("");
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [fsRoots, setFsRoots] = useState<FsRoot[]>([]);
  const [fsPath, setFsPath] = useState("");
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([]);
  const [fsError, setFsError] = useState("");
  const [fsOpening, setFsOpening] = useState(false);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [branches, setBranches] = useState<SessionBranch[]>([]);
  const [currentBranchId, setCurrentBranchId] = useState("main");
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
  const [submitting, setSubmitting] = useState(false);
  const [resolvedPermissions, setResolvedPermissions] =
    useState<Set<string>>(new Set());
  const [permissionFeedback, setPermissionFeedback] =
    useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [replay, setReplay] = useState(false);
  const [replayCursor, setReplayCursor] = useState(0);
  const [runBoundsPreview, setRunBoundsPreview] =
    useState<RunBoundsPreview | null>(null);
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
  // 对话链路：每轮用户提问的目录，点击可定位到对应消息
  const userTurns = useMemo(() => {
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
    return (update?.event.todos as Todo[] | undefined) ??
      selected?.todos ??
      [];
  }, [visibleEvents, selected]);

  async function refreshSessions() {
    const response = await fetch(projectUrl("/api/sessions"));
    if (!response.ok) return;
    const payload = await response.json();
    setSessions((payload.sessions ?? []) as SessionSummary[]);
  }

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

  function switchProject(key: string) {
    setCurrentProject(key);
    setSelectedId("");
    setSessions([]);
    setEvents([]);
  }

  /** 打开新建会话面板：初始化执行环境（当前项目 or 大厅） */
  function openNewTask() {
    setSelectedId("");
    setNewTaskEnv(currentProject === "lobby" ? "lobby" : "project");
    setNewTaskProject(currentProject === "lobby" ? "" : currentProject);
    setShowNewTask(true);
  }

  // 面板展开后聚焦输入框（模态居中，无需滚动）
  const newTaskPanelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!showNewTask) return;
    newTaskPanelRef.current?.querySelector("textarea")?.focus();
  }, [showNewTask]);

  async function openProjectPicker() {
    setFsError("");
    setShowProjectPicker(true);
    try {
      const rootsResponse = await fetch("/api/fs/roots");
      const rootsPayload = await rootsResponse.json();
      const roots = (rootsPayload.roots ?? []) as FsRoot[];
      setFsRoots(roots);
      // 从第一个根（家目录）开始浏览
      const first = roots[0];
      if (first) {
        setFsPath(first.path);
        await loadFsDirectory(first.path);
      }
    } catch {
      setFsError("无法读取目录列表");
    }
  }

  async function loadFsDirectory(dir: string) {
    setFsError("");
    setFsPath(dir);
    const response = await fetch(
      `/api/fs/list?path=${encodeURIComponent(dir)}`,
    );
    const payload = await response.json();
    if (!response.ok) {
      setFsError(payload.error ?? "读取目录失败");
      setFsEntries([]);
      return;
    }
    setFsEntries((payload.entries ?? []) as FsEntry[]);
  }

  async function confirmOpenProject(dir: string) {
    setFsOpening(true);
    setFsError("");
    try {
      const response = await fetch("/api/projects/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dir }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setFsError(payload.error ?? "无法打开项目");
        return;
      }
      const project = payload.project as ProjectEntry;
      setShowProjectPicker(false);
      setSelectedId("");
      setSessions([]);
      setEvents([]);
      setCurrentProject(project.key);
      // 打开后立即拉取该项目的会话列表（值不变时 useEffect 不会触发）
      await refreshSessions();
      // 刷新项目列表（把新项目并入切换器）
      const projectsResponse = await fetch("/api/projects");
      const projectsPayload = await projectsResponse.json();
      setProjects((projectsPayload.projects ?? []) as ProjectEntry[]);
    } catch {
      setFsError("无法打开项目");
    } finally {
      setFsOpening(false);
    }
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
    setReplayCursor(0);
    setResolvedPermissions(new Set());
    seenSeqs.current = new Set();
    void refreshBranches();
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

  async function submitMessage(boundsConfirmed = false) {
    const content = message.trim();
    if (!content) return;
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
              ? { message: content, confirmBounds }
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
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setShowNewTask(false);
        }}
        onNew={startNewSession}
      />

      <main className="sessions-main">
        {selected ? (
          <>
            <header className="page-header sessions-header">
              <div>
                <p className="eyebrow">AGENT / SESSION</p>
                <div className="title-with-status">
                  <h1>{selected.title}</h1>
                  <StatusTag status={selected.status} />
                </div>
                <p>
                  会话 #{selected.id} ·{" "}
                  {selected.kind === "run"
                    ? "无人值守"
                    : "交互会话"}{" "}
                  · {selected.permissionMode} 档
                </p>
              </div>
              <div className="header-actions">
                <select
                  className="project-switcher"
                  value={currentProject}
                  onChange={(event) => switchProject(event.target.value)}
                  title="切换项目"
                >
                  {projects.map((project) => (
                    <option value={project.key} key={project.key}>
                      {project.name}
                    </option>
                  ))}
                </select>
                {busy && (
                  <button
                    className="interrupt-button"
                    onClick={() => void interrupt()}
                  >
                    ■ 中止任务
                  </button>
                )}
                <button
                  className="secondary-button"
                  onClick={startNewSession}
                >
                  ＋ 新会话
                </button>
                <button
                  className="detail-toggle"
                  onClick={() => {
                    if (
                      window.confirm(
                        `确认删除会话「${selected.title}」？该操作不可恢复。`,
                      )
                    ) {
                      void deleteSession(selected.id);
                    }
                  }}
                  title="删除此会话"
                >
                  删除
                </button>
                <button
                  className={`detail-toggle ${showDetail ? "active" : ""}`}
                  onClick={() => setShowDetail((v) => !v)}
                  title="任务清单 / 消耗 / 会话信息"
                >
                  ⤢ {showDetail ? "收起详情" : "详情"}
                </button>
              </div>
            </header>

            {error && (
              <div className="notice error">{error}</div>
            )}

            <div className="session-workspace with-rail">
              <section className="chat-column">
                {replay && (
                  <div className="replay-bar">
                    <span>回放模式</span>
                    <input
                      type="range"
                      min={1}
                      max={Math.max(1, events.length)}
                      value={Math.max(1, replayCursor)}
                      onChange={(event) =>
                        setReplayCursor(
                          Number(event.target.value),
                        )
                      }
                    />
                    <code>
                      {Math.min(replayCursor, events.length)} /{" "}
                      {events.length}
                    </code>
                    <button onClick={() => setReplay(false)}>
                      退出
                    </button>
                  </div>
                )}
                <div
                  className="chat-stream"
                  ref={chatStreamRef}
                >
                  {events.length === 0 && (
                    <div className="chat-waiting">
                      正在连接会话事件流…
                    </div>
                  )}
                  {displayItems.map((item) => (
                    <div
                      className="stream-item"
                      data-seq={item.seq}
                      key={item.seq}
                    >
                      <ItemCard
                        item={item}
                        locallyResolved={resolvedPermissions}
                        feedback={
                          item.kind === "approval"
                            ? (permissionFeedback[
                                String(item.event.call.id)
                              ] ?? "")
                            : ""
                        }
                        onFeedback={(callId, value) =>
                          setPermissionFeedback((current) => ({
                            ...current,
                            [callId]: value,
                          }))
                        }
                        onPermission={answerPermission}
                      />
                    </div>
                  ))}
                </div>
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
                      onSubmit={submitMessage}
                    />
                  </>
                )}
              </section>

              <aside className="session-rail">
                <RailCard title="分支树">
                  {branches.length === 0 ? (
                    <p className="rail-empty">
                      fork 后可在此回溯切换分支。
                    </p>
                  ) : (
                    <BranchTree
                      branches={branches}
                      currentBranchId={currentBranchId}
                      busy={busy}
                      onSwitch={(branchId) =>
                        void switchBranch(branchId)
                      }
                    />
                  )}
                </RailCard>
                <RailCard title="对话链路">
                  {userTurns.length === 0 ? (
                    <p className="rail-empty">
                      发送消息后，这里会列出每轮提问，点击可跳转。
                    </p>
                  ) : (
                    <div className="chain-list">
                      {userTurns.map((turn) => (
                        <button
                          className="chain-item"
                          key={turn.seq}
                          onClick={() => scrollToSeq(turn.seq)}
                          title={turn.text}
                        >
                          <span className="chain-index">
                            {turn.turn}
                          </span>
                          <span className="chain-text">
                            {turn.text}
                          </span>
                          <time>{formatTime(turn.ts)}</time>
                        </button>
                      ))}
                    </div>
                  )}
                </RailCard>
                {showDetail && (
                  <>
                <RailCard title="任务清单">
                  {latestTodos.length === 0 ? (
                    <p className="rail-empty">
                      Agent 建立 todo 后会显示在这里。
                    </p>
                  ) : (
                    latestTodos.map((todo) => (
                      <div
                        className={`rail-todo ${todo.status}`}
                        key={todo.id}
                      >
                        <span className="todo-check">
                          {todo.status === "completed"
                            ? "✓"
                            : ""}
                        </span>
                        <span>{todo.content}</span>
                      </div>
                    ))
                  )}
                </RailCard>
                <RailCard title="消耗">
                  <KeyValue
                    label="本会话累计"
                    tone="kv-total"
                    value={`${formatTokens(
                      selected.totalInputTokens +
                        selected.totalOutputTokens,
                    )} tokens`}
                  />
                  <KeyValue
                    label="输入 / 输出"
                    tone="kv-io"
                    value={`${formatTokens(
                      selected.totalInputTokens,
                    )} / ${formatTokens(
                      selected.totalOutputTokens,
                    )}`}
                  />
                  <KeyValue
                    label="缓存命中"
                    tone="kv-cache"
                    value={`${formatTokens(
                      selected.totalCachedTokens,
                    )} tokens`}
                  />
                  <KeyValue
                    label="估算费用"
                    value={
                      selected.totalCostCny > 0
                        ? `¥${selected.totalCostCny.toFixed(4)}`
                        : "未配置单价"
                    }
                  />
                </RailCard>
                <RailCard title="会话">
                  <KeyValue
                    label="权限档"
                    value={selected.permissionMode}
                  />
                  <KeyValue
                    label="状态"
                    value={statusMeta[selected.status].label}
                  />
                  <KeyValue
                    label="工具调用"
                    value={`${selected.toolCallCount} 次`}
                  />
                  <KeyValue
                    label="开始时间"
                    value={formatTime(selected.createdAt)}
                  />
                  <button
                    className="replay-button"
                    onClick={() => {
                      setReplay(true);
                      setReplayCursor(Math.max(1, events.length));
                    }}
                  >
                    ▶ 回放模式
                  </button>
                </RailCard>
                  </>
                )}
              </aside>
            </div>
          </>
        ) : (
          <>
            {error && (
              <div className="notice error">{error}</div>
            )}
            <div className="empty-detail">
              <div className="empty-detail-inner">
                <span className="empty-detail-mark">◆</span>
                <h2>选择一个会话，或新建</h2>
                <p>
                  左侧是会话列表；也可以在下方直接开始一个新任务。
                </p>
                <div className="empty-detail-actions">
                  <select
                    className="project-switcher"
                    value={currentProject}
                    onChange={(event) =>
                      switchProject(event.target.value)
                    }
                    title="切换项目"
                  >
                    {projects.map((project) => (
                      <option value={project.key} key={project.key}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="save-button"
                    onClick={startNewSession}
                  >
                    ＋ 新会话
                  </button>
                </div>
              </div>
            </div>
          </>
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
              <section className="new-task-panel" ref={newTaskPanelRef}>
                <button
                  type="button"
                  className="new-task-close"
                  aria-label="关闭"
                  onClick={() => setShowNewTask(false)}
                >
                  ×
                </button>
                <div>
                  <span className="new-session-mark">◆</span>
                  <div>
                    <h2>今天想让 MyAgent 做什么？</h2>
                    <p>
                      先选择执行环境；项目下可读写文件，大厅只读不修改任何文件。
                    </p>
                  </div>
                </div>
                <div className="new-task-env">
                  <label
                    className={`env-card ${newTaskEnv === "project" ? "env-card-active" : ""}`}
                  >
                    <input
                      type="radio"
                      name="new-task-env"
                      checked={newTaskEnv === "project"}
                      onChange={() => setNewTaskEnv("project")}
                    />
                    <span className="env-card-icon">📁</span>
                    <span className="env-card-title">在项目下执行</span>
                    <span className="env-card-desc">
                      可读写文件、执行命令，适合修改代码
                    </span>
                    {newTaskEnv === "project" && (
                      <span className="env-card-extra">
                        <select
                          className="env-project-select"
                          value={newTaskProject}
                          onChange={(event) =>
                            setNewTaskProject(event.target.value)
                          }
                        >
                          {projects
                            .filter((project) => project.key !== "lobby")
                            .map((project) => (
                              <option value={project.key} key={project.key}>
                                {project.name}
                              </option>
                            ))}
                        </select>
                        <button
                          type="button"
                          className="env-open-other"
                          onClick={() => void openProjectPicker()}
                        >
                          打开其他项目…
                        </button>
                      </span>
                    )}
                  </label>
                  <label
                    className={`env-card ${newTaskEnv === "lobby" ? "env-card-active" : ""}`}
                  >
                    <input
                      type="radio"
                      name="new-task-env"
                      checked={newTaskEnv === "lobby"}
                      onChange={() => setNewTaskEnv("lobby")}
                    />
                    <span className="env-card-icon">💬</span>
                    <span className="env-card-title">在大厅执行</span>
                    <span className="env-card-desc">
                      不修改任何文件，可读取你提供的文件做分析
                    </span>
                  </label>
                </div>
                <label>
                  权限档
                  <select
                    value={permissionMode}
                    onChange={(event) =>
                      setPermissionMode(
                        event.target.value as PermissionMode,
                      )
                    }
                  >
                    <option value="normal">
                      normal · 推荐
                    </option>
                    <option value="strict">
                      strict · 写操作均审批
                    </option>
                    <option value="trust">
                      trust · 无人值守
                    </option>
                  </select>
                </label>
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
                  busy={false}
                  submitting={submitting}
                  selected={false}
                  onSubmit={submitMessage}
                />
              </section>
              </div>
            )}
      </main>
    </div>
  );
}

export function SessionListSidebar(props: {
  sessions: SessionSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <aside className="sidebar session-list-sidebar">
      <div className="brand">
        <span className="brand-mark">◆</span>
        <span>MyAgent</span>
      </div>
      <button className="sidebar-new" onClick={props.onNew}>
        ＋ 新会话
      </button>
      <div className="sidebar-sessions" aria-label="会话列表">
        {props.sessions.length === 0 && (
          <div className="sidebar-empty">还没有会话</div>
        )}
        {props.sessions.map((session) => {
          const active = session.id === props.selectedId;
          const status = statusMeta[session.status];
          return (
            <button
              key={session.id}
              className={`sidebar-session ${active ? "active" : ""}`}
              onClick={() => props.onSelect(session.id)}
              title={session.title}
            >
              <span className={`session-dot tone-${status.tone}`} />
              <span className="session-line-title">{session.title}</span>
            </button>
          );
        })}
      </div>
      <div className="sidebar-foot">
        <button
          className="nav-item"
          onClick={() => {
            window.location.hash = "settings";
          }}
        >
          <span>⚙</span>设置
        </button>
        <div className="local-state">
          <span className="status-dot" />
          本机服务
          <small>{window.location.host}</small>
        </div>
      </div>
    </aside>
  );
}

function StatusTag(props: { status: SessionStatus }) {
  const meta = statusMeta[props.status];
  return (
    <span className={`session-tag ${meta.tone}`}>
      <i className="tag-dot" />
      {meta.label}
    </span>
  );
}

function Composer(props: {
  message: string;
  setMessage: (message: string) => void;
  busy: boolean;
  submitting: boolean;
  selected: boolean;
  onSubmit: () => Promise<void>;
}) {
  return (
    <div className="web-composer">
      <textarea
        value={props.message}
        onChange={(event) =>
          props.setMessage(event.target.value)
        }
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            void props.onSubmit();
          }
        }}
        placeholder={
          props.selected
            ? props.busy
              ? "发消息给 MyAgent…（自动排队，Esc 硬打断）"
              : "继续发消息给 MyAgent…"
            : "例如：检查这个项目，修复当前失败的测试"
        }
        rows={3}
      />
      <div className="composer-footer">
        <span>
          {props.busy
            ? "软打断 · 当前轮结束后自动处理"
            : "⌘/Ctrl + Enter 发送"}
        </span>
        <button
          className="save-button"
          onClick={() => void props.onSubmit()}
          disabled={
            props.submitting || !props.message.trim()
          }
        >
          {props.submitting
            ? "发送中…"
            : props.selected
              ? props.busy
                ? "排队发送"
                : "发送"
              : "启动任务"}
        </button>
      </div>
    </div>
  );
}

function RunBoundsConfirmation(props: {
  preview: RunBoundsPreview;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="run-bounds-card" aria-label="确认任务边界">
      <div className="run-bounds-heading">
        <span>!</span>
        <div>
          <strong>启动前确认任务边界</strong>
          <p>
            下列路径规则将在本次任务期间作为不可绕过的 deny
            规则。
          </p>
        </div>
      </div>
      <div className="run-bound-rules">
        {props.preview.hardRules.map((rule) => (
          <code key={rule.pattern}>deny · {rule.pattern}</code>
        ))}
      </div>
      {props.preview.semanticBounds.length > 0 && (
        <p className="semantic-bound">
          语义约束（由 Agent 遵守，无法通过路径规则完全保证）：
          {props.preview.semanticBounds.join("；")}
        </p>
      )}
      <div className="run-bounds-actions">
        <button onClick={props.onCancel}>返回修改</button>
        <button
          className="save-button"
          onClick={props.onConfirm}
          disabled={props.submitting}
        >
          {props.submitting ? "启动中…" : "确认并启动"}
        </button>
      </div>
    </section>
  );
}

type DisplayItem =
  | {
      kind: "message";
      seq: number;
      ts: string;
      author: "user" | "assistant";
      text: string;
      queued?: boolean;
      started?: boolean;
    }
  | {
      kind: "tool";
      seq: number;
      call: Record<string, any>;
      result?: Record<string, any>;
    }
  | {
      kind: "approval";
      seq: number;
      ts: string;
      event: Record<string, any>;
      resolvedByEvent: boolean;
    }
  | {
      kind: "subtask";
      seq: number;
      start: Record<string, any>;
      end?: Record<string, any>;
    }
  | { kind: "cost"; seq: number; event: Record<string, any> }
  | { kind: "system"; seq: number; text: string; tone?: string };

/**
 * 事件流 → 显示条目：单次遍历完成 delta 合并、call/result 配对、
 * 审批 resolved 判定，渲染层不再做 O(n) 回看。
 */
function buildDisplayItems(events: SessionEvent[]): DisplayItem[] {
  const toolResults = new Map<string, Record<string, any>>();
  const startedQueues = new Set<string>();
  const taskEnds = new Map<string, Record<string, any>>();
  for (const { event } of events) {
    if (event.type === "tool_result") {
      toolResults.set(String(event.callId), event);
    } else if (event.type === "permission_denied") {
      toolResults.set(String(event.call?.id), event);
    } else if (event.type === "user" && event.queueId) {
      startedQueues.add(String(event.queueId));
    } else if (event.type === "task_end") {
      taskEnds.set(String(event.taskId), event);
    }
  }

  const items: DisplayItem[] = [];
  const system = (seq: number, text: string, tone?: string) =>
    items.push({ kind: "system", seq, text, tone });

  for (let index = 0; index < events.length; index += 1) {
    const { seq, ts, event } = events[index]!;
    switch (event.type) {
      case "user":
        if (!event.queueId) {
          items.push({
            kind: "message",
            seq,
            ts,
            author: "user",
            text: String(event.text),
          });
        }
        break;
      case "user_queued":
        items.push({
          kind: "message",
          seq,
          ts,
          author: "user",
          text: String(event.text),
          queued: true,
          started: startedQueues.has(String(event.queueId)),
        });
        break;
      case "text_delta": {
        let text = String(event.text);
        while (events[index + 1]?.event.type === "text_delta") {
          index += 1;
          text += String(events[index]!.event.text);
        }
        items.push({ kind: "message", seq, ts, author: "assistant", text });
        break;
      }
      case "tool_call":
        items.push({
          kind: "tool",
          seq,
          call: event.call,
          result: toolResults.get(String(event.call.id)),
        });
        break;
      case "ask_permission":
        items.push({
          kind: "approval",
          seq,
          ts,
          event,
          resolvedByEvent: toolResults.has(String(event.call.id)),
        });
        break;
      case "task_start":
        items.push({
          kind: "subtask",
          seq,
          start: event,
          end: taskEnds.get(String(event.taskId)),
        });
        break;
      case "cost_update":
        items.push({ kind: "cost", seq, event });
        break;
      case "branch_switch":
        system(
          seq,
          `⇄ 新分支 #${event.branchId}` +
            (event.label ? `（${event.label}）` : "") +
            ` · 自事件 #${event.forkSeq} 分裂`,
        );
        break;
      case "context_compacted":
        system(seq, `上下文已压缩 · 保留 ${(event.ratio * 100).toFixed(1)}%`);
        break;
      case "model_fallback":
        system(
          seq,
          `${event.role} 模型已降级：${event.from} → ${event.to}`,
          "warning",
        );
        break;
      case "run_started":
        system(
          seq,
          `无人值守任务 #${event.taskId} 已启动 · ${event.permissionMode} 档`,
          "running",
        );
        break;
      case "wrapup_warning":
        system(seq, `任务进入 ${event.level} 阶段 · ${event.message}`, "warning");
        break;
      case "run_finished":
        system(
          seq,
          `无人值守任务 ${statusLabel(event.status)}${
            event.reason ? ` · ${event.reason}` : ""
          }`,
          "done",
        );
        break;
      case "need_user":
        system(seq, `需要你的决定：${event.question}`, "warning");
        break;
      case "done":
        system(seq, "✓ 本轮任务已完成", "done");
        break;
      case "error":
        system(seq, `运行失败：${event.message}`, "error");
        break;
      case "interrupted":
        system(seq, "任务已中止");
        break;
      case "notify":
        system(
          seq,
          String(event.message),
          event.level === "error"
            ? "error"
            : event.level === "warn"
              ? "warning"
              : undefined,
        );
        break;
      default:
        // tool_result / task_end / permission_denied 已并入对应卡片；
        // todo_update / task_event 无需展示。
        break;
    }
  }
  return items;
}

function ItemCard(props: {
  item: DisplayItem;
  locallyResolved: Set<string>;
  feedback: string;
  onFeedback: (callId: string, value: string) => void;
  onPermission: (
    callId: string,
    granted: boolean,
    scope?: ApprovalScope,
    feedback?: string,
  ) => Promise<void>;
}) {
  const { item } = props;

  if (item.kind === "message") {
    return (
      <article
        className={`web-message ${
          item.author === "user" ? "user-message" : "assistant-message"
        }${item.queued ? " queued-message" : ""}`}
      >
        <span className="message-author">
          {item.author === "user" ? "你" : "MyAgent"} · {formatTime(item.ts)}
          {item.queued && <em>{item.started ? "已处理" : "已排队"}</em>}
        </span>
        <RichText text={item.text} />
      </article>
    );
  }

  if (item.kind === "tool") {
    const { call, result } = item;
    const toolStateClass = !result
      ? "tool-running"
      : result.type === "permission_denied"
        ? "tool-denied"
        : result.isError
          ? "tool-error"
          : "tool-ok";
    return (
      <details className={`web-tool-card ${toolStateClass}`}>
        <summary>
          <span className="tool-chevron">›</span>
          <span className="tool-badge">
            {String(call.tool).toLowerCase()}
          </span>
          <code>{call.target}</code>
          <span className="tool-state">
            {!result
              ? "运行中"
              : result.type === "permission_denied"
                ? "已拒绝"
                : result.isError
                  ? "失败"
                  : "完成"}
          </span>
        </summary>
        <div className="tool-detail">
          {call.purpose && <p>目的：{call.purpose}</p>}
          {result?.summary && <p>{result.summary}</p>}
          {result?.reason && <p>{result.reason}</p>}
          {typeof result?.output === "string" && (
            <DiffOrOutput text={result.output} />
          )}
          {result?.output &&
            typeof result.output === "object" && (
              <pre className="tool-output">
                {JSON.stringify(result.output, null, 2)}
              </pre>
            )}
        </div>
      </details>
    );
  }

  if (item.kind === "approval") {
    const { event } = item;
    const callId = String(event.call.id);
    const resolved =
      item.resolvedByEvent || props.locallyResolved.has(callId);
    return (
      <section
        className={`web-approval-card ${resolved ? "resolved" : ""}`}
      >
        <div className="approval-heading">
          <strong>⚠ 审批请求</strong>
          <span>
            {event.call.tool} · {event.call.target}
          </span>
          {resolved && (
            <span className="approval-resolved-tag">已处理</span>
          )}
        </div>
        <p>{event.risk}</p>
        <DiffOrOutput text={String(event.detail || event.call.target)} />
        {!resolved && (
          <>
            <div className="approval-actions">
              <button
                className="approve-button"
                onClick={() =>
                  void props.onPermission(callId, true, "once")
                }
              >
                仅这一次
              </button>
              <button
                onClick={() =>
                  void props.onPermission(callId, true, "session")
                }
              >
                本次会话允许
              </button>
              <button
                onClick={() =>
                  void props.onPermission(callId, true, "project")
                }
              >
                本项目允许
              </button>
              <button
                onClick={() =>
                  void props.onPermission(callId, true, "global")
                }
              >
                全局允许
              </button>
              <button
                className="reject-button"
                onClick={() => void props.onPermission(callId, false)}
              >
                拒绝
              </button>
            </div>
            <div className="approval-feedback">
              <input
                value={props.feedback}
                onChange={(changeEvent) =>
                  props.onFeedback(callId, changeEvent.target.value)
                }
                placeholder="拒绝并留言，例如：别用 npm，用 pnpm"
              />
              <button
                disabled={!props.feedback.trim()}
                onClick={() =>
                  void props.onPermission(
                    callId,
                    false,
                    "once",
                    props.feedback,
                  )
                }
              >
                拒绝并留言
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  if (item.kind === "subtask") {
    const { start, end } = item;
    return (
      <details className="subtask-card">
        <summary>
          ◇ <strong>{start.description}</strong>
          <span>
            子代理 explore ·{" "}
            {end
              ? `${end.toolCalls} 次工具调用 · ${formatTokens(
                  end.inputTokens + end.outputTokens,
                )} tokens · ${statusLabel(end.status)}`
              : "运行中"}
          </span>
        </summary>
        {end?.summary && (
          <div className="subtask-body">
            <RichText text={String(end.summary)} />
          </div>
        )}
      </details>
    );
  }

  if (item.kind === "cost") {
    const { event } = item;
    const cached = Number(event.cached ?? 0);
    const input = Number(event.input ?? 0);
    const cacheRate = input > 0 ? Math.round((cached / input) * 100) : 0;
    // 缓存浪费度量（参照 Pi 的 cache-stats）：区分合法失效（压缩）与异常失效
    const missed = Number(event.missedTokens ?? 0);
    const missedLabel =
      missed <= 0
        ? ""
        : event.missedReason === "compaction"
          ? " · 缓存已重置（压缩）"
          : event.missedReason === "model_switch"
            ? ` · 缓存失效 ${formatTokens(missed)}（模型切换）`
            : event.missedReason === "idle"
              ? ` · 缓存过期 ${formatTokens(missed)}（空闲超时）`
              : ` · 缓存未命中浪费 ${formatTokens(missed)}`;
    return (
      <div className="web-cost-line">
        本轮 {formatTokens(event.input)} in / {formatTokens(event.output)}{" "}
        out · 缓存命中 {cacheRate}% · 累计 {formatTokens(event.totalTokens)}
        {missedLabel}
        {event.totalCostCny
          ? `（≈¥${Number(event.totalCostCny).toFixed(4)}）`
          : ""}
      </div>
    );
  }

  return <SystemLine tone={item.tone}>{item.text}</SystemLine>;
}

function RichText(props: { text: string }) {
  const lines = props.text.split(/\r?\n/);
  return (
    <div className="rich-text">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <br key={index} />;
        const isList = /^[-*]\s+/.test(trimmed);
        return (
          <p className={isList ? "rich-list-line" : ""} key={index}>
            {isList ? "• " : ""}
            {renderInline(
              isList ? trimmed.replace(/^[-*]\s+/, "") : line,
            )}
          </p>
        );
      })}
    </div>
  );
}

function renderInline(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((token, index) => {
    if (token.startsWith("`") && token.endsWith("`")) {
      return <code key={index}>{token.slice(1, -1)}</code>;
    }
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    return <Fragment key={index}>{token}</Fragment>;
  });
}

function DiffOrOutput(props: { text: string }) {
  const lines = props.text.split(/\r?\n/);
  // 同时存在 +/- 行（或带 diff 头）才按 diff 渲染，避免缩进文本误判
  const hasMarker = lines.some(
    (line) => line.startsWith("@@") || line.startsWith("diff --git"),
  );
  const hasAdd = lines.some((line) => line.startsWith("+"));
  const hasRemove = lines.some((line) => line.startsWith("-"));
  const isDiff = hasMarker || (hasAdd && hasRemove);
  return (
    <pre className={isDiff ? "diff-output" : "tool-output"}>
      {lines.map((line, index) => (
        <span
          className={
            line.startsWith("+")
              ? "diff-add"
              : line.startsWith("-")
                ? "diff-remove"
                : "diff-context"
          }
          key={index}
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function RailCard(props: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rail-card">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

function BranchTree(props: {
  branches: SessionBranch[];
  currentBranchId: string;
  busy: boolean;
  onSwitch: (branchId: string) => void;
}) {
  const rows: Array<{ branch: SessionBranch; depth: number }> =
    [];
  const byParent = new Map<string | null, SessionBranch[]>();
  for (const branch of props.branches) {
    const siblings = byParent.get(branch.parent) ?? [];
    siblings.push(branch);
    byParent.set(branch.parent, siblings);
  }
  const walk = (parentId: string | null, depth: number) => {
    const siblings = (byParent.get(parentId) ?? []).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (const branch of siblings) {
      rows.push({ branch, depth });
      walk(branch.id, depth + 1);
    }
  };
  walk(null, 0);
  return (
    <div className="branch-tree">
      {rows.map(({ branch, depth }) => {
        const isCurrent = branch.id === props.currentBranchId;
        const forkInfo =
          branch.forkSeq !== null ? `@#${branch.forkSeq}` : "";
        return (
          <button
            key={branch.id}
            className={`branch-node ${isCurrent ? "current" : ""}`}
            style={{ paddingLeft: 10 + depth * 16 }}
            disabled={props.busy || isCurrent}
            onClick={() => props.onSwitch(branch.id)}
            title={
              isCurrent
                ? "当前分支"
                : props.busy
                  ? "任务运行中，本轮结束后可切换"
                  : "点击切换到此分支"
            }
          >
            <span className="branch-dot">{isCurrent ? "◉" : "○"}</span>
            <span className="branch-id">#{branch.id}</span>
            {branch.label && (
              <span className="branch-label">{branch.label}</span>
            )}
            {forkInfo && (
              <span className="branch-fork">{forkInfo}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function KeyValue(props: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className={`rail-kv ${props.tone ?? ""}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function SystemLine(props: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <div
      className={`web-system-line ${
        props.tone ? `${props.tone}-line` : ""
      }`}
    >
      {props.children}
    </div>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusLabel(status: string): string {
  return (
    {
      completed: "已完成",
      failed: "失败",
      interrupted: "已中止",
    }[status] ?? status
  );
}
