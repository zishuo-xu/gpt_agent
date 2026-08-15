import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolExecutor } from "../tools/executor.js";
import { PluginToolRegistry } from "../shared/plugin-tool.js";
import {
  AgentLoop,
  jitteredBackoff,
  type AgentModel,
  type ModelTurn,
} from "./agent-loop.js";
import { shouldShowCacheMissNotice } from "./cache-stats.js";
import { AgentEventBus } from "./events.js";
import { PermissionEngine } from "./permissions.js";
import type { AgentEvent, FileOps, ToolCall, ToolExecutionResult } from "./types.js";

class ScriptedModel implements AgentModel {
  #turns: ModelTurn[];
  /** acceptToolResult 回灌记录（用于断言工具结果如何反馈模型） */
  readonly results: Array<{ call: ToolCall; isError: boolean }> = [];
  /** setFileOps 回灌记录（P0-3 断言用） */
  readonly fileOpsSnapshots: FileOps[] = [];
  /** 流式 thinking 推送（AgentModel 可选面；测试注入模拟流式模型） */
  onThinkingDelta?: (text: string) => void;

  constructor(turns: ModelTurn[]) {
    this.#turns = [...turns];
  }

  async next(): Promise<ModelTurn> {
    return this.#turns.shift() ?? { done: true };
  }

  acceptToolResult(
    call: ToolCall,
    _result: ToolExecutionResult,
    isError = false,
  ): void {
    this.results.push({ call, isError });
  }

  setFileOps(ops: FileOps): void {
    this.fileOpsSnapshots.push(ops);
  }

