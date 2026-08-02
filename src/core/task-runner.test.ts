import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
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
