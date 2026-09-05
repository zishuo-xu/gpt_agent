import type { RefObject } from "react";
import { ItemCard, type ApprovalScope } from "./session-render";
import type { DisplayItem } from "./session-display";
import { DeliveryWorkbench, type DeliveryWorkbenchData } from "./DeliveryWorkbench";

/**
 * 消息流：事件卡片序列。
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
  /** 来源筛选 chips：轨迹视图才显示，对话视图不出现 */
  showSourceFilter?: boolean;
  /** 对话视图精简模式：隐藏思考过程折叠条与每轮 token 行 */
  compact?: boolean;
  streamRef: RefObject<HTMLDivElement | null>;
  showCacheMissNotices: boolean;
  resolvedPermissions: ReadonlySet<string>;
  pendingPermissionCallId: string | null;
  pendingClarificationId?: string | null;
  permissionFeedback: Record<string, string>;
  onFeedback: (callId: string, value: string) => void;
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
      {props.showSourceFilter && props.totalEvents > 0 && (
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
      )}
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
            <ItemCard
              item={item}
              showCacheMissNotices={props.showCacheMissNotices}
              compact={props.compact}
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
        {props.delivery && <DeliveryWorkbench delivery={props.delivery} workspace={props.workspace} onContinue={props.onContinue} onCopyPath={props.onCopyPath} onExport={props.onExport} />}
      </div>
    </>
  );
}
