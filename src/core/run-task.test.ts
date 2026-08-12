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
import { ConversationAgentModel } from "./agent-model.js";
import { ModelRetriesExhaustedError } from "../model/fallback-client.js";
import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import {
  parseRunCommand,
  serializeTaskOptions,
  TaskBox,
  taskOptionsFromSerialized,
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

test("--bounds 中文路径与无斜杠文件名生成硬规则，纯裸词仍是语义边界", () => {
  const task = parseRunCommand(
    '/run 改代码 --bounds "不改 src/中文字段/，不要改 config.json，不动数据库 schema"',
  );
  const patterns = task.hardRules.map((rule) => rule.pattern);
  assert.ok(
    patterns.includes("Edit(*src/中文字段/*)"),
    "中文目录路径应生成硬规则",
  );
  assert.ok(
    patterns.includes("Edit(*config.json*)"),
    "无斜杠文件名（含扩展名）应生成硬规则",
  );
  assert.equal(
    patterns.filter((p) => p.includes("数据库")).length,
    0,
    "纯中文裸词（无路径特征）不应生成硬规则",
  );
  assert.deepEqual(task.semanticBounds, ["不动数据库 schema"]);
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
          args: { file_path: "input.txt" },
        },
      ],
      { input: 1_000_000, output: 0, cached: 0 },
    ),
    response("", [
      {
        id: "late-write",
        tool: "Write",
        target: "late.txt",
        args: { file_path: "late.txt", content: "too late" },
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

test("TaskBox 构造时正确解析 deadline 和 budget", () => {
  const deadline = new Date("2026-07-30T14:00:00.000Z");
  const options: RunTaskOptions = {
    description: "测试任务",
    deadline: deadline.toISOString(),
    budgetCny: 10,
    hardRules: [],
    semanticBounds: [],
  };
  const box = new TaskBox(options, 0);

  assert.equal(box.options.description, "测试任务");
  assert.equal(box.options.deadline, deadline.toISOString());
  assert.equal(box.options.budgetCny, 10);
  assert.ok(box.id.length > 0);
});

test("TaskBox 构造时无 deadline 或 budget 也能正常工作", () => {
  const options: RunTaskOptions = {
    description: "无限制任务",
    hardRules: [],
    semanticBounds: [],
  };
  const box = new TaskBox(options, 0);
  assert.equal(box.options.description, "无限制任务");
  assert.equal(box.options.deadline, undefined);
  assert.equal(box.options.budgetCny, undefined);
});

test("check() 在超过 deadline 时返回 stop=true", () => {
  const deadline = new Date("2026-07-30T13:00:00.000Z");
  const options: RunTaskOptions = {
    description: "截止测试",
    deadline: deadline.toISOString(),
    hardRules: [],
    semanticBounds: [],
  };
  const box = new TaskBox(options, 0);

  const result = box.check(deadline.getTime() + 1, 0);
  assert.equal(result.stop, true);
  assert.equal(result.reason, "deadline");
});

test("check() 在 deadline 前正常返回空决策", () => {
  const deadline = new Date("2026-07-30T14:00:00.000Z");
  const now = new Date("2026-07-30T12:00:00.000Z");
  const options: RunTaskOptions = {
    description: "正常范围测试",
    deadline: deadline.toISOString(),
    hardRules: [],
    semanticBounds: [],
  };
  const box = new TaskBox(options, 0);

  // 距截止还有 2 小时，远超 30 分钟阈值
  const result = box.check(now.getTime(), 0);
  assert.deepEqual(result, {});
});

test("check() 在无 deadline 时始终返回空决策", () => {
  const options: RunTaskOptions = {
    description: "无截止测试",
    hardRules: [],
    semanticBounds: [],
  };
  const box = new TaskBox(options, 0);

  for (const when of [
    0,
    1_000_000_000_000,
    Date.now(),
  ]) {
    assert.deepEqual(box.check(when, 0), {});
  }
});

test("check() 在预算耗尽时返回 budget 决策", () => {
  const options: RunTaskOptions = {
    description: "预算耗尽测试",
    budgetCny: 5,
    hardRules: [],
    semanticBounds: [],
  };
  const box = new TaskBox(options, 0);

  // 花费 >= 预算，剩余 <= 0%
  const result = box.check(Date.now(), 10);
  assert.equal(result.reason, "budget");
  assert.equal(result.level, "final");
  assert.equal(result.finalOnly, true);
});

test("check() 在预算剩余不足 10% 时返回 wrapup 级别", () => {
  const options: RunTaskOptions = {
    description: "预算 wrapup 测试",
    budgetCny: 10,
    hardRules: [],
    semanticBounds: [],
  };
  const box = new TaskBox(options, 0);

  // 花费 9.5，剩余 5% (< 10%)
  const result = box.check(Date.now(), 9.5);
  assert.equal(result.reason, "budget");
  assert.equal(result.level, "wrapup");
});

test("check() 在预算剩余不足 30% 时返回 narrow 级别", () => {
  const options: RunTaskOptions = {
    description: "预算 narrow 测试",
    budgetCny: 10,
    hardRules: [],
    semanticBounds: [],
  };
  const box = new TaskBox(options, 0);

  // 花费 7.5，剩余 25% (< 30%, > 10%)
  const result = box.check(Date.now(), 7.5);
  assert.equal(result.reason, "budget");
  assert.equal(result.level, "narrow");
});

test("check() 在预算充裕时返回空决策", () => {
  const options: RunTaskOptions = {
    description: "预算充裕测试",
    budgetCny: 10,
    hardRules: [],
    semanticBounds: [],
  };
  const box = new TaskBox(options, 0);

  // 花费 2，剩余 80% (> 30%)
  const result = box.check(Date.now(), 2);
  assert.deepEqual(result, {});
});

test("check() 每次调用累计费用 (startCostCny 支持)", () => {
  const options: RunTaskOptions = {
    description: "累计费用测试",
    budgetCny: 10,
    hardRules: [],
    semanticBounds: [],
  };

  // startCostCny = 2，已花费 2
  const box = new TaskBox(options, 2);

  // totalCostCny = 5，实际花费 = 5 - 2 = 3，剩余 7/10 = 70% > 30%
  assert.deepEqual(box.check(Date.now(), 5), {});

  // totalCostCny = 9，实际花费 = 9 - 2 = 7，剩余 3/10 = 30%
  // 30% 刚好等于 narrow 阈值 (remainingRatio <= 0.3)，触发 narrow
  assert.equal(
    box.check(Date.now(), 9).level,
    "narrow",
  );

  // totalCostCny = 11，实际花费 = 11 - 2 = 9，剩余 1/10 = 10%
  // 10% 刚好等于 wrapup 阈值 (remainingRatio <= 0.1)
  const wrapupResult = box.check(Date.now(), 11);
  assert.equal(wrapupResult.level, "wrapup");

  // totalCostCny = 12，实际花费 = 12 - 2 = 10，剩余 0/10 = 0%
  assert.equal(
    box.check(Date.now(), 12).level,
    "final",
  );
});

test("check() 仅首次触发预算阶段，后续相同 key 返回空或 finalOnly", () => {
  const options: RunTaskOptions = {
    description: "去重测试",
    budgetCny: 10,
    hardRules: [],
    semanticBounds: [],
  };
  const box = new TaskBox(options, 0);

  // 第一次触发 final
  const first = box.check(Date.now(), 12);
  assert.equal(first.level, "final");
  assert.equal(first.finalOnly, true);

  // 第二次调用相同 key，因为 finalOnly=true 所以只返回 { finalOnly: true }
  const second = box.check(Date.now(), 12);
  assert.deepEqual(second, { finalOnly: true });
});

test("/run 模型重试+fallback 耗尽时 run_finished 报 failed 而非 completed", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-model-fail-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-model-fail-state-"),
  );
  const client = new ScriptedClient([]);
  // 让模型调用抛 ModelRetriesExhaustedError（error-policy 判 fatal 直接上抛）
  client.complete = async () => {
    throw new ModelRetriesExhaustedError(
      new Error("余额不足（模拟）"),
      3,
    );
  };
  const session = new AgentSession({
    id: "model-fail",
    title: "模型失败",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir,
  });
  const events: AgentEvent[] = [];
  session.subscribe((record) => events.push(record.event));

  await session.runTask({
    description: "跑不动的任务",
    permission: "trust",
    hardRules: [],
    semanticBounds: [],
  });

  const finished = events.find(
    (event) => event.type === "run_finished",
  );
  assert.equal(finished?.type, "run_finished");
  if (finished?.type === "run_finished") {
    assert.equal(finished.status, "failed", "模型耗尽应记为失败");
    assert.equal(finished.reason, "error");
  }
  assert.ok(
    events.some(
      (event) =>
        event.type === "notify" && event.level === "error",
    ),
    "应发出 error 级通知",
  );
});

test("parseRunCommand --approve-timeout / --auto-allow 解析与校验", () => {
  const task = parseRunCommand(
    '/run 巡检 --approve-timeout 30 --auto-allow "Bash(pnpm*),Read(*)"',
  );
  assert.equal(task.approveTimeoutMs, 30_000);
  assert.deepEqual(task.autoAllowRules, ["Bash(pnpm*)", "Read(*)"]);
  assert.throws(
    () => parseRunCommand("/run x --approve-timeout 3"),
    /--approve-timeout/,
  );
  assert.throws(
    () => parseRunCommand("/run x --auto-allow ",""),
    /--auto-allow/,
  );
  // 序列化往返（崩溃恢复续跑语义一致）
  const serialized = serializeTaskOptions(task);
  const restored = taskOptionsFromSerialized(serialized);
  assert.equal(restored.approveTimeoutMs, 30_000);
  assert.deepEqual(restored.autoAllowRules, ["Bash(pnpm*)", "Read(*)"]);
});

test("任务级 --approve-timeout 覆盖会话级超时，任务结束后恢复", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-task-approve-timeout-"),
  );
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-task-approve-timeout-state-"),
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
    id: "task-timeout",
    title: "任务级超时",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir,
    // 会话级 60s：若任务级覆盖失效，测试会在审批上等 60s 超时
    approvalTimeoutMs: 60_000,
  });
  const events: AgentEvent[] = [];
  session.subscribe((record) => events.push(record.event));

  await session.runTask({
    description: "写文件验证超时",
    hardRules: [],
    semanticBounds: [],
    approveTimeoutMs: 50,
  });

  assert.ok(
    events.some(
      (event) =>
        event.type === "permission_denied" &&
        event.call.id === "side-effect",
    ),
    "任务级 50ms 超时应拒绝审批",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "notify" &&
        event.level === "warn" &&
        /0\.0?5s 无人响应/.test(event.message),
    ),
    "超时通知应显示任务级超时值（0.05s）",
  );
  await assert.rejects(access(path.join(cwd, "changed.txt")));
});

