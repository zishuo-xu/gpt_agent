import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigService } from "../config/service.js";
import { ConversationAgentModel } from "../model/agent-model.js";
import type {
  CompletionRequest,
  ConversationMessage,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import { AgentSessionManager } from "./session-manager.js";
import { AgentSession } from "./session.js";

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

function response(text: string): ModelResponse {
  return {
    text,
    toolCalls: [],
    usage: { input: 12, output: 3, cached: 2 },
  };
}

test("deleteSession 删除会话并清除磁盘文件", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-del-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-del-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-del-home-"),
  );
  const configService = new ConfigService({ cwd, homeDir });
  const manager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    modelFactory: (messages) =>
      new ConversationAgentModel(
        new ScriptedClient([response("完成")]),
        messages,
      ),
  });
  const session = await manager.createSession({ title: "待删除" });
  await session.sendInput("你好");
  await manager.flush();

  const projectKey = Buffer.from(cwd).toString("base64url");
  const sessionsDir = path.join(
    stateDir,
    "projects",
    projectKey,
    "sessions",
  );
  const jsonlPath = path.join(sessionsDir, `${session.id}.jsonl`);
  // 删除前应存在会话文件
  await readFile(jsonlPath, "utf8");
  assert.ok(manager.get(session.id));

  const deleted = await manager.deleteSession(session.id);
  assert.equal(deleted, true);
  assert.equal(manager.get(session.id), undefined);
  // 磁盘文件已删除
  await assert.rejects(() => readFile(jsonlPath, "utf8"));
  // 重复删除返回 false
  assert.equal(await manager.deleteSession(session.id), false);
});

test("AgentSessionManager 通过 index 与 JSONL 恢复会话并继续上下文", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-manager-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-manager-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-manager-home-"),
  );
  const configService = new ConfigService({ cwd, homeDir });
  const firstClient = new ScriptedClient([response("第一轮完成")]);
  const manager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    modelFactory: (messages) =>
      new ConversationAgentModel(firstClient, messages),
  });
  const session = await manager.createSession({
    title: "持久化测试",
    mode: "normal",
  });
  session.setPermissionMode("strict");
  await session.sendInput("第一条");
  await manager.flush();

  const projectKey = Buffer.from(cwd).toString("base64url");
  const indexPath = path.join(
    stateDir,
    "projects",
    projectKey,
    "sessions",
    "index.json",
  );
  const indexText = await readFile(indexPath, "utf8");
  assert.match(indexText, /"title": "持久化测试"/);
  assert.match(indexText, /"permissionMode": "strict"/);

  const restoredClient = new ScriptedClient([response("第二轮完成")]);
  let restoredHistory: ConversationMessage[] = [];
  const restoredManager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    modelFactory: (messages) => {
      restoredHistory = structuredClone(messages);
      return new ConversationAgentModel(restoredClient, messages);
    },
  });
  await restoredManager.restore();

  const restored = restoredManager.get(session.id);
  assert.ok(restored);
  assert.equal(restored.summary().title, "持久化测试");
  assert.equal(restored.summary().permissionMode, "strict");
  assert.equal(restored.summary().totalInputTokens, 12);
  assert.equal(restored.summary().totalCachedTokens, 2);
  assert.equal(restoredHistory[0]?.role, "user");
  assert.equal(restoredHistory[1]?.role, "assistant");

  await restored.sendInput("继续");

  assert.equal(restored.summary().totalInputTokens, 24);
  assert.equal(restoredClient.requests[0]?.messages.at(-1)?.role, "user");
  assert.equal(
    (restoredClient.requests[0]?.messages.at(-1) as { content: string })
      .content,
    "继续",
  );
});

