import type { AgentEventBus } from "./events.js";
import type { PermissionEngine } from "./permissions.js";
import type {
  ApprovalHandler,
  ModelPricing,
  ToolCall,
  ToolExecutionResult,
} from "./types.js";
import type { ToolExecutor } from "../tools/executor.js";

export interface ModelTurn {
  text?: string;
  toolCalls?: ToolCall[];
  done?: boolean;
  question?: string;
  usage?: { input: number; output: number; cached: number };
  usagePricing?: ModelPricing;
  fallbacks?: Array<{
    from: string;
    to: string;
    reason: string;
  }>;
  trace?: {
    request: unknown;
    response: unknown;
  };
}

export interface AgentModel {
  next(signal: AbortSignal): Promise<ModelTurn>;
  acceptToolResult?(
    call: ToolCall,
    result: ToolExecutionResult,
    isError?: boolean,
  ): void;
  acceptToolDenied?(call: ToolCall, reason: string): void;
  onTextDelta?: ((text: string) => void) | undefined;
}

export interface AgentLoopOptions {
  bus: AgentEventBus;
  model: AgentModel;
  permissions: PermissionEngine;
  tools: ToolExecutor;
  approve: ApprovalHandler;
  initialTotalTokens?: number;
  getTotalTokens?: () => number;
  beforeTurn?: (
    signal: AbortSignal,
  ) => Promise<{ stop?: boolean; finalOnly?: boolean }>;
  pricing?: ModelPricing;
  getTotalCostCny?: () => number;
  modelRole?: "main" | "cheap" | "explore";
  /** 最大模型轮数；超过后强制结束循环（子代理成本兜底）。不传则不限。 */
  maxTurns?: number;
  /** 会话内压缩发生次数（缓存浪费度量区分合法失效用）；由 ConversationAgentModel 提供 */
  modelCompactCount?: () => number;
  recordTrace?: (trace: {
    request?: unknown;
    response?: unknown;
    tools: Array<{
      call: ToolCall;
      permission: string;
      result?: unknown;
      ms: number;
    }>;
    usage?: { input: number; output: number; cached: number };
  }) => void;
}

export class AgentLoop {
  readonly #bus: AgentEventBus;
  readonly #model: AgentModel;
  readonly #permissions: PermissionEngine;
  readonly #tools: ToolExecutor;
  readonly #approve: ApprovalHandler;
  #abortController: AbortController | undefined;
  #totalTokens = 0;
  readonly #getTotalTokens: (() => number) | undefined;
  readonly #beforeTurn: AgentLoopOptions["beforeTurn"];
  readonly #pricing: ModelPricing | undefined;
  readonly #getTotalCostCny: (() => number) | undefined;
  readonly #modelRole: "main" | "cheap" | "explore";
  readonly #recordTrace: AgentLoopOptions["recordTrace"];
  readonly #maxTurns: number | undefined;
  readonly #modelCompactCount: AgentLoopOptions["modelCompactCount"];
  /** 缓存浪费度量状态：上一轮 input、上一轮时间、已见压缩数 */
  #prevInputTokens = 0;
  #prevTurnAtMs = 0;
  #seenCompactions = 0;

  constructor(options: AgentLoopOptions) {
    this.#bus = options.bus;
    this.#model = options.model;
    this.#permissions = options.permissions;
    this.#tools = options.tools;
    this.#approve = options.approve;
    this.#totalTokens = options.initialTotalTokens ?? 0;
    this.#getTotalTokens = options.getTotalTokens;
    this.#beforeTurn = options.beforeTurn;
    this.#pricing = options.pricing;
    this.#getTotalCostCny = options.getTotalCostCny;
    this.#modelRole = options.modelRole ?? "main";
    this.#recordTrace = options.recordTrace;
    this.#maxTurns = options.maxTurns;
    this.#modelCompactCount = options.modelCompactCount;
  }

