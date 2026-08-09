import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigService } from "../config/service.js";
import { pluginToolRegistry } from "../shared/plugin-tool.js";
import { ConversationAgentModel } from "./agent-model.js";
import type {
  CompletionRequest,
  ConversationMessage,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import {
  AgentSessionManager,
  buildRoleClientChain,
} from "./session-manager.js";
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

test("AgentSessionManager 通过事件流恢复会话并继续上下文", async () => {
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
  // index.json 已废除：元数据只存事件流（显式标题经 createSession → session_info，
  // 权限档经 setPermissionMode → permission_mode_changed）
  await assert.rejects(
    readFile(
      path.join(
        stateDir,
        "projects",
        projectKey,
        "sessions",
        "index.json",
      ),
      "utf8",
    ),
    { code: "ENOENT" },
  );

  const restoredClient = new ScriptedClient([response("第二轮完成")]);
  let restoredHistory: ConversationMessage[] = [];
  // 模拟进程正常退出：释放写锁后（重启）再恢复同一项目
  await manager.releaseLock();
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
  await restoredManager.releaseLock();

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

test("恢复 strict 会话：补发的初始权限模式事件不抢占首条用户消息 seq", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-mode-seq-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-mode-seq-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-mode-seq-home-"),
  );
  const configService = new ConfigService({ cwd, homeDir });
  const manager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    modelFactory: (messages) =>
      new ConversationAgentModel(
        new ScriptedClient([response("第一轮完成")]),
        messages,
      ),
  });
  // 创建时权限档为 normal：事件流不含 permission_mode_changed
  const session = await manager.createSession({
    title: "seq 冲突测试",
    mode: "normal",
  });
  await session.sendInput("第一条");
  await manager.flush();
  await manager.releaseLock();

  // 项目配置改为 strict：恢复时构造器需补发初始权限模式事件
  await mkdir(path.join(homeDir, ".myagent"), { recursive: true });
  await writeFile(
    path.join(homeDir, ".myagent", "config.jsonc"),
    JSON.stringify({
      permissions: { mode: "strict", rules: [], approvalTimeoutMs: 60000 },
    }),
    "utf8",
  );

  const restoredManager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService: new ConfigService({ cwd, homeDir }),
    modelFactory: (messages) =>
      new ConversationAgentModel(
        new ScriptedClient([response("第二轮完成")]),
        messages,
      ),
  });
  await restoredManager.restore();
  const restored = restoredManager.get(session.id);
  assert.ok(restored);
  assert.equal(restored.summary().permissionMode, "strict");
  const events = restored.events();
  // 补发的权限模式事件必须排在恢复事件之后：不能抢占首条事件，
  // 否则与既有 seq 冲突会被前端按 seq 去重丢弃
  assert.notEqual(
    events[0]?.event.type,
    "permission_mode_changed",
    "首条事件不应是补发的权限模式事件",
  );
  const seqs = events.map((record) => record.seq);
  assert.equal(new Set(seqs).size, seqs.length, "seq 不应重复");
  const modeEvents = events.filter(
    (record) => record.event.type === "permission_mode_changed",
  );
  assert.equal(modeEvents.length, 1, "应恰好补发一次权限模式事件");
  const userSeq =
    events.find((record) => record.event.type === "user")?.seq ?? 0;
  assert.ok(
    (modeEvents[0]?.seq ?? 0) > userSeq,
    "补发事件 seq 应大于首条用户消息",
  );
  await restoredManager.releaseLock();
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

test("会话标题写入事件流并在恢复时还原", async () => {
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

  // 恢复：标题以事件流为准（index.json 已废除，事件流是唯一来源）
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

test("单实例写锁：同项目第二个 manager 报错，--force 跳过，释放后可再获取", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-lock-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-lock-home-"),
  );
  const configService = new ConfigService({ cwd, homeDir });
  const first = new AgentSessionManager({ cwd, stateDir, homeDir, configService });
  await first.restore();

  // 锁文件已写入 pid
  const lockPath = path.join(
    stateDir,
    "projects",
    Buffer.from(cwd).toString("base64url"),
    "lock",
  );
  const lockContent = JSON.parse(
    await readFile(lockPath, "utf8"),
  ) as { pid: number };
  assert.equal(lockContent.pid, process.pid);

  // 第二个 manager 同项目：拒绝（报错含占用提示与锁路径）
  const second = new AgentSessionManager({ cwd, stateDir, homeDir, configService });
  await assert.rejects(
    second.restore(),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("已被其他进程占用") &&
      error.message.includes("lock"),
  );

  // skipLock（--force 语义）跳过
  const forced = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    skipLock: true,
  });
  await forced.restore();

  // 释放后可重新获取
  await first.releaseLock();
  const third = new AgentSessionManager({ cwd, stateDir, homeDir, configService });
  await third.restore();
  await third.releaseLock();

  // 释放后锁文件已删除
  await assert.rejects(readFile(lockPath, "utf8"));
});

