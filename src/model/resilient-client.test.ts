import assert from "node:assert/strict";
import test from "node:test";
import { ModelHttpError } from "./client.js";
import {
  FallbackModelClient,
  ModelRetriesExhaustedError,
  ResilientModelClient,
} from "./resilient-client.js";
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

test("429/5xx 按指数退避重试并尊重 Retry-After", async () => {
  let calls = 0;
  const delays: number[] = [];
  const inner: ModelClient = {
    async complete() {
      calls += 1;
      if (calls === 1) throw new ModelHttpError(429, "rate", 3_000);
      if (calls === 2) throw new ModelHttpError(503, "busy");
      return success;
    },
  };
  const client = new ResilientModelClient(inner, {
    maxRetries: 5,
    initialDelayMs: 1_000,
    sleep: async (delay) => {
      delays.push(delay);
    },
  });

  assert.equal((await client.complete(request())).text, "ok");
  assert.equal(calls, 3);
  // retryAfter 优先（3s），不受 jitter 影响；指数退避项 ×25% 向下抖动（2000×0.75~1.0）
  assert.equal(delays[0], 3_000);
  assert.ok(
    delays[1]! >= 1_500 && delays[1]! <= 2_000,
    `指数退避应带 25% 向下抖动，实际 ${delays[1]}`,
  );
});

test("非瞬时错误不重试，重试耗尽返回可识别错误", async () => {
  let calls = 0;
  const inner: ModelClient = {
    async complete() {
      calls += 1;
      throw new ModelHttpError(401, "unauthorized");
    },
  };
  const client = new ResilientModelClient(inner, {
    sleep: async () => undefined,
  });

  await assert.rejects(
    client.complete(request()),
    (error) =>
      error instanceof ModelRetriesExhaustedError &&
      error.attempts === 1,
  );
  assert.equal(calls, 1);
});

test("中止信号立即打断退避等待", async () => {
  const controller = new AbortController();
  const inner: ModelClient = {
    async complete() {
      throw new ModelHttpError(503, "busy");
    },
  };
  const client = new ResilientModelClient(inner, {
    initialDelayMs: 60_000,
  });
  const running = client.complete(request(controller.signal));
  controller.abort();

  await assert.rejects(running, { name: "AbortError" });
});

test("主候选重试耗尽后按顺序 fallback 并携带实际单价", async () => {
  const primary = new ResilientModelClient(
    {
      async complete() {
        throw new ModelHttpError(503, "primary unavailable");
      },
    },
    { maxRetries: 0 },
  );
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
