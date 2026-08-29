import { useEffect, useRef } from "react";
import type { PermissionMode } from "@shared/types.js";
import {
  Composer,
  RunBoundsConfirmation,
  TaskScopeTemplates,
  type RunBoundsPreview,
} from "./session-composer";
import type { ProjectEntry } from "./session-header";

/** 新建会话模态面板：执行环境（项目/大厅）+ 权限档 + 边界确认 + 模板与输入 */
export function NewTaskOverlay(props: {
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
    panelRef.current?.querySelector("textarea")?.focus();
  }, []);

  return (
    <section className="new-task-panel" ref={panelRef}>
      <button
        type="button"
        className="new-task-close"
        aria-label="关闭"
        onClick={props.onClose}
      >
        ×
      </button>
      <div>
        <span className="new-session-mark">◆</span>
        <div>
          <h2>今天想让 MyAgent 做什么？</h2>
          <p>
            先告诉 MyAgent 你想完成什么；它会先理解任务，再请你确认执行方案。
          </p>
        </div>
      </div>
      <div className="new-task-env">
        <label
          className={`env-card ${props.newTaskEnv === "project" ? "env-card-active" : ""}`}
        >
          <input
            type="radio"
            name="new-task-env"
            checked={props.newTaskEnv === "project"}
            onChange={() => props.onEnvChange("project")}
          />
          <span className="env-card-icon">📁</span>
          <span className="env-card-title">在项目下执行</span>
          <span className="env-card-desc">
            可读写文件、执行命令，适合修改代码
          </span>
          {props.newTaskEnv === "project" && (
            <span className="env-card-extra">
              <select
                className="env-project-select"
                value={props.newTaskProject}
                onChange={(event) =>
                  props.onProjectChange(event.target.value)
                }
              >
                {props.projects
                  .filter((project) => project.key !== "lobby")
                  .map((project) => (
                    <option value={project.key} key={project.key}>
                      {project.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="env-open-other"
                onClick={props.onOpenProjectPicker}
              >
                打开其他项目…
              </button>
            </span>
          )}
          {props.newTaskEnv === "project" && (
            <span className="isolated-mode-toggle">
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
              <span>
                <strong>隔离执行</strong>{" "}
                <small>
                  Agent 只修改独立 Git worktree，结果不会自动合并
                  {props.runMode ? " · 无人值守推荐" : ""}
                </small>
              </span>
            </span>
          )}
        </label>
        <label
          className={`env-card ${props.newTaskEnv === "lobby" ? "env-card-active" : ""}`}
        >
          <input
            type="radio"
            name="new-task-env"
            checked={props.newTaskEnv === "lobby"}
            onChange={() => props.onEnvChange("lobby")}
          />
          <span className="env-card-icon">💬</span>
          <span className="env-card-title">在大厅执行</span>
          <span className="env-card-desc">
            不修改任何文件，可读取你提供的文件做分析
          </span>
        </label>
      </div>
      <label>
        权限档
        <select
          value={props.permissionMode}
          onChange={(event) =>
            props.onPermissionMode(
              event.target.value as PermissionMode,
            )
          }
        >
          <option value="normal">
            normal · 推荐
          </option>
          <option value="strict">
            strict · 写操作均审批
          </option>
          <option value="trust">
            trust · 无人值守
          </option>
        </select>
      </label>
      {props.runBoundsPreview && (
        <RunBoundsConfirmation
          preview={props.runBoundsPreview}
          submitting={props.submitting}
          onConfirm={() => void props.onSubmit(true)}
          onCancel={props.onCancelBounds}
        />
      )}
      <TaskScopeTemplates onPick={props.onPickTemplate} />
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
    </section>
  );
}
