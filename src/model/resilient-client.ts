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

export interface ResilientModelClientOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export class ResilientModelClient implements ModelClient {
  readonly #inner: ModelClient;
  readonly #maxRetries: number;
  readonly #initialDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #sleep: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(
    inner: ModelClient,
    options: ResilientModelClientOptions = {},
  ) {
    this.#inner = inner;
    this.#maxRetries = options.maxRetries ?? 5;
    this.#initialDelayMs = options.initialDelayMs ?? 1_000;
    this.#maxDelayMs = options.maxDelayMs ?? 60_000;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  get stream(): ModelClient["stream"] {
    return this.#inner.stream?.bind(this.#inner);
  }

  async complete(
    request: CompletionRequest,
  ): Promise<ModelResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      if (request.signal.aborted) throw abortError();
      try {
        return await this.#inner.complete(request);
      } catch (error) {
        if (request.signal.aborted) throw abortError();
        if (isAbortError(error)) throw error;
        lastError = error;
        if (!isRetryable(error) || attempt === this.#maxRetries) {
          throw new ModelRetriesExhaustedError(error, attempt + 1);
        }
        const backoff = Math.min(
          this.#maxDelayMs,
          this.#initialDelayMs * 2 ** attempt,
        );
        const retryAfter =
          error instanceof ModelHttpError
            ? error.retryAfterMs
            : undefined;
        // 25% 向下抖动（参照 Pi getRetryDelayMs：delay × (1 - random×0.25)），
        // 避免多会话同步失败时同时重试
        const jittered = backoff * (1 - Math.random() * 0.25);
        await this.#sleep(
          Math.max(jittered, retryAfter ?? 0),
          request.signal,
        );
      }
    }
    throw new ModelRetriesExhaustedError(
      lastError,
      this.#maxRetries + 1,
    );
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

function isRetryable(error: unknown): boolean {
  if (error instanceof ModelHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

async function abortableSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