test("buildRoleClientChain：链顺序为 [选中模型, ...fallbacks] 且 pricing 透传", () => {
  const chain = buildRoleClientChain("main", {
    models: {
      main: {
        providerId: "primary",
        model: "main-model",
        pricing: { inputPerMillionCny: 3, outputPerMillionCny: 12 },
        fallbacks: [
          {
            providerId: "backup",
            model: "backup-model",
            pricing: { inputPerMillionCny: 1, outputPerMillionCny: 4 },
          },
        ],
      },
      cheap: { providerId: "primary", model: "cheap-model" },
      explore: { providerId: "primary", model: "explore-model" },
    },
    providers: [
      {
        id: "primary",
        name: "Primary",
        enabled: true,
        protocol: "openai-compatible",
        baseUrl: "https://primary.example.com/v1",
        apiKey: "key",
        models: ["main-model", "cheap-model", "explore-model"],
      },
      {
        id: "backup",
        name: "Backup",
        enabled: true,
        protocol: "openai-compatible",
        baseUrl: "https://backup.example.com/v1",
        apiKey: "key",
        models: ["backup-model"],
      },
    ],
  });

  assert.deepEqual(
    chain.map((item) => item.id),
    ["primary/main-model", "backup/backup-model"],
    "主候选在前，fallback 在后",
  );
  assert.equal(
    chain[0]?.pricing?.outputPerMillionCny,
    12,
    "主候选 pricing 透传",
  );
  assert.equal(
    chain[1]?.pricing?.inputPerMillionCny,
    1,
    "fallback pricing 透传",
  );
});

test("buildRoleClientChain：供应商缺失或不可用时降级为即抛客户端", async () => {
  const chain = buildRoleClientChain("explore", {
    models: {
      main: { providerId: "primary", model: "main-model" },
      cheap: { providerId: "primary", model: "cheap-model" },
      explore: {
        providerId: "ghost",
        model: "ghost-model",
        fallbacks: [
          { providerId: "disabled-provider", model: "off-model" },
        ],
      },
    },
    providers: [
      {
        id: "disabled-provider",
        name: "Disabled",
        enabled: false,
        protocol: "openai-compatible",
        baseUrl: "https://disabled.example.com/v1",
        apiKey: "key",
        models: ["off-model"],
      },
    ],
  });

  assert.equal(chain.length, 2);
  await assert.rejects(
    chain[0]!.client.complete({ messages: [] }),
    /explore 角色引用了不存在的供应商：ghost/,
  );
  await assert.rejects(
    chain[1]!.client.complete({ messages: [] }),
    /已禁用/,
  );
});

