import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolCall } from "../core/types.js";
import { ConversationAgentModel } from "../model/agent-model.js";
import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import { AgentSession } from "../core/session.js";

class ScriptedClient implements ModelClient {
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
        text: "完成",
        toolCalls: [],
        usage: { input: 1, output: 1, cached: 0 },
      }
    );
  }
}

class DeferredClient implements ModelClient {
  readonly requests: CompletionRequest[] = [];
  readonly started: Promise<void>;
  readonly #responses: ModelResponse[];
  #resolveStarted: (() => void) | undefined;
  #releaseFirst: (() => void) | undefined;
  readonly #firstReleased: Promise<void>;

  constructor(responses: ModelResponse[]) {
    this.#responses = [...responses];
    this.started = new Promise<void>((resolve) => {
      this.#resolveStarted = resolve;
    });
    this.#firstReleased = new Promise<void>((resolve) => {
      this.#releaseFirst = resolve;
    });
  }

  releaseFirst(): void {
    this.#releaseFirst?.();
  }

  async complete(request: CompletionRequest): Promise<ModelResponse> {
    this.requests.push({
      ...request,
      messages: structuredClone(request.messages),
    });
    if (this.requests.length === 1) {
      this.#resolveStarted?.();
      await this.#firstReleased;
    }
    return (
      this.#responses.shift() ?? {
        text: "完成",
        toolCalls: [],
        usage: { input: 1, output: 1, cached: 0 },
      }
    );
  }
}

function response(text: string, toolCalls: ToolCall[] = []): ModelResponse {
  return {
    text,
    toolCalls,
    usage: { input: 10, output: 4, cached: 0 },
  };
}

test("Web 会话保留连续上下文并记录实时事件", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-web-session-"));
  const client = new ScriptedClient([
    response("第一轮完成"),
    response("第二轮完成"),
  ]);
  const session = new AgentSession({
    id: "web-test-1",
    title: "测试会话",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir: path.join(cwd, "state"),
  });

  await session.sendInput("第一条");
  await session.sendInput("继续");

  assert.equal(session.summary().status, "done");
  assert.equal(session.summary().totalInputTokens, 20);
  assert.equal(
    session.events().filter((event) => event.event.type === "user").length,
    2,
  );
  assert.equal(client.requests[1]?.messages.at(-1)?.role, "user");
  assert.equal(
    (client.requests[1]?.messages.at(-1) as { content: string }).content,
    "继续",
  );
});

test("Web 会话运行中接收软打断，并在当前轮结束后自动处理", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-web-queue-"));
  const client = new DeferredClient([
    response("第一轮完成"),
    response("补充要求完成"),
  ]);
  const session = new AgentSession({
    id: "web-test-queue",
    title: "软打断测试",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir: path.join(cwd, "state"),
  });

  const running = session.sendInput("第一条");
  await client.started;
  await session.sendInput("运行中补充");

  assert.equal(session.isProcessing(), true);
  assert.equal(client.requests.length, 1);
  assert.ok(
    session.events().some(
      (event) =>
        event.event.type === "user_queued" &&
        event.event.text === "运行中补充",
    ),
  );

  client.releaseFirst();
  await running;

  assert.equal(client.requests.length, 2);
  assert.equal(session.summary().status, "done");
  assert.equal(session.isProcessing(), false);
  assert.equal(client.requests[1]?.messages.at(-1)?.role, "user");
  assert.equal(
    (client.requests[1]?.messages.at(-1) as { content: string }).content,
    "运行中补充",
  );
});

test("strict Web 会话等待远程审批后继续", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-web-approval-"));
  const call: ToolCall = {
    id: "bash-approval",
    tool: "Bash",
    target: `${process.execPath} -e ok`,
    args: { command: `${process.execPath} -e "process.exit(0)"` },
  };
  const client = new ScriptedClient([
    response("需要运行验证。", [call]),
    response("验证完成。"),
  ]);
  const session = new AgentSession({
    id: "web-test-2",
    title: "审批测试",
    cwd,
    mode: "strict",
    model: new ConversationAgentModel(client, []),
    stateDir: path.join(cwd, "state"),
  });

  const approvalSeen = new Promise<void>((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.event.type === "ask_permission") {
        unsubscribe();
        resolve();
      }
    });
  });
  const running = session.sendInput("运行验证");
  await approvalSeen;
  assert.equal(session.summary().status, "waiting_permission");
  assert.equal(session.resolvePermission("bash-approval", true), true);
  await running;

  assert.equal(session.summary().status, "done");
  assert.ok(
    session.events().some((event) => event.event.type === "tool_result"),
  );
});

test("本次会话批准记忆会放行后续相同工具调用", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-approval-memory-"));
  const command = `${process.execPath} -e "process.exit(0)"`;
  const first: ToolCall = {
    id: "bash-first",
    tool: "Bash",
    target: command,
    args: { command },
  };
  const second: ToolCall = {
    ...first,
    id: "bash-second",
  };
  const client = new ScriptedClient([
    response("第一次验证。", [first]),
    response("再次验证。", [second]),
    response("全部完成。"),
  ]);
  const session = new AgentSession({
    id: "approval-memory",
    title: "批准记忆",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir: path.join(cwd, "state"),
    permissionRules: [],
  });
  let approvalCount = 0;
  const firstApproval = new Promise<void>((resolve) => {
    session.subscribe((event) => {
      if (event.event.type !== "ask_permission") return;
      approvalCount += 1;
      if (approvalCount === 1) resolve();
    });
  });

  const running = session.sendInput("运行两次验证");
  await firstApproval;
  assert.equal(
    session.resolvePermission("bash-first", {
      granted: true,
      scope: "session",
    }),
    true,
  );
  await running;

  assert.equal(approvalCount, 1);
  assert.equal(
    session.events().filter(
      (event) => event.event.type === "tool_result",
    ).length,
    2,
  );
});
