import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { MyAgentConfig } from "../config/schema.js";
import type { ConversationAgentModel } from "../model/agent-model.js";
import { ModelRetriesExhaustedError } from "../model/resilient-client.js";
import type { ModelClient } from "../model/types.js";
import { ToolExecutor } from "../tools/executor.js";
import { AgentLoop } from "./agent-loop.js";
import {
  AgentEventBus,
  SessionStore,
  TraceStore,
} from "./events.js";
import {
  DEFAULT_PERMISSION_RULES,
  PermissionEngine,
  callSignature,
} from "./permissions.js";
import {
  TaskBox,
  type RunTaskOptions,
} from "./run-task.js";
import { TaskRunner } from "./task-runner.js";
import type {
  AgentEvent,
  ApprovalAnswer,
  ModelPricing,
  PermissionMode,
  PermissionRule,
  RecordedEvent,
  TodoItem,
  ToolCall,
} from "./types.js";

export type AgentSessionStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "done"
  | "error"
  | "interrupted";

export interface AgentSessionEvent {
  seq: number;
  ts: string;
  event: AgentEvent;
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  status: AgentSessionStatus;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostCny: number;
  todos: TodoItem[];
  toolCallCount: number;
  kind: "interactive" | "run";
}

interface PendingPermission {
  resolve: (answer: ApprovalAnswer) => void;
}

interface QueuedInput {
  id: string;
  text: string;
  displayText?: string;
}

export class AgentSession {
  readonly id: string;
  title: string;
  readonly createdAt: string;
  readonly #bus = new AgentEventBus();
  readonly #model: ConversationAgentModel;
  readonly #permissions: PermissionEngine;
  readonly #tools: ToolExecutor;
  readonly #store: SessionStore;
  readonly #traceStore: TraceStore;
  readonly #events: AgentSessionEvent[] = [];
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #queuedInputs: QueuedInput[] = [];
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
  #status: AgentSessionStatus = "idle";
  #updatedAt: string;
  #activeLoop: AgentLoop | undefined;
  #processing = false;
  #totalInputTokens = 0;
  #totalOutputTokens = 0;
  #totalCachedTokens = 0;
  #totalCostCny = 0;
  #todos: TodoItem[] = [];
  #taskBox: TaskBox | undefined;
  #taskStopReason: "deadline" | "budget" | undefined;
  #taskHardStopped = false;

