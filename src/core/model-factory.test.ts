import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelProviderConfig,
  ModelRole,
  RoleModelConfig,
} from "../config/schema.js";
import { buildRoleClientChain, rolePricing } from "./model-factory.js";

const PRICING = {
  inputPerMillionCny: 1,
  outputPerMillionCny: 2,
  cachedInputPerMillionCny: 0.2,
};

const provider: ModelProviderConfig = {
  id: "deepseek",
  name: "DeepSeek",
  enabled: true,
  protocol: "openai-compatible",
  baseUrl: "http://127.0.0.1:1",
  apiKey: "test-key",
  models: ["deepseek-chat"],
};

function makeConfig(
  overrides: Partial<
    Record<ModelRole, Partial<RoleModelConfig>>
  > = {},
) {
  const base: RoleModelConfig = {
    providerId: "deepseek",
    model: "deepseek-chat",
  };
  return {
    models: {
      main: { ...base, ...overrides.main },
      cheap: { ...base, ...overrides.cheap },
      explore: { ...base, ...overrides.explore },
    } as Record<ModelRole, RoleModelConfig>,
    providers: [provider],
  };
}

test("buildRoleClientChain：按选中 + fallback 顺序构建链", () => {
  const config = makeConfig({
    main: {
      fallbacks: [{ providerId: "deepseek", model: "deepseek-chat" }],
    },
  });
  const chain = buildRoleClientChain("main", config);
  assert.equal(chain.length, 2);
  assert.equal(chain[0]?.id, "deepseek/deepseek-chat");
  assert.equal(chain[1]?.id, "deepseek/deepseek-chat");
  assert.ok(chain[0]?.client, "客户端已构建");
});

test("buildRoleClientChain：pricing 随目标透传（未配则无）", () => {
  const withPricing = buildRoleClientChain("main", makeConfig({ main: { pricing: PRICING } }));
  assert.deepEqual(withPricing[0]?.pricing, PRICING);
  const without = buildRoleClientChain("explore", makeConfig());
  assert.equal(without[0]?.pricing, undefined);
});

test("buildRoleClientChain：供应商缺失降级为即抛客户端", async () => {
  const config = makeConfig({
    cheap: { providerId: "missing-vendor", model: "x" },
  });
  const chain = buildRoleClientChain("cheap", config);
  assert.equal(chain.length, 1);
  assert.equal(chain[0]?.id, "missing-vendor/x");
  const request = {
    system: "",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  };
  await assert.rejects(
    chain[0]!.client.complete(request),
    /cheap 角色引用了不存在的供应商：missing-vendor/,
  );
});

test("rolePricing：按角色提取定价，缺失角色跳过", () => {
  const models = {
    main: { providerId: "p", model: "m", pricing: PRICING },
    cheap: { providerId: "p", model: "m2" },
    explore: { providerId: "p", model: "m3", pricing: PRICING },
  } as unknown as Parameters<typeof rolePricing>[0];
  assert.deepEqual(rolePricing(models), {
    main: PRICING,
    explore: PRICING,
  });
});
