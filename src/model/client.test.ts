import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProviderConfig } from "../config/schema.js";
import { pluginToolRegistry } from "../shared/plugin-tool.js";
import { ConfiguredModelClient } from "./client.js";
import {
  EXPLORE_TOOL_NAMES,
  toolDefinitionsFor,
} from "../tools/tool-definitions.js";

/** 测试缺省全量工具集（client 层已不再提供默认值，调用方显式传入） */
const ALL_TOOLS = toolDefinitionsFor(undefined);

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
    messages: [{ role: "user" as const, content: "检查代码" }],
    signal: new AbortController().signal,
    tools: ALL_TOOLS,
  });
  assert.equal(result.text, "我先读取文件。");
  assert.deepEqual(result.toolCalls[0], {
    id: "call-1",
    tool: "Read",
    target: "src/app.ts",
    args: { file_path: "src/app.ts" },
  });
  assert.deepEqual(result.usage, { input: 120, output: 15, cached: 40 });
  assert.deepEqual(
    requestBody.tools.map(
      (item: { function: { name: string } }) => item.function.name,
    ),
    [
      "AskUser",
      "Read",
      "Grep",
      "Glob",
      "TodoWrite",
      "Task",
      "Edit",
      "MultiEdit",
      "Write",
      "Bash",
      "BrowserCheck",
    ],
  );
  assert.equal(requestBody.messages[0].role, "system");
});

test("maxTokens 配置透传到请求（Anthropic + OpenAI 两协议）", async () => {
  let anthropicBody: Record<string, any> = {};
  let openaiBody: Record<string, any> = {};
  const anthropicClient = new ConfiguredModelClient(
    provider("anthropic"),
    "test-model",
    async (_input, init) => {
      anthropicBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    },
  );
  const openaiClient = new ConfiguredModelClient(
    provider("openai-compatible"),
    "test-model",
    async (_input, init) => {
      openaiBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: "ok", tool_calls: [] }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    },
  );
  const baseRequest = {
    system: "system",
    messages: [{ role: "user" as const, content: "问题" }],
    signal: new AbortController().signal,
    tools: [],
    maxTokens: 16_384,
  };
  await anthropicClient.complete(baseRequest);
  await openaiClient.complete(baseRequest);
  assert.equal(anthropicBody.max_tokens, 16384, "Anthropic max_tokens 透传");
  assert.equal(openaiBody.max_tokens, 16384, "OpenAI max_tokens 透传");

  // 未配置时用默认兜底 8192
  const { maxTokens: _omit, ...withoutMax } = baseRequest;
  await anthropicClient.complete(withoutMax);
  assert.equal(anthropicBody.max_tokens, 8192, "缺省 8192 兜底");
});

test("OpenAI-compatible 响应解析 finish_reason 为 stopReason", async () => {
  const client = new ConfiguredModelClient(
    provider("openai-compatible"),
    "test-model",
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "length",
              message: { content: "内容被输出长度截断" },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            prompt_tokens_details: {},
          },
        }),
        { status: 200 },
      ),
  );

  const result = await client.complete({
    system: "system",
    messages: [{ role: "user" as const, content: "检查代码" }],
    signal: new AbortController().signal,
    tools: ALL_TOOLS,
  });
  assert.equal(result.text, "内容被输出长度截断");
  assert.equal(result.stopReason, "length");
});

