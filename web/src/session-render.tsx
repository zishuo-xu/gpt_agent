import type { ReactNode } from "react";
import type { SessionStatus } from "@shared/types.js";
import type { DisplayItem } from "./session-display";
import { formatTime, formatTokens } from "./session-format";
import { RichText } from "./session-rich-text";
import {
  ApprovalCard,
  LedgerCard,
  ReviewCard,
  SubtaskCard,
  ToolCard,
  type ApprovalScope,
} from "./session-card";

export type { ApprovalScope } from "./session-card";

/**
 * 会话流事件卡片的统一入口：按 kind 分派到各专用卡片组件。
 * 消息/思考/消耗/系统行内渲染；工具/审批/子代理见 session-card。
 */
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
    return <ToolCard item={item} />;
  }

  if (item.kind === "approval") {
    return (
      <ApprovalCard
        item={item}
        locallyResolved={props.locallyResolved}
        pendingPermissionCallId={props.pendingPermissionCallId ?? null}
        feedback={props.feedback}
        onFeedback={props.onFeedback}
        onPermission={props.onPermission}
      />
    );
  }

  if (item.kind === "subtask") {
    return <SubtaskCard item={item} />;
  }

  if (item.kind === "review") {
    return <ReviewCard item={item} />;
  }

  if (item.kind === "ledger") {
    return <LedgerCard item={item} />;
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
