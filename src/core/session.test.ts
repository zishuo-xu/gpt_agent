import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationAgentModel } from "./agent-model.js";
import { AgentSession } from "./session.js";
import type { AgentSessionEvent } from "./session.js";
import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import type { PermissionRule, ToolCall } from "./types.js";

/**
 * AgentSession 直接单测：会话状态机 / 审批流 / 插队 / 中断 / 分支 /
 * 书签 / 统计累计 / restore / /run 任务。
 * 模型侧用 ScriptedClient（预置响应序列），工具执行用真实
 * ToolExecutor（cwd 隔离临时目录），事件流断言驱动。
 */

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

function response(
  text: string,
  options: {
    toolCalls?: ToolCall[];
    usage?: { input: number; output: number; cached: number };
    model?: string;
    providerId?: string;
    thinking?: string;
  } = {},
): ModelResponse {
  return {
    text,
    toolCalls: options.toolCalls ?? [],
    usage: options.usage ?? { input: 12, output: 3, cached: 2 },
    ...(options.model ? { model: options.model } : {}),
    ...(options.providerId ? { providerId: options.providerId } : {}),
    ...(options.thinking ? { thinking: options.thinking } : {}),
  };
}

function toolCall(
  id: string,
  tool: ToolCall["tool"],
  target: string,
  args: unknown,
): ToolCall {
  return { id, tool, target, args };
}

/** 收集会话全部事件，并支持按类型等待（审批等异步流程用） */
class EventCollector {
  readonly records: AgentSessionEvent[] = [];
  #waiters = new Map<string, Array<(record: AgentSessionEvent) => void>>();

  constructor(session: AgentSession) {
    session.subscribe((record) => {
      this.records.push(record);
      const waiters = this.#waiters.get(record.event.type);
      if (waiters) {
        this.#waiters.delete(record.event.type);
        for (const resolve of waiters) resolve(record);
      }
    });
  }