test("Anthropic 响应解析 stop_reason 为 stopReason", async () => {
  const client = new ConfiguredModelClient(
    provider("anthropic"),
    "test-model",
    async () =>
      new Response(
        JSON.stringify({
          stop_reason: "max_tokens",
          content: [{ type: "text", text: "内容被截断" }],
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        { status: 200 },
      ),
  );

  const result = await client.complete({
    system: "system",
    messages: [{ role: "user" as const, content: "检查代码" }],
    signal: new AbortController().signal,
    tools: ALL_TOOLS,
  });
  assert.equal(result.text, "内容被截断");
  assert.equal(result.stopReason, "max_tokens");
});

test("cacheRetention=none 时 Anthropic 请求省略 cache_control（摘要不写缓存）", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    provider("anthropic"),
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    },
  );
  const base = {
    system: "system",
    messages: [{ role: "user" as const, content: "检查代码" }],
    tools: ALL_TOOLS,
    signal: new AbortController().signal,
  };

  await client.complete({ ...base, cacheRetention: "none" });
  assert.equal(
    requestBody.system[0].cache_control,
    undefined,
    "none 时 system 不写缓存",
  );
  const lastTool = requestBody.tools.at(-1);
  assert.equal(lastTool.cache_control, undefined, "none 时工具定义不写缓存");

  await client.complete({ ...base });
  assert.deepEqual(requestBody.system[0].cache_control, {
    type: "ephemeral",
  });
  assert.deepEqual(requestBody.tools.at(-1).cache_control, {
    type: "ephemeral",
  });
});

test("Anthropic 消息级缓存断点：首条（非末尾）user 消息标记，前缀可缓存", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    provider("anthropic"),
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
        { status: 200 },
      );
    },
  );
  const base = {
    system: "system",
    messages: [
      { role: "user" as const, content: "第一轮" },
      { role: "assistant" as const, content: "回答", toolCalls: [] },
      { role: "user" as const, content: "第二轮" },
    ],
    tools: ALL_TOOLS,
    signal: new AbortController().signal,
  };

  await client.complete({ ...base });
  assert.deepEqual(
    requestBody.messages[0].cache_control,
    { type: "ephemeral" },
    "首条 user 消息应带断点",
  );
  assert.equal(
    requestBody.messages[1].cache_control,
    undefined,
    "assistant 消息不带断点",
  );
  assert.equal(
    requestBody.messages[2].cache_control,
    undefined,
    "末尾 user 消息不带断点（Anthropic 禁止在最后一条消息上放断点）",
  );

  // 单消息（首条即末尾）不加断点
  await client.complete({
    ...base,
    messages: [{ role: "user" as const, content: "单轮" }],
  });
  assert.equal(
    requestBody.messages[0].cache_control,
    undefined,
    "唯一 user 消息是末尾消息，不加断点",
  );

  // cacheRetention=none 时无消息级断点
  await client.complete({ ...base, cacheRetention: "none" });
  for (const message of requestBody.messages) {
    assert.equal(
      message.cache_control,
      undefined,
      "none 时消息不带 cache_control",
    );
  }
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
      { role: "user" as const, content: "修改" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read-1",
            tool: "Read",
            target: "src/app.ts",
            args: { file_path: "src/app.ts" },
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
    tools: ALL_TOOLS,
  });

  assert.equal(result.toolCalls[0]?.tool, "Edit");
  assert.deepEqual(result.toolCalls[0]?.args, {
    file_path: "src/app.ts",
    old_string: "before",
    new_string: "after",
  });
  assert.deepEqual(result.usage, { input: 88, output: 19, cached: 12 });
  assert.equal(requestBody.messages[2].role, "user");
  assert.equal(requestBody.messages[2].content[0].type, "tool_result");
  assert.equal(requestBody.tools[0].input_schema.type, "object");
});

test("模型参数原样透传，客户端不做键名转换（校验交给工具层 schema）", async () => {
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
                      // 模型可能发出任意键名，客户端不归一化
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
      { role: "user" as const, content: "先读 a 再读 b" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            tool: "Read",
            target: "src/a.ts",
            args: { file_path: "src/a.ts", limit: 30 },
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
    tools: ALL_TOOLS,
  });

  // 入参原样透传（camelCase 键合法性由工具层 schema 校验拒绝，客户端不转换）
  assert.deepEqual(result.toolCalls[0]?.args, { filePath: "src/b.ts" });
  // 历史回传同样原样（不经过任何键名转换）
  const echoed = JSON.parse(
    requestBody.messages[2].tool_calls[0].function.arguments,
  );
  assert.deepEqual(echoed, { file_path: "src/a.ts", limit: 30 });
});

