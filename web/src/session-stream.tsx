import type { RefObject } from "react";
import { ItemCard, type ApprovalScope } from "./session-render";
import type { DisplayItem } from "./session-display";

/**
 * 消息流：回放条（Trajectory 式：播放/速度/来源筛选）+ 事件卡片序列。
 * 纯展示组件——事件/回放/审批状态由父组件持有。
 */
export function SessionStream(props: {
  displayItems: DisplayItem[];
  /** 交付摘要（简洁版）：改动文件 + 验证结果；会话完成且有写操作时由父组件传入 */
  delivery?: { files: string[]; verification?: string } | undefined;
  totalEvents: number;
  replay: boolean;
  replayCursor: number;
  replayPlaying: boolean;
  replaySpeed: number;
  sourceFilter: string;
  streamRef: RefObject<HTMLDivElement | null>;
  showCacheMissNotices: boolean;
  resolvedPermissions: ReadonlySet<string>;
  pendingPermissionCallId: string | null;
  permissionFeedback: Record<string, string>;
  onFeedback: (callId: string, value: string) => void;
  onBookmark: (seq: number, name: string) => void;
  onPermission: (
    callId: string,
    granted: boolean,
    scope?: ApprovalScope,
    feedback?: string,
  ) => Promise<void>;
  onExitReplay: () => void;
  onReplayCursor: (value: number) => void;
  onTogglePlayback: () => void;
  onReplaySpeed: (value: number) => void;
  onSourceFilter: (value: string) => void;
}) {
  return (
    <>
      {props.replay && (
        <>
          <div className="replay-bar">
            <button
              className="replay-play"
              onClick={props.onTogglePlayback}
              title={props.replayPlaying ? "暂停回放" : "自动回放整个过程"}
            >
              {props.replayPlaying ? "⏸ 暂停" : "▶ 播放"}
            </button>
            <button
              className="replay-speed"
              onClick={() =>
                props.onReplaySpeed(
                  props.replaySpeed === 8 ? 1 : props.replaySpeed * 2,
                )
              }
              title="播放速度（1x/2x/4x/8x）"
            >
              {props.replaySpeed}x
            </button>
            <input
              type="range"
              min={1}
              max={Math.max(1, props.totalEvents)}
              value={Math.max(1, props.replayCursor)}
              onChange={(event) =>
                props.onReplayCursor(
                  Number(event.target.value),
                )
              }
            />
            <code>
              {Math.min(props.replayCursor, props.totalEvents)} /{" "}
              {props.totalEvents}
            </code>
            <button onClick={props.onExitReplay}>
              退出
            </button>
          </div>
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
        </>
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
              feedback={
                item.kind === "approval"
                  ? (props.permissionFeedback[
                      String(item.event.call.id)
                    ] ?? "")
                  : ""
              }
              onFeedback={props.onFeedback}
              onPermission={props.onPermission}
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
          if (pendingApprovals.length < 2 || props.replay) return null;
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
        {props.delivery && !props.replay && (
          <div className="delivery-summary">
            <div className="delivery-head">
              <strong>✓ 完成</strong>
              <span>改动 {props.delivery.files.length} 个文件</span>
              {props.delivery.verification && (
                <span className="delivery-verification">
                  验证：{props.delivery.verification.slice(0, 48)}
                  {props.delivery.verification.length > 48 ? "…" : ""}
                </span>
              )}
            </div>
            {props.delivery.files.length > 0 && (
              <ul className="delivery-files">
                {props.delivery.files.slice(0, 6).map((file) => (
                  <li key={file}>{file}</li>
                ))}
                {props.delivery.files.length > 6 && (
                  <li className="delivery-more">
                    +{props.delivery.files.length - 6} 个文件
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>
    </>
  );
}
