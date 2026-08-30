/** /run 任务边界确认弹卡的展示数据（preview API 响应） */
export interface RunBoundsPreview {
  hardRules: Array<{ effect: "deny"; pattern: string }>;
  semanticBounds: string[];
  checks?: string[];
  checkTimeoutMs?: number;
}

/** 范围建议模板（参照生产测试：有界任务完成率/速度显著优于无界任务） */
export const TASK_SCOPE_TEMPLATES: Array<{ label: string; text: string }> = [
  {
    label: "只读分析",
    text: "阅读以下文件并分析：<文件列表>。不要修改任何文件，不要运行命令。",
  },
  {
    label: "修复缺陷",
    text: "先运行相关测试复现失败（<测试文件>），定位并修复实现中的问题。只修改实现文件，不要修改测试文件。",
  },
  {
    label: "实现功能",
    text: "在 <目录> 实现 <功能>，并补充单元测试。只改动该目录内的文件，不要探索其他目录。",
  },
  {
    label: "写文档",
    text: "写出 <文档路径>（约 600 字，精炼为主）。只阅读 <文件列表>，不要运行命令，写完立即结束。",
  },
];

export function TaskScopeTemplates(props: {
  onPick: (text: string) => void;
}) {
  return (
    <div className="task-scope-templates">
      <span className="task-scope-label">范围建议（点击填入，可再编辑）</span>
      <span className="task-scope-buttons">
        {TASK_SCOPE_TEMPLATES.map((template) => (
          <button
            type="button"
            key={template.label}
            className="task-scope-button"
            onClick={() => props.onPick(template.text)}
          >
            {template.label}
          </button>
        ))}
      </span>
    </div>
  );
}

export function Composer(props: {
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  message: string;
  setMessage: (message: string) => void;
  busy: boolean;
  waitingUser?: boolean;
  submitting: boolean;
  selected: boolean;
  /** 无人值守任务模式：提交时自动加 /run 前缀（走任务边界确认链路） */
  runMode: boolean;
  onRunModeChange: (runMode: boolean) => void;
  /** 先只读探索生成计划，批准后才进入同会话执行。 */
  planMode: boolean;
  onPlanModeChange: (planMode: boolean) => void;
  onSubmit: (
    boundsConfirmed?: boolean,
    steer?: boolean,
  ) => Promise<void>;
}) {
  return (
    <div className="web-composer">
      <textarea
        ref={props.textareaRef}
        value={props.message}
        onChange={(event) =>
          props.setMessage(event.target.value)
        }
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            // Shift+Enter：插队打断（当前工具完成后转向）；否则普通排队
            void props.onSubmit(
              false,
              props.busy && event.shiftKey,
            );
          }
        }}
        placeholder={
          props.selected
            ? props.waitingUser
              ? "回答上方问题，或在这里输入你自己的选择"
              : props.busy
              ? "发消息给 MyAgent…（自动排队，⌘⇧Enter 插队打断，Esc 硬打断）"
              : "继续发消息给 MyAgent…"
            : "例如：检查这个项目，修复当前失败的测试"
        }
        rows={3}
      />
      <div className="composer-footer">
        <label
          className="run-mode-toggle"
          title="开启后以无人值守任务运行（自动加 /run，可设边界/预算/截止）"
        >
          <input
            type="checkbox"
            checked={props.runMode}
            disabled={props.waitingUser}
            onChange={(event) =>
              props.onRunModeChange(event.target.checked)
            }
          />
          无人值守任务
        </label>
        <label
          className="run-mode-toggle plan-mode-toggle"
          title="先只读探索并生成计划，再通过弹窗批准、修改或仅保留分析"
        >
          <input
            type="checkbox"
            checked={props.planMode}
            disabled={props.waitingUser}
            onChange={(event) =>
              props.onPlanModeChange(event.target.checked)
            }
          />
          先理解再执行
        </label>
        <span>
          {props.waitingUser
            ? "等待你的明确回答，不会自动选择"
            : props.busy
            ? "排队发送 · 插队打断会中断剩余工具调用"
            : "⌘/Ctrl + Enter 发送"}
        </span>
        {props.busy && !props.waitingUser && (
          <button
            className="save-button"
            onClick={() => void props.onSubmit(false, true)}
            disabled={
              props.submitting || !props.message.trim()
            }
          >
            插队打断
          </button>
        )}
        <button
          className="save-button"
          onClick={() => void props.onSubmit()}
          disabled={
            props.submitting || !props.message.trim()
          }
        >
          {props.submitting
            ? "发送中…"
            : props.waitingUser
              ? "回答并继续"
            : props.planMode
              ? "让 MyAgent 理解任务"
              : props.runMode
              ? "启动任务"
              : props.selected
                ? props.busy
                  ? "排队发送"
                  : "发送"
                : "启动任务"}
        </button>
      </div>
    </div>
  );
}

export function RunBoundsConfirmation(props: {
  preview: RunBoundsPreview;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="run-bounds-card" aria-label="确认任务边界">
      <div className="run-bounds-heading">
        <span>!</span>
        <div>
          <strong>启动前确认任务边界</strong>
          <p>
            启动前确认任务边界与机器验收配置。
          </p>
        </div>
      </div>
      {(props.preview.checks ?? []).length > 0 && (
        <div className="run-bound-rules">
          <strong>机器验收命令：</strong>
          {(props.preview.checks ?? []).map((check) => <code key={check}>check · {check}</code>)}
          <small>单项超时：{Math.round((props.preview.checkTimeoutMs ?? 300000) / 1000)} 秒</small>
        </div>
      )}
      <div className="run-bound-rules">
        {props.preview.hardRules.map((rule) => (
          <code key={rule.pattern}>deny · {rule.pattern}</code>
        ))}
      </div>
      {props.preview.semanticBounds.length > 0 && (
        <p className="semantic-bound">
          语义约束（由 Agent 遵守，无法通过路径规则完全保证）：
          {props.preview.semanticBounds.join("；")}
        </p>
      )}
      <div className="run-bounds-actions">
        <button onClick={props.onCancel}>返回修改</button>
        <button
          className="save-button"
          onClick={props.onConfirm}
          disabled={props.submitting}
        >
          {props.submitting ? "启动中…" : "确认并启动"}
        </button>
      </div>
    </section>
  );
}
import type { RefObject } from "react";
