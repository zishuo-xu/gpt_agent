import { ModelHttpError } from "./client.js";
import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
  StreamChunk,
} from "./types.js";
import type { ModelPricing } from "../core/types.js";

export class ModelRetriesExhaustedError extends Error {
  readonly cause: unknown;
  readonly attempts: number;

  constructor(cause: unknown, attempts: number) {
    super(
      `模型调用在 ${attempts} 次尝试后仍失败：${
        cause instanceof Error ? cause.message : "未知错误"
      }`,
    );
    this.name = "ModelRetriesExhaustedError";
    this.cause = cause;
    this.attempts = attempts;
  }
}

export interface FallbackModelCandidate {
  id: string;
  client: ModelClient;
  pricing?: ModelPricing;
}

export class FallbackModelClient implements ModelClient {
  readonly #candidates: FallbackModelCandidate[];

  constructor(candidates: FallbackModelCandidate[]) {
    if (candidates.length === 0) {
      throw new Error("fallback 模型链不能为空");
    }
    this.#candidates = [...candidates];
  }

  get stream(): ModelClient["stream"] {
    const first = this.#candidates[0];
    return first?.client.stream?.bind(first.client);
  }

  async complete(
    request: CompletionRequest,
  ): Promise<ModelResponse> {
    const fallbacks: NonNullable<ModelResponse["fallbacks"]> = [];
    let lastError: unknown;
    for (let index = 0; index < this.#candidates.length; index += 1) {
      const candidate = this.#candidates[index];
      if (!candidate) continue;
      try {
        const response = await candidate.client.complete(request);
        return {
          ...response,
          model: candidate.id,
          ...(candidate.pricing
            ? { pricing: candidate.pricing }
            : {}),
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
        };
      } catch (error) {
        if (request.signal.aborted || isAbortError(error)) throw error;
        lastError = error;
        const next = this.#candidates[index + 1];
        if (!next) break;
        fallbacks.push({
          from: candidate.id,
          to: next.id,
          reason:
            error instanceof Error ? error.message : "未知模型错误",
        });
      }
    }
    if (lastError instanceof ModelRetriesExhaustedError) {
      throw lastError;
    }
    throw new ModelRetriesExhaustedError(
      lastError,
      this.#candidates.length,
    );
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}