  interrupt(): void {
    if (!this.#abortController || this.#abortController.signal.aborted) return;
    this.#abortController.abort();
    this.#bus.emit({ type: "interrupted", scope: "loop" });
  }

  async run(): Promise<void> {
    if (this.#abortController) throw new Error("AgentLoop 已在运行");
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    try {
      // 设置流式文本回调：逐块发出 text_delta 事件
      let streamedText = false;
      this.#model.onTextDelta = (text) => {
        streamedText = true;
        this.#bus.emit({ type: "text_delta", text });
      };
      let turnCount = 0;
      while (!signal.aborted) {
        if (
          this.#maxTurns !== undefined &&
          turnCount >= this.#maxTurns
        ) {
          this.#bus.emit({
            type: "text_delta",
            text: `\n[已达子代理最大轮数（${this.#maxTurns}），强制收尾]`,
          });
          return;
        }
        turnCount += 1;
        const turnPolicy = await this.#beforeTurn?.(signal);
        if (turnPolicy?.stop) {
          this.#bus.emit({ type: "interrupted", scope: "loop" });
          return;
        }
        let turn: ModelTurn;
        try {
          turn = await this.#model.next(signal);
        } catch (error) {
          const trace = modelErrorTrace(error);
          this.#recordTrace?.({
            ...(trace?.request === undefined
              ? {}
              : { request: trace.request }),
            response:
              trace?.response ?? {
                error:
                  error instanceof Error
                    ? error.message
                    : "未知模型错误",
              },
            tools: [],
          });
          throw error;
        }
        const traceTools: Array<{
          call: ToolCall;
          permission: string;
          result?: unknown;
          ms: number;
        }> = [];
        const recordTurn = () => {
          this.#recordTrace?.({
            ...(turn.trace?.request === undefined
              ? {}
              : { request: turn.trace.request }),
            ...(turn.trace?.response === undefined
              ? {}
              : { response: turn.trace.response }),
            tools: traceTools,
            ...(turn.usage ? { usage: turn.usage } : {}),
          });
        };
        for (const fallback of turn.fallbacks ?? []) {
          this.#bus.emit({
            type: "model_fallback",
            role: this.#modelRole,
            ...fallback,
          });
        }
        // 如果流式回调已经发出了文本，不再重复发出
        if (turn.text && !streamedText) {
          this.#bus.emit({ type: "text_delta", text: turn.text });
        }
        streamedText = false;
        if (turn.usage) {
          const now = Date.now();
          // 缓存浪费度量（参照 Pi 的 cache-stats）：上轮已有、本轮本应命中
          // 却未命中的 token 数；<1024 视为 breakpoint 粒度噪音忽略
          const missed = computeMissedTokens(
            turn.usage,
            this.#prevInputTokens,
            this.#prevTurnAtMs,
            now,
            this.#modelCompactCount?.() ?? 0,
            this.#seenCompactions,
            (turn.fallbacks?.length ?? 0) > 0,
          );
          this.#seenCompactions = this.#modelCompactCount?.() ?? 0;
          this.#prevInputTokens = turn.usage.input;
          this.#prevTurnAtMs = now;
          const costCny = usageCostCny(
            turn.usage,
            turn.usagePricing ?? this.#pricing,
          );
          this.#totalTokens =
            (this.#getTotalTokens?.() ?? this.#totalTokens) +
            turn.usage.input +
            turn.usage.output;
          this.#bus.emit({
            type: "cost_update",
            input: turn.usage.input,
            output: turn.usage.output,
            cached: turn.usage.cached,
            totalTokens: this.#totalTokens,
            ...(missed.missedTokens > 0
              ? {
                  missedTokens: missed.missedTokens,
                  ...(missed.missedReason
                    ? { missedReason: missed.missedReason }
                    : {}),
                }
              : {}),
            ...(costCny === undefined
              ? {}
              : {
                  costCny,
                  totalCostCny:
                    (this.#getTotalCostCny?.() ?? 0) + costCny,
                }),
          });
        }
        if (turn.question) {
          recordTurn();
          this.#bus.emit({ type: "need_user", question: turn.question });
          return;
        }

        for (const call of turn.toolCalls ?? []) {
          const toolStartedAt = Date.now();
          if (signal.aborted) {
            recordTurn();
            return;
          }
          this.#bus.emit({ type: "tool_call", call });
          if (turnPolicy?.finalOnly) {
            const reason = "任务盒已进入纯总结阶段，禁止继续调用工具";
            this.#bus.emit({
              type: "permission_denied",
              call,
              reason,
            });
            this.#model.acceptToolDenied?.(call, reason);
            traceTools.push({
              call,
              permission: "task_box_deny",
              result: { error: reason },
              ms: Date.now() - toolStartedAt,
            });
            continue;
          }
          const verdict = this.#permissions.judge(call);
          if (verdict === "deny") {
            const reason = "命中 deny 规则，不能临时强制放行";
            this.#bus.emit({
              type: "permission_denied",
              call,
              reason,
            });
            this.#model.acceptToolDenied?.(call, reason);
            traceTools.push({
              call,
              permission: "deny",
              result: { error: reason },
              ms: Date.now() - toolStartedAt,
            });
            continue;
          }
          if (verdict === "ask") {
            const detail = await this.#tools
              .preview(call, signal)
              .catch(() => "");
            this.#bus.emit({
              type: "ask_permission",
              call,
              risk: riskFor(call),
              ...(detail ? { detail } : {}),
            });
            const answer = await this.#approve(call, signal);
            if (!answer.granted) {
              const reason = answer.feedback?.trim()
                ? `用户拒绝：${answer.feedback.trim()}`
                : "用户拒绝或审批超时";
              this.#bus.emit({
                type: "permission_denied",
                call,
                reason,
              });
              this.#model.acceptToolDenied?.(call, reason);
              traceTools.push({
                call,
                permission: "user_denied",
                result: { error: reason },
                ms: Date.now() - toolStartedAt,
              });
              continue;
            }
          }

          try {
            const result = await this.#tools.execute(call, signal);
            this.#bus.emit({
              type: "tool_result",
              callId: call.id,
              summary: result.summary,
              ...(result.output === undefined ? {} : { output: result.output }),
              ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
              ...(result.isError === undefined ? {} : { isError: result.isError }),
            });
            if (result.todoSnapshot) {
              this.#bus.emit({
                type: "todo_update",
                todos: result.todoSnapshot,
              });
            }
            this.#model.acceptToolResult?.(
              call,
              result,
              result.isError ?? false,
            );
            traceTools.push({
              call,
              permission: verdict,
              result: {
                ...result,
                output: result.traceOutput ?? result.output,
              },
              ms: Date.now() - toolStartedAt,
            });
          } catch (error) {
            const result: ToolExecutionResult = {
              summary:
                error instanceof Error ? error.message : "工具执行发生未知错误",
            };
            this.#bus.emit({
              type: "tool_result",
              callId: call.id,
              summary: result.summary,
              isError: true,
            });
            this.#model.acceptToolResult?.(call, result, true);
            traceTools.push({
              call,
              permission: verdict,
              result: { error: result.summary },
              ms: Date.now() - toolStartedAt,
            });
          }
        }

        recordTurn();

        if (turn.done) {
          this.#bus.emit({ type: "done" });
          return;
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      this.#abortController = undefined;
    }
  }
}