  /** done 校验注入的 user 消息记录 */
  readonly userMessages: string[] = [];
  addUserMessage(content: string): void {
    this.userMessages.push(content);
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
        toolCall("read-1", "Read", "sample.txt", { file_path: "sample.txt" }),
      ],
    },
    {
      text: "执行精确编辑。",
      toolCalls: [
        toolCall("edit-1", "Edit", "sample.txt", {
          file_path: "sample.txt",
          old_string: "before",
          new_string: "after",
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
    // diff 移出 output（模型上下文），完整 diff 在 details 供 UI 渲染
    assert.doesNotMatch(String(editResult.output), /-before/);
    const details = editResult.details as { diff?: unknown };
    assert.match(String(details.diff), /-before\n\+after/);
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
          file_path: "config.txt",
        }),
      ],
    },
    {
      toolCalls: [
        toolCall("edit-config", "Edit", "config.txt", {
          file_path: "config.txt",
          old_string: "port=3000",
          new_string: "port=8080",
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

test("thinking 推理内容：非流式一次性发射，流式增量逐块发射", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-thinking-"));
  // 非流式：turn.thinking 在无流式回调时一次性补发
  const bus1 = new AgentEventBus();
  const events1: AgentEvent[] = [];
  bus1.subscribe((event) => events1.push(event));
  const model1 = new ScriptedModel([
    { thinking: "先检查目录结构", text: "目录为空", done: true },
  ]);
  await new AgentLoop({
    bus: bus1,
    model: model1,
    permissions: new PermissionEngine("trust"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
  }).run();
  const thinking1 = events1.filter(
    (event) => event.type === "thinking_delta",
  );
  assert.equal(thinking1.length, 1, "非流式应恰好发射一次 thinking_delta");
  assert.equal(
    (thinking1[0] as { text: string }).text,
    "先检查目录结构",
  );

  // 流式：模型经 onThinkingDelta 逐块推送，事件逐块发射且不重复
  const bus2 = new AgentEventBus();
  const events2: AgentEvent[] = [];
  bus2.subscribe((event) => events2.push(event));
  const model2 = new ScriptedModel([{ text: "回答", done: true }]);
  // 模拟流式模型：next() 内先推送两段 thinking 增量，再返回带完整 thinking 的回合
  const streamNext = model2.next.bind(model2);
  model2.next = (async () => {
    model2.onThinkingDelta?.("首先考虑");
    model2.onThinkingDelta?.("再决定");
    return streamNext();
  }) as ScriptedModel["next"];
  await new AgentLoop({
    bus: bus2,
    model: model2,
    permissions: new PermissionEngine("trust"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
  }).run();
  const thinking2 = events2.filter(
    (event) => event.type === "thinking_delta",
  );
  assert.equal(thinking2.length, 2, "流式应逐块发射 thinking_delta");
  assert.deepEqual(
    thinking2.map((event) => (event as { text: string }).text),
    ["首先考虑", "再决定"],
    "流式增量不应与完整 thinking 重复",
  );
});

test("插件/MCP 工具审批风险文案按工具名启发式区分只读与写操作", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-plugin-risk-"));
  const cases: Array<{
    tool: string;
    risk: RegExp;
  }> = [
    // snake_case 只读动词（MCP 常见命名）
    { tool: "sysinfo_list_directory", risk: /只读操作，不修改文件/ },
    // camelCase 只读动词（WebFetch / WebSearch 形态）
    { tool: "WebFetch", risk: /只读操作，不修改文件/ },
    // 写操作动词不命中只读词表
    { tool: "create_issue", risk: /将修改文件；执行前可查看精确 diff/ },
    { tool: "fs_write", risk: /将修改文件；执行前可查看精确 diff/ },
  ];
  for (const { tool, risk } of cases) {
    const bus = new AgentEventBus();
    const events: AgentEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const model = new ScriptedModel([
      {
        toolCalls: [toolCall("plugin-call", tool, "", {})],
      },
      { text: "完成", done: true },
    ]);
    const loop = new AgentLoop({
      bus,
      model,
      permissions: new PermissionEngine("normal"),
      tools: new ToolExecutor(directory),
      approve: async () => ({ granted: false }),
    });
    await loop.run();
    const approval = events.find(
      (event) => event.type === "ask_permission",
    );
    assert.equal(approval?.type, "ask_permission", `${tool} 应触发审批`);
    if (approval?.type === "ask_permission") {
      assert.match(approval.risk ?? "", risk, `${tool} 风险文案`);
    }
  }
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

test("run 前 steer：打断点二直接退出，不调用模型也不发 done", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "myagent-steer-pre-"),
  );
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  let nextCalls = 0;
  const model: AgentModel = {
    async next() {
      nextCalls += 1;
      return { text: "不应被调用", done: true };
    },
  };
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
  });

  loop.steer();
  await loop.run();

  assert.equal(nextCalls, 0);
  assert.equal(events.some((event) => event.type === "done"), false);
});

test("steer 打断点一：当前工具完成后拒绝本批剩余调用且不发 done", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "myagent-steer-mid-"),
  );
  await writeFile(path.join(directory, "a.txt"), "a\n", "utf8");
  await writeFile(path.join(directory, "b.txt"), "b\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  const denied: Array<{ id: string; reason: string }> = [];
  let loop: AgentLoop;
  bus.subscribe((event) => {
    events.push(event);
    // 第一个工具完成后触发 steer
    if (event.type === "tool_result" && event.callId === "read-a") {
      loop.steer();
    }
  });
  let nextCalls = 0;
  const model: AgentModel = {
    async next() {
      nextCalls += 1;
      return {
        toolCalls: [
          toolCall("read-a", "Read", "a.txt", { file_path: "a.txt" }),
          toolCall("read-b", "Read", "b.txt", { file_path: "b.txt" }),
        ],
        done: true,
      };
    },
    acceptToolDenied(call, reason) {
      denied.push({ id: call.id, reason });
    },
  };
  loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
  });

  await loop.run();

  assert.equal(nextCalls, 1, "steer 后不应发起新模型轮");
  assert.equal(
    events.filter((event) => event.type === "tool_result").length,
    1,
    "只有第一个工具执行成功",
  );
  const deniedEvent = events.find(
    (event) =>
      event.type === "permission_denied" && event.call.id === "read-b",
  );
  assert.equal(deniedEvent?.type, "permission_denied");
  if (deniedEvent?.type === "permission_denied") {
    assert.match(deniedEvent.reason, /steer/);
  }
  assert.equal(denied.length, 1);
  assert.equal(denied[0]?.id, "read-b");
  assert.match(denied[0]?.reason ?? "", /steer/);
  assert.equal(events.some((event) => event.type === "done"), false);
});