  constructor(options: {
    id: string;
    title: string;
    cwd: string;
    mode: PermissionMode;
    model: ConversationAgentModel;
    stateDir?: string;
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
    keepRecentTurns?: number;
    pricing?: Partial<
      Record<"main" | "cheap" | "explore", ModelPricing>
    >;
  }) {
    this.id = options.id;
    this.title = options.title;
    this.createdAt =
      options.restoredEvents?.[0]?.ts ?? new Date().toISOString();
    this.#updatedAt =
      options.restoredEvents?.at(-1)?.ts ?? this.createdAt;
    this.#model = options.model;
    this.#pricing = options.pricing;
    this.#permissions = new PermissionEngine(
      options.mode,
      options.permissionRules ?? DEFAULT_PERMISSION_RULES,
    );
    const projectKey = Buffer.from(options.cwd).toString("base64url");
    const stateRoot =
      options.stateDir ?? path.join(os.homedir(), ".myagent");
    const sessionsRoot = path.join(
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
    );
    const taskRunner = options.exploreModelClient
      ? new TaskRunner({
          cwd: options.cwd,
          bus: this.#bus,
          client: options.exploreModelClient,
          mode: () => this.#permissions.mode,
          approve: async (call, signal) =>
            await this.#waitForPermission(call, signal),
          reportUsage: (usage) => {
            const costCny = calculateUsageCost(
              usage,
              this.#pricing?.explore,
            );
            const actualCostCny = usage.costCny ?? costCny;
            this.#bus.emit({
              type: "cost_update",
              ...usage,
              totalTokens:
                this.#totalInputTokens +
                this.#totalOutputTokens +
                usage.input +
                usage.output,
              ...(actualCostCny === undefined
                ? {}
                : {
                    costCny: actualCostCny,
                    totalCostCny:
                      this.#totalCostCny + actualCostCny,
                  }),
            });
          },
          recordTrace: (trace) => this.#traceStore.record(trace),
        })
      : undefined;
    this.#tools = new ToolExecutor(
      options.cwd,
      undefined,
      undefined,
      taskRunner
        ? async (args, signal) =>
            await taskRunner.run(args, signal)
        : undefined,
    );
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 300_000;
    this.#rememberPermission = options.rememberPermission;
    this.#store.attach(this.#bus);
    this.#bus.subscribe((event) => this.#record(event));
    if (options.compactModelClient) {
      this.#model.configureCompaction({
        client: options.compactModelClient,
        thresholdTokens:
          options.compactAtEstimatedTokens ?? 90_000,
        keepRecentTurns: options.keepRecentTurns ?? 4,
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
          const costCny = calculateUsageCost(
            result.usage,
            result.pricing ?? this.#pricing?.cheap,
          );
          const totalTokens =
            this.#totalInputTokens +
            this.#totalOutputTokens +
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
                  totalCostCny: this.#totalCostCny + costCny,
                }),
          });
          const userEvents = this.#events.filter(
            (record) => record.event.type === "user",
          );
          const keepFromSeq =
            userEvents.at(-result.keepRecentTurns)?.seq ?? 1;
          this.#bus.emit({
            type: "context_compacted",
            summary: result.summary,
            ratio: result.ratio,
            keepFromSeq,
          });
        },
      });
    }

    if (options.restoredEvents?.length) {
      for (const record of options.restoredEvents) {
        this.#events.push({
          seq: record.seq,
          ts: record.ts,
          event: record.event,
        });
        this.#applyEventState(record.event);
      }
      if (
        this.#status === "idle" ||
        this.#status === "running" ||
        this.#status === "waiting_permission"
      ) {
        this.#status = "interrupted";
      }
    }
  }

  summary(): AgentSessionSummary {
    return {
      id: this.id,
      title: this.title,
      status: this.#status,
      permissionMode: this.#permissions.mode,
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
      totalInputTokens: this.#totalInputTokens,
      totalOutputTokens: this.#totalOutputTokens,
      totalCachedTokens: this.#totalCachedTokens,
      totalCostCny: this.#totalCostCny,
      todos: structuredClone(this.#todos),
      toolCallCount: this.#events.filter(
        (record) => record.event.type === "tool_call",
      ).length,
      kind: this.#events.some(
        (record) => record.event.type === "run_started",
      )
        ? "run"
        : "interactive",
    };
  }

  events(after = 0): AgentSessionEvent[] {
    return this.#events.filter((event) => event.seq > after);
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  isProcessing(): boolean {
    return this.#processing;
  }

  applyConfigChange(config: MyAgentConfig): void {
    this.#permissions.setMode(config.permissions.mode);
    this.#permissions.setRules([
      ...DEFAULT_PERMISSION_RULES,
      ...config.permissions.rules,
    ]);
    this.#approvalTimeoutMs = config.permissions.approvalTimeoutMs;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.#permissions.setMode(mode);
    this.#bus.emit({ type: "permission_mode_changed", mode });
  }

  async sendInput(
    message: string,
    displayText?: string,
  ): Promise<void> {
    const text = message.trim();
    if (!text) throw new Error("消息不能为空");
    if (this.#processing) {
      const queued = { id: randomUUID(), text };
      this.#queuedInputs.push(queued);
      this.#bus.emit({
        type: "user_queued",
        text: queued.text,
        queueId: queued.id,
      });
      return;
    }

    this.#processing = true;
    let current: QueuedInput | undefined = {
      id: "",
      text,
      ...(displayText ? { displayText } : {}),
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
        });
        this.#status = "running";
        this.#updatedAt = new Date().toISOString();

        const loop = new AgentLoop({
          bus: this.#bus,
          model: this.#model,
          permissions: this.#permissions,
          tools: this.#tools,
          approve: async (call, signal) =>
            await this.#waitForPermission(call, signal),
          initialTotalTokens:
            this.#totalInputTokens + this.#totalOutputTokens,
          getTotalTokens: () =>
            this.#totalInputTokens + this.#totalOutputTokens,
          ...(this.#pricing?.main
            ? { pricing: this.#pricing.main }
            : {}),
          getTotalCostCny: () => this.#totalCostCny,
          beforeTurn: async () => this.#checkTaskBox(),
          modelRole: "main",
          recordTrace: (trace) => this.#traceStore.record(trace),
        });
        this.#activeLoop = loop;
        try {
          await loop.run();
        } catch (error) {
          if (error instanceof ModelRetriesExhaustedError) {
            this.#bus.emit({
              type: "need_user",
              question:
                `${error.message}。请检查网络、额度或切换模型后输入“继续”。`,
            });
          } else {
            this.#status = "error";
            this.#bus.emit({
              type: "error",
              message:
                error instanceof Error ? error.message : "模型运行失败",
            });
          }
        } finally {
          this.#activeLoop = undefined;
          await this.flush();
        }

        current = this.#queuedInputs.shift();
      }
    } finally {
      this.#processing = false;
    }
  }

  async runTask(options: RunTaskOptions): Promise<void> {
    if (this.#processing || this.#taskBox) {
      throw new Error("当前会话已有任务在运行");
    }
    if (options.budgetCny !== undefined && !this.#pricing?.main) {
      throw new Error(
        "--budget 需要模型单价：请在 Web 设置页的“角色模型 → 费用与 fallback”中为 main 模型填写单价；或去掉 --budget，仅用 --until 控制时长",
      );
    }
    const previousMode = this.#permissions.mode;
    const previousRules = this.#permissions.rules();
    const taskBox = new TaskBox(options, this.#totalCostCny);
    this.#taskBox = taskBox;
    this.#taskStopReason = undefined;
    this.#taskHardStopped = false;
    this.#permissions.setMode(options.permission ?? previousMode);
    this.#permissions.setRules([
      ...previousRules,
      ...options.hardRules,
    ]);
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
    });
    let status: "completed" | "interrupted" | "failed" = "completed";
    let reason:
      | "done"
      | "deadline"
      | "budget"
      | "error"
      | "interrupted" = "done";
    try {
      await this.sendInput(
        taskBox.prompt(),
        `/run ${options.description}`,
      );
      if (this.#taskStopReason) {
        status = this.#taskHardStopped
          ? "interrupted"
          : "completed";
        reason = this.#taskStopReason;
      } else if (this.#status === "error") {
        status = "failed";
        reason = "error";
      } else if (this.#status === "interrupted") {
        status = "interrupted";
        reason = "interrupted";
      }
    } catch (error) {
      status = "failed";
      reason = "error";
      throw error;
    } finally {
      // 优雅终止：硬停止时自动回滚 Agent 自己的编辑
      if (this.#taskHardStopped) {
        const journal = this.#tools.files.journal;
        let rolledBack = 0;
        while (journal.entries().length > 0) {
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
          ),
      );
      this.#permissions.setRules([
        ...previousRules,
        ...rememberedDuringTask,
      ]);
      this.#permissions.setMode(previousMode);
      this.#taskBox = undefined;
      this.#bus.emit({
        type: "run_finished",
        taskId: taskBox.id,
        status,
        reason,
      });
      await this.flush();
    }
  }

  startRunTask(options: RunTaskOptions): void {
    void this.runTask(options).catch((error) => {
      this.#bus.emit({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "无人值守任务启动失败",
      });
    });
  }

  async initializeProject(): Promise<void> {
    if (this.#processing || this.#taskBox) {
      throw new Error("当前会话已有任务在运行");
    }
    await this.sendInput(
      [
        "[项目初始化]",
        "先调用一个只读 Task 子代理扫描目录结构、README、依赖清单、构建/测试/lint 配置与入口文件。",
        "只把子代理的结论带回主上下文。随后生成一份简洁 AGENTS.md 草稿，包含：技术栈、安装/构建/测试/lint 命令、目录导览、已验证约定。",
        "若 AGENTS.md 已存在，必须先 Read 并展示精确 diff。最后使用 Write 写入草稿，让权限引擎在落盘前向用户展示并审批；未经批准不要写入。",
        "不要运行安装命令，不要修改 AGENTS.md 之外的项目文件。",
      ].join("\n"),
      "/init",
    );
  }

  resolvePermission(
    callId: string,
    answer: boolean | ApprovalAnswer,
  ): boolean {
    const pending = this.#pendingPermissions.get(callId);
    if (!pending) return false;
    const normalized: ApprovalAnswer =
      typeof answer === "boolean"
        ? { granted: answer, scope: "once" }
        : answer;
    this.#status = "running";
    pending.resolve(normalized);
    return true;
  }

  interrupt(): boolean {
    if (!this.#activeLoop) return false;
    this.#activeLoop.interrupt();
    this.#status = "interrupted";
    return true;
  }

  async flush(): Promise<void> {
    await Promise.all([
      this.#store.flush(),
      this.#traceStore.flush(),
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

  async #waitForPermission(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ApprovalAnswer> {
    this.#status = "waiting_permission";
    return await new Promise<ApprovalAnswer>((resolve) => {
      const timeout = setTimeout(
        () => finish({ granted: false }),
        this.#approvalTimeoutMs,
      );
      timeout.unref();
      const onAbort = () => finish({ granted: false });
      signal.addEventListener("abort", onAbort, { once: true });

      const finish = (answer: ApprovalAnswer) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        this.#pendingPermissions.delete(call.id);
        if (
          answer.granted &&
          answer.scope &&
          answer.scope !== "once"
        ) {
          this.#permissions.remember(call);
          if (
            (answer.scope === "project" ||
              answer.scope === "global") &&
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
      this.#pendingPermissions.set(call.id, {
        resolve: finish,
      });
    });
  }

  #record(event: AgentEvent): void {
    const record: AgentSessionEvent = {
      seq: this.#events.length + 1,
      ts: new Date().toISOString(),
      event,
    };
    this.#events.push(record);
    this.#updatedAt = record.ts;
    this.#applyEventState(event);
    for (const listener of this.#listeners) listener(record);
  }

  #applyEventState(event: AgentEvent): void {
    if (event.type === "user") this.#status = "running";
    if (event.type === "permission_mode_changed") {
      this.#permissions.setMode(event.mode);
    }
    if (event.type === "ask_permission") this.#status = "waiting_permission";
    if (event.type === "todo_update") {
      this.#todos = structuredClone(event.todos);
      this.#model.setTodos(this.#todos);
    }
    if (event.type === "cost_update") {
      this.#totalInputTokens += event.input;
      this.#totalOutputTokens += event.output;
      this.#totalCachedTokens += event.cached ?? 0;
      this.#totalCostCny += event.costCny ?? 0;
    }
    if (event.type === "done") this.#status = "done";
    if (event.type === "need_user") this.#status = "done";
    if (event.type === "error") this.#status = "error";
    if (event.type === "interrupted") this.#status = "interrupted";
  }

  async #checkTaskBox(): Promise<{
    stop?: boolean;
    finalOnly?: boolean;
  }> {
    const taskBox = this.#taskBox;
    if (!taskBox) return {};
    const decision = taskBox.check(Date.now(), this.#totalCostCny);
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

function calculateUsageCost(
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
