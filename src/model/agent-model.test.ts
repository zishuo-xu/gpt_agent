import assert from "node:assert/strict";
import test from "node:test";
import { ConversationAgentModel } from "./agent-model.js";
import type {
  CompletionRequest,
  ConversationMessage,
  ModelClient,
  ModelResponse,
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
