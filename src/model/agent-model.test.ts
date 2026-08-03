import assert from "node:assert/strict";
import test from "node:test";
import { ConversationAgentModel } from "./agent-model.js";
import type {
  CompletionRequest,
  ConversationMessage,
  ModelClient,
  ModelResponse,
  StreamChunk,
} from "./types.js";

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
    keepRecentTurns: 1,
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
      content: `助手回答 ${index} ${"x".repeat(200)}`,
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
    keepRecentTurns: 2,
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
