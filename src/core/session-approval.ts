import type { AgentEventBus } from "./events.js";
import {
  callSignature,
  type PermissionEngine,
} from "./permissions.js";
import type {
  ApprovalAnswer,
  PermissionRule,
  ToolCall,
} from "./types.js";

interface PendingPermission {
  resolve: (answer: ApprovalAnswer) => void;
}

/**
 * 审批等待器（AgentSession 委托）：
 * - 超时自动拒绝（notify warn 事件）；
 * - signal abort 拒绝；
 * - scope 记忆（session 内 remember）与 project/global 规则持久化；
 * - steer 时 cancelAll 解锁全部挂起审批（含子代理冒泡上来的）。
 */
export class PermissionWaiter {
  readonly #bus: AgentEventBus;
  readonly #permissions: PermissionEngine;
  readonly #approvalTimeoutMs: number;
  readonly #rememberPermission:
    | ((
        scope: "project" | "global",
        rule: PermissionRule,
      ) => Promise<void>)
    | undefined;
  readonly #setStatus: (status: "running" | "waiting_permission") => void;
  readonly #pending = new Map<string, PendingPermission>();

  constructor(options: {
    bus: AgentEventBus;
    permissions: PermissionEngine;
    approvalTimeoutMs: number;
    rememberPermission?: (
      scope: "project" | "global",
      rule: PermissionRule,
    ) => Promise<void>;
    setStatus: (status: "running" | "waiting_permission") => void;
  }) {
    this.#bus = options.bus;
    this.#permissions = options.permissions;
    this.#approvalTimeoutMs = options.approvalTimeoutMs;
    this.#rememberPermission = options.rememberPermission;
    this.#setStatus = options.setStatus;
  }

  async wait(call: ToolCall, signal: AbortSignal): Promise<ApprovalAnswer> {
    this.#setStatus("waiting_permission");
    return await new Promise<ApprovalAnswer>((resolve) => {
      const timeout = setTimeout(
        () => {
          this.#bus.emit({
            type: "notify",
            level: "warn",
            message: `审批超时（${this.#approvalTimeoutMs / 1000}s 无人响应），已自动拒绝：${call.tool} ${call.target ?? ""}`,
          });
          finish({ granted: false });
        },
        this.#approvalTimeoutMs,
      );
      const onAbort = () => finish({ granted: false });
      signal.addEventListener("abort", onAbort, { once: true });

      const finish = (answer: ApprovalAnswer) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        this.#pending.delete(call.id);
        if (answer.granted && answer.scope && answer.scope !== "once") {
          this.#permissions.remember(call);
          if (
            (answer.scope === "project" || answer.scope === "global") &&
            this.#rememberPermission
          ) {
            void this.#rememberPermission(answer.scope, {
              effect: "allow",
              pattern: callSignature(call),
            }).catch((error) => {
              this.#bus.emit({
                type: "error",
                message:
                  error instanceof Error
                    ? `保存审批规则失败：${error.message}`
                    : "保存审批规则失败",
              });
            });
          }
        }
        resolve(answer);
      };
      this.#pending.set(call.id, { resolve: finish });
    });
  }

  resolve(callId: string, answer: boolean | ApprovalAnswer): boolean {
    const pending = this.#pending.get(callId);
    if (!pending) return false;
    const normalized: ApprovalAnswer =
      typeof answer === "boolean"
        ? { granted: answer, scope: "once" }
        : answer;
    this.#setStatus("running");
    pending.resolve(normalized);
    return true;
  }

  /** 解锁全部挂起审批（steer 插队时调用，防止审批阻塞插队生效） */
  cancelAll(feedback: string): void {
    for (const pending of [...this.#pending.values()]) {
      pending.resolve({ granted: false, feedback });
    }
  }
}