test("压缩事件持久化成本并从摘要与近期对话恢复", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-compact-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-compact-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-compact-home-"),
  );
  const main = new ScriptedClient([
    response("回答一"),
    response("回答二"),
    response("回答三"),
    response("回答四"),
  ]);
  const cheap = new ScriptedClient([
    {
      text: "Task goal: 完成长会话\nCompleted changes: 前两轮已完成",
      toolCalls: [],
      usage: { input: 30, output: 8, cached: 4 },
    },
  ]);
  const session = new AgentSession({
    id: "compact-session",
    title: "压缩恢复",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(main, []),
    compactModelClient: cheap,
    compactAtEstimatedTokens: 100_000,
    // 每轮 ≈ 21 tokens：预算 35 恰好保留最近 2 轮（问题3/问题4）
    keepRecentTokens: 35,
    stateDir,
  });
  for (let index = 1; index <= 4; index += 1) {
    await session.sendInput(`问题${index}`);
  }
  assert.equal(await session.compact(), true);
  await session.flush();

  const compactEvent = session
    .events()
    .find((record) => record.event.type === "context_compacted");
  assert.equal(compactEvent?.event.type, "context_compacted");
  assert.equal(session.summary().totalInputTokens, 78);
  assert.equal(session.summary().totalCachedTokens, 12);

  const configService = new ConfigService({ cwd, homeDir });
  let restoredHistory: ConversationMessage[] = [];
  const restoredManager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    modelFactory: (messages) => {
      restoredHistory = structuredClone(messages);
      return new ConversationAgentModel(
        new ScriptedClient([response("继续")]),
        messages,
      );
    },
  });
  await restoredManager.restore();

  assert.match(
    (restoredHistory[0] as { content: string }).content,
    /会话压缩摘要/,
  );
  assert.ok(
    restoredHistory.some(
      (message) =>
        message.role === "user" && message.content === "问题3",
    ),
  );
  assert.ok(
    restoredHistory.some(
      (message) =>
        message.role === "user" && message.content === "问题4",
    ),
  );
  assert.equal(
    restoredHistory.some(
      (message) =>
        message.role === "user" && message.content === "问题1",
    ),
    false,
  );
});

test("审批等待中 steer：取消挂起审批并优先消费插队消息", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-steer-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-steer-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-steer-home-"),
  );
  const configService = new ConfigService({ cwd, homeDir });
  const client = new ScriptedClient([
    {
      text: "",
      toolCalls: [
        {
          id: "bash-slow",
          tool: "Bash",
          target: "echo slow",
          args: { command: "echo slow" },
        },
      ],
      usage: { input: 10, output: 2, cached: 0 },
    },
    response("steer 后的回答"),
  ]);
  const manager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    modelFactory: (messages) =>
      new ConversationAgentModel(client, messages),
  });
  const session = await manager.createSession({
    title: "steer 解锁",
    mode: "strict",
  });

  const first = session.sendInput("跑个命令");
  // 等待进入审批等待
  const deadline = Date.now() + 2000;
  while (
    session.summary().status !== "waiting_permission" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(session.summary().status, "waiting_permission");

  await session.sendInput("改主意了", undefined, { steer: true });
  await first;

  const events = session.events().map((record) => record.event);
  const queued = events.find((event) => event.type === "user_queued");
  assert.equal(queued?.type, "user_queued");
  if (queued?.type === "user_queued") {
    assert.equal(queued.steer, true);
    assert.equal(queued.text, "改主意了");
  }
  assert.ok(
    events.some(
      (event) =>
        event.type === "permission_denied" &&
        event.reason.includes("steer"),
    ),
    "挂起审批应被 steer 取消",
  );
  assert.ok(
    events.some((event) => event.type === "done"),
    "steer 消息消费后应正常收尾",
  );
  // 插队消息进入下一轮模型请求
  assert.equal(client.requests.length, 2);
  assert.equal(
    (client.requests[1]?.messages.at(-1) as { content: string }).content,
    "改主意了",
  );
});

