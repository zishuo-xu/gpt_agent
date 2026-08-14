import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import { AgentEventBus } from "./events.js";
import {
  formatSubagentConclusion,
  TaskRunner,
} from "./task-runner.js";
import type { AgentEvent } from "./types.js";

class ScriptedClient implements ModelClient {
  readonly #responses: ModelResponse[];

  constructor(responses: ModelResponse[]) {
    this.#responses = [...responses];
  }

  async complete(_request: CompletionRequest): Promise<ModelResponse> {
    const response = this.#responses.shift();
    if (!response) throw new Error("测试模型没有更多响应");
    return response;
  }
}

function response(
  text: string,
  toolCalls: ModelResponse["toolCalls"] = [],
): ModelResponse {
  return {
    text,
    toolCalls,
    usage: { input: 10, output: 4, cached: 2 },
  };
}

test("TaskRunner 执行独立检索并返回带文件行号的结论", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-task-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "src", "auth.ts"),
    "export function refreshToken() {}\n",
    "utf8",
  );
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  const usage: Array<{ input: number; output: number; cached: number }> = [];
  bus.subscribe((event) => events.push(event));
  const runner = new TaskRunner({
    cwd,
    bus,
    mode: "normal",
    client: new ScriptedClient([
      response("", [
        {
          id: "grep-auth",
          tool: "Grep",
          target: "refreshToken",
          args: {
            pattern: "refreshToken",
            path: ".",
            glob: "**/*.ts",
          },
        },
      ]),
      response(
        "Conclusion: refreshToken 在认证模块。\nKey evidence: src/auth.ts:1\nUnconfirmed: 调用方未检查。",
      ),
    ]),
    reportUsage: (item) => usage.push(item),
  });

  const result = await runner.run(
    {
      description: "定位刷新令牌实现",
      prompt: "查找 refreshToken 的定义位置",
    },
    new AbortController().signal,
  );

  assert.equal(result.isError, false);
  assert.match(String(result.output), /src\/auth\.ts:1/);
  assert.equal(usage.length, 2);
  assert.ok(events.some((event) => event.type === "task_start"));
  const end = events.find((event) => event.type === "task_end");
  assert.equal(end?.type, "task_end");
  if (end?.type === "task_end") {
    assert.equal(end.status, "completed");
    assert.equal(end.toolCalls, 1);
    assert.equal(end.inputTokens, 20);
    assert.equal(end.cachedTokens, 4);
  }
});

test("只读 TaskRunner 拒绝子代理写文件", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-task-readonly-"),
  );
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const runner = new TaskRunner({
    cwd,
    bus,
    mode: "trust",
    client: new ScriptedClient([
      response("", [
        {
          id: "write-note",
          tool: "Write",
          target: "notes.txt",
          args: { filePath: "notes.txt", content: "should not exist" },
        },
      ]),
      response(
        "Conclusion: 写入被只读策略拒绝。\nKey evidence: 无\nUnconfirmed: 无。",
      ),
    ]),
  });

  const result = await runner.run(
    {
      description: "只读审查",
      prompt: "只分析，不修改文件",
      writable: false,
    },
    new AbortController().signal,
  );

  await assert.rejects(access(path.join(cwd, "notes.txt")));
  assert.match(String(result.output), /只读策略拒绝/);
  assert.ok(
    events.some(
      (event) =>
        event.type === "task_event" &&
        event.eventType === "permission_denied",
    ),
  );
});

test("TaskRunner 中途失败时返回部分结论且不向上抛错", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-task-failure-"),
  );
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const runner = new TaskRunner({
    cwd,
    bus,
    mode: "normal",
    client: new ScriptedClient([
      response("部分结论：入口可能在 src/index.ts。", [
        {
          id: "missing-read",
          tool: "Read",
          target: "missing.ts",
          args: { filePath: "missing.ts" },
        },
      ]),
    ]),
  });

  const result = await runner.run(
    {
      description: "失败降级",
      prompt: "检查入口文件",
    },
    new AbortController().signal,
  );

  assert.equal(result.isError, true);
  assert.match(String(result.output), /部分结论/);
  assert.match(String(result.output), /测试模型没有更多响应/);
  const end = events.find((event) => event.type === "task_end");
  assert.equal(end?.type, "task_end");
  if (end?.type === "task_end") assert.equal(end.status, "failed");
});

