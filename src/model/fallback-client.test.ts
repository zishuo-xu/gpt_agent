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

test("流式：首候选中途失败顺延第二候选重放完整请求，done 携带 model 与 fallbacks", async () => {
  const primary: ModelClient = {
    async *stream() {
      yield { type: "text_delta", text: "半截" };
      throw new ModelHttpError(500, "stream broke");
    },
  };
  const backup: ModelClient = {
    async *stream() {
      yield { type: "text_delta", text: "完整回答" };
      yield {
        type: "done",
        response: { text: "完整回答", toolCalls: [], usage: { input: 2, output: 3, cached: 1 } },
      };
    },
  };
  const fallback = new FallbackModelClient([
    { id: "provider-a/main", client: primary },
    { id: "provider-b/backup", client: backup },
  ]);

  const chunks: string[] = [];
  let finalResponse: ModelResponse | undefined;
  for await (const chunk of fallback.stream!(request())) {
    if (chunk.type === "text_delta") chunks.push(chunk.text);
    else finalResponse = chunk.response;
  }
  // 已知权衡：首候选已吐出的 text_delta 在重放时重复
  assert.deepEqual(chunks, ["半截", "完整回答"]);
  assert.equal(finalResponse?.model, "provider-b/backup");
  assert.equal(finalResponse?.text, "完整回答");
  assert.equal(finalResponse?.fallbacks?.[0]?.from, "provider-a/main");
  assert.equal(finalResponse?.fallbacks?.[0]?.to, "provider-b/backup");
  assert.match(finalResponse?.fallbacks?.[0]?.reason ?? "", /stream broke/);
});

test("流式：全部候选失败抛 ModelRetriesExhaustedError（含底层原因）", async () => {
  const fallback = new FallbackModelClient([
    {
      id: "provider-a/main",
      client: {
        async *stream() {
          throw new ModelHttpError(503, "still down");
        },
      },
    },
  ]);

  await assert.rejects(
    (async () => {
      for await (const _chunk of fallback.stream!(request())) {
        // 消费生成器
      }
    })(),
    (error) =>
      error instanceof ModelRetriesExhaustedError &&
      error.cause instanceof ModelHttpError &&
      error.cause.status === 503,
  );
});

test("流式：abort 时立即透传不 fallback", async () => {
  let primaryCalls = 0;
  let backupCalls = 0;
  const controller = new AbortController();
  const fallback = new FallbackModelClient([
    {
      id: "provider-a/main",
      client: {
        async *stream() {
          primaryCalls += 1;
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
      },
    },
    {
      id: "provider-b/backup",
      client: {
        async *stream() {
          backupCalls += 1;
          yield {
            type: "done",
            response: { text: "ok", toolCalls: [], usage: { input: 1, output: 1, cached: 0 } },
          };
        },
      },
    },
  ]);

  await assert.rejects(
    (async () => {
      for await (const _chunk of fallback.stream!(request(controller.signal))) {
        // 消费生成器
      }
    })(),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 0, "abort 不应触发 fallback");
});
