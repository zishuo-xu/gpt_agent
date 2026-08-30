import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { usageCostCny } from "../utils/cost.js";
import type { MyAgentConfig } from "../config/schema.js";
import { ConversationAgentModel } from "./agent-model.js";
import { modelErrorGuidanceText } from "../model/error-policy.js";
import { ModelRetriesExhaustedError } from "../model/fallback-client.js";
import type { ModelClient } from "../model/types.js";
import { ToolExecutor } from "../tools/executor.js";
import type { AtomicFileTools } from "../tools/atomic-file.js";
import { AgentLoop } from "./agent-loop.js";
import {
  AgentEventBus,
  SessionStore,
  TraceStore,
} from "./events.js";
import {
  DEFAULT_PERMISSION_RULES,
  PermissionEngine,
} from "./permissions.js";
import {
  TaskBox,
  parseRunCommand,
  serializeTaskOptions,
  taskOptionsFromSerialized,
  type RunTaskOptions,
} from "./run-task.js";
import { TaskRunner } from "./task-runner.js";
import { buildReviewPrompt, parseReviewResult } from "./review-runner.js";
import { runAcceptanceChecks, type AcceptanceCheckResult } from "./acceptance-runner.js";
import { BranchCoordinator } from "./session-branch.js";
import { PermissionWaiter } from "./session-approval.js";
import { ClarificationWaiter } from "./clarification-waiter.js";
import {
  SessionStateMachine,
  type SessionStateDeps,
} from "./session-state.js";
import {
  firstUserText,
  interruptedTaskFrom,
  resumePrompt,
} from "./session-restore.js";
import { TaskLedger, normalizeLedgerPath } from "./task-ledger.js";
import {
  PLAN_TOOL_NAMES,
  buildApprovedPlanPrompt,
  buildTaskPlanningPrompt,
  normalizePlanText,
  extractPlanExecutionUnits,
  taskContractFromMarkdown,
  taskPlanDigest,
  taskPlanFromEvents,
  taskPlanSummary,
  type PlanDecision,
  type TaskPlanState,
} from "./task-plan.js";
import { ContextManager } from "./context.js";
import { captureWorkspaceFingerprint } from "./workspace-fingerprint.js";
import type { ExperimentSessionSummary } from "./experiment.js";
import type {
  AgentEvent,
  ApprovalAnswer,
  ModelPricing,
  PermissionMode,
  PermissionRule,
  RecordedEvent,
  SessionBranch,
  PlanExecutionUnit,
} from "./types.js";

import type {
  SessionStatus as AgentSessionStatus,
  SessionSummary as AgentSessionSummary,
} from "../shared/types.js";

export type { AgentSessionStatus, AgentSessionSummary };

/** 事件记录（RecordedEvent 的会话内形态：sessionId 由 SessionStore 落盘时补齐） */
export type AgentSessionEvent = RecordedEvent;

interface QueuedInput {
  id: string;
  text: string;
  displayText?: string;
  answerTo?: string;
  /** Steer 插队消息：打断当前工具批次后优先处理 */
  steer?: boolean;
}

