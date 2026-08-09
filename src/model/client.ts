import { randomUUID } from "node:crypto";
import type { ModelProviderConfig } from "../config/schema.js";
import type { ToolCall } from "../core/types.js";
import { pluginToolRegistry } from "../shared/plugin-tool.js";
import { isToolName } from "../shared/tool-names.js";
import type {
  CompletionRequest,
  ConversationMessage,
  ModelClient,
  ModelResponse,
  StreamChunk,
} from "./types.js";

export class ModelHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    message: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModelHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Anthropic extended thinking 默认预算（provider.thinkingBudgetTokens 缺省值） */
export const DEFAULT_THINKING_BUDGET = 2048;

export class ConfiguredModelClient implements ModelClient {
  readonly #provider: ModelProviderConfig;
  readonly #model: string;
  readonly #fetcher: typeof fetch;

  constructor(
    provider: ModelProviderConfig,
    model: string,
    fetcher: typeof fetch = fetch,
  ) {
    if (!provider.enabled) {
      throw new Error(`模型供应商“${provider.name}”已禁用`);
    }
    if (!provider.apiKey) {
      throw new Error(`模型供应商“${provider.name}”尚未配置 API Key`);
    }
    if (!provider.models.includes(model)) {
      throw new Error(`模型“${model}”不在供应商“${provider.name}”的模型列表中`);
    }
    this.#provider = provider;
    this.#model = model;
    this.#fetcher = fetcher;
  }

  async complete(request: CompletionRequest): Promise<ModelResponse> {
    return this.#provider.protocol === "anthropic"
      ? await this.#completeAnthropic(request)
      : await this.#completeOpenAi(request);
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    if (this.#provider.protocol === "anthropic") {
      yield* this.#streamAnthropic(request);
    } else {
      yield* this.#streamOpenAi(request);
    }
  }

