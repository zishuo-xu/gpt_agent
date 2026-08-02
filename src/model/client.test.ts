import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProviderConfig } from "../config/schema.js";
import { ConfiguredModelClient } from "./client.js";

function provider(
  protocol: ModelProviderConfig["protocol"],
): ModelProviderConfig {
  return {
    id: protocol === "anthropic" ? "anthropic" : "third-party",
    name: "Test Provider",
    enabled: true,
    protocol,
    baseUrl:
      protocol === "anthropic"
        ? "https://api.anthropic.com"
        : "https://api.example.com/v1",
    apiKey: "secret",
    models: ["test-model"],
  };
}

test("OpenAI-compatible 响应转换为统一工具调用", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    provider("openai-compatible"),
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "我先读取文件。",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "Read",
                      arguments: JSON.stringify({ file_path: "src/app.ts" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 15,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
        { status: 200 },
      );
    },
  );

  const result = await client.complete({
    system: "system",
    messages: [{ role: "user", content: "检查代码" }],
    signal: new AbortController().signal,
  });
  assert.equal(result.text, "我先读取文件。");
  assert.deepEqual(result.toolCalls[0], {
    id: "call-1",
    tool: "Read",
    target: "src/app.ts",
    args: { filePath: "src/app.ts" },
  });
  assert.deepEqual(result.usage, { input: 120, output: 15, cached: 40 });
  assert.deepEqual(
    requestBody.tools.map(
      (item: { function: { name: string } }) => item.function.name,
    ),
    [
      "Read",
      "Grep",
      "Glob",
      "TodoWrite",
      "Task",
      "Edit",
      "MultiEdit",
      "Write",
      "Bash",
    ],
  );
  assert.equal(requestBody.messages[0].role, "system");
});

test("Anthropic tool_use 与 tool_result 正确往返", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    provider("anthropic"),
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "修改文件。" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Edit",
              input: {
                file_path: "src/app.ts",
                old_string: "before",
                new_string: "after",
              },
            },
          ],
          usage: {
            input_tokens: 88,
            output_tokens: 19,
            cache_read_input_tokens: 12,
          },
        }),
        { status: 200 },
      );
    },
  );

  const result = await client.complete({
    system: "system",
    messages: [
      { role: "user", content: "修改" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read-1",
            tool: "Read",
            target: "src/app.ts",
            args: { filePath: "src/app.ts" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read-1",
        toolName: "Read",
        content: "file content",
        isError: false,
      },
    ],
    signal: new AbortController().signal,
  });

  assert.equal(result.toolCalls[0]?.tool, "Edit");
  assert.deepEqual(result.toolCalls[0]?.args, {
    filePath: "src/app.ts",
    oldString: "before",
    newString: "after",
  });
  assert.deepEqual(result.usage, { input: 88, output: 19, cached: 12 });
  assert.equal(requestBody.messages[2].role, "user");
  assert.equal(requestBody.messages[2].content[0].type, "tool_result");
  assert.equal(requestBody.tools[0].input_schema.type, "object");
});

test("模型误用 camelCase 键名时仍能解析，历史回传保持 wire 格式", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    provider("openai-compatible"),
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call-2",
                    type: "function",
                    function: {
                      name: "Read",
                      // 模型模仿历史键名后可能发出 camelCase
                      arguments: JSON.stringify({ filePath: "src/b.ts" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    },
  );

  const result = await client.complete({
    system: "system",
    messages: [
      { role: "user", content: "先读 a 再读 b" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            tool: "Read",
            target: "src/a.ts",
            args: { filePath: "src/a.ts", limit: 30 },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "Read",
        content: "content of a",
        isError: false,
      },
    ],
    signal: new AbortController().signal,
  });

  // camelCase 入参被容错解析
  assert.deepEqual(result.toolCalls[0]?.args, { filePath: "src/b.ts" });
  // 历史回传必须是 schema 声明的 wire 键名，防止模型模仿 camelCase
  const echoed = JSON.parse(
    requestBody.messages[2].tool_calls[0].function.arguments,
  );
  assert.deepEqual(echoed, { file_path: "src/a.ts", limit: 30 });
});

test("禁用供应商、缺少 Key 和未知模型会在请求前失败", () => {
  const disabled = provider("anthropic");
  disabled.enabled = false;
  assert.throws(
    () => new ConfiguredModelClient(disabled, "test-model"),
    /已禁用/,
  );

  const noKey = provider("anthropic");
  noKey.apiKey = "";
  assert.throws(
    () => new ConfiguredModelClient(noKey, "test-model"),
    /API Key/,
  );

  assert.throws(
    () => new ConfiguredModelClient(provider("anthropic"), "missing"),
    /不在供应商/,
  );
});
