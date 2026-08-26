import { ConfigService } from "../config/service.js";
import { builtinPricingFor } from "../config/model-pricing.js";
import { buildRoleClientChain } from "../core/model-factory.js";
import type { ModelClient, CompletionRequest, ModelResponse } from "../model/types.js";
import type { ModelPricing } from "../core/types.js";
import type { EvalOptions, EvalScenario } from "./types.js";

export interface InjectedEvalLabel {
  providerId: string;
  model: string;
}

export interface InjectedEvalOptions extends EvalOptions {
  injected: NonNullable<EvalOptions["injected"]> & { label: InjectedEvalLabel };
}

/**
 * 从生效配置构建真实模型注入缝：main 角色 fallback 链的首个可用客户端
 * + 配置或内置价格表单价。供 runScenario 的 options.injected 使用，
 * 让确定性场景在真实供应商上测得成功率、tokens、成本与耗时。
 *
 * 判定"可用"的方式与链式降级一致：createConfiguredClient 把构造失败
 * （禁用/缺 Key/模型不在列表）包装为补全时即抛的客户端，这里通过一次
 * 构造期探测选择第一个不抛错的候选。
 */
export async function buildInjectedEvalOptions(options: { homeDir?: string; cwd?: string }): Promise<InjectedEvalOptions> {
  const configService = new ConfigService({
    cwd: options.cwd ?? process.cwd(),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
  const effective = await configService.readEffective();

  const chain = buildRoleClientChain("main", effective);
  // 不联网探测：createConfiguredClient 已把禁用/缺 Key/模型不在列表包成
  // 即抛客户端，其报错在第一次 complete 就会复现——直接选首候选，
  // 由 FirstAvailableClient 在真正补全时顺延次选，避免探测流量打真实网关
  const usable = chain[0];
  if (!usable) throw new Error("没有可用的真实模型：请检查 providers/models 配置（Web 设置页可测试连接）");

  const slashIndex = usable.id.indexOf("/");
  const label: InjectedEvalLabel = {
    providerId: slashIndex > 0 ? usable.id.slice(0, slashIndex) : "unknown",
    model: slashIndex > 0 ? usable.id.slice(slashIndex + 1) : usable.id,
  };
  // 配置显式 pricing 优先；缺省回退内置价格表；两者皆无则记 0（报告成本不可信）
  const pricing: ModelPricing =
    usable.pricing ??
    builtinPricingFor(label.model) ?? { inputPerMillionCny: 0, outputPerMillionCny: 0, cachedInputPerMillionCny: 0 };

  return {
    injected: {
      createClient: (_context: { scenario: EvalScenario; cwd: string }): ModelClient => {
        const candidates = buildRoleClientChain("main", effective);
        return new FirstAvailableClient(candidates);
      },
      pricing: { main: pricing },
      label,
    },
  };
}

/** eval 会话只需 complete()；多候选时顺延到首个成功者。 */
class FirstAvailableClient implements ModelClient {
  constructor(private readonly candidates: Array<{ id: string; client: ModelClient }>) {}

  async complete(request: CompletionRequest): Promise<ModelResponse> {
    let lastError: unknown;
    for (const candidate of this.candidates) {
      try {
        return await candidate.client.complete(request);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
