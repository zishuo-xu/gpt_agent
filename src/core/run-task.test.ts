import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationAgentModel } from "../model/agent-model.js";
import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import {
  parseRunCommand,
  TaskBox,
  type RunTaskOptions,
} from "./run-task.js";
import { AgentSession } from "./session.js";
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
  usage = { input: 20, output: 5, cached: 0 },
): ModelResponse {
  return { text, toolCalls, usage };
}

test("/run 解析引号参数、未来时间与路径硬边界", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const task = parseRunCommand(
    '/run 提升检索质量 --goal "npm test 全过" --bounds "不改 src/api/，不动数据库 schema" --until 14:30 --budget 5 --permission trust',
    now,
  );

  assert.equal(task.description, "提升检索质量");
  assert.equal(task.goal, "npm test 全过");
  assert.equal(task.budgetCny, 5);
  assert.equal(task.permission, "trust");
  assert.ok(Date.parse(task.deadline ?? "") > now.getTime());
  assert.deepEqual(
    task.hardRules.map((rule) => rule.pattern),
    [
      "Edit(*src/api/*)",
      "MultiEdit(*src/api/*)",
      "Write(*src/api/*)",
    ],
  );
  assert.deepEqual(task.semanticBounds, ["不动数据库 schema"]);
});

test("/run 边界为“不改任何文件”时生成全量写保护", () => {
  const task = parseRunCommand(
    '/run 检查代码 --bounds "不改任何文件" --permission trust',
  );
  assert.deepEqual(
    task.hardRules.map((rule) => rule.pattern),
    [
      "Edit(**)",
      "MultiEdit(**)",
      "Write(**)",
    ],
  );
  const projectWide = parseRunCommand(
    '/run 检查代码 --bounds "不改整个项目"',
  );
  assert.equal(projectWide.hardRules.length, 3);
});

test("TaskBox 按 30/10/2 分钟阶段收尾并在截止时硬停", () => {
  const deadline = new Date("2026-07-30T13:00:00.000Z");
  const options: RunTaskOptions = {
    description: "持续优化",
    deadline: deadline.toISOString(),
    hardRules: [],
    semanticBounds: [],
  };
  const box = new TaskBox(options, 0);

  assert.equal(
    box.check(deadline.getTime() - 25 * 60_000, 0).level,
    "narrow",
  );
  assert.equal(
    box.check(deadline.getTime() - 8 * 60_000, 0).level,
    "wrapup",
  );
  assert.equal(
    box.check(deadline.getTime() - 60_000, 0).finalOnly,
    true,
  );
  assert.equal(box.check(deadline.getTime() + 1, 0).stop, true);
});

test("无人值守预算耗尽后禁止新工具并恢复原权限档", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-run-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-run-state-"),
  );
  await writeFile(path.join(cwd, "input.txt"), "ready\n", "utf8");
  const client = new ScriptedClient([
    response(
      "",
      [
        {
          id: "read",
          tool: "Read",
          target: "input.txt",
          args: { filePath: "input.txt" },
        },
      ],
      { input: 1_000_000, output: 0, cached: 0 },
    ),
    response("", [
      {
        id: "late-write",
        tool: "Write",
        target: "late.txt",
        args: { filePath: "late.txt", content: "too late" },
      },
    ]),
    response("预算已耗尽，输出最终总结。"),
  ]);
  const session = new AgentSession({
    id: "run-test",
    title: "预算任务",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir,
    pricing: {
      main: {
        inputPerMillionCny: 1,
        outputPerMillionCny: 1,
        cachedInputPerMillionCny: 0.2,
      },
    },
  });
  const events: AgentEvent[] = [];
  session.subscribe((record) => events.push(record.event));

  await session.runTask({
    description: "预算内完成检查",
    budgetCny: 0.5,
    permission: "trust",
    hardRules: [],
    semanticBounds: [],
  });

  await assert.rejects(access(path.join(cwd, "late.txt")));
  assert.equal(session.summary().permissionMode, "normal");
  assert.ok(
    Math.abs(session.summary().totalCostCny - 1.00005) < 1e-9,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "wrapup_warning" &&
        event.reason === "budget" &&
        event.level === "final",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "permission_denied" &&
        event.call.id === "late-write",
    ),
  );
  const finished = events.find(
    (event) => event.type === "run_finished",
  );
  assert.equal(finished?.type, "run_finished");
  if (finished?.type === "run_finished") {
    assert.equal(finished.status, "completed");
    assert.equal(finished.reason, "budget");
  }
});

test("审批超时自动拒绝并让 Agent 继续收尾", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-approval-timeout-"),
  );
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-approval-timeout-state-"),
  );
  const client = new ScriptedClient([
    response("", [
      {
        id: "side-effect",
        tool: "Bash",
        target: "echo changed > changed.txt",
        args: { command: "echo changed > changed.txt" },
      },
    ]),
    response("审批超时，未执行命令；任务已安全收尾。"),
  ]);
  const session = new AgentSession({
    id: "timeout-test",
    title: "审批超时",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir,
    approvalTimeoutMs: 5,
  });
  const events: AgentEvent[] = [];
  session.subscribe((record) => events.push(record.event));

  await session.sendInput("执行任务");

  await assert.rejects(access(path.join(cwd, "changed.txt")));
  assert.ok(
    events.some(
      (event) =>
        event.type === "permission_denied" &&
        event.call.id === "side-effect",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "text_delta" &&
        event.text.includes("安全收尾"),
    ),
  );
  assert.equal(session.summary().status, "done");

  const projectKey = Buffer.from(cwd).toString("base64url");
  const tracePath = path.join(
    stateDir,
    "projects",
    projectKey,
    "sessions",
    "timeout-test.trace.jsonl",
  );
  const traces = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
  assert.equal(traces.length, 2);
  assert.match(String(traces[0]?.request?.system), /MyAgent/);
  assert.equal(
    traces[0]?.tools?.[0]?.permission,
    "user_denied",
  );
});
