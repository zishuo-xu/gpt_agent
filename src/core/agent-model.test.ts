import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCall, ToolExecutionResult } from "./types.js";
import {
  buildSystemPrompt,
  ConversationAgentModel,
  findCompactionCutPoint,
  sanitizeMessages,
} from "./agent-model.js";
import { EXPLORE_TOOL_NAMES } from "../tools/tool-definitions.js";
import type {
  CompletionRequest,
  ConversationMessage,
  ModelClient,
  ModelResponse,
  StreamChunk,
} from "../model/types.js";

class CapturingClient implements ModelClient {
  readonly requests: CompletionRequest[] = [];
  readonly #responses: ModelResponse[];

  constructor(responses: ModelResponse[]) {
    this.#responses = [...responses];
  }

  async complete(request: CompletionRequest): Promise<ModelResponse> {
    this.requests.push({
      ...request,
      messages: structuredClone(request.messages),
    });
    return (
      this.#responses.shift() ?? {
        text: "ok",
        toolCalls: [],
        usage: { input: 1, output: 1, cached: 0 },
      }
    );
  }
}

class StreamingClient implements ModelClient {
  readonly #chunks: StreamChunk[];

  constructor(chunks: StreamChunk[]) {
    this.#chunks = [...chunks];
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamChunk> {
    for (const chunk of this.#chunks) {
      yield chunk;
    }
  }

  async complete(): Promise<ModelResponse> {
    throw new Error("流式客户端不应被调用 complete");
  }
}

function response(
  text: string,
  input = 10,
  output = 3,
): ModelResponse {
  return {
    text,
    toolCalls: [],
    usage: { input, output, cached: 1 },
  };
}

test("next() 透传 stopReason 到 ModelTurn", async () => {
  const client = new CapturingClient([
    {
      text: "内容被输出长度截断",
      toolCalls: [],
      usage: { input: 10, output: 3, cached: 1 },
      stopReason: "max_tokens",
    },
  ]);
  const model = new ConversationAgentModel(client, []);
  const turn = await model.next(new AbortController().signal);
  assert.equal(turn.text, "内容被输出长度截断");
  assert.equal(turn.stopReason, "max_tokens");
});

test("配置 onTextDelta 后走流式路径并逐段回调", async () => {
  const streamClient = new StreamingClient([
    { type: "text_delta", text: "你好" },
    { type: "text_delta", text: "，世界" },
    {
      type: "done",
      response: {
        text: "你好，世界",
        toolCalls: [],
        usage: { input: 5, output: 2, cached: 0 },
      },
    },
  ]);
  const model = new ConversationAgentModel(streamClient, "问题");
  const deltas: string[] = [];
  model.onTextDelta = (text) => deltas.push(text);

  const turn = await model.next(new AbortController().signal);

  assert.deepEqual(deltas, ["你好", "，世界"], "每段增量都应回调");
  assert.equal(turn.text, "你好，世界");
  assert.equal(turn.done, true);
});

test("流式响应缺少 done 时抛错", async () => {
  const streamClient = new StreamingClient([
    { type: "text_delta", text: "只来了第一段" },
  ]);
  const model = new ConversationAgentModel(streamClient, "问题");
  model.onTextDelta = () => undefined;

  await assert.rejects(
    model.next(new AbortController().signal),
    /流式响应未正常结束/,
  );
});

test("setClient 替换主客户端后新请求走新客户端", async () => {
  const first = new CapturingClient([response("第一轮回答")]);
  const second = new CapturingClient([response("第二轮回答")]);
  const model = new ConversationAgentModel(first, "初始问题");
  await model.next(new AbortController().signal);
  assert.equal(first.requests.length, 1);

  model.setClient(second);
  await model.next(new AbortController().signal);
  assert.equal(first.requests.length, 1, "旧客户端不应再收到请求");
  assert.equal(second.requests.length, 1, "新客户端应接手后续请求");
});

test("setCompactionClient 替换压缩客户端", async () => {
  const history: ConversationMessage[] = [];
  for (let index = 1; index <= 5; index += 1) {
    history.push({ role: "user", content: `用户问题 ${index}` });
    history.push({
      role: "assistant",
      content: `助手回答 ${index} ${"x".repeat(200)}`,
      toolCalls: [],
    });
  }
  const cheapFirst = new CapturingClient([
    response("旧压缩客户端摘要：完成", 40, 12),
  ]);
  const cheapSecond = new CapturingClient([
    response("新压缩客户端摘要：完成", 40, 12),
  ]);
  const model = new ConversationAgentModel(
    new CapturingClient([response("继续")]),
    history,
  );
  model.configureCompaction({
    client: cheapFirst,
    thresholdTokens: 100,
    keepRecentTokens: 100,
    onCompacted: () => undefined,
  });
  await model.compact(new AbortController().signal, true);
  assert.equal(cheapFirst.requests.length, 1);

  model.setCompactionClient(cheapSecond);
  await model.compact(new AbortController().signal, true);
  assert.equal(cheapFirst.requests.length, 1, "旧压缩客户端不应再被调用");
  assert.equal(cheapSecond.requests.length, 1);
});

test("硬压缩使用 cheap 模型摘要并保留最近对话", async () => {
  const history: ConversationMessage[] = [];
  for (let index = 1; index <= 5; index += 1) {
    history.push({ role: "user", content: `用户问题 ${index}` });
    history.push({
      role: "assistant",
      content: `助手回答 ${index} ${"x".repeat(1000)}`,
      toolCalls: [],
    });
  }
  const main = new CapturingClient([response("继续完成")]);
  const cheap = new CapturingClient([
    response(
      "Task goal: 修复问题\nCompleted changes: 已完成前三轮\nCurrent todo: 继续验证",
      40,
      12,
    ),
  ]);
  const model = new ConversationAgentModel(main, history);
  let compacted:
    | {
        summary: string;
        ratio: number;
        usage: { input: number; output: number; cached: number };
      }
    | undefined;
  model.configureCompaction({
    client: cheap,
    thresholdTokens: 1,
    // 每轮 ≈ 260+ tokens：预算 400 恰好保留最近 2 轮（4 个 user 消息中的后 2 个）
    keepRecentTokens: 400,
    onCompacted: (result) => {
      compacted = result;
    },
  });

  await model.next(new AbortController().signal);

  assert.equal(cheap.requests.length, 1);
  assert.match(compacted?.summary ?? "", /Task goal/);
  assert.ok((compacted?.ratio ?? 1) < 1);
  assert.match(
    (main.requests[0]?.messages[0] as { content: string }).content,
    /会话压缩摘要/,
  );
  assert.equal(
    main.requests[0]?.messages.filter(
      (message) =>
        message.role === "user" &&
        message.content.startsWith("用户问题"),
    ).length,
    2,
  );
});

test("buildSystemPrompt 默认输出与历史全量指南逐字一致", () => {
  const prompt = buildSystemPrompt(undefined);
  assert.ok(
    prompt.includes(
      "Use Grep and Glob to locate relevant code before broad reading. " +
        "For tasks with roughly three or more steps, call TodoWrite first " +
        "and keep exactly one item in_progress until the work is complete.",
    ),
    "Grep+Todo 指南应保持原合并段落",
  );
  assert.ok(prompt.includes("Use Task for broad repository exploration"));
  assert.ok(prompt.includes("The Bash tool runs in the project root"));
  assert.ok(prompt.includes("persist one concise dated entry under .myagent/memory/"));
});

test("buildSystemPrompt 体积守护：全量注入时估算 < 1000 tokens（Pi 原则）", () => {
  const prompt = buildSystemPrompt(undefined);
  // 与估计 message token 同源的口径：JSON 长度 / 4（中文占比高时偏保守）
  const estimatedTokens = Math.ceil(JSON.stringify(prompt).length / 4);
  assert.ok(
    estimatedTokens < 1000,
    `system prompt 估算 ${estimatedTokens} tokens 应 < 1000（膨胀会稀释上下文预算并破坏缓存前缀收益）`,
  );
  // 裁剪版（只读子代理）更小
  const readOnlyPrompt = buildSystemPrompt(EXPLORE_TOOL_NAMES);
  assert.ok(
    Math.ceil(JSON.stringify(readOnlyPrompt).length / 4) <
      estimatedTokens,
    "只读裁剪版应小于全量版",
  );
});

test("只读子代理工具集：请求只带探索工具，system 裁剪 Task/Bash 指南", async () => {
  const client = new CapturingClient([response("结论：…")]);
  const model = new ConversationAgentModel(
    client,
    "探索这个仓库",
    undefined,
    { toolNames: EXPLORE_TOOL_NAMES },
  );
  await model.next(new AbortController().signal);
  const request = client.requests[0]!;
  assert.deepEqual(
    request.tools?.map((tool) => tool.name),
    ["Read", "Grep", "Glob", "TodoWrite"],
    "只读子代理不应注入写工具与 Task",
  );
  assert.ok(!request.system.includes("Use Task for broad"), "无 Task 指南");
  assert.ok(!request.system.includes("The Bash tool runs"), "无 Bash 指南");
  assert.ok(request.system.includes("Use Grep and Glob"), "保留导航指南");
});

test("压缩请求不携带工具 schema", async () => {
  const history: ConversationMessage[] = [];
  for (let index = 1; index <= 5; index += 1) {
    history.push({ role: "user", content: `用户问题 ${index}` });
    history.push({
      role: "assistant",
      content: `助手回答 ${index} ${"x".repeat(200)}`,
      toolCalls: [],
    });
  }
  const cheap = new CapturingClient([
    response("Task goal: 修复问题", 40, 12),
  ]);
  const model = new ConversationAgentModel(
    new CapturingClient([response("继续")]),
    history,
  );
  model.configureCompaction({
    client: cheap,
    thresholdTokens: 1,
    keepRecentTokens: 100,
    onCompacted: () => undefined,
  });
  await model.next(new AbortController().signal);
  assert.deepEqual(cheap.requests[0]?.tools, [], "压缩请求不应携带工具");
});

test("工具结果 details 供事件层透传，不进入模型上下文", async () => {
  const call: ToolCall = {
    id: "bash-1",
    tool: "Bash",
    target: "echo hi",
    args: { command: "echo hi" },
  };
  const client = new CapturingClient([
    {
      text: "",
      toolCalls: [call],
      usage: { input: 4, output: 2, cached: 0 },
    },
    response("收尾"),
  ]);
  const model = new ConversationAgentModel(client, "跑个命令");
  await model.next(new AbortController().signal);

  const result: ToolExecutionResult = {
    summary: "退出码 0",
    output: "hi",
    details: {
      command: "echo hi",
      durationMs: 12,
      code: 0,
      marker: "DETAILS_ONLY_FOR_UI",
    },
  };
  model.acceptToolResult(call, result, false);
  await model.next(new AbortController().signal);

  const toolMessage = client.requests[1]?.messages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  const serialized = JSON.stringify(toolMessage);
  assert.ok(
    !serialized.includes("DETAILS_ONLY_FOR_UI"),
    "details 不应进入模型上下文",
  );
  assert.ok(
    !serialized.includes("durationMs"),
    "耗时等执行元数据不应进入模型上下文",
  );
  assert.ok(serialized.includes("hi"), "output 应正常回灌模型");
  assert.ok(serialized.includes("退出码 0"), "summary 应正常回灌模型");
});

test("压缩切点按 token 预算并保持轮次完整（tool 不与其 assistant 拆开）", () => {
  const messages: ConversationMessage[] = [
    { role: "user", content: "u1" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "t1", tool: "Read", target: "a.ts", args: { filePath: "a.ts" } },
      ],
    },
    {
      role: "tool",
      toolCallId: "t1",
      toolName: "Read",
      target: "a.ts",
      content: "r1",
    },
    { role: "user", content: "u2" },
    { role: "assistant", content: `a2 ${"x".repeat(2000)}`, toolCalls: [] },
    { role: "user", content: "u3" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "t3", tool: "Bash", target: "ls", args: { command: "ls" } },
      ],
    },
    {
      role: "tool",
      toolCallId: "t3",
      toolName: "Bash",
      target: "ls",
      content: "r3",
    },
  ];
  // 预算穿越第二轮（大消息）：切点必须回退到 u2，recent 从轮次起点开始
  const cut = findCompactionCutPoint(messages, 300);
  assert.ok(cut !== null);
  assert.equal(messages[cut]!.role, "user");
  assert.equal(messages[cut]!.content, "u2");
});