test("请求级 tools 子集：只注入指定工具（OpenAI）", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    provider("openai-compatible"),
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok", tool_calls: [] } }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
        { status: 200 },
      );
    },
  );

  await client.complete({
    system: "system",
    messages: [{ role: "user" as const, content: "探索" }],
    signal: new AbortController().signal,
    tools: toolDefinitionsFor(EXPLORE_TOOL_NAMES),
  });
  assert.deepEqual(
    requestBody.tools.map(
      (item: { function: { name: string } }) => item.function.name,
    ),
    ["Read", "Grep", "Glob", "TodoWrite"],
  );
});

test("请求级 tools 空数组：Anthropic 请求不带任何工具定义", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    provider("anthropic"),
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    },
  );

  await client.complete({
    system: "system",
    messages: [{ role: "user" as const, content: "压缩" }],
    signal: new AbortController().signal,
    tools: [],
  });
  assert.deepEqual(requestBody.tools, []);
});

function sseBody(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

test("OpenAI 流式响应逐段推送 text_delta 并累积分片工具调用", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    provider("openai-compatible"),
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(sseBody([
        // 第一片：内容 + 工具调用开始（id/name/首段 arguments）
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                content: "我先",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "Read",
                      arguments: '{"file',
                    },
                  },
                ],
              },
            },
          ],
        }),
        // 第二片：内容继续 + 工具调用参数续片
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                content: "读取文件。",
                tool_calls: [
                  { index: 0, function: { arguments: '_path": "src/app.ts"}' } },
                ],
              },
            },
          ],
        }),
        // 第三片：usage + finish_reason（OpenAI 在最后一片的 choices 上带出）
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "length" }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        }),
      ]))
    },
  );

  const chunks: string[] = [];
  let done: { text: string; toolCalls: any[]; usage: any; stopReason?: string } | undefined;
  for await (const chunk of client.stream({
    system: "system",
    messages: [{ role: "user" as const, content: "读文件" }],
    signal: new AbortController().signal,
    tools: ALL_TOOLS,
  })) {
    if (chunk.type === "text_delta") {
      chunks.push(chunk.text);
    } else if (chunk.type === "done") {
      done = chunk.response;
    }
  }

  assert.equal(requestBody.stream, true);
  assert.deepEqual(chunks, ["我先", "读取文件。"]);
  assert.equal(done?.text, "我先读取文件。");
  assert.deepEqual(done?.toolCalls, [
    {
      id: "call-1",
      tool: "Read",
      target: "src/app.ts",
      args: { file_path: "src/app.ts" },
    },
  ]);
  assert.deepEqual(done?.usage, { input: 100, output: 30, cached: 20 });
  assert.equal(done?.stopReason, "length");
});

test("Anthropic 流式响应解析 content_block 事件并累积 input_json_delta", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    provider("anthropic"),
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(sseBody([
        JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 50, cache_read_input_tokens: 10 } },
        }),
        JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "正在" },
        }),
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "修改。" },
        }),
        JSON.stringify({ type: "content_block_stop", index: 0 }),
        JSON.stringify({
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Edit",
            input: {},
          },
        }),
        JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"file_path": "src/app.ts", "old_str',
          },
        }),
        JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: 'ing": "a", "new_string": "b"}',
          },
        }),
        JSON.stringify({ type: "content_block_stop", index: 1 }),
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 25 },
        }),
        JSON.stringify({ type: "message_stop" }),
      ]))
    },
  );

  const chunks: string[] = [];
  let done: { text: string; toolCalls: any[]; usage: any; stopReason?: string } | undefined;
  for await (const chunk of client.stream({
    system: "system",
    messages: [{ role: "user" as const, content: "改文件" }],
    signal: new AbortController().signal,
    tools: ALL_TOOLS,
  })) {
    if (chunk.type === "text_delta") {
      chunks.push(chunk.text);
    } else if (chunk.type === "done") {
      done = chunk.response;
    }
  }

  assert.equal(requestBody.stream, true);
  assert.deepEqual(chunks, ["正在", "修改。"]);
  assert.equal(done?.text, "正在修改。");
  assert.deepEqual(done?.toolCalls, [
    {
      id: "tool-1",
      tool: "Edit",
      target: "src/app.ts",
      args: { file_path: "src/app.ts", old_string: "a", new_string: "b" },
    },
  ]);
  assert.deepEqual(done?.usage, { input: 50, output: 25, cached: 10 });
  assert.equal(done?.stopReason, "tool_use");
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