test("fork 时被放弃路径超过阈值自动生成分支摘要并注入新分支", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-bs-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-bs-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-bs-home-"),
  );
  const main = new ScriptedClient([
    response(`探索回答 ${"x".repeat(25_000)}`), // ≈ 6.3k tokens，超过 5k 阈值
    response("新分支继续"),
  ]);
  const cheap = new ScriptedClient([
    response(
      "Goal: 探索任务\nProgress: 已完成探索\nNext Steps: 回到主线",
    ),
  ]);
  const session = new AgentSession({
    id: "bs-session",
    title: "分支摘要",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(main, []),
    compactModelClient: cheap,
    stateDir,
  });
  await session.sendInput("探索这个仓库");
  // 分裂点：只继承第一条 user 消息；之后的大回复被放弃
  session.forkBranch(1, "回到主线");
  await session.flush();

  assert.equal(
    cheap.requests.length,
    1,
    "被放弃路径超过阈值应触发一次摘要",
  );
  const summarized = session
    .events()
    .find((record) => record.event.type === "branch_summarized");
  assert.equal(summarized?.event.type, "branch_summarized");
  if (summarized?.event.type === "branch_summarized") {
    assert.match(summarized.event.summary, /Goal:/);
    assert.equal(summarized.event.fromBranchId, "main");
  }

  // 摘要注入模型上下文：下一轮请求应携带 [分支摘要] 消息
  await session.sendInput("继续");
  assert.ok(
    main.requests.some((request) =>
      request.messages.some(
        (message) =>
          message.role === "user" &&
          String(message.content).includes("[分支摘要]"),
      ),
    ),
    "分支摘要应作为 user 消息注入模型",
  );

  // 恢复视角：conversationFrom 把 branch_summarized 事件转成摘要消息
  const configService = new ConfigService({ cwd, homeDir });
  let restored: ConversationMessage[] = [];
  const restoredManager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    modelFactory: (messages) => {
      restored = structuredClone(messages);
      return new ConversationAgentModel(
        new ScriptedClient([response("继续")]),
        messages,
      );
    },
  });
  await restoredManager.restore();
  assert.ok(
    restored.some(
      (message) =>
        message.role === "user" &&
        String(message.content).includes("[分支摘要]"),
    ),
    "恢复后摘要消息应存在于模型历史",
  );
});

test("被放弃路径小于阈值不触发分支摘要", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-bs2-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-bs2-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-bs2-home-"),
  );
  const main = new ScriptedClient([response("短回答")]);
  const cheap = new ScriptedClient([response("摘要")]);
  const session = new AgentSession({
    id: "bs2-session",
    title: "小路径",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(main, []),
    compactModelClient: cheap,
    stateDir,
  });
  await session.sendInput("hi");
  session.forkBranch(1);
  await session.flush();
  assert.equal(
    cheap.requests.length,
    0,
    "小路径不应浪费 cheap 调用",
  );
});

test("会话标题写入事件流并在恢复时优先于 index.json", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-info-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-info-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-info-home-"),
  );
  const main = new ScriptedClient([response("回答一")]);
  const session = new AgentSession({
    id: "info-session",
    title: "初始标题",
    cwd,
    mode: "normal",
    model: new ConversationAgentModel(main, []),
    stateDir,
  });
  await session.sendInput("问题");
  session.setTitle("事件流标题");
  await session.flush();

  // 事件流包含 session_info 事件
  assert.ok(
    session
      .events()
      .some(
        (record) =>
          record.event.type === "session_info" &&
          record.event.name === "事件流标题",
      ),
    "setTitle 应写入 session_info 事件",
  );
  assert.equal(session.summary().title, "事件流标题");

  // 恢复：即使 index.json 标题不同，也以事件流为准
  const configService = new ConfigService({ cwd, homeDir });
  let restoredTitle = "";
  const restoredManager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    modelFactory: (messages) =>
      new ConversationAgentModel(
        new ScriptedClient([response("继续")]),
        messages,
      ),
  });
  const restored = restoredManager.get("info-session");
  if (!restored) {
    await restoredManager.restore();
  }
  const target = restoredManager.get("info-session");
  assert.ok(target, "会话应被恢复");
  assert.equal(
    target?.summary().title,
    "事件流标题",
    "恢复后标题应来自事件流",
  );
});
