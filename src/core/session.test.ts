import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
}

async function setup(
  responses: ModelResponse[],
  options: {
    mode?: "normal" | "strict" | "trust";
    permissionRules?: PermissionRule[];
    restoredEvents?: AgentSessionEvent[];
  } = {},
): Promise<{
  session: AgentSession;
  collector: EventCollector;
  cwd: string;
  stateDir: string;
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
    ...(options.permissionRules
      ? { permissionRules: options.permissionRules }
      : {}),
    ...(options.restoredEvents
      ? { restoredEvents: options.restoredEvents }
      : {}),
  });
  const collector = new EventCollector(session);
  return { session, collector, cwd, stateDir };
}

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

test("compact：会话空闲时强制压缩", async () => {
  const { session } = await setup([]);
  // 未配置压缩客户端：compact 返回 false（不报错）
  const compacted = await session.compact();
  assert.equal(compacted, false);
});