test("steer 解锁挂起审批：拒绝后直接结束本批且不发 done", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "myagent-steer-approve-"),
  );
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  let resolveApproval: ((answer: { granted: boolean; feedback?: string }) => void) | undefined;
  const model: AgentModel = {
    async next() {
      return {
        toolCalls: [
          toolCall("bash-1", "Bash", "echo one", { command: "echo one" }),
          toolCall("bash-2", "Bash", "echo two", { command: "echo two" }),
        ],
        done: true,
      };
    },
  };
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("strict"),
    tools: new ToolExecutor(directory),
    approve: () =>
      new Promise((resolve) => {
        resolveApproval = resolve;
      }),
  });

  const runPromise = loop.run();
  // 等待循环进入审批等待
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    events.some((event) => event.type === "ask_permission"),
    "应已发出审批请求",
  );
  loop.steer();
  assert.ok(resolveApproval, "审批回调应已挂起");
  resolveApproval?.({
    granted: false,
    feedback: "用户插入新指令（steer），已取消审批",
  });
  await runPromise;

  const denied = events.filter(
    (event) => event.type === "permission_denied",
  );
  assert.equal(denied.length, 1, "第二个调用被 break 跳过，不重复拒绝");
  assert.equal(
    events.filter((event) => event.type === "tool_result").length,
    0,
  );
  assert.equal(events.some((event) => event.type === "done"), false);
});

test("缓存 miss 提示显示阈值（参照 Pi：<20k tokens 且 <¥0.1 不显示）", () => {
  assert.equal(shouldShowCacheMissNotice(19_999, 0), false);
  assert.equal(shouldShowCacheMissNotice(20_000, 0), true);
  assert.equal(shouldShowCacheMissNotice(0, 0.09), false);
  assert.equal(shouldShowCacheMissNotice(0, 0.1), true);
  assert.equal(shouldShowCacheMissNotice(5_000, 0.2), true);
  assert.equal(shouldShowCacheMissNotice(5_000, 0.05), false);
});

test("turn 级 auto-retry：瞬时错误退避重试成功并发出 notify", async () => {
  let calls = 0;
  const model: AgentModel = {
    async next() {
      calls += 1;
      if (calls === 1) throw new Error("upstream 500 Internal Server Error");
      return { text: "重试成功", done: true };
    },
  };
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(process.cwd()),
    approve: async () => ({ granted: true }),
    retryBaseDelayMs: 1,
  });
  await loop.run();
  assert.equal(calls, 2, "瞬时错误后应自动重试一次");
  assert.ok(
    events.some(
      (event) =>
        event.type === "notify" && /自动重试/.test(event.message),
    ),
    "应发出重试 notify",
  );
  assert.ok(events.some((event) => event.type === "done"));
});

test("turn 级 auto-retry：连续失败重试耗尽后 run 抛错", async () => {
  let calls = 0;
  const model: AgentModel = {
    async next() {
      calls += 1;
      throw new Error("fetch failed");
    },
  };
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(process.cwd()),
    approve: async () => ({ granted: true }),
    retryBaseDelayMs: 1,
    retryMaxRetries: 3,
  });
  await assert.rejects(loop.run(), /fetch failed/);
  assert.equal(calls, 4, "初始 1 次 + 重试 3 次");
  assert.equal(
    events.filter((event) => event.type === "notify").length,
    3,
    "每次重试前发出 notify",
  );
});

test("quota 类错误不重试（fail-closed）", async () => {
  let calls = 0;
  const model: AgentModel = {
    async next() {
      calls += 1;
      throw new Error("insufficient_quota");
    },
  };
  const loop = new AgentLoop({
    bus: new AgentEventBus(),
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(process.cwd()),
    approve: async () => ({ granted: true }),
    retryBaseDelayMs: 1,
  });
  await assert.rejects(loop.run(), /insufficient_quota/);
  assert.equal(calls, 1, "quota 错误不应重试");
});

test("overflow 错误：先压缩再重试一次", async () => {
  let calls = 0;
  let compactCalls = 0;
  const model: AgentModel = {
    async next() {
      calls += 1;
      if (calls === 1) {
        throw new Error("This model's maximum context length is 200000 tokens");
      }
      return { text: "压缩后重试成功", done: true };
    },
    async compact() {
      compactCalls += 1;
      return true;
    },
  };
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(process.cwd()),
    approve: async () => ({ granted: true }),
    retryBaseDelayMs: 1,
  });
  await loop.run();
  assert.equal(compactCalls, 1, "overflow 应触发一次压缩");
  assert.equal(calls, 2);
  assert.ok(
    events.some((event) => event.type === "notify" && /上下文超长/.test(event.message)),
  );
});

