import { ModelHttpError } from "./client.js";
import { ModelRetriesExhaustedError } from "./fallback-client.js";

/**
 * 模型错误分类与用户指引（单一模块，双用途）：
 * - 机器分类 classifyModelError → RetryPolicy（agent-loop 回合级重试用，参照 Pi 的
 *   RETRYABLE/NON_RETRYABLE pattern 表）：
 *   retry：瞬时错误（限流/5xx/网络），退避后自动重试
 *   overflow：上下文超长，先压缩再重试一次
 *   fatal：quota/认证/未知错误，不重试（fail-closed，交给人处理）
 * - 用户指引 modelErrorGuidance → ModelErrorGuidance（无人值守失败后的可操作文案）：
 *   认证失败 → 更新 API Key；余额不足 → 充值或换 fallback；限流 → 等待重试；
 *   网络不可达 → 检查网络/代理；上下文超长 → 已自动压缩重试。
 */

// ===== 机器分类 =====

export type RetryPolicy = "retry" | "overflow" | "fatal";

/** 上下文超长：压缩后重试可解（Anthropic 400 prompt is too long / OpenAI maximum context length） */
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /maximum context length/i,
  /context length exceeded/i,
  /context_length_exceeded/i,
  /token limit.*exceeded/i,
];

/** 余额/配额耗尽：重试无意义（Pi NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN；
    并入原 error-guidance 的余额关键词，机器分类与用户指引共用一份表） */
const QUOTA_PATTERNS = [
  /insufficient_quota/i,
  /out of budget/i,
  /quota exceeded/i,
  /billing/i,
  /(go|free)usage(limit|error)/i,
  /insufficient/i,
  /\bbalance\b/i,
  /余额/i,
  /额度/i,
  /account.*(expired|disabled)/i,
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

// ===== 用户指引 =====

export type ModelErrorCategory =
  | "auth"
  | "balance"
  | "rate_limit"
  | "not_found"
  | "server"
  | "network"
  | "overflow"
  | "unknown";

export interface ModelErrorGuidance {
  category: ModelErrorCategory;
  label: string;
  guidance: string;
}

/** 沿 cause 链（ModelRetriesExhaustedError.cause → ModelHttpError）提取 HTTP 细节 */
export function extractHttpDetail(
  error: unknown,
): { status: number; message: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current instanceof ModelHttpError) {
      return { status: current.status, message: current.message };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function modelErrorGuidance(error: unknown): ModelErrorGuidance {
  const detail = extractHttpDetail(error);
  if (detail) {
    const { status, message } = detail;
    if (status === 401 || status === 403) {
      return {
        category: "auth",
        label: "认证失败",
        guidance:
          "请到 Web 设置页检查该供应商的 API Key：可能已过期、被删除或不属于当前账号。更新 Key 后重试（运行中会话会自动生效）。",
      };
    }
    if (
      status === 402 ||
      matchesAny(message, QUOTA_PATTERNS)
    ) {
      return {
        category: "balance",
        label: "余额或额度不足",
        guidance:
          "请到供应商控制台充值/续费，或更换余额充足的供应商/模型；也可以在设置页为该角色配置 fallback 模型链，失败时自动降级。",
      };
    }
    if (status === 404) {
      return {
        category: "not_found",
        label: "接口路径或模型名错误",
        guidance:
          "请到 Web 设置页检查该供应商的 Base URL 与模型名：模型必须存在于该供应商的模型列表中（可用「测试连接」验证）。",
      };
    }
    if (status === 429) {
      return {
        category: "rate_limit",
        label: "限流",
        guidance:
          "已自动指数退避重试仍失败。请稍等几分钟后输入「继续」重试，或切换到负载更低的模型/供应商。",
      };
    }
    if (status >= 500) {
      return {
        category: "server",
        label: "供应商服务异常",
        guidance:
          "对方服务端错误。请稍后输入「继续」重试，或更换 fallback 模型。",
      };
    }
  }

  // 无 HTTP 细节（或非标准状态）：复用机器分类，避免 pattern 表双份维护
  switch (classifyModelError(error)) {
    case "overflow":
      return {
        category: "overflow",
        label: "上下文超长",
        guidance:
          "已自动压缩上下文后重试。若仍失败，请精简任务范围，或输入「/compact」手动压缩。",
      };
    case "retry":
      return {
        category: "network",
        label: "网络不可达",
        guidance:
          "请检查本机网络与代理是否能访问该供应商的 Base URL，然后输入「继续」重试。",
      };
    case "fatal": {
      const message =
        error instanceof Error ? error.message : String(error);
      if (matchesAny(message, QUOTA_PATTERNS)) {
        return {
          category: "balance",
          label: "余额或额度不足",
          guidance:
            "请到供应商控制台充值/续费，或更换余额充足的供应商/模型；也可以在设置页为该角色配置 fallback 模型链，失败时自动降级。",
        };
      }
      return {
        category: "unknown",
        label: "模型调用失败",
        guidance:
          "请检查模型配置（API Key / 模型名 / 网络）后输入「继续」重试。",
      };
    }
  }
}

/** 生成最终用户可见文案：分类标签 + 原始错误 + 操作建议 */
export function modelErrorGuidanceText(error: unknown): string {
  const guidance = modelErrorGuidance(error);
  const original =
    error instanceof ModelHttpError ||
    error instanceof ModelRetriesExhaustedError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return `${guidance.label}：${original}。操作建议：${guidance.guidance}`;
}
