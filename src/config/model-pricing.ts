import type { ModelPricing } from "../core/types.js";

/**
 * 内置常见模型价格表（人民币 / 每百万 token）。
 *
 * 用途：模型配置未显式填写 pricing 时，按模型名自动匹配默认价格，
 * 让成本统计（costCny / 预算盒）开箱即用。显式配置的 pricing 永远优先。
 *
 * 价格来源为公开发布价，可能有波动；如需精确对账请在该模型的配置里
 * 显式填写 pricing 覆盖。
 */
export const BUILTIN_PRICING: Record<string, ModelPricing> = {
  // —— Anthropic Claude ——
  "claude-sonnet": {
    inputPerMillionCny: 21,
    outputPerMillionCny: 105,
    cachedInputPerMillionCny: 1.05,
  },
  "claude-opus": {
    inputPerMillionCny: 105,
    outputPerMillionCny: 525,
    cachedInputPerMillionCny: 5.25,
  },
  "claude-haiku": {
    inputPerMillionCny: 7,
    outputPerMillionCny: 35,
    cachedInputPerMillionCny: 0.35,
  },
  // —— DeepSeek ——
  // deepseek-v4 系列官方分时计价（高峰为空闲两倍，缓存命中价差极大）；
  // 本表取高峰档作为保守上界（成本估算宁高勿低，预算盒更安全）
  "deepseek-chat": {
    inputPerMillionCny: 2,
    outputPerMillionCny: 8,
    cachedInputPerMillionCny: 0.5,
  },
  "deepseek-reasoner": {
    inputPerMillionCny: 4,
    outputPerMillionCny: 16,
    cachedInputPerMillionCny: 1,
  },
  "deepseek-v4-flash": {
    inputPerMillionCny: 3,
    outputPerMillionCny: 9,
    cachedInputPerMillionCny: 0.1,
  },
  // —— Moonshot Kimi ——
  "kimi-k2": {
    inputPerMillionCny: 4,
    outputPerMillionCny: 16,
    cachedInputPerMillionCny: 1,
  },
  "kimi-latest": {
    inputPerMillionCny: 4,
    outputPerMillionCny: 16,
    cachedInputPerMillionCny: 1,
  },
  // —— GLM（智谱）——
  "glm-4": {
    inputPerMillionCny: 0.6,
    outputPerMillionCny: 0.6,
    cachedInputPerMillionCny: 0.6,
  },
  // —— Qwen（通义）——
  "qwen-plus": {
    inputPerMillionCny: 4,
    outputPerMillionCny: 12,
    cachedInputPerMillionCny: 1,
  },
};

/** 按模型名前缀匹配内置价格（"claude-sonnet-4-5" 命中 "claude-sonnet"）。 */
export function builtinPricingFor(model: string): ModelPricing | undefined {
  const name = model.trim().toLowerCase();
  const exact = BUILTIN_PRICING[name];
  if (exact) return exact;
  // 前缀匹配：按 key 长度降序，取最长的命中前缀
  const candidates = Object.entries(BUILTIN_PRICING)
    .filter(([key]) => name.startsWith(key))
    .sort((a, b) => b[0].length - a[0].length);
  return candidates[0]?.[1];
}
