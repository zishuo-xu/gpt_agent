import type { ReactNode, RefObject } from "react";

/** /run 任务边界确认弹卡的展示数据（preview API 响应） */
export interface RunBoundsPreview {
  hardRules: Array<{ effect: "deny"; pattern: string }>;
  semanticBounds: string[];
  checks?: string[];
  checkTimeoutMs?: number;
}

/** 输入框（设计稿形态）：大文本域 + 底栏 [footerLeading…] [模式开关] [发送]
 *  variant="hero" 用于首页大输入框（字数统计、绿色发送按钮、Enter 发送）。 */
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
  showModes?: boolean;
  /** 首页大输入框形态 */
  variant?: "default" | "hero";
  footerLeading?: ReactNode;
  onSubmit: (
    boundsConfirmed?: boolean,
    steer?: boolean,
  ) => Promise<void>;
}) {
  const hero = props.variant === "hero";
  const maxLength = 2000;
  return (
    <div className={`web-composer${hero ? " web-composer-hero" : ""}`}>
      <textarea
        ref={props.textareaRef}
        value={props.message}
        maxLength={maxLength}
        onChange={(event) =>
          props.setMessage(event.target.value)
        }
        onKeyDown={(event) => {
          if (hero) {
            // 首页：Enter 发送，Shift+Enter 换行
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void props.onSubmit();
            }
            return;
          }
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
                : "继续输入需求，或询问进度、提出调整…"
            : "例如：检查这个项目，修复当前失败的测试"
        }
        rows={hero ? 5 : 2}
      />
      <div className="composer-footer">
        {props.footerLeading}
        {props.showModes !== false && !props.waitingUser && (
          <>
            <label className="run-mode-toggle" title="开启后以无人值守任务运行">
              <input
                type="checkbox"
                checked={props.runMode}
                disabled={props.waitingUser}
                onChange={(event) => props.onRunModeChange(event.target.checked)}
              />
              无人值守任务
            </label>
            <label className="run-mode-toggle plan-mode-toggle" title="先只读探索并生成计划，确认后再执行">
              <input
                type="checkbox"
                checked={props.planMode}
                disabled={props.waitingUser}
                onChange={(event) => props.onPlanModeChange(event.target.checked)}
              />
              先规划（先理解再执行）
            </label>
          </>
        )}
        <span className="composer-hint">
          {hero
            ? `${props.message.length}/${maxLength}`
            : props.waitingUser
              ? "等待你的回答"
              : props.busy
                ? "发送将排队 · Esc 中止"
                : ""}
        </span>
        <button
          className="save-button composer-send"
          aria-label={props.selected ? (props.waitingUser ? "回答并继续" : "发送") : "发送"}
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
                    : (
                      <>
                        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                          <path d="M12.5 1.5 6.75 7.25M12.5 1.5 8.75 12.5l-2-5.25-5.25-2L12.5 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        发送
                      </>
                    )}
        </button>
      </div>
      {hero && (
        <p className="composer-enter-hint" aria-hidden="true">按 Enter 发送</p>
      )}
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
