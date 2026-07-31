import { randomUUID } from "node:crypto";
import { ConversationAgentModel } from "../model/agent-model.js";
import type { ModelClient } from "../model/types.js";
import {
  ToolExecutor,
  type TaskArgs,
} from "../tools/executor.js";
import {
  AgentLoop,
  type AgentLoopOptions,
} from "./agent-loop.js";
import { AgentEventBus } from "./events.js";
import {
  DEFAULT_PERMISSION_RULES,
  PermissionEngine,
} from "./permissions.js";
import type {
  ApprovalAnswer,
  ApprovalHandler,
  PermissionMode,
  PermissionRule,
  ToolExecutionResult,
} from "./types.js";

export interface TaskRunnerOptions {
  cwd: string;
  bus: AgentEventBus;
  client: ModelClient;
  mode: PermissionMode | (() => PermissionMode);
  depth?: number;
  maxDepth?: number;
  approve?: ApprovalHandler;
  reportUsage?: (usage: {
    input: number;
    output: number;
    cached: number;
    costCny?: number;
  }) => void;
  recordTrace?: AgentLoopOptions["recordTrace"];
}

export class TaskRunner {
  readonly #cwd: string;
  readonly #bus: AgentEventBus;
  readonly #client: ModelClient;
  readonly #mode: PermissionMode | (() => PermissionMode);
  readonly #depth: number;
  readonly #maxDepth: number;
  readonly #reportUsage:
    | TaskRunnerOptions["reportUsage"]
    | undefined;
  readonly #recordTrace: AgentLoopOptions["recordTrace"];
  readonly #approve: ApprovalHandler | undefined;

  constructor(options: TaskRunnerOptions) {
    this.#cwd = options.cwd;
    this.#bus = options.bus;
    this.#client = options.client;
    this.#mode = options.mode;
    this.#depth = options.depth ?? 1;
    this.#maxDepth = options.maxDepth ?? 2;
    this.#approve = options.approve;
    this.#reportUsage = options.reportUsage;
    this.#recordTrace = options.recordTrace;
  }

  async run(
    args: TaskArgs,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (this.#depth > this.#maxDepth) {
      return {
        summary: "子代理失败：超过最大嵌套深度",
        output: "未执行；Task 最大嵌套深度为 2。",
        isError: true,
      };
    }
    const taskId = randomUUID().slice(0, 8);
    this.#bus.emit({
      type: "task_start",
      taskId,
      description: args.description,
    });
    let toolCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    const texts: string[] = [];
    let interrupted = false;
    const childBus = new AgentEventBus();
    childBus.subscribe((event) => {
      if (event.type === "tool_call") toolCalls += 1;
      if (event.type === "text_delta") texts.push(event.text);
      if (event.type === "cost_update") {
        inputTokens += event.input;
        outputTokens += event.output;
        cachedTokens += event.cached;
        this.#reportUsage?.({
          input: event.input,
          output: event.output,
          cached: event.cached,
          ...(event.costCny === undefined
            ? {}
            : { costCny: event.costCny }),
        });
      }
      if (event.type === "interrupted") interrupted = true;
      this.#bus.emit({
        type: "task_event",
        taskId,
        eventType: event.type,
        ...("summary" in event &&
        typeof event.summary === "string"
          ? { summary: event.summary }
          : {}),
      });
    });

    const readonlyRules: PermissionRule[] = args.writable
      ? DEFAULT_PERMISSION_RULES
      : [
          { effect: "deny", pattern: "Edit(*)" },
          { effect: "deny", pattern: "MultiEdit(*)" },
          { effect: "deny", pattern: "Write(*)" },
          ...DEFAULT_PERMISSION_RULES,
        ];
    const permissions = new PermissionEngine(
      typeof this.#mode === "function"
        ? this.#mode()
        : this.#mode,
      readonlyRules,
    );
    const nestedRunner =
      this.#depth < this.#maxDepth
        ? new TaskRunner({
            cwd: this.#cwd,
            bus: this.#bus,
            client: this.#client,
            mode: this.#mode,
            depth: this.#depth + 1,
            maxDepth: this.#maxDepth,
            ...(this.#approve
              ? { approve: this.#approve }
              : {}),
            ...(this.#reportUsage
              ? { reportUsage: this.#reportUsage }
              : {}),
            ...(this.#recordTrace
              ? { recordTrace: this.#recordTrace }
              : {}),
          })
        : undefined;
    const tools = new ToolExecutor(
      this.#cwd,
      undefined,
      undefined,
      nestedRunner
        ? async (taskArgs, childSignal) =>
            await nestedRunner.run(taskArgs, childSignal)
        : undefined,
    );
    const model = new ConversationAgentModel(
      this.#client,
      [],
    );
    model.addUserMessage(
      `${args.prompt}\n\nReturn exactly three sections: Conclusion; Key evidence (file:line); Unconfirmed.`,
    );
    const loop = new AgentLoop({
      bus: childBus,
      model,
      permissions,
      tools,
      approve: this.#approve
        ? async (call, childSignal) => {
            // 冒泡审批到父会话：通过父总线发出 ask_permission 事件
            this.#bus.emit({
              type: "ask_permission",
              call,
              risk: "子代理审批请求",
            });
            return await this.#approve!(call, childSignal);
          }
        : async () => ({ granted: false }),
      modelRole: "explore",
      ...(this.#recordTrace
        ? { recordTrace: this.#recordTrace }
        : {}),
    });

    const onAbort = () => loop.interrupt();
    try {
      signal.addEventListener("abort", onAbort, { once: true });
      await loop.run();
      const summary =
        texts.at(-1)?.trim() ||
        "子代理未返回文本结论。";
      const status = interrupted
        ? "interrupted"
        : "completed";
      this.#bus.emit({
        type: "task_end",
        taskId,
        status,
        toolCalls,
        inputTokens,
        outputTokens,
        cachedTokens,
        summary,
      });
      return {
        summary: `子代理“${args.description}”${status === "completed" ? "完成" : "已中止"}`,
        output: summary,
        aborted: interrupted,
        isError: interrupted,
      };
    } catch (error) {
      const summary =
        `部分结论：${texts.at(-1)?.trim() || "无"}\n` +
        `失败说明：${error instanceof Error ? error.message : "未知错误"}`;
      this.#bus.emit({
        type: "task_end",
        taskId,
        status: "failed",
        toolCalls,
        inputTokens,
        outputTokens,
        cachedTokens,
        summary,
      });
      return {
        summary: `子代理“${args.description}”失败，已返回部分结论`,
        output: summary,
        isError: true,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
