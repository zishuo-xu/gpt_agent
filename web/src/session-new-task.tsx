import { useEffect, useRef } from "react";
import type { PermissionMode } from "@shared/types.js";
import {
  Composer,
  RunBoundsConfirmation,
  TaskScopeTemplates,
  type RunBoundsPreview,
} from "./session-composer";
import type { ProjectEntry } from "./session-header";

/** 新建任务表单，可作为模态或首页嵌入式启动器。 */
export function NewTaskOverlay(props: {
  presentation?: "modal" | "home";
  newTaskEnv: "project" | "lobby";
  newTaskProject: string;
  projects: ProjectEntry[];
  permissionMode: PermissionMode;
  runBoundsPreview: RunBoundsPreview | null;
  submitting: boolean;
  message: string;
  runMode: boolean;
  workspaceMode: "project" | "isolated";
  onWorkspaceModeChange: (mode: "project" | "isolated") => void;
  onRunModeChange: (runMode: boolean) => void;
  planMode: boolean;
  onPlanModeChange: (planMode: boolean) => void;
  onEnvChange: (env: "project" | "lobby") => void;
  onProjectChange: (key: string) => void;
  onPermissionMode: (mode: PermissionMode) => void;
  onMessage: (text: string) => void;
  /** 模板填入：仅替换输入（不清除边界确认卡） */
  onPickTemplate: (text: string) => void;
  onSubmit: (
    boundsConfirmed?: boolean,
    steer?: boolean,
  ) => Promise<void>;
  onOpenProjectPicker: () => void;
  onClose: () => void;
  /** 取消边界确认：仅收起确认卡，面板保留（可继续编辑输入） */
  onCancelBounds: () => void;
}) {
  // 面板展开后聚焦输入框（模态居中，无需滚动）
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (props.presentation === "home") return;
    panelRef.current?.querySelector("textarea")?.focus();
  }, [props.presentation]);

  return (
    <section className={`new-task-panel${props.presentation === "home" ? " new-task-panel-home" : ""}`} ref={panelRef}>
      {props.presentation !== "home" && <button
        type="button"
        className="new-task-close"
        aria-label="关闭"
        onClick={props.onClose}
      >
        ×
      </button>}
      <div className="new-task-heading">
        <span className="new-session-mark">◆</span>
        <div>
          <p className="new-task-kicker">NEW TASK</p>
          <h2>让 MyAgent 帮你完成什么？</h2>
          <p>
            描述目标，执行方式和权限由你明确决定。
          </p>
        </div>
      </div>
      <Composer
        message={props.message}
        setMessage={props.onMessage}
        busy={false}
        submitting={props.submitting}
        selected={false}
        runMode={props.runMode}
        onRunModeChange={props.onRunModeChange}
        planMode={props.planMode}
        onPlanModeChange={props.onPlanModeChange}
        onSubmit={props.onSubmit}
      />
      <TaskScopeTemplates onPick={props.onPickTemplate} />
      <div className="new-task-options">
        <div className="new-task-section">
          <span className="new-task-section-label">执行位置</span>
          <div className="new-task-segmented" role="radiogroup" aria-label="执行位置">
            <label className={props.newTaskEnv === "project" ? "is-active" : ""}>
              <input type="radio" name="new-task-env" value="project" checked={props.newTaskEnv === "project"} onChange={() => props.onEnvChange("project")} />
              <span className="segment-title">项目</span>
              <span className="segment-desc">读写代码与运行命令</span>
            </label>
            <label className={props.newTaskEnv === "lobby" ? "is-active" : ""}>
              <input type="radio" name="new-task-env" value="lobby" checked={props.newTaskEnv === "lobby"} onChange={() => props.onEnvChange("lobby")} />
              <span className="segment-title">大厅</span>
              <span className="segment-desc">只读分析，不改文件</span>
            </label>
          </div>
        </div>
        {props.newTaskEnv === "project" && (
          <div className="new-task-project-row">
            <label className="new-task-project-select">
              <span>项目</span>
              <select value={props.newTaskProject} onChange={(event) => props.onProjectChange(event.target.value)}>
                {props.projects.filter((project) => project.key !== "lobby").map((project) => <option value={project.key} key={project.key}>{project.name}</option>)}
              </select>
            </label>
            <button type="button" className="env-open-other" onClick={props.onOpenProjectPicker}>打开其他项目</button>
            <label className="isolated-mode-toggle">
              <input aria-label="隔离执行" type="checkbox" checked={props.workspaceMode === "isolated"} onChange={(event) => props.onWorkspaceModeChange(event.target.checked ? "isolated" : "project")} />
              <span><strong>隔离执行</strong><small>使用独立 worktree，结果不自动合并</small></span>
            </label>
          </div>
        )}
        <div className="new-task-section permission-section">
          <span className="new-task-section-label">权限档</span>
          <div className="permission-choices" role="radiogroup" aria-label="权限档">
            {([
              ["normal", "标准", "需要时请求确认"],
              ["strict", "严格", "写操作均需确认"],
              ["trust", "信任", "适合无人值守"],
            ] as const).map(([mode, label, desc]) => (
              <label className={props.permissionMode === mode ? "is-active" : ""} key={mode}>
                <input type="radio" name="permission-mode" value={mode} checked={props.permissionMode === mode} onChange={() => props.onPermissionMode(mode)} />
                <span><strong>{label}</strong><small>{desc}</small></span>
              </label>
            ))}
          </div>
        </div>
      </div>
      {props.runBoundsPreview && (
        <RunBoundsConfirmation
          preview={props.runBoundsPreview}
          submitting={props.submitting}
          onConfirm={() => void props.onSubmit(true)}
          onCancel={props.onCancelBounds}
        />
      )}
    </section>
  );
}
