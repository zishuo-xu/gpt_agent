import type { AgentModel, ModelTurn } from "../core/agent-loop.js";
import { ContextManager } from "../core/context.js";
import type {
  ModelPricing,
  TodoItem,
  ToolCall,
  ToolExecutionResult,
} from "../core/types.js";
import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
} from "./types.js";
import type { ConversationMessage } from "./types.js";
import type { ModelUsage } from "./types.js";
import {
  toolDefinitionsFor,
} from "./tool-definitions.js";
import type { ToolName } from "../core/types.js";

const PROMPT_HEADER = `You are MyAgent, a local coding agent operating in the user's current project.

Work autonomously toward the user's request. Inspect before editing. Use Read before Edit, MultiEdit, or overwriting an existing file. Prefer focused changes and run relevant tests after edits. Never claim success without evidence.`;

const PROMPT_NAVIGATION = `Use Grep and Glob to locate relevant code before broad reading. For tasks with roughly three or more steps, call TodoWrite first and keep exactly one item in_progress until the work is complete.`;

const PROMPT_NAVIGATION_READ_ONLY = `Use Grep and Glob to locate relevant code before broad reading.`;

const PROMPT_TODO_ONLY = `For tasks with roughly three or more steps, call TodoWrite first and keep exactly one item in_progress until the work is complete.`;

const PROMPT_TASK = `Use Task for broad repository exploration that would otherwise flood the main context. For comprehensive searches (multiple keywords, multiple directories, or many files), delegate to a sub-agent FIRST instead of running a long chain of Grep/Read in the main context. Give the sub-agent a self-contained prompt and require conclusions, file:line evidence, and unconfirmed points.`;

const PROMPT_MEMORY = `When you learn a stable, verified project fact that will matter in future sessions, persist one concise dated entry under .myagent/memory/: conventions.md for commands/conventions, pitfalls.md for verified traps, or decisions.md for architectural decisions. Mark one-off observations as unconfirmed instead of presenting them as facts. Memory writes are visible in the event stream and should not contain secrets.`;

const PROMPT_RESPECT = `Respect tool errors and permission denials. If a tool is denied, choose a safer alternative or explain the blocker. Keep the final response concise and include changed files and verification results.`;

const PROMPT_BASH = `The Bash tool runs in the project root. Avoid destructive commands, network writes, force pushes, and broad cleanup. Never use git reset, git clean, or git checkout -- to restore the workspace; if rollback is necessary, revert only your own still-current atomic edits and otherwise preserve the scene and report it.`;

/** 按实际注入的工具集动态生成 system prompt（参照 Pi 的动态 guidelines）：
    只写当前可用工具的指南，工具指南不再背负不存在的工具。
    未指定（全量）时输出与历史版本逐字一致，保持缓存前缀兼容。 */
export function buildSystemPrompt(
  toolNames: readonly ToolName[] | undefined,
): string {
  const tools = toolNames;
  const hasGrepGlob =
    tools === undefined || tools.includes("Grep") || tools.includes("Glob");
  const hasTodo = tools === undefined || tools.includes("TodoWrite");
  const paragraphs = [PROMPT_HEADER];
  if (hasGrepGlob && hasTodo) {
    paragraphs.push(PROMPT_NAVIGATION);
  } else if (hasGrepGlob) {
    paragraphs.push(PROMPT_NAVIGATION_READ_ONLY);
  } else if (hasTodo) {
    paragraphs.push(PROMPT_TODO_ONLY);
  }
  if (tools === undefined || tools.includes("Task")) {
    paragraphs.push(PROMPT_TASK);
  }
  paragraphs.push(PROMPT_MEMORY, PROMPT_RESPECT);
  if (tools === undefined || tools.includes("Bash")) {
    paragraphs.push(PROMPT_BASH);
  }
  return paragraphs.join("\n\n");
}

export class ConversationAgentModel implements AgentModel {
  #client: ModelClient;
  #messages: ConversationMessage[];
  readonly #context: ContextManager;
  onTextDelta: ((text: string) => void) | undefined;
  #compactionCount = 0;
  #compaction:
    | {
        client: ModelClient;
        thresholdTokens: number;
        keepRecentTurns: number;
        onCompacted: (result: CompactionResult) => void;
      }
    | undefined;