test("--auto-allow 任务期放行指定工具，任务结束后回落", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-auto-allow-"),
  );
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-auto-allow-state-"),
  );
  const call = {
    id: "side-effect",
    tool: "Bash",
    target: "echo changed > changed.txt",
    args: { command: "echo changed > changed.txt" },
  };
  const client = new ScriptedClient([
    response("", [call]),
    response("任务完成。"),
    response("", [call]),
    response("已拒绝。"),
  ]);
  const session = new AgentSession({
    id: "auto-allow",
    title: "任务期白名单",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir,
    approvalTimeoutMs: 100,
  });
  const events: AgentEvent[] = [];
  session.subscribe((record) => events.push(record.event));
  const hasAsk = () =>
    events.some(
      (event) => event.type === "ask_permission" && event.call.id === "side-effect",
    );
  const hasDenied = () =>
    events.some(
      (event) =>
        event.type === "permission_denied" && event.call.id === "side-effect",
    );

  // 任务期：auto-allow 命中 → 直接执行，无审批请求
  await session.runTask({
    description: "写文件",
    hardRules: [],
    semanticBounds: [],
    autoAllowRules: ["Bash(echo changed*)"],
  });
  assert.equal(hasAsk(), false, "任务期内应被 auto-allow 放行");
  assert.equal(hasDenied(), false);
  await access(path.join(cwd, "changed.txt"));

  // 任务结束：规则回落 → 同样的命令重新要求审批（100ms 超时拒绝）
  await session.sendInput("再执行一次");
  assert.equal(hasAsk(), true, "任务结束后规则应回落，命令重新要求审批");
  assert.equal(hasDenied(), true, "无响应时按会话级超时拒绝");
});