test("重试期间 abort：立即中止且不再发起请求", async () => {
  let calls = 0;
  const model: AgentModel = {
    async next() {
      calls += 1;
      throw new Error("fetch failed");
    },
  };
  const loop = new AgentLoop({
    bus: new AgentEventBus(),
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(process.cwd()),
    approve: async () => ({ granted: true }),
    retryBaseDelayMs: 50_000, // 长退避：确保 abort 发生在 sleep 中
  });
  const running = loop.run();
  setTimeout(() => loop.interrupt(), 10);
  await running; // abort 后应正常返回而非抛错
  assert.ok(calls >= 1);
});

test("并行模式：全并行安全工具批次并发执行（总时长 < 串行总和）", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-par-"));
  const registry = new PluginToolRegistry();
  registry.register({
    name: "SlowProbe",
    description: "慢速只读探测",
    inputSchema: {},
    executionMode: "parallel",
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { summary: "probe done" };
    },
  });
  const model = new ScriptedModel([
    {
      text: "",
      toolCalls: [
        toolCall("p1", "SlowProbe", "probe-1", {}),
        toolCall("p2", "SlowProbe", "probe-2", {}),
      ],
    },
    { text: "并行完成", done: true },
  ]);
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const loop = new AgentLoop({
    bus,
    model,
    // trust 档：插件工具自动放行（normal 档需审批，批次会退化为串行——审批优先）
    permissions: new PermissionEngine("trust"),
    tools: new ToolExecutor(
      directory,
      undefined,
      undefined,
      undefined,
      registry,
    ),
    approve: async () => ({ granted: true }),
    parallelTools: true,
  });
  const startedAt = Date.now();
  await loop.run();
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 700,
    `两个 0.4s 只读探测应并发执行（实际 ${elapsed}ms）`,
  );
  assert.equal(
    events.filter((event) => event.type === "tool_result").length,
    2,
  );
  // 并行路径也 emit tool_call（事件流完整，崩溃恢复时 tool_result 可配对）
  assert.equal(
    events.filter((event) => event.type === "tool_call").length,
    2,
    "并行执行应补发 tool_call 事件",
  );
  const callEvents = events
    .filter((event) => event.type === "tool_call")
    .map((event) => (event as Extract<AgentEvent, { type: "tool_call" }>).call.id);
  assert.deepEqual(
    callEvents.sort(),
    ["p1", "p2"],
    "tool_call 事件覆盖全部并发调用",
  );
});

test("并行模式：批次含顺序工具（Bash）时整批退化为串行", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-serial-batch-"));
  await writeFile(path.join(directory, "a.txt"), "before\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      text: "",
      toolCalls: [
        toolCall("b1", "Bash", "sleep 0.3", { command: "sleep 0.3" }),
        toolCall("b2", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    { text: "串行完成", done: true },
  ]);
  const tools = new ToolExecutor(directory);
  const executionOrder: string[] = [];
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (call, signal, options) => {
    executionOrder.push(`start:${call.id}`);
    const result = await originalExecute(call, signal, options);
    executionOrder.push(`end:${call.id}`);
    return result;
  };
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools,
    approve: async () => ({ granted: true }),
    parallelTools: true,
  });
  await loop.run();
  // 批次含顺序工具（Bash）→ 整批串行：Read 必须等 Bash 结束后才开始
  assert.deepEqual(executionOrder, [
    "start:b1",
    "end:b1",
    "start:b2",
    "end:b2",
  ]);
});

test("并行模式：批次含 ask 工具时退化为串行并正常审批", async () => {
  let approveCalls = 0;
  const model = new ScriptedModel([
    {
      text: "",
      toolCalls: [
        toolCall("s1", "Edit", "src/a.ts", {
          file_path: "src/a.ts",
          old_string: "a",
          new_string: "b",
        }),
        toolCall("s2", "Read", "src/b.ts", { file_path: "src/b.ts" }),
      ],
    },
    { text: "串行完成", done: true },
  ]);
  const loop = new AgentLoop({
    bus: new AgentEventBus(),
    model,
    permissions: new PermissionEngine("strict"),
    tools: new ToolExecutor(process.cwd()),
    approve: async () => {
      approveCalls += 1;
      return { granted: true };
    },
    parallelTools: true,
  });
  await loop.run();
  assert.equal(approveCalls, 1, "Edit 应走审批");
});

