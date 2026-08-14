import type { AgentEventBus } from "./events.js";
import {
  PermissionEngine,
  type PermissionVerdict,
} from "./permissions.js";
import { computeMissedTokens, missedCost } from "./cache-stats.js";
import {
  emitDeniedTool,
  emitToolResult,
  executeTool,
  type ToolTraceItem,
} from "./tool-batch.js";
import type {
  ApprovalHandler,
  ModelPricing,
  ToolCall,
  ToolExecutionResult,
} from "./types.js";
import type { ToolExecutor } from "../tools/executor.js";
import {
  classifyModelError,
  errorMessageOf,
  retryAfterMsOf,
} from "../model/error-policy.js";
import { isToolName, looksReadOnlyToolName, TOOL_NAMES } from "../shared/tool-names.js";
import { usageCostCny } from "../utils/cost.js";
import { abortableSleep } from "../utils/sleep.js";

/**
 * 重试退避 25% 向下抖动（参照 Pi provider 级公式 0.5×2^n ≤8s + 抖动）：
 * 指数退避乘 [0.75, 1.0] 随机系数——多个并发请求同时失败时，同步重试
 * 会形成 thundering herd 反复打同一端点，向下抖动错开重试时刻。
 * Retry-After（供应商显式指令）不抖动，由调用方取 max 保留其语义。
 */
export function jitteredBackoff(
  baseMs: number,
  random: () => number = Math.random,
): number {
  return baseMs * (0.75 + random() * 0.25);
}

