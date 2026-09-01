import type { ReactNode } from "react";
import type { SessionSummary } from "@shared/types.js";
import { StatusTag } from "./session-render";

/** 项目切换器里的一个项目项（/api/projects 响应） */
export interface ProjectEntry {
  key: string;
  name: string;
  cwd: string;
}

/** 任务详情页头部：标题、状态与当前动作；技术操作收进更多菜单。 */
export function SessionHeader(props: {
  selected: SessionSummary;
  currentProject: string;
  projects: ProjectEntry[];
  busy: boolean;
  showDetail: boolean;
  onSwitchProject: (key: string) => void;
  onInterrupt: () => void;
  onResume: () => void;
  onNew: () => void;
  onExport: () => void;
  onDelete: () => void;
  onToggleDetail: () => void;
}) {
  return (
    <header className="page-header sessions-header">
      <div>
        <div className="title-with-status">
          <h1>{props.selected.title}</h1>
          <StatusTag status={props.selected.status} />
        </div>
        <p className="task-context">
          {props.selected.kind === "run" ? "自动执行" : "与你协作"}
          {taskAction(props.selected.status)}
        </p>
      </div>
      <div className="header-actions">
        <select
          className="project-switcher"
          value={props.currentProject}
          onChange={(event) =>
            props.onSwitchProject(event.target.value)
          }
          title="切换项目"
        >
          {props.projects.map((project) => (
            <option value={project.key} key={project.key}>
              {project.name}
            </option>
          ))}
        </select>
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
        <button className="secondary-button" onClick={props.onNew}>＋ 新建任务</button>
        <details className="header-more">
          <summary>更多</summary>
          <div className="header-more-menu">
            <button className={`detail-toggle ${props.showDetail ? "active" : ""}`} onClick={props.onToggleDetail}>
              {props.showDetail ? "收起任务详情" : "任务详情"}
            </button>
            <button className="detail-toggle" onClick={props.onExport}>导出任务</button>
            <button className="detail-toggle danger" onClick={props.onDelete}>删除任务</button>
          </div>
        </details>
      </div>
    </header>
  );
}

/** 未选中任务时的极简任务首页。 */
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
          <span className="empty-detail-mark">◆</span>
          <h2>把工作交给 MyAgent</h2>
          <p>描述你想完成的工作，MyAgent 会在项目中执行、验证并汇报结果。</p>
          {props.newTaskComposer}
        </div>
      </div>
    </>
  );
}

function taskAction(status: SessionSummary["status"]): string {
  switch (status) {
    case "waiting_permission":
    case "waiting_plan":
    case "waiting_user":
      return " · 等待你的决定";
    case "running":
      return " · 正在处理";
    case "done":
      return " · 可查看交付结果";
    case "error":
      return " · 遇到问题，可继续处理";
    case "interrupted":
      return " · 可恢复任务";
    case "idle":
      return " · 可补充要求";
  }
}