test("并行模式：deny 在并行路径被拒绝且不执行", async () => {
  let executed = 0;
  const model = new ScriptedModel([
    {
      text: "",
      toolCalls: [
        toolCall("d1", "Bash", "rm -rf /tmp/x", { command: "rm -rf /tmp/x" }),
        toolCall("d2", "Read", "src/a.ts", { file_path: "src/a.ts" }),
      ],
    },
    { text: "完成", done: true },
  ]);
  const tools = new ToolExecutor(process.cwd());
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (call, signal) => {
    executed += 1;
    return await originalExecute(call, signal);
  };
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust", [
      { effect: "deny", pattern: "Bash(rm -rf *)" },
    ]),
    tools,
    approve: async () => ({ granted: true }),
    parallelTools: true,
  });
  await loop.run();
  assert.equal(executed, 1, "deny 的工具不应执行");
  assert.ok(
    events.some(
      (event) =>
        event.type === "permission_denied" &&
        event.call.id === "d1",
    ),
  );
});

test("截断回合（stopReason=max_tokens）工具调用全部判失败且不执行", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-trunc-"));
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      text: "先读取文件，但输出被截断",
      stopReason: "max_tokens",
      toolCalls: [
        toolCall("t-1", "Read", "a.ts", { file_path: "a.ts" }),
        toolCall("t-2", "Grep", "TODO", { pattern: "TODO", path: "." }),
      ],
    },
    { text: "收到失败结果后总结", done: true },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
  });
  await loop.run();

  // 两个工具调用均以失败回灌模型，且实际未执行
  assert.equal(model.results.length, 2);
  assert.ok(model.results.every((item) => item.isError), "截断回合工具应全部判失败");
  assert.deepEqual(
    model.results.map((item) => item.call.id),
    ["t-1", "t-2"],
  );
  // 事件流：每个调用都有 tool_call + tool_result(isError)，无成功结果
  const toolResults = events.filter((event) => event.type === "tool_result");
  assert.equal(toolResults.length, 2);
  assert.ok(
    toolResults.every(
      (event) =>
        event.type === "tool_result" &&
        event.isError === true &&
        String(event.summary).includes("截断"),
    ),
  );
  assert.equal(events.at(-1)?.type, "done");
});

test("Bash 执行时发射 tool_execution_update 流式事件，tool_result 仍完整", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-partial-"));
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const model = new ScriptedModel([
    {
      text: "运行命令。",
      toolCalls: [
        toolCall("bash-partial", "Bash", "echo hello-partial", {
          command: "echo hello-partial",
        }),
      ],
    },
    { text: "完成。", done: true },
  ]);

  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
  });
  await loop.run();

  const updates = events.filter(
    (event) => event.type === "tool_execution_update",
  );
  assert.ok(updates.length >= 1, "应发射至少一条 tool_execution_update");
  const partials = updates
    .map((event) =>
      event.type === "tool_execution_update" ? event.partial : "",
    )
    .join("");
  assert.ok(partials.includes("hello-partial"), `流式输出应含命令输出，实际: ${partials}`);

  // tool_result 仍正常发射且输出完整（流式不破坏最终结果）
  const results = events.filter((event) => event.type === "tool_result");
  assert.equal(results.length, 1);
  const result = results[0];
  assert.ok(result && result.type === "tool_result");
  const stdout =
    result.output && typeof result.output === "object"
      ? (result.output as { stdout?: string }).stdout ?? ""
      : String(result.output);
  assert.ok(stdout.includes("hello-partial"), "tool_result 输出应完整包含命令输出");
  assert.equal(events.at(-1)?.type, "done");
});

test("jitteredBackoff：25% 向下抖动——退避乘 [0.75, 1.0] 随机系数", () => {
  // 注入随机源断言边界：random=0 → ×0.75；random=1 → ×1.0；random=0.5 → ×0.875
  assert.equal(jitteredBackoff(2000, () => 0), 1500);
  assert.equal(jitteredBackoff(2000, () => 1), 2000);
  assert.equal(jitteredBackoff(2000, () => 0.5), 1750);
  assert.equal(jitteredBackoff(8000, () => 0), 6000);
  // 向下抖动语义：结果永不超过原退避（不会向上放大）
  assert.ok(jitteredBackoff(2000, () => 0.99) <= 2000);
});

test("AgentLoop 累计文件操作并注入模型（FileOps）", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-fileops-loop-"));
  const filePath = path.join(directory, "sample.txt");
  await writeFile(filePath, "before\n", "utf8");
  const bus = new AgentEventBus();
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("r1", "Read", "sample.txt", { file_path: "sample.txt" }),
      ],
    },
    {
      toolCalls: [
        toolCall("e1", "Edit", "sample.txt", {
          file_path: "sample.txt",
          old_string: "before",
          new_string: "after",
        }),
      ],
    },
    { text: "完成", done: true },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
  });
  await loop.run();
  assert.deepEqual(model.fileOpsSnapshots.at(-1), {
    read: ["sample.txt"],
    modified: ["sample.txt"],
  });
});

