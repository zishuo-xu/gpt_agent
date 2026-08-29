import type { AgentEvent, RecordedEvent } from "./types.js";
import type {
  DeliveryOutcome,
  DeliveryProjection,
  DeliveryReview,
  DeliveryVerification,
  SessionStatus,
} from "../shared/types.js";

export type {
  DeliveryCheck,
  DeliveryOutcome,
  DeliveryProjection,
  DeliveryReview,
  DeliveryVerification,
} from "../shared/types.js";

/** Rebuilds the user-facing delivery package solely from the persisted event stream. */
export function projectDelivery(
  records: RecordedEvent[],
  options: { title?: string; status?: SessionStatus } = {},
): DeliveryProjection {
  let start = -1;
  let taskId: string | undefined;
  let title = "";
  let goal: string | undefined;
  let finish: Extract<AgentEvent, { type: "run_finished" }> | undefined;
  let finishIndex = -1;
  for (let i = 0; i < records.length; i += 1) {
    const event = records[i]?.event;
    if (event?.type === "run_started") {
      start = i;
      taskId = event.taskId;
      title = event.description;
      goal = event.taskOptions?.goal;
      finish = undefined;
      finishIndex = -1;
    } else if (
      event?.type === "run_finished" &&
      start >= 0 &&
      event.taskId === taskId
    ) {
      finish = event; finishIndex = i;
    }
  }
  const from = start >= 0
    ? records.slice(start, finishIndex >= 0 ? finishIndex + 1 : undefined)
    : records;
  const calls = new Map<string, string>();
  const files = new Set<string>();
  for (const record of from) {
    const event = record.event;
    if (
      event.type === "tool_call" &&
      ["Write", "Edit", "MultiEdit"].includes(event.call.tool)
    ) {
      calls.set(event.call.id, event.call.target);
    } else if (event.type === "tool_result" && !event.aborted && !event.isError) {
      const target = calls.get(event.callId);
      if (target) files.add(target);
    }
  }
  const acceptance = from
    .filter(isAcceptanceRecord)
    .map((record) => record.event)
    .filter((event) => !taskId || event.taskId === taskId);
  const latestAttempt = acceptance.reduce(
    (max, event) => Math.max(max, event.attempt),
    0,
  );
  const checks = acceptance
    .filter((event) => event.attempt === latestAttempt)
    .map(({ command, status, exitCode, durationMs, output }) => ({
      command,
      status,
      ...(exitCode === undefined ? {} : { exitCode }),
      durationMs,
      ...(output === undefined ? {} : { output }),
    }));
  const reviewEvent = [...from]
    .reverse()
    .map((record) => record.event)
    .find((event) => event.type === "review_result");
  const outcome = projectOutcome(from, finish, options.status);
  const verification: DeliveryVerification = checks.length === 0
    ? "not_run"
    : checks.every((check) => check.status === "passed")
      ? "passed"
      : "failed";
  const review: DeliveryReview = reviewEvent?.type !== "review_result"
    ? "not_run"
    : reviewEvent.passed
      ? "passed"
      : "failed";
  const warnings: string[] = [];
  const unconfirmed: string[] = [];
  if (verification === "not_run") unconfirmed.push("未运行机器验收");
  if (files.size > 0) {
    unconfirmed.push(
      "文件清单来自成功的 Write/Edit/MultiEdit 调用，可能没有完整最终 diff",
    );
  }
  title ||= options.title || firstUserText(records) || "未命名会话";
  return {
    title,
    ...(goal ? { goal } : {}),
    outcome,
    verification,
    review,
    files: [...files],
    checks,
    ...(reviewEvent?.type === "review_result"
      ? {
          reviewResult: {
            passed: reviewEvent.passed,
            issues: [...reviewEvent.issues],
            summary: reviewEvent.summary,
          },
        }
      : {}),
    warnings,
    unconfirmed,
  };
}

function isAcceptanceRecord(
  record: RecordedEvent,
): record is RecordedEvent & {
  event: Extract<AgentEvent, { type: "acceptance_result" }>;
} {
  return record.event.type === "acceptance_result";
}

function firstUserText(records: RecordedEvent[]): string | undefined {
  const event = records.find((record) => record.event.type === "user")?.event;
  return event?.type === "user" ? event.text : undefined;
}

function projectOutcome(
  records: RecordedEvent[],
  finish: Extract<AgentEvent, { type: "run_finished" }> | undefined,
  status: SessionStatus | undefined,
): DeliveryOutcome {
  if (records.some((record) => record.event.type === "interrupted")) {
    return "interrupted";
  }
  if (finish) return finish.status;
  switch (status) {
    case "done":
      return "completed";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "idle":
    case "running":
    case "waiting_permission":
    case "waiting_plan":
    default:
      return "running";
  }
}
