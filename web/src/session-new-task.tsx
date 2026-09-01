import { useEffect, useRef } from "react";
import type { PermissionMode } from "@shared/types.js";
import {
  Composer,
  RunBoundsConfirmation,
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
    <section
      className={`new-task-panel${props.presentation === "home" ? " new-task-panel-home" : ""}`}
      ref={panelRef}
    >
      {props.presentation !== "home" && (
        <button
          type="button"
          className="new-task-close"
          aria-label="关闭"
          onClick={props.onClose}
        >
          ×
        </button>
      )}
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
        showModes={props.presentation !== "home"}
        onSubmit={props.onSubmit}
      />
      <div className="new-task-context-row" aria-label="任务上下文">
        <label>
          <span>位置</span>
          <select
            value={props.newTaskEnv === "lobby" ? "lobby" : props.newTaskProject}
            onChange={(event) => {
              const key = event.target.value;
              if (key === "lobby") {
                props.onEnvChange("lobby");
              } else {
                props.onEnvChange("project");
                props.onProjectChange(key);
              }
            }}
          >
            <option value="lobby">大厅（只读）</option>
            <optgroup label="项目">
              {props.projects
                .filter((project) => project.key !== "lobby")
                .map((project) => (
                  <option value={project.key} key={project.key}>
                    {project.name}
                  </option>
                ))}
            </optgroup>
          </select>
        </label>
        <label>
          <span>权限</span>
          <select
            value={props.permissionMode}
            onChange={(event) =>
              props.onPermissionMode(event.target.value as PermissionMode)
            }
          >
            <option value="normal">标准</option>
            <option value="strict">严格</option>
            <option value="trust">信任</option>
          </select>
        </label>
      </div>
      <details className="new-task-options">
        <summary>任务选项</summary>
        <div className="new-task-options-grid">
          <label className="compact-check">
            <input
              type="checkbox"
              checked={props.runMode}
              disabled={props.submitting}
              onChange={(event) => props.onRunModeChange(event.target.checked)}
            />
            <span><strong>无人值守任务</strong><small>自动执行到完成</small></span>
          </label>
          <label className="compact-check">
            <input
              type="checkbox"
              checked={props.planMode}
              disabled={props.submitting}
              onChange={(event) => props.onPlanModeChange(event.target.checked)}
            />
            <span><strong>先理解再执行</strong><small>先生成计划，确认后执行</small></span>
          </label>
          {props.newTaskEnv === "project" && (
            <>
              <label className="compact-check">
                <input
                  aria-label="隔离执行"
                  type="checkbox"
                  checked={props.workspaceMode === "isolated"}
                  onChange={(event) =>
                    props.onWorkspaceModeChange(
                      event.target.checked ? "isolated" : "project",
                    )
                  }
                />
                <span><strong>隔离执行</strong><small>使用独立 worktree，不自动合并</small></span>
              </label>
              <button
                type="button"
                className="env-open-other"
                onClick={props.onOpenProjectPicker}
              >
                打开其他项目
              </button>
            </>
          )}
        </div>
      </details>
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
