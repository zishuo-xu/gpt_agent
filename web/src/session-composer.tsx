import { useState, type ReactNode, type RefObject } from "react";

/** /run 任务边界确认弹卡的展示数据（preview API 响应） */
export interface RunBoundsPreview {
  hardRules: Array<{ effect: "deny"; pattern: string }>;
  semanticBounds: string[];
  checks?: string[];
  checkTimeoutMs?: number;
}

/** 会话内斜杠命令（参照 Codex/Claude Code 的命令面板）：本地执行，不发送给模型 */
export interface SlashCommand {
  name: string;
  desc: string;
  run: () => void;
}

/** 输入是否处于斜杠查询态：/ 开头、尚未出现空格（命令名 [\w-]） */
export function isSlashQuery(value: string): boolean {
  return /^\/[\w-]*$/.test(value.trim());
}

/** 按查询前缀过滤命令：query 含首字符 /（如 "/co" 匹配 "/cost"） */
export function matchSlashCommands(
  query: string,
  commands: SlashCommand[],
): SlashCommand[] {
  const prefix = query.replace(/^\//, "").toLowerCase();
  return commands.filter((command) =>
    command.name.toLowerCase().startsWith(`/${prefix}`),
  );
}

/** 输入框（设计稿形态）：大文本域 + 底栏 [footerLeading…] [模式开关] [发送]
 *  variant="hero" 用于首页大输入框（字数统计、绿色发送按钮、Enter 发送）。
 *  传入 slashCommands 后，输入 "/" 前缀弹出命令面板（↑↓ 选择，Enter/Tab 执行）。 */
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
  slashCommands?: SlashCommand[];
}) {
  const hero = props.variant === "hero";
  const maxLength = 2000;
  // 斜杠命令面板：可见性直接派生自受控输入（/ 查询态 + 有注册命令），
  // Esc 显式关闭后（dismissed）继续输入即恢复
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashOpen =
    !slashDismissed &&
    isSlashQuery(props.message) &&
    (props.slashCommands?.length ?? 0) > 0;
  const slashMatches = slashOpen
    ? matchSlashCommands(props.message, props.slashCommands ?? [])
    : [];
  const slashOpenFinal = slashOpen && slashMatches.length > 0;
  const slashIndexSafe = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));

  function syncSlash() {
    setSlashDismissed(false);
    setSlashIndex(0);
  }

  function runSlash(command: SlashCommand) {
    setSlashDismissed(true);
    props.setMessage("");
    command.run();
  }

  return (
    <div className={`web-composer${hero ? " web-composer-hero" : ""}`}>
      <textarea
        ref={props.textareaRef}
        value={props.message}
        maxLength={maxLength}
        onChange={(event) => {
          props.setMessage(event.target.value);
          syncSlash();
        }}
        onKeyDown={(event) => {
          if (slashOpenFinal) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSlashIndex((index) => (index + 1) % slashMatches.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setSlashIndex(
                (index) => (index - 1 + slashMatches.length) % slashMatches.length,
              );
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              if (!event.nativeEvent.isComposing) {
                runSlash(slashMatches[slashIndexSafe]!);
              }
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setSlashDismissed(true);
              return;
            }
          }
          if (hero) {
            // 首页：Enter 发送，Shift+Enter 换行；超限时吞掉 Enter（计数器已标红提示）
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (props.message.length <= maxLength) void props.onSubmit();
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
                ? "发消息给 MyAgent…（自动排队，⌘⇧Enter 插队打断，Esc 硬打断，/ 唤出命令）"
                : "继续输入需求，或输入 / 查看命令…"
            : "例如：检查这个项目，修复当前失败的测试"
        }
        rows={hero ? 5 : 2}
      />
      {slashOpenFinal && (
        <div className="slash-menu" role="listbox" aria-label="可用命令">
          {slashMatches.map((command, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === slashIndex}
              className={`slash-item${index === slashIndex ? " selected" : ""}`}
              key={command.name}
              onClick={() => runSlash(command)}
            >
              <code>{command.name}</code>
              <span>{command.desc}</span>
            </button>
          ))}
        </div>
      )}
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
        <span
          className={
            props.message.length > maxLength
              ? "composer-hint composer-hint-over"
              : "composer-hint"
          }
        >
          {hero
            ? `${props.message.length}/${maxLength}`
            : props.waitingUser
              ? "等待你的回答"
              : props.busy
                ? "发送将排队 · Esc 中止"
                : ""}
        </span>
        <button
          className={`save-button composer-send${props.submitting ? "" : " is-idle"}`}
          aria-label={props.selected ? (props.waitingUser ? "回答并继续" : "发送") : "发送"}
          onClick={() => void props.onSubmit()}
          // 超限禁发：textarea 的 maxLength 只拦真实键入，粘贴/程序化路径可绕过
          disabled={
            props.submitting ||
            !props.message.trim() ||
            props.message.length > maxLength
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
