import type { AgentEvent, TodoItem } from "./types.js";

/**
 * 从会话事件流提取无人值守任务（/run）的收尾总结。
 *
 * 收尾总结不在 run_finished 事件里（事件只含 status/reason），而是
 * 任务收尾阶段最后一段助手文本（text_delta 合并）——本模块负责定位
 * 最后一次 run_started/run_finished 配对并提取：
 * - summary：收尾阶段最后一段助手文本（总结报告）
 * - todos：收尾前最后一次 todo_update 快照
 * - 时间范围 / 状态 / 原因
 */
export interface RunSummary {
  taskId: string;
  description: string;
  status: "completed" | "interrupted" | "failed";
  reason?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: string;
  todos: TodoItem[];
  acceptance?: {
    status: "passed" | "failed";
    attempts: number;
    checks: Array<{
      command: string;
      status: "passed" | "failed" | "timed_out";
      exitCode?: number;
      durationMs: number;
      output?: string;
    }>;
    review?: { passed: boolean; issues: string[]; summary: string };
  };
}

export function extractRunSummary(
  records: Array<{ ts: string; event: AgentEvent }>,
): RunSummary | undefined {
  // 定位最后一次 run_started / run_finished 配对（后一次 run_started 重置前者）
  let runStartIndex = -1;
  let runStartTaskId = "";
  let runStartDescription = "";
  let runFinish: {
    index: number;
    status: RunSummary["status"];
    reason?: string;
    ts: string;
  } | undefined;

  for (let index = 0; index < records.length; index += 1) {
    const event = records[index]?.event;
    if (!event) continue;
    if (event.type === "run_started") {
      runStartIndex = index;
      runStartTaskId = event.taskId;
      runStartDescription = event.description;
      runFinish = undefined;
    } else if (event.type === "run_finished") {
      runFinish = {
        index,
        status: event.status,
        ...(event.reason ? { reason: event.reason } : {}),
        ts: records[index]?.ts ?? "",
      };
    }
  }
  if (!runFinish || runStartIndex === -1) return undefined;

  // 总结 = run_finished 之前最后一段助手文本（向前合并完整 text_delta 段）
  let summary = "";
  for (let index = runFinish.index - 1; index >= runStartIndex; index -= 1) {
    const event = records[index]?.event;
    if (event?.type !== "text_delta") continue;
    let text = event.text;
    let cursor = index - 1;
    while (cursor >= runStartIndex) {
      const previous = records[cursor]?.event;
      if (previous?.type !== "text_delta") break;
      text = previous.text + text;
      cursor -= 1;
    }
    summary = text;
    break;
  }

  // todo 快照：run_finished 前最后一个 todo_update
  let todos: TodoItem[] = [];
  for (let index = runFinish.index - 1; index >= runStartIndex; index -= 1) {
    const event = records[index]?.event;
    if (event?.type !== "todo_update") continue;
    todos = event.todos;
    break;
  }

  const acceptanceEvents = records
    .slice(runStartIndex, runFinish.index + 1)
    .map((record) => record.event)
    .filter((event) => event.type === "acceptance_result");
  const latestAttempt = acceptanceEvents.reduce(
    (max, event) => event.type === "acceptance_result" ? Math.max(max, event.attempt) : max,
    0,
  );
  const latestAcceptanceEvents = acceptanceEvents.filter(
    (event) => event.type === "acceptance_result" && event.attempt === latestAttempt,
  );
  const reviewEvent = records
    .slice(runStartIndex, runFinish.index + 1)
    .map((record) => record.event)
    .reverse()
    .find((event) => event.type === "review_result");

  const startedAt = records[runStartIndex]?.ts ?? "";
  return {
    taskId: runStartTaskId,
    description: runStartDescription,
    status: runFinish.status,
    ...(runFinish.reason ? { reason: runFinish.reason } : {}),
    startedAt,
    finishedAt: runFinish.ts,
    durationMs: Math.max(0, Date.parse(runFinish.ts) - Date.parse(startedAt)),
    summary: summary.trim(),
    todos: structuredClone(todos),
    ...(acceptanceEvents.length > 0
      ? {
          acceptance: {
            status: latestAcceptanceEvents.every((event) => event.type === "acceptance_result" && event.status === "passed") ? "passed" as const : "failed" as const,
            attempts: latestAttempt,
            checks: latestAcceptanceEvents.map((event) => event.type === "acceptance_result" ? {
              command: event.command,
              status: event.status,
              ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
              durationMs: event.durationMs,
              ...(event.output ? { output: event.output } : {}),
            } : undefined).filter((value): value is NonNullable<typeof value> => value !== undefined),
            ...(reviewEvent?.type === "review_result" ? { review: reviewEvent } : {}),
          },
        }
      : {}),
  };
}
