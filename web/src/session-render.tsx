import { Fragment, createElement, useState, type ReactNode } from "react";
import type { SessionStatus } from "@shared/types.js";
import type { DisplayItem } from "./session-display";
import { statusLabel, toolResultDiffText } from "./session-display";

export type ApprovalScope = "once" | "session" | "project" | "global";

export function ItemCard(props: {
  item: DisplayItem;
  /** 缓存 miss 提示开关（behavior.showCacheMissNotices；默认关） */
  showCacheMissNotices: boolean;
  locallyResolved: ReadonlySet<string>;
  /** 正在提交审批的 callId（按钮 loading 态，防重复点击） */
  pendingPermissionCallId?: string | null;
  feedback: string;
  onFeedback: (callId: string, value: string) => void;
  onPermission: (
    callId: string,
    granted: boolean,
    scope?: ApprovalScope,
    feedback?: string,
  ) => Promise<void>;
}) {
  const { item, showCacheMissNotices } = props;

  if (item.kind === "message") {
    return (
      <article
        className={`web-message ${
          item.author === "user" ? "user-message" : "assistant-message"
        }${item.queued ? " queued-message" : ""}`}
      >
        <span className="message-author">
          {item.author === "user" ? "你" : "MyAgent"} · {formatTime(item.ts)}
          {item.queued && (
            <em>
              {item.started
                ? "已处理"
                : item.steer
                  ? "已插队"
                  : "已排队"}
            </em>
          )}
        </span>
        <RichText text={item.text} />
      </article>
    );
  }

  if (item.kind === "tool") {
    const { call, result, partial } = item;
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
          {/* Bash 执行期实时输出（tool_execution_update 流式 partial；
              命令结束后仍保留供查看，与最终 tool_result 不重复展示） */}
          {partial && !result && (
            <pre className="tool-partial-output">{partial}</pre>
          )}
          {call.purpose && <p>目的：{call.purpose}</p>}
          {result?.summary && <p>{result.summary}</p>}
          {result?.reason && <p>{result.reason}</p>}
          {result?.details &&
            typeof result.details === "object" && (
              <div className="tool-details-grid">
                {Object.entries(
                  result.details as Record<string, unknown>,
                ).map(([key, value]) => {
                  // diff 单独渲染为高亮块，不进 details 网格
                  if (key === "diff") return null;
                  // Bash 退出码着色（0 绿/非 0 红），耗时转可读格式
                  const toneClass =
                    key === "code" && typeof value === "number"
                      ? value === 0
                        ? " detail-ok"
                        : " detail-error"
                      : key === "durationMs" || key === "signal"
                        ? " detail-meta"
                        : "";
                  const display =
                    key === "durationMs" && typeof value === "number"
                      ? formatDuration(value)
                      : typeof value === "object" && value !== null
                        ? JSON.stringify(value)
                        : String(value);
                  return (
                    <span
                      className={`tool-details-item${toneClass}`}
                      key={key}
                    >
                      <b>{key}</b>
                      <span className="tool-details-sep">：</span>
                      {display}
                    </span>
                  );
                })}
              </div>
            )}
          {(() => {
            // P0-3 后 Edit/Write diff 在 details.diff（不进模型上下文），渲染优先取它；
            // 旧 trace 的 tool_result 无 details.diff 时回退 output
            const text = toolResultDiffText(result);
            return text === undefined ? null : (
              <DiffOrOutput
                text={text}
                forceDiff={
                  call.tool === "Edit" ||
                  call.tool === "Write" ||
                  call.tool === "MultiEdit"
                }
              />
            );
          })()}
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
            <span
              className={`approval-resolved-tag${
                item.deniedReason ? " denied" : ""
              }`}
            >
              {item.deniedReason
                ? `已拒绝：${item.deniedReason}`
                : "已处理"}
            </span>
          )}
        </div>
        <p>{event.risk}</p>
        <DiffOrOutput text={String(event.detail || event.call.target)} />
        {!resolved && (
          <>
            <div className="approval-actions">
              <button
                className="approve-button"
                disabled={props.pendingPermissionCallId === callId}
                onClick={() =>
                  void props.onPermission(callId, true, "once")
                }
              >
                {props.pendingPermissionCallId === callId
                  ? "处理中…"
                  : "仅这一次"}
              </button>
              <button
                disabled={props.pendingPermissionCallId === callId}
                onClick={() =>
                  void props.onPermission(callId, true, "session")
                }
              >
                {props.pendingPermissionCallId === callId
                  ? "处理中…"
                  : "本次会话允许"}
              </button>
              <button
                disabled={props.pendingPermissionCallId === callId}
                onClick={() =>
                  void props.onPermission(callId, true, "project")
                }
              >
                {props.pendingPermissionCallId === callId
                  ? "处理中…"
                  : "本项目允许"}
              </button>
              <button
                disabled={props.pendingPermissionCallId === callId}
                onClick={() =>
                  void props.onPermission(callId, true, "global")
                }
              >
                {props.pendingPermissionCallId === callId
                  ? "处理中…"
                  : "全局允许"}
              </button>
              <button
                className="reject-button"
                disabled={props.pendingPermissionCallId === callId}
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
    const durationMs = end
      ? Date.parse(String(end.ts)) - Date.parse(String(start.ts))
      : undefined;
    return (
      <details className="subtask-card">
        <summary>
          ◇ <strong>{start.description}</strong>
          <span>
            子代理 explore ·{" "}
            {end
              ? `${end.toolCalls} 次工具调用 · ${formatTokens(
                  end.inputTokens + end.outputTokens,
                )} tokens · ${
                  durationMs !== undefined && Number.isFinite(durationMs)
                    ? `${formatDuration(durationMs)} · `
                    : ""
                }${statusLabel(end.status)}${end.reason === "timeout" ? "（超时）" : ""}`
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

  if (item.kind === "thinking") {
    return (
      <details className="web-thinking">
        <summary>
          <span className="thinking-label">思考过程</span>
        </summary>
        <div className="thinking-body">
          <RichText text={item.text} />
        </div>
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
    const missedCostCny = Number(event.missedCostCny ?? 0);
    // 显示门控：压缩重置属合法信息始终提示；其余 miss 提示需开启开关且超过显示阈值
    const showMiss =
      missed > 0 &&
      (event.missedReason === "compaction" ||
        (showCacheMissNotices &&
          (missed >= 20_000 || missedCostCny >= 0.1)));
    const missedCostLabel =
      showMiss && missedCostCny > 0
        ? `（多花 ¥${missedCostCny.toFixed(4)}）`
        : "";
    const missedLabel =
      !showMiss
        ? ""
        : event.missedReason === "compaction"
          ? " · 缓存已重置（压缩）"
          : event.missedReason === "model_switch"
            ? ` · 缓存失效 ${formatTokens(missed)}（模型切换）${missedCostLabel}`
            : event.missedReason === "idle"
              ? ` · 缓存过期 ${formatTokens(missed)}（空闲超时）${missedCostLabel}`
              : ` · 缓存未命中浪费 ${formatTokens(missed)}${missedCostLabel}`;
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

export function RichText(props: { text: string }) {
  const lines = props.text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  // fenced code block 状态：```lang 开行进入收集，闭合围栏渲染为 <pre>
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];
  const flushCode = (key: number) => {
    if (!inCode) return;
    blocks.push(
      <pre
        className="code-block"
        data-lang={codeLang}
        key={`code-${key}`}
      >
        {codeLines.map((line, lineIndex) => (
          <span key={lineIndex}>
            {line || " "}
            {"\n"}
          </span>
        ))}
      </pre>,
    );
    codeLang = "";
    codeLines = [];
    inCode = false;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();
    const fence = /^```(\S*)\s*$/.exec(trimmed);
    if (fence) {
      if (inCode) {
        flushCode(blocks.length);
      } else {
        inCode = true;
        codeLang = fence[1] ?? "";
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!trimmed) {
      blocks.push(<br key={index} />);
      continue;
    }
    // markdown 标题：## 等原样渲染为分级标题（h1 过大映射 h2，最多 h4）
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(Math.max(heading[1]!.length, 2), 4);
      blocks.push(
        createElement(
          `h${level}`,
          { key: index },
          renderInline(heading[2] ?? ""),
        ),
      );
      continue;
    }
    // 引用块
    if (trimmed.startsWith(">")) {
      blocks.push(
        <blockquote key={index}>
          {renderInline(trimmed.replace(/^>\s?/, ""))}
        </blockquote>,
      );
      continue;
    }
    // 分隔线
    if (/^-{3,}$/.test(trimmed)) {
      blocks.push(<hr key={index} />);
      continue;
    }
    // 有序列表：保留编号前缀
    const ordered = /^(\d+[.)])\s+(.*)$/.exec(trimmed);
    if (ordered) {
      blocks.push(
        <p className="rich-list-line ordered" key={index}>
          {ordered[1]} {renderInline(ordered[2] ?? "")}
        </p>,
      );
      continue;
    }
    const isList = /^[-*]\s+/.test(trimmed);
    blocks.push(
      <p className={isList ? "rich-list-line" : ""} key={index}>
        {isList ? "• " : ""}
        {renderInline(
          isList ? trimmed.replace(/^[-*]\s+/, "") : line,
        )}
      </p>,
    );
  }
  flushCode(blocks.length);
  return <div className="rich-text">{blocks}</div>;
}

export function renderInline(text: string): ReactNode[] {
  // 链接优先于 code/bold 解析：避免 [text](url) 中括号内容被误判
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^)\n]+\))/g);
  return tokens.map((token, index) => {
    if (token.startsWith("`") && token.endsWith("`")) {
      return <code key={index}>{token.slice(1, -1)}</code>;
    }
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/.exec(token);
    if (link) {
      const href = link[2] ?? "";
      // 只放行 http(s) 链接，防 javascript: 等危险协议
      return /^https?:\/\//i.test(href) ? (
        <a key={index} href={href} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>
      ) : (
        <Fragment key={index}>{token}</Fragment>
      );
    }
    return <Fragment key={index}>{token}</Fragment>;
  });
}

export function DiffOrOutput(props: { text: string; forceDiff?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const lines = props.text.split(/\r?\n/);
  // 同时存在 +/- 行（或带 diff 头）才按 diff 渲染，避免缩进文本误判；
  // 编辑类工具（Edit/Write/MultiEdit）输出强制按 diff 着色（纯新增文件只有 + 行）
  const hasMarker = lines.some(
    (line) => line.startsWith("@@") || line.startsWith("diff --git"),
  );
  const hasAdd = lines.some((line) => line.startsWith("+"));
  const hasRemove = lines.some((line) => line.startsWith("-"));
  const isDiff =
    props.forceDiff === true || hasMarker || (hasAdd && hasRemove);
  // 长输出按需展开：默认只展示前 60 行，避免大段输出拖慢回放渲染
  const collapseThreshold = 60;
  const collapsed = !expanded && lines.length > collapseThreshold;
  const visibleLines = collapsed
    ? lines.slice(0, collapseThreshold)
    : lines;
  return (
    <>
      <pre className={isDiff ? "diff-output" : "tool-output"}>
        {visibleLines.map((line, index) => (
          <span
            className={
              line.startsWith("@@") || line.startsWith("diff --git")
                ? "diff-hunk"
                : line.startsWith("+")
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
      {collapsed && (
        <button
          className="output-expand-toggle"
          onClick={() => setExpanded(true)}
        >
          展开剩余 {lines.length - collapseThreshold} 行
        </button>
      )}
    </>
  );
}

export function SystemLine(props: {
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

export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  const seconds = ms / 1000;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 时`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)} 分`;
  if (ms >= 1000) return `${seconds.toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}


export const statusMeta: Record<
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

export function StatusTag(props: { status: SessionStatus }) {
  const meta = statusMeta[props.status];
  return (
    <span className={`session-tag ${meta.tone}`}>
      <i className="tag-dot" />
      {meta.label}
    </span>
  );
}
