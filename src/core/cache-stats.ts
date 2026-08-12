import type { ModelPricing } from "./types.js";

/**
 * 缓存浪费度量（参照 Pi 的 cache-stats）：上轮 prompt 在本轮应已命中缓存，
 * 若 cacheRead 低于上轮总量说明前缀被破坏（浪费重新计费的 token）。
 *
 * 原因分类（优先级）：
 * - compaction：压缩后缓存必然失效 → 合法，仅标记原因不视为异常
 * - model_switch：模型/供应商切换 → 异常，计入浪费
 * - idle：超过供应商缓存 TTL（Anthropic 5 分钟）→ 提示
 * - 其余：未知破坏源
 *
 * reportedCache sticky（Pi 语义）：会话从未报告过缓存活动（cached > 0）
 * 时不计 miss——区分「OpenAI 式全 miss」与「根本不支持缓存的 provider」，
 * 避免 DeepSeek 等 OpenAI 兼容端点（cached 恒为 0）每轮误报缓存浪费。
 * sticky 置位后永不重置（压缩重置 prev 不影响该标志）。
 *
 * <1024 tokens 的 miss 视为 breakpoint 粒度噪音忽略。
 */
export function computeMissedTokens(
  usage: { input: number; output: number; cached: number },
  prevInputTokens: number,
  prevTurnAtMs: number,
  nowMs: number,
  compactionCount: number,
  seenCompactions: number,
  switchedModel: boolean,
  /** 会话是否曾报告过缓存命中（sticky：置位后永不重置） */
  everReportedCache: boolean,
): { missedTokens: number; missedReason?: "compaction" | "model_switch" | "idle" } {
  if (prevInputTokens <= 0) return { missedTokens: 0 };
  // 从未见过缓存活动的供应商（cached 恒为 0）：不报 miss，避免误报
  if (!everReportedCache) return { missedTokens: 0 };
  const expectedCached = Math.min(prevInputTokens, usage.input);
  const missedTokens = Math.max(0, expectedCached - usage.cached);
  if (missedTokens < 1024) return { missedTokens: 0 };
  if (compactionCount > seenCompactions) {
    return { missedTokens, missedReason: "compaction" };
  }
  if (switchedModel) {
    return { missedTokens, missedReason: "model_switch" };
  }
  // Anthropic 缓存 TTL 5 分钟；空闲超时后未命中属预期，但值得提示
  if (prevTurnAtMs > 0 && nowMs - prevTurnAtMs > 5 * 60_000) {
    return { missedTokens, missedReason: "idle" };
  }
  return { missedTokens };
}

/** miss 浪费费用：missedTokens 本可按缓存价计费，实际按全价输入计费。
    压缩是合法的缓存重置（Pi 语义：重置计数不计浪费），返回 undefined。 */
export function missedCost(
  missedTokens: number,
  missedReason: "compaction" | "model_switch" | "idle" | undefined,
  pricing?: ModelPricing,
): number | undefined {
  if (missedTokens <= 0 || missedReason === "compaction") return undefined;
  if (!pricing) return undefined;
  return (
    (missedTokens *
      Math.max(
        0,
        pricing.inputPerMillionCny - pricing.cachedInputPerMillionCny,
      )) /
    1_000_000
  );
}

/**
 * 缓存 miss 提示的显示阈值（参照 Pi cache-stats 的 UI 显示规则）：
 * missedTokens < 20_000 且 missedCostCny < 0.1 时视为噪音不显示。
 * 注意：仅用于展示门控；会话累计（/cost、summary）不受影响。
 */
export function shouldShowCacheMissNotice(
  missedTokens: number | undefined,
  missedCostCny: number | undefined,
): boolean {
  return (missedTokens ?? 0) >= 20_000 || (missedCostCny ?? 0) >= 0.1;
}