export class AgentSession {
  readonly id: string;
  readonly #cwd: string;
  readonly #stateDir: string;
  title: string;
  readonly createdAt: string;
  readonly #bus = new AgentEventBus();
  readonly #model: ConversationAgentModel;
  readonly #permissions: PermissionEngine;
  /** 审批等待（超时/abort/scope 记忆/steer 解锁） */
  readonly #approvalWaiter: PermissionWaiter;
  readonly #clarificationWaiter: ClarificationWaiter;
  /** 分支树协调（fork/switch/被放弃路径摘要） */
  readonly #branchOps: BranchCoordinator;
  readonly #tools: ToolExecutor;
  readonly #taskRunner: TaskRunner | undefined;
  readonly #store: SessionStore;
  readonly #traceStore: TraceStore;
  readonly #modelPinned: boolean;
  readonly #experiment: ExperimentSessionSummary | undefined;
  readonly #runtimeUnavailableReason: string | undefined;
  readonly #events: AgentSessionEvent[] = [];
  readonly #queuedInputs: QueuedInput[] = [];
  /** 事件 seq 独立计数器：从恢复时的最后合法记录续，与磁盘对齐
      （崩溃/坏行造成 seq 空洞时不再用 length+1 复用旧号，杜绝前端按 seq 去重丢事件） */
  #eventSeq = 0;
  #approvalTimeoutMs: number;
  readonly #rememberPermission:
    | ((
        scope: "project" | "global",
        rule: PermissionRule,
      ) => Promise<void>)
    | undefined;
  readonly #pricing:
    | Partial<Record<"main" | "cheap" | "explore", ModelPricing>>
    | undefined;
  #updatedAt: string;
  #activeLoop: AgentLoop | undefined;
  #processing = false;
  /** 工具并行执行开关（behavior.parallelTools，热生效；批次含审批需求时自动串行） */
  #parallelTools = false;
  /** 会话状态机与统计聚合（状态/成本/todo 的唯一落点，见 session-state.ts） */
  readonly #state = new SessionStateMachine();
  /** 状态机事件应用的外部依赖（权限档/分支树/模型 todo 同步） */
  get #stateDeps(): SessionStateDeps {
    return {
      permissions: this.#permissions,
      branchOps: this.#branchOps,
      model: this.#model,
    };
  }
  #taskBox: TaskBox | undefined;
  #taskStopReason: "deadline" | "budget" | undefined;
  #taskHardStopped = false;
  /** 任务执行账本（按 taskId 索引；事件流投影 + 运行期记账双入口，保留至会话结束供续跑取用） */
  readonly #ledgerByTask = new Map<string, TaskLedger>();
  /** 当前执行上下文的账本，供 TodoWrite 状态回灌；空闲时不串接其他任务。 */
  #activeLedgerTaskId: string | undefined;
  /** /run 任务期审批超时（--approve-timeout；任务期覆盖会话级配置，结束恢复） */
  #taskApprovalTimeoutMs: number | undefined;
  /** /run 任务期间模型重试+fallback 全部耗尽（sendInput 捕获后置位；
      修复 run_finished 误报 completed——need_user 会把 status 盖成 done） */
  #taskModelFailed = false;
  /** 完成审查（开发验证用）：开关（behavior.completionReview；运行时缺省关） */
  readonly #completionReview: boolean;
  /** 本轮完成的审查循环计数（sendInput 开头重置；打回循环累计，上限 2） */
  #reviewAttempts = 0;
  /** 手动 /review 请求标记（reviewNow 置位；#shouldReview 消费） */
  #reviewRequested = false;
  #taskAcceptance?: {
    status: "passed" | "failed";
    checks: AcceptanceCheckResult[];
    review?: { passed: boolean; issues: string[]; summary: string };
  };
  /** 恢复时检测到的中断任务（run_started 无配对 run_finished；进程崩溃残留） */
  #interruptedTask:
    | {
        taskId: string;
        description: string;
        options?: NonNullable<
          Extract<AgentEvent, { type: "run_started" }>["taskOptions"]
        >;
      }
    | undefined;

  constructor(options: {
    id: string;
    title: string;
    cwd: string;
    mode: PermissionMode;
    model: ConversationAgentModel;
    stateDir?: string;
    /** 运行 cwd 与会话持久化目录解耦；实验子会话仍归父项目管理。 */
    storageDir?: string;
    restoredEvents?: RecordedEvent[];
    permissionRules?: PermissionRule[];
    approvalTimeoutMs?: number;
    rememberPermission?: (
      scope: "project" | "global",
      rule: PermissionRule,
    ) => Promise<void>;
    exploreModelClient?: ModelClient;
    compactModelClient?: ModelClient;
    compactAtEstimatedTokens?: number;
    keepRecentTokens?: number;
    parallelTools?: boolean;
    /** 子代理（Task）超时（ms）；缺省 15 分钟（TaskRunner 默认） */
    subagentTimeoutMs?: number;
    pricing?: Partial<
      Record<"main" | "cheap" | "explore", ModelPricing>
    >;
    /** 文件工具实现（可注入记忆留档钩子等）；缺省新建 */
    files?: AtomicFileTools;
    /** 完成审查开关（behavior.completionReview；运行时缺省关，开发验证用） */
    completionReview?: boolean;
    modelPinned?: boolean;
    experiment?: ExperimentSessionSummary;
    runtimeUnavailableReason?: string;
  }) {
    this.id = options.id;
    this.#cwd = options.cwd;
    this.#stateDir = options.stateDir ?? path.join(os.homedir(), ".myagent");
    this.title = options.title;
    this.createdAt =
      options.restoredEvents?.[0]?.ts ?? new Date().toISOString();
    this.#updatedAt =
      options.restoredEvents?.at(-1)?.ts ?? this.createdAt;
    this.#model = options.model;
    this.#modelPinned = options.modelPinned === true;
    this.#experiment = options.experiment;
    this.#runtimeUnavailableReason = options.runtimeUnavailableReason;
    this.#pricing = options.pricing;
    this.#permissions = new PermissionEngine(
      options.mode,
      options.permissionRules ?? DEFAULT_PERMISSION_RULES,
      { cwd: options.cwd },
    );
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 300_000;
    this.#rememberPermission = options.rememberPermission;
    this.#parallelTools = options.parallelTools ?? false;
    this.#completionReview = options.completionReview ?? false;
    this.#approvalWaiter = new PermissionWaiter({
      bus: this.#bus,
      permissions: this.#permissions,
      approvalTimeoutMs: this.#approvalTimeoutMs,
      ...(this.#rememberPermission
        ? { rememberPermission: this.#rememberPermission }
        : {}),
      setStatus: (status) => {
        this.#state.setStatus(status);
      },
    });
    this.#clarificationWaiter = new ClarificationWaiter({
      setStatus: (status) => this.#state.setStatus(status),
    });
    this.#branchOps = new BranchCoordinator({
      bus: this.#bus,
      model: this.#model,
      ...(options.compactModelClient
        ? { branchSummaryClient: options.compactModelClient }
        : {}),
      ...(this.#pricing ? { pricing: this.#pricing } : {}),
      getTotalTokens: () =>
        this.#state.tokens(),
      getTotalCostCny: () => this.#state.costCny(),
      ...(options.restoredEvents
        ? { restoredEvents: options.restoredEvents }
        : {}),
    });
    const projectKey = Buffer.from(options.cwd).toString("base64url");
    const stateRoot = this.#stateDir;
    const sessionsRoot = options.storageDir ?? path.join(
      stateRoot,
      "projects",
      projectKey,
      "sessions",
    );
    this.#store = new SessionStore(
      path.join(sessionsRoot, `${this.id}.jsonl`),
      this.id,
    );
    this.#traceStore = new TraceStore(
      path.join(sessionsRoot, `${this.id}.trace.jsonl`),
      {
        getBranchId: () => this.#branchOps.currentBranchId(),
        getEventSeq: () => this.#eventSeq,
        // A fingerprint is a per-Turn observation. Do not reuse a time-based
        // cache across turns: a Write followed by the next model call must be
        // able to observe the changed workspace.
        getWorkspace: () => captureWorkspaceFingerprint(this.#cwd),
      },
    );
    const taskRunner = options.exploreModelClient
      ? new TaskRunner({
          cwd: options.cwd,
          bus: this.#bus,
          client: options.exploreModelClient,
          mode: () => this.#permissions.mode,
          // 会话级 deny（用户配置 / /run 硬边界）快照传递给子代理引擎
          rules: () => this.#permissions.rules(),
          approve: async (call, signal) =>
            await this.#approvalWaiter.wait(
              call,
              signal,
              this.#taskApprovalTimeoutMs,
            ),
          reportUsage: (usage) => {
            const costCny = usageCostCny(
              usage,
              this.#pricing?.explore,
            );
            const actualCostCny = usage.costCny ?? costCny;
            this.#bus.emit({
              type: "cost_update",
              ...usage,
              totalTokens:
                this.#state.tokens() +
                usage.input +
                usage.output,
              ...(actualCostCny === undefined
                ? {}
                : {
                    costCny: actualCostCny,
                    totalCostCny:
                      this.#state.costCny() + actualCostCny,
                  }),
            });
          },
          recordTrace: (trace) => this.#traceStore.record(trace),
          ...(options.subagentTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.subagentTimeoutMs }),
          ...(options.files ? { files: options.files } : {}),
        })
      : undefined;
    this.#taskRunner = taskRunner;
    this.#tools = new ToolExecutor(
      options.cwd,
      options.files,
      undefined,
      taskRunner
        ? async (args, signal) =>
            await taskRunner.run(args, signal)
        : undefined,
    );
    this.#store.attach(this.#bus, () => this.#branchOps.currentBranchId());
    this.#bus.subscribe((event) => this.#record(event));
    // 恢复时检测中断任务：最近的 run_started 无配对 run_finished（进程崩溃残留）
    this.#interruptedTask = interruptedTaskFrom(options.restoredEvents);
    if (options.compactModelClient) {
      this.#model.configureCompaction({
        client: options.compactModelClient,
        thresholdTokens:
          options.compactAtEstimatedTokens ?? 90_000,
        keepRecentTokens: options.keepRecentTokens ?? 20_000,
        onCompacted: (result) => {
          for (const fallback of result.fallbacks ?? []) {
            this.#bus.emit({
              type: "model_fallback",
              role: "cheap",
              ...fallback,
            });
          }
          if (result.trace) {
            this.#traceStore.record({
              request: result.trace.request,
              response: result.trace.response,
              tools: [],
              usage: result.usage,
            });
          }
          const costCny = usageCostCny(
            result.usage,
            result.pricing ?? this.#pricing?.cheap,
          );
          const totalTokens =
            this.#state.tokens() +
            result.usage.input +
            result.usage.output;
          this.#bus.emit({
            type: "cost_update",
            input: result.usage.input,
            output: result.usage.output,
            cached: result.usage.cached,
            totalTokens,
            ...(costCny === undefined
              ? {}
              : {
                  costCny,
                  totalCostCny: this.#state.costCny() + costCny,
                }),
          });
          const userEvents = this.#events.filter(
            (record) => record.event.type === "user",
          );
          const keepFromSeq =
            userEvents.at(-result.retainedUserCount)?.seq ?? 1;
          this.#bus.emit({
            type: "context_compacted",
            summary: result.summary,
            ratio: result.ratio,
            keepFromSeq,
            ...(result.fileOps ? { fileOps: result.fileOps } : {}),
          });
        },
      });
    }

    if (options.restoredEvents?.length) {
      for (const record of options.restoredEvents) {
        this.#events.push({
          seq: record.seq,
          ts: record.ts,
          ...(record.branchId ? { branchId: record.branchId } : {}),
          event: record.event,
        });
        // 独立计数器从最后合法记录续（磁盘缺号不产生内存空洞）
        if (record.seq > this.#eventSeq) this.#eventSeq = record.seq;
        // 账本投影与运行期记账共用同一入口（事件流是唯一事实源）
        if (record.event.type === "ledger_update") {
          this.#applyLedgerEvent(record.event);
        }
        this.#state.apply(record.event, this.#stateDeps);
      }
      if (
        this.#state.status === "idle" ||
        this.#state.status === "running" ||
        this.#state.status === "waiting_permission"
      ) {
        this.#state.setStatus("interrupted");
      }
    }
    // 初始权限模式入事件流：恢复时 lastPermissionMode 才能还原初始模式
    // （否则崩溃续跑会从 trust/strict 降级为配置默认，任务权限上下文丢失）。
    // 必须在恢复事件推入之后发射：seq 取 #events.length + 1，
    // 提前发射会拿到 seq=1 与首条 user 事件冲突并被前端按 seq 去重丢弃。
    if (
      options.mode !== "normal" &&
      !options.restoredEvents?.some(
        (record) => record.event.type === "permission_mode_changed",
      )
    ) {
      this.#bus.emit({
        type: "permission_mode_changed",
        mode: options.mode,
      });
    }
  }

  summary(): AgentSessionSummary {
    const summary: AgentSessionSummary = {
      id: this.id,
      title: this.title,
      status: this.#state.status,
      permissionMode: this.#permissions.mode,
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
      totalInputTokens: this.#state.inputTokens(),
      totalOutputTokens: this.#state.outputTokens(),
      totalCachedTokens: this.#state.cachedTokens(),
      totalCostCny: this.#state.costCny(),
      totalMissedTokens: this.#state.missedTokens(),
      totalMissedCostCny: this.#state.missedCostCny(),
      todos: structuredClone(this.#state.todos()),
      toolCallCount: this.#events.filter(
        (record) => record.event.type === "tool_call",
      ).length,
      costByModel: this.#state.costByModel(),
      kind: this.#events.some(
        (record) => record.event.type === "run_started",
      )
        ? "run"
        : "interactive",
    };
    // exactOptionalPropertyTypes 下条件展开会带出 undefined，改用条件赋值
    const firstPlan = this.#events.find(
      (record) => record.event.type === "plan_started",
    );
    const firstMessage =
      firstUserText(this.#events) ??
      (firstPlan?.event.type === "plan_started"
        ? firstPlan.event.task
        : undefined);
    if (firstMessage) {
      summary.firstMessage = firstMessage;
    }
    if (this.#interruptedTask) {
      summary.interruptedTask = {
        taskId: this.#interruptedTask.taskId,
        description: this.#interruptedTask.description,
      };
    }
    const lastReview = [...this.#events]
      .reverse()
      .find((record) => record.event.type === "review_result");
    if (lastReview?.event.type === "review_result") {
      summary.review = {
        passed: lastReview.event.passed,
        attempts: lastReview.event.attempts,
      };
    }
    const plan = taskPlanSummary(this.taskPlan());
    if (plan) summary.plan = plan;
    if (this.#experiment) {
      summary.experiment = structuredClone(this.#experiment);
    }
    return summary;
  }

  events(after = 0): AgentSessionEvent[] {
    return this.#events.filter((event) => event.seq > after);
  }

  /** 最近一次任务计划（从事件流投影，恢复与实时路径一致）。 */
  taskPlan(): TaskPlanState | undefined {
    return taskPlanFromEvents(this.#events);
  }

  /** Agent Harness Flight Recorder trace metadata/details. */
  async traces(): Promise<import("./events.js").AgentTurnTrace[]> {
    return await this.#traceStore.readAll();
  }

  recordExperimentCreated(meta: {
    parentSessionId: string;
    parentTurnId: string;
    parentEventSeq: number;
    providerId: string;
    model: string;
    systemPromptOverlay?: string;
  }): void {
    this.#bus.emit({ type: "experiment_created", ...meta });
  }

  /** 分支树（根分支 main 恒存在） */
  branches(): SessionBranch[] {
    return this.#branchOps.branches();
  }

  /** 当前分支 id */
  currentBranchId(): string {
    return this.#branchOps.currentBranchId();
  }

  /** 从指定 seq 处分裂新分支并切换；后续消息走新分支。
      模型消息历史重建为分支链视角（fork 点之前不变，之后只含新分支）。 */
  forkBranch(forkSeq: number, label?: string): string {
    if (this.#processing || this.#taskBox) {
      throw new Error("会话运行中，请在当前轮结束后分支");
    }
    return this.#branchOps.fork(this.#events, forkSeq, label);
  }

  /** 添加书签：标记指定事件 seq（可重复标记同一 seq 以改名） */
  addBookmark(seq: number, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("书签名称不能为空");
    const target = this.#events.find((record) => record.seq === seq);
    if (!target) throw new Error(`事件 #${seq} 不存在`);
    this.#bus.emit({ type: "label", seq, name: trimmed });
  }

  /** 移除指定 seq 的书签（无则忽略） */
  removeBookmark(seq: number): void {
    this.#bus.emit({ type: "label", seq, name: "" });
  }

  /** 全部书签（按 seq 升序；空名称表示已移除） */
  bookmarks(): Array<{ seq: number; name: string }> {
    const bySeq = new Map<number, string>();
    for (const record of this.#events) {
      if (record.event.type !== "label") continue;
      if (record.event.name) bySeq.set(record.event.seq, record.event.name);
      else bySeq.delete(record.event.seq);
    }
    return [...bySeq.entries()]
      .map(([seq, name]) => ({ seq, name }))
      .sort((a, b) => a.seq - b.seq);
  }

  /** 回溯切换到已存在的分支（不建新节点）；后续消息写入目标分支 */
  switchBranch(branchId: string): void {
    if (this.#processing || this.#taskBox) {
      throw new Error("会话运行中，请在当前轮结束后切换");
    }
    this.#branchOps.switch(this.#events, branchId);
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    // 单一注册表（#bus）：外部订阅排在 #record 之后，直接复用刚记录的 record
    return this.#bus.subscribe((event) => {
      const record = this.#events[this.#events.length - 1];
      if (record && record.event === event) listener(record);
    });
  }

  isProcessing(): boolean {
    return this.#processing;
  }

  /**
   * 会话删除前的收尾标记：关闭事件/追踪落盘写链（文件 unlink 后不得被重建），
   * 内存事件流保留（当前订阅者仍可读到已记录内容）。
   */
  markClosed(): void {
    this.#store.close();
    this.#traceStore.close();
  }

  applyConfigChange(config: MyAgentConfig): void {
    this.#permissions.setMode(config.permissions.mode);
    this.#permissions.setRules([
      ...DEFAULT_PERMISSION_RULES,
      ...config.permissions.rules,
    ]);
    this.#approvalTimeoutMs = config.permissions.approvalTimeoutMs;
    this.#parallelTools = config.behavior?.parallelTools === true;
  }

  /** 配置变更后替换各角色模型客户端（API Key、模型、fallback 等即时生效） */
  applyModelConfigChange(clients: {
    main?: ModelClient | undefined;
    compact?: ModelClient | undefined;
    explore?: ModelClient | undefined;
  }): void {
    if (this.#modelPinned) return;
    if (clients.main) this.#model.setClient(clients.main);
    if (clients.compact) {
      this.#model.setCompactionClient(clients.compact);
      // 分支摘要客户端同步刷新（此前模型热切换后仍用陈旧 cheap 客户端）
      this.#branchOps.setBranchSummaryClient(clients.compact);
    }
    if (clients.explore) this.#taskRunner?.setClient(clients.explore);
  }

  setPermissionMode(mode: PermissionMode): void {
    this.#permissions.setMode(mode);
    this.#bus.emit({ type: "permission_mode_changed", mode });
  }

  /** 更新会话标题并写入事件流（恢复时以事件流为准；同名也写，保证显式标题可恢复） */
  setTitle(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.title = trimmed;
    this.#bus.emit({ type: "session_info", name: trimmed });
  }

  /** 交互撤销：回滚最近一次 Agent 编辑（EditJournal 记录 Edit/MultiEdit/Write）。
      安全语义：文件已被后续修改（hash 不匹配，可能含用户手动改动）时拒绝。 */
  async undoLastEdit(): Promise<
    | { ok: true; path: string }
    | { ok: false; reason: "empty" | "modified" }
  > {
    const journal = this.#tools.files.journal;
    const entry = journal.entries().at(-1);
    if (!entry) return { ok: false, reason: "empty" };
    const ok = await journal.rollbackLast();
    return ok ? { ok: true, path: entry.path } : { ok: false, reason: "modified" };
  }

  /**
   * 启动只读规划。先持久化 plan_started，再异步探索，确保 Web/CLI 立即获得
   * 可恢复的计划身份；规划模型与主对话隔离，不会把草稿污染执行上下文。
   */
  async startPlan(task: string): Promise<void> {
    if (this.#runtimeUnavailableReason) {
      throw new Error(this.#runtimeUnavailableReason);
    }
    const trimmed = task.trim();
    if (!trimmed) throw new Error("规划任务不能为空");
    if (this.#processing || this.#taskBox) {
      throw new Error("当前会话已有任务在运行");
    }
    if (this.taskPlan()?.status === "awaiting_approval") {
      throw new Error("当前已有计划等待决策");
    }
    await this.#beginPlanning({
      planId: randomUUID(),
      task: trimmed,
      revision: 1,
    });
  }

  /** 对等待中的计划作决策；批准后在同一会话里立刻进入普通执行或 /run。 */
  async decidePlan(
    decision: PlanDecision,
    feedback?: string,
  ): Promise<void> {
    if (this.#processing || this.#taskBox) {
      throw new Error("当前会话已有任务在运行");
    }
    const plan = this.taskPlan();
    if (!plan || plan.status !== "awaiting_approval" || !plan.content) {
      throw new Error("当前没有等待决策的计划");
    }
    const trimmedFeedback = feedback?.trim();
    if (decision === "revision_requested" && !trimmedFeedback) {
      throw new Error("修改计划时必须填写意见");
    }
    this.#bus.emit({
      type: "plan_decision",
      planId: plan.planId,
      revision: plan.revision,
      ...(plan.digest ? { digest: plan.digest } : {}),
      decision,
      ...(trimmedFeedback ? { feedback: trimmedFeedback } : {}),
    });
    await this.flush();

    if (decision === "analysis_only") return;
    if (decision === "revision_requested") {
      await this.#beginPlanning({
        planId: plan.planId,
        task: plan.task,
        revision: plan.revision + 1,
        previousPlan: plan.content,
        ...(trimmedFeedback ? { feedback: trimmedFeedback } : {}),
      });
      return;
    }

    // 用户批准的是 digest 绑定的 Markdown；执行数据必须现场从同一正文重建，
    // 不能让独立持久化的 contract 字段成为命令注入通道。
    const contract = taskContractFromMarkdown(plan.content);
    const units = plan.units ?? contract.steps;
    if (plan.task.startsWith("/run")) {
      this.startRunTask(parseRunCommand(plan.task), plan.content, units);
      return;
    }
    if (contract.checks.length > 0) {
      this.startRunTask({
        description: plan.task,
        ...(contract.goal ? { goal: contract.goal } : {}),
        checks: contract.checks,
        hardRules: [],
        semanticBounds: [],
        permission: this.#permissions.mode,
      }, plan.content, units);
      return;
    }
    const planTaskId = `plan:${plan.planId}`;
    const ledger =
      this.#ledgerByTask.get(planTaskId) ?? new TaskLedger(planTaskId);
    this.#ledgerByTask.set(planTaskId, ledger);
    for (const unit of ledger.initializeTaskUnits(units)) {
      this.#bus.emit({ type: "ledger_update", taskId: planTaskId, unit });
    }
    this.#activeLedgerTaskId = planTaskId;
    if (units.length > 0) {
      const todos = units.map((unit, index) => ({
        id: unit.id,
        content: unit.content,
        status: index === 0 ? ("in_progress" as const) : ("pending" as const),
      }));
      this.#tools.todos.replace(todos);
      this.#bus.emit({ type: "todo_update", todos });
    }
    this.#tools.setFileWrittenListener(async (absPath) => {
      const unit = ledger.markFileWritten(normalizeLedgerPath(this.#cwd, absPath));
      if (unit) this.#bus.emit({ type: "ledger_update", taskId: planTaskId, unit });
    });
    void this.sendInput(
      buildApprovedPlanPrompt(plan.task, plan.content),
      plan.task,
    ).catch((error) => {
      this.#bus.emit({
        type: "error",
        message:
          error instanceof Error ? error.message : "批准后的任务启动失败",
      });
    }).finally(() => {
      this.#tools.setFileWrittenListener(undefined);
      this.#activeLedgerTaskId = undefined;
    });
  }

  async #beginPlanning(options: {
    planId: string;
    task: string;
    revision: number;
    previousPlan?: string;
    feedback?: string;
  }): Promise<void> {
    this.#processing = true;
    this.#bus.emit({
      type: "plan_started",
      planId: options.planId,
      task: options.task,
      revision: options.revision,
    });
    try {
      await this.flush();
    } catch (error) {
      this.#processing = false;
      throw error;
    }
    void this.#generatePlan(options);
  }

  async #generatePlan(options: {
    planId: string;
    task: string;
    revision: number;
    previousPlan?: string;
    feedback?: string;
  }): Promise<void> {
    const planningBus = new AgentEventBus();
    const chunks: string[] = [];
    const unsubscribe = planningBus.subscribe((event) => {
      if (event.type === "text_delta") {
        chunks.push(event.text);
        return;
      }
      // done 会把会话提前标成完成；最终计划由 plan_proposed 一次性发布。
      if (
        event.type === "done" ||
        event.type === "need_user" ||
        event.type === "interrupted" ||
        event.type === "error"
      ) {
        return;
      }
      this.#bus.emit(event);
    });
    const planningModel = new ConversationAgentModel(
      this.#model.client,
      buildTaskPlanningPrompt(options),
      new ContextManager({ cwd: this.#cwd, stateDir: this.#stateDir }),
      { toolNames: PLAN_TOOL_NAMES },
    );
    const loop = new AgentLoop({
      bus: planningBus,
      model: planningModel,
      permissions: new PermissionEngine("trust", []),
      tools: this.#tools,
      approve: async () => ({ granted: false }),
      initialTotalTokens: this.#state.tokens(),
      getTotalTokens: () => this.#state.tokens(),
      ...(this.#pricing?.main ? { pricing: this.#pricing.main } : {}),
      getTotalCostCny: () => this.#state.costCny(),
      modelRole: "main",
      maxTurns: 12,
      parallelTools: false,
      allowedToolNames: PLAN_TOOL_NAMES,
      recordTrace: (trace) => this.#traceStore.record(trace),
      getEventSeq: () => this.#eventSeq,
    });
    this.#activeLoop = loop;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      loop.interrupt();
    }, 3 * 60_000);
    try {
      await loop.run();
      const content = normalizePlanText(chunks.join(""));
      const requiredSections = [
        "## 目标",
        "## 执行步骤",
        "## 预计修改文件",
        "## 验证方式",
        "## 风险与待确认",
      ];
      if (
        timedOut ||
        this.#state.status === "interrupted" ||
        !content ||
        !requiredSections.every((section) => content.includes(section))
      ) {
        throw new Error(
          timedOut
            ? "规划超时"
            : this.#state.status === "interrupted"
              ? "规划已中断"
              : "模型未返回完整的结构化计划",
        );
      }
      this.#bus.emit({
        type: "plan_proposed",
        planId: options.planId,
        task: options.task,
        revision: options.revision,
        content,
        digest: taskPlanDigest(options.revision, content),
        units: extractPlanExecutionUnits(content),
        contract: taskContractFromMarkdown(content),
      });
    } catch (error) {
      const interrupted =
        !timedOut && this.#state.status === "interrupted";
      this.#bus.emit({
        type: "plan_failed",
        planId: options.planId,
        revision: options.revision,
        message: error instanceof Error ? error.message : "生成计划失败",
        ...(interrupted ? { interrupted: true } : {}),
      });
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      this.#activeLoop = undefined;
      this.#processing = false;
      await this.flush().catch((error) => {
        this.#state.setStatus("error");
        this.#bus.emit({
          type: "error",
          message: `规划事件落盘失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
    }
  }

  async sendInput(
    message: string,
    displayText?: string,
    options?: {
      steer?: boolean;
      taskMode?: boolean;
      checksMode?: boolean;
      answerTo?: string;
    },
  ): Promise<void> {
    if (this.#runtimeUnavailableReason) {
      throw new Error(this.#runtimeUnavailableReason);
    }
    const text = message.trim();
    if (!text) throw new Error("消息不能为空");
    if (this.taskPlan()?.status === "planning") {
      throw new Error("计划正在生成，请等待完成或先中止规划");
    }
    if (
      !this.#processing &&
      this.taskPlan()?.status === "awaiting_approval"
    ) {
      throw new Error("当前计划等待决策，请先批准、修改或选择仅分析");
    }
    if (this.#processing) {
      const steer = options?.steer === true;
      const queued: QueuedInput = {
        id: randomUUID(),
        text,
        ...(options?.answerTo ? { answerTo: options.answerTo } : {}),
        ...(steer ? { steer: true } : {}),
      };
      if (steer) {
        // 插队到队首，并软打断当前循环（当前工具完成后拒绝剩余调用）
        this.#queuedInputs.unshift(queued);
        this.#activeLoop?.steer();
        this.#taskRunner?.steer();
        // 取消挂起审批：否则 steer 会被阻塞在 approve Promise 上无法生效
        //（子代理审批同样冒泡到此，一并解锁）
        this.#approvalWaiter.cancelAll("用户插入新指令（steer），已取消审批");
      } else {
        this.#queuedInputs.push(queued);
      }
      this.#bus.emit({
        type: "user_queued",
        text: queued.text,
        queueId: queued.id,
        ...(steer ? { steer: true } : {}),
      });
      return;
    }

    this.#processing = true;
    // 每轮完成独立计审查次数（打回循环内累计，上限 2）
    this.#reviewAttempts = 0;
    let current: QueuedInput | undefined = {
      id: "",
      text,
      ...(displayText ? { displayText } : {}),
      ...(options?.answerTo ? { answerTo: options.answerTo } : {}),
    };
    try {
      while (current !== undefined) {
        this.#model.addUserMessage(current.text);
        this.#bus.emit({
          type: "user",
          text: current.displayText ?? current.text,
          ...(current.displayText
            ? { modelText: current.text }
            : {}),
          ...(current.id ? { queueId: current.id } : {}),
          ...(current.answerTo ? { answerTo: current.answerTo } : {}),
        });
        this.#state.setStatus("running");
        this.#updatedAt = new Date().toISOString();

        const loop = new AgentLoop({
          bus: this.#bus,
          model: this.#model,
          permissions: this.#permissions,
          tools: this.#tools,
          approve: async (call, signal) =>
            await this.#approvalWaiter.wait(
              call,
              signal,
              this.#taskApprovalTimeoutMs,
            ),
          askUser: async (interaction, signal) => {
            // 先注册 waiter 再 flush，避免 SSE 刚显示问题、用户立即点击时尚无 pending 的竞态。
            const waiting = this.#clarificationWaiter.wait(interaction, signal);
            await this.flush();
            return await waiting;
          },
          initialTotalTokens:
            this.#state.tokens(),
          getTotalTokens: () =>
            this.#state.tokens(),
          ...(this.#pricing?.main
            ? { pricing: this.#pricing.main }
            : {}),
          getTotalCostCny: () => this.#state.costCny(),
          beforeTurn: async () => this.#checkTaskBox(),
          modelRole: "main",
          modelCompactCount: () => this.#model.compactionCount,
          parallelTools: this.#parallelTools,
          getTodos: () => this.#state.todos(),
          recordTrace: (trace) => this.#traceStore.record(trace),
          getEventSeq: () => this.#eventSeq,
        });
        this.#activeLoop = loop;
        try {
          await loop.run();
          // 任务验收链：完成审查（有写操作 / 任务模式 / 手动触发；问答跳过）
          if (await this.#shouldReview(options)) {
            const review = await this.#runReview(current.text);
            this.#bus.emit({
              type: "review_result",
              ...review,
              attempts: this.#reviewAttempts,
            });
            if (review.passed && this.#activeLedgerTaskId) {
              const ledger = this.#ledgerByTask.get(this.#activeLedgerTaskId);
              for (const unit of ledger?.markVerified("完成审查通过") ?? []) {
                this.#bus.emit({ type: "ledger_update", taskId: ledger!.taskId, unit });
              }
            }
            if (!review.passed && this.#reviewAttempts < 2) {
              // 打回：审查结论注入主循环继续修，本轮完成后再审
              this.#model.addUserMessage(
                `完成审查未通过（第 ${this.#reviewAttempts} 次）：\n${review.issues.join("\n")}\n请修复这些问题并重新验证后再次宣布完成。`,
              );
              continue;
            }
          }
        } catch (error) {
          if (error instanceof ModelRetriesExhaustedError) {
            // 重试与 fallback 全部耗尽：可操作化指引（分类 + 原文 + 建议），
            // 并发出 error 级 notify，无人值守时 webhook 能推送出去（失败要响）
            const guidance = modelErrorGuidanceText(error);
            this.#taskModelFailed = true;
            this.#bus.emit({
              type: "notify",
              level: "error",
              message: `模型调用持续失败：${guidance}`,
            });
            this.#bus.emit({
              type: "need_user",
              question: `${guidance}输入“继续”重试。`,
            });
          } else {
            this.#state.setStatus("error");
            this.#bus.emit({
              type: "error",
              message:
                error instanceof Error ? error.message : "模型运行失败",
            });
          }
        } finally {
          this.#activeLoop = undefined;
          try {
            await this.flush();
          } catch (error) {
            // 事件落盘失败：失败可见（事件流内存仍完整）但不崩进程——
            // 裸 void sendInput 调用点无 catch，未处理的 rejection 会让 Node 直接退出
            this.#state.setStatus("error");
            this.#bus.emit({
              type: "error",
              message: `事件落盘失败：${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
        }

        // 任务模式（runTask 调用）：只处理任务 prompt 本身，任务期间排队的
        // 用户消息留给任务结束后的空闲路径（权限已复位）处理——排队消息
        // 不得在任务级权限/任务盒约束下执行，deadline 也不得吞掉用户消息
        if (options?.taskMode === true) break;
        current = this.#queuedInputs.shift();
      }
    } finally {
      this.#processing = false;
    }
  }

  /** 最近一个尚未被用户回答的结构化问题；普通文本输入也可完成回答。 */
  pendingQuestionId(): string | undefined {
    const pending = [...this.#events]
      .reverse()
      .find(
        (record) =>
          record.event.type === "need_user" && record.event.questionId,
      );
    if (
      !pending ||
      pending.event.type !== "need_user" ||
      !pending.event.questionId
    ) {
      return undefined;
    }
    const questionId = pending.event.questionId;
    const answered = this.#events.some(
      (record) =>
        record.seq > pending.seq &&
        record.event.type === "user" &&
        record.event.answerTo === questionId,
    );
    return answered ? undefined : questionId;
  }

  pendingQuestion(): Extract<AgentEvent, { type: "need_user" }> | undefined {
    const questionId = this.pendingQuestionId();
    if (!questionId) return undefined;
    const record = [...this.#events]
      .reverse()
      .find(
        (candidate) =>
          candidate.event.type === "need_user" &&
          candidate.event.questionId === questionId,
      );
    return record?.event.type === "need_user" ? structuredClone(record.event) : undefined;
  }

  async runTask(
    options: RunTaskOptions,
    resumeTaskId?: string,
    approvedPlan?: string,
    approvedPlanUnits?: readonly PlanExecutionUnit[],
  ): Promise<void> {
    if (this.#runtimeUnavailableReason) {
      throw new Error(this.#runtimeUnavailableReason);
    }
    if (this.#processing || this.#taskBox) {
      throw new Error("当前会话已有任务在运行");
    }
    if (this.taskPlan()?.status === "awaiting_approval") {
      throw new Error("当前计划等待决策，请先批准、修改或选择仅分析");
    }
    if (options.budgetCny !== undefined && !this.#pricing?.main) {
      throw new Error(
        "--budget 需要模型单价：请在 Web 设置页的“角色模型 → 费用与 fallback”中为 main 模型填写单价；或去掉 --budget，仅用 --until 控制时长",
      );
    }
    const previousMode = this.#permissions.mode;
    const previousRules = this.#permissions.rules();
    const previousApprovalTimeout = this.#approvalTimeoutMs;
    // 回滚基线：只撤销任务开始之后的编辑（任务前的交互编辑是用户工作，硬停止不得误删）
    const journalBaseline = this.#tools.files.journal.entries().length;
    // 续跑沿用原 taskId（事件流配对 run_finished）；新任务生成新 id
    const taskBox = new TaskBox(
      options,
      this.#state.costCny(),
      resumeTaskId,
    );
    this.#taskBox = taskBox;
    // 任务执行账本：续跑复用已投影的账本（同一进程内 interrupt 后 / 崩溃恢复后），新任务新建
    const ledger =
      this.#ledgerByTask.get(taskBox.id) ?? new TaskLedger(taskBox.id);
    this.#ledgerByTask.set(taskBox.id, ledger);
    const planUnits = approvedPlanUnits ?? [];
    for (const unit of ledger.initializeTaskUnits(planUnits)) {
      this.#bus.emit({ type: "ledger_update", taskId: taskBox.id, unit });
    }
    const firstPlanUnit = ledger.markNextPendingInProgress();
    if (firstPlanUnit) {
      this.#bus.emit({ type: "ledger_update", taskId: taskBox.id, unit: firstPlanUnit });
    }
    if (planUnits.length > 0) {
      const todos = planUnits.map((unit, index) => ({
        id: unit.id,
        content: unit.content,
        status: index === 0 ? ("in_progress" as const) : ("pending" as const),
      }));
      this.#tools.todos.replace(todos);
      this.#bus.emit({ type: "todo_update", todos });
    }
    // 系统自动记账通道：Edit/MultiEdit/Write 实际写入后标记 in_progress（等待验证）
    this.#tools.setFileWrittenListener(async (absPath) => {
      const unit = ledger.markFileWritten(
        normalizeLedgerPath(this.#cwd, absPath),
      );
      if (unit) {
        this.#bus.emit({
          type: "ledger_update",
          taskId: ledger.taskId,
          unit,
        });
      }
    });
    this.#activeLedgerTaskId = taskBox.id;
    this.#taskStopReason = undefined;
    this.#taskHardStopped = false;
    this.#taskModelFailed = false;
    this.#permissions.setMode(options.permission ?? previousMode);
    // 任务级审批控制：--auto-allow 规则任务期生效（结束后随 previousRules 恢复一并回落）
    const taskAllowRules = (options.autoAllowRules ?? []).map((pattern) => ({
      effect: "allow" as const,
      pattern,
    }));
    this.#permissions.setRules([
      ...previousRules,
      ...options.hardRules,
      ...taskAllowRules,
    ]);
    // 任务级审批超时（--approve-timeout）覆盖会话级配置，finally 恢复
    if (options.approveTimeoutMs !== undefined) {
      this.#approvalTimeoutMs = options.approveTimeoutMs;
      this.#taskApprovalTimeoutMs = options.approveTimeoutMs;
    }
    // 续跑时事件流已存在原 run_started（含原 taskOptions），不再重复发
    if (!resumeTaskId) {
      this.#bus.emit({
        type: "run_started",
        taskId: taskBox.id,
        description: options.description,
        permissionMode: this.#permissions.mode,
        ...(options.deadline ? { deadline: options.deadline } : {}),
        ...(options.budgetCny === undefined
          ? {}
          : { budgetCny: options.budgetCny }),
        hardRules: structuredClone(options.hardRules),
        taskOptions: serializeTaskOptions(options),
      });
    }
    let status: "completed" | "interrupted" | "failed" = "completed";
    let reason:
      | "done" | "deadline" | "budget" | "error" | "interrupted" | "acceptance" | "review" = "done";
    this.#taskAcceptance = { status: "passed", checks: [] };
    try {
      const checks = options.checks ?? [];
      const maxAcceptanceRounds = checks.length > 0 ? 2 : 0;
      let accepted = false;
      for (let round = 0; round <= maxAcceptanceRounds && !accepted; round += 1) {
        const taskPrompt =
          round === 0
            ? (resumeTaskId ? resumePrompt(taskBox, this.#state.costCny()) : taskBox.prompt())
            : "请根据上一轮验收失败证据修复问题，然后重新完成任务。";
        await this.sendInput(
          round === 0 && approvedPlan
            ? `${buildApprovedPlanPrompt(options.description, approvedPlan)}\n\n${taskPrompt}`
            : taskPrompt,
          round === 0
            ? (resumeTaskId ? `/resume ${options.description}` : `/run ${options.description}`)
            : `/acceptance-retry ${options.description}`,
          { taskMode: true, checksMode: checks.length > 0 },
        );
        const stopReasonAfterModel = this.#taskStopReason as "deadline" | "budget" | undefined;
        if ((stopReasonAfterModel !== undefined && stopReasonAfterModel !== "budget") || this.#taskModelFailed || this.#state.status === "error") break;
        if (checks.length === 0) { accepted = true; break; }
        const remainingMs = options.deadline ? Date.parse(options.deadline) - Date.now() : undefined;
        if (remainingMs !== undefined && remainingMs <= 0) {
          this.#taskStopReason = "deadline";
          this.#taskHardStopped = true;
          break;
        }
        this.#bus.emit({ type: "acceptance_started", taskId: taskBox.id, attempt: round + 1, checks: [...checks] });
        const results = await runAcceptanceChecks({
          cwd: this.#cwd,
          checks,
          timeoutMs: options.checkTimeoutMs ?? 300_000,
          ...(remainingMs === undefined ? {} : { deadlineAt: Date.parse(options.deadline!) }),
        });
        if (!this.#taskStopReason && options.deadline && Date.now() >= Date.parse(options.deadline)) {
          this.#taskStopReason = "deadline";
          this.#taskHardStopped = true;
        }
        results.forEach((result, index) => {
          this.#bus.emit({
            type: "acceptance_result",
            taskId: taskBox.id,
            attempt: round + 1,
            command: result.command,
            index,
            status: result.status,
            ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
            durationMs: result.durationMs,
            ...(result.output ? { output: result.output } : {}),
          });
        });
        this.#taskAcceptance = { status: results.every((result) => result.status === "passed") ? "passed" : "failed", checks: results };
        accepted = this.#taskAcceptance.status === "passed";
        if (this.#taskStopReason && !accepted) break;
        if (!accepted && round < maxAcceptanceRounds && !this.#taskStopReason) {
          const failures = results.filter((result) => result.status !== "passed");
          this.#model.addUserMessage(`机器验收未通过（第 ${round + 1} 轮）：\n${failures.map((result) => `${result.command}: ${result.status}\n${result.output}`).join("\n")}\n请修复后重新运行。`);
        }
        if (accepted && !this.#taskStopReason && this.#tools.files.journal.entries().length > journalBaseline && (this.#completionReview || checks.length > 0)) {
          const review = await this.#runReview(options.description, journalBaseline, results);
          this.#taskAcceptance = { ...this.#taskAcceptance, review };
          this.#bus.emit({ type: "review_result", ...review, attempts: this.#reviewAttempts });
          if (!review.passed) {
            accepted = false;
            if (round < maxAcceptanceRounds && !this.#taskStopReason) {
              this.#model.addUserMessage(`完成审查未通过（第 ${round + 1} 轮）：\n${review.issues.join("\n")}\n请修复后重新运行全部机器验收命令。`);
            }
          }
        }
        if (
          accepted &&
          !this.#taskStopReason &&
          (checks.length > 0 ||
            this.#taskAcceptance?.review?.passed === true) &&
          (!this.#taskAcceptance?.review ||
            this.#taskAcceptance.review.passed)
        ) {
          const evidence = checks.length > 0 ? `验收通过：${checks.join("；")}` : "完成审查通过";
          for (const unit of ledger.markVerified(evidence)) {
            this.#bus.emit({ type: "ledger_update", taskId: ledger.taskId, unit });
          }
        }
      }
      if (checks.length > 0 && !accepted) {
        status = "failed";
        reason = this.#taskAcceptance?.review && !this.#taskAcceptance.review.passed ? "review" : "acceptance";
      }
      if (this.#taskStopReason) {
        const changed = this.#tools.files.journal.entries().length > journalBaseline;
        status = options.checks?.length && (!accepted || changed) ? "interrupted" : (this.#taskHardStopped ? "interrupted" : "completed");
        reason = this.#taskStopReason;
      } else if (this.#state.status === "error" || this.#taskModelFailed) {
        status = "failed";
        reason = "error";
      } else if (this.#state.status === "interrupted") {
        status = "interrupted";
        reason = "interrupted";
      }
    } catch (error) {
      status = "failed";
      reason = "error";
      throw error;
    } finally {
      // 优雅终止：硬停止时自动回滚 Agent 自己的编辑（仅任务期条目，
      // 任务前交互编辑保留；哈希守卫仍防误回滚被后续改动过的文件）
      if (this.#taskHardStopped) {
        const journal = this.#tools.files.journal;
        let rolledBack = 0;
        while (journal.entries().length > journalBaseline) {
          const ok = await journal.rollbackLast().catch(() => false);
          if (!ok) break;
          rolledBack += 1;
        }
        if (rolledBack > 0) {
          this.#bus.emit({
            type: "notify",
            level: "info",
            message: `优雅终止：已自动回滚 ${rolledBack} 项编辑`,
          });
        }
      }
      const currentRules = this.#permissions.rules();
      const rememberedDuringTask = currentRules.filter(
        (rule) =>
          rule.effect === "allow" &&
          !previousRules.some(
            (candidate) =>
              candidate.effect === rule.effect &&
              candidate.pattern === rule.pattern,
          ) &&
          // 任务期注入的 --auto-allow 规则随任务结束回落，不并入会话记忆
          !taskAllowRules.some(
            (candidate) => candidate.pattern === rule.pattern,
          ),
      );
      this.#permissions.setRules([
        ...previousRules,
        ...rememberedDuringTask,
      ]);
      this.#permissions.setMode(previousMode);
      // 任务级审批超时回落会话级配置
      this.#approvalTimeoutMs = previousApprovalTimeout;
      this.#taskApprovalTimeoutMs = undefined;
      // 权限档是会话级状态且只在事件流持久化（index.json 已废除）：
      // 恢复任务前模式的事件，保证重启后 restore 能还原到任务结束时的真实档位
      this.#bus.emit({
        type: "permission_mode_changed",
        mode: previousMode,
      });
      this.#taskBox = undefined;
      this.#tools.setFileWrittenListener(undefined);
      this.#activeLedgerTaskId = undefined;
      // 无机器验收/完成审查证据时，成功终态只能归并为 done，不能伪造 verified；
      // failed/interrupted/deadline/budget 路径保留 pending/in_progress 供恢复和排查。
      if (status === "completed" && reason === "done") {
        for (const unit of ledger.markCompletedWithoutVerification()) {
          this.#bus.emit({ type: "ledger_update", taskId: ledger.taskId, unit });
        }
      }
      this.#bus.emit({
        type: "run_finished",
        taskId: taskBox.id,
        status,
        reason,
      });
      if (resumeTaskId && this.#interruptedTask?.taskId === taskBox.id) {
        this.#interruptedTask = undefined;
      }
      await this.flush();
      // 任务期排队的用户消息：权限/任务盒已复位，按普通消息消费——
      // 避免悬置到用户下次发送才被拾起，也保证其不在任务约束下执行
      this.#drainQueuedInputs();
    }
  }

  /** 任务结束后消费排队消息（权限已复位；失败兜底为会话 error 事件，不崩进程） */
  #drainQueuedInputs(): void {
    const first = this.#queuedInputs.shift();
    if (!first) return;
    void this.sendInput(first.text, first.displayText, {
      ...(first.steer ? { steer: true } : {}),
    }).catch((error) => {
      if (error instanceof Error) {
        this.#bus.emit({
          type: "error",
          message: error.message,
        });
      }
    });
  }

  startRunTask(
    options: RunTaskOptions,
    approvedPlan?: string,
    approvedPlanUnits?: readonly PlanExecutionUnit[],
  ): void {
    void this.runTask(options, undefined, approvedPlan, approvedPlanUnits).catch((error) => {
      this.#bus.emit({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "无人值守任务启动失败",
      });
    });
  }

  /** 崩溃中断的任务信息（restore 后存在时 Web/CLI 展示「续跑」入口） */
  interruptedTask(): {
    taskId: string;
    description: string;
  } | undefined {
    if (!this.#interruptedTask) return undefined;
    return {
      taskId: this.#interruptedTask.taskId,
      description: this.#interruptedTask.description,
    };
  }

  /** 任务执行账本只读访问（Web 面板展示 / 续跑注入用）；无则 undefined */
  ledgerFor(taskId: string): TaskLedger | undefined {
    return this.#ledgerByTask.get(taskId);
  }

  /**
   * 续跑崩溃中断的任务：用 run_started 事件里持久化的完整任务选项重建
   * TaskBox（沿用原 taskId 与 deadline/budget 语义），注入续跑指令继续执行。
   */
  async resumeTask(): Promise<void> {
    if (!this.#interruptedTask) {
      throw new Error("当前会话没有中断的任务可续跑");
    }
    if (this.#processing || this.#taskBox) {
      throw new Error("当前会话已有任务在运行");
    }
    const serialized = this.#interruptedTask.options;
    if (!serialized) {
      throw new Error(
        "该中断任务缺少完整选项（旧版本事件流），无法续跑；请重新发起任务",
      );
    }
    await this.runTask(
      taskOptionsFromSerialized(serialized),
      this.#interruptedTask.taskId,
    );
  }

  /** 完成审查触发条件：开关开 + 未超上限 + （有写操作 或 任务模式 或 手动标记） */
  async #shouldReview(options?: { taskMode?: boolean; checksMode?: boolean }): Promise<boolean> {
    if (options?.checksMode === true) return false;
    if (this.#completionReview === false) return false;
    if (this.#reviewAttempts >= 2) return false;
    if (options?.taskMode === true) return true;
    if (this.#reviewRequested) {
      this.#reviewRequested = false;
      return true;
    }
    return this.#tools.files.journal.entries().length > 0;
  }

  /** 执行完成审查：独立 TaskRunner（main client + 只读 + 审查 prompt） */
  async #runReview(taskReq: string, journalBaseline = 0, checks?: AcceptanceCheckResult[]): Promise<{
    passed: boolean;
    issues: string[];
    summary: string;
  }> {
    this.#reviewAttempts += 1;
    const journal = this.#tools.files.journal.entries().slice(journalBaseline);
    const modifiedFiles = [
      ...new Set(journal.map((entry) => entry.path)),
    ];
    // 最近验证结果：最后一个 tool_result 的 summary
    const lastResult = [...this.#events]
      .reverse()
      .find((record) => record.event.type === "tool_result");
    const checkEvidence = checks?.map((result) => `${result.command}: ${result.status}\n${result.output}`).join("\n")
    const prompt = buildReviewPrompt({
      taskReq,
      modifiedFiles,
      ...(checkEvidence
        ? { lastVerification: checkEvidence }
        : lastResult?.event.type === "tool_result"
          ? { lastVerification: lastResult.event.summary }
          : {}
      ),
      todos: this.#state.todos(),
    });
    const runner = new TaskRunner({
      cwd: this.#cwd,
      bus: this.#bus,
      client: this.#model.client,
      mode: () => this.#permissions.mode,
      rules: () => this.#permissions.rules(),
      approve: async (call, signal) =>
        await this.#approvalWaiter.wait(
          call,
          signal,
          this.#taskApprovalTimeoutMs,
        ),
      reportUsage: (usage) => {
        const costCny = usageCostCny(usage, this.#pricing?.main);
        const actualCostCny = usage.costCny ?? costCny;
        this.#bus.emit({
          type: "cost_update",
          ...usage,
          totalTokens:
            this.#state.tokens() + usage.input + usage.output,
          ...(actualCostCny === undefined
            ? {}
            : {
                costCny: actualCostCny,
                totalCostCny:
                  this.#state.costCny() + actualCostCny,
              }),
        });
      },
      recordTrace: (trace) => this.#traceStore.record(trace),
      // 审查是短任务：3 分钟 + 12 轮上限（成本兜底）
      timeoutMs: 3 * 60_000,
      maxTurns: 12,
    });
    const result = await runner.run(
      {
        description: `[完成审查] ${taskReq.slice(0, 24)}`,
        prompt,
        writable: false,
      },
      new AbortController().signal,
    );
    return parseReviewResult(
      typeof result.output === "string" ? result.output : "",
    );
  }

  /** 手动触发完成审查（/review 命令；运行中则忽略） */
  async reviewNow(): Promise<void> {
    if (this.#processing) return;
    const lastUser = [...this.#events]
      .reverse()
      .find((record) => record.event.type === "user");
    if (!lastUser || lastUser.event.type !== "user") return;
    this.#reviewAttempts = 0;
    const review = await this.#runReview(lastUser.event.text);
    this.#bus.emit({
      type: "review_result",
      ...review,
      attempts: this.#reviewAttempts,
    });
    if (!review.passed && this.#reviewAttempts < 2) {
      this.#model.addUserMessage(
        `完成审查未通过（第 ${this.#reviewAttempts} 次）：\n${review.issues.join("\n")}\n请修复这些问题并重新验证后再次宣布完成。`,
      );
      void this.sendInput("", undefined);
    }
  }

  async initializeProject(): Promise<void> {
    if (this.#processing || this.#taskBox) {
      throw new Error("当前会话已有任务在运行");
    }
    await this.sendInput(
      [
        "[项目初始化]",
        "你的目标：生成一份简洁的 AGENTS.md 草稿，经用户批准后落盘。",
        "工作方式（严格遵守顺序）：",
        "0. 先用一次 Glob 或 ls 判断项目是否为空（无任何源码/配置文件）：",
        "   - 若为空（或仅有 .git 等空壳）：跳过 Task 子代理，直接生成最小骨架草稿——说明这是全新空项目，技术栈待定，各节留占位（如 `暂无，待技术栈确定后补充`），并在回复中向用户说明「目录为空，建议先搭建项目骨架后再 /init 完善」。",
        "   - 若非空：继续下面步骤。",
        "1. 调用一次只读 Task 子代理完成扫描：目录结构、README、依赖清单、构建/测试/lint 配置与入口文件。探索全文在子代理上下文中完成，你只接收它的三段式结论。",
        "2. 拿到结论后立即生成 AGENTS.md 草稿：技术栈、安装/构建/测试/lint 命令、目录导览、已验证约定。",
        "3. 若 AGENTS.md 已存在，先 Read 原文件，确认修改点。",
        "4. 用 Write 工具提交完整草稿（路径 AGENTS.md）：Write 会触发权限审批卡片，用户批准后才落盘——这就是征求用户意见的机制。不要先在对话中征询用户、不要粘贴完整草稿，对话文本只展示 2-3 行摘要。",
        "硬性限制：",
        "- 禁止运行任何测试/构建/安装命令（如 pnpm test、pnpm typecheck、npm install、pnpm build）。",
        "- 禁止自行用 Bash/Read 大规模探索——扫描必须交给 Task 子代理。",
        "- 探索阶段合计最多 5 次工具调用；拿到子代理结论后立即进入草稿与 Write，不要重复验证。",
      ].join("\n"),
      "/init",
    );
  }

  resolvePermission(
    callId: string,
    answer: boolean | ApprovalAnswer,
  ): boolean {
    return this.#approvalWaiter.resolve(callId, answer);
  }

  answerQuestion(questionId: string, answer: string): boolean {
    const trimmed = answer.trim();
    const pending = this.pendingQuestion();
    if (
      this.#state.status !== "waiting_user" ||
      !trimmed ||
      pending?.questionId !== questionId
    ) {
      return false;
    }
    if (this.#clarificationWaiter.resolve(questionId, trimmed)) return true;

    // 进程重启后没有内存 waiter：先把回答写回原会话，再恢复同一任务或普通对话。
    const modelText = `用户对问题「${pending.question}」的回答：${trimmed}`;
    if (this.#interruptedTask) {
      this.#model.addUserMessage(modelText);
      this.#bus.emit({
        type: "user",
        text: trimmed,
        modelText,
        answerTo: questionId,
      });
      this.#state.setStatus("running");
      void this.resumeTask().catch((error) => {
        this.#bus.emit({
          type: "error",
          message: error instanceof Error ? error.message : "恢复任务失败",
        });
      });
      return true;
    }
    void this.sendInput(modelText, trimmed, { answerTo: questionId }).catch(
      (error) => {
        this.#bus.emit({
          type: "error",
          message: error instanceof Error ? error.message : "继续会话失败",
        });
      },
    );
    return true;
  }

  interrupt(): boolean {
    if (!this.#activeLoop) return false;
    this.#activeLoop.interrupt();
    this.#clarificationWaiter.cancelAll();
    this.#state.setStatus("interrupted");
    return true;
  }

  async flush(): Promise<void> {
    await Promise.all([
      this.#store.flush(),
      this.#traceStore.flush(),
      this.#branchOps.flush(),
    ]);
  }

  async compact(): Promise<boolean> {
    if (this.#processing) {
      throw new Error("会话运行中，请在当前轮结束后压缩");
    }
    const controller = new AbortController();
    const compacted = await this.#model.compact(
      controller.signal,
      true,
    );
    await this.flush();
    return compacted;
  }

  #record(event: AgentEvent): void {
    const record: AgentSessionEvent = {
      seq: ++this.#eventSeq,
      ts: new Date().toISOString(),
      // branch_switch 事件属于新分支（此时 currentBranchId 尚未切换）
      branchId:
        event.type === "branch_switch"
          ? event.branchId
          : this.#branchOps.currentBranchId(),
      event,
    };
    this.#events.push(record);
    this.#updatedAt = record.ts;
    if (event.type === "ledger_update") {
      // 账本投影：恢复重放 + 运行期记账共用同一入口（事件流是唯一事实源）
      this.#applyLedgerEvent(event);
    }
    if (event.type === "todo_update" && this.#activeLedgerTaskId) {
      const ledger = this.#ledgerByTask.get(this.#activeLedgerTaskId);
      if (ledger) {
        for (const todo of event.todos) {
          const unit = ledger.applyTodoStatus(todo.id, todo.status);
          // #record is itself a bus subscriber; defer the derived event so the
          // outer todo_update record is delivered to session subscribers first.
          if (unit) {
            queueMicrotask(() =>
              this.#bus.emit({
                type: "ledger_update",
                taskId: ledger.taskId,
                unit,
              }),
            );
          }
        }
      }
    }
    this.#state.apply(event, this.#stateDeps);
  }

  #applyLedgerEvent(event: Extract<AgentEvent, { type: "ledger_update" }>): void {
    const ledger = this.#ledgerByTask.get(event.taskId);
    if (ledger) {
      ledger.applyUpdate(event.unit);
    } else {
      this.#ledgerByTask.set(
        event.taskId,
        new TaskLedger(event.taskId, [event.unit]),
      );
    }
  }

  async #checkTaskBox(): Promise<{
    stop?: boolean;
    finalOnly?: boolean;
  }> {
    const taskBox = this.#taskBox;
    if (!taskBox) return {};
    const decision = taskBox.check(Date.now(), this.#state.costCny());
    if (decision.instruction) {
      this.#model.addUserMessage(
        `[任务盒控制指令]\n${decision.instruction}`,
      );
    }
    if (
      decision.level &&
      decision.reason &&
      decision.instruction
    ) {
      this.#bus.emit({
        type: "wrapup_warning",
        taskId: taskBox.id,
        level: decision.level,
        reason: decision.reason,
        message: decision.instruction,
      });
    }
    if (decision.stop && decision.reason) {
      this.#taskStopReason = decision.reason;
      this.#taskHardStopped = true;
    } else if (decision.finalOnly && decision.reason) {
      this.#taskStopReason = decision.reason;
    }
    return {
      ...(decision.stop ? { stop: true } : {}),
      ...(decision.finalOnly ? { finalOnly: true } : {}),
    };
  }
}