  /** 会话内压缩发生次数：缓存浪费度量据此区分“合法失效（压缩）” */
  get compactionCount(): number {
    return this.#compactionCount;
  }

  constructor(
    client: ModelClient,
    initialConversation: string | ConversationMessage[],
    context = new ContextManager(),
    options: { toolNames?: readonly ToolName[] | undefined } = {},
  ) {
    this.#client = client;
    this.#messages =
      typeof initialConversation === "string"
        ? [{ role: "user", content: initialConversation }]
        : structuredClone(initialConversation);
    this.#context = context;
    this.#toolNames = options.toolNames;
  }

  readonly #toolNames: readonly ToolName[] | undefined;

  addUserMessage(content: string): void {
    this.#messages.push({ role: "user", content });
  }

  /** 会话分支（fork）时重建模型消息历史为分支链视角 */
  resetConversation(messages: ConversationMessage[]): void {
    this.#messages = structuredClone(messages);
  }

  /** 配置变更后替换主模型客户端（会话历史保持不变） */
  setClient(client: ModelClient): void {
    this.#client = client;
  }

  /** 配置变更后替换压缩模型客户端 */
  setCompactionClient(client: ModelClient): void {
    if (this.#compaction) {
      this.#compaction = { ...this.#compaction, client };
    }
  }

  setTodos(todos: TodoItem[]): void {
    this.#context.setTodos(todos);
  }

  configureCompaction(options: {
    client: ModelClient;
    thresholdTokens: number;
    keepRecentTurns: number;
    onCompacted: (result: CompactionResult) => void;
  }): void {
    this.#compaction = options;
  }

  estimatedTokens(): number {
    return Math.ceil(JSON.stringify(this.#messages).length / 4);
  }

  async compact(signal: AbortSignal, force = false): Promise<boolean> {
    const options = this.#compaction;
    if (!options) return false;
    const beforeTokens = this.estimatedTokens();
    if (!force && beforeTokens < options.thresholdTokens) return false;
    const userIndexes = this.#messages
      .map((message, index) => (message.role === "user" ? index : -1))
      .filter((index) => index >= 0);
    if (userIndexes.length <= options.keepRecentTurns) return false;
    const keepFromIndex =
      userIndexes.at(-options.keepRecentTurns) ?? 0;
    const older = this.#messages.slice(0, keepFromIndex);
    const recent = this.#messages.slice(keepFromIndex);
    const request: CompletionRequest = {
      system: COMPACTION_PROMPT,
      messages: [
        {
          role: "user",
          content: serializeConversation(older),
        },
      ],
      // 压缩不需要工具调用，不携带工具 schema（省 token）
      tools: [],
      signal,
    };
    let response: ModelResponse;
    try {
      response = await options.client.complete(request);
    } catch (error) {
      attachModelTrace(error, request);
      throw error;
    }
    const summary = response.text.trim();
    if (!summary) throw new Error("压缩模型未返回摘要");
    this.#compactionCount += 1;
    this.#messages.splice(
      0,
      this.#messages.length,
      {
        role: "user",
        content: `[会话压缩摘要]\n${summary}`,
      },
      ...recent,
    );
    const afterTokens = this.estimatedTokens();
    options.onCompacted({
      summary,
      ratio:
        beforeTokens === 0
          ? 1
          : Number((afterTokens / beforeTokens).toFixed(3)),
      usage: response.usage,
      keepRecentTurns: options.keepRecentTurns,
      ...(response.pricing
        ? { pricing: response.pricing }
        : {}),
      ...(response.fallbacks
        ? { fallbacks: response.fallbacks }
        : {}),
      trace: {
        request: {
          system: request.system,
          messages: request.messages,
        },
        response: {
          text: response.text,
          usage: response.usage,
          ...(response.model ? { model: response.model } : {}),
          ...(response.fallbacks
            ? { fallbacks: response.fallbacks }
            : {}),
          ...(response.traceRaw === undefined
            ? {}
            : { raw: response.traceRaw }),
        },
      },
    });
    return true;
  }

  async next(signal: AbortSignal): Promise<ModelTurn> {
    await this.compact(signal);
    const prepared = await this.#context.prepare(
      buildSystemPrompt(this.#toolNames),
      this.#messages,
    );
    const request: CompletionRequest = {
      system: prepared.system,
      messages: prepared.messages,
      // 动态工具集：只注入本模型角色启用的工具（main 全量 / explore 只读集）
      tools: toolDefinitionsFor(this.#toolNames),
      signal,
    };
    let response: ModelResponse;
    try {
      if (this.#client.stream && this.onTextDelta) {
        response = await this.#streamNext(request);
      } else {
        response = await this.#client.complete(request);
      }
    } catch (error) {
      attachModelTrace(error, request);
      throw error;
    }
    this.#messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
    });
    return {
      ...(response.text ? { text: response.text } : {}),
      toolCalls: response.toolCalls,
      done: response.toolCalls.length === 0,
      usage: response.usage,
      ...(response.pricing
        ? { usagePricing: response.pricing }
        : {}),
      ...(response.fallbacks
        ? { fallbacks: response.fallbacks }
        : {}),
      trace: {
        request: {
          system: request.system,
          messages: request.messages,
        },
        response: {
          text: response.text,
          toolCalls: response.toolCalls,
          usage: response.usage,
          ...(response.model ? { model: response.model } : {}),
          ...(response.providerId
            ? { providerId: response.providerId }
            : {}),
          ...(response.fallbacks
            ? { fallbacks: response.fallbacks }
            : {}),
          ...(response.traceRaw === undefined
            ? {}
            : { raw: response.traceRaw }),
        },
      },
    };
  }