test("硬停止回滚只撤销任务期编辑——任务前交互编辑保留", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-rollback-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-rollback-state-"),
  );
  await writeFile(path.join(cwd, "keep.txt"), "original\n", "utf8");
  // 已过期的截止：任务第一轮 beforeTurn 即硬停止（TaskBox 的 final 窗口为截止前 2 分钟，
  // 真实时间下无法让任务期先执行工具再跨过截止，故本用例聚焦修复核心：
  // 任务前交互编辑不得被硬停止回滚——旧逻辑 while(entries>0) 会把 keep.txt 一并回滚）
  const deadline = new Date(Date.now() - 1000).toISOString();
  const client = new ScriptedClient([
    // 任务前交互轮：Read 后 Write keep.txt（应保留，不得被回滚）
    response("", [
      {
        id: "read-keep",
        tool: "Read",
        target: "keep.txt",
        args: { file_path: "keep.txt" },
      },
    ]),
    response("", [
      {
        id: "write-keep",
        tool: "Write",
        target: "keep.txt",
        args: { file_path: "keep.txt", content: "interactive edit\n" },
      },
    ]),
    response("完成。"),
  ]);
  const session = new AgentSession({
    id: "rollback-test",
    title: "回滚测试",
    cwd,
    mode: "trust",
    model: new ConversationAgentModel(client, []),
    stateDir,
  });
  const events: AgentEvent[] = [];
  session.subscribe((record) => events.push(record.event));

  await session.sendInput("请修改 keep.txt");
  assert.equal(
    await readFile(path.join(cwd, "keep.txt"), "utf8"),
    "interactive edit\n",
    "任务前交互编辑应先成功落盘",
  );

  await session.runTask({
    description: "写文件后超时",
    deadline,
    permission: "trust",
    hardRules: [],
    semanticBounds: [],
  });

  // 任务前交互编辑保留（旧逻辑 while(entries>0) 会把 keep.txt 一并回滚）
  assert.equal(
    await readFile(path.join(cwd, "keep.txt"), "utf8"),
    "interactive edit\n",
    "任务前交互编辑不得被硬停止回滚",
  );
  const finished = events.find(
    (event) => event.type === "run_finished",
  );
  assert.equal(finished?.type, "run_finished");
  if (finished?.type === "run_finished") {
    assert.equal(finished.status, "interrupted");
    assert.equal(finished.reason, "deadline");
  }
});

