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
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [message, setMessage] = useState("");
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("normal");
  const [showNewTask, setShowNewTask] = useState(false);
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
  const latestTodos = useMemo(() => {
    const update = [...events]
      .reverse()
      .find((record) => record.event.type === "todo_update");
    return (update?.event.todos as Todo[] | undefined) ??
      selected?.todos ??
      [];
  }, [events, selected]);

  async function refreshSessions() {
    const response = await fetch("/api/sessions");
    if (!response.ok) return;
    const payload = await response.json();
    const next = (payload.sessions ?? []) as SessionSummary[];
    for (const session of next) {
      const previous = previousStatuses.current[session.id];
      if (
        previous &&
        previous !== session.status &&
        session.status === "done"
      ) {
        document.title = `任务完成 · ${session.title} · MyAgent`;
      }
      previousStatuses.current[session.id] = session.status;
    }
    setSessions(next);
  }

  useEffect(() => {
    void refreshSessions();
    const timer = window.setInterval(
      () => void refreshSessions(),
      1500,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const waiting = sessions.filter(
      (session) => session.status === "waiting_permission",
    ).length;
    if (waiting > 0) {
      document.title = `(${waiting}) 等待审批 · MyAgent`;
    } else if (selected) {
      document.title = `${selected.title} · MyAgent`;
    } else {
      document.title = "监控台 · MyAgent";
    }
  }, [sessions, selected]);

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
    const source = new EventSource(
      `/api/sessions/${selectedId}/stream`,
    );
    source.onmessage = (messageEvent) => {
      const record = JSON.parse(
        messageEvent.data,
      ) as SessionEvent;
      if (seenSeqs.current.has(record.seq)) return;
      seenSeqs.current.add(record.seq);
      setEvents((current) => [...current, record]);
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
      const response = await fetch(
        selectedId
          ? `/api/sessions/${selectedId}/input`
          : "/api/sessions",
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
      `/api/sessions/${selectedId}/permission`,
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
      `/api/sessions/${selectedId}/interrupt`,
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
    setShowNewTask(true);
  }

  return (
    <div className="shell">
      <AppSidebar
        active={selectedId ? "session" : "dashboard"}
        onDashboard={() => {
          setSelectedId("");
          setShowNewTask(false);
        }}
        onSession={() => {
          if (!selectedId && sessions[0]) {
            setSelectedId(sessions[0].id);
          }
        }}
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
              </div>
            </header>

            {error && (
              <div className="notice error">{error}</div>
            )}

            <div className="session-workspace">
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
                    <ItemCard
                      key={item.seq}
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
              </aside>
            </div>
          </>
        ) : (
          <>
            <header className="page-header sessions-header">
              <div>
                <p className="eyebrow">AGENT / DASHBOARD</p>
                <h1>监控台</h1>
                <p>
                  所有 Agent 会话的实时状态 · 点击卡片进入详情
                </p>
              </div>
              <button
                className="save-button"
                onClick={() =>
                  setShowNewTask((value) => !value)
                }
              >
                ＋ 新会话
              </button>
            </header>
            {error && (
              <div className="notice error">{error}</div>
            )}
            {showNewTask && (
              <section className="new-task-panel">
                <div>
                  <span className="new-session-mark">◆</span>
                  <div>
                    <h2>今天想让 MyAgent 做什么？</h2>
                    <p>
                      描述目标即可；运行中仍可继续发送消息。
                    </p>
                  </div>
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
            )}
            <section className="session-grid">
              {sessions.length === 0 && (
                <button
                  className="empty-dashboard"
                  onClick={() => setShowNewTask(true)}
                >
                  <span>◆</span>
                  <strong>还没有会话</strong>
                  <small>点击开始第一个编码任务</small>
                </button>
              )}
              {sessions.map((session) => (
                <SessionCard
                  session={session}
                  key={session.id}
                  onClick={() => setSelectedId(session.id)}
                />
              ))}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export function AppSidebar(props: {
  active: "dashboard" | "session" | "memory" | "settings";
  onDashboard: () => void;
  onSession: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">◆</span>
        <span>MyAgent</span>
      </div>
      <nav aria-label="主导航">
        <button
          className={`nav-item ${
            props.active === "dashboard" ? "active" : ""
          }`}
          onClick={props.onDashboard}
        >
          <span>▦</span>监控台
        </button>
        <button
          className={`nav-item ${
            props.active === "session" ? "active" : ""
          }`}
          onClick={props.onSession}
        >
          <span>◉</span>会话详情
        </button>
        <button
          className="nav-item"
          onClick={() => {
            window.location.hash = "memory";
          }}
        >
          <span>✎</span>记忆面板
        </button>
        <button
          className="nav-item"
          onClick={() => {
            window.location.hash = "settings";
          }}
        >
          <span>⚙</span>设置
        </button>
      </nav>
      <div className="local-state">
        <span className="status-dot" />
        本机服务
        <small>{window.location.host}</small>
      </div>
    </aside>
  );
}

function SessionCard(props: {
  session: SessionSummary;
  onClick: () => void;
}) {
  const { session } = props;
  const completed = session.todos.filter(
    (todo) => todo.status === "completed",
  ).length;
  const total = session.todos.length;
  const progress = total === 0 ? 0 : (completed / total) * 100;
  const current = session.todos.find(
    (todo) => todo.status === "in_progress",
  );
  return (
    <button
      className={`dashboard-card status-${statusMeta[session.status].tone}`}
      onClick={props.onClick}
    >
      <div className="dashboard-card-top">
        <h2>{session.title}</h2>
        <StatusTag status={session.status} />
      </div>
      <p>
        {session.kind === "run" ? "无人值守任务" : "交互会话"} ·{" "}
        {session.permissionMode} 档 · #{session.id}
      </p>
      <div className="dashboard-todo-copy">
        {total > 0
          ? `已完成 ${completed} / ${total}${
              current ? ` · 进行中：${current.content}` : ""
            }`
          : "尚未建立任务清单"}
      </div>
      <div className="progress-track">
        <i style={{ width: `${progress}%` }} />
      </div>
      <div className="dashboard-meta">
        <span>
          已运行 <b>{formatDuration(session.createdAt)}</b>
        </span>
        <span>
          消耗{" "}
          <b>
            {formatTokens(
              session.totalInputTokens +
                session.totalOutputTokens,
            )}
          </b>
        </span>
        <span>
          工具 <b>{session.toolCallCount}</b>
        </span>
      </div>
    </button>
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
        </div>
        <p>{event.risk}</p>
        <DiffOrOutput text={String(event.detail || event.call.target)} />
        {!resolved ? (
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
        ) : (
          <span className="approval-resolved">审批已处理</span>
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
    return (
      <div className="web-cost-line">
        本轮 {formatTokens(event.input)} in / {formatTokens(event.output)}{" "}
        out · 缓存命中 {cacheRate}% · 累计 {formatTokens(event.totalTokens)}
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

function formatDuration(createdAt: string): string {
  const elapsed = Math.max(
    0,
    Date.now() - Date.parse(createdAt),
  );
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
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