test("装配：reloadPlugins 加载 mcpServers 配置，MCP 工具可调用且 closeMcp 清理子进程", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-mcp-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-mcp-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-mcp-home-"),
  );
  const fakeServer = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'greet', description: 'Greet someone', inputSchema: { type: 'object', properties: { who: { type: 'string' } } } }
    ] } });
  } else if (msg.method === 'tools/call') {
    const who = msg.params.arguments.who || 'world';
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'hello ' + who }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
  }
});
`;
  const configService = new ConfigService({ cwd, homeDir });
  const manager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    skipLock: true,
  });
  await manager.restore();
  try {
    // 配置 mcpServers → reloadPlugins 应重连并注册工具
    await mkdir(path.join(homeDir, ".myagent"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".myagent", "plugins.json"),
      JSON.stringify({
        mcpServers: {
          fake: { command: process.execPath, args: ["-e", fakeServer] },
        },
      }),
      "utf8",
    );
    await manager.reloadPlugins();
    const status = manager.pluginStatus();
    assert.equal(status.errors.length, 0, JSON.stringify(status.errors));
    // MCP 工具注册进插件注册表（不列入插件文件 loaded 报告）
    assert.equal(
      pluginToolRegistry.has("fake_greet"),
      true,
      "MCP 工具应注册进插件注册表",
    );
    assert.equal(pluginToolRegistry.isEnabled("fake_greet"), true);

    // MCP 工具通过插件通道调用
    const result = await pluginToolRegistry.execute(
      "fake_greet",
      { who: "agent" },
      new AbortController().signal,
    );
    assert.equal(result.output, "hello agent");
    assert.equal(result.isError, undefined);

    // closeMcp 终止子进程（web server 关闭路径）：连接关闭，注册表条目由 reload 统一清理
    await manager.closeMcp();
    assert.equal(
      pluginToolRegistry.has("fake_greet"),
      true,
      "closeMcp 仅断连接，条目保留到下次 reload",
    );
    const afterClose = await pluginToolRegistry.execute(
      "fake_greet",
      { who: "x" },
      new AbortController().signal,
    );
    assert.equal(afterClose.isError, true, "连接关闭后调用返回失败结果");
  } finally {
    pluginToolRegistry.clear();
    await manager.releaseLock();
  }
});

test("装配：ensurePluginsLoaded 启动即加载且幂等（报告立即可见）", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-plug-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-plug-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-plug-home-"),
  );
  // 真实项目结构：插件以相对路径 import src 模块（与 dist 部署回归同源）
  await mkdir(path.join(cwd, "src", "shared"), { recursive: true });
  await writeFile(
    path.join(cwd, "src", "shared", "plugin-tool.ts"),
    "export function definePluginTool<T>(tool: T): T { return tool; }\n",
    "utf8",
  );
  await mkdir(path.join(cwd, ".myagent", "tools"), { recursive: true });
  await writeFile(
    path.join(cwd, ".myagent", "tools", "startup.ts"),
    `import { definePluginTool } from "../../src/shared/plugin-tool.js";\n` +
      `export default definePluginTool({ name: "Startup", description: "启动加载", inputSchema: { type: "object" }, async run() { return { summary: "ok" }; } });\n`,
    "utf8",
  );

  const configService = new ConfigService({ cwd, homeDir });
  const manager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    skipLock: true,
  });
  await manager.restore();

  // 启动即加载：不触发任何模型请求，报告直接可见
  await manager.ensurePluginsLoaded();
  const status = manager.pluginStatus();
  assert.equal(status.errors.length, 0, JSON.stringify(status.errors));
  assert.deepEqual(status.loaded.map((item) => item.name), ["Startup"]);

  // 幂等：再次调用不重复加载（报告与注册表状态不变）
  await manager.ensurePluginsLoaded();
  const again = manager.pluginStatus();
  assert.deepEqual(again.loaded.map((item) => item.name), ["Startup"]);
  assert.equal(again.loaded.length, 1);
  pluginToolRegistry.clear();
  await manager.releaseLock();
});

test("恢复后事件 seq 与磁盘对齐：缺号恢复不产生重复或空洞", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-seqgap-cwd-"));
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-seqgap-state-"),
  );
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-seqgap-home-"),
  );
  const configService = new ConfigService({ cwd, homeDir });
  const manager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService,
    modelFactory: (messages) =>
      new ConversationAgentModel(
        new ScriptedClient([response("第一轮完成")]),
        messages,
      ),
  });
  const session = await manager.createSession({ title: "seq 对齐测试" });
  await session.sendInput("第一条");
  await manager.flush();
  await manager.releaseLock();

  // 模拟磁盘缺号：删除事件流中的 seq=4（cost_update，类似崩溃时某事件分配了 seq 但未落盘）
  const filePath = path.join(
    stateDir,
    "projects",
    Buffer.from(cwd).toString("base64url"),
    "sessions",
    `${session.id}.jsonl`,
  );
  const records = (await readFile(filePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { seq: number; event: { type: string } });
  const withGap = records.filter((record) => record.seq !== 4);
  await writeFile(filePath, withGap.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const lastDiskSeq = withGap.at(-1)!.seq;
  // 恢复后继续发事件：新事件 seq 必须严格递增且不与既有 seq 重复
  const restoredManager = new AgentSessionManager({
    cwd,
    stateDir,
    homeDir,
    configService: new ConfigService({ cwd, homeDir }),
    modelFactory: (messages) =>
      new ConversationAgentModel(
        new ScriptedClient([response("第二轮完成")]),
        messages,
      ),
  });
  await restoredManager.restore();
  const restored = restoredManager.get(session.id);
  assert.ok(restored);
  await restored.sendInput("第二条");
  await restoredManager.flush();

  const events = restored.events();
  const seqs = events.map((record) => record.seq);
  assert.equal(new Set(seqs).size, seqs.length, "seq 不应重复");
  const lastSeq = seqs.at(-1) ?? 0;
  assert.ok(
    seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!),
    `seq 应严格递增，实际: ${seqs.join(",")}`,
  );
  // 与磁盘对齐：新事件 seq 必须续在磁盘最后 seq 之后（缺号不吞新号、不复用旧号）
  assert.ok(
    lastSeq > lastDiskSeq,
    `新事件最后 seq ${lastSeq} 应大于磁盘最后 seq ${lastDiskSeq}`,
  );
  await restoredManager.releaseLock();
});

