import assert from "node:assert/strict";
import test from "node:test";
import { ModelHttpError } from "./client.js";
import { ModelRetriesExhaustedError } from "./fallback-client.js";
import {
  classifyModelError,
  extractHttpDetail,
  modelErrorGuidance,
  modelErrorGuidanceText,
  RetryPolicy,
} from "./error-policy.js";

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

test("沿 cause 链提取 HTTP 状态（重试耗尽 → 原始 429）", () => {
  const exhausted = new ModelRetriesExhaustedError(
    new ModelHttpError(429, "rate limited"),
    5,
  );
  assert.deepEqual(extractHttpDetail(exhausted), {
    status: 429,
    message: "rate limited",
  });
  const guidance = modelErrorGuidance(exhausted);
  assert.equal(guidance.category, "rate_limit");
  assert.match(guidance.guidance, /「继续」重试/);
});

test("401/403 → 认证失败，给出更新 Key 的操作指引", () => {
  const guidance = modelErrorGuidance(new ModelHttpError(401, "invalid api key"));
  assert.equal(guidance.category, "auth");
  assert.match(guidance.guidance, /API Key/);
});

test("余额不足（含错误消息关键字）→ 充值或配置 fallback", () => {
  const byStatus = modelErrorGuidance(new ModelHttpError(402, ""));
  assert.equal(byStatus.category, "balance");
  assert.match(byStatus.guidance, /fallback/);

  const byMessage = modelErrorGuidance(
    new ModelHttpError(400, "Insufficient Balance"),
  );
  assert.equal(byMessage.category, "balance");
});

test("404 → 路径/模型名错误；5xx → 服务端异常", () => {
  const notFound = modelErrorGuidance(new ModelHttpError(404, "model not found"));
  assert.equal(notFound.category, "not_found");
  const server = modelErrorGuidance(new ModelHttpError(503, "overloaded"));
  assert.equal(server.category, "server");
});

test("网络类错误（非 HTTP）→ 网络不可达", () => {
  const guidance = modelErrorGuidance(
    new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:443"),
  );
  assert.equal(guidance.category, "network");
  assert.match(guidance.guidance, /网络/);
});

test("上下文超长（非 HTTP）→ 超长指引", () => {
  const guidance = modelErrorGuidance(
    new Error("This model's maximum context length is 200000"),
  );
  assert.equal(guidance.category, "overflow");
  assert.match(guidance.guidance, /压缩/);
});

test("未知错误 → 兜底分类并提示检查配置", () => {
  const guidance = modelErrorGuidance(new Error("something weird"));
  assert.equal(guidance.category, "unknown");
});

test("modelErrorGuidanceText 组合：标签 + 原文 + 操作建议", () => {
  const text = modelErrorGuidanceText(
    new ModelHttpError(429, "rate limited"),
  );
  assert.match(text, /限流/);
  assert.match(text, /rate limited/);
  assert.match(text, /操作建议/);
});
