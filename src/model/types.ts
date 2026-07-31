import type { ToolCall } from "../core/types.js";
import type { ModelPricing } from "../core/types.js";

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
}

export type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "done"; response: ModelResponse };

export interface ModelClient {
  complete(request: CompletionRequest): Promise<ModelResponse>;
  stream?: ((request: CompletionRequest) => AsyncIterable<StreamChunk>) | undefined;
}
