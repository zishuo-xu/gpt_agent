import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProviderConfig } from "../config/schema.js";
import { testModelConnection } from "./test-connection.js";

const provider: ModelProviderConfig = {
  id: "deepseek",
  name: "DeepSeek",
  enabled: true,
  protocol: "openai-compatible",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "secret",
  models: ["deepseek-chat"],
};

test("OpenAI-compatible 测试发送最小 chat/completions 请求", async () => {
  let requestedUrl = "";
  let authorization = "";
  let requestBody: unknown;
  const fetcher: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await testModelConnection(
    provider,
    "deepseek-chat",
    fetcher,
  );
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(authorization, "Bearer secret");
  assert.deepEqual(
    (requestBody as { messages: unknown[] }).messages,
    [{ role: "user", content: "Reply with OK." }],
  );
});

test("Anthropic 测试使用 messages 协议与专用认证头", async () => {
  const anthropic: ModelProviderConfig = {
    id: "anthropic",
    name: "Anthropic",
    enabled: true,
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "anthropic-secret",
    models: ["claude-test"],
  };
  let requestedUrl = "";
  let apiKey = "";
  const fetcher: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    apiKey = new Headers(init?.headers).get("x-api-key") ?? "";
    return new Response(JSON.stringify({ content: [{ text: "OK" }] }), {
      status: 200,
    });
  };

  const result = await testModelConnection(anthropic, "claude-test", fetcher);
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(apiKey, "anthropic-secret");
});

test("认证、限流与网络错误会返回可读结果", async () => {
  const unauthorized = await testModelConnection(
    provider,
    "deepseek-chat",
    async () =>
      new Response(JSON.stringify({ error: { message: "invalid key" } }), {
        status: 401,
      }),
  );
  assert.equal(unauthorized.reachable, true);
  assert.match(unauthorized.message, /认证失败/);

  const limited = await testModelConnection(
    provider,
    "deepseek-chat",
    async () => new Response("", { status: 429 }),
  );
  assert.equal(limited.reachable, true);
  assert.match(limited.message, /限流或额度不足/);

  const offline = await testModelConnection(
    provider,
    "deepseek-chat",
    async () => {
      throw new Error("connection refused");
    },
  );
  assert.equal(offline.reachable, false);
  assert.match(offline.message, /connection refused/);
});
