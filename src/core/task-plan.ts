import type { AgentEvent, RecordedEvent } from "./types.js";

export type TaskPlanStatus =
  | "planning"
  | "awaiting_approval"
  | "approved"
  | "revision_requested"
  | "analysis_only"
  | "failed";

export interface TaskPlanState {
  planId: string;
  task: string;
  revision: number;
  status: TaskPlanStatus;
  content?: string;
  feedback?: string;
  error?: string;
}

export type TaskPlanSummary = Omit<
  TaskPlanState,
  "content" | "feedback" | "error"
>;

/**
 * 事件流投影出当前任务计划。旧会话没有计划事件时返回 undefined；
 * 不属于当前 planId 的迟到决定会被忽略，避免并发/坏事件污染恢复状态。
 */
export function taskPlanFromEvents(
  records: readonly Pick<RecordedEvent, "event">[],
): TaskPlanState | undefined {
  let state: TaskPlanState | undefined;
  for (const { event } of records) {
    if (event.type === "plan_started") {
      state = {
        planId: event.planId,
        task: event.task,
        revision: event.revision,
        status: "planning",
      };
      continue;
    }
    if (
      event.type !== "plan_proposed" &&
      event.type !== "plan_decision" &&
      event.type !== "plan_failed"
    ) {
      continue;
    }
    if (!state || event.planId !== state.planId) continue;
    if (event.type === "plan_proposed") {
      state = {
        planId: event.planId,
        task: event.task,
        revision: event.revision,
        status: "awaiting_approval",
        content: event.content,
      };
      continue;
    }
    if (event.type === "plan_decision") {
      state = {
        ...state,
        status: event.decision,
        ...(event.feedback ? { feedback: event.feedback } : {}),
      };
      continue;
    }
    if (event.type === "plan_failed") {
      state = {
        ...state,
        revision: event.revision,
        status: "failed",
        error: event.message,
      };
    }
  }
  return state;
}

export function taskPlanSummary(
  state: TaskPlanState | undefined,
): TaskPlanSummary | undefined {
  if (!state) return undefined;
  return {
    planId: state.planId,
    task: state.task,
    revision: state.revision,
    status: state.status,
  };
}

export type PlanDecision = Extract<
  AgentEvent,
  { type: "plan_decision" }
>["decision"];
