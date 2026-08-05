import { ModelHttpError } from "./client.js";
import { ModelRetriesExhaustedError } from "./resilient-client.js";

/**
 * 模型错误分类（参照 Pi 的 RETRYABLE/NON_RETRYABLE pattern 表）：
 * - retry：瞬时错误（限流/5xx/网络），退避后自动重试
 * - overflow：上下文超长，先压缩再重试一次
 * - fatal：quota/认证/未知错误，不重试（fail-closed，交给人处理）
 */

export type RetryPolicy = "retry" | "overflow" | "fatal";

/** 上下文超长：压缩后重试可解（Anthropic 400 prompt is too long / OpenAI maximum context length） */
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /maximum context length/i,
  /context length exceeded/i,
  /context_length_exceeded/i,
  /token limit.*exceeded/i,
];

/** 余额/配额耗尽：重试无意义（Pi NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN） */
const QUOTA_PATTERNS = [
  /insufficient_quota/i,
  /out of budget/i,
  /quota exceeded/i,
  /billing/i,
  /(go|free)usage(limit|error)/i,
];

/** 瞬时错误消息（Pi RETRYABLE_PROVIDER_ERROR_PATTERN 子集） */
const RETRYABLE_PATTERNS = [
  /overloaded/i,
  /rate.?limit/i,
  /too many requests/i,
  /service.?unavailable/i,
  /server.?error/i,
  /internal.?error/i,
  /provider.?returned.?error/i,
  /network.?error/i,
  /connection.?refused/i,
  /fetch failed/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /timed? ?out/i,
  /stream ended before message_stop/i,
  /http2 request did not get a response/i,
  /ResourceExhausted/i,
  /websocket.?closed/i,
];

/** 剥开重试/fallback 包装层，取根因 */
function unwrap(error: unknown): unknown {
  if (error instanceof ModelRetriesExhaustedError) {
    return unwrap(error.cause);
  }
  return error;
}

export function classifyModelError(error: unknown): RetryPolicy {
  const cause = unwrap(error);
  if (cause instanceof ModelHttpError) {
    if (cause.status === 400 && matchesAny(cause.message, CONTEXT_OVERFLOW_PATTERNS)) {
      return "overflow";
    }
    if (cause.status === 429 || cause.status >= 500) {
      return matchesAny(cause.message, QUOTA_PATTERNS) ? "fatal" : "retry";
    }
    return "fatal";
  }
  const message =
    cause instanceof Error ? cause.message : String(cause ?? "");
  if (matchesAny(message, CONTEXT_OVERFLOW_PATTERNS)) return "overflow";
  if (matchesAny(message, QUOTA_PATTERNS)) return "fatal";
  if (matchesAny(message, RETRYABLE_PATTERNS)) return "retry";
  return "fatal";
}

function matchesAny(
  message: string,
  patterns: RegExp[],
): boolean {
  return patterns.some((pattern) => pattern.test(message));
}
