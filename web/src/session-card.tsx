import { formatDuration, formatTokens } from "./session-format";
import { DiffOrOutput, RichText } from "./session-rich-text";
import { statusLabel, toolResultDiffText } from "./session-display";
import type { DisplayItem } from "./session-display";

export type ApprovalScope = "once" | "session" | "project" | "global";

/** 工具卡：调用详情 + 实时输出 + 结果网格 + diff（折叠展示） */
export function ToolCard(props: {
  item: Extract<DisplayItem, { kind: "tool" }>;
}) {
  const { call, result, partial } = props.item;
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

/** 审批卡：请求详情 + 作用域批准/拒绝 + 留言（已决只读展示） */
export function ApprovalCard(props: {
  item: Extract<DisplayItem, { kind: "approval" }>;
  locallyResolved: ReadonlySet<string>;
  pendingPermissionCallId: string | null;
  feedback: string;
  onFeedback: (callId: string, value: string) => void;
  onPermission: (
    callId: string,
    granted: boolean,
    scope?: ApprovalScope,
    feedback?: string,
  ) => Promise<void>;
}) {
  const { event } = props.item;
  const callId = String(event.call.id);
  const resolved =
    props.item.resolvedByEvent || props.locallyResolved.has(callId);
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
              props.item.deniedReason ? " denied" : ""
            }`}
          >
            {props.item.deniedReason
              ? `已拒绝：${props.item.deniedReason}`
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

/** 子代理卡：探索任务的耗时/工具调用/结果摘要（可展开） */
export function SubtaskCard(props: {
  item: Extract<DisplayItem, { kind: "subtask" }>;
}) {
  const { start, end } = props.item;
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
