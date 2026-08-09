import type { ToolCall } from "../core/types.js";
import type { ModelPricing } from "../core/types.js";
import type { ToolDefinition } from "../tools/tool-definitions.js";

export type ConversationMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      /** 推理内容（Anthropic thinking / OpenAI reasoning_content）。
          不持久化到事件流；wire 构建时按目标供应商能力保留或降级为普通文本。 */
      thinking?: string;
    }
  | {
      role: "tool";
      toolCallId: string;
      toolName: string;
      target?: string;
      content: string;
      isError: boolean;
    };

export interface ModelUsage {
  input: number;
  output: number;
  cached: number;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: ModelUsage;
  /** 供应商原始终止原因（Anthropic stop_reason / OpenAI finish_reason） */
  stopReason?: string;
  /** 推理内容（Anthropic thinking 块 / OpenAI reasoning_content） */
  thinking?: string;
  model?: string;
  providerId?: string;
  pricing?: ModelPricing;
  fallbacks?: Array<{
    from: string;
    to: string;
    reason: string;
  }>;
  traceRaw?: unknown;
}

export interface CompletionRequest {
  system: string;
  messages: ConversationMessage[];
  signal: AbortSignal;
  /** 本次请求注入的工具集（调用方显式提供；不传即无工具调用能力）。
      同一模型会话内必须固定，否则破坏 prompt cache 前缀。 */
  tools: ToolDefinition[];
  /** 缓存写入策略（参照 Pi cacheRetention）：摘要等一次性辅助请求用 "none"
      省略 cache_control，避免污染主会话缓存前缀。缺省 "default"（正常写缓存）。 */
  cacheRetention?: "default" | "none";
  /** 单次请求最大输出 tokens；缺省 8192（客户端兜底） */
  maxTokens?: number;
}

export type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "done"; response: ModelResponse };

export interface ModelClient {
  complete(request: CompletionRequest): Promise<ModelResponse>;
  stream?: ((request: CompletionRequest) => AsyncIterable<StreamChunk>) | undefined;
}
