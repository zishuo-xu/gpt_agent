import type { ReactNode } from "react";
import type { SessionSummary, TodoItem } from "@shared/types.js";
import { statusMeta } from "./session-render";
import type { FileChangeEntry } from "./session-rail";

/** 会话头部下方的紧凑状态条：计划进度 / 文件改动 / 费用，点击展开详情抽屉。
 *  各分段仅在对应数据存在时渲染；全空则不渲染。 */
export function SessionStatusBar(props: {
  latestTodos: TodoItem[];
  fileChanges: FileChangeEntry[];
  selected: SessionSummary;
  onOpen: () => void;
}) {
  const todos = props.latestTodos;
  const doneCount = todos.filter((t) => t.status === "completed").length;
  const changes = props.fileChanges;
  const totalAdded = changes.reduce((s, c) => s + (c.added ?? 0), 0);
  const totalRemoved = changes.reduce((s, c) => s + (c.removed ?? 0), 0);
  const cost = props.selected.totalCostCny;

  const segments: Array<{ key: string; node: ReactNode }> = [];
  if (todos.length > 0) {
    segments.push({
      key: "plan",
      node: <>计划 <b>{doneCount}/{todos.length}</b></>,
    });
  }
  if (changes.length > 0) {
    segments.push({
      key: "diff",
      node: <>改动 <b>{changes.length} 文件</b>{" "}
        <b className="diff-add">+{totalAdded}</b>{" "}
        <b className="diff-del">−{totalRemoved}</b></>,
    });
  }
  if (cost > 0) {
    segments.push({ key: "cost", node: <b>¥{cost.toFixed(2)}</b> });
  }
  if (segments.length === 0) return null;

  return (
    <button
      type="button"
      className="statusbar"
      onClick={props.onOpen}
      aria-label="展开任务详情"
    >
      {segments.map((seg) => (
        <span className="statusbar-seg" key={seg.key}>{seg.node}</span>
      ))}
      <span className="statusbar-state">{statusMeta[props.selected.status].label}</span>
      <span className="statusbar-hint" aria-hidden="true">详情 ›</span>
    </button>
  );
}