  /** 等待某类型事件出现（若已出现过则立即返回最新一条） */
  async waitFor(
    type: string,
    timeoutMs = 5_000,
  ): Promise<AgentSessionEvent> {
    const existing = [...this.records]
      .reverse()
      .find((record) => record.event.type === type);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`等待事件超时：${type}`)),
        timeoutMs,
      );
      const waiters = this.#waiters.get(type) ?? [];
      waiters.push((record) => {
        clearTimeout(timer);
        resolve(record);
      });
      this.#waiters.set(type, waiters);
    });
  }

  eventsOf(type: string): AgentSessionEvent[] {
    return this.records.filter((record) => record.event.type === type);
  }

  async waitForCount(type: string, count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.eventsOf(type).length < count) {
      if (Date.now() >= deadline) {
        throw new Error(`等待事件数量超时：${type} < ${count}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function structuredPlan(label = "计划"): string {
  return `## 目标\n${label}\n## 执行步骤\n1. 修改实现\n## 预计修改文件\n- src/main.ts\n## 验证方式\n- pnpm test\n## 风险与待确认\n- 无`;
}

async function setup(
  responses: ModelResponse[],
  options: {
    mode?: "normal" | "strict" | "trust";
    permissionRules?: PermissionRule[];
    restoredEvents?: AgentSessionEvent[];
    completionReview?: boolean;
  } = {},
): Promise<{
  session: AgentSession;
  collector: EventCollector;
  cwd: string;
  stateDir: string;
  client: ScriptedClient;
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-session-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-session-state-"),
  );
  const client = new ScriptedClient(responses);
  const model = new ConversationAgentModel(client, "你好");
  const session = new AgentSession({
    id: "s-test",
    title: "测试会话",
    cwd,
    mode: options.mode ?? "normal",
    model,
    stateDir,
    ...(options.completionReview === undefined
      ? {}
      : { completionReview: options.completionReview }),
    ...(options.permissionRules
      ? { permissionRules: options.permissionRules }
      : {}),
    ...(options.restoredEvents
      ? { restoredEvents: options.restoredEvents }
      : {}),
  });
  const collector = new EventCollector(session);
  return { session, collector, cwd, stateDir, client };
}

test("任务规划只暴露只读工具，并硬拒绝模型幻觉出的写工具", async () => {
  const { session, collector, cwd, client } = await setup([
    response("尝试写入", {
      toolCalls: [
        toolCall("write-plan", "Write", "should-not-exist.txt", {
          file_path: "should-not-exist.txt",
          content: "bad",
        }),
      ],
    }),
    response(structuredPlan("安全计划")),
  ]);

  await session.startPlan("实现安全功能");
  await collector.waitFor("plan_proposed");

  assert.deepEqual(
    client.requests[0]?.tools?.map((tool) => tool.name),
    ["Read", "Grep", "Glob"],
  );
  const denied = collector.eventsOf("permission_denied")[0];
  assert.match(
    denied?.event.type === "permission_denied" ? denied.event.reason : "",
    /当前阶段不允许调用 Write/,
  );
  await assert.rejects(readFile(path.join(cwd, "should-not-exist.txt"), "utf8"), /ENOENT/);
  assert.equal(session.taskPlan()?.status, "awaiting_approval");
  assert.equal(session.summary().status, "waiting_plan");
  await assert.rejects(
    session.sendInput("绕过计划直接执行"),
    /当前计划等待决策/,
  );
});

test("批准计划后在同一会话执行，执行提示携带原任务与已批准计划", async () => {
  const plan = structuredPlan("批准版");
  const { session, collector } = await setup([
    response(plan),
    response("执行完成"),
  ]);

  await session.startPlan("实现功能 A");
  await collector.waitFor("plan_proposed");
  await session.decidePlan("approved");
  await collector.waitFor("done");

  assert.equal(session.taskPlan()?.status, "approved");
  const user = collector.eventsOf("user")[0];
  assert.equal(user?.event.type, "user");
  if (user?.event.type === "user") {
    assert.equal(user.event.text, "实现功能 A");
    assert.match(user.event.modelText ?? "", /用户已经批准/);
    assert.match(user.event.modelText ?? "", /批准版/);
  }
});

test("批准计划初始化首个 Todo/Ledger，并将 TodoWrite 状态同步到账本", async () => {
  const plan = "## 目标\n闭环\n## 执行步骤\n1. 修改实现\n2. 补充验证\n## 预计修改文件\n- src/main.ts\n## 验证方式\n- pnpm test\n## 风险与待确认\n- 无";
  const { session, collector } = await setup([
    response(plan),
    response("推进步骤", { toolCalls: [toolCall("todo-1", "TodoWrite", "", { todos: [
      { id: "plan-step-1", content: "修改实现", status: "completed" },
      { id: "plan-step-2", content: "补充验证", status: "in_progress" },
    ] })] }),
    response("完成"),
  ]);
  await session.startPlan("闭环");
  const proposed = await collector.waitFor("plan_proposed");
  await session.decidePlan("approved");
  await collector.waitFor("done");
  const decision = collector.eventsOf("plan_decision")[0]?.event;
  assert.equal(decision?.type, "plan_decision");
  if (decision?.type === "plan_decision" && proposed.event.type === "plan_proposed") {
    assert.equal(decision.revision, proposed.event.revision);
    assert.equal(decision.digest, proposed.event.digest);
  }
  const seeded = collector.eventsOf("todo_update")[0]?.event;
  assert.equal(seeded?.type, "todo_update");
  if (seeded?.type === "todo_update") {
    assert.deepEqual(seeded.todos.map((todo) => todo.status), ["in_progress", "pending"]);
  }
  const ledgerEvent = collector.eventsOf("ledger_update").find((record) =>
    record.event.type === "ledger_update" && record.event.unit.id === "plan-step-1",
  );
  assert.ok(ledgerEvent);
  if (ledgerEvent?.event.type === "ledger_update") {
    const ledger = session.ledgerFor(ledgerEvent.event.taskId);
    assert.equal(ledger?.snapshot().units.find((unit) => unit.id === "plan-step-1")?.status, "done");
    assert.equal(ledger?.snapshot().units.find((unit) => unit.id === "plan-step-2")?.status, "in_progress");
  }
});

test("批准带显式验收命令的自然语言计划进入验收链", async () => {
  const plan = "## 目标\n完成任务\n## 执行步骤\n1. 实施修改\n## 预计修改文件\n- 无\n## 验证方式\n- `true`\n## 风险与待确认\n- 无";
  const { session, collector } = await setup([response(plan), response("完成")]);
  await session.startPlan("完成一个自然语言任务");
  const proposed = await collector.waitFor("plan_proposed");
  assert.equal(proposed.event.type === "plan_proposed" ? proposed.event.contract?.checks[0] : undefined, "true");
  await session.decidePlan("approved");
  await collector.waitFor("run_finished");
  assert.ok(collector.eventsOf("acceptance_result").some((record) => record.event.type === "acceptance_result" && record.event.status === "passed"));
});

test("计划可按反馈修订，也可选择仅分析后结束", async () => {
  const { session, collector, client } = await setup([
    response(structuredPlan("第一版")),
    response(structuredPlan("第二版不改 API")),
  ]);

  await session.startPlan("重构模块");
  await collector.waitFor("plan_proposed");
  await session.decidePlan("revision_requested", "不要修改 API");
  await collector.waitForCount("plan_proposed", 2);

  assert.equal(session.taskPlan()?.revision, 2);
  assert.match(session.taskPlan()?.content ?? "", /第二版不改 API/);
  assert.match(
    JSON.stringify(client.requests[1]?.messages ?? []),
    /不要修改 API/,
  );
  await session.decidePlan("analysis_only");
  assert.equal(session.taskPlan()?.status, "analysis_only");
  assert.equal(session.summary().status, "done");
  assert.equal(client.requests.length, 2);
});

test("sendInput 纯文本闭环：事件序列 + 状态机 + summary", async () => {
  const { session, collector, cwd } = await setup([
    response("先读取文件。", {
      toolCalls: [
        toolCall("read-1", "Read", "sample.txt", { file_path: "sample.txt" }),
      ],
    }),
    response("文件已读，总结如下。"),
  ]);
  await writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
  await session.sendInput("请描述项目");
  assert.equal(session.summary().status, "done");
  const types = collector.records.map((record) => record.event.type);
  // user → text_delta（模型文本）→ tool → cost → done
  assert.ok(types.includes("user"), "首事件含 user");
  assert.ok(types.includes("done"), "结束事件含 done");
  assert.ok(collector.eventsOf("text_delta").length >= 2, "两轮模型文本");
  assert.equal(collector.eventsOf("tool_call").length, 1);
  const summary = session.summary();
  assert.equal(summary.kind, "interactive");
  assert.equal(summary.totalInputTokens, 24, "两次 usage 12+12 累计");
  assert.equal(summary.totalOutputTokens, 6);
});

test("sendInput 空消息抛错", async () => {
  const { session } = await setup([]);
  await assert.rejects(
    session.sendInput("   "),
    /消息不能为空/,
  );
});

test("审批批准流：ask → 批准 → 工具执行 → 完成", async () => {
  const { session, collector } = await setup(
    [
      response("先执行命令。", {
        toolCalls: [toolCall("bash-1", "Bash", "pwd", { command: "pwd" })],
      }),
      response("命令已完成。"),
    ],
    {
      permissionRules: [{ effect: "ask", pattern: "Bash(*)" }],
    },
  );
  const inputPromise = session.sendInput("运行 pwd");
  const ask = await collector.waitFor("ask_permission");
  assert.equal(session.summary().status, "waiting_permission");
  const callId = String(
    (ask.event as { call: ToolCall }).call.id,
  );
  assert.equal(session.resolvePermission(callId, true), true);
  await inputPromise;
  // 工具真实执行（临时目录 cwd），结果回灌
  assert.equal(collector.eventsOf("tool_result").length, 1);
  const result = collector.eventsOf("tool_result")[0]!.event as {
    callId: string;
    isError?: boolean;
  };
  assert.equal(result.callId, "bash-1");
  assert.notEqual(result.isError, true);
  assert.equal(session.summary().status, "done");
});

test("审批拒绝流：ask → 拒绝 → permission_denied → 模型纠偏后完成", async () => {
  const { session, collector } = await setup(
    [
      response("先执行命令。", {
        toolCalls: [toolCall("bash-1", "Bash", "rm -rf x", { command: "rm -rf x" })],
      }),
      response("明白，不执行删除。"),
    ],
    {
      permissionRules: [{ effect: "ask", pattern: "Bash(*)" }],
    },
  );
  const inputPromise = session.sendInput("删除 x");
  const ask = await collector.waitFor("ask_permission");
  const callId = String(
    (ask.event as { call: ToolCall }).call.id,
  );
  session.resolvePermission(callId, false);
  await inputPromise;
  const denied = collector.eventsOf("permission_denied");
  assert.equal(denied.length, 1, "拒绝产生 permission_denied 事件");
  assert.equal(collector.eventsOf("tool_result").length, 0, "工具未执行");
  assert.equal(session.summary().status, "done");
});

test("steer 插队：运行中发送插队消息 → user_queued 且优先处理", async () => {
  const { session, collector } = await setup(
    [
      response("先睡一下。", {
        toolCalls: [
          toolCall("sleep-1", "Bash", "sleep 0.3", { command: "sleep 0.3" }),
        ],
      }),
      response("第一轮结束。"),
      response("插队消息已处理。"),
    ],
    {
      permissionRules: [{ effect: "allow", pattern: "Bash(sleep*)" }],
    },
  );
  const first = session.sendInput("第一条");
  await collector.waitFor("tool_call");
  // 运行中插队（steer）
  await session.sendInput("插队指令", "插队指令", { steer: true });
  await first;
  const queued = collector.eventsOf("user_queued");
  assert.equal(queued.length, 1);
  assert.equal(
    (queued[0]!.event as { steer?: boolean }).steer,
    true,
    "插队消息带 steer 标记",
  );
  // 两条 user 消息都进入会话
  const users = collector.eventsOf("user");
  assert.equal(users.length, 2);
  assert.equal(session.summary().status, "done");
});

test("interrupt：运行中中止 → 状态 interrupted", async () => {
  const { session, collector } = await setup(
    [
      response("长命令。", {
        toolCalls: [
          toolCall("sleep-1", "Bash", "sleep 0.5", { command: "sleep 0.5" }),
        ],
      }),
    ],
    {
      permissionRules: [{ effect: "allow", pattern: "Bash(sleep*)" }],
    },
  );
  const inputPromise = session.sendInput("跑长命令");
  await collector.waitFor("tool_call");
  assert.equal(session.interrupt(), true);
  await inputPromise.catch(() => undefined);
  assert.equal(session.summary().status, "interrupted");
});

test("分支：fork 后切换 → branch_switch 事件 + 树结构", async () => {
  const { session, collector } = await setup([
    response("完成。"),
  ]);
  await session.sendInput("创建分支");
  const branchId = session.forkBranch(3, "实验分支");
  assert.ok(branchId);
  const branches = session.branches();
  assert.equal(branches.length, 2, "main + 新分支");
  const created = branches.find((branch) => branch.id === branchId);
  assert.equal(created?.label, "实验分支");
  assert.equal(created?.forkSeq, 3);
  // 切回 main（fork 时已发过一条 branch_switch，共 2 条）
  session.switchBranch("main");
  const switched = collector.eventsOf("branch_switch");
  assert.equal(switched.length, 2);
  assert.equal(
    (switched[0]!.event as { branchId: string }).branchId,
    branchId,
    "fork 切换至新分支",
  );
  assert.equal(
    (switched[1]!.event as { branchId: string }).branchId,
    "main",
  );
  assert.equal(session.currentBranchId(), "main");
});

test("书签：添加 → 列表 → 移除", async () => {
  const { session } = await setup([response("完成。")]);
  await session.sendInput("打书签");
  session.addBookmark(2, "重要位置");
  assert.deepEqual(session.bookmarks(), [{ seq: 2, name: "重要位置" }]);
  session.removeBookmark(2);
  assert.deepEqual(session.bookmarks(), []);
});

test("成本与 todo 累计：cost_update/todo_update 反映到 summary", async () => {
  const { session, collector } = await setup(
    [
      response("建立 todo。", {
        toolCalls: [
          toolCall("todo-1", "TodoWrite", "", {
            todos: [
              { id: "a", content: "第一步", status: "in_progress" },
            ],
          }),
        ],
      }),
      response("全部完成。", {
        toolCalls: [
          toolCall("todo-2", "TodoWrite", "", {
            todos: [
              { id: "a", content: "第一步", status: "completed" },
            ],
          }),
        ],
      }),
      response("完成。", {
        usage: { input: 100, output: 50, cached: 30 },
        model: "deepseek-v4-flash",
        providerId: "deepseek",
      }),
    ],
  );
  const inputPromise = session.sendInput("开始任务");
  await collector.waitFor("todo_update");
  await inputPromise;
  const summary = session.summary();
  assert.equal(summary.todos[0]?.content, "第一步");
  assert.equal(summary.totalInputTokens, 124);
  assert.equal(summary.totalOutputTokens, 56);
  assert.equal(summary.costByModel.length, 1);
  assert.equal(summary.costByModel[0]!.model, "deepseek-v4-flash");
  assert.equal(summary.costByModel[0]!.tokens, 150);
});

test("restore：恢复事件流 + 检测崩溃残留的中断任务", async () => {
  const userRecord: AgentSessionEvent = {
    seq: 1,
    ts: "2026-08-01T10:00:00.000Z",
    branchId: "main",
    event: { type: "user", text: "恢复测试" },
  };
  const runStarted: AgentSessionEvent = {
    seq: 2,
    ts: "2026-08-01T10:00:01.000Z",
    branchId: "main",
    event: {
      type: "run_started",
      taskId: "task-9",
      description: "崩溃任务",
      permissionMode: "normal",
      hardRules: [],
      taskOptions: {
        description: "崩溃任务",
        permission: "normal",
        hardRules: [],
        semanticBounds: [],
      },
    },
  };
  const { session } = await setup([], {
    restoredEvents: [userRecord, runStarted],
  });
  assert.equal(session.events().length, 2, "事件流完整恢复");
  assert.equal(session.summary().firstMessage, "恢复测试");
  const interrupted = session.interruptedTask();
  assert.equal(interrupted?.taskId, "task-9");
  assert.equal(interrupted?.description, "崩溃任务");
});

test("/run 任务：run_started → 完成 → run_finished + 权限档恢复", async () => {
  const { session, collector } = await setup(
    [response("任务完成。")],
    { mode: "normal" },
  );
  await session.runTask({
    description: "测试任务",
    permission: "trust",
    hardRules: [],
    semanticBounds: [],
  });
  const started = collector.eventsOf("run_started");
  assert.equal(started.length, 1);
  const taskId = (started[0]!.event as { taskId: string }).taskId;
  assert.ok(taskId, "任务 id 非空");
  const finished = collector.eventsOf("run_finished");
  assert.equal(finished.length, 1);
  const finishedEvent = finished[0]!.event as {
    taskId: string;
    status: string;
    reason?: string;
  };
  assert.equal(finishedEvent.taskId, taskId, "run_finished 配对同一任务");
  assert.equal(finishedEvent.status, "completed");
  assert.equal(finishedEvent.reason, "done");
  // 权限档任务期 trust → 结束后恢复 normal
  assert.equal(session.summary().permissionMode, "normal");
});

test("checks 首轮失败后修复，完整 checks 重跑并可信完成", async () => {
  const marker = "acceptance-marker.txt";
  const { session, collector, cwd } = await setup([
    response("先结束本轮。"),
    response("写入修复文件。", { toolCalls: [toolCall("write-fix", "Write", marker, { file_path: marker, content: "ok" })] }),
    response("修复完成。"),
    response("Verdict: PASS\nIssues:（无）\nUnconfirmed: 无"),
  ], { mode: "trust" });
  await session.runTask({ description: "验收修复", checks: [`test -f ${path.join(cwd, marker)}`], checkTimeoutMs: 5_000, permission: "trust", hardRules: [], semanticBounds: [] });
  assert.equal(collector.eventsOf("acceptance_started").length, 2, collector.eventsOf("acceptance_result").map((e) => (e.event as { status?: string; output?: string }).status + ":" + (e.event as { output?: string }).output).join("\n"));
  assert.equal(collector.eventsOf("run_finished").at(-1)?.event.type, "run_finished");
  assert.equal((collector.eventsOf("run_finished").at(-1)?.event as { status: string }).status, "completed");
  assert.equal(await readFile(path.join(cwd, marker), "utf8"), "ok");
});

test("checks 两轮修复耗尽后 failed/acceptance，恰好三次验收", async () => {
  const { session, collector } = await setup([response("结束。"), response("仍然结束。"), response("再次结束。")], { mode: "trust" });
  await session.runTask({ description: "失败验收", checks: ["false"], checkTimeoutMs: 5_000, permission: "trust", hardRules: [], semanticBounds: [] });
  assert.equal(collector.eventsOf("acceptance_started").length, 3);
  const finished = collector.eventsOf("run_finished").at(-1)?.event as { status: string; reason?: string };
  assert.deepEqual({ status: finished.status, reason: finished.reason }, { status: "failed", reason: "acceptance" });
});

test("checks 任务即使 completionReview=false，有任务期写入也自动 review", async () => {
  const marker = "review-marker.txt";
  const { session, collector } = await setup([
    response("写文件。", { toolCalls: [toolCall("write-review", "Write", marker, { file_path: marker, content: "ok" })] }),
    response("完成。"),
    response("Verdict: PASS\nIssues:（无）\nUnconfirmed: 无"),
  ], { mode: "trust", completionReview: false });
  await session.runTask({ description: "自动审查", checks: ["test -f review-marker.txt"], permission: "trust", hardRules: [], semanticBounds: [] });
  assert.equal(collector.eventsOf("review_result").length, 1);
  assert.equal((collector.eventsOf("run_finished").at(-1)?.event as { status: string }).status, "completed");
});

test("review 失败后重跑完整 checks，且与 checks 共享两轮额度", async () => {
  const marker = "review-retry-marker.txt";
  const { session, collector } = await setup([
    response("写文件。", { toolCalls: [toolCall("write-review-retry", "Write", marker, { file_path: marker, content: "ok" })] }),
    response("完成。"),
    response("Verdict: FAIL\nIssues:\n- 需要补充修复\nUnconfirmed: 无"),
    response("修复后完成。"),
    response("Verdict: PASS\nIssues:（无）\nUnconfirmed: 无"),
  ], { mode: "trust", completionReview: false });
  await session.runTask({ description: "审查重试", checks: ["test -f review-retry-marker.txt"], permission: "trust", hardRules: [], semanticBounds: [] });
  assert.equal(collector.eventsOf("acceptance_started").length, 2);
  assert.equal(collector.eventsOf("review_result").length, 2);
  assert.equal((collector.eventsOf("run_finished").at(-1)?.event as { status: string }).status, "completed");
});

test("任务开始前已有 journal 改动不触发自动 review", async () => {
  const { session, collector, cwd } = await setup([
    response("先写入文件。", { toolCalls: [toolCall("pre-write", "Write", "pre-task.txt", { file_path: "pre-task.txt", content: "before" })] }),
    response("完成。"),
    response("完成任务。"),
  ], { mode: "trust", completionReview: true });
  await session.sendInput("先写入文件", undefined);
  const reviewsBefore = collector.eventsOf("review_result").length;
  await session.runTask({ description: "无任务期改动", checks: ["true"], permission: "trust", hardRules: [], semanticBounds: [] });
  assert.equal(collector.eventsOf("review_result").length, reviewsBefore);
  void cwd;
});

test("compact：会话空闲时强制压缩", async () => {
  const { session } = await setup([]);
  // 未配置压缩客户端：compact 返回 false（不报错）
  const compacted = await session.compact();
  assert.equal(compacted, false);
});

test("完成审查：有写操作的任务在 done 后触发审查，通过则正常结束", async () => {
  const { session, collector } = await setup([
    response("写文件。", {
      toolCalls: [
        toolCall("write-1", "Write", "a.txt", { file_path: "a.txt", content: "hello" }),
      ],
    }),
    response("完成。"),
    // 审查轮（TaskRunner 消费）
    response("Verdict: PASS\nIssues: （无）\nUnconfirmed: 无", {
      usage: { input: 10, output: 5, cached: 0 },
    }),
  ], { mode: "trust", completionReview: true });
  await session.sendInput("创建 a.txt");
  const summary = session.summary();
  assert.equal(summary.status, "done");
  assert.deepEqual(summary.review, { passed: true, attempts: 1 });
  const reviewEvents = collector.eventsOf("review_result");
  assert.equal(reviewEvents.length, 1);
  const review = reviewEvents[0]!.event as { passed: boolean };
  assert.equal(review.passed, true);
});

test("完成审查：FAIL 打回主循环，修复后再次审查通过", async () => {
  const { session } = await setup([
    response("写文件。", {
      toolCalls: [
        toolCall("write-1", "Write", "a.txt", { file_path: "a.txt", content: "hello" }),
      ],
    }),
    response("完成。"),
    // 第一次审查 FAIL
    response("Verdict: FAIL\nIssues:\n- a.txt 内容不符合要求\nUnconfirmed: 无", {
      usage: { input: 10, output: 5, cached: 0 },
    }),
    // 主循环打回后模型修复（再次 Write）+ 宣布完成
    response("修复。", {
      toolCalls: [
        toolCall("write-2", "Write", "a.txt", { file_path: "a.txt", content: "world" }),
      ],
    }),
    response("修复完成。"),
    // 第二次审查 PASS
    response("Verdict: PASS\nIssues: （无）\nUnconfirmed: 无", {
      usage: { input: 10, output: 5, cached: 0 },
    }),
  ], { mode: "trust", completionReview: true });
  await session.sendInput("创建 a.txt");
  const summary = session.summary();
  assert.equal(summary.status, "done");
  assert.deepEqual(summary.review, { passed: true, attempts: 2 });
});

test("完成审查：连续 FAIL 超过 2 次放行并标记未通过", async () => {
  const { session } = await setup([
    response("写文件。", {
      toolCalls: [
        toolCall("write-1", "Write", "a.txt", { file_path: "a.txt", content: "hello" }),
      ],
    }),
    response("完成。"),
    response("Verdict: FAIL\nIssues:\n- 问题一\nUnconfirmed: 无"),
    response("再修。"),
    response("完成。"),
    response("Verdict: FAIL\nIssues:\n- 问题二\nUnconfirmed: 无"),
    response("还修。"),
    response("完成。"),
    response("Verdict: FAIL\nIssues:\n- 问题三\nUnconfirmed: 无"),
  ], { mode: "trust", completionReview: true });
  await session.sendInput("创建 a.txt");
  const summary = session.summary();
  assert.equal(summary.status, "done");
  assert.deepEqual(summary.review, { passed: false, attempts: 2 });
});

test("完成审查：纯问答（无写操作）不触发", async () => {
  const { session, collector } = await setup([
    response("1+1 等于 2。"),
  ], { completionReview: true });
  await session.sendInput("1+1 等于几？");
  assert.equal(collector.eventsOf("review_result").length, 0);
  assert.equal(session.summary().review, undefined);
});

test("完成审查：默认关闭（运行时无审查环节）", async () => {
  const { session, collector } = await setup([
    response("写文件。", {
      toolCalls: [
        toolCall("write-1", "Write", "a.txt", { file_path: "a.txt", content: "hello" }),
      ],
    }),
    response("完成。"),
  ], { mode: "trust" });
  await session.sendInput("创建 a.txt");
  assert.equal(collector.eventsOf("review_result").length, 0, "默认不触发审查");
  assert.equal(session.summary().review, undefined);
});

test("undoLastEdit：模型编辑后撤销恢复原内容；无记录时拒绝", async () => {
  const { session, cwd } = await setup([
    response("先读后改。", {
      toolCalls: [
        toolCall("read-1", "Read", "sample.txt", {
          file_path: "sample.txt",
        }),
        toolCall("edit-1", "Edit", "sample.txt", {
          file_path: "sample.txt",
          old_string: "hello",
          new_string: "world",
        }),
      ],
    }),
    response("完成。"),
  ]);
  await writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
  await session.sendInput("把 hello 改成 world");
  assert.equal(await readFile(path.join(cwd, "sample.txt"), "utf8"), "world\n");

  const undo = await session.undoLastEdit();
  assert.equal(undo.ok, true);
  if (undo.ok) assert.equal(undo.path, path.join(cwd, "sample.txt"));
  assert.equal(await readFile(path.join(cwd, "sample.txt"), "utf8"), "hello\n");

  // 全部撤销后无记录
  assert.deepEqual(await session.undoLastEdit(), {
    ok: false,
    reason: "empty",
  });
});

test("undoLastEdit：新文件撤销即删除（trust 档 Write 自动放行）", async () => {
  const { session, cwd } = await setup(
    [
      response("新建文件。", {
        toolCalls: [
          toolCall("write-1", "Write", "new.txt", {
            file_path: "new.txt",
            content: "新内容",
          }),
        ],
      }),
      response("完成。"),
    ],
    { mode: "trust" },
  );
  await session.sendInput("创建 new.txt");
  const newPath = path.join(cwd, "new.txt");
  assert.equal(await readFile(newPath, "utf8"), "新内容");

  const undo = await session.undoLastEdit();
  assert.equal(undo.ok, true);
  if (undo.ok) assert.equal(undo.path, newPath);
  await assert.rejects(readFile(newPath, "utf8"), /ENOENT/);
});

test("undoLastEdit：文件被后续修改时拒绝（不撤销用户手动改动）", async () => {
  const { session, cwd } = await setup([
    response("先读后改。", {
      toolCalls: [
        toolCall("read-1", "Read", "sample.txt", {
          file_path: "sample.txt",
        }),
        toolCall("edit-1", "Edit", "sample.txt", {
          file_path: "sample.txt",
          old_string: "hello",
          new_string: "world",
        }),
      ],
    }),
    response("完成。"),
  ]);
  await writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
  await session.sendInput("把 hello 改成 world");
  // 用户事后手动修改（模拟用户编辑）
  await writeFile(path.join(cwd, "sample.txt"), "user-edit\n", "utf8");

  assert.deepEqual(await session.undoLastEdit(), {
    ok: false,
    reason: "modified",
  });
  assert.equal(await readFile(path.join(cwd, "sample.txt"), "utf8"), "user-edit\n");
});
