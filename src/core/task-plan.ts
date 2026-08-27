import { createHash } from "node:crypto";
import type { AgentEvent, PlanExecutionUnit, RecordedEvent } from "./types.js";

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
  digest?: string;
  units?: PlanExecutionUnit[];
}

export type TaskPlanSummary = Omit<
  TaskPlanState,
  "content" | "feedback" | "error" | "digest" | "units"
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
        ...(event.digest ? { digest: event.digest } : {}),
        ...(event.units ? { units: event.units.map((unit) => ({ ...unit })) } : {}),
      };
      continue;
    }
    if (event.type === "plan_decision") {
      // 新事件必须绑定当前提案的 revision/digest；旧事件无绑定字段时保持兼容。
      if (event.revision !== undefined && event.revision !== state.revision) continue;
      if (event.digest !== undefined && event.digest !== state.digest) continue;
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

/** 规划阶段唯一允许暴露和执行的工具。Bash 即使执行只读命令也不进入首版边界。 */
export const PLAN_TOOL_NAMES = ["Read", "Grep", "Glob"] as const;

export function buildTaskPlanningPrompt(options: {
  task: string;
  previousPlan?: string;
  feedback?: string;
}): string {
  const revision = options.previousPlan
    ? `\n\n这是上一版计划：\n${options.previousPlan}\n\n用户的修改意见：\n${options.feedback ?? "请进一步完善计划。"}`
    : "";
  return `你现在处于 MyAgent 的只读规划阶段。请先探索当前项目，再为下面的任务提出可执行计划；不要修改任何文件，也不要运行 Bash 或其他可能写入状态的工具。只可使用 Read、Grep、Glob。\n\n用户任务：\n${options.task}${revision}\n\n最终回答必须是 Markdown，并严格包含以下二级标题：\n## 目标\n## 执行步骤\n## 预计修改文件\n## 验证方式\n## 风险与待确认\n\n“执行步骤”中的每一步必须使用单行有序列表（如 1. 修改实现），以便批准后逐步跟踪。计划应引用关键的 file:line 证据，明确不会在用户批准前执行修改。只输出最终计划，不要附加寒暄。`;
}

/** 计划内容的稳定摘要；批准事件用它绑定用户看到的确切提案。 */
export function taskPlanDigest(revision: number, content: string): string {
  return createHash("sha256")
    .update(`${revision}\n${content}`, "utf8")
    .digest("hex");
}

/** 从执行步骤标题下提取稳定的编号/项目列表，保留原 Markdown 展示。 */
export function extractPlanExecutionUnits(content: string): PlanExecutionUnit[] {
  const lines = content.split("\n");
  const heading = lines.findIndex((line) =>
    /^##\s+执行步骤\s*$/.test(line.trim()),
  );
  if (heading < 0) return [];
  const units: PlanExecutionUnit[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    const item = line.trim().match(/^(?:\d+[.)]|[-*+])\s+(.+?)\s*$/);
    if (!item?.[1]) continue;
    units.push({ id: `plan-step-${units.length + 1}`, content: item[1] });
  }
  return units;
}

export function buildApprovedPlanPrompt(task: string, plan: string): string {
  return `用户已经批准下面的执行计划。现在在同一会话中实施任务；计划是执行依据，但若现场证据与计划冲突，应先说明并采用更安全的最小调整。不要停留在复述计划，完成修改并运行相关验证。\n\n原始任务：\n${task}\n\n已批准计划：\n${plan}`;
}

/** 流式模型偶尔会在最终计划前输出短前言，保留最后一个结构化计划块。 */
export function normalizePlanText(text: string): string {
  const trimmed = text.trim();
  const marker = "## 目标";
  const index = trimmed.lastIndexOf(marker);
  return index < 0 ? trimmed : trimmed.slice(index).trim();
}
