import type { SessionSummary, TodoItem } from "@shared/types.js";
import { formatTime, formatTokens } from "./session-format";
import { statusMeta } from "./session-render";
import { KeyValue, RailCard } from "./session-branch";

/** 从事件流提取的文件改动条目（Edit/Write/MultiEdit 工具调用） */
export interface FileChangeEntry {
  path: string;
  /** 累计增删行（能从 diff 解析则给出，否则为 undefined） */
  added?: number;
  removed?: number;
}

/** 任务清单卡（有 todo 时显示，设计稿「计划详情」形态）+ 文件改动卡 + 消耗/会话卡。
 *  纯展示组件：完成态警告（0 工具调用 / 完成但有未完成 todo）由 SessionApp 内联渲染。 */
export function SessionRail(props: {
  latestTodos: TodoItem[];
  selected: SessionSummary;
  showDetail: boolean;
  /** 会话内累计文件改动（从事件流的 Edit/Write 工具结果提取） */
  fileChanges?: FileChangeEntry[];
}) {
  const hasTodos = props.latestTodos.length > 0;
  const fileChanges = props.fileChanges ?? [];
  const totalAdded = fileChanges.reduce((sum, item) => sum + (item.added ?? 0), 0);
  const totalRemoved = fileChanges.reduce((sum, item) => sum + (item.removed ?? 0), 0);
  if (!hasTodos && !props.showDetail && fileChanges.length === 0) {
    return null;
  }
  return (
    <aside className="session-rail">
      {hasTodos && (
        <RailCard title="计划详情">
          <ol className="rail-plan-steps">
            {props.latestTodos.map((todo, index) => (
              <li className={`rail-plan-step ${todo.status}`} key={todo.id}>
                <span className="rail-plan-index" aria-hidden="true">
                  {todo.status === "completed" ? (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    index + 1
                  )}
                </span>
                {/* 三态文本标记（✓/→/○）：供测试与无样式环境识别状态 */}
                <span className="todo-check sr-only">
                  {todo.status === "completed"
                    ? "✓"
                    : todo.status === "in_progress"
                      ? "→"
                      : "○"}
                </span>
                <span className="rail-plan-content">{todo.content}</span>
                <span className="rail-plan-state">
                  {todo.status === "completed"
                    ? ""
                    : todo.status === "in_progress"
                      ? "进行中"
                      : "待执行"}
                </span>
              </li>
            ))}
          </ol>
        </RailCard>
      )}
      {fileChanges.length > 0 && (
        <RailCard title={`文件改动 (${fileChanges.length})`}>
          <p className="rail-diff-total">
            {fileChanges.length} 个文件被修改
            <span className="diff-stat">
              <b className="diff-add">+{totalAdded}</b>
              <b className="diff-del">-{totalRemoved}</b>
            </span>
          </p>
          <ul className="rail-file-changes">
            {fileChanges.map((change) => (
              <li key={change.path} className="rail-file-change">
                <code title={change.path}>{change.path}</code>
                {(change.added !== undefined || change.removed !== undefined) && (
                  <span className="diff-stat">
                    <b className="diff-add">+{change.added ?? 0}</b>
                    <b className="diff-del">-{change.removed ?? 0}</b>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </RailCard>
      )}
      {props.showDetail && (
        <>
          <RailCard title="消耗">
            <KeyValue
              label="本会话累计"
              value={`${formatTokens(
                props.selected.totalInputTokens +
                  props.selected.totalOutputTokens,
              )} tokens`}
            />
            <KeyValue
              label="输入 / 输出"
              value={`${formatTokens(
                props.selected.totalInputTokens,
              )} / ${formatTokens(
                props.selected.totalOutputTokens,
              )}`}
            />
            <KeyValue
              label="缓存命中"
              value={`${formatTokens(
                props.selected.totalCachedTokens,
              )} tokens`}
            />
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
