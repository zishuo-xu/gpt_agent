/** /run 任务边界确认弹卡的展示数据（preview API 响应） */
export interface RunBoundsPreview {
  hardRules: Array<{ effect: "deny"; pattern: string }>;
  semanticBounds: string[];
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
  message: string;
  setMessage: (message: string) => void;
  busy: boolean;
  submitting: boolean;
  selected: boolean;
  /** 无人值守任务模式：提交时自动加 /run 前缀（走任务边界确认链路） */
  runMode: boolean;
  onRunModeChange: (runMode: boolean) => void;
  onSubmit: (
    boundsConfirmed?: boolean,
    steer?: boolean,
  ) => Promise<void>;
}) {
  return (
    <div className="web-composer">
      <textarea
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
            ? props.busy
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
            onChange={(event) =>
              props.onRunModeChange(event.target.checked)
            }
          />
          无人值守任务
        </label>
        <span>
          {props.busy
            ? "排队发送 · 插队打断会中断剩余工具调用"
            : "⌘/Ctrl + Enter 发送"}
        </span>
        {props.busy && (
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
            下列路径规则将在本次任务期间作为不可绕过的 deny
            规则。
          </p>
        </div>
      </div>
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
