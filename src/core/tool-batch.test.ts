import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolExecutor } from "../tools/executor.js";
import { AgentEventBus } from "./events.js";
import {
  emitDeniedTool,
  emitToolResult,
  executeTool,
  type ToolTraceItem,
} from "./tool-batch.js";
import type { AgentModel, ModelTurn } from "./agent-loop.js";
import type {
  AgentEvent,
  ToolCall,
  ToolExecutionResult,
} from "./types.js";

/** 记录 acceptToolDenied / acceptToolResult 回灌的最小模型 mock */
class RecordModel implements AgentModel {
  readonly denied: Array<{ call: ToolCall; reason: string }> = [];
  readonly results: Array<{ call: ToolCall; isError: boolean }> = [];

  async next(): Promise<ModelTurn> {
    return { done: true };
  }

  acceptToolDenied(call: ToolCall, reason: string): void {
    this.denied.push({ call, reason });
  }

  acceptToolResult(
    call: ToolCall,
    _result: ToolExecutionResult,
    isError = false,
  ): void {
    this.results.push({ call, isError });
  }
}

function toolCall(
  id: string,
  tool: ToolCall["tool"],
  target: string,
  args: unknown = {},
): ToolCall {
  return { id, tool, target, args };
}

/** 抛错执行器 stub（executeTool 异常归一用） */
const failingExecutor = {
  async execute(_call: ToolCall): Promise<ToolExecutionResult> {
    throw new Error("模拟执行失败");
  },
} as unknown as ToolExecutor;

test("emitDeniedTool：permission_denied 事件 + 拒绝回灌 + trace 记录", () => {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new RecordModel();
  const trace: ToolTraceItem[] = [];
  const call = toolCall("c1", "Bash", "rm -rf x");

  emitDeniedTool(bus, model, trace, {
    call,
    reason: "命中 deny 规则",
    permission: "deny",
    ms: 3,
  });

  const denied = events.find((event) => event.type === "permission_denied");
  assert.equal(denied?.type, "permission_denied");
  if (denied?.type === "permission_denied") {
    assert.equal(denied.call.id, "c1");
    assert.equal(denied.reason, "命中 deny 规则");
  }
  assert.equal(model.denied.length, 1);
  assert.equal(model.denied[0]?.reason, "命中 deny 规则");
  assert.equal(trace.length, 1);
  assert.deepEqual(trace[0], {
    call,
    permission: "deny",
    result: { error: "命中 deny 规则" },
    ms: 3,
  });
});

test("emitToolResult：tool_result 事件 + todo 快照 + 回灌 + trace 用 traceOutput", () => {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new RecordModel();
  const trace: ToolTraceItem[] = [];
  const call = toolCall("c2", "Read", "a.txt");
  const result: ToolExecutionResult = {
    summary: "读取完成",
    output: "截断后的输出",
    traceOutput: "完整输出",
    details: { lines: 3 },
  };

  const returned = emitToolResult(bus, model, trace, {
    call,
    result,
    permission: "allow",
    ms: 5,
  });

  assert.equal(returned, result);
  const toolResult = events.find((event) => event.type === "tool_result");
  assert.equal(toolResult?.type, "tool_result");
  if (toolResult?.type === "tool_result") {
    assert.equal(toolResult.callId, "c2");
    assert.equal(toolResult.output, "截断后的输出");
    assert.deepEqual(toolResult.details, { lines: 3 });
  }
  assert.equal(model.results.length, 1);
  assert.equal(model.results[0]?.isError, false);
  assert.equal(
    (trace[0]?.result as { output?: string }).output,
    "完整输出",
    "trace 应优先取 traceOutput",
  );
});

test("emitToolResult：todoSnapshot 触发 todo_update 事件", () => {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new RecordModel();
  const todos = [{ id: "t1", content: "干活", status: "completed" as const }];
  const result: ToolExecutionResult = {
    summary: "完成",
    todoSnapshot: todos,
  };

  emitToolResult(bus, model, [], { call: toolCall("c3", "Edit", "b.txt"), result, permission: "allow", ms: 1 });

  const update = events.find((event) => event.type === "todo_update");
  assert.equal(update?.type, "todo_update");
  if (update?.type === "todo_update") {
    assert.deepEqual(update.todos, todos);
  }
});

test("executeTool：成功路径执行并回灌", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-batch-"));
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new RecordModel();
  const trace: ToolTraceItem[] = [];
  const tools = new ToolExecutor(directory);
  const call = toolCall("c4", "Bash", "echo batch-ok", {
    command: "echo batch-ok",
  });

  const result = await executeTool(bus, model, tools, trace, {
    call,
    permission: "allow",
    signal: new AbortController().signal,
    ms: 0,
  });

  assert.equal(result.summary, "命令退出：0");
  const bashOutput = result.output as { stdout?: string };
  assert.match(bashOutput.stdout ?? "", /batch-ok/);
  assert.ok(!result.isError, "成功执行不应标记 isError");
  assert.equal(
    events.filter((event) => event.type === "tool_result").length,
    1,
  );
  assert.equal(model.results.length, 1);
  assert.equal(trace.length, 1);
});

test("executeTool：执行抛错归一为 isError 结果并回灌", async () => {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new RecordModel();
  const trace: ToolTraceItem[] = [];
  const call = toolCall("c5", "Bash", "explode");

  const result = await executeTool(bus, model, failingExecutor, trace, {
    call,
    permission: "allow",
    signal: new AbortController().signal,
    ms: 0,
  });

  assert.equal(result.isError, true);
  assert.match(result.summary, /模拟执行失败/);
  assert.equal(model.results[0]?.isError, true);
  const event = events.find((item) => item.type === "tool_result");
  assert.equal(event?.type, "tool_result");
  if (event?.type === "tool_result") {
    assert.equal(event.isError, true);
  }
});

test("executeTool：transform 在成功与异常路径均应用", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-batch-"));
  const bus = new AgentEventBus();
  const model = new RecordModel();
  const calls: Array<{ raw: ToolExecutionResult }> = [];
  const transform = (raw: ToolExecutionResult) => {
    calls.push({ raw });
    return { ...raw, summary: `改写：${raw.summary}` };
  };
  const tools = new ToolExecutor(directory);

  const ok = await executeTool(bus, model, tools, [], {
    call: toolCall("c6", "Bash", "echo x", { command: "echo x" }),
    permission: "allow",
    signal: new AbortController().signal,
    ms: 0,
    transform,
  });
  assert.match(ok.summary, /^改写：/);

  const failed = await executeTool(bus, model, failingExecutor, [], {
    call: toolCall("c7", "Bash", "explode"),
    permission: "allow",
    signal: new AbortController().signal,
    ms: 0,
    transform,
  });
  assert.equal(failed.isError, true);
  assert.match(failed.summary, /^改写：/);
  assert.equal(calls[1]?.raw.isError, true, "异常路径 transform 收到 isError 标记");
});