  async #completeOpenAi(request: CompletionRequest): Promise<ModelResponse> {
    const tools = request.tools;
    const response = await this.#fetcher(
      appendEndpoint(this.#provider.baseUrl, "chat/completions"),
      {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#provider.apiKey}`,
        },
        body: JSON.stringify({
          model: this.#model,
          max_tokens: request.maxTokens ?? 8192,
          messages: [
            { role: "system", content: request.system },
            ...request.messages.map(toOpenAiMessage),
          ],
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
          tool_choice: "auto",
        }),
      },
    );
    const payload = await parseJsonResponse(response);
    const choice = asRecord(asArray(payload.choices)[0]);
    const message = asRecord(choice.message);
    const text = typeof message.content === "string" ? message.content : "";
    // OpenAI reasoning_content：部分端点（o1 系）返回推理内容，保留供会话/降级使用
    const thinking =
      typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : undefined;
    const toolCalls = asArray(message.tool_calls).map((raw) => {
      const item = asRecord(raw);
      const fn = asRecord(item.function);
      return createToolCall(
        stringValue(item.id) || randomUUID(),
        stringValue(fn.name),
        parseArguments(fn.arguments),
      );
    });
    const usage = asRecord(payload.usage);
    const promptDetails = asRecord(usage.prompt_tokens_details);
    return {
      text,
      toolCalls,
      usage: {
        input: numberValue(usage.prompt_tokens),
        output: numberValue(usage.completion_tokens),
        cached: numberValue(promptDetails.cached_tokens),
      },
      ...(thinking ? { thinking } : {}),
      ...(stringValue(choice.finish_reason)
        ? { stopReason: stringValue(choice.finish_reason) }
        : {}),
      traceRaw: payload,
    };
  }

  /** extended thinking 请求参数（provider.thinking 默认开；显式 false 关闭） */
  #anthropicThinking(): { type: "enabled"; budget_tokens: number } | undefined {
    if (this.#provider.thinking === false) return undefined;
    return {
      type: "enabled",
      budget_tokens:
        this.#provider.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET,
    };
  }

  /**
   * Anthropic complete：thinking 默认开启；若模型不支持 extended thinking
   * （400 且错误含 thinking），自动降级不带 thinking 重试一次——换模型不卡死。
   */
  async #completeAnthropic(request: CompletionRequest): Promise<ModelResponse> {
    const thinking = this.#anthropicThinking();
    try {
      return await this.#completeAnthropicOnce(request, thinking);
    } catch (error) {
      if (thinking && isThinkingUnsupported(error)) {
        return await this.#completeAnthropicOnce(request, undefined);
      }
      throw error;
    }
  }

  async #completeAnthropicOnce(
    request: CompletionRequest,
    thinking: { type: "enabled"; budget_tokens: number } | undefined,
  ): Promise<ModelResponse> {
    const tools = request.tools;
    // 参照 Pi cacheRetention："none" 时省略 cache_control，不写缓存（摘要等一次性请求）
    const cacheControl =
      request.cacheRetention === "none"
        ? undefined
        : { type: "ephemeral" as const };
    const response = await this.#fetcher(
      appendEndpoint(this.#provider.baseUrl, "messages"),
      {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#provider.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.#model,
          system: [
            {
              type: "text",
              text: request.system,
              ...(cacheControl ? { cache_control: cacheControl } : {}),
            },
          ],
          max_tokens: request.maxTokens ?? 8192,
          ...(thinking ? { thinking } : {}),
          messages: toAnthropicMessages(request.messages, cacheControl, thinking),
          tools: tools.map((tool, index) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
            ...(index === tools.length - 1 && cacheControl
              ? { cache_control: cacheControl }
              : {}),
          })),
        }),
      },
    );
    const payload = await parseJsonResponse(response);
    const content = asArray(payload.content);
    const text = content
      .map((block) => asRecord(block))
      .filter((block) => block.type === "text")
      .map((block) => stringValue(block.text))
      .join("");
    // thinking 块（type === "thinking"）单独累积，与 text 分离
    const thinkingText = content
      .map((block) => asRecord(block))
      .filter((block) => block.type === "thinking")
      .map((block) => stringValue(block.thinking))
      .filter(Boolean)
      .join("\n");
    const toolCalls = content
      .map((block) => asRecord(block))
      .filter((block) => block.type === "tool_use")
      .map((block) =>
        createToolCall(
          stringValue(block.id) || randomUUID(),
          stringValue(block.name),
          asRecord(block.input),
        ),
      );
    const usage = asRecord(payload.usage);
    return {
      text,
      toolCalls,
      usage: {
        input: numberValue(usage.input_tokens),
        output: numberValue(usage.output_tokens),
        cached: numberValue(usage.cache_read_input_tokens),
      },
      ...(thinkingText ? { thinking: thinkingText } : {}),
      ...(stringValue(payload.stop_reason)
        ? { stopReason: stringValue(payload.stop_reason) }
        : {}),
      traceRaw: payload,
    };
  }

  async *#streamOpenAi(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const tools = request.tools;
    const response = await this.#fetcher(
      appendEndpoint(this.#provider.baseUrl, "chat/completions"),
      {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#provider.apiKey}`,
        },
        body: JSON.stringify({
          model: this.#model,
          max_tokens: request.maxTokens ?? 8192,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: "system", content: request.system },
            ...request.messages.map(toOpenAiMessage),
          ],
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
          tool_choice: "auto",
        }),
      },
    );
    if (!response.ok || !response.body) {
      const payload = await parseJsonResponse(response);
      throw new Error(stringValue(asRecord(payload.error).message) || `HTTP ${response.status}`);
    }
    let text = "";
    let thinking = "";
    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
    let usage: { input: number; output: number; cached: number } = { input: 0, output: 0, cached: 0 };
    let stopReason = "";
    for await (const event of parseSSE(response.body, request.signal)) {
      if (event === "[DONE]") break;
      let parsed: Record<string, unknown>;
      try { parsed = asRecord(JSON.parse(event)); } catch { continue; }
      const choices = asArray(parsed.choices);
      if (choices.length > 0) {
        const choice = asRecord(choices[0]);
        // finish_reason 只在最后一片上带出，取最后一次非空值
        if (stringValue(choice.finish_reason)) {
          stopReason = stringValue(choice.finish_reason);
        }
        const delta = asRecord(choice.delta);
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        // OpenAI reasoning_content 增量（o1 系）：累积为 thinking，同时实时外发
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          thinking += delta.reasoning_content;
          yield { type: "thinking_delta", text: delta.reasoning_content };
        }
        for (const raw of asArray(delta.tool_calls)) {
          const tc = asRecord(raw);
          const idx = numberValue(tc.index);
          const fn = asRecord(tc.function);
          if (!toolCallAccum.has(idx)) toolCallAccum.set(idx, { id: "", name: "", args: "" });
          const acc = toolCallAccum.get(idx)!;
          if (stringValue(tc.id)) acc.id = stringValue(tc.id);
          if (stringValue(fn.name)) acc.name = stringValue(fn.name);
          if (stringValue(fn.arguments)) acc.args += stringValue(fn.arguments);
        }
      }
      const u = asRecord(parsed.usage);
      if (u.prompt_tokens !== undefined) {
        const details = asRecord(u.prompt_tokens_details);
        usage = {
          input: numberValue(u.prompt_tokens),
          output: numberValue(u.completion_tokens),
          cached: numberValue(details.cached_tokens),
        };
      }
    }
    const toolCalls = [...toolCallAccum.values()]
      .filter((tc) => tc.name)
      .map((tc) => createToolCall(tc.id || randomUUID(), tc.name, parseArguments(tc.args)));
    yield {
      type: "done",
      response: {
        text,
        toolCalls,
        usage,
        ...(thinking ? { thinking } : {}),
        ...(stopReason ? { stopReason } : {}),
      },
    };
  }

  /**
   * Anthropic stream：thinking 默认开启；模型不支持 extended thinking 时
   * 降级不带 thinking 重试一次（400 在 fetch 阶段抛出，尚未 yield 任何
   * chunk，重试不重复输出）。
   */
  async *#streamAnthropic(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const thinking = this.#anthropicThinking();
    try {
      yield* this.#streamAnthropicOnce(request, thinking);
    } catch (error) {
      if (thinking && isThinkingUnsupported(error)) {
        yield* this.#streamAnthropicOnce(request, undefined);
        return;
      }
      throw error;
    }
  }

  async *#streamAnthropicOnce(
    request: CompletionRequest,
    thinking: { type: "enabled"; budget_tokens: number } | undefined,
  ): AsyncIterable<StreamChunk> {
    const tools = request.tools;
    const cacheControl =
      request.cacheRetention === "none"
        ? undefined
        : { type: "ephemeral" as const };
    const response = await this.#fetcher(
      appendEndpoint(this.#provider.baseUrl, "messages"),
      {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#provider.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.#model,
          system: [
            {
              type: "text",
              text: request.system,
              ...(cacheControl ? { cache_control: cacheControl } : {}),
            },
          ],
          max_tokens: request.maxTokens ?? 8192,
          ...(thinking ? { thinking } : {}),
          stream: true,
          messages: toAnthropicMessages(request.messages, cacheControl, thinking),
          tools: tools.map((tool, index) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
            ...(index === tools.length - 1 && cacheControl
              ? { cache_control: cacheControl }
              : {}),
          })),
        }),
      },
    );
    if (!response.ok || !response.body) {
      const payload = await parseJsonResponse(response);
      throw new Error(stringValue(asRecord(payload.error).message) || `HTTP ${response.status}`);
    }
    let text = "";
    let thinkingText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let stopReason = "";
    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
    let currentToolIndex = -1;
    for await (const event of parseSSE(response.body, request.signal)) {
      let parsed: Record<string, unknown>;
      try { parsed = asRecord(JSON.parse(event)); } catch { continue; }
      const eventType = stringValue(parsed.type);
      if (eventType === "content_block_start") {
        const block = asRecord(parsed.content_block);
        if (block.type === "tool_use") {
          currentToolIndex += 1;
          toolCallAccum.set(currentToolIndex, {
            id: stringValue(block.id),
            name: stringValue(block.name),
            args: "",
          });
        }
        // thinking 块开始（extended thinking）：无初始内容
      } else if (eventType === "content_block_delta") {
        const delta = asRecord(parsed.delta);
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          text += delta.text;
          yield { type: "text_delta", text: delta.text };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          thinkingText += delta.thinking;
          yield { type: "thinking_delta", text: delta.thinking };
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const acc = toolCallAccum.get(currentToolIndex);
          if (acc) acc.args += stringValue(delta.partial_json);
        }
      } else if (eventType === "message_delta") {
        const delta = asRecord(parsed.delta);
        stopReason = stringValue(delta.stop_reason) || stopReason;
        const u = asRecord(parsed.usage);
        outputTokens = numberValue(u.output_tokens);
      } else if (eventType === "message_start") {
        const u = asRecord(asRecord(parsed.message).usage);
        inputTokens = numberValue(u.input_tokens);
        cachedTokens = numberValue(u.cache_read_input_tokens);
      }
    }
    const toolCalls = [...toolCallAccum.values()]
      .filter((tc) => tc.name)
      .map((tc) => createToolCall(tc.id || randomUUID(), tc.name, parseArguments(tc.args)));
    yield {
      type: "done",
      response: {
        text,
        toolCalls,
        usage: { input: inputTokens, output: outputTokens, cached: cachedTokens },
        ...(thinkingText ? { thinking: thinkingText } : {}),
        ...(stopReason ? { stopReason } : {}),
      },
    };
  }
}

