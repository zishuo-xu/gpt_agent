import type { ToolCall } from "../core/types.js";
import type { ModelPricing } from "../core/types.js";
import type { ToolDefinition } from "./tool-definitions.js";

export type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
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
  /** 本次请求注入的工具集；缺省时由客户端决定（全量编码工具）。
      同一模型会话内必须固定，否则破坏 prompt cache 前缀。 */
  tools?: ToolDefinition[];
}

export type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "done"; response: ModelResponse };

export interface ModelClient {
  complete(request: CompletionRequest): Promise<ModelResponse>;
  stream?: ((request: CompletionRequest) => AsyncIterable<StreamChunk>) | undefined;
}