test("已注册的插件工具名通过运行时守卫（openai-compatible 响应）", async () => {
  pluginToolRegistry.register({
    name: "WebFetch",
    description: "抓取网页",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
    async run() {
      return { summary: "ok" };
    },
  });
  try {
    const client = new ConfiguredModelClient(
      provider("openai-compatible"),
      "test-model",
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-wf",
                      type: "function",
                      function: {
                        name: "WebFetch",
                        arguments: JSON.stringify({ url: "https://example.com" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        ),
    );
    const response = await client.complete({
      system: "",
      messages: [],
      tools: ALL_TOOLS,
      signal: new AbortController().signal,
    });
    assert.equal(response.toolCalls[0]?.tool, "WebFetch");
    assert.equal(response.toolCalls[0]?.target, "https://example.com");
  } finally {
    pluginToolRegistry.clear();
  }
});

test("插件工具 target 取 query 主参（搜索类工具）", async () => {
  pluginToolRegistry.register({
    name: "WebSearch",
    description: "搜索",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    async run() {
      return { summary: "ok" };
    },
  });
  try {
    const client = new ConfiguredModelClient(
      provider("openai-compatible"),
      "test-model",
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-s",
                      type: "function",
                      function: {
                        name: "WebSearch",
                        arguments: JSON.stringify({ query: "Rust 2024 edition" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        ),
    );
    const response = await client.complete({
      system: "",
      messages: [],
      tools: ALL_TOOLS,
      signal: new AbortController().signal,
    });
    assert.equal(response.toolCalls[0]?.tool, "WebSearch");
    assert.equal(response.toolCalls[0]?.target, "Rust 2024 edition");
  } finally {
    pluginToolRegistry.clear();
  }
});

test("Anthropic thinking：开启时请求含 thinking 参数，响应解析 thinking 块", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    { ...provider("anthropic"), thinking: true, thinkingBudgetTokens: 4096 },
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "推理第一段" },
            { type: "text", text: "最终答案" },
            { type: "tool_use", id: "tu_1", name: "Read", input: {} },
          ],
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        { status: 200 },
      );
    },
  );

  const result = await client.complete({
    system: "system",
    messages: [{ role: "user" as const, content: "问题" }],
    signal: new AbortController().signal,
    tools: [],
  });
  assert.deepEqual(requestBody.thinking, {
    type: "enabled",
    budget_tokens: 4096,
  }, "请求携带 thinking 参数与自定义预算");
  assert.equal(result.thinking, "推理第一段", "thinking 块解析为 thinking 字段");
  assert.equal(result.text, "最终答案", "text 块不受影响");
  assert.equal(result.toolCalls.length, 1);
});

test("Anthropic thinking：显式关闭时请求不含 thinking 参数，历史 thinking 降级为文本", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    { ...provider("anthropic"), thinking: false },
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    },
  );

  await client.complete({
    system: "system",
    messages: [
      {
        role: "assistant",
        content: "回答",
        toolCalls: [],
        thinking: "历史推理内容",
      },
    ],
    signal: new AbortController().signal,
    tools: [],
  });
  assert.equal(requestBody.thinking, undefined, "显式关闭时请求不含 thinking 参数");
  const assistant = requestBody.messages[0];
  assert.deepEqual(
    assistant.content,
    [{ type: "text", text: "[思考过程]\n历史推理内容\n\n回答" }],
    "历史 thinking 降级为 text 块",
  );
});

