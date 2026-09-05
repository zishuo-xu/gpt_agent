import type { ReactNode } from "react";
import type { SessionSummary, TodoItem } from "@shared/types.js";
import { statusMeta } from "./session-render";
import type { FileChangeEntry } from "./session-rail";

/** 会话头部下方的紧凑状态条：计划进度 / 文件改动 / 上下文水位 / 费用，点击展开详情抽屉。
 *  各分段仅在对应数据存在时渲染；全空则不渲染。 */
export function SessionStatusBar(props: {
  latestTodos: TodoItem[];
  fileChanges: FileChangeEntry[];
  selected: SessionSummary;
  /** 上下文水位：最近一轮 input tokens（对照压缩阈值显示百分比） */
  contextTokens?: number;
  contextThreshold?: number;
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
  const contextTokens = props.contextTokens ?? 0;
  const contextThreshold = props.contextThreshold ?? 0;
  if (contextTokens > 0 && contextThreshold > 0) {
    const percent = Math.min(100, Math.round((contextTokens / contextThreshold) * 100));
    segments.push({
      key: "context",
      node: <b
        className={percent >= 80 ? "context-high" : undefined}
        title={`上下文约 ${Math.round(contextTokens / 1000)}k tokens / 压缩阈值 ${Math.round(contextThreshold / 1000)}k${percent >= 80 ? " · 接近自动压缩" : ""}`}
      >上下文 {percent}%</b>,
    });
  }
  if (cost > 0) {
    // 定价未校准前明确标注估算属性
    segments.push({ key: "cost", node: <b title="按配置单价估算">≈¥{cost.toFixed(2)}</b> });
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
