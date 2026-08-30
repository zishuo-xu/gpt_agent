import type { RefObject } from "react";
import { ItemCard, type ApprovalScope } from "./session-render";
import type { DisplayItem } from "./session-display";
import { DeliveryWorkbench, type DeliveryWorkbenchData } from "./DeliveryWorkbench";

/**
 * 消息流：来源筛选 chips + 事件卡片序列。
 * 纯展示组件——事件/审批状态由父组件持有。
 */
export function SessionStream(props: {
  displayItems: DisplayItem[];
  /** 交付摘要（简洁版）：改动文件 + 验证结果；会话完成且有写操作时由父组件传入 */
  delivery?: DeliveryWorkbenchData | undefined;
  workspace?: { mode: "project" | "isolated"; path?: string; baseHead?: string; currentHead?: string; exists?: boolean; warnings?: string[] };
  onContinue?: () => void;
  onCopyPath?: () => void;
  onExport?: () => void;
  totalEvents: number;
  sourceFilter: string;
  streamRef: RefObject<HTMLDivElement | null>;
  showCacheMissNotices: boolean;
  resolvedPermissions: ReadonlySet<string>;
  pendingPermissionCallId: string | null;
  pendingClarificationId?: string | null;
  permissionFeedback: Record<string, string>;
  onFeedback: (callId: string, value: string) => void;
  onBookmark: (seq: number, name: string) => void;
  onPermission: (
    callId: string,
    granted: boolean,
    scope?: ApprovalScope,
    feedback?: string,
  ) => Promise<void>;
  onClarification?: (
    questionId: string,
    answer: string,
    optionId?: string,
  ) => Promise<void>;
  onSourceFilter: (value: string) => void;
}) {
  return (
    <>
      <div className="replay-filters">
            {(
              [
                ["all", "全部"],
                ["thinking", "推理"],
                ["tool", "工具"],
                ["subtask", "子代理"],
                ["system", "系统"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={
                  props.sourceFilter === key
                    ? "replay-chip active"
                    : "replay-chip"
                }
                onClick={() => props.onSourceFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
      <div
        className="chat-stream"
        ref={props.streamRef}
      >
        {props.totalEvents === 0 && (
          <div className="chat-waiting">
            正在连接会话事件流…
          </div>
        )}
        {props.displayItems.map((item) => (
          <div
            className="stream-item"
            data-seq={item.seq}
            data-display-kind={item.kind}
            key={item.seq}
          >
            {item.kind === "message" &&
              item.author === "user" && (
                <button
                  className="stream-bookmark"
                  title="打书签（长会话导航用）"
                  aria-label={`打书签 #${item.seq}`}
                  onClick={() => {
                    const name = window.prompt(
                      `书签名称（#${item.seq}）：`,
                      item.text.slice(0, 20),
                    );
                    if (name !== null) {
                      props.onBookmark(item.seq, name.trim());
                    }
                  }}
                >
                  ★
                </button>
              )}
            <ItemCard
              item={item}
              showCacheMissNotices={props.showCacheMissNotices}
              locallyResolved={props.resolvedPermissions}
              pendingPermissionCallId={props.pendingPermissionCallId}
              pendingClarificationId={props.pendingClarificationId}
              feedback={
                item.kind === "approval"
                  ? (props.permissionFeedback[
                      String(item.event.call.id)
                    ] ?? "")
                  : ""
              }
              onFeedback={props.onFeedback}
              onPermission={props.onPermission}
              onClarification={props.onClarification}
            />
          </div>
        ))}
        {(() => {
          // 审批风暴：挂起审批 ≥2 时提供"全部允许（本次会话）"批量放行
          const pendingApprovals = props.displayItems.filter(
            (item): item is Extract<DisplayItem, { kind: "approval" }> =>
              item.kind === "approval" &&
              !item.resolvedByEvent &&
              !props.resolvedPermissions.has(String(item.event.call.id)),
          );
          if (pendingApprovals.length < 2) return null;
          return (
            <div className="approval-batch-bar">
              <span>{pendingApprovals.length} 个审批等待处理</span>
              <button
                className="approve-button"
                onClick={() => {
                  for (const item of pendingApprovals) {
                    void props.onPermission(
                      String(item.event.call.id),
                      true,
                      "session",
                    );
                  }
                }}
              >
                全部允许（本次会话）
              </button>
            </div>
          );
        })()}
        {props.delivery && <DeliveryWorkbench delivery={props.delivery} workspace={props.workspace} onContinue={props.onContinue} onCopyPath={props.onCopyPath} onExport={props.onExport} />}
      </div>
    </>
  );
}
