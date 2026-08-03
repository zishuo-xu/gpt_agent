import assert from "node:assert/strict";
import test from "node:test";
import { ModelHttpError } from "./client.js";
import {
  classifyModelError,
  extractHttpDetail,
  modelErrorGuidanceText,
} from "./error-guidance.js";
import { ModelRetriesExhaustedError } from "./resilient-client.js";

test("沿 cause 链提取 HTTP 状态（重试耗尽 → 原始 429）", () => {
  const exhausted = new ModelRetriesExhaustedError(
    new ModelHttpError(429, "rate limited"),
    5,
  );
  assert.deepEqual(extractHttpDetail(exhausted), {
    status: 429,
    message: "rate limited",
  });
  const guidance = classifyModelError(exhausted);
  assert.equal(guidance.category, "rate_limit");
  assert.match(guidance.guidance, /「继续」重试/);
});

test("401/403 → 认证失败，给出更新 Key 的操作指引", () => {
  const guidance = classifyModelError(new ModelHttpError(401, "invalid api key"));
  assert.equal(guidance.category, "auth");
  assert.match(guidance.guidance, /API Key/);
});

test("余额不足（含错误消息关键字）→ 充值或配置 fallback", () => {
  const byStatus = classifyModelError(new ModelHttpError(402, ""));
  assert.equal(byStatus.category, "balance");
  assert.match(byStatus.guidance, /fallback/);

  const byMessage = classifyModelError(
    new ModelHttpError(400, "Insufficient Balance"),
  );
  assert.equal(byMessage.category, "balance");
});

test("404 → 路径/模型名错误；5xx → 服务端异常", () => {
  const notFound = classifyModelError(new ModelHttpError(404, "model not found"));
  assert.equal(notFound.category, "not_found");
  const server = classifyModelError(new ModelHttpError(503, "overloaded"));
  assert.equal(server.category, "server");
});

test("网络类错误（非 HTTP）→ 网络不可达", () => {
  const guidance = classifyModelError(
    new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:443"),
  );
  assert.equal(guidance.category, "network");
  assert.match(guidance.guidance, /网络/);
});

test("未知错误 → 兜底分类并提示检查配置", () => {
  const guidance = classifyModelError(new Error("something weird"));
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
