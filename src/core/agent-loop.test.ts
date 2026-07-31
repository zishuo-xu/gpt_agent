import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolExecutor } from "../tools/executor.js";
import { AgentLoop, type AgentModel, type ModelTurn } from "./agent-loop.js";
import { AgentEventBus } from "./events.js";
import { PermissionEngine } from "./permissions.js";
import type { AgentEvent, ToolCall } from "./types.js";

class ScriptedModel implements AgentModel {
  #turns: ModelTurn[];

  constructor(turns: ModelTurn[]) {
    this.#turns = [...turns];
  }

  async next(): Promise<ModelTurn> {
    return this.#turns.shift() ?? { done: true };
  }
}

function toolCall(
  id: string,
  tool: ToolCall["tool"],
  target: string,
  args: unknown,
): ToolCall {
  return { id, tool, target, args };
}

test("AgentLoop 完成 Read → Edit → Bash → done 纵向闭环", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-loop-"));
  const filePath = path.join(directory, "sample.txt");
  await writeFile(filePath, "before\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  let approvals = 0;

  const model = new ScriptedModel([
    {
      text: "先读取文件。",
      toolCalls: [
        toolCall("read-1", "Read", "sample.txt", { filePath: "sample.txt" }),
      ],
    },
    {
      text: "执行精确编辑。",
      toolCalls: [
        toolCall("edit-1", "Edit", "sample.txt", {
          filePath: "sample.txt",
          oldString: "before",
          newString: "after",
        }),
      ],
    },
    {
      text: "运行验证命令。",
      toolCalls: [
        toolCall("bash-1", "Bash", `${process.execPath} -e verify`, {
          command: `${process.execPath} -e "const fs=require('fs');process.exit(fs.readFileSync('sample.txt','utf8').includes('after')?0:1)"`,
        }),
      ],
    },
    { text: "修改和验证已完成。", done: true },
  ]);

  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(directory),
    approve: async () => {
      approvals += 1;
      return { granted: true };
    },
  });
  await loop.run();

  assert.equal(await readFile(filePath, "utf8"), "after\n");
  assert.equal(approvals, 1, "normal 下 Edit 自动放行，灰区 Bash 询问一次");
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(
    events.filter((event) => event.type === "tool_result").length,
    3,
  );
  const editResult = events.find(
    (event) =>
      event.type === "tool_result" && event.callId === "edit-1",
  );
  assert.equal(editResult?.type, "tool_result");
  if (editResult?.type === "tool_result") {
    assert.match(String(editResult.output), /-before\n\+after/);
  }
});

test("deny 直接回灌错误且不调用审批", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-deny-"));
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  let asked = false;
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("danger-1", "Bash", "rm -rf build", {
          command: "rm -rf build",
        }),
      ],
      done: true,
    },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust", [
      { effect: "deny", pattern: "Bash(rm -rf *)" },
    ]),
    tools: new ToolExecutor(directory),
    approve: async () => {
      asked = true;
      return { granted: true };
    },
  });

  await loop.run();
  assert.equal(asked, false);
  assert.ok(events.some((event) => event.type === "permission_denied"));
});

test("TodoWrite 通过 AgentLoop 发布全量 todo_update 事件", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-loop-todo-"));
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("todo-1", "TodoWrite", "2 items", {
          todos: [
            { id: "inspect", content: "检查实现", status: "in_progress" },
            { id: "verify", content: "运行测试", status: "pending" },
          ],
        }),
      ],
    },
    { text: "计划已建立。", done: true },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: false }),
  });

  await loop.run();

  const update = events.find((event) => event.type === "todo_update");
  assert.equal(update?.type, "todo_update");
  if (update?.type === "todo_update") {
    assert.equal(update.todos[0]?.status, "in_progress");
  }
  assert.equal(
    events.some((event) => event.type === "ask_permission"),
    false,
  );
});

test("拒绝并留言会将纠正意见回灌模型", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-feedback-"));
  const bus = new AgentEventBus();
  let deniedReason = "";
  const call = toolCall(
    "install",
    "Bash",
    "npm install left-pad",
    { command: "npm install left-pad" },
  );
  const model: AgentModel = {
    async next() {
      return { toolCalls: [call], done: true };
    },
    acceptToolDenied(_call, reason) {
      deniedReason = reason;
    },
  };
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(directory),
    approve: async () => ({
      granted: false,
      feedback: "别用 npm，用 pnpm",
    }),
  });

  await loop.run();

  assert.equal(deniedReason, "用户拒绝：别用 npm，用 pnpm");
});

test("strict 编辑审批在落盘前携带真实 diff", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-preview-"));
  const filePath = path.join(directory, "config.txt");
  await writeFile(
    filePath,
    ["a", "b", "c", "port=3000", "d", "e", "f"].join("\n"),
    "utf8",
  );
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("read-config", "Read", "config.txt", {
          filePath: "config.txt",
        }),
      ],
    },
    {
      toolCalls: [
        toolCall("edit-config", "Edit", "config.txt", {
          filePath: "config.txt",
          oldString: "port=3000",
          newString: "port=8080",
        }),
      ],
    },
    { text: "完成", done: true },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("strict"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true, scope: "once" }),
  });

  await loop.run();

  const approval = events.find(
    (event) =>
      event.type === "ask_permission" &&
      event.call.id === "edit-config",
  );
  assert.equal(approval?.type, "ask_permission");
  if (approval?.type === "ask_permission") {
    assert.match(approval.detail ?? "", /-port=3000\n\+port=8080/);
  }
  assert.match(await readFile(filePath, "utf8"), /port=8080/);
});

test("模型 fallback 事件可观测且按实际模型单价计费", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "myagent-fallback-event-"),
  );
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      text: "备用模型已接管。",
      done: true,
      usage: { input: 100, output: 20, cached: 40 },
      usagePricing: {
        inputPerMillionCny: 2,
        outputPerMillionCny: 10,
        cachedInputPerMillionCny: 0.5,
      },
      fallbacks: [
        {
          from: "primary/model-a",
          to: "backup/model-b",
          reason: "503",
        },
      ],
    },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: false }),
    modelRole: "main",
  });

  await loop.run();

  const fallback = events.find(
    (event) => event.type === "model_fallback",
  );
  assert.deepEqual(fallback, {
    type: "model_fallback",
    role: "main",
    from: "primary/model-a",
    to: "backup/model-b",
    reason: "503",
  });
  const cost = events.find(
    (event) => event.type === "cost_update",
  );
  assert.equal(cost?.type, "cost_update");
  if (cost?.type === "cost_update") {
    assert.ok(Math.abs((cost.costCny ?? 0) - 0.00034) < 1e-12);
  }
});
