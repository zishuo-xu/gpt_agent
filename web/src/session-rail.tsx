import type { SessionBranch, SessionSummary, TodoItem } from "@shared/types.js";
import { formatTime, formatTokens } from "./session-format";
import { statusMeta } from "./session-render";
import { BranchTree, KeyValue, RailCard } from "./session-branch";

/** 对话链路：每轮用户提问的目录项（点击定位到对应消息） */
export interface UserTurn {
  seq: number;
  ts: string;
  text: string;
  turn: number;
}

export interface Bookmark {
  seq: number;
  name: string;
}

/** 右侧信息栏：分支树 / 对话链路 / 书签 /（详情展开）清单·消耗·会话 */
export function SessionRail(props: {
  branches: SessionBranch[];
  currentBranchId: string;
  busy: boolean;
  userTurns: UserTurn[];
  bookmarks: Bookmark[];
  latestTodos: TodoItem[];
  selected: SessionSummary;
  showDetail: boolean;
  onSwitchBranch: (branchId: string) => void;
  onScrollToSeq: (seq: number) => void;
  onToggleBookmark: (seq: number, name: string) => void;
}) {
  return (
    <aside className="session-rail">
      {props.selected.status === "done" &&
        props.selected.toolCallCount === 0 && (
          <div className="rail-todo-warning">
            Agent 未调用任何工具就宣布完成——若这是编码/搭建任务，
            结果可能不完整，请检查或让 Agent 重新执行
          </div>
        )}
      <RailCard title="分支树">
        {props.branches.length === 0 ? (
          <p className="rail-empty">
            fork 后可在此回溯切换分支。
          </p>
        ) : (
          <BranchTree
            branches={props.branches}
            currentBranchId={props.currentBranchId}
            busy={props.busy}
            onSwitch={props.onSwitchBranch}
          />
        )}
      </RailCard>
      <RailCard title="对话链路">
        {props.userTurns.length === 0 ? (
          <p className="rail-empty">
            发送消息后，这里会列出每轮提问，点击可跳转。
          </p>
        ) : (
          <div className="chain-list">
            {props.userTurns.map((turn) => (
              <button
                className="chain-item"
                key={turn.seq}
                onClick={() => props.onScrollToSeq(turn.seq)}
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
      <RailCard title="书签">
        {props.bookmarks.length === 0 ? (
          <p className="rail-empty">
            在对话中右键/长按消息可打书签；CLI /label 亦可。
          </p>
        ) : (
          <div className="chain-list">
            {props.bookmarks.map((bookmark) => (
              <button
                className="chain-item bookmark-item"
                key={bookmark.seq}
                onClick={() => props.onScrollToSeq(bookmark.seq)}
                title={bookmark.name}
              >
                <span className="chain-index">
                  #{bookmark.seq}
                </span>
                <span className="chain-text">
                  {bookmark.name}
                </span>
                <time
                  role="button"
                  aria-label={`移除书签 ${bookmark.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onToggleBookmark(bookmark.seq, "");
                  }}
                >
                  ✕
                </time>
              </button>
            ))}
          </div>
        )}
      </RailCard>
      {props.showDetail && (
        <>
          <RailCard title="任务清单">
            {props.selected.status === "done" &&
              props.latestTodos.some(
                (todo) => todo.status !== "completed",
              ) && (
                <div className="rail-todo-warning">
                  Agent 已宣布完成，但仍有{" "}
                  {
                    props.latestTodos.filter(
                      (todo) => todo.status !== "completed",
                    ).length
                  }{" "}
                  项任务未完成或未更新
                </div>
              )}
            {props.latestTodos.length === 0 ? (
              <p className="rail-empty">
                Agent 建立 todo 后会显示在这里。
              </p>
            ) : (
              props.latestTodos.map((todo) => (
                <div
                  className={`rail-todo ${todo.status}`}
                  key={todo.id}
                >
                  <span className="todo-check">
                    {todo.status === "completed"
                      ? "✓"
                      : todo.status === "in_progress"
                        ? "→"
                        : "○"}
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
                props.selected.totalInputTokens +
                  props.selected.totalOutputTokens,
              )} tokens`}
            />
            <KeyValue
              label="输入 / 输出"
              tone="kv-io"
              value={`${formatTokens(
                props.selected.totalInputTokens,
              )} / ${formatTokens(
                props.selected.totalOutputTokens,
              )}`}
            />
            <KeyValue
              label="缓存命中"
              tone="kv-cache"
              value={`${formatTokens(
                props.selected.totalCachedTokens,
              )} tokens`}
            />
            {props.selected.totalMissedTokens > 0 && (
              <KeyValue
                label="缓存浪费"
                value={`${formatTokens(
                  props.selected.totalMissedTokens,
                )} tokens${
                  props.selected.totalMissedCostCny > 0
                    ? `（多花 ¥${props.selected.totalMissedCostCny.toFixed(4)}）`
                    : ""
                }`}
              />
            )}
            <KeyValue
              label="估算费用"
              value={
                props.selected.totalCostCny > 0
                  ? `¥${props.selected.totalCostCny.toFixed(4)}`
                  : "未配置单价"
              }
            />
          </RailCard>
          <RailCard title="会话">
            <KeyValue
              label="权限档"
              value={props.selected.permissionMode}
            />
            <KeyValue
              label="状态"
              value={statusMeta[props.selected.status].label}
            />
            <KeyValue
              label="工具调用"
              value={`${props.selected.toolCallCount} 次`}
            />
            <KeyValue
              label="开始时间"
              value={formatTime(props.selected.createdAt)}
            />
          </RailCard>
        </>
      )}
    </aside>
  );
}
