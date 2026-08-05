import assert from "node:assert/strict";
import test from "node:test";
import { ModelHttpError } from "./client.js";
import {
  FallbackModelClient,
  ModelRetriesExhaustedError,
} from "./fallback-client.js";
import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
} from "./types.js";

function request(signal = new AbortController().signal): CompletionRequest {
  return {
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    signal,
  };
}

const success: ModelResponse = {
  text: "ok",
  toolCalls: [],
  usage: { input: 1, output: 1, cached: 0 },
};

test("主候选失败后按顺序 fallback 并携带实际单价", async () => {
  const primary: ModelClient = {
    async complete() {
      throw new ModelHttpError(503, "primary unavailable");
    },
  };
  const fallback = new FallbackModelClient([
    { id: "provider-a/main", client: primary },
    {
      id: "provider-b/backup",
      client: { async complete() { return success; } },
      pricing: {
        inputPerMillionCny: 2,
        outputPerMillionCny: 8,
        cachedInputPerMillionCny: 0.5,
      },
    },
  ]);

  const result = await fallback.complete(request());

  assert.equal(result.model, "provider-b/backup");
  assert.equal(result.pricing?.outputPerMillionCny, 8);
  assert.equal(result.fallbacks?.[0]?.from, "provider-a/main");
  assert.equal(result.fallbacks?.[0]?.to, "provider-b/backup");
  assert.match(result.fallbacks?.[0]?.reason ?? "", /primary unavailable/);
});

test("全部候选失败时抛可识别错误（含底层原因，供回合级分类）", async () => {
  const fallback = new FallbackModelClient([
    {
      id: "provider-a/main",
      client: {
        async complete() {
          throw new ModelHttpError(503, "still unavailable");
        },
      },
    },
  ]);

  await assert.rejects(
    fallback.complete(request()),
    (error) =>
      error instanceof ModelRetriesExhaustedError &&
      error.cause instanceof ModelHttpError &&
      error.cause.status === 503,
  );
});