test("Anthropic thinking：开启时历史 thinking 保留为 thinking 块", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    { ...provider("anthropic"), thinking: true },
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    },
  );

  await client.complete({
    system: "system",
    messages: [
      {
        role: "assistant",
        content: "回答",
        toolCalls: [],
        thinking: "推理过程",
      },
    ],
    signal: new AbortController().signal,
    tools: [],
  });
  const assistant = requestBody.messages[0];
  assert.deepEqual(
    assistant.content,
    [
      { type: "thinking", thinking: "推理过程" },
      { type: "text", text: "回答" },
    ],
    "开启时历史 thinking 保留为 thinking 块",
  );
});

test("OpenAI：reasoning_content 解析为 thinking；历史 thinking 降级为文本前缀", async () => {
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
                content: "最终回答",
                reasoning_content: "推理过程",
                tool_calls: [],
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    },
  );

  const result = await client.complete({
    system: "system",
    messages: [{ role: "user" as const, content: "问题" }],
    signal: new AbortController().signal,
    tools: [],
  });
  assert.equal(result.thinking, "推理过程", "reasoning_content 解析为 thinking");

  // 历史 thinking 在 OpenAI 侧降级为文本前缀
  await client.complete({
    system: "system",
    messages: [
      { role: "assistant", content: "答", toolCalls: [], thinking: "想" },
    ],
    signal: new AbortController().signal,
    tools: [],
  });
  assert.equal(
    requestBody.messages[1].content,
    "[思考过程]\n想\n\n答",
    "OpenAI 历史 thinking 降级为 content 前缀",
  );
});

test("Anthropic 流式：thinking_delta 累积为 thinking", async () => {
  const client = new ConfiguredModelClient(
    { ...provider("anthropic"), thinking: true },
    "test-model",
    async () =>
      new Response(
        [
          `data: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":1}}}`,
          `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
          `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"推理中"}}`,
          `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"继续推理"}}`,
          `data: {"type":"content_block_stop","index":0}`,
          `data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
          `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答案"}}`,
          `data: {"type":"content_block_stop","index":1}`,
          `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}`,
          `data: {"type":"message_stop"}`,
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );

  const chunks: string[] = [];
  const thinkingChunks: string[] = [];
  let finalResponse: any;
  for await (const chunk of client.stream!({
    system: "system",
    messages: [{ role: "user" as const, content: "问题" }],
    signal: new AbortController().signal,
    tools: [],
  })) {
    if (chunk.type === "text_delta") chunks.push(chunk.text);
    else if (chunk.type === "thinking_delta") thinkingChunks.push(chunk.text);
    else finalResponse = chunk.response;
  }
  assert.deepEqual(chunks, ["答案"], "流式只推送 text_delta");
  assert.deepEqual(
    thinkingChunks,
    ["推理中", "继续推理"],
    "thinking_delta 应实时逐块推送",
  );
  assert.equal(finalResponse.thinking, "推理中继续推理", "thinking_delta 累积");
  assert.equal(finalResponse.text, "答案");
});