test("会话小于保留预算或无可压缩时返回 null", () => {
  const small: ConversationMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", toolCalls: [] },
  ];
  assert.equal(findCompactionCutPoint(small, 100_000), null);
  assert.equal(findCompactionCutPoint([], 100), null);
  assert.equal(
    findCompactionCutPoint([{ role: "user", content: "only" }], 10),
    null,
  );
  // 切点回退到头部（摘要消息本身）时不可压缩
  const summaryOnly: ConversationMessage[] = [
    { role: "user", content: "[会话压缩摘要] old" },
    { role: "assistant", content: "a", toolCalls: [] },
  ];
  assert.equal(findCompactionCutPoint(summaryOnly, 10), null);
});

test("sanitizeMessages：不合规 toolCallId 重写为 Anthropic 合规格式且映射一致", () => {
  const messages: ConversationMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_abc.def!xyz",
          tool: "Read",
          target: "a.ts",
          args: { filePath: "a.ts" },
        },
        { id: "ok_id_123", tool: "Bash", target: "ls", args: { command: "ls" } },
      ],
    },
    {
      role: "tool",
      toolCallId: "call_abc.def!xyz",
      toolName: "Read",
      target: "a.ts",
      content: "内容",
    },
    {
      role: "tool",
      toolCallId: "ok_id_123",
      toolName: "Bash",
      target: "ls",
      content: "内容2",
    },
  ];
  const sanitized = sanitizeMessages(messages);
  const assistant = sanitized[0] as Extract<ConversationMessage, { role: "assistant" }>;
  const rewritten = assistant.toolCalls.find(
    (call) => call.target === "a.ts",
  )!;
  assert.match(rewritten.id, /^[a-zA-Z0-9_-]{1,64}$/, "重写后必须合规");
  assert.notEqual(rewritten.id, "call_abc.def!xyz", "不合规 id 必须被重写");
  const okCall = assistant.toolCalls.find((call) => call.target === "ls")!;
  assert.equal(okCall.id, "ok_id_123", "已合规 id 保持不变");
  const tool = sanitized.find(
    (message) =>
      message.role === "tool" &&
      (message as Extract<ConversationMessage, { role: "tool" }>).target === "a.ts",
  ) as Extract<ConversationMessage, { role: "tool" }>;
  assert.equal(tool.toolCallId, rewritten.id, "tool 消息的 toolCallId 同步重写");
  // 原消息不被修改（不可变）
  const original = messages[0] as Extract<ConversationMessage, { role: "assistant" }>;
  assert.equal(original.toolCalls[0]!.id, "call_abc.def!xyz");
});

test("sanitizeMessages：空 content 的 tool 消息补占位", () => {
  const messages: ConversationMessage[] = [
    {
      role: "tool",
      toolCallId: "t1",
      toolName: "Bash",
      target: "ls",
      content: "",
    },
    {
      role: "tool",
      toolCallId: "t2",
      toolName: "Read",
      target: "a.ts",
      content: "正常内容",
    },
  ];
  const sanitized = sanitizeMessages(messages);
  assert.equal(
    (sanitized[0] as Extract<ConversationMessage, { role: "tool" }>).content,
    "No result provided",
  );
  assert.equal(
    (sanitized[1] as Extract<ConversationMessage, { role: "tool" }>).content,
    "正常内容",
    "非空内容不受影响",
  );
});
