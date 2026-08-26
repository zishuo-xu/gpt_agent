import { RichText } from "./session-rich-text";

export interface TaskPlanDetail {
  planId: string;
  task: string;
  revision: number;
  status: "planning" | "awaiting_approval" | "approved" | "revision_requested" | "analysis_only" | "failed";
  content?: string;
  feedback?: string;
  error?: string;
}

/** 人在闭环中的计划决策弹窗：计划本身只读，三种出口均显式。 */
export function PlanDecisionOverlay(props: {
  plan: TaskPlanDetail;
  feedback: string;
  submitting: boolean;
  onFeedback: (value: string) => void;
  onDecision: (
    decision: "approved" | "revision_requested" | "analysis_only",
    feedback?: string,
  ) => Promise<void>;
}) {
  return (
    <div className="plan-decision-overlay">
      <section
        className="plan-decision-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-decision-title"
      >
        <header className="plan-decision-header">
          <div>
            <span className="plan-decision-kicker">只读规划 · 第 {props.plan.revision} 版</span>
            <h2 id="plan-decision-title">计划已就绪，请选择下一步</h2>
            <p>规划阶段仅使用 Read、Grep、Glob，没有修改当前工作区。</p>
          </div>
          <span className="plan-readonly-badge">只读</span>
        </header>

        <div className="plan-task">原始任务：{props.plan.task}</div>
        <div className="plan-content">
          <RichText text={props.plan.content ?? "计划正文暂不可用。"} />
        </div>

        <label className="plan-feedback">
          修改意见（选择“修改计划”时必填）
          <textarea
            value={props.feedback}
            onChange={(event) => props.onFeedback(event.target.value)}
            placeholder="例如：不要修改公开 API；把验证方式改为 pnpm test。"
            rows={3}
          />
        </label>

        <div className="plan-decision-actions">
          <button
            type="button"
            disabled={props.submitting}
            onClick={() => void props.onDecision("analysis_only")}
          >
            仅保留分析
          </button>
          <button
            type="button"
            disabled={props.submitting || !props.feedback.trim()}
            onClick={() =>
              void props.onDecision("revision_requested", props.feedback)
            }
          >
            修改计划
          </button>
          <button
            type="button"
            className="save-button"
            disabled={props.submitting}
            onClick={() => void props.onDecision("approved")}
          >
            {props.submitting ? "提交中…" : "批准并开始执行"}
          </button>
        </div>
      </section>
    </div>
  );
}
