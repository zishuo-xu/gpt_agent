import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationAgentModel } from "../model/agent-model.js";
import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import type { ToolCall } from "./types.js";
import { WebAgentSession } from "../web/sessions.js";

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
  toolCalls: ToolCall[] = [],
  usage = { input: 800, output: 120, cached: 200 },
): ModelResponse {
  return { text, toolCalls, usage };
}

function call(
  id: string,
  tool: ToolCall["tool"],
  target: string,
  args: Record<string, unknown>,
): ToolCall {
  return { id, tool, target, args };
}

async function createProjectFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-e2e-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "tests"), { recursive: true });

  await writeFile(
    path.join(dir, "src", "math.ts"),
    [
      "export function add(a: number, b: number): number {",
      "  return a - b;",
      "}",
      "",
      "export function multiply(a: number, b: number): number {",
      "  return a * b;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(dir, "tests", "math.test.ts"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { add, multiply } from "../src/math.ts";',
      "",
      'test("add", () => {',
      "  assert.equal(add(2, 3), 5);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture-project", type: "module" }, null, 2),
    "utf8",
  );

  return dir;
}

test("端到端：修复 bug 完整工作流（todo + 读取 + 搜索 + 编辑 + 验证 + 成本）", async () => {
  const cwd = await createProjectFixture();
  const stateDir = path.join(cwd, ".state");
  const verifyCmd = `${process.execPath} -e "const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');if(!s.includes('a + b'))process.exit(1)" ${path.join(cwd, "src", "math.ts")}`;

  const mainClient = new ScriptedClient([
    response("让我先了解项目结构，然后定位并修复这个 bug。", [
      call("todo-1", "TodoWrite", "3 items", {
        todos: [
          { id: "locate", content: "定位 add 函数的 bug", status: "in_progress" },
          { id: "fix", content: "修复 src/math.ts 中的实现", status: "pending" },
          { id: "verify", content: "运行测试验证修复", status: "pending" },
        ],
      }),
    ], { input: 1200, output: 200, cached: 0 }),

    response("先看看测试文件和源码。", [
      call("read-test", "Read", "tests/math.test.ts", { filePath: "tests/math.test.ts" }),
      call("read-src", "Read", "src/math.ts", { filePath: "src/math.ts" }),
    ], { input: 1500, output: 80, cached: 800 }),

    response("搜索一下是否有其他文件引用了 add 函数。", [
      call("grep-1", "Grep", "add\\(", { pattern: "add\\(", path: cwd }),
    ], { input: 2000, output: 60, cached: 1200 }),

    response("找到问题了：add 函数用了减法。修复它。", [
      call("edit-1", "Edit", "src/math.ts", {
        filePath: "src/math.ts",
        oldString: "  return a - b;",
        newString: "  return a + b;",
      }),
      call("todo-2", "TodoWrite", "3 items", {
        todos: [
          { id: "locate", content: "定位 add 函数的 bug", status: "completed" },
          { id: "fix", content: "修复 src/math.ts 中的实现", status: "completed" },
          { id: "verify", content: "运行测试验证修复", status: "in_progress" },
        ],
      }),
    ], { input: 2200, output: 150, cached: 1500 }),

    response("运行验证命令。", [
      call("bash-verify", "Bash", verifyCmd, { command: verifyCmd }),
    ], { input: 2500, output: 50, cached: 1800 }),

    response("修复完成。", [
      call("todo-3", "TodoWrite", "3 items", {
        todos: [
          { id: "locate", content: "定位 add 函数的 bug", status: "completed" },
          { id: "fix", content: "修复 src/math.ts 中的实现", status: "completed" },
          { id: "verify", content: "运行测试验证修复", status: "completed" },
        ],
      }),
    ], { input: 2800, output: 100, cached: 2000 }),

    response("任务已完成，所有验证通过。", [], { input: 3000, output: 30, cached: 2200 }),
  ]);

  const session = new WebAgentSession({
    id: "e2e-fix-test",
    title: "修复 math 测试",
    cwd,
    mode: "trust",
    model: new ConversationAgentModel(mainClient, []),
    stateDir,
    permissionRules: [],
  });

  const costEvents: Array<{ input: number; output: number }> = [];
  session.subscribe((event) => {
    if (event.event.type === "cost_update") {
      costEvents.push({ input: event.event.input, output: event.event.output });
    }
  });

  await session.sendInput(
    "tests/math.test.ts 里的 add 测试失败了，帮我修复 src/math.ts 中的 bug 并验证",
  );

  const summary = session.summary();
  assert.equal(summary.status, "done");

  const fixedSource = await readFile(path.join(cwd, "src", "math.ts"), "utf8");
  assert.ok(fixedSource.includes("return a + b;"), "add 函数应使用加法");
  assert.ok(!fixedSource.includes("return a - b;"), "不应残留减法实现");

  assert.equal(summary.todos.length, 3);
  assert.ok(summary.todos.every((todo) => todo.status === "completed"));

  // TodoWrite x3 + Read x2 + Grep x1 + Edit x1 + Bash x1 = 8
  assert.equal(summary.toolCallCount, 8);

  assert.ok(summary.totalInputTokens > 0);
  assert.ok(summary.totalOutputTokens > 0);
  assert.ok(summary.totalCachedTokens > 0);
  assert.ok(costEvents.length >= 5, "每轮都应有 cost_update 事件");

  const events = session.events();
  const eventTypes = events.map((event) => event.event.type);
  assert.ok(eventTypes.includes("user"), "应有用户消息事件");
  assert.ok(eventTypes.includes("text_delta"), "应有文本输出事件");
  assert.ok(eventTypes.includes("tool_call"), "应有工具调用事件");
  assert.ok(eventTypes.includes("tool_result"), "应有工具结果事件");
  assert.ok(eventTypes.includes("todo_update"), "应有 todo 更新事件");
  assert.ok(eventTypes.includes("cost_update"), "应有成本更新事件");
  assert.ok(eventTypes.includes("done"), "应有完成事件");

  const lastRequest = mainClient.requests.at(-1);
  assert.ok(lastRequest, "模型应收到多轮请求");
  assert.ok(
    lastRequest.messages.some((message) => message.role === "tool"),
    "后续轮次应包含工具结果消息",
  );
});

