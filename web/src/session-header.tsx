import type { ReactNode } from "react";
import type { SessionSummary } from "@shared/types.js";
import { StatusTag } from "./session-render";

/** 项目切换器里的一个项目项（/api/projects 响应） */
export interface ProjectEntry {
  key: string;
  name: string;
  cwd: string;
}

/** 任务详情页头部：标题 + 状态 + 当前动作按钮；项目切换在左栏，导出/删除挪到轨迹页头部。 */
export function SessionHeader(props: {
  selected: SessionSummary;
  busy: boolean;
  onInterrupt: () => void;
  onResume: () => void;
}) {
  return (
    <header className="page-header sessions-header">
      <div>
        <div className="title-with-status">
          <h1>{props.selected.title}</h1>
          <StatusTag status={props.selected.status} />
        </div>
      </div>
      <div className="header-actions">
        {props.busy && (
          <button
            className="interrupt-button"
            onClick={props.onInterrupt}
          >
            ■ 中止任务
          </button>
        )}
        {props.selected.interruptedTask && !props.busy && (
          <button
            className="resume-button"
            onClick={props.onResume}
            title={`续跑中断任务：${props.selected.interruptedTask.description}`}
          >
            ↻ 续跑中断任务
          </button>
        )}
      </div>
    </header>
  );
}

/** 未选中任务时的极简任务首页：只有输入框。 */
export function SessionEmpty(props: {
  error: string;
  newTaskComposer?: ReactNode;
}) {
  return (
    <>
      {props.error && (
        <div className="notice error">{props.error}</div>
      )}
      <div className="empty-detail">
        <div className="empty-detail-inner">
          {props.newTaskComposer}
        </div>
      </div>
    </>
  );
}