test("三段式结论解析：完整、缺失段与无结构回退", () => {
  assert.equal(
    formatSubagentConclusion(
      "## Conclusion\n修复了登录 bug。\n## Key evidence\nsrc/auth.ts:1\n## Unconfirmed\n未验证重试路径。",
    ),
    [
      "结论：修复了登录 bug。",
      "关键证据：src/auth.ts:1",
      "未能确认：未验证重试路径。",
    ].join("\n"),
  );
  assert.equal(
    formatSubagentConclusion(
      "Conclusion: 结论 A\nKey evidence: src/a.ts:2\nUnconfirmed: 无。",
    ),
    [
      "结论：结论 A",
      "关键证据：src/a.ts:2",
      "未能确认：无。",
    ].join("\n"),
  );
  assert.equal(
    formatSubagentConclusion("普通文本，没有分段结构"),
    "普通文本，没有分段结构",
  );
});

test("子代理达到最大轮数后强制收尾", async () => {
  class InfiniteClient implements ModelClient {
    calls = 0;
    async complete(): Promise<ModelResponse> {
      this.calls += 1;
      return {
        text: `第 ${this.calls} 轮探索`,
        toolCalls: [
          {
            id: `c${this.calls}`,
            tool: "Read",
            target: "nonexistent.txt",
            args: {},
          },
        ],
        usage: { input: 1, output: 1, cached: 0 },
      };
    }
  }
  const client = new InfiniteClient();
  const runner = new TaskRunner({
    cwd: await mkdtemp(path.join(os.tmpdir(), "myagent-task-maxsteps-")),
    bus: new AgentEventBus(),
    mode: "normal",
    client,
  });
  const result = await runner.run(
    { description: "无限探索任务", prompt: "持续探索" },
    new AbortController().signal,
  );
  assert.equal(client.calls, 40, "模型调用应被 40 轮上限截断");
  assert.match(
    String(result.output ?? result.summary),
    /强制收尾|最大轮数/,
  );
});

test("超过并发上限的子代理被立即拒绝", async () => {
  class GateClient implements ModelClient {
    readonly #pending: Array<(value: ModelResponse) => void> = [];
    async complete(): Promise<ModelResponse> {
      return new Promise((resolve) => {
        this.#pending.push(resolve);
      });
    }
    releaseAll(): void {
      for (const resolve of this.#pending.splice(0)) {
        resolve(response("done", []));
      }
    }
  }
  const client = new GateClient();
  const bus = new AgentEventBus();
  const runner = new TaskRunner({
    cwd: await mkdtemp(path.join(os.tmpdir(), "myagent-task-concurrent-")),
    bus,
    mode: "normal",
    client,
  });
  const signal = new AbortController().signal;
  const pending = Array.from({ length: 4 }, () =>
    runner.run({ description: "并发任务", prompt: "执行" }, signal),
  );
  // 让 4 个 runner 先进入并占用并发计数
  await new Promise((resolve) => setTimeout(resolve, 10));
  const fifth = await runner.run(
    { description: "第五个任务", prompt: "执行" },
    signal,
  );
  assert.equal(fifth.isError, true);
  assert.match(String(fifth.output), /最多 4 个/);
  assert.match(String(fifth.summary), /并发/);
  client.releaseAll();
  const rest = await Promise.all(pending);
  assert.equal(rest.filter((result) => !result.isError).length, 4);
});

test("TaskRunner.steer 传播到活跃子代理：剩余工具调用被拒绝", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-task-steer-"));
  await writeFile(path.join(cwd, "a.txt"), "a\n", "utf8");
  await writeFile(path.join(cwd, "b.txt"), "b\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  let runnerRef: TaskRunner | undefined;
  bus.subscribe((event) => {
    events.push(event);
    // 第一个工具完成后 steer，验证剩余调用被软打断
    if (event.type === "task_event" && event.eventType === "tool_result") {
      runnerRef?.steer();
    }
  });
  const client = new ScriptedClient([
    response("", [
      {
        id: "read-a",
        tool: "Read",
        target: "a.txt",
        args: { filePath: "a.txt" },
      },
      {
        id: "read-b",
        tool: "Read",
        target: "b.txt",
        args: { filePath: "b.txt" },
      },
    ]),
    response("Conclusion: 被 steer 打断。\nKey evidence: a.txt:1\nUnconfirmed: 无。"),
  ]);
  const runner = new TaskRunner({
    cwd,
    bus,
    mode: "normal",
    client,
  });
  runnerRef = runner;

  const result = await runner.run(
    { description: "steer 传播任务", prompt: "读取两个文件" },
    new AbortController().signal,
  );

  assert.equal(result.isError, false);
  // steer 后循环不发 done 也不发起新模型轮：第二个响应不被消费
  const toolResults = events.filter(
    (event) =>
      event.type === "task_event" && event.eventType === "tool_result",
  );
  assert.equal(toolResults.length, 1, "只有第一个 Read 执行");
  assert.ok(
    events.some(
      (event) =>
        event.type === "task_event" &&
        event.eventType === "permission_denied",
    ),
    "第二个 Read 应被 steer 拒绝",
  );
});