test("afterToolCall 改写工具结果（emit 前应用）", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-hook-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("r1", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    { text: "完成", done: true },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
    afterToolCall: (_call, result) => ({
      ...result,
      summary: `改写：${result.summary}`,
    }),
  });
  await loop.run();
  const toolResult = events.find((event) => event.type === "tool_result");
  assert.ok(toolResult?.type === "tool_result");
  if (toolResult?.type === "tool_result") {
    assert.match(toolResult.summary, /^改写：/);
  }
});

test("afterToolCall 抛错不中断循环，保留原结果", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-hook-err-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("r1", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    { text: "完成", done: true },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
    afterToolCall: () => {
      throw new Error("钩子故障");
    },
  });
  await loop.run();
  assert.equal(events.at(-1)?.type, "done");
  const toolResult = events.find((event) => event.type === "tool_result");
  assert.ok(toolResult?.type === "tool_result");
  if (toolResult?.type === "tool_result") {
    assert.match(toolResult.summary, /已读取/);
  }
});

test("terminate：单工具批次 terminate 后循环立即结束", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-term-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("r1", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    // 循环若未终止，第二轮会执行 r2
    {
      toolCalls: [
        toolCall("r2", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    { text: "完成", done: true },
  ]);
  let executed = 0;
  const tools = new ToolExecutor(directory);
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (call, signal, options) => {
    executed += 1;
    return await originalExecute(call, signal, options);
  };
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools,
    approve: async () => ({ granted: true }),
    afterToolCall: (_call, result) => ({ ...result, terminate: true }),
  });
  await loop.run();
  assert.equal(executed, 1, "terminate 后不再发起下一轮工具调用");
  assert.equal(events.at(-1)?.type, "done");
});

test("terminate：批次部分 terminate 不结束循环", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-term-part-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  await writeFile(path.join(directory, "b.txt"), "hi\n", "utf8");
  await writeFile(path.join(directory, "c.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("r1", "Read", "a.txt", { file_path: "a.txt" }),
        toolCall("r2", "Read", "b.txt", { file_path: "b.txt" }),
      ],
    },
    {
      toolCalls: [
        toolCall("r3", "Read", "c.txt", { file_path: "c.txt" }),
      ],
    },
    { text: "完成", done: true },
  ]);
  let executed = 0;
  const tools = new ToolExecutor(directory);
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (call, signal, options) => {
    executed += 1;
    return await originalExecute(call, signal, options);
  };
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools,
    approve: async () => ({ granted: true }),
    afterToolCall: (call, result) => ({
      ...result,
      terminate: call.id === "r1",
    }),
  });
  await loop.run();
  assert.equal(executed, 3, "部分 terminate 不终止循环，后续轮继续执行");
  assert.equal(events.at(-1)?.type, "done");
});

test("terminate 与 steer 交互：steer 优先于 terminate", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-term-steer-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  await writeFile(path.join(directory, "b.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("t1", "Read", "a.txt", { file_path: "a.txt" }),
        toolCall("t2", "Read", "b.txt", { file_path: "b.txt" }),
      ],
    },
    { text: "完成", done: true },
  ]);
  let loop: AgentLoop | undefined;
  loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
    afterToolCall: (call, result) => {
      if (call.id === "t1") loop?.steer();
      return { ...result, terminate: true };
    },
  });
  await loop.run();
  assert.ok(
    events.some(
      (event) =>
        event.type === "permission_denied" &&
        (event as Extract<AgentEvent, { type: "permission_denied" }>).call
          .id === "t2",
    ),
    "steer 后批次剩余调用被拒绝",
  );
  assert.notEqual(events.at(-1)?.type, "done", "steer 路径不 emit done");
});