test("任务执行账本：/run 中 Write 触发 ledger_update（系统自动记账链路）", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-ledger-"),
  );
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-ledger-state-"),
  );
  const client = new ScriptedClient([
    response("", [
      {
        id: "w1",
        tool: "Write",
        target: "out.txt",
        args: { file_path: "out.txt", content: "ledger" },
      },
    ]),
    response("任务完成"),
  ]);
  const session = new AgentSession({
    id: "ledger-test",
    title: "账本任务",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir,
  });
  const events: AgentEvent[] = [];
  session.subscribe((record) => events.push(record.event));

  await session.runTask({
    description: "写一个文件",
    permission: "trust",
    hardRules: [],
    semanticBounds: [],
  });

  // 文件确实写入
  assert.equal(await readFile(path.join(cwd, "out.txt"), "utf8"), "ledger");

  // ledger_update 事件出现且单元为规范化相对路径 + done 状态
  const updates = events.filter(
    (event): event is Extract<AgentEvent, { type: "ledger_update" }> =>
      event.type === "ledger_update",
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.unit.id, "out.txt");
  assert.equal(updates[0]?.unit.kind, "file");
  assert.equal(updates[0]?.unit.status, "done");
  assert.match(updates[0]?.unit.note ?? "", /待验证/);
});

test("账本恢复：进程重启后 restore 重放 ledger_update 事件重建账本", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-ledger-restore-"),
  );
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-ledger-restore-state-"),
  );
  const client = new ScriptedClient([
    response("", [
      {
        id: "w1",
        tool: "Write",
        target: "src/one.ts",
        args: { file_path: "src/one.ts", content: "// one" },
      },
    ]),
    response("任务完成"),
  ]);
  const first = new AgentSession({
    id: "restore-a",
    title: "第一段",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(client, []),
    stateDir,
  });
  const records: Array<{ seq: number; ts: string; event: AgentEvent }> = [];
  first.subscribe((record) => records.push(record));

  await first.runTask({
    description: "写文件",
    permission: "trust",
    hardRules: [],
    semanticBounds: [],
  });
  const started = records.find(
    (record) => record.event.type === "run_started",
  );
  assert.ok(started);
  const taskId =
    started?.event.type === "run_started" ? started.event.taskId : "";

  // 模拟进程重启：用事件流记录重建会话（restore 路径）
  const second = new AgentSession({
    id: "restore-b",
    title: "第二段",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(new ScriptedClient([]), []),
    stateDir,
    restoredEvents: records as Parameters<typeof AgentSession>[0]["restoredEvents"],
  });

  // 账本从事件流投影重建：单元为 done（系统自动记录）
  const ledger = second.ledgerFor(taskId);
  assert.ok(ledger, "restore 后应能从事件流重建账本");
  const snapshot = ledger?.snapshot();
  assert.equal(snapshot?.units.length, 1);
  assert.equal(snapshot?.units[0]?.id, "src/one.ts");
  assert.equal(snapshot?.units[0]?.status, "done");
});
