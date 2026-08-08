import type { RecordedEvent } from "@shared/types.js";

export type SessionEvent = RecordedEvent;

export type DisplayItem =
  | {
      kind: "message";
      seq: number;
      ts: string;
      author: "user" | "assistant";
      text: string;
      queued?: boolean;
      started?: boolean;
      steer?: boolean;
    }
  | {
      kind: "tool";
      seq: number;
      call: Record<string, any>;
      result?: Record<string, any>;
    }
  | {
      kind: "approval";
      seq: number;
      ts: string;
      event: Record<string, any>;
      resolvedByEvent: boolean;
      /** 审批被拒（用户拒绝/超时）的原因，来自 permission_denied 事件 */
      deniedReason?: string;
    }
  | {
      kind: "subtask";
      seq: number;
      start: Record<string, any>;
      end?: Record<string, any>;
    }
  | { kind: "cost"; seq: number; event: Record<string, any> }
  | { kind: "system"; seq: number; text: string; tone?: string };

/**
 * 工具结果显示文本：优先 details.diff（P0-3 后 Edit/Write 的 diff 移入 details，
 * 不进模型上下文），旧 trace 的 tool_result 无 details.diff 时回退 output。
 */
export function toolResultDiffText(
  result: Record<string, any> | undefined,
): string | undefined {
  const details = result?.details as Record<string, unknown> | undefined;
  if (typeof details?.diff === "string") return details.diff;
  return typeof result?.output === "string" ? result.output : undefined;
}

export function statusLabel(status: string): string {
  return (
    {
      completed: "已完成",
      failed: "失败",
      interrupted: "已中止",
    }[status] ?? status
  );
}

/**
 * 事件流 → 显示条目：单次遍历完成 delta 合并、call/result 配对、
 * 审批 resolved 判定，渲染层不再做 O(n) 回看。
 */
export function buildDisplayItems(events: SessionEvent[]): DisplayItem[] {
  const toolResults = new Map<string, Record<string, any>>();
  const deniedReasons = new Map<string, string>();
  const startedQueues = new Set<string>();
  const taskEnds = new Map<string, Record<string, any>>();
  for (const { event } of events) {
    if (event.type === "tool_result") {
      toolResults.set(String(event.callId), event);
    } else if (event.type === "permission_denied") {
      toolResults.set(String(event.call?.id), event);
      if (event.call?.id) {
        deniedReasons.set(String(event.call.id), event.reason);
      }
    } else if (event.type === "user" && event.queueId) {
      startedQueues.add(String(event.queueId));
    } else if (event.type === "task_end") {
      taskEnds.set(String(event.taskId), event);
    }
  }

  const items: DisplayItem[] = [];
  const system = (seq: number, text: string, tone?: string) =>
    items.push({ kind: "system", seq, text, tone });

  for (let index = 0; index < events.length; index += 1) {
    const { seq, ts, event } = events[index]!;
    switch (event.type) {
      case "user":
        if (!event.queueId) {
          items.push({
            kind: "message",
            seq,
            ts,
            author: "user",
            text: String(event.text),
          });
        }
        break;
      case "user_queued":
        items.push({
          kind: "message",
          seq,
          ts,
          author: "user",
          text: String(event.text),
          queued: true,
          started: startedQueues.has(String(event.queueId)),
          steer: event.steer === true,
        });
        break;
      case "text_delta": {
        let text = String(event.text);
        let nextEvent = events[index + 1]?.event;
        while (nextEvent && nextEvent.type === "text_delta") {
          index += 1;
          text += nextEvent.text;
          nextEvent = events[index + 1]?.event;
        }
        items.push({ kind: "message", seq, ts, author: "assistant", text });
        break;
      }
      case "tool_call":
        items.push({
          kind: "tool",
          seq,
          call: event.call,
          result: toolResults.get(String(event.call.id)),
        });
        break;
      case "ask_permission":
        items.push({
          kind: "approval",
          seq,
          ts,
          event,
          resolvedByEvent: toolResults.has(String(event.call.id)),
          deniedReason: deniedReasons.get(String(event.call.id)),
        });
        break;
      case "task_start":
        items.push({
          kind: "subtask",
          seq,
          start: event,
          end: taskEnds.get(String(event.taskId)),
        });
        break;
      case "cost_update":
        items.push({ kind: "cost", seq, event });
        break;
      case "branch_switch":
        system(
          seq,
          `⇄ 新分支 #${event.branchId}` +
            (event.label ? `（${event.label}）` : "") +
            ` · 自事件 #${event.forkSeq} 分裂`,
        );
        break;
      case "branch_summarized":
        system(
          seq,
          `⇄ 分支摘要（来自 #${String(event.fromBranchId)}）：` +
            String(event.summary).replace(/\n/g, " ").slice(0, 120),
        );
        break;
      case "context_compacted":
        system(seq, `上下文已压缩 · 保留 ${(event.ratio * 100).toFixed(1)}%`);
        break;
      case "model_fallback":
        system(
          seq,
          `${event.role} 模型已降级：${event.from} → ${event.to}`,
          "warning",
        );
        break;
      case "run_started":
        system(
          seq,
          `无人值守任务 #${event.taskId} 已启动 · ${event.permissionMode} 档`,
          "running",
        );
        break;
      case "wrapup_warning":
        system(seq, `任务进入 ${event.level} 阶段 · ${event.message}`, "warning");
        break;
      case "run_finished":
        system(
          seq,
          `无人值守任务 ${statusLabel(event.status)}${
            event.reason ? ` · ${event.reason}` : ""
          }`,
          "done",
        );
        break;
      case "need_user":
        system(seq, `需要你的决定：${event.question}`, "warning");
        break;
      case "done":
        system(seq, "✓ 本轮任务已完成", "done");
        break;
      case "error":
        system(seq, `运行失败：${event.message}`, "error");
        break;
      case "interrupted":
        system(seq, "任务已中止");
        break;
      case "notify":
        system(
          seq,
          String(event.message),
          event.level === "error"
            ? "error"
            : event.level === "warn"
              ? "warning"
              : undefined,
        );
        break;
      default:
        // tool_result / task_end / permission_denied 已并入对应卡片；
        // todo_update / task_event 无需展示。
        break;
    }
  }
  return items;
}