test("端到端：strict 档多步审批流程", async () => {
  const cwd = await createProjectFixture();
  const stateDir = path.join(cwd, ".state-strict");

  const mainClient = new ScriptedClient([
    response("先读取文件。", [
      call("read-strict", "Read", "src/math.ts", { filePath: "src/math.ts" }),
    ]),
    response("我来修改文件。", [
      call("edit-strict", "Edit", "src/math.ts", {
        filePath: "src/math.ts",
        oldString: "  return a - b;",
        newString: "  return a + b;",
      }),
    ]),
    response("运行验证。", [
      call("bash-strict", "Bash", "echo ok", {
        command: `${process.execPath} -e "console.log('verified')"`,
      }),
    ]),
    response("全部完成。"),
  ]);

  const session = new WebAgentSession({
    id: "e2e-strict",
    title: "strict 审批测试",
    cwd,
    mode: "strict",
    model: new ConversationAgentModel(mainClient, []),
    stateDir,
    permissionRules: [],
  });

  const permissionRequests: Array<{ callId: string; tool: string }> = [];
  let notifyApproval: (() => void) | undefined;

  session.subscribe((event) => {
    if (event.event.type !== "ask_permission") return;
    permissionRequests.push({
      callId: event.event.call.id,
      tool: event.event.call.tool,
    });
    notifyApproval?.();
  });

  const running = session.sendInput("修复 add 函数");

  // Read 在 strict 下自动放行，Edit 需要审批
  await new Promise<void>((resolve) => { notifyApproval = resolve; });
  const first = permissionRequests[0];
  session.resolvePermission(first.callId, true);

  // Bash 需要第二次审批（可能已经到达）
  if (permissionRequests.length < 2) {
    await new Promise<void>((resolve) => { notifyApproval = resolve; });
  }
  session.resolvePermission(permissionRequests[1].callId, {
    granted: true,
    scope: "session",
  });

  await running;

  const summary = session.summary();
  assert.equal(summary.status, "done");
  assert.equal(permissionRequests.length, 2);
  assert.equal(permissionRequests[0].tool, "Edit");
  assert.equal(permissionRequests[1].tool, "Bash");

  const source = await readFile(path.join(cwd, "src", "math.ts"), "utf8");
  assert.ok(source.includes("return a + b;"));
});

test("端到端：无人值守任务盒预算耗尽触发优雅终止", async () => {
  const cwd = await createProjectFixture();
  const stateDir = path.join(cwd, ".state-run");

  const mainClient = new ScriptedClient([
    response("开始工作。", [
      call("read-run", "Read", "src/math.ts", { filePath: "src/math.ts" }),
    ], { input: 5000, output: 100, cached: 0 }),
    response("继续分析。", [
      call("read-run-2", "Read", "tests/math.test.ts", { filePath: "tests/math.test.ts" }),
    ], { input: 5000, output: 100, cached: 0 }),
    response("还在工作。", [
      call("grep-run", "Grep", "add", { pattern: "add", path: cwd }),
    ], { input: 5000, output: 100, cached: 0 }),
    response("总结：预算耗尽。", [], { input: 1000, output: 50, cached: 0 }),
  ]);

  const session = new WebAgentSession({
    id: "e2e-budget",
    title: "预算盒测试",
    cwd,
    mode: "trust",
    model: new ConversationAgentModel(mainClient, []),
    stateDir,
    permissionRules: [],
    pricing: {
      main: {
        inputPerMillionCny: 100,
        outputPerMillionCny: 500,
        cachedInputPerMillionCny: 10,
      },
    },
  });

  session.startRunTask({
    description: "持续优化代码",
    goal: "所有测试通过",
    budgetCny: 0.002,
    permission: "trust",
    hardRules: [],
    semanticBounds: [],
  });

  const finished = new Promise<void>((resolve) => {
    session.subscribe((event) => {
      if (["done", "notify", "error"].includes(event.event.type)) {
        resolve();
      }
    });
  });
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([finished, timeout]);

  const summary = session.summary();
  assert.equal(summary.kind, "run");
  assert.ok(
    summary.status === "done" || summary.status === "interrupted",
    `任务应已终止，实际状态: ${summary.status}`,
  );
});
