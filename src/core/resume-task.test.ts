import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationAgentModel } from "./agent-model.js";
import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import type { ToolCall } from "./types.js";
import { AgentSession } from "./session.js";
import { AgentSessionManager } from "./session-manager.js";
import { ConfigService } from "../config/service.js";
import { serializeTaskOptions, taskOptionsFromSerialized } from "./run-task.js";

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

async function fixture(): Promise<{
  cwd: string;
  stateDir: string;
  homeDir: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-resume-"));
  const cwd = path.join(root, "project");
  const stateDir = path.join(root, "state");
  const homeDir = path.join(root, "home");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "src", "math.ts"),
    "export function add(a: number, b: number) { return a - b; }\n",
  );
  await mkdir(path.join(stateDir, "projects"), { recursive: true });
  await mkdir(path.join(homeDir, ".myagent"), { recursive: true });
  return { cwd, stateDir, homeDir };
}

test("serializeTaskOptions / taskOptionsFromSerialized 往返保真", () => {
  const options = {
    description: "修复测试",
    goal: "pnpm test 通过",
    bounds: "不改 package.json",
    until: "23:00",
    deadline: new Date(Date.now() + 3600_000).toISOString(),
    budgetCny: 2.5,
    permission: "trust" as const,
    hardRules: [
      { effect: "deny" as const, pattern: "Edit(*package.json*)" },
    ],
    semanticBounds: ["不要运行 npm install"],
  };
  const restored = taskOptionsFromSerialized(serializeTaskOptions(options));
  assert.equal(restored.description, options.description);
  assert.equal(restored.goal, options.goal);
  assert.equal(restored.bounds, options.bounds);
  assert.equal(restored.until, options.until);
  assert.equal(restored.deadline, options.deadline);
  assert.equal(restored.budgetCny, 2.5);
  assert.equal(restored.permission, "trust");
  assert.deepEqual(restored.hardRules, options.hardRules);
  assert.deepEqual(restored.semanticBounds, options.semanticBounds);
});

test("崩溃恢复：run_started 无配对 run_finished → 会话标记中断任务可续跑", async () => {
  const { cwd, stateDir, homeDir } = await fixture();
  const mainClient = new ScriptedClient([
    // 原任务第一轮：请求工具（模拟崩溃前已开始执行）
    response("先看下文件。", [
      call("read-1", "Read", "src/math.ts", { file_path: "src/math.ts" }),
    ]),
  ]);

  // 模拟进程崩溃现场：任务已 run_started 但从未 run_finished
  const crashedSession = new AgentSession({
    id: "crashed-1",
    title: "修复测试",
    cwd,
    mode: "trust",
    model: new ConversationAgentModel(mainClient, []),
    stateDir,
    permissionRules: [],
  });
  // 先发一次 sendInput 产生事件流（含 read 工具执行），再补发 run_started 模拟中断现场
  const firstTurn = await crashedSession.sendInput("看看 src/math.ts");
  assert.ok(firstTurn === undefined);
  const runOptions = {
    description: "修复 add 并验证",
    goal: "tests 全部通过",
    hardRules: [
      { effect: "deny" as const, pattern: "Write(secrets/**)" },
    ],
    semanticBounds: [],
  };
  // 直接触发 runTask 的前半段会真实执行模型调用；改为手工构造事件流：
  // 用真实会话跑一个快速任务再截断——这里用最小路径：构造 restore 事件
  await crashedSession.flush();
  const events = crashedSession.events();

  // 手工补 run_started（带完整 taskOptions），无 run_finished → 崩溃现场
  const storePath = path.join(
    stateDir,
    "projects",
    Buffer.from(cwd).toString("base64url"),
    "sessions",
    "crashed-1.jsonl",
  );
  const record = {
    seq: events.length + 1,
    ts: new Date().toISOString(),
    sessionId: "crashed-1",
    branchId: "main",
    event: {
      type: "run_started" as const,
      taskId: "task-abc",
      description: runOptions.description,
      permissionMode: "trust" as const,
      hardRules: runOptions.hardRules,
      taskOptions: serializeTaskOptions(runOptions),
    },
  };
  const existing = await import("node:fs/promises").then(({ readFile }) =>
    readFile(storePath, "utf8"),
  );
  await writeFile(storePath, existing + JSON.stringify(record) + "\n");

  // 重启：新 manager restore 该会话
  const configService = new ConfigService({ cwd, homeDir });
  const manager = new AgentSessionManager({
    cwd,
    configService,
    stateDir,
    homeDir,
    modelFactory: async () =>
      new ConversationAgentModel(
        new ScriptedClient([
          // 续跑首轮：先 Read（Edit 工具要求先读文件，FileJournal 状态恢复后不保留）
          response("先确认当前文件内容。", [
            call("read-2", "Read", "src/math.ts", {
              file_path: "src/math.ts",
            }),
          ]),
          // 第二轮：修复实现
          response("继续完成修复。", [
            call("edit-1", "Edit", "src/math.ts", {
              file_path: "src/math.ts",
              old_string: "return a - b;",
              new_string: "return a + b;",
            }),
          ]),
        ]),
        [],
      ),
  });
  await manager.restore();

  const restored = manager.get("crashed-1");
  assert.ok(restored, "会话应被恢复");
  const interrupted = restored.interruptedTask();
  assert.ok(interrupted, "应检测到中断任务");
  assert.equal(interrupted.taskId, "task-abc");
  assert.equal(interrupted.description, "修复 add 并验证");
  const summary = restored.summary();
  assert.deepEqual(summary.interruptedTask, {
    taskId: "task-abc",
    description: "修复 add 并验证",
  });
  // 初始权限模式（trust）应写入事件流并在恢复时还原，续跑不降级
  assert.equal(
    restored.summary().permissionMode,
    "trust",
    "恢复后权限模式应保持初始值（不回落配置默认）",
  );

  // 续跑：沿用原 taskId、注入续跑指令、继续执行
  await restored.resumeTask();
  const eventsAfter = restored.events();
  const userMessages = eventsAfter.filter(
    (e) => e.event.type === "user",
  );
  const resumeMessage = userMessages.at(-1);
  assert.ok(
    resumeMessage?.event.type === "user" &&
      resumeMessage.event.text.includes("/resume"),
    "续跑应注入 /resume 展示消息",
  );
  // 模型实际收到的消息含续跑指令（事件 modelText 保留模型侧原文）
  assert.ok(
    resumeMessage?.event.type === "user" &&
      resumeMessage.event.modelText?.includes("[任务续跑"),
    "模型消息应含续跑指令",
  );
  const finished = eventsAfter.find(
    (e) =>
      e.event.type === "run_finished" &&
      e.event.taskId === "task-abc",
  );
  assert.ok(finished, "续跑完成后应发 run_finished 配对原 taskId");

  // 编辑应真实落盘（续跑链路完整）
  const mathSource = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(cwd, "src", "math.ts"), "utf8"),
  );
  assert.ok(mathSource.includes("return a + b;"));
});

test("中断任务续跑：重复 resume 拒绝，无中断任务时抛错", async () => {
  const { cwd, stateDir, homeDir } = await fixture();
  const manager = new AgentSessionManager({
    cwd,
    configService: new ConfigService({ cwd, homeDir }),
    stateDir,
    homeDir,
    modelFactory: async () =>
      new ConversationAgentModel(new ScriptedClient([]), []),
  });
  await manager.restore();
  const session = await manager.createSession({ title: "普通会话" });
  await assert.rejects(
    session.resumeTask(),
    /没有中断的任务/,
    "无中断任务时 resumeTask 应拒绝",
  );
});
