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

/** 从候选模型 id（形如 "opencode/deepseek-v4-flash"）拆供应商与模型名 */
function splitCandidateId(id: string): {
  providerId: string;
  model: string;
} {
  const slash = id.indexOf("/");
  if (slash <= 0) return { providerId: "unknown", model: id };
  return { providerId: id.slice(0, slash), model: id.slice(slash + 1) };
}

export class FallbackModelClient implements ModelClient {
  readonly #candidates: FallbackModelCandidate[];

  constructor(candidates: FallbackModelCandidate[]) {
    if (candidates.length === 0) {
      throw new Error("fallback 模型链不能为空");
    }
    this.#candidates = [...candidates];
  }

  /**
   * 流式执行（跨候选 fallback）：首候选流式迭代，中途失败（非 abort）
   * 顺延下一候选以完整请求重放。已知权衡：重放时已吐出的 text_delta
   * 会重复（流式无法回滚，Pi 同类）；done 响应附带 model 与 fallbacks。
   */
  async *#stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const fallbacks: NonNullable<ModelResponse["fallbacks"]> = [];
    let lastError: unknown;
    let attempts = 0;
    for (let index = 0; index < this.#candidates.length; index += 1) {
      const candidate = this.#candidates[index]!;
      if (!candidate.client.stream) continue;
      attempts += 1;
      try {
        for await (const chunk of candidate.client.stream(request)) {
          if (
            chunk.type === "text_delta" ||
            chunk.type === "thinking_delta"
          ) {
            yield chunk;
            continue;
          }
          yield {
            type: "done",
            response: {
              ...chunk.response,
              ...splitCandidateId(candidate.id),
              ...(fallbacks.length > 0 ? { fallbacks } : {}),
            },
          };
          return;
        }
        throw new Error("流式响应未正常结束");
      } catch (error) {
        if (request.signal.aborted || isAbortError(error)) throw error;
        lastError = error;
        const next = this.#candidates[index + 1];
        if (!next || !next.client.stream) {
          throw new ModelRetriesExhaustedError(lastError, attempts);
        }
        fallbacks.push({
          from: candidate.id,
          to: next.id,
          reason:
            error instanceof Error ? error.message : "未知模型错误",
        });
      }
    }
    throw new ModelRetriesExhaustedError(lastError, attempts);
  }

  get stream(): ModelClient["stream"] {
    return this.#stream.bind(this);
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
          ...splitCandidateId(candidate.id),
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
