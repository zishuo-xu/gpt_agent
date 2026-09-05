import { useEffect, useRef } from "react";
import type { PermissionMode } from "@shared/types.js";
import {
  Composer,
  RunBoundsConfirmation,
  type RunBoundsPreview,
} from "./session-composer";
import type { ProjectEntry } from "./session-header";

/** 首页示例快捷入口（设计稿「试试这些示例」） */
const EXAMPLE_PROMPTS = [
  { icon: "🔧", label: "修复问题", prompt: "定位并修复当前项目里最紧要的一个问题，并验证修复结果" },
  { icon: "🧪", label: "补充测试", prompt: "为核心模块补充缺失的单元测试，覆盖正常与异常路径" },
  { icon: "📖", label: "理解项目", prompt: "通读这个项目，给我讲清楚整体架构和关键模块的职责" },
  { icon: "🧱", label: "重构模块", prompt: "挑一个复杂度最高的模块做重构，保持行为不变并让测试通过" },
] as const;

/** 新建任务表单，可作为模态或首页嵌入式启动器（设计稿首页：大标题 + 大输入框）。 */
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

  const home = props.presentation === "home";

  // 首页形态：输入框与「任务选项」同级，结构为 .new-task-panel > .new-task-options，
  // 因此 e2e 用 .new-task-panel .plan-mode-toggle input 也能选中。modal 形态结构相同。
  const footerControls = (
    <>
      {home ? (
        <select
          className="composer-project-chip"
          value={props.newTaskEnv === "lobby" ? "lobby" : props.newTaskProject}
          onChange={(event) => {
            const key = event.target.value;
            if (key === "lobby") props.onEnvChange("lobby");
            else {
              props.onEnvChange("project");
              props.onProjectChange(key);
            }
          }}
          aria-label="任务位置"
          title="选择任务所在项目"
        >
          <option value="lobby">大厅（只读）</option>
          {props.projects.filter((project) => project.key !== "lobby").map((project) => (
            <option value={project.key} key={project.key}>{project.name}</option>
          ))}
        </select>
      ) : (
        <div className="new-task-context-row" aria-label="任务上下文">
          <label>
            <span>位置</span>
            <select
              value={props.newTaskEnv === "lobby" ? "lobby" : props.newTaskProject}
              onChange={(event) => {
                const key = event.target.value;
                if (key === "lobby") props.onEnvChange("lobby");
                else {
                  props.onEnvChange("project");
                  props.onProjectChange(key);
                }
              }}
            >
              <option value="lobby">大厅（只读）</option>
              <optgroup label="项目">
                {props.projects.filter((project) => project.key !== "lobby").map((project) => (
                  <option value={project.key} key={project.key}>{project.name}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            <span>权限</span>
            <select value={props.permissionMode} onChange={(event) => props.onPermissionMode(event.target.value as PermissionMode)}>
              <option value="normal">标准</option>
              <option value="strict">严格</option>
              <option value="trust">信任</option>
            </select>
          </label>
        </div>
      )}
    </>
  );

  /** 「任务选项」折叠条：权限、隔离执行、超时设置等 */
  const optionsDetails = (
    <details className="new-task-options">
      <summary>
        <span className="new-task-options-icon" aria-hidden="true">☰</span>
        任务选项
        <span className="new-task-options-hint">权限、隔离执行、超时设置等</span>
      </summary>
      <div className="new-task-options-grid">
        <label className="compact-check">
          <input type="checkbox" checked={props.runMode} disabled={props.submitting} onChange={(event) => props.onRunModeChange(event.target.checked)} />
          <span><strong>无人值守任务</strong><small>自动执行到完成</small></span>
        </label>
        <label className="compact-check">
          <input type="checkbox" checked={props.planMode} disabled={props.submitting} onChange={(event) => props.onPlanModeChange(event.target.checked)} />
          <span><strong>先规划</strong><small>先生成计划，确认后执行</small></span>
        </label>
        <label className="compact-check compact-select">
          <span><strong>权限档</strong></span>
          <select
            aria-label="权限档"
            value={props.permissionMode}
            onChange={(event) => props.onPermissionMode(event.target.value as PermissionMode)}
          >
            <option value="normal">标准</option>
            <option value="strict">严格</option>
            <option value="trust">信任</option>
          </select>
        </label>
        {props.newTaskEnv === "project" && (
          <>
            <label className="compact-check">
              <input aria-label="隔离执行" type="checkbox" checked={props.workspaceMode === "isolated"} onChange={(event) => props.onWorkspaceModeChange(event.target.checked ? "isolated" : "project")} />
              <span><strong>隔离执行</strong><small>使用独立 worktree，不自动合并</small></span>
            </label>
            <button type="button" className="env-open-other" onClick={props.onOpenProjectPicker}>打开其他项目</button>
          </>
        )}
      </div>
    </details>
  );

  return (
    <section
      className={`new-task-panel${home ? " new-task-panel-home" : ""}`}
      ref={panelRef}
    >
      {!home && (
        <button
          type="button"
          className="new-task-close"
          aria-label="关闭"
          onClick={props.onClose}
        >
          ×
        </button>
      )}
      {!home && (
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
      )}
      {home && (
        <div className="home-hero">
          <h1 className="home-hero-title">今天想完成什么？</h1>
          <p className="home-hero-sub">告诉 MyAgent 你的目标，它会帮你完成并验证。</p>
        </div>
      )}
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
        showModes
        variant={home ? "hero" : "default"}
        footerLeading={footerControls}
        onSubmit={props.onSubmit}
      />
      {home && optionsDetails}
      {home && (
        <div className="home-examples">
          <p className="home-examples-label">试试这些示例</p>
          <div className="home-examples-row">
            {EXAMPLE_PROMPTS.map((example) => (
              <button
                key={example.label}
                type="button"
                className="home-example-chip"
                onClick={() => props.onMessage(example.prompt)}
              >
                <span aria-hidden="true">{example.icon}</span>
                {example.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {!home && optionsDetails}
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
