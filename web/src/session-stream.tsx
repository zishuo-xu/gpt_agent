import type { RefObject } from "react";
import { ItemCard, type ApprovalScope } from "./session-render";
import type { DisplayItem } from "./session-display";

/**
 * 消息流：回放条（Trajectory 式：播放/速度/来源筛选）+ 事件卡片序列。
 * 纯展示组件——事件/回放/审批状态由父组件持有。
 */
export function SessionStream(props: {
  displayItems: DisplayItem[];
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
      </div>
    </>
  );
}
