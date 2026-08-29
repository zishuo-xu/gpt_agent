import type { AgentEvent, RecordedEvent } from "./types.js";
import type { SessionStatus } from "../shared/types.js";

export type DeliveryOutcome = "running" | "completed" | "failed" | "interrupted";
export type DeliveryVerification = "passed" | "failed" | "not_run";
export type DeliveryReview = "passed" | "failed" | "not_run";

export interface DeliveryCheck {
  command: string;
  status: "passed" | "failed" | "timed_out";
  exitCode?: number;
  durationMs: number;
  output?: string;
}

export interface DeliveryProjection {
  title: string;
  goal?: string;
  outcome: DeliveryOutcome;
  verification: DeliveryVerification;
  review: DeliveryReview;
  files: string[];
  checks: DeliveryCheck[];
  reviewResult?: { passed: boolean; issues: string[]; summary: string };
  warnings: string[];
  unconfirmed: string[];
}

/** Rebuilds the user-facing delivery package solely from the persisted event stream. */
export function projectDelivery(records: RecordedEvent[], options: { title?: string; status?: SessionStatus } = {}): DeliveryProjection {
  let start = -1;
  let taskId: string | undefined;
  let title = "";
  let goal: string | undefined;
  let finish: Extract<AgentEvent, { type: "run_finished" }> | undefined;
  let finishIndex = -1;
  for (let i = 0; i < records.length; i += 1) {
    const event = records[i]?.event;
    if (event?.type === "run_started") {
      start = i; taskId = event.taskId; title = event.description;
      goal = event.taskOptions?.goal;
      finish = undefined; finishIndex = -1;
    } else if (event?.type === "run_finished" && start >= 0 && event.taskId === taskId) {
      finish = event; finishIndex = i;
    }
  }
  const from = start >= 0 ? records.slice(start, finishIndex >= 0 ? finishIndex + 1 : undefined) : records;
  const calls = new Map<string, string>();
  const files = new Set<string>();
  for (const record of from) {
    const event = record.event;
    if (event.type === "tool_call" && ["Write", "Edit", "MultiEdit"].includes(event.call.tool)) {
      calls.set(event.call.id, event.call.target);
    } else if (event.type === "tool_result" && !event.aborted && !event.isError) {
      const target = calls.get(event.callId);
      if (target) files.add(target);
    }
  }
  const acceptance = from
    .filter((r): r is RecordedEvent & { event: Extract<AgentEvent, { type: "acceptance_result" }> } => r.event.type === "acceptance_result" && (!taskId || r.event.taskId === taskId))
    .map((r) => r.event);
  const latestAttempt = acceptance.reduce((max, item) => Math.max(max, item.attempt), 0);
  const checks = acceptance.filter((item) => item.attempt === latestAttempt).map(({ command, status, exitCode, durationMs, output }) => ({ command, status, ...(exitCode === undefined ? {} : { exitCode }), durationMs, ...(output === undefined ? {} : { output }) }));
  const reviewEvent = [...from].reverse().map((r) => r.event).find((e) => e.type === "review_result");
  const outcome = projectOutcome(records, finish, options.status);
  const verification: DeliveryVerification = checks.length === 0 ? "not_run" : checks.every((c) => c.status === "passed") ? "passed" : "failed";
  const review: DeliveryReview = reviewEvent?.type !== "review_result" ? "not_run" : reviewEvent.passed ? "passed" : "failed";
  const warnings: string[] = [];
  const unconfirmed: string[] = [];
  if (verification === "not_run") unconfirmed.push("未运行机器验收");
  if (files.size > 0) unconfirmed.push("文件清单来自成功的 Write/Edit/MultiEdit 调用，可能没有完整最终 diff");
  if (!title) title = options.title || (records.find((r) => r.event.type === "user")?.event.type === "user" ? (records.find((r) => r.event.type === "user")!.event as Extract<AgentEvent,{type:"user"}>).text : "未命名会话");
  return { title, ...(goal ? { goal } : {}), outcome, verification, review, files: [...files], checks, ...(reviewEvent?.type === "review_result" ? { reviewResult: { passed: reviewEvent.passed, issues: [...reviewEvent.issues], summary: reviewEvent.summary } } : {}), warnings, unconfirmed };
}

function projectOutcome(
  records: RecordedEvent[],
  finish: Extract<AgentEvent, { type: "run_finished" }> | undefined,
  status: SessionStatus | undefined,
): DeliveryOutcome {
  if (records.some((record) => record.event.type === "interrupted")) return "interrupted";
  if (finish) return finish.status;
  switch (status) {
    case "done": return "completed";
    case "error": return "failed";
    case "interrupted": return "interrupted";
    case "idle":
    case "running":
    case "waiting_permission":
    case "waiting_plan":
    default: return "running";
  }
}