test("steerLoops 注册表在 run 结束后清空且跨嵌套共享", async () => {
  class HangClient implements ModelClient {
    release: ((value: ModelResponse) => void) | undefined;
    async complete(): Promise<ModelResponse> {
      return new Promise((resolve) => {
        this.release = resolve;
      });
    }
  }
  const client = new HangClient();
  const steerLoops = new Set<unknown>();
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-task-steerloops-"),
  );
  const runner = new TaskRunner({
    cwd,
    bus: new AgentEventBus(),
    mode: "normal",
    client,
    steerLoops: steerLoops as Set<never>,
  });
  const runPromise = runner.run(
    { description: "注册表任务", prompt: "直接给结论" },
    new AbortController().signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(steerLoops.size, 1, "活跃循环应已注册");
  assert.ok(client.release, "模型调用应已挂起");
  client.release?.(response("Conclusion: 完成。"));
  await runPromise;
  assert.equal(steerLoops.size, 0, "结束后应移除");
});

test("子代理超时软打断：保留已收集结果并标记 reason=timeout", async () => {
  // 模拟真实客户端行为：请求挂起，收到 abort 信号时拒绝（AbortError）
  class AbortableHangClient implements ModelClient {
    async complete(
      request: CompletionRequest,
    ): Promise<ModelResponse> {
      return await new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }
  }
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const runner = new TaskRunner({
    cwd: await mkdtemp(path.join(os.tmpdir(), "myagent-task-timeout-")),
    bus,
    mode: "normal",
    client: new AbortableHangClient(),
    timeoutMs: 300,
  });

  const result = await runner.run(
    { description: "无界探索", prompt: "持续检索" },
    new AbortController().signal,
  );

  assert.equal(result.aborted, true);
  assert.equal(result.isError, true);
  assert.match(String(result.summary), /已超时/);
  const end = events.find((event) => event.type === "task_end");
  assert.equal(end?.type, "task_end");
  if (end?.type === "task_end") {
    assert.equal(end.status, "interrupted");
    assert.equal(end.reason, "timeout");
  }
});

test("writable 子代理继承父会话 deny 规则（/run 硬边界不可绕过）", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-task-deny-"),
  );
  await writeFile(path.join(cwd, "secret.txt"), "top secret");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const runner = new TaskRunner({
    cwd,
    bus,
    mode: "normal",
    // 父会话规则含 deny（模拟用户配置 / /run --bounds 硬边界）
    rules: () => [{ effect: "deny", pattern: "Edit(*secret.txt*)" }],
    client: new ScriptedClient([
      response("", [
        {
          id: "edit-secret",
          tool: "Edit",
          target: "secret.txt",
          args: { filePath: "secret.txt", edits: [] },
        },
      ]),
      response(
        "Conclusion: 目标文件被权限策略拒绝。\nKey evidence: 无\nUnconfirmed: 无。",
      ),
    ]),
  });

  await runner.run(
    {
      description: "修改 secret",
      prompt: "修改 secret.txt",
      writable: true,
    },
    new AbortController().signal,
  );

  assert.equal(
    await readFile(path.join(cwd, "secret.txt"), "utf8"),
    "top secret",
    "子代理不得写入被会话 deny 的文件",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "task_event" &&
        event.eventType === "permission_denied",
    ),
  );
});

test("writable 子代理继承 deny：../ 折叠路径同样被拦截", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-task-deny-dotdot-"),
  );
  await writeFile(path.join(cwd, "secret.txt"), "top secret");
  const bus = new AgentEventBus();
  const runner = new TaskRunner({
    cwd,
    bus,
    mode: "normal",
    rules: () => [{ effect: "deny", pattern: "Edit(*secret.txt*)" }],
    client: new ScriptedClient([
      response("", [
        {
          id: "edit-secret",
          tool: "Edit",
          target: "sub/../secret.txt",
          args: { filePath: "sub/../secret.txt", edits: [] },
        },
      ]),
      response(
        "Conclusion: 目标文件被权限策略拒绝。\nKey evidence: 无\nUnconfirmed: 无。",
      ),
    ]),
  });

  await runner.run(
    {
      description: "修改 secret",
      prompt: "修改 secret.txt",
      writable: true,
    },
    new AbortController().signal,
  );

  assert.equal(
    await readFile(path.join(cwd, "secret.txt"), "utf8"),
    "top secret",
    "路径折叠形态同样受会话 deny 约束",
  );
});