test("OpenAI 流式：reasoning_content 增量实时推送为 thinking_delta", async () => {
  const client = new ConfiguredModelClient(
    provider("openai-compatible"),
    "test-model",
    async () =>
      new Response(
        [
          `data: {"choices":[{"delta":{"reasoning_content":"先"}}]}`,
          `data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}`,
          `data: {"choices":[{"delta":{"content":"答案"},"finish_reason":"stop"}]}`,
          `data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":0}}}`,
          `data: [DONE]`,
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );

  const chunks: string[] = [];
  const thinkingChunks: string[] = [];
  let finalResponse: any;
  for await (const chunk of client.stream!({
    system: "system",
    messages: [{ role: "user" as const, content: "问题" }],
    signal: new AbortController().signal,
    tools: [],
  })) {
    if (chunk.type === "text_delta") chunks.push(chunk.text);
    else if (chunk.type === "thinking_delta") thinkingChunks.push(chunk.text);
    else finalResponse = chunk.response;
  }
  assert.deepEqual(chunks, ["答案"]);
  assert.deepEqual(thinkingChunks, ["先", "思考"], "reasoning_content 增量实时推送");
  assert.equal(finalResponse.thinking, "先思考", "增量累积为 thinking");
});

test("Anthropic thinking：默认开启（未显式配置即携带 thinking 参数）", async () => {
  let requestBody: Record<string, any> = {};
  const client = new ConfiguredModelClient(
    provider("anthropic"), // 未设置 thinking 字段 → 默认开启
    "test-model",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200 },
      );
    },
  );
  await client.complete({
    system: "system",
    messages: [{ role: "user" as const, content: "hi" }],
    signal: new AbortController().signal,
    tools: [],
  });
  assert.deepEqual(requestBody.thinking, { type: "enabled", budget_tokens: 2048 }, "默认开启携带 thinking 参数");
});

test("Anthropic thinking：模型不支持（400 含 thinking）自动降级不带 thinking 重试", async () => {
  let calls = 0;
  const client = new ConfiguredModelClient(
    provider("anthropic"), // 默认开启
    "test-model",
    async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (calls === 1 && body.thinking) {
        return new Response(
          JSON.stringify({ error: { message: "This model does not support the thinking parameter" } }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200 },
      );
    },
  );
  const result = await client.complete({
    system: "system",
    messages: [{ role: "user" as const, content: "hi" }],
    signal: new AbortController().signal,
    tools: [],
  });
  assert.equal(result.text, "ok");
  assert.equal(calls, 2, "第一次带 thinking 400，第二次降级重试成功");
});

test("Anthropic thinking：非 thinking 相关 400 不降级重试", async () => {
  let calls = 0;
  const client = new ConfiguredModelClient(
    provider("anthropic"),
    "test-model",
    async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ error: { message: "Invalid model name" } }),
        { status: 400 },
      );
    },
  );
  await assert.rejects(
    client.complete({
      system: "system",
      messages: [{ role: "user" as const, content: "hi" }],
      signal: new AbortController().signal,
      tools: [],
    }),
    (error: unknown) => error instanceof Error && /Invalid model name/.test(error.message),
  );
  assert.equal(calls, 1, "非 thinking 错误只请求一次");
});

test("Anthropic 流式：模型不支持 thinking（400 含 thinking）降级重试不重复输出", async () => {
  let calls = 0;
  const client = new ConfiguredModelClient(
    provider("anthropic"), // 默认开启
    "test-model",
    async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (calls === 1 && body.thinking) {
        return new Response(
          JSON.stringify({ error: { message: "thinking blocks are not supported by this model" } }),
          { status: 400 },
        );
      }
      return new Response(
        [
          `data: {"type":"message_start","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":0}}}`,
          `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
          `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"降级回答"}}`,
          `data: {"type":"content_block_stop","index":0}`,
          `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
          `data: {"type":"message_stop"}`,
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  );

  const chunks: string[] = [];
  let finalResponse: any;
  for await (const chunk of client.stream!({
    system: "system",
    messages: [{ role: "user" as const, content: "hi" }],
    signal: new AbortController().signal,
    tools: [],
  })) {
    if (chunk.type === "text_delta") chunks.push(chunk.text);
    else if (chunk.type === "done") finalResponse = chunk.response;
  }
  assert.equal(calls, 2, "第一次带 thinking 400，第二次降级重试");
  assert.deepEqual(chunks, ["降级回答"], "降级后不重复输出");
  assert.equal(finalResponse.text, "降级回答");
});
