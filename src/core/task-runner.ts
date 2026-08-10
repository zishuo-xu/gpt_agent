import { randomUUID } from "node:crypto";
import { ConversationAgentModel } from "./agent-model.js";
import type { ModelClient } from "../model/types.js";
import { EXPLORE_TOOL_NAMES } from "../tools/tool-definitions.js";
import {
  ToolExecutor,
  type TaskArgs,
} from "../tools/executor.js";
import type { AtomicFileTools } from "../tools/atomic-file.js";
import {
  AgentLoop,
  type AgentLoopOptions,
} from "./agent-loop.js";
import { AgentEventBus } from "./events.js";
import {
  DEFAULT_PERMISSION_RULES,
  PermissionEngine,
  READONLY_DENY_RULES,
} from "./permissions.js";
import type {
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
  /** 活跃子代理循环注册表（跨嵌套层级共享，steer 时逐个软打断） */
  steerLoops?: Set<AgentLoop>;
  /** 单次运行超时（ms）；超时软打断子代理并返回已收集结果。缺省 15 分钟 */
  timeoutMs?: number;
  /** 文件工具实现（可注入记忆留档钩子等）；缺省新建 */
  files?: AtomicFileTools;
}

/** 子代理默认超时：15 分钟（无界探索会拖住主任务，参照生产测试 P5 观察） */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 15 * 60_000;

/** 同时运行的子代理数量上限（设计约定：并发 ≤ 4） */
const MAX_CONCURRENT_RUNNERS = 4;

let activeRunners = 0;

export class TaskRunner {
  readonly #cwd: string;
  readonly #bus: AgentEventBus;
  #client: ModelClient;
  readonly #mode: PermissionMode | (() => PermissionMode);
  readonly #depth: number;
  readonly #maxDepth: number;
  readonly #reportUsage:
    | TaskRunnerOptions["reportUsage"]
    | undefined;
  readonly #recordTrace: AgentLoopOptions["recordTrace"];
  readonly #approve: ApprovalHandler | undefined;
  readonly #steerLoops: Set<AgentLoop>;
  readonly #timeoutMs: number;
  readonly #files: AtomicFileTools | undefined;

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
    this.#steerLoops = options.steerLoops ?? new Set();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
    this.#files = options.files;
  }

  /** 配置变更后替换子代理模型客户端 */
  setClient(client: ModelClient): void {
    this.#client = client;
  }

  /** Steer 软打断：传播到所有活跃的子代理循环（含嵌套层级） */
  steer(): void {
    for (const loop of this.#steerLoops) loop.steer();
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
    if (activeRunners >= MAX_CONCURRENT_RUNNERS) {
      return {
        summary: "子代理失败：并发任务数已达上限",
        output: `未执行；同时运行的子代理最多 ${MAX_CONCURRENT_RUNNERS} 个，请稍后再试。`,
        isError: true,
      };
    }
    activeRunners += 1;
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
          ...READONLY_DENY_RULES,
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
            steerLoops: this.#steerLoops,
            timeoutMs: this.#timeoutMs,
          })
        : undefined;
    const tools = new ToolExecutor(
      this.#cwd,
      this.#files,
      undefined,
      nestedRunner
        ? async (taskArgs, childSignal) =>
            await nestedRunner.run(taskArgs, childSignal)
        : undefined,
    );
    const model = new ConversationAgentModel(
      this.#client,
      [],
      undefined,
      // 只读子代理仅注入探索工具（writable 时回退全量工具集）
      { toolNames: args.writable ? undefined : EXPLORE_TOOL_NAMES },
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
      // 子代理成本兜底：最多 40 轮，防止过度探索耗尽预算
      maxTurns: 40,
      ...(this.#recordTrace
        ? { recordTrace: this.#recordTrace }
        : {}),
    });

    const onAbort = () => loop.interrupt();
    // 子代理超时：无界探索拖住主任务时强制软打断（保留已收集结果）
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      loop.interrupt();
    }, this.#timeoutMs);
    this.#steerLoops.add(loop);
    try {
      signal.addEventListener("abort", onAbort, { once: true });
      await loop.run();
      const summary = formatSubagentConclusion(
        texts.at(-1)?.trim() || "",
      ) || "子代理未返回文本结论。";
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
        ...(timedOut ? { reason: "timeout" as const } : {}),
      });
      return {
        summary: `子代理“${args.description}”${status === "completed" ? "完成" : timedOut ? "已超时" : "已中止"}`,
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
      clearTimeout(timeoutTimer);
      activeRunners -= 1;
      this.#steerLoops.delete(loop);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

const THREE_SECTION_HEADERS = [
  "Conclusion",
  "Key evidence",
  "Unconfirmed",
] as const;

/**
 * 宽容解析子代理三段式结论（Conclusion / Key evidence / Unconfirmed），
 * 缺失的段标注"（未提供）"；无法识别结构时原样返回。
 */
export function formatSubagentConclusion(raw: string): string {
  const extracted = extractSections(raw);
  if (!extracted) return raw;
  return [
    `结论：${extracted.conclusion || "（未提供）"}`,
    `关键证据：${extracted.evidence || "（未提供）"}`,
    `未能确认：${extracted.unconfirmed || "（未提供）"}`,
  ].join("\n");
}

function extractSections(
  text: string,
): { conclusion: string; evidence: string; unconfirmed: string } | undefined {
  const lines = text.split(/\r?\n/);
  const markers: Array<{ header: string; index: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const cleanedHeader = lines[index]!
      .trim()
      .replace(/^#{1,6}\s*/, "");
    const header = THREE_SECTION_HEADERS.find(
      (candidate) =>
        cleanedHeader === candidate ||
        cleanedHeader.startsWith(`${candidate}:`) ||
        cleanedHeader.startsWith(`${candidate}：`),
    );
    if (header) markers.push({ header, index });
  }
  if (markers.length < 2) return undefined;
  const section = (header: string): string => {
    const start = markers.find((marker) => marker.header === header);
    if (!start) return "";
    const end = markers.find((marker) => marker.index > start.index);
    const firstLine = lines[start.index]!
      .replace(/^#{1,6}\s*/, "")
      .replace(header, "")
      .replace(/^[：:]\s*/, "")
      .trim();
    const rest = lines
      .slice(start.index + 1, end?.index)
      .join("\n")
      .trim();
    return [firstLine, rest].filter(Boolean).join("\n");
  };
  return {
    conclusion: section("Conclusion"),
    evidence: section("Key evidence"),
    unconfirmed: section("Unconfirmed"),
  };
}