  acceptToolResult(
    call: ToolCall,
    result: ToolExecutionResult,
    isError = false,
  ): void {
    const content = formatToolResult(result);
    this.#messages.push({
      role: "tool",
      toolCallId: call.id,
      toolName: call.tool,
      target: call.target,
      content,
      isError,
    });
  }

  async #streamNext(request: CompletionRequest): Promise<ModelResponse> {
    let finalResponse: ModelResponse | undefined;
    for await (const chunk of this.#client.stream!(request)) {
      if (chunk.type === "text_delta") {
        this.onTextDelta?.(chunk.text);
      } else if (chunk.type === "done") {
        finalResponse = chunk.response;
      }
    }
    if (!finalResponse) throw new Error("流式响应未正常结束");
    return finalResponse;
  }

  acceptToolDenied(call: ToolCall, reason: string): void {
    this.#messages.push({
      role: "tool",
      toolCallId: call.id,
      toolName: call.tool,
      target: call.target,
      content: `Permission denied: ${reason}`,
      isError: true,
    });
  }
}

export interface CompactionResult {
  summary: string;
  ratio: number;
  usage: ModelUsage;
  keepRecentTurns: number;
  pricing?: ModelPricing;
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

const COMPACTION_PROMPT = `Summarize this coding-agent conversation for exact continuation.

Return a concise structured summary with these headings:
- Task goal
- Completed changes
- Key files and evidence
- Current todo and blockers
- User preferences and constraints

Preserve concrete commands, file paths, decisions, failed attempts, and verification results. Do not invent facts.`;

function serializeConversation(
  messages: ConversationMessage[],
): string {
  return messages
    .map((message) => {
      if (message.role === "user") {
        return `USER:\n${message.content}`;
      }
      if (message.role === "assistant") {
        return `ASSISTANT:\n${message.content}\nTOOLS: ${message.toolCalls
          .map((call) => `${call.tool}(${call.target})`)
          .join(", ")}`;
      }
      return `TOOL ${message.toolName}(${message.target ?? ""}):\n${message.content}`;
    })
    .join("\n\n");
}

function formatToolResult(result: ToolExecutionResult): string {
  const serialized =
    result.output === undefined
      ? result.summary
      : `${result.summary}\n${stringifyOutput(result.output)}`;
  const limit = 30_000;
  if (serialized.length <= limit) return serialized;
  const half = Math.floor((limit - 100) / 2);
  return `${serialized.slice(0, half)}\n[... tool output truncated ...]\n${serialized.slice(-half)}`;
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function attachModelTrace(
  error: unknown,
  request: {
    system: string;
    messages: ConversationMessage[];
  },
): void {
  if (!error || typeof error !== "object") return;
  Object.assign(error, {
    agentTrace: {
      request: {
        system: request.system,
        messages: request.messages,
      },
      response: {
        error:
          error instanceof Error ? error.message : String(error),
      },
    },
  });
}
