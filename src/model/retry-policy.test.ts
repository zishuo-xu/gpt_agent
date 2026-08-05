import assert from "node:assert/strict";
import test from "node:test";
import { ModelHttpError } from "./client.js";
import { ModelRetriesExhaustedError } from "./resilient-client.js";
import { classifyModelError, RetryPolicy } from "./retry-policy.js";

test("HTTP 状态码分类：429/5xx 可重试，401/403 不可重试", () => {
  assert.equal(classifyModelError(new ModelHttpError(429, "rate limited")), "retry");
  assert.equal(classifyModelError(new ModelHttpError(500, "server error")), "retry");
  assert.equal(classifyModelError(new ModelHttpError(503, "unavailable")), "retry");
  assert.equal(classifyModelError(new ModelHttpError(401, "unauthorized")), "fatal");
  assert.equal(classifyModelError(new ModelHttpError(403, "forbidden")), "fatal");
  assert.equal(classifyModelError(new ModelHttpError(400, "invalid request")), "fatal");
});

test("上下文超长错误分类为 overflow（400 或消息匹配）", () => {
  assert.equal(
    classifyModelError(new ModelHttpError(400, "prompt is too long: 210000 tokens")),
    "overflow",
  );
  assert.equal(
    classifyModelError(new Error("This model's maximum context length is 200000")),
    "overflow",
  );
});

test("quota/余额类错误即使 429 也视为不可重试", () => {
  assert.equal(
    classifyModelError(new ModelHttpError(429, "insufficient_quota")),
    "fatal",
  );
  assert.equal(
    classifyModelError(new Error("out of budget for this project")),
    "fatal",
  );
});

test("网络/限流类消息按 pattern 匹配可重试", () => {
  assert.equal(classifyModelError(new Error("fetch failed")), "retry");
  assert.equal(classifyModelError(new Error("socket hang up")), "retry");
  assert.equal(classifyModelError(new Error("ENOTFOUND api.example.com")), "retry");
  assert.equal(classifyModelError(new Error("stream ended before message_stop")), "retry");
  assert.equal(classifyModelError(new Error("API is overloaded, please retry")), "retry");
});

test("未知错误不可重试（fail-closed）", () => {
  assert.equal(classifyModelError(new Error("some weird bug")), "fatal");
  assert.equal(classifyModelError(undefined), "fatal");
});

test("ModelRetriesExhaustedError 剥壳后按 cause 分类", () => {
  const inner = new ModelHttpError(429, "overloaded");
  assert.equal(classifyModelError(new ModelRetriesExhaustedError(inner, 5)), "retry");
  const overflow = new Error("maximum context length");
  assert.equal(
    classifyModelError(new ModelRetriesExhaustedError(overflow, 5)),
    "overflow",
  );
});
