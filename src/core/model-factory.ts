import type { ConfigService } from "../config/service.js";
import type {
  ModelProviderConfig,
  ModelRole,
  RoleModelConfig,
} from "../config/schema.js";
import { ConfiguredModelClient } from "../model/client.js";
import { FallbackModelClient } from "../model/fallback-client.js";
import type { ModelClient } from "../model/types.js";
import type { ModelPricing } from "./types.js";

function createConfiguredClient(
  provider: ModelProviderConfig,
  model: string,
): ModelClient {
  try {
    return new ConfiguredModelClient(provider, model);
  } catch (error) {
    return {
      async complete() {
        throw error;
      },
    };
  }
}

function failingModelClient(message: string): ModelClient {
  return {
    async complete() {
      throw new Error(message);
    },
  };
}

export class PinnedModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinnedModelUnavailableError";
  }
}

/** 构造实验使用的单一模型客户端；故意不提供 fallback。 */
export function buildPinnedModelClient(
  target: { providerId: string; model: string },
  config: { providers: ModelProviderConfig[] },
): ModelClient {
  const provider = config.providers.find(
    (candidate) => candidate.id === target.providerId,
  );
  if (!provider) {
    throw new PinnedModelUnavailableError(
      `实验模型引用了不存在的供应商：${target.providerId}`,
    );
  }
  try {
    return new FallbackModelClient([
      {
        id: `${target.providerId}/${target.model}`,
        client: new ConfiguredModelClient(provider, target.model),
      },
    ]);
  } catch (error) {
    throw new PinnedModelUnavailableError(
      error instanceof Error ? error.message : "实验模型不可用",
    );
  }
}

/**
 * 构建角色模型 fallback 链（[选中模型, ...fallbacks]）。
 * 供应商缺失/不可用（禁用、缺 Key、模型不在列表）时降级为即抛客户端，
 * 由 FallbackModelClient 顺延到下一候选；pricing 随目标透传用于成本核算。
 * 重试已上收到回合级（AgentLoop.#requestTurn），链内客户端不做请求级重试。
 */
export function buildRoleClientChain(
  role: ModelRole,
  config: {
    models: Record<ModelRole, RoleModelConfig>;
    providers: ModelProviderConfig[];
  },
): Array<{
  id: string;
  client: ModelClient;
  pricing?: ModelPricing;
}> {
  const selection = config.models[role];
  const targets = [selection, ...(selection.fallbacks ?? [])];
  return targets.map((target) => {
    const provider = config.providers.find(
      (candidate) => candidate.id === target.providerId,
    );
    const inner = provider
      ? createConfiguredClient(provider, target.model)
      : failingModelClient(
          `${role} 角色引用了不存在的供应商：${target.providerId}`,
        );
    return {
      id: `${target.providerId}/${target.model}`,
      client: inner,
      ...(target.pricing
        ? { pricing: target.pricing }
        : {}),
    };
  });
}

/** 从生效配置提取各角色定价（缺失角色跳过），供会话成本核算 */
export function rolePricing(
  models: Awaited<
    ReturnType<ConfigService["readEffective"]>
  >["models"],
) {
  return {
    ...(models.main.pricing
      ? { main: models.main.pricing }
      : {}),
    ...(models.cheap.pricing
      ? { cheap: models.cheap.pricing }
      : {}),
    ...(models.explore.pricing
      ? { explore: models.explore.pricing }
      : {}),
  };
}