function toOpenAiMessage(message: ConversationMessage): Record<string, unknown> {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  // thinking 降级为普通文本前缀（Pi「跨模型时 thinking 降级为 text」；
  // OpenAI 请求侧不发送 reasoning 参数，历史推理内容以文本形式可见）
  const thinkingPrefix = message.thinking
    ? `[思考过程]\n${message.thinking}\n\n`
    : "";
  return {
    role: "assistant",
    content: `${thinkingPrefix}${message.content ?? ""}` || null,
    ...(message.toolCalls.length === 0
      ? {}
      : {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.tool,
              // args 已是 wire 键名（全程 wire，无转换层）
              arguments: JSON.stringify(asRecord(call.args)),
            },
          })),
        }),
  };
}

function toAnthropicMessages(
  messages: ConversationMessage[],
  cacheControl?: { type: "ephemeral" } | undefined,
  thinking?: { type: "enabled"; budget_tokens: number } | undefined,
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  // 消息级缓存断点：第一条（非末尾）user 消息标记后，其之前的前缀整段可缓存
  // （Anthropic 断点上限 4 个：system + tools + 至多 2 个消息级；此实现只用 1 个）
  let breakpointPlaced = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as ConversationMessage;
    if (message.role === "user") {
      const isLast = index === messages.length - 1;
      if (cacheControl && !breakpointPlaced && !isLast) {
        breakpointPlaced = true;
        output.push({
          role: "user",
          content: message.content,
          cache_control: cacheControl,
        });
      } else {
        output.push({ role: "user", content: message.content });
      }
      continue;
    }
    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      // thinking 块仅在请求开启 thinking 时发送（否则 Anthropic 400）；
      // 未开启时降级为普通 text 文本（Pi 跨模型降级语义）
      if (message.thinking) {
        if (thinking) {
          content.push({ type: "thinking", thinking: message.thinking });
          if (message.content) {
            content.push({ type: "text", text: message.content });
          }
        } else {
          content.push({
            type: "text",
            text: `[思考过程]\n${message.thinking}\n\n${message.content ?? ""}`,
          });
        }
      } else if (message.content) {
        content.push({ type: "text", text: message.content });
      }
      content.push(
        ...message.toolCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.tool,
          input: asRecord(call.args),
        })),
      );
      output.push({ role: "assistant", content });
      continue;
    }
    const block = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
      is_error: message.isError,
    };
    const last = output.at(-1);
    if (last?.role === "user" && Array.isArray(last.content)) {
      last.content.push(block);
    } else {
      output.push({ role: "user", content: [block] });
    }
  }
  return output;
}

function createToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolCall {
  // 运行时守卫：内置名 ∪ 插件注册表名（插件通道开放了工具名集合）
  if (!isToolName(name) && !pluginToolRegistry.has(name)) {
    throw new Error(`模型请求了未知工具：${name}`);
  }
  return {
    id,
    tool: name,
    target: targetFor(name, args),
    // 全程 wire 键名（参照 Pi：无 camelCase 转换层）；
    // 未知键保留，由工具层的 schema 校验拒绝并回显（不静默丢弃）
    args,
  };
}

function targetFor(tool: string, args: Record<string, unknown>): string {
  if (tool === "Bash") return stringValue(args.command);
  if (tool === "Grep") return stringValue(args.pattern);
  if (tool === "Glob") return stringValue(args.pattern);
  if (tool === "TodoWrite") {
    return `${asArray(args.todos).length} items`;
  }
  if (tool === "Task") return stringValue(args.description);
  // 插件工具：取常见主参名（url/path/command/target/file_path/pattern/query）的首个非空值，
  // 供权限签名与 UI 展示；缺省空串
  for (const key of ["url", "path", "command", "target", "file_path", "pattern", "query"]) {
    const value = stringValue(args[key]);
    if (value) return value;
  }
  return "";
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) return asRecord(value);
  if (typeof value !== "string" || !value) return {};
  try {
    return asRecord(JSON.parse(value));
  } catch {
    throw new Error("模型返回了无法解析的工具参数");
  }
}

async function parseJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = asRecord(JSON.parse(text));
  } catch {
    if (response.ok) throw new Error("模型接口返回了非 JSON 响应");
  }
  if (!response.ok) {
    const error = asRecord(parsed.error);
    const message =
      stringValue(error.message) ||
      stringValue(parsed.message) ||
      text.slice(0, 300) ||
      `HTTP ${response.status}`;
    throw new ModelHttpError(
      response.status,
      message,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  return parsed;
}

/** 拼接供应商端点：已含 endpoint 原样返回；已以 /v1 结尾直接追加；否则补 /v1 前缀 */
/** 400 且错误信息含 thinking：模型不支持 extended thinking 的典型信号 */
function isThinkingUnsupported(error: unknown): boolean {
  return (
    error instanceof ModelHttpError &&
    error.status === 400 &&
    /thinking/i.test(error.message)
  );
}

export function appendEndpoint(baseUrl: string, endpoint: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith(`/${endpoint}`)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/${endpoint}`;
  return `${normalized}/v1/${endpoint}`;
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, any>)
    : {};
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - Date.now());
}

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          yield trimmed.slice(6);
        }
      }
    }
    // 处理缓冲区中剩余数据
    if (buffer.trim().startsWith("data: ")) {
      yield buffer.trim().slice(6);
    }
  } finally {
    reader.releaseLock();
  }
}
