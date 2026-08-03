import { ModelHttpError } from "./client.js";
import { ModelRetriesExhaustedError } from "./resilient-client.js";

/**
 * 模型错误可操作化（借鉴 Pi：错误信息透明、可行动）。
 *
 * 无人值守场景的痛点：任务在夜里因"余额不足/限流/断网"失败，
 * 用户早上只看到一行原始报错，不知道下一步该做什么。
 * 本模块把底层错误分类并翻译成具体的操作指引：
 * - 认证失败 → 去设置页更新 API Key
 * - 余额不足 → 充值或换 fallback
 * - 限流 → 等待重试或换模型
 * - 网络不可达 → 检查网络/代理
 */

export type ModelErrorCategory =
  | "auth"
  | "balance"
  | "rate_limit"
  | "not_found"
  | "server"
  | "network"
  | "unknown";

export interface ModelErrorGuidance {
  category: ModelErrorCategory;
  label: string;
  guidance: string;
}

const NETWORK_PATTERNS = [
  /fetch failed/i,
  /ENOTFOUND/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /network/i,
  /socket hang up/i,
];

const BALANCE_PATTERNS = [
  /insufficient/i,
  /\bbalance\b/i,
  /\bquota\b/i,
  /余额/i,
  /额度/i,
  /account.*(expired|disabled)/i,
];

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

export function classifyModelError(error: unknown): ModelErrorGuidance {
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
      BALANCE_PATTERNS.some((pattern) => pattern.test(message))
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
    return {
      category: "unknown",
      label: `HTTP ${status}`,
      guidance: "请检查供应商配置后输入「继续」重试。",
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (NETWORK_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      category: "network",
      label: "网络不可达",
      guidance:
        "请检查本机网络与代理是否能访问该供应商的 Base URL，然后输入「继续」重试。",
    };
  }
  return {
    category: "unknown",
    label: "模型调用失败",
    guidance:
      "请检查模型配置（API Key / 模型名 / 网络）后输入「继续」重试。",
  };
}

/** 生成最终用户可见文案：分类标签 + 原始错误 + 操作建议 */
export function modelErrorGuidanceText(error: unknown): string {
  const guidance = classifyModelError(error);
  const original =
    error instanceof ModelHttpError ||
    error instanceof ModelRetriesExhaustedError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return `${guidance.label}：${original}。操作建议：${guidance.guidance}`;
}