/**
 * 缓存浪费度量（参照 Pi 的 cache-stats）：上轮 prompt 在本轮应已命中缓存，
 * 若 cacheRead 低于上轮总量说明前缀被破坏（浪费重新计费的 token）。
 *
 * 原因分类（优先级）：
 * - compaction：压缩后缓存必然失效 → 合法，仅标记原因不视为异常
 * - model_switch：模型/供应商切换 → 异常，计入浪费
 * - idle：超过供应商缓存 TTL（Anthropic 5 分钟）→ 提示
 * - 其余：未知破坏源
 *
 * <1024 tokens 的 miss 视为 breakpoint 粒度噪音忽略。
 */
export function computeMissedTokens(
  usage: { input: number; output: number; cached: number },
  prevInputTokens: number,
  prevTurnAtMs: number,
  nowMs: number,
  compactionCount: number,
  seenCompactions: number,
  switchedModel: boolean,
): { missedTokens: number; missedReason?: "compaction" | "model_switch" | "idle" } {
  if (prevInputTokens <= 0) return { missedTokens: 0 };
  const expectedCached = Math.min(prevInputTokens, usage.input);
  const missedTokens = Math.max(0, expectedCached - usage.cached);
  if (missedTokens < 1024) return { missedTokens: 0 };
  if (compactionCount > seenCompactions) {
    return { missedTokens, missedReason: "compaction" };
  }
  if (switchedModel) {
    return { missedTokens, missedReason: "model_switch" };
  }
  // Anthropic 缓存 TTL 5 分钟；空闲超时后未命中属预期，但值得提示
  if (prevTurnAtMs > 0 && nowMs - prevTurnAtMs > 5 * 60_000) {
    return { missedTokens, missedReason: "idle" };
  }
  return { missedTokens };
}

function usageCostCny(
  usage: { input: number; output: number; cached: number },
  pricing?: ModelPricing,
): number | undefined {
  if (!pricing) return undefined;
  return (
    (Math.max(0, usage.input - usage.cached) *
      pricing.inputPerMillionCny +
      usage.output * pricing.outputPerMillionCny +
      usage.cached * pricing.cachedInputPerMillionCny) /
    1_000_000
  );
}

function modelErrorTrace(error: unknown):
  | { request?: unknown; response?: unknown }
  | undefined {
  if (!error || typeof error !== "object") return undefined;
  const trace = (
    error as {
      agentTrace?: {
        request?: unknown;
        response?: unknown;
      };
    }
  ).agentTrace;
  return trace;
}

function riskFor(call: ToolCall): string {
  if (call.tool === "Bash") {
    const command = (call.args as { command?: string }).command ?? call.target;
    if (/^(npm|pnpm|yarn) (install|add|remove|rm)\b/.test(command)) {
      return "将修改依赖清单与 lock 文件";
    }
    if (/^git push\b/.test(command)) return "将向远端推送提交";
    if (
      /^git (reset|clean|checkout)\b/.test(command) ||
      /^git checkout --/.test(command)
    ) {
      return "⚠ 将重置或丢弃工作区改动，不可轻松恢复";
    }
    if (/^rm\s/.test(command)) {
      return "⚠ 将删除文件，删除后不可恢复";
    }
    if (/^sudo\b/.test(command)) {
      return "⚠ 将以管理员权限执行，影响面较大";
    }
    if (/\b(curl|wget)\b.*\|\s*(ba)?sh\b/.test(command)) {
      return "⚠ 将下载并直接执行远程脚本";
    }
    if (/^(pkill|kill)\b/.test(command)) return "将终止进程";
    return "命令副作用未知；中止不能撤销已经发生的副作用";
  }
  if (call.tool === "Write") return "将新建或完整覆盖文件";
  return "将修改文件；执行前可查看精确 diff";
}