export interface ModelTurn {
  text?: string;
  toolCalls?: ToolCall[];
  done?: boolean;
  question?: string;
  /** 供应商原始终止原因（Anthropic max_tokens / OpenAI length 等） */
  stopReason?: string;
  /** 推理内容（thinking） */
  thinking?: string;
  usage?: { input: number; output: number; cached: number };
  usagePricing?: ModelPricing;
  /** 成本来源（按模型/供应商拆维度统计） */
  providerId?: string;
  model?: string;
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
  /** 上下文超长（overflow）时的压缩重试（可选）：AgentLoop 在 overflow 错误时调用 */
  compact?(signal: AbortSignal, force?: boolean): Promise<boolean>;
  acceptToolResult?(
    call: ToolCall,
    result: ToolExecutionResult,
    isError?: boolean,
  ): void;
  acceptToolDenied?(call: ToolCall, reason: string): void;
  onTextDelta?: ((text: string) => void) | undefined;
  onThinkingDelta?: ((text: string) => void) | undefined;
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
  /** turn 级自动重试次数（参照 Pi auto-retry）；默认 3 */
  retryMaxRetries?: number;
  /** turn 级重试基础退避（指数 ×2）；默认 2000ms */
  retryBaseDelayMs?: number;
  /** 工具并行执行（参照 Pi 默认 parallel）：同一批全部无需审批时并发执行 */
  parallelTools?: boolean;
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
  readonly #retryMaxRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #parallelTools: boolean;
  /** 缓存浪费度量状态：上一轮 input、上一轮时间、已见压缩数 */
  #prevInputTokens = 0;
  #prevTurnAtMs = 0;
  #seenCompactions = 0;
  /** reportedCache sticky（Pi 语义）：会话是否曾见过缓存命中（cached > 0）；
   *  从未命中的供应商（OpenAI 兼容端点 cached 恒 0）不报缓存浪费 */
  #everReportedCache = false;
  /** Steer 打断请求（参照 Pi 的 steer）：当前工具完成后拒绝剩余工具调用并退出循环 */
  #steerRequested = false;

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
    this.#retryMaxRetries = options.retryMaxRetries ?? 3;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 2_000;
    this.#parallelTools = options.parallelTools ?? false;
  }

  interrupt(): void {
    if (!this.#abortController || this.#abortController.signal.aborted) return;
    this.#abortController.abort();
    this.#bus.emit({ type: "interrupted", scope: "loop" });
  }

  /** Steer 软打断：不 abort 正在运行的工具，而是在它完成后拒绝本批剩余
      工具调用并结束循环，让会话优先处理插队的用户消息。 */
  steer(): void {
    this.#steerRequested = true;
  }

  /**
   * 模型回合请求 + turn 级 auto-retry（参照 Pi 的 agent-session auto-retry）：
   * - retry：瞬时错误（限流/5xx/网络）指数退避重试（2s/4s/8s，默认 3 次）；
   * - overflow：上下文超长先压缩再重试一次；
   * - fatal（quota/认证/未知）：不重试，抛给上层（fail-closed）。
   * 失败回合不会污染模型上下文（ConversationAgentModel 仅在成功时 push 消息）。
   */
  async #requestTurn(signal: AbortSignal): Promise<ModelTurn> {
    try {
      return await this.#model.next(signal);
    } catch (error) {
      this.#recordModelError(error);
      const policy = classifyModelError(error);
      if (policy === "fatal" || signal.aborted) throw error;
      const maxRetries =
        policy === "overflow" ? 1 : this.#retryMaxRetries;
      let lastError = error;
      for (let retry = 1; retry <= maxRetries; retry += 1) {
        // Retry-After 优先（供应商显式要求等待时长），否则指数退避 + 25% 向下抖动
        // （并发失败时错开重试时刻，防 thundering herd）
        const backoff = jitteredBackoff(
          this.#retryBaseDelayMs * 2 ** (retry - 1),
        );
        const delayMs = Math.max(
          backoff,
          retryAfterMsOf(lastError) ?? 0,
        );
        this.#bus.emit({
          type: "notify",
          level: "info",
          message:
            policy === "overflow"
              ? "模型调用失败：上下文超长，正在压缩后自动重试"
              : `模型调用失败（${errorMessageOf(lastError)}），${Math.round(delayMs / 1000)}s 后自动重试（${retry}/${maxRetries}）`,
        });
        await abortableSleep(delayMs, signal);
        if (signal.aborted) break;
        if (policy === "overflow") {
          await this.#model.compact?.(signal, true).catch(() => false);
        }
        try {
          return await this.#model.next(signal);
        } catch (retryError) {
          this.#recordModelError(retryError);
          lastError = retryError;
        }
      }
      throw lastError;
    }
  }

  /**
   * Bash 实时输出 → tool_execution_update 事件（100ms 节流，对齐 Pi）。
   * 仅 UI 展示，不进模型上下文；最终结果仍由 tool_result 承载。
   */
  #makeOnToolData(callId: string): (chunk: string) => void {
    let lastEmitAt = 0;
    let pending = "";
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      if (!pending) return;
      const partial = pending;
      pending = "";
      this.#bus.emit({ type: "tool_execution_update", callId, partial });
    };
    return (chunk) => {
      pending += chunk;
      const now = Date.now();
      if (now - lastEmitAt >= 100) {
        lastEmitAt = now;
        flush();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          lastEmitAt = Date.now();
          flush();
        }, 100);
      }
    };
  }

  #recordModelError(error: unknown): void {
    const trace = modelErrorTrace(error);
    this.#recordTrace?.({
      ...(trace?.request === undefined ? {} : { request: trace.request }),
      response:
        trace?.response ?? {
          error:
            error instanceof Error ? error.message : "未知模型错误",
        },
      tools: [],
    });
  }

  /**
   * 并行工具执行（参照 Pi 的 parallel 模式）：deny/finalOnly 直接拒绝（同步回灌），
   * 其余并发执行；执行完成后按 assistant 原始顺序统一回灌事件与模型消息。
   * 审批（ask）不在此路径——含 ask 的批次由调用方退化为串行。
   */
  async #executeBatchParallel(
    verdicts: Array<{ call: ToolCall; verdict: PermissionVerdict }>,
    turnPolicy: { stop?: boolean; finalOnly?: boolean } | undefined,
    signal: AbortSignal,
    traceTools: ToolTraceItem[],
  ): Promise<void> {
    // 先统一 emit tool_call（与串行路径一致）：事件流完整，崩溃恢复时
    // tool_result 按 callId 配对不丢（此前并行路径缺 tool_call 事件导致恢复丢失）
    for (const { call } of verdicts) {
      this.#bus.emit({ type: "tool_call", call });
    }
    const executions = verdicts.map(async ({ call, verdict }) => {
      const toolStartedAt = Date.now();
      if (signal.aborted) {
        return { call, verdict, state: "skipped" as const };
      }
      if (verdict === "deny") {
        emitDeniedTool(this.#bus, this.#model, traceTools, {
          call,
          reason: "命中 deny 规则，不能临时强制放行",
          permission: "deny",
          ms: 0,
        });
        return { call, verdict, state: "denied" as const };
      }
      if (turnPolicy?.finalOnly) {
        emitDeniedTool(this.#bus, this.#model, traceTools, {
          call,
          reason: "任务盒已进入纯总结阶段，禁止继续调用工具",
          permission: "task_box_deny",
          ms: 0,
        });
        return { call, verdict, state: "denied" as const };
      }
      try {
        const result = await this.#tools.execute(call, signal, {
          onData: this.#makeOnToolData(call.id),
        });
        return { call, verdict, state: "done" as const, result, toolStartedAt };
      } catch (error) {
        const result: ToolExecutionResult = {
          summary:
            error instanceof Error ? error.message : "工具执行发生未知错误",
        };
        return { call, verdict, state: "error" as const, result, toolStartedAt };
      }
    });
    const settled = await Promise.all(executions);
    for (const item of settled) {
      const { call, verdict } = item;
      if (item.state === "skipped") continue;
      if (item.state === "denied") continue; // trace 已在 executions 内记录
      emitToolResult(this.#bus, this.#model, traceTools, {
        call,
        result: item.result!,
        permission: verdict,
        ms: Date.now() - item.toolStartedAt,
      });
    }
  }

  async run(): Promise<void> {
    if (this.#abortController) throw new Error("AgentLoop 已在运行");
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    try {
      // 设置流式文本回调：逐块发出 text_delta / thinking_delta 事件
      let streamedText = false;
      let streamedThinking = false;
      this.#model.onTextDelta = (text) => {
        streamedText = true;
        this.#bus.emit({ type: "text_delta", text });
      };
      this.#model.onThinkingDelta = (text) => {
        streamedThinking = true;
        this.#bus.emit({ type: "thinking_delta", text });
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
        if (this.#steerRequested) {
          // 打断点二：模型轮间（上一轮无工具或已处理完毕），不再发起新轮
          return;
        }
        let turn: ModelTurn;
        try {
          turn = await this.#requestTurn(signal);
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
        const traceTools: ToolTraceItem[] = [];
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
        // 推理内容同理：流式已发出则不重复；非流式/模型只在 done 携带时一次性补发
        if (turn.thinking && !streamedThinking) {
          this.#bus.emit({ type: "thinking_delta", text: turn.thinking });
        }
        streamedThinking = false;
        if (turn.usage) {
          const now = Date.now();
          // reportedCache sticky：见过缓存命中后置位（永不重置）；
          // 从未命中的供应商（cached 恒 0）后续轮次不计缓存浪费
          if (turn.usage.cached > 0) this.#everReportedCache = true;
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
            this.#everReportedCache,
          );
          this.#seenCompactions = this.#modelCompactCount?.() ?? 0;
          this.#prevInputTokens = turn.usage.input;
          this.#prevTurnAtMs = now;
          // 浪费费用（Pi missedCost）：miss 部分本可按缓存价计费却按全价重计；
          // 压缩属合法重置不计入
          const missedCostCny = missedCost(
            missed.missedTokens,
            missed.missedReason,
            turn.usagePricing ?? this.#pricing,
          );
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
            ...(turn.providerId ? { providerId: turn.providerId } : {}),
            ...(turn.model ? { model: turn.model } : {}),
            ...(missed.missedTokens > 0
              ? {
                  missedTokens: missed.missedTokens,
                  ...(missed.missedReason
                    ? { missedReason: missed.missedReason }
                    : {}),
                  ...(missedCostCny === undefined || missedCostCny <= 0
                    ? {}
                    : { missedCostCny }),
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

        const calls = turn.toolCalls ?? [];
        // 截断回合（Pi failToolCallsFromTruncatedMessage）：输出达到长度上限时
        // 工具调用未完整生成（参数可能残缺），一律不执行，判失败回灌模型
        if (isTruncatedStopReason(turn.stopReason) && calls.length > 0) {
          const reason =
            "回合输出被长度截断，工具调用未完整生成，判为失败";
          for (const call of calls) {
            this.#bus.emit({ type: "tool_call", call });
            this.#bus.emit({
              type: "tool_result",
              callId: call.id,
              summary: reason,
              isError: true,
            });
            this.#model.acceptToolResult?.(
              call,
              { summary: reason },
              true,
            );
            traceTools.push({
              call,
              permission: "truncated",
              result: { error: reason },
              ms: 0,
            });
          }
          recordTurn();
          continue;
        }
        // 并行试点：同一批全部预检通过（allow/deny、无 ask）且全部并行安全时并发执行，
        // 结果按原始顺序回灌（模型协议要求 tool 消息与 tool_use 顺序一致）；
        // 含任一顺序工具（写类/Bash）的批次整批退化为串行（P0-1）
        if (
          this.#parallelTools &&
          calls.length > 1 &&
          !signal.aborted &&
          !this.#steerRequested &&
          calls.every((call) => this.#tools.isParallelSafe(call.tool))
        ) {
          const verdicts = calls.map((call) => ({
            call,
            verdict: this.#permissions.judge(call),
          }));
          if (verdicts.every((item) => item.verdict !== "ask")) {
            await this.#executeBatchParallel(
              verdicts,
              turnPolicy,
              signal,
              traceTools,
            );
            recordTurn();
            if (this.#steerRequested) {
              return;
            }
            if (turn.done) {
              this.#bus.emit({ type: "done" });
              return;
            }
            continue;
          }
        }

        for (const call of calls) {
          const toolStartedAt = Date.now();
          if (signal.aborted) {
            recordTurn();
            return;
          }
          if (this.#steerRequested) {
            // 打断点一：当前工具已完成，拒绝本批剩余调用
            //（模型协议要求每个 tool_use 都有 tool_result 回应）
            emitDeniedTool(this.#bus, this.#model, traceTools, {
              call,
              reason: "用户插入新指令（steer），跳过剩余工具调用",
              permission: "steered",
              ms: Date.now() - toolStartedAt,
            });
            continue;
          }
          this.#bus.emit({ type: "tool_call", call });
          if (turnPolicy?.finalOnly) {
            emitDeniedTool(this.#bus, this.#model, traceTools, {
              call,
              reason: "任务盒已进入纯总结阶段，禁止继续调用工具",
              permission: "task_box_deny",
              ms: Date.now() - toolStartedAt,
            });
            continue;
          }
          const verdict = this.#permissions.judge(call);
          if (verdict === "deny") {
            emitDeniedTool(this.#bus, this.#model, traceTools, {
              call,
              reason: "命中 deny 规则，不能临时强制放行",
              permission: "deny",
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
              emitDeniedTool(this.#bus, this.#model, traceTools, {
                call,
                reason,
                permission: "user_denied",
                ms: Date.now() - toolStartedAt,
              });
              // 拒绝来自 steer 取消挂起审批：直接结束本批，不再执行剩余工具
              if (this.#steerRequested) break;
              continue;
            }
          }

          await executeTool(this.#bus, this.#model, this.#tools, traceTools, {
            call,
            permission: verdict,
            signal,
            ms: toolStartedAt,
            onData: this.#makeOnToolData(call.id),
          });
        }

        recordTurn();

        if (this.#steerRequested) {
          // steer 后不发 done：退出循环让会话优先消费插队消息
          return;
        }
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

/** 从模型错误上提取供应商 trace（agentTrace 附在错误对象上，供回合 trace 落盘） */
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

/** 输出长度截断的终止原因（Anthropic stop_reason=max_tokens / OpenAI finish_reason=length） */
function isTruncatedStopReason(reason: string | undefined): boolean {
  return reason === "max_tokens" || reason === "length";
}

function riskFor(call: ToolCall): string {
  if (call.tool === TOOL_NAMES[8]) {
    // Bash
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
  if (call.tool === TOOL_NAMES[7]) return "将新建或完整覆盖文件"; // Write
  // 插件/MCP 工具：按工具名启发式区分只读与写操作（内置 Edit/MultiEdit 保持原文案）。
  // 注意不能用 \b 词边界：snake_case/camelCase 名称中下划线是 \w，动词没有边界
  if (!isToolName(call.tool) && looksReadOnlyToolName(call.tool)) {
    return "只读操作，不修改文件；执行前可查看详细参数";
  }
  return "将修改文件；执行前可查看精确 diff";
}
