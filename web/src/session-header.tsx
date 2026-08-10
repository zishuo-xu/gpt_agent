import type { SessionSummary } from "@shared/types.js";
import { StatusTag } from "./session-render";

/** 项目切换器里的一个项目项（/api/projects 响应） */
export interface ProjectEntry {
  key: string;
  name: string;
  cwd: string;
}

/** 会话详情页头部：标题 + 项目切换 + 任务操作 + 导出/删除/详情 */
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
        <p className="eyebrow">AGENT / SESSION</p>
        <div className="title-with-status">
          <h1>{props.selected.title}</h1>
          <StatusTag status={props.selected.status} />
        </div>
        <p>
          会话 #{props.selected.id} ·{" "}
          {props.selected.kind === "run"
            ? "无人值守"
            : "交互会话"}{" "}
          · {props.selected.permissionMode} 档
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
        <button
          className="secondary-button"
          onClick={props.onNew}
        >
          ＋ 新会话
        </button>
        <button
          className="detail-toggle"
          onClick={props.onExport}
          title="导出会话为 HTML（可分享/归档）"
        >
          导出
        </button>
        <button
          className="detail-toggle"
          onClick={props.onDelete}
          title="删除此会话"
        >
          删除
        </button>
        <button
          className={`detail-toggle ${props.showDetail ? "active" : ""}`}
          onClick={props.onToggleDetail}
          title="任务清单 / 消耗 / 会话信息"
        >
          ⤢ {props.showDetail ? "收起详情" : "详情"}
        </button>
      </div>
    </header>
  );
}

/** 未选中会话时的空态：说明 + 项目切换 + 新建入口 */
export function SessionEmpty(props: {
  error: string;
  currentProject: string;
  projects: ProjectEntry[];
  onSwitchProject: (key: string) => void;
  onNew: () => void;
}) {
  return (
    <>
      {props.error && (
        <div className="notice error">{props.error}</div>
      )}
      <div className="empty-detail">
        <div className="empty-detail-inner">
          <span className="empty-detail-mark">◆</span>
          <h2>选择一个会话，或新建</h2>
          <p>
            左侧是会话列表；也可以在下方直接开始一个新任务。
          </p>
          <div className="empty-detail-actions">
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
            <button
              className="save-button"
              onClick={props.onNew}
            >
              ＋ 新会话
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