test("terminate 无法绕过 finalOnly：final 阶段工具被拒", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-term-final-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("t1", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    { text: "总结", done: true },
  ]);
  let executed = 0;
  const tools = new ToolExecutor(directory);
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (call, signal, options) => {
    executed += 1;
    return await originalExecute(call, signal, options);
  };
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools,
    approve: async () => ({ granted: true }),
    beforeTurn: async () => ({ finalOnly: true }),
    afterToolCall: (_call, result) => ({ ...result, terminate: true }),
  });
  await loop.run();
  assert.equal(executed, 0, "final 阶段工具被拒绝，不执行");
  assert.ok(
    events.some(
      (event) =>
        event.type === "permission_denied" &&
        (event as Extract<AgentEvent, { type: "permission_denied" }>).reason.includes("纯总结"),
    ),
  );
});

test("done 校验：todo 有未完成项时软拦截（最多 2 次），第 3 次宣布完成放行", async () => {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    { done: true },
    { done: true },
    { done: true },
  ]);
  const todos = [{ id: "t1", content: "写核心逻辑", status: "pending" as const }];
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor("/tmp"),
    approve: async () => ({ granted: true }),
    getTodos: () => todos,
  });
  await loop.run();
  const doneEvents = events.filter((event) => event.type === "done");
  const warnEvents = events.filter(
    (event) => event.type === "notify" && event.level === "warn",
  );
  assert.equal(doneEvents.length, 1, "第 3 次宣布完成才放行");
  assert.equal(warnEvents.length, 2, "前两次拦截各发一条 warn 通知");
  assert.equal(model.userMessages.length, 2, "注入两条提示消息");
  assert.match(model.userMessages[0] ?? "", /仍有 1 项未完成/);
  assert.match(model.userMessages[0] ?? "", /写核心逻辑（pending）/);
});

test("done 校验：todo 全部 completed 时直接放行", async () => {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([{ done: true }]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor("/tmp"),
    approve: async () => ({ granted: true }),
    getTodos: () => [
      { id: "t1", content: "写核心逻辑", status: "completed" as const },
    ],
  });
  await loop.run();
  assert.equal(
    events.filter((event) => event.type === "done").length,
    1,
    "无未完成项直接完成",
  );
  assert.equal(model.userMessages.length, 0);
});

test("done 校验：未传 getTodos（子代理等）不拦截", async () => {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([{ done: true }]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor("/tmp"),
    approve: async () => ({ granted: true }),
  });
  await loop.run();
  assert.equal(events.filter((event) => event.type === "done").length, 1);
  assert.equal(model.userMessages.length, 0);
  assert.equal(
    events.filter((event) => event.type === "notify").length,
    0,
    "无 warn 通知",
  );
});

test("riskFor：cd 前缀不再绕过依赖安装规则", async () => {
  const bus = new AgentEventBus();
  const askEvents: Array<{ risk: string; target: string }> = [];
  bus.subscribe((event) => {
    if (event.type === "ask_permission") {
      askEvents.push({ risk: event.risk, target: event.call.target });
    }
  });
  const model = new ScriptedModel([
    {
      text: "安装依赖。",
      toolCalls: [
        toolCall("bash-1", "Bash", "cd /tmp/proj && pnpm install", {
          command: "cd /tmp/proj && pnpm install",
        }),
      ],
    },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor("/tmp"),
    approve: async () => ({ granted: true }),
  });
  await loop.run();
  assert.equal(askEvents.length, 1);
  assert.equal(askEvents[0]?.risk, "将修改依赖清单与 lock 文件");
});

test("riskFor：pnpm create / git init / git commit / npx 有明确翻译", async () => {
  const bus = new AgentEventBus();
  const risks: Array<{ risk: string; target: string }> = [];
  bus.subscribe((event) => {
    if (event.type === "ask_permission") {
      risks.push({ risk: event.risk, target: event.call.target });
    }
  });
  const model = new ScriptedModel([
    {
      text: "脚手架与提交。",
      toolCalls: [
        toolCall("b1", "Bash", "pnpm create vite . --template react-ts", {
          command: "pnpm create vite . --template react-ts",
        }),
        toolCall("b2", "Bash", "git init", { command: "git init" }),
        toolCall("b3", "Bash", "git commit -m init", {
          command: "git commit -m init",
        }),
        toolCall("b4", "Bash", "npx prettier --check .", {
          command: "npx prettier --check .",
        }),
      ],
    },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor("/tmp"),
    approve: async () => ({ granted: true }),
  });
  await loop.run();
  assert.deepEqual(
    risks.map((item) => item.risk),
    [
      "将生成项目脚手架文件",
      "将初始化 git 仓库",
      "将创建本地提交",
      "将下载并执行包（脚手架/一次性命令）",
    ],
  );
});
