import type { ModelPricing } from "../core/types.js";

/** 按模型单价折算一次调用的费用（元）；未配置单价时返回 undefined */
export function usageCostCny(
  usage: { input: number; output: number; cached: number },
  pricing?: ModelPricing,
): number | undefined {
  if (!pricing) return undefined;
  return (
    (Math.max(0, usage.input - usage.cached) *
      pricing.inputPerMillionCny +
      usage.output * pricing.outputPerMillionCny +
      usage.cached * pricing.cachedInputPerMillionCny) /
    1_000_000
  );
}
